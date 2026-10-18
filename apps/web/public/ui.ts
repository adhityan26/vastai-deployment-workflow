import {
  API,
  AUTH,
  SESSION_EXPIRED_MESSAGE,
  loginErrorMessage,
  loginErrorParam,
  screenForMe,
  withoutLoginError,
  CLOCK_TICK_MS,
  CONSOLE_PATH,
  EMPTY_CONSOLE_VIEW,
  PHASE_MARKS,
  bootSentence,
  clearConsoleView,
  consoleCardVisible,
  consoleDelayMs,
  consoleExport,
  consoleKeepsPolling,
  endedText,
  isNearBottom,
  lineTime,
  mergeConsole,
  parseConsole,
  visibleLines,
  type ConsolePayload,
  type ConsoleView,
  DEFAULT_EXTEND_MINUTES,
  AUTOSAVE_STORAGE_KEY,
  creditDue,
  formatBytes,
  formatCredit,
  formatSavedAt,
  galleryPath,
  parseCredit,
  parseGalleryPage,
  type GalleryEntry,
  acceptTypes,
  base64FromDataUrl,
  editLabel,
  pickReferences,
  referenceHint,
  CONSOLE_COLLAPSED_KEY,
  GPU_STORAGE_KEY,
  HISTORY_COLLAPSED_KEY,
  formatDuration,
  historyRefreshDue,
  historyTime,
  parseHistory,
  stopReasonText,
  type UsageEntry,
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

const CONSOLE_REVOKE_MS = 1_000; // the browser needs a moment to start the download

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
  /** Fetch the boot console once (admins only) and redraw it. */
  pollConsole(): Promise<void>;
  stop(): void;
}

class ApiError extends Error {
  constructor(message: string, readonly reason: string | null = null, readonly status: number | null = null) {
    super(message);
  }
}
/** The session is gone or the account lost access: the screen was already switched. */
class AuthLostError extends ApiError {}

/** One attached reference image: the file itself and, when the browser can make one, a preview URL. */
interface Reference {
  id: number;
  file: File;
  url: string | null;
}

interface HistoryEntry {
  id: string;
  prompt: string;
  label: string;
  status: "pending" | "done" | "failed";
  message: string;
  images: string[];
  /** The server's index of each image in `images` (what Save sends). */
  indexes: number[];
  /** Per image: whether it was saved to the gallery. */
  saves: ("idle" | "saving" | "saved" | "failed")[];
  saveMessages: string[];
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
  let mode: "generate" | "edit" = "generate";
  let refSeq = 0;
  const references: Reference[] = [];
  let consoleView: ConsoleView = EMPTY_CONSOLE_VIEW;
  let consolePayload: ConsolePayload | null = null;
  let consoleHandle: unknown = null;
  let consoleFailures = 0;
  let consoleBusy = false;
  let consoleStopped = false; // the endpoint refused us (401/403): never ask again
  let consolePaused = false; // the user's Pause button
  let consoleLoaded = false; // at least one answer arrived
  let consoleFollow = true; // auto-scroll: off while the user is scrolled up
  let consoleStepsKey = "";
  let consoleRenderKey = "";
  let consoleRenderedSeq = 0;
  let consoleTruncated = false; // sticky per generation: lines were dropped at some point
  let consoleEpoch = 0; // bumped by resetConsole; an answer from an older epoch is discarded
  const history: HistoryEntry[] = [];
  let usageSeenState: string | null = null; // the state at the last history read decision (null: never read)
  let usageEpoch = 0; // bumped by resetUsage; an answer from an older epoch is discarded
  let usageBusy = false;
  let usageDirty = false; // a refresh was due while a read was in flight: read once more after it

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
    if (!res.ok) throw new ApiError(errorText(res.status, json), errorReason(json), res.status);
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
    if (consoleHandle !== null) env.clearTimeout(consoleHandle);
    pollHandle = null;
    tickHandle = null;
    consoleHandle = null;
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
    resetConsole();
    resetUsage();
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

