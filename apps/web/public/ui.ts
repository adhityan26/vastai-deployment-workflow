import {
  API,
  AUTH,
  SESSION_EXPIRED_MESSAGE,
  loginErrorMessage,
  loginErrorParam,
  screenForMe,
  withoutLoginError,
  CLOCK_TICK_MS,
  DEFAULT_EXTEND_MINUTES,
  creditDue,
  formatCredit,
  parseCredit,
  GPU_STORAGE_KEY,
  JOB_POLL_MAX_ERRORS,
  JOB_POLL_MS,
  characterCount,
  chooseGpu,
  clockView,
  controls,
  downloadPercent,
  downloadText,
  errorReason,
  errorText,
  estimatePath,
  formatCost,
  formatPrice,
  formatQueue,
  formatVram,
  gpuOptionLabel,
  imageUrl,
  isJobId,
  parseEstimate,
  parseGpus,
  parseSeed,
  parseState,
  pollIntervalMs,
  presetLabel,
  progressPercent,
  sizeLabel,
  nextSamples,
  stateInfo,
  windowSpeed,
  type ApiState,
  type Estimate,
  type GpuOption,
  type Sample,
} from "./model.js";

// DOM glue. Every string that came from the API goes in through textContent or setAttribute,
// never innerHTML. Decisions live in model.ts.

