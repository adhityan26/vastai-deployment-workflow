import {
  API,
  CLOCK_TICK_MS,
  DEFAULT_EXTEND_MINUTES,
  JOB_POLL_MAX_ERRORS,
  JOB_POLL_MS,
  characterCount,
  clockView,
  controls,
  errorText,
  formatCost,
  formatPrice,
  formatQueue,
  formatVram,
  imageUrl,
  isJobId,
  parseEstimate,
  parseSeed,
  parseState,
  pollIntervalMs,
  presetLabel,
  progressPercent,
  sizeLabel,
  stateInfo,
  type ApiState,
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

class ApiError extends Error {}

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
  let pollHandle: unknown = null;
  let tickHandle: unknown = null;
  let selectedPreset = "";
  let formKey = "";
  let adminBuilt = false;
  let unknownKey = "";
  let restoreFocus: HTMLElement | null = null;
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
    if (!res.ok) throw new ApiError(errorText(res.status, json));
    return json;
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
  modalOk.addEventListener("click", () => closeModal?.(true));
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

  function onStart(): Promise<void> {
    return act(async () => {
      const est = parseEstimate(await call("GET", API.estimate));
      if (est === null) throw new ApiError("The cost estimate was not understood. Nothing was started.");
      const gpu = est.gpu_name === null ? "" : ` (${est.gpu_name})`;
      const ok = await confirmDialog(
        "Start an instance?",
        [
          `Price: ${formatPrice(est.dph)}${gpu}.`,
          `Estimated cost if it runs for the full failsafe time (${est.horizon_hours} hours): up to ${formatCost(est.max_cost)}.`,
          "This estimate covers the failsafe time only; the failsafe can be extended up to the hard cap, which costs more.",
          "Disk storage is billed separately, per hour, for as long as the instance exists.",
          "You pay while the instance exists, even if nobody generates anything.",
        ],
        "Start and pay",
        false,
      );
      if (!ok) return;
      await call("POST", API.start, { confirm: true });
      showNotice("Starting. It can take several minutes to boot and download models.");
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
    const pct = progressPercent(s.progress);
    const info = stateInfo(s.state, pct);
    const line = $("state-line");
    line.textContent = info.label;
    line.dataset["tone"] = info.tone;
    const downloading = s.state === "downloading" && s.progress !== null;
    $("progress-box").hidden = !downloading;
    if (downloading && s.progress) {
      const bar = $<HTMLProgressElement>("progress");
      if (pct === null) bar.removeAttribute("value");
      else bar.value = pct;
      $("progress-file").textContent = s.progress.file;
    }
    $("alert-agent").hidden = !s.agent_unreachable;
    const failed = $("alert-failed");
    failed.hidden = !(s.state === "failed" || s.failed !== null);
    $("failed-reason").textContent = s.failed?.reason ?? "";
    const df = $("alert-destroy-failed");
    df.hidden = !(s.state === "destroy_failed" || s.destroy_failed !== null);
    $("destroy-failed-error").textContent = s.destroy_failed?.error ?? "";
    $("f-price").textContent = formatPrice(s.dph);
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
    if (stopped) return;
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
      // A network blip or a 5xx may pass; anything else (404, 403) will not.
      if (errors + 1 >= JOB_POLL_MAX_ERRORS) {
        return finishEntry(e, "failed", err instanceof Error ? err.message : "Lost contact with the server.");
      }
      env.setTimeout(() => void pollJob(e, errors + 1), JOB_POLL_MS);
    }
  }

  // ---- render + polling loop ----

  function render(): void {
    const c = controls(state, busy, jobPending);
    if (state) {
      renderStatus(state);
      renderForm(state);
    }
    if (c.showAdmin) {
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
    }
  }

  async function refresh(): Promise<void> {
    try {
      const parsed = parseState(await call("GET", API.state));
      if (parsed === null) throw new ApiError("The server sent a status this page cannot read.");
      state = parsed;
      fetchedAt = env.now();
      failures = 0;
      if (banner.dataset["source"] === "poll") {
        banner.hidden = true;
        delete banner.dataset["source"];
      }
    } catch (err) {
      failures += 1;
      showBanner(err instanceof Error ? err.message : "Status update failed.", true);
    }
    render();
    schedulePoll();
  }

  function schedulePoll(): void {
    if (stopped) return;
    if (pollHandle !== null) env.clearTimeout(pollHandle);
    pollHandle = env.setTimeout(() => void refresh(), pollIntervalMs(state?.state ?? null, doc.hidden, failures));
  }

  function tick(): void {
    if (stopped) return;
    renderClock();
    tickHandle = env.setTimeout(tick, CLOCK_TICK_MS);
  }

  const onVisibility = (): void => {
    if (!doc.hidden) void refresh();
    else schedulePoll();
  };
  doc.addEventListener("visibilitychange", onVisibility);

  tickHandle = env.setTimeout(tick, CLOCK_TICK_MS);
  const ready = refresh();
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