  // While the boot console says a phase is running, a plain sentence replaces the "agent cannot
  // be reached" warning (it is expected during boot). Members have no console: they keep the warning.
  function renderAgentNotice(s: ApiState): void {
    const sentence = s.agent_unreachable && s.role === "admin" ? bootSentence(consolePayload) : null;
    const box = $("boot-sentence");
    box.textContent = sentence ?? "";
    box.hidden = sentence === null;
    $("alert-agent").hidden = !s.agent_unreachable || sentence !== null;
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
    renderAgentNotice(s);
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
  const modeBox = $("mode-box");
  const modeGenerate = $<HTMLButtonElement>("mode-generate");
  const modeEdit = $<HTMLButtonElement>("mode-edit");
  const editBox = $("edit-box");
  const sizeBox = $("size-box");
  const refInput = $<HTMLInputElement>("ref-input");
  const refList = $("ref-list");
  const refError = $("ref-error");
  const resolutionSelect = $<HTMLSelectElement>("resolution");

  function markPresets(): void {
    for (const b of Array.from(presetsBox.querySelectorAll("button"))) {
      b.setAttribute("aria-pressed", String(b.dataset["preset"] === selectedPreset));
    }
  }

  function renderForm(s: ApiState): void {
    // Edit can disappear (server config) while it is selected: fall back to plain generate.
    if (s.edit === null) mode = "generate";
    // Rebuild options only when the API's lists change, so a poll never resets the user's choice.
    const key = JSON.stringify([s.presets, s.sizes, s.edit]);
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
      const keepResolution = resolutionSelect.value;
      resolutionSelect.replaceChildren(
        ...(s.edit?.resolutions ?? []).map((r) => {
          const o = make("option", r.name);
          o.value = r.name;
          return o;
        }),
      );
      if (s.edit?.resolutions.some((r) => r.name === keepResolution)) resolutionSelect.value = keepResolution;
      if (s.edit !== null) {
        refInput.accept = acceptTypes(s.edit);
        $("ref-hint").textContent = referenceHint(s.edit);
      }
    }
    const editing = mode === "edit";
    modeBox.hidden = s.edit === null;
    modeGenerate.setAttribute("aria-pressed", String(!editing));
    modeEdit.setAttribute("aria-pressed", String(editing));
    editBox.hidden = !editing;
    sizeBox.hidden = editing;
    promptBox.placeholder = editing ? "Describe the change, e.g. make the girl in <image1> wear the jacket from <image2>" : "";
    const c = controls(s, busy, jobPending);
    const allowed = editing ? c.canEdit : c.canGenerate;
    generateBtn.disabled = !allowed;
    generateBtn.textContent = jobPending ? "Generating…" : editing ? "Edit" : "Generate";
    $("gen-hint").textContent = jobPending
      ? "A job is running. You can submit another when it finishes."
      : allowed
        ? ""
        : s.state === "none"
          ? "No instance is running. An admin needs to start one."
          : "Generating is available when the instance is ready.";
  }

  function setMode(next: "generate" | "edit"): void {
    if (next === "edit" && state?.edit == null) return;
    mode = next;
    formError.hidden = true;
    if (state) renderForm(state);
  }
  modeGenerate.addEventListener("click", () => setMode("generate"));
  modeEdit.addEventListener("click", () => setMode("edit"));

  promptBox.addEventListener("input", () => {
    $("prompt-count").textContent = characterCount(promptBox.value);
  });

  const formError = $("form-error");
  function formFail(text: string): void {
    formError.textContent = text;
    formError.hidden = false;
  }

  // ---- reference images (edit mode) ----

  function previewUrl(file: Blob): string | null {
    const api = doc.defaultView?.URL;
    return api && typeof api.createObjectURL === "function" ? api.createObjectURL(file) : null;
  }
  function releaseUrl(url: string | null): void {
    const api = doc.defaultView?.URL;
    if (url !== null && api && typeof api.revokeObjectURL === "function") api.revokeObjectURL(url);
  }

  function showRefErrors(errors: readonly string[]): void {
    refError.textContent = errors.join(" ");
    refError.hidden = errors.length === 0;
  }