export interface Env {
  fetch: typeof fetch;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface App {
  /** Resolves after the first state fetch has been drawn. */
  ready: Promise<void>;
  /** Fetch the state once and redraw. */
  refresh(): Promise<void>;
  stop(): void;
}

class ApiError extends Error {
  constructor(message: string, readonly reason: string | null = null) {
    super(message);
  }
}
/** The session is gone or the account lost access: the screen was already switched. */
class AuthLostError extends ApiError {}

interface HistoryEntry {
  id: string;
  prompt: string;
  label: string;
  status: "pending" | "done" | "failed";
  message: string;
  images: string[];
  node: HTMLElement;
}

export function mountApp(doc: Document, env: Env): App {
  const $ = <T extends HTMLElement>(id: string): T => {
    const node = doc.getElementById(id);
    if (node === null) throw new Error(`missing element #${id}`);
    return node as T;
  };
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className !== undefined) node.className = className;
    return node;
  };

  let state: ApiState | null = null;
  let fetchedAt = 0;
  let failures = 0;
  let busy = false;
  let jobPending = false;
  let stopped = false;
  let active = false; // true only while the app screen is shown; gates every timer and poll
  let pollHandle: unknown = null;
  let tickHandle: unknown = null;
  let selectedPreset = "";
  let formKey = "";
  let adminBuilt = false;
  let unknownKey = "";
  let restoreFocus: HTMLElement | null = null;
  let samples: Sample[] = []; // recent download byte counts, for speed and ETA
  let creditAskedAt = Number.NEGATIVE_INFINITY; // when the credit was last requested (success or not)
  let creditRunning = false;
  const history: HistoryEntry[] = [];

  // ---- requests ----

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await env.fetch(path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError("Could not reach the server. Check your connection.");
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.status === 401) {
      showAuthScreen("login", SESSION_EXPIRED_MESSAGE);
      throw new AuthLostError(SESSION_EXPIRED_MESSAGE);
    }
    if (res.status === 403 && (await accessLost())) throw new AuthLostError("No access for this account");
    if (!res.ok) throw new ApiError(errorText(res.status, json), errorReason(json));
    return json;
  }

  // A 403 can also mean "admin only" or a refused cross-site request, so ask /api/me whether the
  // account itself lost its access. True when the screen was switched.
  async function accessLost(): Promise<boolean> {
    try {
      const res = await env.fetch(API.me);
      if (res.status === 401) {
        showAuthScreen("login", SESSION_EXPIRED_MESSAGE);
        return true;
      }
      if (res.status === 403) {
        showAuthScreen("noaccess", "");
        return true;
      }
    } catch {
      // Cannot tell: keep the page and show the ordinary error.
    }
    return false;
  }

  // ---- screens: loading, login, no access, app ----

  const screens = {
    loading: $("loading"),
    error: $("loading-error"),
    login: $("login-screen"),
    noaccess: $("noaccess-screen"),
    app: $("app"),
  };
  function showOnly(name: keyof typeof screens): void {
    for (const [key, node] of Object.entries(screens)) node.hidden = key !== name;
  }

  function pauseTimers(): void {
    active = false;
    if (pollHandle !== null) env.clearTimeout(pollHandle);
    if (tickHandle !== null) env.clearTimeout(tickHandle);
    pollHandle = null;
    tickHandle = null;
  }

  function setText(id: string, text: string): void {
    const node = $(id);
    node.textContent = text;
    node.hidden = text === "";
  }

  function showAuthScreen(kind: "login" | "noaccess", message: string): void {
    startSubmitting = false; // a Start request in flight must not keep the dialog over the login screen
    closeModal?.(false);
    pauseTimers();
    clearMessages();
    state = null;
    samples = [];
    jobPending = false;
    setText("login-message", kind === "login" ? message : "");
    setText("noaccess-error", "");
    setText("logout-error", "");
    showOnly(kind);
    ($(kind === "login" ? "login-link" : "btn-logout-noaccess") as HTMLElement).focus();
  }

  async function logout(): Promise<void> {
    try {
      const res = await env.fetch(AUTH.logout, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      const text = "Logout failed, please try again.";
      setText(screens.app.hidden ? "noaccess-error" : "logout-error", text);
      return;
    }
    showAuthScreen("login", "");
  }
  $("btn-logout").addEventListener("click", () => void logout());
  $("btn-logout-noaccess").addEventListener("click", () => void logout());
  $("btn-retry").addEventListener("click", () => void start());

  async function start(): Promise<void> {
    showOnly("loading");
    let result: ReturnType<typeof screenForMe>;
    try {
      const res = await env.fetch(API.me);
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      result = screenForMe(res.status, json);
    } catch {
      result = { screen: "error", me: null };
    }
    if (stopped) return;
    if (result.screen === "login") {
      // Show a login_error from the redirect once, from a fixed map; the URL value is never shown.
      const win = doc.defaultView;
      const code = win === null ? null : loginErrorParam(win.location.search);
      showAuthScreen("login", loginErrorMessage(code) ?? "");
      if (win !== null && code !== null) {
        win.history.replaceState(null, "", `${win.location.pathname}${withoutLoginError(win.location.search)}${win.location.hash}`);
      }
    } else if (result.screen === "noaccess" || result.me === null) {
      if (result.screen === "noaccess") showAuthScreen("noaccess", "");
      else {
        $("loading-error-text").textContent = "Could not check your login. Check your connection and try again.";
        showOnly("error");
      }
    } else {
      $("user-name").textContent = result.me.name;
      showOnly("app");
      active = true;
      tickHandle = env.setTimeout(tick, CLOCK_TICK_MS);
      await refresh();
    }
  }

  // ---- banners ----

  const banner = $("banner");
  const notice = $("notice");
  function showBanner(text: string, fromPoll = false): void {
    banner.textContent = text;
    banner.hidden = false;
    if (fromPoll) banner.dataset["source"] = "poll";
    else delete banner.dataset["source"];
  }
  function showNotice(text: string): void {
    notice.textContent = text;
    notice.hidden = false;
  }
  function clearMessages(): void {
    banner.hidden = true;
    notice.hidden = true;
  }

  // ---- confirm dialog (in the page: window.confirm is unreliable in installed web apps) ----

  const modal = $("modal");
  const modalOk = $<HTMLButtonElement>("modal-ok");
  const modalCancel = $<HTMLButtonElement>("modal-cancel");
  let closeModal: ((ok: boolean) => void) | null = null;
  let okHandler: (() => void | Promise<void>) | null = null; // Start dialog confirms without closing

  function confirmDialog(title: string, lines: string[], okLabel: string, danger: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      restoreFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
      $("modal-title").textContent = title;
      const body = $("modal-body");
      body.replaceChildren(...lines.map((l) => make("p", l)));
      modalOk.textContent = okLabel;
      modalOk.className = danger ? "danger" : "primary";
      closeModal = (ok) => {
        closeModal = null;
        modal.hidden = true;
        restoreFocus?.focus();
        resolve(ok);
      };
      modal.hidden = false;
      modalCancel.focus();
    });
  }
  modalOk.addEventListener("click", () => {
    if (okHandler !== null) void okHandler();
    else closeModal?.(true);
  });
  modalCancel.addEventListener("click", () => closeModal?.(false));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal?.(false);
  });
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal?.(false);
  });

  // ---- actions ----

  async function act(work: () => Promise<void>): Promise<void> {
    clearMessages();
    busy = true;
    render();
    try {
      await work();
    } catch (err) {
      showBanner(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      busy = false;
      await refresh();
    }
  }

  // ---- Start dialog: GPU choice, live estimate, errors inside the dialog ----

  // The remembered model is only a preference; storage can be missing or throw, so every access
  // is guarded and the value is validated against the current list before use.
  function readRemembered(): string | null {
    try {
      return doc.defaultView?.localStorage.getItem(GPU_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }
  function writeRemembered(name: string): void {
    try {
      doc.defaultView?.localStorage.setItem(GPU_STORAGE_KEY, name);
    } catch {
      // Storage unavailable: the choice is just not remembered.
    }
  }

  let startSubmitting = false;
  let dialogToken = 0; // bumped whenever a Start dialog opens or closes
  let estimateSeq = 0; // bumped for every estimate request; only the latest may answer

  function onStart(): Promise<void> {
    if (busy || startSubmitting || !modal.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      const token = ++dialogToken;
      restoreFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
      let gpus: GpuOption[] = [];
      let estimate: Estimate | null = null;

      $("modal-title").textContent = "Start an instance?";
      const loading = make("p", "Loading GPU models…");
      loading.setAttribute("role", "status");
      const gpuLabel = make("label", "GPU");
      gpuLabel.htmlFor = "start-gpu";
      const select = make("select");
      select.id = "start-gpu";
      select.disabled = true;
      const gpuNote = make("p", "", "muted");
      gpuNote.hidden = true;
      const estBox = make("div", undefined, "estimate");
      estBox.setAttribute("aria-live", "polite");
      const errBox = make("div", undefined, "alert bad");
      errBox.setAttribute("role", "alert");
      errBox.hidden = true;
      const notes = [
        "This estimate covers the failsafe time only; the failsafe can be extended up to the hard cap, which costs more.",
        "Disk storage is billed separately, per hour, for as long as the instance exists.",
        "You pay while the instance exists, even if nobody generates anything.",
      ].map((t) => make("p", t));
      $("modal-body").replaceChildren(loading, gpuLabel, select, gpuNote, estBox, errBox, ...notes);
      modalOk.textContent = "Start and pay";
      modalOk.className = "primary";
      modalOk.disabled = true;

      const showError = (err: unknown): void => {
        const box = errBox;
        box.replaceChildren(make("p", err instanceof Error ? err.message : "Something went wrong."));
        if (err instanceof ApiError && err.reason !== null) box.append(make("p", `Reason: ${err.reason}`, "small"));
        box.hidden = false;
      };
      const clearError = (): void => {
        errBox.hidden = true;
        errBox.replaceChildren();
      };
      const authLost = (err: unknown): boolean => err instanceof AuthLostError;

      const showEstimate = (): void => {
        if (estimate === null) {
          estBox.replaceChildren();
          return;
        }
        const name = estimate.gpu_name === null ? "" : ` (${estimate.gpu_name})`;
        estBox.replaceChildren(
          make("p", `Price: ${formatPrice(estimate.dph)}${name}.`),
          make("p", `Estimated cost if it runs for the full failsafe time (${estimate.horizon_hours} hours): up to ${formatCost(estimate.max_cost)}.`),
        );
      };

      const loadEstimate = async (): Promise<void> => {
        const seq = ++estimateSeq;
        estimate = null;
        showEstimate();
        clearError();
        modalOk.disabled = true;
        if (select.value === "") return;
        try {
          const est = parseEstimate(await call("GET", estimatePath(select.value)));
          if (seq !== estimateSeq || token !== dialogToken) return;
          if (est === null) throw new ApiError("The cost estimate was not understood. Nothing was started.");
          estimate = est;
          showEstimate();
          modalOk.disabled = false;
        } catch (err) {
          if (seq !== estimateSeq || token !== dialogToken || authLost(err)) return;
          showError(err);
        }
      };

      const finish = (): void => {
        dialogToken++;
        estimateSeq++;
        closeModal = null;
        okHandler = null;
        modalOk.disabled = false;
        modal.hidden = true;
        restoreFocus?.focus();
        resolve();
      };
      closeModal = (ok) => {
        if (!ok && startSubmitting) return; // no cancelling while the request is in flight
        finish();
      };

      okHandler = async () => {
        if (startSubmitting || estimate === null || select.value === "") return;
        const chosen = select.value;
        startSubmitting = true;
        busy = true;
        modalOk.disabled = true;
        select.disabled = true;
        clearError();
        clearMessages();
        render();
        try {
          const res = await call("POST", API.start, { confirm: true, gpu: chosen });
          writeRemembered(chosen);
          // Start may share an attempt for another model: show what the server really rented.
          const started = parseEstimate(res !== null && typeof res === "object" ? (res as Record<string, unknown>)["estimate"] : null);
          startSubmitting = false;
          finish();
          showNotice(`Starting${started?.gpu_name ? ` on ${started.gpu_name}` : ""}. It can take several minutes to boot and download models.`);
        } catch (err) {
          startSubmitting = false;
          if (authLost(err)) return;
          showError(err);
          showBanner(err instanceof Error ? err.message : "Something went wrong.");
          select.disabled = false;
          modalOk.disabled = estimate === null;
          modalOk.focus();
        } finally {
          busy = false;
          if (active) await refresh();
        }
      };

      modal.hidden = false;
      modalCancel.focus();

      void (async () => {
        try {
          const list = parseGpus(await call("GET", API.gpus));
          if (token !== dialogToken) return;
          if (list === null) throw new ApiError("The GPU list was not understood. Nothing was started.");
          gpus = list;
        } catch (err) {
          if (token !== dialogToken || authLost(err)) return;
          loading.hidden = true;
          showError(err);
          return;
        }
        loading.hidden = true;
        select.replaceChildren(
          ...gpus.map((g) => {
            const o = make("option", gpuOptionLabel(g));
            o.value = g.name;
            o.disabled = !g.available;
            return o;
          }),
        );
        const pick = chooseGpu(readRemembered(), gpus);
        if (pick === null) {
          select.value = "";
          select.disabled = true;
          gpuNote.textContent = gpus.length === 0 ? "No GPU model is configured." : "No GPU model has offers right now. Try again later.";
          gpuNote.hidden = false;
          return;
        }
        select.value = pick;
        select.disabled = false;
        select.addEventListener("change", () => void loadEstimate());
        await loadEstimate();
      })();
    });
  }

  function onDestroy(): Promise<void> {
    return act(async () => {
      const ok = await confirmDialog(
        "Destroy the instance?",
        ["This stops billing and deletes the instance. Running jobs are lost."],
        "Destroy",
        true,
      );
      if (!ok) return;
      const res = await call("POST", API.destroy, {});
      const outcome = res !== null && typeof res === "object" ? (res as { outcome?: unknown }).outcome : undefined;
      if (outcome === "pending") {
        showNotice(
          "Destroy is queued: the instance is not visible on Vast yet; it will be destroyed as soon as it appears.",
        );
      } else if (outcome === "none") {
        showNotice("No instance to destroy.");
      } else {
        showNotice("Destroy requested.");
      }
    });
  }

  function onExtend(): Promise<void> {
    const kind = $<HTMLSelectElement>("extend-kind").value;
    const minutes = Number($<HTMLInputElement>("extend-minutes").value);
    return act(async () => {
      if (!Number.isInteger(minutes) || minutes < 1) throw new ApiError("Minutes must be a whole number of at least 1.");
      const what = kind === "idle" ? "idle shutdown" : "failsafe";
      const ok = await confirmDialog(
        "Extend the instance?",
        [`Move the ${what} later by ${minutes} minutes. The instance keeps costing money for that time.`],
        "Extend",
        false,
      );
      if (!ok) return;
      await call("POST", API.extend, { kind, minutes });
      showNotice("Extended.");
    });
  }

  function onDestroyUnknown(id: number): Promise<void> {
    return act(async () => {
      const ok = await confirmDialog(
        "Destroy this instance?",
        [`Instance ${id} is not tracked by this page. Destroying it cannot be undone.`],
        "Destroy",
        true,
      );
      if (!ok) return;
      await call("POST", API.destroyUnknown, { vast_id: id });
      showNotice(`Instance ${id} destroy requested.`);
    });
  }

  // ---- admin panel ----

  const adminPanel = $("admin-panel");
  function buildAdmin(): void {
    adminBuilt = true;
    const title = make("h2", "Controls");
    title.id = "admin-title";
    const start = make("button", "Start instance", "primary");
    start.id = "btn-start";
    start.type = "button";
    start.addEventListener("click", () => void onStart());
    const destroy = make("button", "Destroy instance", "danger");
    destroy.id = "btn-destroy";
    destroy.type = "button";
    destroy.addEventListener("click", () => void onDestroy());
    const row = make("div", undefined, "row");
    row.append(start, destroy);

    const extend = make("div", undefined, "extend");
    const kindLabel = make("label", "Extend");
    kindLabel.htmlFor = "extend-kind";
    const kind = make("select");
    kind.id = "extend-kind";
    for (const [value, text] of [["idle", "Idle shutdown"], ["failsafe", "Failsafe"]] as const) {
      const o = make("option", text);
      o.value = value;
      kind.append(o);
    }
    const minLabel = make("label", "Minutes");
    minLabel.htmlFor = "extend-minutes";
    const minutes = make("input");
    minutes.id = "extend-minutes";
    minutes.type = "number";
    minutes.inputMode = "numeric";
    minutes.min = "1";
    minutes.value = String(DEFAULT_EXTEND_MINUTES);
    const go = make("button", "Extend", "");
    go.id = "btn-extend";
    go.type = "button";
    go.addEventListener("click", () => void onExtend());
    const left = make("div");
    left.append(kindLabel, kind);
    const right = make("div");
    right.append(minLabel, minutes);
    extend.append(left, right, go);

    const unknown = make("div", undefined, "unknown");
    unknown.id = "unknown";
    unknown.hidden = true;
    adminPanel.replaceChildren(title, row, extend, unknown);
  }

  function renderUnknown(list: ApiState["unknown"]): void {
    const key = JSON.stringify(list);
    if (key === unknownKey) return;
    unknownKey = key;
    const box = $("unknown");
    box.hidden = list.length === 0;
    if (list.length === 0) {
      box.replaceChildren();
      return;
    }
    const warn = make("p", "Other instances from this project are running and are not tracked here. They cost money.", "alert warn");
    const ul = make("ul");
    for (const u of list) {
      const li = make("li");
      li.append(make("span", `#${u.vast_instance_id} · ${u.actual_status ?? "unknown"} · ${formatPrice(u.dph)}`));
      const b = make("button", "Destroy", "danger");
      b.type = "button";
      b.dataset["unknownId"] = String(u.vast_instance_id);
      b.setAttribute("aria-label", `Destroy instance ${u.vast_instance_id}`);
      b.addEventListener("click", () => void onDestroyUnknown(u.vast_instance_id));
      li.append(b);
      ul.append(li);
    }
    box.replaceChildren(warn, ul);
  }

  // ---- status ----

  function renderClock(): void {
    if (state === null) return;
    const c = clockView(state, Math.max(0, env.now() - fetchedAt));
    $("f-uptime").textContent = c.uptime;
    $("f-cost").textContent = c.cost;
    $("f-idle").textContent = c.idle;
    $("f-failsafe").textContent = c.failsafe;
    $("f-hardcap").textContent = c.hardCap;
  }

  function renderStatus(s: ApiState): void {
    const pct = s.download ? downloadPercent(s.download) : progressPercent(s.progress);
    const info = stateInfo(s.state, pct);
    const line = $("state-line");
    line.textContent = info.label;
    line.dataset["tone"] = info.tone;
    const downloading = s.state === "downloading" && (s.progress !== null || s.download !== null);
    $("progress-box").hidden = !downloading;
    if (downloading) {
      const bar = $<HTMLProgressElement>("progress");
      if (pct === null) bar.removeAttribute("value");
      else bar.value = pct;
      // One overall bar and text when the server reports it; the per-file name stays as a second line.
      const text = $("progress-text");
      text.textContent = s.download ? downloadText(s.download, windowSpeed(samples)) : "";
      text.hidden = s.download === null;
      $("progress-file").textContent = s.progress?.file ?? s.download?.current_file ?? "";
    }
    $("alert-agent").hidden = !s.agent_unreachable;
    const failed = $("alert-failed");
    failed.hidden = !(s.state === "failed" || s.failed !== null);
    $("failed-reason").textContent = s.failed?.reason ?? "";
    const df = $("alert-destroy-failed");
    df.hidden = !(s.state === "destroy_failed" || s.destroy_failed !== null);
    $("destroy-failed-error").textContent = s.destroy_failed?.error ?? "";
    $("f-price").textContent = formatPrice(s.dph);
    $("f-gpu").textContent = s.gpu_name ?? "—";
    $("f-queue").textContent = formatQueue(s.agent?.queue ?? null);
    $("f-vram").textContent = formatVram(s.agent?.gpu.vram_used_mb ?? null, s.agent?.gpu.vram_total_mb ?? null);
    const role = $("role");
    role.textContent = s.role;
    role.hidden = false;
    renderClock();
  }

  // ---- generate form ----

  const presetsBox = $("presets");
  const sizeSelect = $<HTMLSelectElement>("size");
  const generateBtn = $<HTMLButtonElement>("btn-generate");
  const promptBox = $<HTMLTextAreaElement>("prompt");

  function markPresets(): void {
    for (const b of Array.from(presetsBox.querySelectorAll("button"))) {
      b.setAttribute("aria-pressed", String(b.dataset["preset"] === selectedPreset));
    }
  }

  function renderForm(s: ApiState): void {
    // Rebuild options only when the API's lists change, so a poll never resets the user's choice.
    const key = JSON.stringify([s.presets, s.sizes]);
    if (key !== formKey) {
      formKey = key;
      if (!s.presets.some((p) => p.name === selectedPreset)) selectedPreset = s.presets[0]?.name ?? "";
      presetsBox.replaceChildren(
        ...s.presets.map((p) => {
          const b = make("button", presetLabel(p));
          b.type = "button";
          b.dataset["preset"] = p.name;
          b.addEventListener("click", () => {
            selectedPreset = p.name;
            markPresets();
          });
          return b;
        }),
      );
      markPresets();
      const keep = sizeSelect.value;
      sizeSelect.replaceChildren(
        ...s.sizes.map((z) => {
          const o = make("option", sizeLabel(z));
          o.value = z.name;
          return o;
        }),
      );
      if (s.sizes.some((z) => z.name === keep)) sizeSelect.value = keep;
    }
    const c = controls(s, busy, jobPending);
    generateBtn.disabled = !c.canGenerate;
    generateBtn.textContent = jobPending ? "Generating…" : "Generate";
    $("gen-hint").textContent = jobPending
      ? "A job is running. You can submit another when it finishes."
      : c.canGenerate
        ? ""
        : s.state === "none"
          ? "No instance is running. An admin needs to start one."
          : "Generating is available when the instance is ready.";
  }

  promptBox.addEventListener("input", () => {
    $("prompt-count").textContent = characterCount(promptBox.value);
  });

  const formError = $("form-error");
  function formFail(text: string): void {
    formError.textContent = text;
    formError.hidden = false;
  }

  $("gen-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void submitGenerate();
  });

  async function submitGenerate(): Promise<void> {
    formError.hidden = true;
    if (!controls(state, busy, jobPending).canGenerate) return;
    const prompt = promptBox.value;
    if (prompt.trim() === "") return formFail("Write a prompt first.");
    const seed = parseSeed($<HTMLInputElement>("seed").value);
    if (!seed.ok) return formFail(seed.message);
    if (selectedPreset === "" || sizeSelect.value === "") return formFail("Choose a quality and a size.");
    const body: Record<string, unknown> = { prompt, preset: selectedPreset, size: sizeSelect.value };
    if (seed.value !== undefined) body["seed"] = seed.value;
    jobPending = true;
    if (state) renderForm(state);
    try {
      const res = await call("POST", API.generate, body);
      const id = typeof res === "object" && res !== null ? (res as Record<string, unknown>)["id"] : undefined;
      if (!isJobId(id)) throw new ApiError("The server returned an unusable job id.");
      const preset = state?.presets.find((p) => p.name === selectedPreset);
      const entry = addEntry(id, prompt, `${preset ? presetLabel(preset) : selectedPreset}, ${sizeSelect.selectedOptions[0]?.textContent ?? ""}`);
      void pollJob(entry, 0);
    } catch (err) {
      jobPending = false;
      formFail(err instanceof Error ? err.message : "Could not start the job.");
      if (state) renderForm(state);
    }
  }

  // ---- results ----

  const historyBox = $("history");
  function addEntry(id: string, prompt: string, label: string): HistoryEntry {
    const entry: HistoryEntry = { id, prompt, label, status: "pending", message: "", images: [], node: make("article", undefined, "job") };
    history.unshift(entry);
    historyBox.prepend(entry.node);
    $("hist-empty").hidden = true;
    renderEntry(entry);
    return entry;
  }

  function renderEntry(e: HistoryEntry): void {
    const kids: HTMLElement[] = [make("p", e.prompt, "job-prompt"), make("p", e.label, "muted")];
    if (e.status === "pending") {
      const p = make("p", "Generating…");
      p.setAttribute("role", "status");
      kids.push(p);
    } else if (e.status === "failed") {
      kids.push(make("p", `Failed: ${e.message}`, "alert bad"));
      kids[kids.length - 1]!.setAttribute("role", "alert");
    } else {
      const grid = make("div", undefined, "grid");
      e.images.forEach((src, i) => {
        const fig = make("figure");
        const img = make("img");
        img.src = src;
        img.alt = `Result ${i + 1} for: ${e.prompt}`;
        img.loading = "lazy";
        const dl = make("a", "Download", "dl");
        dl.href = src;
        dl.setAttribute("download", `image-${e.id}-${i}`);
        fig.append(img, dl);
        grid.append(fig);
      });
      kids.push(grid);
    }
    e.node.replaceChildren(...kids);
  }

  function finishEntry(e: HistoryEntry, status: "done" | "failed", message = ""): void {
    e.status = status;
    e.message = message;
    jobPending = false;
    renderEntry(e);
    if (state) renderForm(state);
  }

  async function pollJob(e: HistoryEntry, errors: number): Promise<void> {
    if (stopped || !active) return;
    try {
      const res = await call("GET", `${API.generate}/${e.id}`);
      const r = (typeof res === "object" && res !== null ? res : {}) as Record<string, unknown>;
      if (r["status"] === "done" && Array.isArray(r["images"])) {
        e.images = r["images"].flatMap((img: unknown) => {
          const idx = typeof img === "object" && img !== null ? (img as Record<string, unknown>)["index"] : undefined;
          const url = imageUrl(e.id, idx);
          return url === null ? [] : [url];
        });
        return finishEntry(e, "done");
      }
      if (r["status"] === "failed") {
        return finishEntry(e, "failed", typeof r["message"] === "string" ? r["message"] : "Generation failed.");
      }
      env.setTimeout(() => void pollJob(e, 0), JOB_POLL_MS);
    } catch (err) {
      if (err instanceof AuthLostError) return;
      // A network blip or a 5xx may pass; anything else (404, 403) will not.
      if (errors + 1 >= JOB_POLL_MAX_ERRORS) {
        return finishEntry(e, "failed", err instanceof Error ? err.message : "Lost contact with the server.");
      }
      env.setTimeout(() => void pollJob(e, errors + 1), JOB_POLL_MS);
    }
  }

  // ---- Vast credit (admin only) ----

  /** Read the Vast credit and show it; any failure shows "unavailable" and the next interval retries. */
  async function refreshCredit(): Promise<void> {
    creditRunning = true;
    creditAskedAt = env.now();
    let text = "unavailable";
    try {
      const reading = parseCredit(await call("GET", API.credit));
      if (reading !== null) text = formatCredit(reading.credit);
    } catch (err) {
      if (err instanceof AuthLostError) return;
    } finally {
      creditRunning = false;
    }
    $("f-credit").textContent = text;
  }

  // ---- render + polling loop ----

  function render(): void {
    const c = controls(state, busy, jobPending);
    if (state) {
      renderStatus(state);
      renderForm(state);
    }
    $("f-credit-box").hidden = !c.showAdmin;
    if (c.showAdmin) {
      if (creditDue(creditAskedAt, env.now(), creditRunning)) void refreshCredit();
      if (!adminBuilt) buildAdmin();
      adminPanel.hidden = false;
      $<HTMLButtonElement>("btn-start").disabled = !c.canStart;
      $<HTMLButtonElement>("btn-destroy").disabled = !c.canDestroy;
      $<HTMLButtonElement>("btn-extend").disabled = !c.canExtend;
      renderUnknown(state?.unknown ?? []);
    } else {
      adminPanel.replaceChildren();
      adminPanel.hidden = true;
      adminBuilt = false;
      unknownKey = "";
      creditAskedAt = Number.NEGATIVE_INFINITY;
    }
  }

  async function refresh(): Promise<void> {
    if (!active) return;
    try {
      const parsed = parseState(await call("GET", API.state));
      if (parsed === null) throw new ApiError("The server sent a status this page cannot read.");
      state = parsed;
      fetchedAt = env.now();
      samples = nextSamples(samples, fetchedAt, parsed.state, parsed.download);
      failures = 0;
      if (banner.dataset["source"] === "poll") {
        banner.hidden = true;
        delete banner.dataset["source"];
      }
    } catch (err) {
      if (err instanceof AuthLostError || !active) return;
      failures += 1;
      showBanner(err instanceof Error ? err.message : "Status update failed.", true);
    }
    render();
    schedulePoll();
  }

  function schedulePoll(): void {
    if (stopped || !active) return;
    if (pollHandle !== null) env.clearTimeout(pollHandle);
    pollHandle = env.setTimeout(() => void refresh(), pollIntervalMs(state?.state ?? null, doc.hidden, failures));
  }

  function tick(): void {
    if (stopped || !active) return;
    renderClock();
    tickHandle = env.setTimeout(tick, CLOCK_TICK_MS);
  }

  const onVisibility = (): void => {
    if (!active) return;
    if (!doc.hidden) void refresh();
    else schedulePoll();
  };
  doc.addEventListener("visibilitychange", onVisibility);

  const ready = start();
  return {
    ready,
    refresh,
    stop() {
      stopped = true;
      if (pollHandle !== null) env.clearTimeout(pollHandle);
      if (tickHandle !== null) env.clearTimeout(tickHandle);
      doc.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
