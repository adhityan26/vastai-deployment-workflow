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
  startFailureText,
  serverText,
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
  GPU_STORAGE_KEY,
  DEFAULT_START_FILTERS,
  REGION_CHOICES,
  SORT_CHOICES,
  START_FILTERS_STORAGE_KEY,
  filterBodyMembers,
  filterQueryString,
  offerLabel,
  parseOffers,
  parseStoredFilters,
  startFilterProblem,
  startFiltersAreDefault,
  type OfferView,
  type StartFilterState,
  TOOL_STORAGE_KEY,
  chainTargets,
  chooseEntry,
  menuGroups,
  usableMenu,
  WIDE_SCREEN_QUERY,
  type MenuEntry,
  type MenuInfo,
  HISTORY_COLLAPSED_KEY,
  formatDuration,
  historyRefreshDue,
  historyTime,
  parseHistory,
  stopReasonText,
  type UsageEntry,
  JOB_POLL_MAX_ERRORS,
  JOB_POLL_MS,
  elapsedText,
  isPreviewType,
  jobPollDelayMs,
  parseJobProgress,
  parsePreviewSeq,
  previewPath,
  stepText,
  type JobProgress,
  characterCount,
  durationText,
  parseSeconds,
  type JobKind,
  chooseGpu,
  clockView,
  controls,
  downloadPercent,
  downloadText,
  errorCode,
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
  isChainableUrl,
  snapToStep,
  styleDefaults,
  styleRequest,
  referenceRuleText,
  referenceTag,
  referencesFit,
  stylesForMode,
  type EditInfo,
  type Mode,
  type PageMode,
  type FormValues,
  type Prefilled,
  advancedLabel,
  advancedRequest,
  knobsFor,
  snapGuidance,
  switchDefaults,
  usableDefaults,
  upscaleAsEdit,
  upscaleHint,
  upscaleLabel,
  type StyleInfo,
  type StyleParam,
  type StyleValue,
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
  panelActions,
  layoutMode,
  startCreditWarning,
  PANEL_STORAGE_KEY,
  parsePanelPref,
  widgetVisible,
  type LayoutMode,
  countdown,
  creditTone,
  creditToneText,
  pillView,
  windowSpeed,
  type ApiState,
  type Estimate,
  type GpuOption,
  type Sample,
} from "./model.js";
import { iconNode, uiIconNode } from "./icons.js";

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
  constructor(message: string, readonly reason: string | null = null, readonly status: number | null = null, readonly code: string | null = null) {
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
  kind: JobKind;
  prompt: string;
  label: string;
  /** How long the job took, once the server said so. */
  seconds: number | null;
  /** env.now() when it was submitted (the elapsed time of a running job). */
  submittedAt: number;
  /** The newest step counter while it runs. */
  progress: JobProgress | null;
  /** The preview_seq of the preview shown (or being fetched); a different one is fetched. */
  previewSeq: number;
  /** Object URL of the newest live preview; revoked when replaced and when the job ends. */
  previewUrl: string | null;
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
  let creditValue: number | null = null; // the last credit read (null: unknown or unreadable)
  let mode: PageMode = "generate"; // follows the selected menu entry (its tool)
  let selectedId: string | null = null; // the wanted menu entry; the one shown is chosen against the current menu
  const chosenStyle: Record<Mode, string | null> = { generate: null, edit: null }; // null = Standard
  let guidanceValue: number | null = null; // null = at the guidance default (the workflows' own cfg: nothing is sent)
  let prefilled: Prefilled = {}; // what the current style pre-filled, so leaving it undoes that
  let defaultsFor = ""; // "<mode>:<style id>" whose defaults are in the form
  const styleValues: Record<string, Record<string, StyleValue>> = {};
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
    if (!res.ok) throw new ApiError(errorText(res.status, json), errorReason(json), res.status, errorCode(json));
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
    if (overlay !== null) setOverlay(null, false);
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
  $("btn-logout").prepend(uiIconNode(doc, "logout"));
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
        setModalOpen(false);
        restoreFocus?.focus();
        resolve(ok);
      };
      setModalOpen(true);
      modalCancel.focus();
    });
  }

  /** Show or hide the confirmation layer (the floating widget never shows over it). */
  function setModalOpen(open: boolean): void {
    modal.hidden = !open;
    renderWidget();
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
    if (e.key === "Escape") {
      if (!modal.hidden) closeModal?.(false);
      else if (overlay !== null) setOverlay(null, true);
    }
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
      // The button that opened a confirmation was disabled while it ran: give it the focus back once enabled
      // (inside a drawer the focus must not fall out to the page).
      const at = doc.activeElement;
      if (restoreFocus?.isConnected && (at === null || at === doc.body || modal.contains(at))) restoreFocus.focus();
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
  function readFilters(): StartFilterState {
    try {
      return parseStoredFilters(doc.defaultView?.localStorage.getItem(START_FILTERS_STORAGE_KEY) ?? null);
    } catch {
      return DEFAULT_START_FILTERS; // storage unavailable: no remembered choice
    }
  }
  function writeFilters(f: StartFilterState): void {
    try {
      doc.defaultView?.localStorage.setItem(START_FILTERS_STORAGE_KEY, JSON.stringify(f));
    } catch {
      // Storage unavailable: the choice is just not remembered.
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
      // Advanced server choice: filters (remembered per device), a list of matching servers, an explicit pick.
      let filters = readFilters();
      let chosenOffer: number | null = null;
      const advanced = make("details");
      advanced.id = "start-advanced";
      advanced.open = !startFiltersAreDefault(filters);
      advanced.append(make("summary", "Advanced server choice"));
      const field = (labelText: string, id: string, control: HTMLElement): HTMLElement => {
        const row = make("div", undefined, "start-field");
        const label = make("label", labelText);
        label.htmlFor = id;
        control.id = id;
        row.append(label, control);
        return row;
      };
      const choiceSelect = (list: readonly { value: string; label: string }[], value: string): HTMLSelectElement => {
        const sel = make("select");
        for (const c of list) {
          const o = make("option", c.label);
          o.value = c.value;
          sel.append(o);
        }
        sel.value = value;
        return sel;
      };
      const regionSel = choiceSelect(REGION_CHOICES, filters.region);
      const sortSel = choiceSelect(SORT_CHOICES, filters.sort);
      const priceIn = make("input");
      priceIn.type = "text";
      priceIn.inputMode = "decimal";
      priceIn.autocomplete = "off";
      priceIn.placeholder = "no limit";
      priceIn.value = filters.maxDph;
      const speedIn = make("input");
      speedIn.type = "text";
      speedIn.inputMode = "numeric";
      speedIn.autocomplete = "off";
      speedIn.placeholder = "no minimum";
      speedIn.value = filters.minDown;
      const showOffers = make("button", "Show matching servers");
      showOffers.type = "button";
      const offerList = make("div", undefined, "start-offers");
      offerList.setAttribute("role", "radiogroup");
      offerList.setAttribute("aria-label", "Servers");
      offerList.hidden = true;
      const offerNote = make("p", "", "muted");
      offerNote.hidden = true;
      advanced.append(
        field("Region", "start-region", regionSel),
        field("Highest price per hour (USD)", "start-max-price", priceIn),
        field("Lowest download speed (Mbps)", "start-min-speed", speedIn),
        field("Order", "start-sort", sortSel),
        showOffers,
        offerNote,
        offerList,
      );
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
      $("modal-body").replaceChildren(loading, gpuLabel, select, gpuNote, advanced, estBox, errBox, ...notes);
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
        const where = serverText({ location: estimate.location, down_mbps: estimate.down_mbps });
        estBox.replaceChildren(
          make("p", `Price: ${formatPrice(estimate.dph)}${name}.`),
          ...(where === null ? [] : [make("p", `Server: ${where}.`)]),
          make("p", `Estimated cost if it runs for the full failsafe time (${estimate.horizon_hours} hours): up to ${formatCost(estimate.max_cost)}.`),
        );
        const low = startCreditWarning(creditValue, estimate.max_cost);
        if (low !== null) {
          const warn = make("p", low, "alert warn");
          warn.id = "start-credit-warning";
          estBox.append(warn);
        }
      };

      const loadEstimate = async (): Promise<void> => {
        const seq = ++estimateSeq;
        estimate = null;
        showEstimate();
        clearError();
        modalOk.disabled = true;
        if (select.value === "") return;
        try {
          const est = parseEstimate(await call("GET", estimatePath(select.value, filterQueryString(filters, chosenOffer))));
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
        setModalOpen(false);
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
          const res = await call("POST", API.start, { confirm: true, gpu: chosen, ...filterBodyMembers(filters, chosenOffer) });
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
          if (err instanceof ApiError && err.code === "offer_gone") {
            // The chosen server vanished: nothing was rented. Forget the pick and list the servers again.
            resetOffers();
            void loadEstimate(); // the price shown must be the automatic one again, not the vanished server's
            showError(err); // loadEstimate clears the error box first: say why again
            void loadOffers();
          }
          select.disabled = false;
          modalOk.disabled = estimate === null;
          modalOk.focus();
        } finally {
          busy = false;
          if (active) await refresh();
        }
      };

      setModalOpen(true);
      modalCancel.focus();

      const gpusPath = (): string => {
        const q = filterQueryString(filters, null);
        return q === "" ? API.gpus : `${API.gpus}?${q}`;
      };

      /** Read the GPU models (they follow the filters) and rebuild the select; false when it could not. */
      const populateGpus = async (keep: string | null): Promise<boolean> => {
        try {
          const list = parseGpus(await call("GET", gpusPath()));
          if (token !== dialogToken) return false;
          if (list === null) throw new ApiError("The GPU list was not understood. Nothing was started.");
          gpus = list;
        } catch (err) {
          if (token !== dialogToken || authLost(err)) return false;
          loading.hidden = true;
          showError(err);
          return false;
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
        const pick = chooseGpu(keep ?? readRemembered(), gpus);
        if (pick === null) {
          select.value = "";
          select.disabled = true;
          gpuNote.textContent = gpus.length === 0 ? "No GPU model is configured." : "No GPU model has offers right now. Try again later.";
          gpuNote.hidden = false;
          return true;
        }
        gpuNote.hidden = true;
        select.value = pick;
        select.disabled = false;
        return true;
      };

      const resetOffers = (): void => {
        chosenOffer = null;
        offerList.replaceChildren();
        offerList.hidden = true;
        offerNote.hidden = true;
      };

      /** Take the filter inputs; false (with the problem shown) when they cannot be sent. */
      const takeFilters = (): boolean => {
        const next: StartFilterState = { region: regionSel.value, maxDph: priceIn.value.trim(), minDown: speedIn.value.trim(), sort: sortSel.value };
        const problem = startFilterProblem(next);
        if (problem !== null) {
          estimateSeq++;
          estimate = null;
          showEstimate();
          modalOk.disabled = true;
          showError(new ApiError(problem));
          return false;
        }
        filters = next;
        writeFilters(filters);
        return true;
      };

      const onFiltersChanged = async (): Promise<void> => {
        if (startSubmitting) return;
        if (!takeFilters()) return;
        resetOffers();
        clearError();
        if (await populateGpus(select.value === "" ? null : select.value)) await loadEstimate();
      };
      for (const control of [regionSel, sortSel, priceIn, speedIn]) control.addEventListener("change", () => void onFiltersChanged());

      const loadOffers = async (): Promise<void> => {
        if (!takeFilters() || select.value === "") return;
        offerNote.hidden = false;
        offerNote.textContent = "Loading servers…";
        showOffers.disabled = true;
        try {
          const query = [`gpu=${encodeURIComponent(select.value)}`, filterQueryString(filters, null)].filter((p) => p !== "").join("&");
          const list = parseOffers(await call("GET", `${API.offers}?${query}`));
          if (token !== dialogToken) return;
          if (list === null) throw new ApiError("The server list was not understood. Nothing was started.");
          renderOffers(list);
        } catch (err) {
          if (token !== dialogToken || authLost(err)) return;
          offerNote.hidden = true;
          showError(err);
        } finally {
          showOffers.disabled = false;
        }
      };
      showOffers.addEventListener("click", () => void loadOffers());

      const renderOffers = (list: OfferView[]): void => {
        if (chosenOffer !== null) {
          chosenOffer = null;
          void loadEstimate(); // the listing replaced the pick: show the automatic price
        }
        offerList.replaceChildren();
        if (list.length === 0) {
          offerList.hidden = true;
          offerNote.hidden = false;
          offerNote.textContent = "No server matches these filters right now.";
          return;
        }
        offerNote.hidden = true;
        offerList.hidden = false;
        const choices: { id: number | null; text: string }[] = [
          { id: null, text: "Automatic: the first server of this list when you start" },
          ...list.map((o) => ({ id: o.id, text: offerLabel(o) })),
        ];
        choices.forEach((c, i) => {
          const row = make("label", undefined, "start-offer");
          const radio = make("input");
          radio.type = "radio";
          radio.name = "start-offer";
          radio.checked = i === 0;
          radio.addEventListener("change", () => {
            if (!radio.checked) return;
            chosenOffer = c.id;
            void loadEstimate();
          });
          row.append(radio, make("span", c.text));
          offerList.append(row);
        });
      };

      void (async () => {
        if (!(await populateGpus(null))) return;
        if (select.value === "") return;
        select.addEventListener("change", () => {
          resetOffers();
          void loadEstimate();
        });
        await loadEstimate();
      })();
    });
  }

  function onDestroy(): Promise<void> {
    return act(async () => {
      const ok = await confirmDialog(
        "Destroy the instance?",
        ["This stops billing and deletes the instance. Running jobs are lost.", ...costSoFarLine()],
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
  const dangerZone = $("danger-zone");
  const dangerTitle = $("danger-title");
  let extendWasPrimary = false;

  /** "Cost so far: $0.37." for the destroy confirmation, when an instance has a cost. */
  function costSoFarLine(): string[] {
    if (state === null || state.cost_so_far === null) return [];
    return [`Cost so far: ${clockView(state, Math.max(0, env.now() - fetchedAt)).cost}.`];
  }

  // The main action (Start or Extend) sits in the panel's admin section; Destroy and the untracked instances sit in
  // the danger zone at the bottom of the panel, never next to Extend.
  function buildAdmin(): void {
    adminBuilt = true;
    const start = make("button", "Start instance…", "primary");
    start.id = "btn-start";
    start.type = "button";
    start.addEventListener("click", () => void onStart());
    const hint = make("p", "", "muted");
    hint.id = "action-hint";
    hint.hidden = true;

    const extendBox = make("details", undefined, "extend-box");
    extendBox.id = "extend-box";
    const summary = make("summary", "Extend…");
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
    extendBox.append(summary, extend);
    adminPanel.replaceChildren(start, extendBox, hint);

    const destroy = make("button", "Destroy instance…", "danger");
    destroy.id = "btn-destroy";
    destroy.type = "button";
    destroy.addEventListener("click", () => void onDestroy());
    const unknownBox = make("details", undefined, "unknown-box");
    unknownBox.id = "unknown-box";
    unknownBox.hidden = true;
    const unknownSummary = make("summary", "Untracked instances on Vast");
    unknownSummary.id = "unknown-summary";
    const unknown = make("div", undefined, "unknown");
    unknown.id = "unknown";
    unknown.hidden = true;
    unknownBox.append(unknownSummary, unknown);
    dangerZone.replaceChildren(dangerTitle, destroy, unknownBox);
    extendWasPrimary = false;
  }

  /** Show the admin actions that fit the state; whether they are enabled stays with `controls`. */
  function renderActions(c: ReturnType<typeof controls>): void {
    const a = panelActions(state?.state ?? null);
    const start = $<HTMLButtonElement>("btn-start");
    start.hidden = !a.start;
    start.disabled = !c.canStart;
    const extendBox = $<HTMLDetailsElement>("extend-box");
    extendBox.hidden = !a.extend;
    // Near the idle shutdown Extend opens as the first choice, once: the admin may close it again.
    if (a.extendPrimary && !extendWasPrimary) extendBox.open = true;
    extendWasPrimary = a.extendPrimary;
    const go = $<HTMLButtonElement>("btn-extend");
    go.disabled = !c.canExtend;
    go.classList.toggle("primary", a.extendPrimary);
    setText("action-hint", a.hint);
    const destroy = $<HTMLButtonElement>("btn-destroy");
    destroy.hidden = !a.destroy;
    destroy.disabled = !c.canDestroy;
    if (destroy.textContent !== a.destroyLabel) destroy.textContent = a.destroyLabel;
    renderUnknown(state?.unknown ?? []);
    dangerZone.hidden = !a.destroy && (state?.unknown ?? []).length === 0;
  }

  function renderUnknown(list: ApiState["unknown"]): void {
    const key = JSON.stringify(list);
    if (key === unknownKey) return;
    unknownKey = key;
    const box = $("unknown");
    box.hidden = list.length === 0;
    $("unknown-box").hidden = list.length === 0;
    $("unknown-summary").textContent = `Untracked instances on Vast (${list.length})`;
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
    $("float-uptime").textContent = c.uptime;
    $("float-cost").textContent = c.cost;
    $("float-idle").textContent = c.idle;
    $("float-idle-cell").hidden = state.remaining.idle_s === null;
    renderPill(Math.max(0, env.now() - fetchedAt));
  }

  /** The header pill: a short label and the state's tone (never a live region: the state line is). */
  function renderPill(elapsedMs: number): void {
    const s = state;
    const pct = s === null ? null : s.download ? downloadPercent(s.download) : progressPercent(s.progress);
    const view = pillView(s?.state ?? null, pct, s === null ? null : countdown(s.remaining.idle_s, elapsedMs));
    const text = $("status-pill-text");
    if (text.textContent !== view.label) text.textContent = view.label;
    $("status-pill").dataset["tone"] = view.tone;
    $("float-status").dataset["tone"] = view.tone;
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
    // The only live region of the panel: set it only when the words change, so nothing is announced twice.
    if (line.textContent !== info.label) line.textContent = info.label;
    line.dataset["tone"] = info.tone;
    const noInstance = s.state === "none" && s.uptime_s === null;
    $("none-note").hidden = !noInstance;
    $("key-figures").hidden = noInstance;
    $("facts").hidden = noInstance;
    $("key-idle").hidden = s.remaining.idle_s === null;
    $("key-idle").dataset["tone"] = s.state === "idle-warning" ? "warn" : "";
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
    $("alert-start-failure").hidden = s.start_failure === null;
    const failedAt = s.start_failure === null ? null : serverText(s.start_failure.server);
    $("start-failure-text").textContent =
      s.start_failure === null ? "" : `${startFailureText(s.start_failure)}${failedAt === null ? "" : ` Server: ${failedAt}.`}`;
    const df = $("alert-destroy-failed");
    df.hidden = !(s.state === "destroy_failed" || s.destroy_failed !== null);
    $("destroy-failed-error").textContent = s.destroy_failed?.error ?? "";
    $("f-price").textContent = formatPrice(s.dph);
    $("f-gpu").textContent = s.gpu_name ?? "—";
    $("f-server").textContent = serverText(s.server) ?? "—";
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
  const editBox = $("edit-box");
  const promptRow = $("prompt-box");
  const samplingBox = $("sampling-box");
  const resolutionBox = $("resolution-box");
  const scaleBox = $("scale-box");
  const scaleSelect = $<HTMLSelectElement>("scale");
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
    // The menu decides the mode and the style. An entry can disappear (edit or upscale off, a style gone):
    // the first entry still offered takes over.
    const entry = syncSelection(s);
    $("gen-title").textContent = entry?.title ?? "Generate";
    setText("tool-desc", entry?.description ?? "");
    // Rebuild options only when the API's lists change, so a poll never resets the user's choice.
    const key = JSON.stringify([s.presets, s.sizes, s.edit, s.styles, s.upscale]);
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
      const keepScale = scaleSelect.value;
      scaleSelect.replaceChildren(
        ...(s.upscale?.scales ?? []).map((name) => {
          const o = make("option", name);
          o.value = name;
          return o;
        }),
      );
      if (s.upscale?.scales.includes(keepScale)) scaleSelect.value = keepScale;
    }
    // The picker follows the mode: edit takes several images, upscale exactly one.
    const refRules = refLimits(s);
    if (refRules !== null) {
      refInput.accept = acceptTypes(refRules);
      refInput.multiple = mode !== "upscale";
      const rule = mode === "edit" ? referenceRuleText(currentStyle(s)) : null;
      $("ref-hint").textContent = mode === "upscale" && s.upscale ? upscaleHint(s.upscale) : rule ?? (s.edit ? referenceHint(s.edit) : "");
    }
    renderStyles(s);
    // A style with its own prompt text takes the prompt as optional notes.
    const notes = mode !== "upscale" && currentStyle(s)?.promptOptional === true;
    $("prompt-label").textContent = notes ? "Notes (optional)" : "Prompt";
    renderAdvanced(s);
    const editing = mode === "edit";
    const upscaling = mode === "upscale";
    editBox.hidden = !editing && !upscaling;
    resolutionBox.hidden = upscaling;
    scaleBox.hidden = !upscaling;
    promptRow.hidden = upscaling;
    samplingBox.hidden = upscaling;
    sizeBox.hidden = editing || upscaling;
    promptBox.placeholder = notes
      ? "Optional notes for this style"
      : editing
        ? "Describe the change, e.g. make the girl in <image1> wear the jacket from <image2>"
        : "";
    const c = controls(s, busy, jobPending);
    const allowed = upscaling ? c.canUpscale : editing ? c.canEdit : c.canGenerate;
    generateBtn.disabled = !allowed;
    generateBtn.textContent = jobPending ? "Generating…" : upscaling ? "Upscale" : editing ? "Edit" : "Generate";
    $("gen-hint").textContent = jobPending
      ? "A job is running. You can submit another when it finishes."
      : allowed
        ? ""
        : s.state === "none"
          ? "No instance is running. An admin needs to start one."
          : "Generating is available when the instance is ready.";
  }

  // ---- style options (the panel of the selected entry's style) ----

  const styleBox = $("style-box");
  const styleParamsBox = $("style-params");
  const styleHint = $("style-hint");
  let styleKey = "";

  /** The style of the selected entry, only if the server still lists it for the current mode. */
  function currentStyle(s: ApiState | null): StyleInfo | null {
    if (mode === "upscale") return null;
    const id = chosenStyle[mode];
    return id === null || s === null ? null : stylesForMode(s.styles, mode).find((st) => st.id === id) ?? null;
  }

  function paramControl(style: StyleInfo, p: StyleParam): HTMLElement {
    const values = (styleValues[style.id] ??= styleDefaults(style));
    const wrap = make("div");
    const inputId = `style-${style.id}-${p.id}`;
    const label = make("label", p.title);
    label.htmlFor = inputId;
    if (p.type === "bool") {
      const box = make("input");
      box.type = "checkbox";
      box.id = inputId;
      box.checked = values[p.id] === true;
      box.addEventListener("change", () => { values[p.id] = box.checked; });
      wrap.append(box, label);
    } else if (p.type === "choice") {
      const sel = make("select");
      sel.id = inputId;
      for (const c of p.choices ?? []) {
        const o = make("option", c);
        o.value = c;
        sel.append(o);
      }
      sel.value = String(values[p.id]);
      sel.addEventListener("change", () => { values[p.id] = sel.value; });
      wrap.append(label, sel);
    } else {
      const range = make("input");
      range.type = "range";
      range.id = inputId;
      range.min = String(p.min);
      range.max = String(p.max);
      range.step = String(p.step);
      const shown = make("span", "", "style-value");
      const current = typeof values[p.id] === "number" ? (values[p.id] as number) : (p.default as number);
      range.value = String(current);
      shown.textContent = String(current);
      range.addEventListener("input", () => {
        const v = snapToStep(p, Number(range.value));
        values[p.id] = v;
        shown.textContent = String(v);
      });
      wrap.append(label, make("span", " "), shown, range);
    }
    return wrap;
  }

  function renderStyles(s: ApiState): void {
    const style = currentStyle(s);
    // Rebuild only when the style or its definition changes, so a poll never resets a slider.
    const key = JSON.stringify([mode, style?.id ?? null, style]);
    if (key === styleKey) return;
    styleKey = key;
    styleBox.hidden = style === null || style.params.length === 0;
    styleParamsBox.replaceChildren(...(style ? style.params.map((p) => paramControl(style, p)) : []));
    styleHint.textContent = style?.hint ?? "";
    styleHint.hidden = style?.hint == null;
    renderReferences(); // the slots follow the style's labels
  }

  // ---- Advanced: negative prompt and guidance, and the defaults a style pre-fills ----

  const advancedBox = $<HTMLDetailsElement>("advanced-box");
  const negativeRow = $("negative-row");
  const guidanceRow = $("guidance-row");
  const negativeBox = $<HTMLTextAreaElement>("negative");
  const guidanceInput = $<HTMLInputElement>("guidance");
  const guidanceOut = $("guidance-value");
  let guidanceKey = "";

  function showGuidance(s: ApiState): void {
    if (s.guidance === null) return;
    guidanceInput.value = String(guidanceValue === null ? s.guidance.default : snapGuidance(s.guidance, guidanceValue));
    guidanceOut.textContent = guidanceInput.value;
  }

  function formValues(): FormValues {
    return { negativePrompt: negativeBox.value, cfg: guidanceValue, preset: selectedPreset, size: sizeSelect.value, resolution: resolutionSelect.value };
  }

  /** Put a style's defaults in the form when the chosen style (or the mode) changes, undoing the previous style's. */
  function applyStyleDefaults(s: ApiState): void {
    const style = currentStyle(s);
    const key = `${mode}:${style?.id ?? ""}`;
    if (key === defaultsFor) return;
    defaultsFor = key;
    const next = switchDefaults(formValues(), prefilled, usableDefaults(style, s, mode));
    prefilled = next.prefilled;
    // A value pre-filled inside Advanced is never sent unseen: open the section. It is never closed here,
    // so whatever the user did with it stays.
    if (next.prefilled.negativePrompt !== undefined || next.prefilled.cfg !== undefined) advancedBox.open = true;
    const v = next.values;
    negativeBox.value = v.negativePrompt;
    guidanceValue = v.cfg;
    showGuidance(s);
    if (v.preset !== selectedPreset && s.presets.some((p) => p.name === v.preset)) {
      selectedPreset = v.preset;
      markPresets();
    }
    if (s.sizes.some((z) => z.name === v.size)) sizeSelect.value = v.size;
    if (s.edit?.resolutions.some((r) => r.name === v.resolution)) resolutionSelect.value = v.resolution;
  }

  function renderAdvanced(s: ApiState): void {
    const knobs = knobsFor(s, mode);
    advancedBox.hidden = !knobs.negativePrompt && !knobs.cfg;
    negativeRow.hidden = !knobs.negativePrompt;
    guidanceRow.hidden = !knobs.cfg;
    negativeBox.maxLength = s.advanced.negativeMaxChars;
    if (s.guidance !== null) {
      const key = JSON.stringify(s.guidance);
      if (key !== guidanceKey) {
        guidanceKey = key;
        guidanceInput.min = String(s.guidance.min);
        guidanceInput.max = String(s.guidance.max);
        guidanceInput.step = String(s.guidance.step);
        showGuidance(s);
      }
    }
    applyStyleDefaults(s);
  }

  guidanceInput.addEventListener("input", () => {
    const g = state?.guidance ?? null;
    const value = g === null ? Number(guidanceInput.value) : snapGuidance(g, Number(guidanceInput.value));
    guidanceValue = g !== null && value === g.default ? null : value;
    guidanceOut.textContent = String(value);
  });

  // ---- the tool menu (a sidebar on wide screens, a drawer on narrow ones) ----

  const nav = $("tool-nav");
  const pageBox = $("page");
  const menuList = $("menu-list");
  const menuSearch = $<HTMLInputElement>("menu-search");
  const menuEmpty = $("menu-empty");
  const menuOpenBtn = $<HTMLButtonElement>("menu-open");
  const menuCloseBtn = $<HTMLButtonElement>("menu-close");
  const menuBackdrop = $("menu-backdrop");
  let menuKey = "";
  let query = "";

  // The stored id is only ever compared with the ids of the current menu (chooseEntry), never shown or parsed.
  function readTool(): string | null {
    try {
      return doc.defaultView?.localStorage.getItem(TOOL_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }
  function writeTool(id: string): void {
    try {
      doc.defaultView?.localStorage.setItem(TOOL_STORAGE_KEY, id);
    } catch {
      // Storage unavailable: the choice is just not remembered.
    }
  }

  /** The entries offered now, in menu order. */
  function offeredEntries(): readonly MenuEntry[] {
    return state === null ? [] : usableMenu(state).items;
  }

  /**
   * The entry shown now: the chosen (or remembered) one when the menu still has it, else the first. A fallback
   * becomes the selection, so an entry that comes back later does not pull the form away. Sets mode and style.
   */
  function syncSelection(s: ApiState): MenuEntry | null {
    const menu = usableMenu(s);
    if (selectedId === null) selectedId = readTool();
    const entry = chooseEntry(selectedId, menu.items);
    if (entry !== null) selectedId = entry.id;
    mode = entry?.tool ?? "generate";
    if (mode !== "upscale") chosenStyle[mode] = entry?.style ?? null;
    renderMenu(menu, entry);
    return entry;
  }

  function menuButtons(): HTMLButtonElement[] {
    return Array.from(menuList.querySelectorAll<HTMLButtonElement>("button.menu-item"));
  }

  function renderMenu(menu: MenuInfo, entry: MenuEntry | null): void {
    // Rebuild only when the menu or the search changes (focus and scroll stay put across polls).
    const key = JSON.stringify([menu, query]);
    if (key !== menuKey) {
      menuKey = key;
      const groups = menuGroups(menu, query);
      menuList.replaceChildren(
        ...groups.map(({ category, items }) => {
          const group = make("section", undefined, "menu-group");
          const heading = make("h3", category.title, "menu-heading");
          heading.id = `menu-heading-${category.id}`;
          group.setAttribute("aria-labelledby", heading.id);
          const ul = make("ul");
          for (const item of items) {
            const b = make("button", undefined, "menu-item");
            b.type = "button";
            b.dataset["toolId"] = item.id;
            if (item.description !== null) b.title = item.description;
            b.append(iconNode(doc, item.icon), make("span", item.title, "menu-title"));
            b.addEventListener("click", () => selectEntry(item.id));
            const li = make("li");
            li.append(b);
            ul.append(li);
          }
          group.append(heading, ul);
          return group;
        }),
      );
      menuEmpty.hidden = groups.length > 0 || menu.items.length === 0;
    }
    for (const b of menuButtons()) {
      if (b.dataset["toolId"] === entry?.id) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
  }

  /**
   * Choose a menu entry: what the old mode switch and style selector did. From the drawer, the drawer closes and
   * the focus goes to the chosen tool's panel; in the sidebar it stays on the entry.
   */
  function selectEntry(id: string, focusPanel = true): void {
    if (!offeredEntries().some((i) => i.id === id)) return;
    selectedId = id;
    writeTool(id);
    showRefErrors([]);
    formError.hidden = true;
    styleKey = "";
    const fromDrawer = overlay === "menu";
    if (fromDrawer) setOverlay(null, false);
    if (state) renderForm(state);
    renderReferences();
    if (focusPanel && fromDrawer) $("gen-title").focus();
    else if (focusPanel) {
      // Scrolled down to the results: bring the panel's top back into view (never scroll otherwise).
      const card = $("tool-card");
      if (card.getBoundingClientRect().top < 0) card.scrollIntoView?.({ block: "start" });
    }
  }

  menuSearch.addEventListener("input", () => {
    query = menuSearch.value;
    if (state) renderMenu(usableMenu(state), chooseEntry(selectedId, usableMenu(state).items));
  });
  menuSearch.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      menuButtons()[0]?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = menuButtons()[0]?.dataset["toolId"];
      if (first !== undefined) selectEntry(first);
    }
  });
  menuList.addEventListener("keydown", (e) => {
    const buttons = menuButtons();
    const at = buttons.indexOf(doc.activeElement as HTMLButtonElement);
    if (at === -1) return;
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = buttons[Math.min(at + 1, buttons.length - 1)];
    else if (e.key === "ArrowUp") next = at === 0 ? menuSearch : buttons[at - 1];
    else if (e.key === "Home") next = buttons[0];
    else if (e.key === "End") next = buttons[buttons.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    next.focus();
  });

  menuOpenBtn.addEventListener("click", () => setOverlay(overlay === "menu" ? null : "menu", true));
  menuCloseBtn.addEventListener("click", () => setOverlay(null, true));
  menuBackdrop.addEventListener("click", () => setOverlay(null, true));
  // Focus trap: Tab and Shift+Tab wrap inside the open drawer.
  nav.addEventListener("keydown", (e) => {
    if (overlay !== "menu" || e.key !== "Tab") return;
    const stops = [menuCloseBtn, menuSearch, ...menuButtons()];
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    if (e.shiftKey && doc.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  // The menu drawer is a narrow-screen thing: a screen that becomes wide shows the sidebar instead.
  const wide = typeof doc.defaultView?.matchMedia === "function" ? doc.defaultView.matchMedia(WIDE_SCREEN_QUERY) : null;
  wide?.addEventListener?.("change", (e) => {
    if (e.matches && overlay === "menu") setOverlay(null, false);
  });

  // ---- overlays: the menu drawer, the panel drawer, the boot log dialog (one at a time) ----

  type Overlay = "menu" | "panel" | "log";
  let overlay: Overlay | null = null;
  let panelOpener: HTMLElement | null = null; // where the focus goes back when the panel drawer closes
  let logReturn: HTMLElement | null = null; // where the focus goes back when the log dialog closes
  const consoleDialog = $("console-card");
  const consoleBackdrop = $("console-backdrop");
  const consoleOpenBtn = $<HTMLButtonElement>("console-open");
  const consoleCloseBtn = $<HTMLButtonElement>("console-close");
  const statusPanel = $("status-panel");
  const statusTitle = $("status-title");
  const statusPill = $<HTMLButtonElement>("status-pill");
  const panelBackdrop = $("panel-backdrop");
  const panelClose = $<HTMLButtonElement>("panel-close");
  const panelHide = $<HTMLButtonElement>("panel-hide");

  /** The layout now; jsdom and old browsers without a width count as narrow. */
  function currentMode(): LayoutMode {
    return layoutMode(doc.defaultView?.innerWidth ?? 0);
  }

  // Whether the column is hidden (from 1280 px only; a drawer always starts closed). The stored word is only
  // compared with "collapsed"; storage can be missing or throw.
  let collapsed = false;
  try {
    collapsed = parsePanelPref(doc.defaultView?.localStorage.getItem(PANEL_STORAGE_KEY) ?? null) === "collapsed";
  } catch {
    collapsed = false;
  }
  function setCollapsed(next: boolean): void {
    collapsed = next;
    try {
      doc.defaultView?.localStorage.setItem(PANEL_STORAGE_KEY, next ? "collapsed" : "open");
    } catch {
      // Storage unavailable: the choice is just not remembered.
    }
    renderPanelState();
  }

  /** True at the wide layout: the panel is a column there (shown unless collapsed), never a drawer. */
  function panelIsColumn(): boolean {
    return currentMode() === "wide";
  }

  /**
   * Open one overlay (closing any other) or close it. While one is open the page behind it is inert; the focus moves
   * into it and, on close with returnFocus, back to what opened it.
   */
  function setOverlay(next: Overlay | null, returnFocus: boolean): void {
    const prev = overlay;
    overlay = next;
    nav.classList.toggle("open", next === "menu");
    menuBackdrop.hidden = next !== "menu";
    menuOpenBtn.setAttribute("aria-expanded", String(next === "menu"));
    statusPanel.classList.toggle("open", next === "panel");
    panelBackdrop.hidden = next !== "panel";
    consoleDialog.hidden = next !== "log";
    consoleBackdrop.hidden = next !== "log";
    pageBox.toggleAttribute("inert", next !== null);
    nav.toggleAttribute("inert", next === "panel" || next === "log");
    statusPanel.toggleAttribute("inert", next === "log");
    renderPanelState();
    if (next === "menu") menuSearch.focus();
    else if (next === "panel") statusTitle.focus();
    else if (next === "log") consoleCloseBtn.focus();
    else if (returnFocus && prev !== null) returnTarget(prev).focus();
  }

  function returnTarget(closed: Overlay): HTMLElement {
    const wanted = closed === "menu" ? menuOpenBtn : closed === "panel" ? panelOpener : logReturn;
    // The opener may be gone or hidden meanwhile (the widget, a summary that closed): the pill is always there.
    return wanted !== null && wanted.isConnected && wanted.closest("[hidden]") === null ? wanted : statusPill;
  }

  /** The pill (and the widget): at the wide layout bring the panel's heading into focus, else open the drawer. */
  function openPanelFrom(opener: HTMLElement): void {
    if (panelIsColumn()) {
      if (collapsed) setCollapsed(false);
      statusTitle.focus();
      return;
    }
    panelOpener = opener;
    setOverlay(overlay === "panel" ? null : "panel", true);
  }
  statusPill.addEventListener("click", () => openPanelFrom(statusPill));
  panelClose.addEventListener("click", () => setOverlay(null, true));
  panelHide.addEventListener("click", () => {
    setCollapsed(true);
    (floatBtn.hidden ? statusPill : floatBtn).focus(); // the Hide button is gone with the column
  });
  panelBackdrop.addEventListener("click", () => setOverlay(null, true));
  statusPanel.addEventListener("keydown", (e) => {
    if (overlay === "panel") trapTab(statusPanel, e);
  });

  // The boot log dialog: opened from the panel's boot summary. From the drawer it replaces the drawer, so the focus
  // then goes back to the pill.
  consoleOpenBtn.addEventListener("click", () => {
    logReturn = panelIsColumn() && !collapsed ? consoleOpenBtn : statusPill;
    setOverlay("log", false);
    consoleFollow = true;
    renderConsoleLines();
  });
  consoleCloseBtn.addEventListener("click", () => setOverlay(null, true));
  consoleBackdrop.addEventListener("click", () => setOverlay(null, true));
  consoleDialog.addEventListener("keydown", (e) => {
    if (overlay === "log") trapTab(consoleDialog, e);
  });

  /** The controls the Tab key can reach inside a container (jsdom has no layout: hidden attributes decide). */
  function tabStops(container: HTMLElement): HTMLElement[] {
    const all = Array.from(container.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, summary, [tabindex]"));
    return all.filter((el) => {
      if (el.tabIndex < 0 || (el as HTMLButtonElement).disabled === true || el.closest("[hidden]") !== null) return false;
      // Inside a closed <details> only its own summary can be reached.
      for (let d = el.parentElement?.closest("details") ?? null; d !== null; d = d.parentElement?.closest("details") ?? null) {
        if (!(d as HTMLDetailsElement).open && el.closest("summary")?.parentElement !== d) return false;
      }
      return true;
    });
  }

  /** Keep Tab and Shift+Tab inside an open overlay. */
  function trapTab(container: HTMLElement, e: KeyboardEvent): void {
    if (e.key !== "Tab") return;
    const stops = tabStops(container);
    if (stops.length === 0) return;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const at = doc.activeElement;
    if (e.shiftKey && (at === first || !container.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !container.contains(at))) {
      e.preventDefault();
      first.focus();
    }
  }

  /** The layout-dependent parts: which panel buttons are offered and whether the pill says the panel is shown. */
  function renderPanelState(): void {
    const column = panelIsColumn();
    panelHide.hidden = !column;
    panelClose.hidden = column;
    screens.app.classList.toggle("panel-collapsed", column && collapsed);
    statusPill.setAttribute("aria-expanded", String((column && !collapsed) || overlay === "panel"));
    renderWidget();
  }

  /** The floating widget: shown while the panel is off screen, an instance has an uptime and nothing covers the page. */
  const floatBtn = $<HTMLButtonElement>("float-status");
  function renderWidget(): void {
    const show = widgetVisible({ mode: currentMode(), collapsed, overlayOpen: overlay !== null || !modal.hidden, uptime: state?.uptime_s ?? null });
    floatBtn.hidden = !show;
    floatBtn.toggleAttribute("inert", overlay !== null);
    screens.app.classList.toggle("widget-on", show);
  }
  floatBtn.addEventListener("click", () => openPanelFrom(floatBtn));

  doc.defaultView?.addEventListener("resize", () => {
    if (overlay === "panel" && panelIsColumn()) setOverlay(null, false);
    else renderPanelState();
  });
  renderPanelState();

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

  /** The attach rules of the current mode (upscale: one image), or null when the mode takes none. */
  function refLimits(s: ApiState | null): EditInfo | null {
    if (s === null) return null;
    if (mode === "upscale") return s.upscale ? upscaleAsEdit(s.upscale) : null;
    return s.edit;
  }

  function showRefErrors(errors: readonly string[]): void {
    refError.textContent = errors.join(" ");
    refError.hidden = errors.length === 0;
  }

  const refSwap = $<HTMLButtonElement>("ref-swap");
  refSwap.addEventListener("click", () => {
    if (references.length !== 2) return;
    references.reverse();
    renderReferences();
  });

  function renderReferences(): void {
    // A style with labelled references shows its slots in order, the missing ones as empty slots.
    const style = mode === "edit" ? currentStyle(state) : null;
    const labels = style?.references?.labels ?? [];
    const empty = labels.slice(references.length).map((label) => make("li", `${label}: not attached yet`, "ref-empty"));
    refSwap.hidden = !(style?.references != null && references.length === 2);
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
        item.append(make("p", referenceTag(style, i), "ref-tag"), make("p", r.file.name, "ref-name"), remove);
        return item;
      }),
      ...empty,
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
    const edit = refLimits(state);
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
    void (mode === "upscale" ? submitUpscale() : mode === "edit" ? submitEdit() : submitGenerate());
  });

  async function submitGenerate(): Promise<void> {
    formError.hidden = true;
    if (!controls(state, busy, jobPending).canGenerate) return;
    const prompt = promptBox.value;
    const style = currentStyle(state);
    // A style with its own prompt text takes the prompt as optional notes (as in edit).
    if (prompt.trim() === "" && style?.promptOptional !== true) return formFail("Write a prompt first.");
    const seed = parseSeed($<HTMLInputElement>("seed").value);
    if (!seed.ok) return formFail(seed.message);
    if (selectedPreset === "" || sizeSelect.value === "") return formFail("Choose a quality and a size.");
    const body: Record<string, unknown> = { prompt, preset: selectedPreset, size: sizeSelect.value };
    if (seed.value !== undefined) body["seed"] = seed.value;
    if (state) Object.assign(body, advancedRequest({ knobs: knobsFor(state, "generate"), negative: negativeBox.value, guidance: state.guidance, guidanceValue }));
    const styleBody = styleRequest(style, style ? (styleValues[style.id] ??= styleDefaults(style)) : {});
    if (styleBody) body["style"] = styleBody;
    jobPending = true;
    if (state) renderForm(state);
    try {
      const res = await call("POST", API.generate, body);
      const id = typeof res === "object" && res !== null ? (res as Record<string, unknown>)["id"] : undefined;
      if (!isJobId(id)) throw new ApiError("The server returned an unusable job id.");
      const preset = state?.presets.find((p) => p.name === selectedPreset);
      const entry = addEntry(id, "generate", prompt.trim() === "" && style ? style.title : prompt, `${preset ? presetLabel(preset) : selectedPreset}, ${sizeSelect.selectedOptions[0]?.textContent ?? ""}${style ? `, ${style.title}` : ""}${advancedLabel(body)}`);
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
    const chosen = currentStyle(state);
    if (prompt.trim() === "" && chosen?.promptOptional !== true) return formFail("Describe the change first.");
    if (references.length === 0) return formFail("Attach at least one reference image.");
    if (!referencesFit(chosen, references.length)) return formFail(referenceRuleText(chosen) ?? "Attach the images this style needs.");
    const seed = parseSeed($<HTMLInputElement>("seed").value);
    if (!seed.ok) return formFail(seed.message);
    if (selectedPreset === "" || resolutionSelect.value === "") return formFail("Choose a quality and a resolution.");
    const files = references.map((r) => r.file);
    const style = currentStyle(state);
    const styleBody = styleRequest(style, style ? (styleValues[style.id] ??= styleDefaults(style)) : {});
    jobPending = true; // also blocks a second submit while the files are being read and sent
    if (state) renderForm(state);
    try {
      const images: string[] = [];
      for (const file of files) images.push(await readBase64(file));
      const body: Record<string, unknown> = { prompt, preset: selectedPreset, resolution: resolutionSelect.value, images };
      if (seed.value !== undefined) body["seed"] = seed.value;
      if (state) Object.assign(body, advancedRequest({ knobs: knobsFor(state, "edit"), negative: negativeBox.value, guidance: state.guidance, guidanceValue }));
      if (styleBody) body["style"] = styleBody;
      const res = await call("POST", API.edit, body);
      const id = typeof res === "object" && res !== null ? (res as Record<string, unknown>)["id"] : undefined;
      if (!isJobId(id)) throw new ApiError("The server returned an unusable job id.");
      const preset = state?.presets.find((p) => p.name === selectedPreset);
      const entry = addEntry(id, "edit", prompt.trim() === "" && style ? style.title : prompt, editLabel(preset ? presetLabel(preset) : selectedPreset, resolutionSelect.value, files.length) + (style ? `, ${style.title}` : "") + advancedLabel(body));
      void pollJob(entry, 0);
    } catch (err) {
      jobPending = false;
      formFail(err instanceof Error ? err.message : "Could not start the job.");
      if (state) renderForm(state);
    }
  }

  async function submitUpscale(): Promise<void> {
    formError.hidden = true;
    if (!controls(state, busy, jobPending).canUpscale) return;
    if (references.length !== 1) return formFail("Attach exactly one image to upscale.");
    if (scaleSelect.value === "") return formFail("Choose a scale.");
    const file = references[0]!.file;
    const scale = scaleSelect.value;
    jobPending = true;
    if (state) renderForm(state);
    try {
      const image = await readBase64(file);
      const res = await call("POST", API.upscale, { image, scale });
      const id = typeof res === "object" && res !== null ? (res as Record<string, unknown>)["id"] : undefined;
      if (!isJobId(id)) throw new ApiError("The server returned an unusable job id.");
      const entry = addEntry(id, "upscale", file.name, upscaleLabel(scale));
      void pollJob(entry, 0);
    } catch (err) {
      jobPending = false;
      formFail(err instanceof Error ? err.message : "Could not start the job.");
      if (state) renderForm(state);
    }
  }

  // ---- results ----

  const historyBox = $("history");
  function addEntry(id: string, kind: JobKind, prompt: string, label: string): HistoryEntry {
    const entry: HistoryEntry = { id, kind, prompt, label, seconds: null, submittedAt: env.now(), progress: null, previewSeq: 0, previewUrl: null, status: "pending", message: "", images: [], indexes: [], saves: [], saveMessages: [], node: make("article", undefined, "job") };
    history.unshift(entry);
    historyBox.prepend(entry.node);
    $("hist-empty").hidden = true;
    renderEntry(entry);
    return entry;
  }

  // ---- chaining: a result becomes the reference image of the next edit ----

  /** One button per way to continue from a result; null when no edit or upscale entry is offered or the url is not ours. */
  function chainButtons(src: string, name: string): HTMLElement | null {
    const targets = chainTargets(offeredEntries().filter((i) => i.tool !== "generate"));
    if (targets.length === 0 || !isChainableUrl(src)) return null;
    const row = make("div", undefined, "chain");
    for (const t of targets) {
      const b = make("button", t.title);
      b.type = "button";
      b.addEventListener("click", () => void chainResult(src, name, t.id));
      row.append(b);
    }
    return row;
  }

  async function chainResult(src: string, name: string, entryId: string): Promise<void> {
    const target = offeredEntries().find((i) => i.id === entryId);
    if (target === undefined) return;
    // One image for an upscale, so a result replaces whatever was attached; edit adds to the list.
    if (target.tool === "upscale") { while (references.length > 0) releaseUrl(references.pop()!.url); renderReferences(); }
    selectEntry(entryId, false);
    const rules = refLimits(state);
    if (rules === null) return;
    try {
      const res = await env.fetch(src, { credentials: "same-origin" });
      if (!res.ok) throw new ApiError("The result could not be loaded.");
      const blob = await res.blob();
      const result = pickReferences(references.length, [{ name, type: blob.type, size: blob.size }], rules);
      if (result.accepted.length > 0) {
        const FileCtor = doc.defaultView?.File;
        if (FileCtor === undefined) throw new ApiError("This browser cannot attach the result.");
        const file = new FileCtor([blob], `${name}.${blob.type.slice("image/".length)}`, { type: blob.type });
        references.push({ id: ++refSeq, file, url: previewUrl(file) });
        renderReferences();
      }
      showRefErrors(result.errors);
    } catch (err) {
      showRefErrors([err instanceof Error ? err.message : "The result could not be loaded."]);
    }
    if (state) renderForm(state);
    refList.scrollIntoView?.({ block: "nearest" });
  }

  function renderEntry(e: HistoryEntry): void {
    const kids: HTMLElement[] = [make("p", e.prompt, "job-prompt"), make("p", e.label, "muted")];
    if (e.status === "pending") {
      const p = make("p", "Generating…");
      p.setAttribute("role", "status");
      kids.push(p);
      // An upscale has no sampler steps: it only shows how long it has been running.
      if (e.progress !== null && e.kind !== "upscale") {
        const bar = make("progress");
        bar.max = e.progress.max;
        bar.value = e.progress.step;
        bar.setAttribute("aria-label", stepText(e.progress));
        kids.push(bar, make("p", stepText(e.progress), "muted job-step"));
      }
      kids.push(make("p", elapsedText(env.now() - e.submittedAt), "muted job-elapsed"));
      if (e.previewUrl !== null) {
        const fig = make("figure", undefined, "live-preview");
        const img = make("img");
        img.src = e.previewUrl;
        img.alt = "Live preview (rough)";
        fig.append(img, make("figcaption", "Live preview (rough)", "muted"));
        kids.push(fig);
      }
    } else if (e.status === "failed") {
      kids.push(make("p", `Failed: ${e.message}`, "alert bad"));
      kids[kids.length - 1]!.setAttribute("role", "alert");
    } else {
      const took = durationText(e.kind, e.seconds);
      if (took !== null) kids.push(make("p", took, "muted job-time"));
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
        const chain = chainButtons(src, `result-${e.id}-${i}`);
        if (chain !== null) fig.append(chain);
        grid.append(fig);
      });
      kids.push(grid);
    }
    e.node.replaceChildren(...kids);
  }

  /**
   * The per-result buttons (Save, Use as reference, Upscale) depend on what the server offers now, not when
   * the job finished: when that changes, the finished entries are drawn again from the current state.
   */
  let resultActionsKey = "";
  function renderResultActions(s: ApiState): void {
    const key = JSON.stringify([s.gallery, chainTargets(usableMenu(s).items.filter((i) => i.tool !== "generate"))]);
    if (key === resultActionsKey) return;
    resultActionsKey = key;
    for (const e of history) if (e.status === "done") renderEntry(e);
  }

  /** Forget the live preview of an entry (the final image replaces it). */
  function dropPreview(e: HistoryEntry): void {
    releaseUrl(e.previewUrl);
    e.previewUrl = null;
    e.progress = null;
  }

  function finishEntry(e: HistoryEntry, status: "done" | "failed", message = ""): void {
    e.status = status;
    e.message = message;
    dropPreview(e);
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
    const caption = [item.label, durationText(item.kind, item.seconds) ?? "", formatSavedAt(item.createdAt), formatBytes(item.size)];
    if (everyone && !item.mine && item.ownerName !== "") caption.push(item.ownerName);
    const dl = make("a", "Download", "dl");
    dl.href = item.url;
    dl.setAttribute("download", `gallery-${item.id}`);
    const del = make("button", "Delete");
    del.type = "button";
    del.addEventListener("click", () => void deleteGalleryItem(item, fig));
    fig.append(img, make("p", item.prompt, "gal-prompt"), make("p", caption.filter((c) => c !== "").join(" · "), "gal-caption"));
    const chain = chainButtons(item.url, `saved-${item.id.slice(0, 8)}`);
    if (chain !== null) fig.append(chain);
    fig.append(dl, del);
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


  /** Fetch the newest live preview of a running job; a failure only means no (new) preview is shown. */
  async function loadPreview(e: HistoryEntry, seq: number): Promise<void> {
    const path = previewPath(e.id);
    if (path === null) return;
    e.previewSeq = seq;
    try {
      const res = await env.fetch(path, { credentials: "same-origin" });
      if (!res.ok) return;
      const blob = await res.blob();
      if (!isPreviewType(blob.type) || e.status !== "pending" || e.previewSeq !== seq) return;
      const url = previewUrl(blob);
      if (url === null) return;
      releaseUrl(e.previewUrl);
      e.previewUrl = url;
      renderEntry(e);
    } catch {
      // no preview this time
    }
  }

  async function pollJob(e: HistoryEntry, errors: number): Promise<void> {
    if (stopped || !active) return;
    try {
      const askedAt = env.now();
      const res = await call("GET", `${API.generate}/${e.id}`);
      const latency = env.now() - askedAt;
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
        e.seconds = parseSeconds(r["seconds"]);
        return finishEntry(e, "done");
      }
      if (r["status"] === "failed") {
        return finishEntry(e, "failed", typeof r["message"] === "string" ? r["message"] : "Generation failed.");
      }
      // Still running: the step counter, a new preview only when the server has one, and a faster pace.
      e.progress = parseJobProgress(r["progress"]);
      const seq = parsePreviewSeq(r["preview_seq"]);
      renderEntry(e);
      if (seq !== 0 && seq !== e.previewSeq) void loadPreview(e, seq);
      env.setTimeout(() => void pollJob(e, 0), jobPollDelayMs(latency));
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
    let value: number | null = null;
    try {
      const reading = parseCredit(await call("GET", API.credit));
      if (reading !== null) {
        text = formatCredit(reading.credit);
        value = reading.credit;
      }
    } catch (err) {
      if (err instanceof AuthLostError) return;
    } finally {
      creditRunning = false;
    }
    $("f-credit").textContent = text;
    creditValue = value;
    renderCredit();
  }

  /** The credit's tone (it follows the current price) in the header and in the panel's first line. */
  function renderCredit(): void {
    const admin = state?.role === "admin";
    const tone = creditTone(creditValue, state?.dph ?? null);
    const word = creditToneText(tone);
    $("f-credit-box").dataset["tone"] = tone;
    $("f-credit-tone").textContent = word;
    const line = $("panel-credit");
    line.hidden = !admin;
    line.dataset["tone"] = tone;
    $("panel-credit-value").textContent = $("f-credit").textContent ?? "";
    $("panel-credit-tone").textContent = word;
  }

  // ---- boot console (admin only) ----

  const bootSummary = $("boot-summary");
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
    bootSummary.hidden = true;
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
    // The boot summary in the panel (stepper, sentence, ended notice, "View log") shows while the console is
    // relevant; the log itself is in a dialog. Polling does not depend on the dialog being open.
    const show = consoleCardVisible(state?.role ?? null, p);
    bootSummary.hidden = !show;
    if (!show && overlay === "log") setOverlay(null, true);
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
    const where = serverText({ location: e.location, down_mbps: e.down_mbps });
    if (where !== null) meta.append(doc.createTextNode(" · "), make("span", where));
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
      renderResultActions(state);
    }
    $("f-credit-box").hidden = !c.showAdmin;
    renderCredit();
    renderWidget();
    if (c.showAdmin) {
      if (creditDue(creditAskedAt, env.now(), creditRunning)) void refreshCredit();
      if (!adminBuilt) buildAdmin();
      adminPanel.hidden = false;
      renderActions(c);
      renderUsage(state, true);
    } else {
      renderUsage(state, false);
      adminPanel.replaceChildren();
      adminPanel.hidden = true;
      dangerZone.replaceChildren(dangerTitle);
      dangerZone.hidden = true;
      adminBuilt = false;
      unknownKey = "";
      creditAskedAt = Number.NEGATIVE_INFINITY;
      creditValue = null;
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