  function renderReferences(): void {
    refList.replaceChildren(
      ...references.map((r, i) => {
        const item = make("li");
        if (r.url !== null) {
          const img = make("img");
          img.src = r.url;
          img.alt = `Reference ${i + 1}: ${r.file.name}`;
          item.append(img);
        }
        const remove = make("button", "Remove");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove reference ${i + 1}: ${r.file.name}`);
        remove.addEventListener("click", () => removeReference(r.id));
        item.append(make("p", `<image${i + 1}>`, "ref-tag"), make("p", r.file.name, "ref-name"), remove);
        return item;
      }),
    );
  }

  function removeReference(id: number): void {
    const at = references.findIndex((r) => r.id === id);
    if (at === -1) return;
    releaseUrl(references[at]!.url);
    references.splice(at, 1);
    showRefErrors([]);
    renderReferences();
  }

  refInput.addEventListener("change", () => {
    const files = Array.from(refInput.files ?? []);
    refInput.value = ""; // so the same file can be picked again after removing it
    const edit = state?.edit ?? null;
    if (edit === null || files.length === 0) return;
    const result = pickReferences(references.length, files.map((f) => ({ name: f.name, type: f.type, size: f.size })), edit);
    for (const i of result.accepted) references.push({ id: ++refSeq, file: files[i]!, url: previewUrl(files[i]!) });
    showRefErrors(result.errors);
    renderReferences();
  });

  /** The base64 text of a file (FileReader data URL without its prefix). */
  function readBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const Reader = doc.defaultView?.FileReader;
      if (Reader === undefined) return reject(new ApiError("This browser cannot read the image files."));
      const reader = new Reader();
      reader.onload = () => {
        const text = typeof reader.result === "string" ? base64FromDataUrl(reader.result) : null;
        if (text === null) reject(new ApiError("An image file could not be read."));
        else resolve(text);
      };
      reader.onerror = () => reject(new ApiError("An image file could not be read."));
      reader.readAsDataURL(file);
    });
  }

  $("gen-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void (mode === "edit" ? submitEdit() : submitGenerate());
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

  async function submitEdit(): Promise<void> {
    formError.hidden = true;
    if (!controls(state, busy, jobPending).canEdit) return;
    const prompt = promptBox.value;
    if (prompt.trim() === "") return formFail("Describe the change first.");
    if (references.length === 0) return formFail("Attach at least one reference image.");
    const seed = parseSeed($<HTMLInputElement>("seed").value);
    if (!seed.ok) return formFail(seed.message);
    if (selectedPreset === "" || resolutionSelect.value === "") return formFail("Choose a quality and a resolution.");
    const files = references.map((r) => r.file);
    jobPending = true; // also blocks a second submit while the files are being read and sent
    if (state) renderForm(state);
    try {
      const images: string[] = [];
      for (const file of files) images.push(await readBase64(file));
      const body: Record<string, unknown> = { prompt, preset: selectedPreset, resolution: resolutionSelect.value, images };
      if (seed.value !== undefined) body["seed"] = seed.value;
      const res = await call("POST", API.edit, body);
      const id = typeof res === "object" && res !== null ? (res as Record<string, unknown>)["id"] : undefined;
      if (!isJobId(id)) throw new ApiError("The server returned an unusable job id.");
      const preset = state?.presets.find((p) => p.name === selectedPreset);
      const entry = addEntry(id, prompt, editLabel(preset ? presetLabel(preset) : selectedPreset, resolutionSelect.value, files.length));
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
    const entry: HistoryEntry = { id, prompt, label, status: "pending", message: "", images: [], indexes: [], saves: [], saveMessages: [], node: make("article", undefined, "job") };
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
        if (state?.gallery === true) {
          const st = e.saves[i] ?? "idle";
          const save = make("button", st === "saved" ? "Saved ✓" : st === "saving" ? "Saving…" : "Save to gallery", "save");
          save.type = "button";
          save.disabled = st === "saving" || st === "saved";
          save.addEventListener("click", () => void saveImage(e, i));
          fig.append(save);
          if (st === "failed") {
            const note = make("p", `Not saved: ${e.saveMessages[i] ?? ""}`, "alert bad");
            note.setAttribute("role", "alert");
            fig.append(note);
          }
        }
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
    if (status === "done" && state?.gallery === true && autosaveBox.checked) void autoSave(e);
  }

  // ---- save to the gallery ----

  /** Save one result image (by its position in the entry); the server fetches it from the instance. */
  async function saveImage(e: HistoryEntry, i: number): Promise<void> {
    const index = e.indexes[i];
    if (index === undefined || e.saves[i] === "saving" || e.saves[i] === "saved") return;
    e.saves[i] = "saving";
    renderEntry(e);
    try {
      await call("POST", API.gallery, { job: e.id, index });
      e.saves[i] = "saved";
      e.saveMessages[i] = "";
      if (galleryOpen) void loadGallery(true);
    } catch (err) {
      if (err instanceof AuthLostError) return;
      e.saves[i] = "failed";
      e.saveMessages[i] = err instanceof Error ? err.message : "the image could not be saved.";
    }
    renderEntry(e);
  }

  async function autoSave(e: HistoryEntry): Promise<void> {
    for (let i = 0; i < e.indexes.length; i++) await saveImage(e, i);
  }

  const autosaveBox = $<HTMLInputElement>("autosave");
  // The choice is a per-device preference; storage can be missing or throw.
  function readAutosave(): boolean {
    try {
      return doc.defaultView?.localStorage.getItem(AUTOSAVE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }
  autosaveBox.checked = readAutosave();
  autosaveBox.addEventListener("change", () => {
    try {
      doc.defaultView?.localStorage.setItem(AUTOSAVE_STORAGE_KEY, autosaveBox.checked ? "1" : "0");
    } catch {
      // not remembered, still honoured for this page
    }
  });

  // ---- gallery card ----

  const galleryCard = $("gallery-card");
  const galOpenBtn = $<HTMLButtonElement>("gal-open");
  const galList = $("gal-list");
  const galMore = $<HTMLButtonElement>("gal-more");
  const galEmpty = $("gal-empty");
  const galError = $("gal-error");
  const galAll = $<HTMLInputElement>("gal-all");
  const galAllBox = $("gal-all-box");
  let galleryOpen = false;
  let galleryNext: string | null = null;
  let galleryLoading = false;
  let galleryEpoch = 0; // a newer load makes an older answer obsolete

  function galleryItemNode(item: GalleryEntry, everyone: boolean): HTMLElement {
    const fig = make("figure");
    const img = make("img");
    img.src = item.url;
    img.alt = item.prompt === "" ? "Saved image" : `Saved image: ${item.prompt}`;
    img.loading = "lazy";
    const caption = [item.label, formatSavedAt(item.createdAt), formatBytes(item.size)];
    if (everyone && !item.mine && item.ownerName !== "") caption.push(item.ownerName);
    const dl = make("a", "Download", "dl");
    dl.href = item.url;
    dl.setAttribute("download", `gallery-${item.id}`);
    const del = make("button", "Delete");
    del.type = "button";
    del.addEventListener("click", () => void deleteGalleryItem(item, fig));
    fig.append(img, make("p", item.prompt, "gal-prompt"), make("p", caption.filter((c) => c !== "").join(" · "), "gal-caption"), dl, del);
    return fig;
  }

  function updateGalleryEmpty(): void {
    const any = galList.children.length > 0;
    galEmpty.hidden = !galleryOpen || any || galleryLoading;
    galList.hidden = !any;
    galMore.hidden = galleryNext === null;
  }

  async function loadGallery(reset: boolean): Promise<void> {
    if (!galleryOpen) return;
    if (galleryLoading && !reset) return;
    const epoch = ++galleryEpoch;
    const everyone = galAll.checked && state?.role === "admin";
    galleryLoading = true;
    galMore.disabled = true;
    galError.hidden = true;
    try {
      const page = parseGalleryPage(await call("GET", galleryPath(reset ? null : galleryNext, everyone)));
      if (page === null) throw new ApiError("The server sent a gallery this page cannot read.");
      if (epoch !== galleryEpoch) return;
      if (reset) galList.replaceChildren();
      galList.append(...page.items.map((i) => galleryItemNode(i, everyone)));
      galleryNext = page.next;
    } catch (err) {
      if (err instanceof AuthLostError || epoch !== galleryEpoch) return;
      galError.textContent = err instanceof Error ? err.message : "The gallery could not be loaded.";
      galError.hidden = false;
    } finally {
      if (epoch === galleryEpoch) {
        galleryLoading = false;
        galMore.disabled = false;
        updateGalleryEmpty();
      }
    }
  }

  async function deleteGalleryItem(item: GalleryEntry, node: HTMLElement): Promise<void> {
    const ok = await confirmDialog("Delete this image?", ["It is removed from the gallery for good."], "Delete", true);
    if (!ok) return;
    try {
      await call("POST", API.galleryDelete, { id: item.id });
      node.remove();
      updateGalleryEmpty();
    } catch (err) {
      if (err instanceof AuthLostError) return;
      galError.textContent = err instanceof Error ? err.message : "The image could not be deleted.";
      galError.hidden = false;
    }
  }

  galOpenBtn.addEventListener("click", () => {
    galleryOpen = true;
    galOpenBtn.textContent = "Refresh";
    galAllBox.hidden = state?.role !== "admin";
    galleryNext = null;
    void loadGallery(true);
  });
  galMore.addEventListener("click", () => void loadGallery(false));
  galAll.addEventListener("change", () => {
    galleryNext = null;
    void loadGallery(true);
  });

  function renderGallery(s: ApiState): void {
    galleryCard.hidden = !s.gallery;
    $("autosave-box").hidden = !s.gallery;
    if (!s.gallery) {
      // The server turned it off: forget what was shown.
      galleryOpen = false;
      galList.replaceChildren();
    }
    galAllBox.hidden = !(galleryOpen && s.role === "admin");
  }


  async function pollJob(e: HistoryEntry, errors: number): Promise<void> {
    if (stopped || !active) return;
    try {
      const res = await call("GET", `${API.generate}/${e.id}`);
      const r = (typeof res === "object" && res !== null ? res : {}) as Record<string, unknown>;
      if (r["status"] === "done" && Array.isArray(r["images"])) {
        e.images = [];
        e.indexes = [];
        for (const img of r["images"] as unknown[]) {
          const idx = typeof img === "object" && img !== null ? (img as Record<string, unknown>)["index"] : undefined;
          const url = imageUrl(e.id, idx);
          if (url === null) continue;
          e.images.push(url);
          e.indexes.push(idx as number);
        }
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

  // ---- boot console (admin only) ----

  const consoleCard = $("console-card");
  const consoleLog = $("console-log");
  const consoleSteps = $("console-steps");
  const consolePauseBtn = $<HTMLButtonElement>("console-pause");
  // The download link is made here: a real link (keyboard and touch friendly) whose href is a Blob
  // URL created on click, so the static page has no link to a file.
  const consoleDownload = make("a", "Download .txt", "button");
  consoleDownload.id = "console-download";
  consoleDownload.href = "#";
  consoleDownload.setAttribute("download", "boot-console.txt");
  $("console-actions").append(consoleDownload);

  // The log part can be folded away; the stepper and the ended notice stay visible. The choice is
  // only a per-viewer convenience, so storage failures are ignored.
  const consoleBody = $("console-body");
  const consoleToggle = $<HTMLButtonElement>("console-toggle");
  function setConsoleCollapsed(collapsed: boolean, remember: boolean): void {
    consoleBody.hidden = collapsed;
    consoleToggle.setAttribute("aria-expanded", String(!collapsed));
    consoleToggle.textContent = collapsed ? "Show log" : "Hide log";
    if (!remember) return;
    try {
      doc.defaultView?.localStorage.setItem(CONSOLE_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Storage unavailable: the choice is just not remembered.
    }
  }
  try {
    setConsoleCollapsed(doc.defaultView?.localStorage.getItem(CONSOLE_COLLAPSED_KEY) === "1", false);
  } catch {
    // Storage unavailable: start expanded.
  }
  consoleToggle.addEventListener("click", () => {
    setConsoleCollapsed(!consoleBody.hidden, true);
    if (!consoleBody.hidden) {
      consoleFollow = true;
      renderConsoleLines();
    }
  });

  function resetConsole(): void {
    consoleEpoch++;
    consoleTruncated = false;
    if (consoleHandle !== null) env.clearTimeout(consoleHandle);
    consoleHandle = null;
    consoleView = EMPTY_CONSOLE_VIEW;
    consolePayload = null;
    consoleFailures = 0;
    consoleStopped = false;
    consolePaused = false;
    consoleLoaded = false;
    consoleFollow = true;
    consoleStepsKey = "";
    consoleRenderKey = "";
    consoleRenderedSeq = 0;
    consoleLog.replaceChildren();
    consoleSteps.replaceChildren();
    consolePauseBtn.setAttribute("aria-pressed", "false");
    consoleCard.hidden = true;
  }

  function setConsoleStatus(text: string): void {
    $("console-status").textContent = text;
  }

  function renderSteps(p: ConsolePayload): void {
    const key = JSON.stringify(p.phases);
    if (key === consoleStepsKey) return;
    consoleStepsKey = key;
    consoleSteps.replaceChildren(
      ...p.phases.map((ph) => {
        const li = make("li");
        li.dataset["status"] = ph.status;
        const mark = make("span", PHASE_MARKS[ph.status], "mark");
        mark.setAttribute("aria-hidden", "true");
        li.append(mark, make("span", ph.name), make("span", ` (${ph.status})`, "sr"));
        return li;
      }),
    );
  }

  function lineNode(l: ConsoleView["lines"][number]): HTMLElement {
    const row = make("div", undefined, "cl");
    row.append(make("span", lineTime(l.t), "ct"), doc.createTextNode(" "), make("span", `[${l.source}]`, "cs"), doc.createTextNode(" "), make("span", l.text, "cx"));
    return row;
  }

  function renderConsoleLines(): void {
    const shown = visibleLines(consoleView);
    const key = `${consoleView.generation}:${consoleView.clearedUpTo}`;
    if (key !== consoleRenderKey) {
      consoleRenderKey = key;
      consoleRenderedSeq = 0;
      consoleLog.replaceChildren();
    }
    const fresh = shown.filter((l) => l.seq > consoleRenderedSeq);
    if (fresh.length > 0) {
      consoleLog.append(...fresh.map(lineNode));
      consoleRenderedSeq = fresh[fresh.length - 1]!.seq;
    }
    while (consoleLog.childElementCount > shown.length) consoleLog.firstElementChild?.remove();
    if (consoleFollow) consoleLog.scrollTop = consoleLog.scrollHeight;
  }

  function renderConsole(): void {
    const p = consolePayload;
    const show = consoleCardVisible(state?.role ?? null, p);
    consoleCard.hidden = !show;
    if (state) renderAgentNotice(state);
    if (!show || p === null) return;
    renderSteps(p);
    const ended = $("console-ended");
    ended.textContent = p.instance.ended ? endedText(p.instance.ended_reason) : "";
    ended.hidden = !p.instance.ended;
    const note = $("console-note");
    note.textContent = consoleTruncated ? "Earlier lines were dropped to keep the console short." : "";
    note.hidden = !consoleTruncated;
    const err = $("console-error");
    const text =
      consoleFailures > 0
        ? "The console could not be updated. Trying again."
        : p.source_error !== null
          ? "Some logs are unavailable right now."
          : "";
    err.textContent = text;
    err.hidden = text === "";
    renderConsoleLines();
  }

  function canPollConsole(): boolean {
    return !stopped && active && !consoleStopped && state?.role === "admin";
  }

  function scheduleConsole(): void {
    if (!canPollConsole() || consolePaused || consoleHandle !== null) return;
    if (consoleLoaded && !consoleKeepsPolling(state?.state ?? null)) return;
    const delay = consoleDelayMs(doc.hidden, consoleFailures);
    if (delay === null) return;
    consoleHandle = env.setTimeout(() => {
      consoleHandle = null;
      void pollConsole();
    }, delay);
  }

  async function pollConsole(): Promise<void> {
    if (!canPollConsole() || consolePaused || consoleBusy || doc.hidden) return;
    if (consoleHandle !== null) env.clearTimeout(consoleHandle); // a manual poll replaces the timer
    consoleHandle = null;
    consoleBusy = true;
    const epoch = consoleEpoch;
    try {
      const parsed = parseConsole(await call("GET", `${CONSOLE_PATH}?after=${consoleView.lastSeq}`));
      if (epoch !== consoleEpoch) return; // logged out meanwhile: drop the answer
      if (parsed === null) throw new ApiError("The server sent a console this page cannot read.");
      if (consoleView.generation !== null && consoleView.generation !== parsed.generation) consoleTruncated = false;
      if (parsed.truncated) consoleTruncated = true;
      consoleView = mergeConsole(consoleView, parsed);
      consolePayload = parsed;
      consoleLoaded = true;
      consoleFailures = 0;
    } catch (err) {
      if (err instanceof AuthLostError || !active || epoch !== consoleEpoch) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        consoleStopped = true;
        consolePayload = null;
        renderConsole();
        return;
      }
      consoleFailures += 1;
    } finally {
      if (epoch === consoleEpoch) consoleBusy = false;
    }
    renderConsole();
    scheduleConsole();
  }

  // Start (or restart) polling when nothing is scheduled: after a state refresh, a tab that became
  // visible again, or a Resume. The first answer is fetched even without an instance, so the last
  // ended one can still be shown.
  function kickConsole(): void {
    if (!canPollConsole() || consolePaused || consoleHandle !== null || consoleBusy) return;
    if (consoleLoaded && !consoleKeepsPolling(state?.state ?? null)) return;
    void pollConsole();
  }

  consoleLog.addEventListener("scroll", () => {
    consoleFollow = isNearBottom(consoleLog.scrollTop, consoleLog.clientHeight, consoleLog.scrollHeight);
  });
  consolePauseBtn.addEventListener("click", () => {
    consolePaused = !consolePaused;
    consolePauseBtn.setAttribute("aria-pressed", String(consolePaused));
    if (consolePaused) {
      if (consoleHandle !== null) env.clearTimeout(consoleHandle);
      consoleHandle = null;
      setConsoleStatus("Paused. New lines are not loaded.");
    } else {
      setConsoleStatus("");
      void pollConsole();
    }
  });
  $("console-clear").addEventListener("click", () => {
    consoleView = clearConsoleView(consoleView);
    renderConsole();
    setConsoleStatus("View cleared.");
  });
  $("console-copy").addEventListener("click", () => {
    void (async () => {
      try {
        const clip = doc.defaultView?.navigator.clipboard;
        if (!clip) throw new Error("no clipboard");
        await clip.writeText(consoleExport(visibleLines(consoleView)));
        setConsoleStatus("Copied.");
      } catch {
        setConsoleStatus("Could not copy. Select the text and copy it by hand.");
      }
    })();
  });
  consoleDownload.addEventListener("click", (e) => {
    e.preventDefault();
    try {
      const win = doc.defaultView;
      if (!win) throw new Error("no window");
      const url = win.URL.createObjectURL(new win.Blob([consoleExport(visibleLines(consoleView))], { type: "text/plain;charset=utf-8" }));
      const a = make("a");
      a.href = url;
      a.download = consoleDownload.getAttribute("download") ?? "boot-console.txt";
      doc.body.append(a);
      a.click();
      a.remove();
      env.setTimeout(() => win.URL.revokeObjectURL(url), CONSOLE_REVOKE_MS);
      setConsoleStatus("Downloaded.");
    } catch {
      setConsoleStatus("Could not create the download.");
    }
  });

  // ---- usage history (admin only) ----

  const usageCard = $("usage-card");
  const usageBody = $("usage-body");
  const usageToggle = $<HTMLButtonElement>("usage-toggle");
  const usageList = $("usage-list");
  function setUsageCollapsed(collapsed: boolean, remember: boolean): void {
    usageBody.hidden = collapsed;
    usageToggle.setAttribute("aria-expanded", String(!collapsed));
    usageToggle.textContent = collapsed ? "Show history" : "Hide history";
    if (!remember) return;
    try {
      doc.defaultView?.localStorage.setItem(HISTORY_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Storage unavailable: the choice is just not remembered.
    }
  }
  try {
    setUsageCollapsed(doc.defaultView?.localStorage.getItem(HISTORY_COLLAPSED_KEY) === "1", false);
  } catch {
    // Storage unavailable: start expanded.
  }
  usageToggle.addEventListener("click", () => setUsageCollapsed(!usageBody.hidden, true));

  function resetUsage(): void {
    usageEpoch++;
    usageSeenState = null;
    usageBusy = false;
    usageDirty = false;
    usageList.replaceChildren();
    $("usage-empty").hidden = false;
    setText("usage-error", "");
    usageCard.hidden = true;
  }

  function usageRow(e: UsageEntry): HTMLElement {
    const li = make("li");
    const head = make("div");
    head.append(make("span", historyTime(e.started_at)), doc.createTextNode(" · "), make("span", formatDuration(e.duration_s)), doc.createTextNode(" · "), make("span", e.gpu_name ?? "—"));
    const meta = make("div", undefined, "um");
    meta.append(make("span", stopReasonText(e.reason, e.stop_by, e.active)), doc.createTextNode(" · "), make("span", `${formatCost(e.estimated_cost)} est.`));
    if (e.started_by !== null) meta.append(doc.createTextNode(" · "), make("span", `started by ${e.started_by}`));
    li.append(head, meta);
    return li;
  }

  async function loadUsage(): Promise<void> {
    if (usageBusy) {
      usageDirty = true;
      return;
    }
    usageBusy = true;
    usageDirty = false;
    const epoch = usageEpoch;
    try {
      const entries = parseHistory(await call("GET", API.history));
      if (epoch !== usageEpoch) return;
      if (entries === null) throw new ApiError("unreadable history");
      usageList.replaceChildren(...entries.map(usageRow));
      $("usage-empty").hidden = entries.length > 0;
      setText("usage-error", "");
    } catch (err) {
      if (err instanceof AuthLostError || epoch !== usageEpoch) return;
      // A short note in the card only: the history is never worth a page-wide banner.
      setText("usage-error", "The history could not be loaded. It is tried again when the instance state changes.");
    } finally {
      if (epoch === usageEpoch) usageBusy = false;
    }
    if (epoch === usageEpoch && usageDirty) void loadUsage();
  }

  /** Admins only: read the history on the first state and when the state turns none or ready. */
  function renderUsage(s: ApiState | null, isAdmin: boolean): void {
    if (!isAdmin || s === null) {
      if (!usageCard.hidden || usageSeenState !== null) resetUsage();
      return;
    }
    usageCard.hidden = false;
    const due = historyRefreshDue(usageSeenState, s.state);
    usageSeenState = s.state;
    if (due) void loadUsage();
  }

  // ---- render + polling loop ----

  function render(): void {
    const c = controls(state, busy, jobPending);
    if (state) {
      renderStatus(state);
      renderForm(state);
      renderGallery(state);
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
      renderUsage(state, true);
    } else {
      renderUsage(state, false);
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
    kickConsole();
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
    if (!doc.hidden) {
      void refresh();
      if (consoleHandle !== null) env.clearTimeout(consoleHandle);
      consoleHandle = null;
      kickConsole();
    } else schedulePoll();
  };
  doc.addEventListener("visibilitychange", onVisibility);

  const ready = start();
  return {
    ready,
    refresh,
    pollConsole,
    stop() {
      stopped = true;
      if (pollHandle !== null) env.clearTimeout(pollHandle);
      if (tickHandle !== null) env.clearTimeout(tickHandle);
      if (consoleHandle !== null) env.clearTimeout(consoleHandle);
      doc.removeEventListener("visibilitychange", onVisibility);
      for (const r of references.splice(0)) releaseUrl(r.url);
    },
  };
}
