import { describe, expect, it } from "vitest";
import {
  startFailureText,
  advancedLabel,
  advancedRequest,
  knobsFor,
  switchDefaults,
  usableDefaults,
  durationText,
  formatSeconds,
  parseSeconds,
  CONSOLE_POLL_MAX_MS,
  CONSOLE_POLL_MS,
  EMPTY_CONSOLE_VIEW,
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
  STATE_POLL_HIDDEN_MS,
  STATE_POLL_MAX_MS,
  STATE_POLL_MS,
  clockView,
  loginErrorMessage,
  loginErrorParam,
  screenForMe,
  withoutLoginError,
  controls,
  countdown,
  errorText,
  formatCost,
  formatDuration,
  formatQueue,
  formatVram,
  imageUrl,
  GPU_STORAGE_KEY,
  chooseGpu,
  downloadPercent,
  downloadText,
  errorDetail,
  errorReason,
  estimatePath,
  etaSeconds,
  formatEta,
  formatSpeed,
  gpuOptionLabel,
  parseEstimate,
  serverText,
  nextSamples,
  parseGpus,
  windowSpeed,
  parseSeed,
  parseState,
  pollIntervalMs,
  progressPercent,
  stateInfo,
  CREDIT_REFRESH_MS,
  creditDue,
  formatCredit,
  parseCredit,
  AUTOSAVE_STORAGE_KEY,
  formatBytes,
  formatSavedAt,
  galleryImageUrl,
  galleryPath,
  isGalleryId,
  parseGalleryPage,
  acceptTypes,
  base64FromDataUrl,
  editLabel,
  formatMegabytes,
  pickReferences,
  referenceHint,
  type EditInfo,
  isChainableUrl,
  upscaleAsEdit,
  upscaleHint,
  upscaleLabel,
  snapToStep,
  styleDefaults,
  styleRequest,
  stylesForMode,
  type StyleInfo,
  TOOL_STORAGE_KEY,
  chainTargets,
  chooseEntry,
  matchesQuery,
  menuGroups,
  usableMenu,
  type MenuEntry,
  START_FILTERS_STORAGE_KEY,
  errorCode,
  DEFAULT_START_FILTERS,
  filterBodyMembers,
  filterQueryString,
  offerLabel,
  parseOffers,
  parseStoredFilters,
  startFilterProblem,
  startFiltersAreDefault,
  VIDEO_WAIT_TEXT,
  durationLabel,
  EXPERIMENTAL_DURATION_WARNING,
  videoAsEdit,
  videoHint,
  videoLabel,
  videoUrl,
  videoDownloadLabel,
  videoModelsNote,
  EXPERT_LINK_NOTICE,
  expertsNote,
  familyDownloadBody,
  familyVideo,
  extraLoraMembers,
  extraLoraNote,
} from "../../public/model.js";
import {
  PANEL_STORAGE_KEY,
  creditTone,
  creditToneText,
  layoutMode,
  panelActions,
  parsePanelPref,
  pillView,
  startCreditWarning,
  widgetVisible,
} from "../../public/model.js";
import { DEFAULT_ICON, ICONS } from "../../public/icons.js";
import { MENU_ICONS, loadProfile, menuItems } from "@vast-comfy/core";
import { fileURLToPath } from "node:url";

const base = {
  state: "ready",
  role: "member",
  agent: null,
  agent_unreachable: false,
  failed: null,
  destroy_failed: null,
  dph: 0.36,
  uptime_s: 3600,
  cost_so_far: 0.36,
  progress: null,
  remaining: { idle_s: 600, failsafe_s: 7200, hard_cap_s: null },
  unknown: [],
  presets: [{ name: "fast", steps: 7 }],
  sizes: [{ name: "sq", width: 512, height: 512 }],
};

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59.9)).toBe("59s");
    expect(formatDuration(125)).toBe("2m 05s");
    expect(formatDuration(3600 * 2 + 300)).toBe("2h 05m");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("0s");
  });
  it("formats cost, queue and vram", () => {
    expect(formatCost(1.005)).toBe("$1.00");
    expect(formatCost(0.456)).toBe("$0.46");
    expect(formatCost(null)).toBe("—");
    expect(formatQueue({ running: 1, pending: 3 })).toBe("1 running, 3 waiting");
    expect(formatVram(12288, 24576)).toBe("12.0 / 24.0 GB");
    expect(formatVram(null, 24576)).toBe("—");
  });
  it("computes download progress", () => {
    const p = { phase: "models", file: "a", bytes_done: 50, bytes_total: 200 };
    expect(progressPercent(p)).toBe(25);
    expect(progressPercent({ ...p, bytes_done: 999 })).toBe(100);
    expect(progressPercent({ ...p, bytes_total: 0 })).toBeNull();
    expect(progressPercent(null)).toBeNull();
    expect(stateInfo("downloading", 25).label).toContain("25%");
    expect(stateInfo("destroy_failed").tone).toBe("bad");
    expect(stateInfo("something-new").label).toBe("something-new");
  });
});

describe("time between polls", () => {
  it("counts down without going below zero", () => {
    expect(countdown(100, 30_000)).toBe(70);
    expect(countdown(10, 60_000)).toBe(0);
    expect(countdown(null, 60_000)).toBeNull();
  });
  it("advances uptime and cost locally", () => {
    const s = parseState({ ...base })!;
    const v = clockView(s, 10_000);
    expect(v.uptime).toBe("1h 00m");
    expect(v.idle).toBe("9m 50s");
    expect(v.hardCap).toBe("—");
    expect(clockView(s, 3_600_000).cost).toBe("$0.72");
  });
});

describe("controls", () => {
  const s = (state: string, role = "admin") => parseState({ ...base, state, role });
  it("hides admin controls from members", () => {
    expect(controls(s("ready", "member"), false, false)).toMatchObject({ showAdmin: false, canStart: false, canDestroy: false, canExtend: false });
    expect(controls(s("ready"), false, false)).toMatchObject({ showAdmin: true, canDestroy: true, canExtend: true, canStart: false });
  });
  it("allows start only with no instance", () => {
    expect(controls(s("none"), false, false).canStart).toBe(true);
    expect(controls(s("none"), false, false).canDestroy).toBe(false);
    expect(controls(s("none"), true, false).canStart).toBe(false);
  });
  it("allows generate only when ready and no job pending", () => {
    for (const st of ["none", "creating", "booting", "downloading", "stopping", "failed", "destroy_failed"]) {
      expect(controls(s(st), false, false).canGenerate).toBe(false);
    }
    expect(controls(s("ready"), false, false).canGenerate).toBe(true);
    expect(controls(s("ready"), false, true).canGenerate).toBe(false);
    expect(controls(null, false, false).canGenerate).toBe(false);
  });
});

describe("polling interval", () => {
  it("slows down in the background and backs off on errors", () => {
    expect(pollIntervalMs("ready", false, 0)).toBe(STATE_POLL_MS);
    expect(pollIntervalMs("ready", true, 0)).toBe(STATE_POLL_HIDDEN_MS);
    expect(pollIntervalMs("ready", false, 2)).toBe(STATE_POLL_MS * 4);
    expect(pollIntervalMs("ready", true, 9)).toBe(STATE_POLL_MAX_MS);
    expect(pollIntervalMs("none", false, 0)).toBeGreaterThan(STATE_POLL_MS);
  });
});

describe("form helpers", () => {
  it("parses the seed", () => {
    expect(parseSeed("")).toEqual({ ok: true, value: undefined });
    expect(parseSeed(" 42 ")).toEqual({ ok: true, value: 42 });
    expect(parseSeed("-1").ok).toBe(false);
    expect(parseSeed("1.5").ok).toBe(false);
    expect(parseSeed("99999999999999999").ok).toBe(false);
  });
  it("builds image urls only from valid ids and indexes", () => {
    expect(imageUrl("abc-123_X", 2)).toBe("/api/image/abc-123_X/2");
    expect(imageUrl("a/b", 0)).toBeNull();
    expect(imageUrl("abc", "1")).toBeNull();
    expect(imageUrl("abc", -1)).toBeNull();
    expect(imageUrl("abc", 1.5)).toBeNull();
  });
  it("reads api error messages", () => {
    expect(errorText(409, { error: { code: "x", message: "not ready" } })).toBe("not ready");
    expect(errorText(500, "<html>")).toContain("500");
    expect(errorText(401, null)).toContain("sign in");
  });
  it("says a proxy may have replaced the answer when a 5xx has no JSON body (a Cloudflare 502/504 page)", () => {
    for (const status of [502, 504, 503, 500, 520]) {
      expect(errorText(status, null)).toBe(
        `The server could not be reached or a proxy replaced the answer (HTTP ${status}). Check the Status card and try again; the server log has the details.`,
      );
    }
    expect(errorText(502, { error: { code: "x", message: "" } })).toContain("a proxy replaced the answer (HTTP 502)");
    // A server JSON message always wins, whatever the status.
    expect(errorText(424, { error: { code: "start_failed", message: "Tailscale refused the OAuth client." } })).toBe("Tailscale refused the OAuth client.");
    // A 4xx without a body keeps the plain line.
    expect(errorText(424, null)).toBe("The request failed (HTTP 424).");
  });
  it("words the slow network failures, naming the measured speed only for slow_download", () => {
    const slow = "The rented machine's network is too slow";
    const retry = "It was released; try Start again, a different machine is chosen.";
    expect(startFailureText({ code: "slow_download", message: "", measured_mb_s: 2.8 })).toBe(
      `${slow} (about 2.8 MB/s to the model host). ${retry}`,
    );
    expect(startFailureText({ code: "slow_download", message: "", measured_mb_s: null })).toBe(`${slow}. ${retry}`);
    expect(startFailureText({ code: "slow_boot", message: "", measured_mb_s: 2.8 })).toBe(
      `The rented machine did not finish starting up in time. ${retry}`,
    );
    expect(startFailureText({ code: "boot_failed", message: "" })).toBe(
      "The rented machine's boot failed and it removed itself; try Start again.",
    );
    expect(parseState({ ...base, start_failure: { code: "slow_download", message: "m", measured_mb_s: 2.8 } })!.start_failure?.measured_mb_s).toBe(2.8);
    for (const bad of [-1, "2.8", Number.NaN, 1e9]) {
      expect(parseState({ ...base, start_failure: { code: "slow_download", message: "m", measured_mb_s: bad } })!.start_failure?.measured_mb_s).toBeNull();
    }
  });

  it("parses a start failure and drops a broken one", () => {
    expect(parseState({ ...base })!.start_failure).toBeNull();
    expect(parseState({ ...base, start_failure: { code: "start_stuck", message: "m" } })!.start_failure).toEqual({ code: "start_stuck", message: "m", server: null, measured_mb_s: null });
    expect(parseState({ ...base, start_failure: { code: 5 } })!.start_failure).toBeNull();
    expect(parseState({ ...base, start_failure: "start_stuck" })!.start_failure).toBeNull();
  });
  it("parses the server and words it, leaving out what is missing", () => {
    expect(parseState({ ...base })!.server).toBeNull();
    const s = parseState({ ...base, server: { location: "Quebec, CA", down_mbps: 860, up_mbps: 400, reliability: 0.99 } })!;
    expect(s.server).toEqual({ location: "Quebec, CA", down_mbps: 860 });
    expect(serverText(s.server)).toBe("Quebec, CA, 860 Mbps down");
    expect(serverText({ location: null, down_mbps: 860 })).toBe("860 Mbps down");
    expect(serverText({ location: "Quebec, CA", down_mbps: null })).toBe("Quebec, CA");
    expect(serverText({ location: null, down_mbps: null })).toBeNull();
    expect(serverText(null)).toBeNull();
    expect(parseState({ ...base, server: { location: "x".repeat(65), down_mbps: "fast" } })!.server).toBeNull();
    const f = parseState({ ...base, start_failure: { code: "start_stuck", message: "m", server: { location: "Paris, FR", down_mbps: null } } })!;
    expect(f.start_failure?.server).toEqual({ location: "Paris, FR", down_mbps: null });
    expect(parseEstimate({ gpu_name: "A", dph: 0.2, horizon_hours: 3, max_cost: 0.6, location: "Paris, FR", down_mbps: 300 })).toMatchObject({
      location: "Paris, FR", down_mbps: 300,
    });
    expect(parseEstimate({ gpu_name: "A", dph: 0.2, horizon_hours: 3, max_cost: 0.6 })).toMatchObject({ location: null, down_mbps: null });
  });

  it("rejects unusable state payloads", () => {
    expect(parseState(null)).toBeNull();
    expect(parseState({ state: "ready" })).toBeNull();
    expect(parseState({ ...base, presets: "nope" })!.presets).toEqual([]);
  });
});

describe("login helpers", () => {
  it("maps login_error codes to fixed messages", () => {
    expect(loginErrorMessage(null)).toBeNull();
    expect(loginErrorMessage("access_denied")).toBe("This account has no access.");
    expect(loginErrorMessage("session_too_large")).toBe("Login failed, please try again.");
    expect(loginErrorMessage("state_mismatch")).toBe("Login failed, please try again.");
    const hostile = "<img src=x onerror=alert(1)>";
    expect(loginErrorMessage(hostile)).toBe("Login failed, please try again.");
    expect(loginErrorMessage("__proto__")).toBe("Login failed, please try again.");
  });
  it("reads and strips login_error from a search string", () => {
    expect(loginErrorParam("?login_error=access_denied&x=1")).toBe("access_denied");
    expect(loginErrorParam("")).toBeNull();
    expect(withoutLoginError("?login_error=access_denied")).toBe("");
    expect(withoutLoginError("?login_error=a&x=1")).toBe("?x=1");
  });
  it("decides the screen from an /api/me answer", () => {
    expect(screenForMe(401, null).screen).toBe("login");
    expect(screenForMe(403, null).screen).toBe("noaccess");
    expect(screenForMe(500, null).screen).toBe("error");
    expect(screenForMe(200, "x").screen).toBe("error");
    expect(screenForMe(200, { name: "A", username: "a", role: "none" }).screen).toBe("noaccess");
    expect(screenForMe(200, { name: "A", username: "a", role: "admin" })).toEqual({ screen: "app", me: { name: "A", username: "a", role: "admin" } });
    expect(screenForMe(200, { name: null, username: "a", role: "member" }).me?.name).toBe("a");
  });
});


describe("GPU choice", () => {
  const list = [
    { name: "RTX A5000", dph: 0.25, vram_gb: 24, available: true, location: null, down_mbps: null },
    { name: "RTX 3090", dph: null, vram_gb: null, available: false, location: null, down_mbps: null },
    { name: "RTX 4090", dph: 0.45, vram_gb: 24, available: true, location: "Quebec, CA", down_mbps: 860 },
  ];
  it("parses the list and treats a missing price as unavailable", () => {
    expect(parseGpus({ gpus: list })).toEqual(list);
    expect(parseGpus({ gpus: [{ name: "X", dph: null, vram_gb: 1, available: true }, { name: "", dph: 1 }, 5] })).toEqual([{ name: "X", dph: null, vram_gb: 1, available: false, location: null, down_mbps: null }]);
    expect(parseGpus({ gpus: [{ name: "Y", dph: 1, vram_gb: 1, available: true, location: 7, down_mbps: -1 }] })![0]).toMatchObject({ location: null, down_mbps: null });
    expect(parseGpus({})).toBeNull();
    expect(parseGpus(null)).toBeNull();
  });
  it("labels options", () => {
    expect(gpuOptionLabel(list[0]!)).toBe("RTX A5000 - $0.25/h");
    expect(gpuOptionLabel(list[1]!)).toBe("RTX 3090 - no offers now");
    expect(gpuOptionLabel(list[2]!)).toBe("RTX 4090 - $0.45/h - Quebec, CA, 860 Mbps down");
  });
  it("chooses remembered, else cheapest available, else null", () => {
    expect(chooseGpu("RTX 4090", list)).toBe("RTX 4090");
    expect(chooseGpu("RTX 3090", list)).toBe("RTX A5000");
    expect(chooseGpu("nope", list)).toBe("RTX A5000");
    expect(chooseGpu(null, list)).toBe("RTX A5000");
    expect(chooseGpu("RTX 4090", [{ ...list[0]!, available: false }, list[1]!])).toBeNull();
    expect(chooseGpu(null, [])).toBeNull();
  });
  it("encodes the estimate path", () => {
    expect(estimatePath("RTX 4090")).toBe("/api/estimate?gpu=RTX%204090");
    expect(estimatePath("a&b=c#")).toBe("/api/estimate?gpu=a%26b%3Dc%23");
    expect(estimatePath(null)).toBe("/api/estimate");
    expect(GPU_STORAGE_KEY).toBeTruthy();
  });
  it("reads a plain reason only", () => {
    expect(errorReason({ error: { reason: "ts_key_missing" } })).toBe("ts_key_missing");
    expect(errorReason({ error: { reason: 5 } })).toBeNull();
    expect(errorReason({ error: { reason: "" } })).toBeNull();
    expect(errorReason(null)).toBeNull();
  });
  it("reads a plain detail only", () => {
    expect(errorDetail({ error: { reason: "ts_key_mint_failed", detail: "tailscale_unavailable" } })).toBe("tailscale_unavailable");
    expect(errorDetail({ error: { detail: "Not A Code" } })).toBeNull();
    expect(errorDetail({ error: { detail: 5 } })).toBeNull();
    expect(errorDetail({ error: {} })).toBeNull();
    expect(errorDetail(null)).toBeNull();
  });
});

describe("download progress", () => {
  const d = (over: Record<string, unknown> = {}) => ({ files_total: 3, files_done: 0, bytes_done: 2_100_000_000, bytes_total: 14_600_000_000, current_file: "a", ...over });
  it("computes the percent, null for an unknown total", () => {
    expect(downloadPercent(d())).toBe(14);
    expect(downloadPercent(d({ bytes_total: 0 }))).toBeNull();
    expect(downloadPercent(d({ bytes_done: 99e9 }))).toBe(100);
    expect(downloadPercent(null)).toBeNull();
  });
  it("parseState keeps a valid download and drops a broken one", () => {
    const ok = parseState({ ...base, gpu_name: "RTX 4090", download: d() })!;
    expect(ok.gpu_name).toBe("RTX 4090");
    expect(ok.download!.files_total).toBe(3);
    expect(parseState({ ...base, download: { ...d(), bytes_done: -1 } })!.download).toBeNull();
    expect(parseState({ ...base, download: { ...d(), bytes_total: "x" } })!.download).toBeNull();
    expect(parseState({ ...base })!.gpu_name).toBeNull();
    expect(parseState({ ...base, download: d({ bytes_done: 20e9 }) })!.download!.bytes_done).toBe(14_600_000_000);
  });
  it("needs two samples and a positive delta for a speed", () => {
    expect(windowSpeed([])).toBeNull();
    expect(windowSpeed([{ t: 0, bytes: 5 }])).toBeNull();
    expect(windowSpeed([{ t: 0, bytes: 5 }, { t: 1000, bytes: 5 }])).toBeNull();
    expect(windowSpeed([{ t: 0, bytes: 5 }, { t: 1000, bytes: 3 }])).toBeNull();
    expect(windowSpeed([{ t: 1000, bytes: 5 }, { t: 1000, bytes: 9 }])).toBeNull();
    expect(windowSpeed([{ t: 0, bytes: 0 }, { t: 2000, bytes: 100 }])).toBe(50);
  });
  it("keeps a moving window, replaces a same-time sample and resets on decrease, gap, clock back or state change", () => {
    let s = nextSamples([], 0, "downloading", d({ bytes_done: 0 }));
    for (let i = 1; i <= 10; i++) s = nextSamples(s, i * 1000, "downloading", d({ bytes_done: i * 100 }));
    expect(s).toHaveLength(6);
    expect(windowSpeed(s)).toBe(100);
    expect(nextSamples(s, 10_000, "downloading", d({ bytes_done: 1000 }))).toHaveLength(6);
    expect(nextSamples(s, 11_000, "downloading", d({ bytes_done: 5 }))).toEqual([{ t: 11_000, bytes: 5 }]);
    expect(nextSamples(s, 10_000 + 200_000, "downloading", d({ bytes_done: 2000 }))).toHaveLength(1);
    expect(nextSamples(s, 5_000, "downloading", d({ bytes_done: 2000 }))).toHaveLength(1);
    expect(nextSamples(s, 11_000, "ready", d())).toEqual([]);
    expect(nextSamples(s, 11_000, "downloading", null)).toEqual([]);
    expect(nextSamples(s, Number.NaN, "downloading", d())).toEqual([]);
  });
  it("computes the ETA only with a speed and a known remaining size", () => {
    expect(etaSeconds(d(), 12.5e6)).toBe(1000);
    expect(etaSeconds(d(), null)).toBeNull();
    expect(etaSeconds(d(), 0)).toBeNull();
    expect(etaSeconds(d({ bytes_total: 0 }), 1e6)).toBeNull();
    expect(etaSeconds(d({ bytes_done: 14_600_000_000 }), 1e6)).toBeNull();
    expect(etaSeconds(d(), Number.NaN)).toBeNull();
    expect(Number.isFinite(etaSeconds(d({ bytes_total: 1e300 }), 1e-300)!) || etaSeconds(d({ bytes_total: 1e300 }), 1e-300) === null).toBe(true);
  });
  it("formats speed and ETA", () => {
    expect(formatSpeed(38e6)).toBe("38 MB/s");
    expect(formatSpeed(2.1e6)).toBe("2.1 MB/s");
    expect(formatSpeed(1.5e9)).toBe("1.5 GB/s");
    expect(formatSpeed(500)).toBe("1 KB/s");
    expect(formatSpeed(250e3)).toBe("250 KB/s");
    expect(formatEta(0.2)).toBe("about 1 s left");
    expect(formatEta(40)).toBe("about 40 s left");
    expect(formatEta(300)).toBe("about 5 min left");
    expect(formatEta(3900)).toBe("about 1 h 05 min left");
    expect(formatEta(1e12)).toBe("more than 99 h left");
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatEta(Number.NaN)).toBe("");
    expect(formatEta(-5)).toBe("");
  });
  it("builds the overall text", () => {
    expect(downloadText(d(), null)).toBe("2.1 / 14.6 GB (14%) - file 1 of 3");
    expect(downloadText(d({ files_done: 0, bytes_done: 2_100_000_000 }), 38e6)).toBe("2.1 / 14.6 GB (14%) - file 1 of 3 - 38 MB/s - about 5 min left");
    expect(downloadText(d({ files_done: 3 }), null)).toContain("file 3 of 3");
    expect(downloadText(d({ bytes_total: 0 }), 1e6)).toBe("2.1 GB - file 1 of 3 - 1.0 MB/s");
    expect(downloadText(d({ bytes_done: 5e6, bytes_total: 50e6 }), null)).toBe("5.0 / 50.0 MB (10%) - file 1 of 3");
    expect(downloadText(d({ bytes_done: 9e17, bytes_total: 1e18 }), 1e9)).not.toMatch(/NaN|Infinity/);
  });
});

describe("edit info from the state", () => {
  const edit = { max_references: 4, max_bytes: 8_388_608, max_pixels: 16_777_216, types: ["png", "jpeg", "webp"], resolutions: [{ name: "1024", value: 1024 }] };

  it("is null when the server sends none, or something unusable", () => {
    expect(parseState(base)!.edit).toBeNull();
    expect(parseState({ ...base, edit: null })!.edit).toBeNull();
    const bad: unknown[] = [
      "yes",
      { ...edit, max_references: 0 },
      { ...edit, max_references: 1.5 },
      { ...edit, max_bytes: "8" },
      { ...edit, max_pixels: -1 },
      { ...edit, types: [] },
      { ...edit, types: ["gif"] },
      { ...edit, types: "png" },
      { ...edit, resolutions: [] },
      { ...edit, resolutions: [{ name: "x" }] },
      { ...edit, resolutions: [{ name: 5, value: 1 }] },
    ];
    for (const e of bad) expect(parseState({ ...base, edit: e })!.edit, JSON.stringify(e)).toBeNull();
  });

  it("is kept when valid", () => {
    expect(parseState({ ...base, edit })!.edit).toEqual({ ...edit, sizes: [] });
  });

  it("only canEdit when generating is possible and the server offers edit", () => {
    const withEdit = (state: string) => parseState({ ...base, state, edit })!;
    expect(controls(withEdit("ready"), false, false).canEdit).toBe(true);
    expect(controls(withEdit("booting"), false, false).canEdit).toBe(false);
    expect(controls(withEdit("ready"), false, true).canEdit).toBe(false);
    expect(controls(parseState({ ...base, state: "ready" }), false, false).canEdit).toBe(false);
    expect(controls(null, false, false).canEdit).toBe(false);
  });
});

describe("reference helpers", () => {
  const info: EditInfo = {
    max_references: 3,
    max_bytes: 2_097_152,
    max_pixels: 1_000_000,
    types: ["png", "jpeg"],
    resolutions: [{ name: "1024", value: 1024 }],
    sizes: [],
  };
  const file = (name: string, type = "image/png", size = 1000) => ({ name, type, size });

  it("builds the accept list and the hint from the limits", () => {
    expect(acceptTypes(info)).toBe("image/png,image/jpeg");
    expect(referenceHint(info)).toBe("Up to 3 images (PNG, JPEG), 2.0 MB each. Refer to them as <image1>, <image2> in the prompt. You can also paste an image (Ctrl/Cmd+V).");
    expect(formatMegabytes(8_388_608)).toBe("8.0 MB");
    expect(formatMegabytes(1_572_864)).toBe("1.5 MB");
  });

  it("accepts valid files in order and reports the others by name", () => {
    const r = pickReferences(0, [file("a.png"), file("b.txt", "text/plain"), file("c.jpg", "image/jpeg"), file("d.png", "image/png", 9_999_999), file("e.png", "image/png", 0)], info);
    expect(r.accepted).toEqual([0, 2]);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toContain("b.txt");
    expect(r.errors[0]).toContain("PNG, JPEG");
    expect(r.errors[1]).toContain("d.png");
    expect(r.errors[1]).toContain("2.0 MB");
    expect(r.errors[2]).toContain("e.png");
  });

  it("rejects a type the server does not list even if it is an image", () => {
    expect(pickReferences(0, [file("x.webp", "image/webp"), file("y.gif", "image/gif")], info).accepted).toEqual([]);
  });

  it("stops at the maximum, counting what is already there, with one message", () => {
    const r = pickReferences(2, [file("a.png"), file("b.png"), file("c.png")], info);
    expect(r.accepted).toEqual([0]);
    expect(r.errors).toEqual(["At most 3 images can be attached."]);
    expect(pickReferences(3, [file("a.png")], info).accepted).toEqual([]);
  });

  it("shortens very long file names in messages", () => {
    const r = pickReferences(0, [file(`${"n".repeat(200)}.txt`, "text/plain")], info);
    expect(r.errors[0]!.length).toBeLessThan(200);
  });

  it("takes the base64 payload out of a data URL, and nothing else", () => {
    expect(base64FromDataUrl("data:image/png;base64,QUJD")).toBe("QUJD");
    expect(base64FromDataUrl("data:;base64,QUJD")).toBe("QUJD");
    for (const bad of ["", "QUJD", "data:image/png,QUJD", "data:image/png;base64,", "data:image/png;base64,QU JD", "http://x/y;base64,QUJD"]) {
      expect(base64FromDataUrl(bad), bad).toBeNull();
    }
  });

  it("labels an edit job", () => {
    expect(editLabel("fast (7 steps)", "1024", 1)).toBe("Edit: fast (7 steps), 1024, 1 reference");
    expect(editLabel("fast (7 steps)", "1024", 3)).toBe("Edit: fast (7 steps), 1024, 3 references");
  });
});

describe("Vast credit", () => {
  it("formats dollars, with a minus sign when the credit is used up", () => {
    expect(formatCredit(4.5377)).toBe("$4.54");
    expect(formatCredit(0)).toBe("$0.00");
    expect(formatCredit(-1.25)).toBe("-$1.25");
    expect(formatCredit(-0.001)).toBe("$0.00");
    expect(formatCredit(1234.5)).toBe("$1234.50");
  });

  it("parses only a finite credit number", () => {
    expect(parseCredit({ credit: 4.5, as_of: 1_800_000_000 })).toEqual({ credit: 4.5, asOf: 1_800_000_000 });
    expect(parseCredit({ credit: 0 })).toEqual({ credit: 0, asOf: null });
    for (const bad of [null, "4", [], {}, { credit: "4.5" }, { credit: null }, { credit: Number.NaN }, { credit: Infinity }]) {
      expect(parseCredit(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("asks again once the refresh interval has passed, never while a read is running", () => {
    expect(CREDIT_REFRESH_MS).toBe(60_000);
    expect(creditDue(Number.NEGATIVE_INFINITY, 1000, false)).toBe(true);
    expect(creditDue(1000, 1000 + CREDIT_REFRESH_MS - 1, false)).toBe(false);
    expect(creditDue(1000, 1000 + CREDIT_REFRESH_MS, false)).toBe(true);
    expect(creditDue(Number.NEGATIVE_INFINITY, 1000, true)).toBe(false);
  });
});

describe("boot console model", () => {
  const line = (seq: number, text = `l${seq}`, source = "agent") => ({ seq, t: 1_700_000_000 + seq, source, text });
  const payload = (over: Record<string, unknown> = {}) => ({
    generation: 1,
    instance: { state: "booting", ended: false, ended_reason: null },
    phases: [
      { id: "tailscale", name: "Join Tailscale", status: "running" },
      { id: "agent", name: "Start agent", status: "pending" },
    ],
    lines: [line(1), line(2)],
    last_seq: 2,
    truncated: false,
    ...over,
  });

  it("parseConsole accepts the API shape and drops bad lines and phases", () => {
    const p = parseConsole(payload({ lines: [line(1), { seq: -1, text: "x" }, { seq: 2 }, "no"], phases: [{ id: "a", name: "A", status: "weird" }, { id: "b", name: "B", status: "done" }] }));
    expect(p!.lines.map((l) => l.seq)).toEqual([1]);
    expect(p!.phases.map((x) => x.id)).toEqual(["b"]);
    expect(p!.source_error).toBeNull();
    expect(parseConsole(payload({ source_error: "vast_logs_unavailable" }))!.source_error).toBe("vast_logs_unavailable");
    expect(parseConsole(null)).toBeNull();
    expect(parseConsole({ ...payload(), instance: null })).toBeNull();
    expect(parseConsole({ ...payload(), last_seq: "2" })).toBeNull();
  });

  it("mergeConsole appends by seq without duplicates", () => {
    let v = mergeConsole(EMPTY_CONSOLE_VIEW, parseConsole(payload())!);
    expect(v.lines.map((l) => l.seq)).toEqual([1, 2]);
    v = mergeConsole(v, parseConsole(payload({ lines: [line(2), line(3), line(1)], last_seq: 3 }))!);
    expect(v.lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(v.lastSeq).toBe(3);
  });

  it("mergeConsole replaces everything on a new generation and keeps the newest lines under the cap", () => {
    let v = mergeConsole(EMPTY_CONSOLE_VIEW, parseConsole(payload())!);
    v = mergeConsole(v, parseConsole(payload({ generation: 2, lines: [line(10)], last_seq: 10 }))!);
    expect(v.lines.map((l) => l.seq)).toEqual([10]);
    const many = Array.from({ length: 10 }, (_, i) => line(i + 1));
    const capped = mergeConsole(EMPTY_CONSOLE_VIEW, parseConsole(payload({ lines: many, last_seq: 10 }))!, 4);
    expect(capped.lines.map((l) => l.seq)).toEqual([7, 8, 9, 10]);
  });

  it("clear view hides what is held and later lines still show; export is the visible lines", () => {
    let v = mergeConsole(EMPTY_CONSOLE_VIEW, parseConsole(payload())!);
    v = clearConsoleView(v);
    expect(visibleLines(v)).toEqual([]);
    expect(consoleExport(visibleLines(v))).toBe("");
    v = mergeConsole(v, parseConsole(payload({ lines: [line(3, "after clear")], last_seq: 3 }))!);
    expect(visibleLines(v).map((l) => l.seq)).toEqual([3]);
    expect(consoleExport(visibleLines(v))).toBe(`${lineTime(1_700_000_003)} [agent] after clear\n`);
  });

  it("auto-scroll pauses when scrolled up and resumes at the bottom", () => {
    expect(isNearBottom(900, 100, 1000)).toBe(true);
    expect(isNearBottom(890, 100, 1000)).toBe(true); // within the slack
    expect(isNearBottom(500, 100, 1000)).toBe(false);
    expect(isNearBottom(0, 0, 0)).toBe(true);
  });

  it("lineTime is UTC HH:MM:SS and tolerates junk", () => {
    expect(lineTime(0)).toBe("--:--:--");
    expect(lineTime(3661)).toBe("01:01:01");
  });

  it("polling delay backs off, is capped and is null while the tab is hidden", () => {
    expect(consoleDelayMs(false, 0)).toBe(CONSOLE_POLL_MS);
    expect(consoleDelayMs(false, 2)).toBe(CONSOLE_POLL_MS * 4);
    expect(consoleDelayMs(false, 50)).toBe(CONSOLE_POLL_MAX_MS);
    expect(consoleDelayMs(true, 0)).toBeNull();
    expect(consoleKeepsPolling("booting")).toBe(true);
    expect(consoleKeepsPolling("none")).toBe(false);
    expect(consoleKeepsPolling(null)).toBe(false);
  });

  it("card is visible for admins while an instance exists or ended, never for members", () => {
    const live = parseConsole(payload())!;
    const ended = parseConsole(payload({ instance: { state: "none", ended: true, ended_reason: "destroyed" } }))!;
    const none = parseConsole(payload({ instance: { state: "none", ended: false, ended_reason: null } }))!;
    expect(consoleCardVisible("admin", live)).toBe(true);
    expect(consoleCardVisible("admin", ended)).toBe(true);
    expect(consoleCardVisible("admin", none)).toBe(false);
    expect(consoleCardVisible("admin", null)).toBe(false);
    expect(consoleCardVisible("member", live)).toBe(false);
    expect(consoleCardVisible(null, live)).toBe(false);
  });

  it("endedText names the reason from a fixed map", () => {
    expect(endedText("destroyed")).toContain("destroyed");
    expect(endedText("<b>x</b>")).toBe("Instance ended.");
    expect(endedText(null)).toBe("Instance ended.");
    expect(endedText("start_stuck")).toBe("Instance ended: the rented machine did not start.");
    expect(endedText("boot_stopped")).toBe("Instance ended: the container stopped during the boot.");
  });

  it("bootSentence follows the running phase and is null otherwise", () => {
    expect(bootSentence(parseConsole(payload())!)).toBe("Installing tools and joining Tailscale, usually 2-4 minutes");
    const run = (id: string) => parseConsole(payload({ phases: [{ id, name: "N", status: "running" }] }))!;
    for (const id of ["image_pull", "net_probe", "install_tools", "failsafe", "agent", "nodes", "models", "comfyui"]) {
      expect(bootSentence(run(id))).toMatch(/\S/);
    }
    expect(bootSentence(run("something_new"))).toBe("N, in progress");
    expect(bootSentence(run("ready"))).toBeNull();
    expect(bootSentence(parseConsole(payload({ phases: [{ id: "tailscale", name: "J", status: "failed" }] }))!)).toBeNull();
    expect(bootSentence(parseConsole(payload({ phases: [{ id: "agent", name: "A", status: "pending" }] }))!)).toBeNull();
    expect(bootSentence(parseConsole(payload({ instance: { state: "none", ended: true, ended_reason: "gone" } }))!)).toBeNull();
    expect(bootSentence(null)).toBeNull();
  });
});

describe("gallery helpers", () => {
  const ID = `${"a".repeat(32)}.8199999999000.job-1_x.0`;
  const entry = (over: Record<string, unknown> = {}) => ({
    id: ID, url: `/api/gallery/${ID}/image`, created_at: 1_800_000_000, kind: "generate", prompt: "a fox", label: "preview, 1:1", owner_name: "Ayu", mine: true, size: 12345, ...over,
  });

  it("knows what a gallery id looks like", () => {
    expect(isGalleryId(ID)).toBe(true);
    for (const bad of ["", "x", `${ID}/..`, `../${ID}`, ID.toUpperCase(), `${ID}\n`, 5, null, `${"a".repeat(32)}.1.job.0`]) expect(isGalleryId(bad), String(bad)).toBe(false);
  });

  it("builds image urls from the id, never from server text", () => {
    expect(galleryImageUrl(ID)).toBe(`/api/gallery/${ID}/image`);
    expect(galleryImageUrl("../x")).toBeNull();
  });

  it("builds the list path: own images, a cursor, or everyone", () => {
    expect(galleryPath(null, false)).toBe("/api/gallery");
    expect(galleryPath(null, true)).toBe("/api/gallery?scope=all");
    expect(galleryPath(ID, false)).toBe(`/api/gallery?cursor=${ID}`);
    expect(galleryPath(ID, true)).toBe(`/api/gallery?scope=all&cursor=${ID}`);
    expect(galleryPath("not an id", false)).toBe("/api/gallery"); // a bad cursor is dropped, not sent
  });

  it("parses a page, keeps the entries it can trust and rebuilds their urls", () => {
    const page = parseGalleryPage({ items: [entry({ url: "https://evil.example/x.png" }), entry({ id: "bad" }), entry({ kind: "weird" }), entry({ size: "big" }), 5], next: ID });
    expect(page).not.toBeNull();
    expect(page!.items).toHaveLength(2);
    expect(page!.items[0]).toEqual({ id: ID, url: `/api/gallery/${ID}/image`, createdAt: 1_800_000_000, kind: "generate", prompt: "a fox", label: "preview, 1:1", ownerName: "Ayu", mine: true, size: 12345, seconds: null });
    expect(page!.items[1]!.kind).toBe("generate"); // an unknown kind falls back instead of dropping the image
    expect(parseGalleryPage({ items: [entry({ kind: "upscale" }), entry({ kind: "edit" })], next: null })!.items.map((i) => i.kind)).toEqual(["upscale", "edit"]);
    expect(page!.next).toBe(ID);
    expect(parseGalleryPage({ items: [], next: null })).toEqual({ items: [], next: null });
    expect(parseGalleryPage({ items: [], next: "junk" })!.next).toBeNull();
    for (const bad of [null, "x", [], {}, { items: "no" }]) expect(parseGalleryPage(bad), JSON.stringify(bad)).toBeNull();
  });

  it("formats time and size", () => {
    expect(formatSavedAt(1_800_000_000)).toBe("2027-01-15 08:00 UTC");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1_900_000)).toBe("1.8 MB");
  });

  it("reads the gallery flag from the state, off when absent or not exactly true", () => {
    expect(parseState(base)!.gallery).toBe(false);
    expect(parseState({ ...base, gallery: true })!.gallery).toBe(true);
    expect(parseState({ ...base, gallery: "yes" })!.gallery).toBe(false);
    expect(AUTOSAVE_STORAGE_KEY).toBe("vast-comfy.autosave");
  });
});

describe("styles from the state", () => {
  const strength = { id: "strength", title: "LoRA strength", type: "float", min: 0.4, max: 1, step: 0.05, default: 0.7 };
  const style = { id: "anything2real", title: "Anything to Real", modes: ["edit"], params: [strength] };
  const parsed = { ...style, promptOptional: false, references: null, hint: null, defaults: {} };

  it("is an empty list when the server sends none or something unusable", () => {
    expect(parseState(base)!.styles).toEqual([]);
    expect(parseState({ ...base, styles: "x" })!.styles).toEqual([]);
    expect(parseState({ ...base, styles: [style] })!.styles).toEqual([parsed]);
  });

  it("reads a preset's reference rule, optional prompt and hint; leaves out a style with an unusable rule", () => {
    const swap = { id: "faceswap", title: "Face swap", kind: "preset", modes: ["edit"], params: [], prompt_optional: true, references: { min: 2, max: 2, labels: ["Scene to keep", "Face to use", "extra"] }, hint: "Ask first." };
    expect(parseState({ ...base, styles: [swap] })!.styles).toEqual([
      { id: "faceswap", title: "Face swap", modes: ["edit"], params: [], promptOptional: true, references: { min: 2, max: 2, labels: ["Scene to keep", "Face to use"] }, hint: "Ask first.", defaults: {} },
    ]);
    for (const references of [{ min: 0, max: 2 }, { min: 3, max: 2 }, { min: 1, max: 99 }, { min: "2", max: 2 }, "two"]) {
      expect(parseState({ ...base, styles: [{ ...swap, references }, style] })!.styles.map((s) => s.id)).toEqual(["anything2real"]);
    }
  });

  it("leaves out a style whose panel cannot be drawn faithfully, keeps the others", () => {
    const bad: unknown[] = [
      { ...style, id: "" },
      { ...style, modes: ["upscale"] },
      { ...style, modes: "edit" },
      { ...style, params: [{ ...strength, type: "text" }] },
      { ...style, params: [{ ...strength, step: 0 }] },
      { ...style, params: [{ ...strength, min: 2 }] },
      { ...style, params: [{ ...strength, default: 5 }] },
      { ...style, params: [{ id: "c", title: "C", type: "choice", choices: ["a"], default: "b" }] },
      { ...style, params: [{ id: "c", title: "C", type: "choice", choices: [], default: "" }] },
      { ...style, params: [{ id: "b", title: "B", type: "bool", default: "yes" }] },
      null,
    ];
    for (const b of bad) expect(parseState({ ...base, styles: [b, { ...style, id: "ok" }] })!.styles.map((x) => x.id), JSON.stringify(b)).toEqual(["ok"]);
  });

  it("lists the styles of a mode, with defaults, and builds the request", () => {
    const all = parseState({ ...base, styles: [style, { id: "both", title: "Both", modes: ["generate", "edit"], params: [{ id: "on", title: "On", type: "bool", default: true }] }] })!.styles;
    expect(stylesForMode(all, "generate").map((x) => x.id)).toEqual(["both"]);
    expect(stylesForMode(all, "edit").map((x) => x.id)).toEqual(["anything2real", "both"]);
    const a = all[0] as StyleInfo;
    expect(styleDefaults(a)).toEqual({ strength: 0.7 });
    expect(styleRequest(null, {})).toBeUndefined();
    expect(styleRequest(a, { strength: 0.8 })).toEqual({ id: "anything2real", params: { strength: 0.8 } });
    expect(styleRequest(a, {})).toEqual({ id: "anything2real", params: { strength: 0.7 } });
  });

  it("snaps slider values onto the grid and inside the limits", () => {
    const p = parseState({ ...base, styles: [style] })!.styles[0]!.params[0]!;
    expect(snapToStep(p, 0.7000000000000001)).toBe(0.7);
    expect(snapToStep(p, 0.62)).toBe(0.6);
    expect(snapToStep(p, 5)).toBe(1);
    expect(snapToStep(p, -3)).toBe(0.4);
    expect(snapToStep(p, Number.NaN)).toBe(0.7);
  });

  it("chains only our own result paths", () => {
    expect(isChainableUrl("/api/image/abc_1-2/0")).toBe(true);
    const gid = `${"a".repeat(32)}.8199999999000.job-1_x.0`;
    expect(isChainableUrl(`/api/gallery/${gid}/image`)).toBe(true);
    for (const u of [`/api/gallery/${gid}/delete`, "/api/gallery/x/image", `/api/gallery/${gid}/../image`, `//evil.example/api/gallery/${gid}/image`]) {
      expect(isChainableUrl(u), u).toBe(false);
    }
    for (const u of ["https://evil.example/api/image/a/0", "//evil.example/x", "/api/image/a/../0", "/api/image/a/0?x=1", "/api/other/a/0", "data:image/png;base64,AA"]) {
      expect(isChainableUrl(u), u).toBe(false);
    }
  });
});

describe("upscale info from the state", () => {
  const up = { scales: ["2x", "4x"], max_bytes: 8_388_608, max_pixels: 16_777_216, types: ["png", "jpeg"] };

  it("is null when absent or unusable, kept when valid", () => {
    expect(parseState(base)!.upscale).toBeNull();
    const bad: unknown[] = ["yes", { ...up, scales: [] }, { ...up, scales: [""] }, { ...up, scales: "2x" }, { ...up, max_bytes: 0 }, { ...up, max_pixels: 1.5 }, { ...up, types: ["gif"] }, { ...up, types: [] }];
    for (const b of bad) expect(parseState({ ...base, upscale: b })!.upscale, JSON.stringify(b)).toBeNull();
    expect(parseState({ ...base, upscale: up })!.upscale).toEqual(up);
  });

  it("canUpscale needs a ready instance, the section and no pending job", () => {
    const s = (state: string) => parseState({ ...base, state, upscale: up })!;
    expect(controls(s("ready"), false, false).canUpscale).toBe(true);
    expect(controls(s("booting"), false, false).canUpscale).toBe(false);
    expect(controls(s("ready"), false, true).canUpscale).toBe(false);
    expect(controls(parseState({ ...base, state: "ready" })!, false, false).canUpscale).toBe(false);
  });

  it("takes one image under the server limits", () => {
    expect(upscaleAsEdit(up)).toMatchObject({ max_references: 1, max_bytes: 8_388_608, types: ["png", "jpeg"] });
    expect(upscaleHint(up)).toBe("One image (PNG, JPEG), 8.0 MB at most. The result size is limited by the server. You can also paste an image (Ctrl/Cmd+V).");
    expect(upscaleLabel("2x")).toBe("Upscale: 2x");
  });
});

describe("job durations", () => {
  it("formats seconds for people", () => {
    expect(formatSeconds(0)).toBe("0.0 s");
    expect(formatSeconds(4.25)).toBe("4.3 s");
    expect(formatSeconds(9.96)).toBe("10.0 s");
    expect(formatSeconds(52.3)).toBe("52 s");
    expect(formatSeconds(119.4)).toBe("119 s");
    expect(formatSeconds(125)).toBe("2 min 5 s");
  });

  it("uses the verb of the kind and says nothing when the duration is unknown", () => {
    expect(durationText("generate", 52.3)).toBe("Generated in 52 s");
    expect(durationText("edit", 30)).toBe("Edited in 30 s");
    expect(durationText("upscale", 3)).toBe("Upscaled in 3.0 s");
    expect(durationText("generate", null)).toBeNull();
  });

  it("accepts only plausible numbers from the server", () => {
    expect(parseSeconds(12.5)).toBe(12.5);
    for (const bad of ["12", -1, Number.NaN, Number.POSITIVE_INFINITY, 1e9, null, undefined, {}]) expect(parseSeconds(bad)).toBeNull();
  });
});

describe("Advanced: knobs, the request and style defaults", () => {
  const guidance = { min: 1, max: 6, step: 0.5, default: 1 };
  const both = { negative_prompt: true, cfg: true };
  const state = (over: Record<string, unknown> = {}) =>
    parseState({
      ...base,
      guidance,
      advanced: { generate: both, edit: { negative_prompt: true, cfg: false }, negative_prompt_max_chars: 10 },
      presets: [{ name: "fast", steps: 5 }, { name: "slow", steps: 50 }],
      sizes: [{ name: "sq", width: 512, height: 512 }],
      edit: { max_references: 2, max_bytes: 1000, max_pixels: 1000, types: ["png"], resolutions: [{ name: "1024", value: 1024 }] },
      ...over,
    })!;

  it("reads the per-mode knobs; an old server without them offers none", () => {
    expect(state().advanced).toEqual({ generate: { negativePrompt: true, cfg: true }, edit: { negativePrompt: true, cfg: false }, negativeMaxChars: 10 });
    expect(parseState(base)!.advanced).toEqual({ generate: { negativePrompt: false, cfg: false }, edit: { negativePrompt: false, cfg: false }, negativeMaxChars: 1000 });
    expect(knobsFor(state(), "edit")).toEqual({ negativePrompt: true, cfg: false });
    expect(knobsFor(state(), "upscale")).toEqual({ negativePrompt: false, cfg: false });
    expect(knobsFor(state({ guidance: null }), "generate")).toEqual({ negativePrompt: true, cfg: false }); // no range, no slider
  });

  it("keeps only well-typed style defaults", () => {
    const st = { id: "s", title: "S", modes: ["generate"], params: [], defaults: { negative_prompt: "x", cfg: "3", preset: 5, size: "sq", extra: 1 } };
    expect(state({ styles: [st] }).styles[0]!.defaults).toEqual({ negativePrompt: "x", size: "sq" });
  });

  it("sends only what differs from untouched", () => {
    const knobs = { negativePrompt: true, cfg: true };
    expect(advancedRequest({ knobs, negative: "  ", guidance, guidanceValue: null })).toEqual({});
    expect(advancedRequest({ knobs, negative: "", guidance, guidanceValue: 1 })).toEqual({}); // the default is the workflow's own
    expect(advancedRequest({ knobs, negative: " hat ", guidance, guidanceValue: 3.4 })).toEqual({ negative_prompt: "hat", cfg: 3.5 });
    expect(advancedRequest({ knobs: { negativePrompt: false, cfg: false }, negative: "hat", guidance, guidanceValue: 3 })).toEqual({});
    expect(advancedLabel({ cfg: 3.5, negative_prompt: "hat" })).toBe(", guidance 3.5, negative prompt");
    expect(advancedLabel({})).toBe("");
  });

  it("uses only the defaults this server and mode can take", () => {
    const st = (defaults: Record<string, unknown>, modes = ["generate", "edit"]) => state({ styles: [{ id: "s", title: "S", modes, params: [], defaults }] });
    const s1 = st({ negative_prompt: "0123456789abc", cfg: 3.2, preset: "slow", size: "sq", resolution: "1024" });
    const style = s1.styles[0]!;
    expect(usableDefaults(style, s1, "generate")).toEqual({ negativePrompt: "0123456789", cfg: 3, preset: "slow", size: "sq" });
    expect(usableDefaults(style, s1, "edit")).toEqual({ negativePrompt: "0123456789", preset: "slow", resolution: "1024" }); // edit takes no cfg here
    const s2 = st({ preset: "ultra", size: "huge" });
    expect(usableDefaults(s2.styles[0]!, s2, "generate")).toEqual({});
    expect(usableDefaults(null, s1, "generate")).toEqual({});
  });

  it("switches defaults: undoes the previous style's untouched pre-fill, keeps the user's changes", () => {
    const start = { negativePrompt: "", cfg: null, preset: "fast", size: "sq", resolution: "1024" };
    const a = switchDefaults(start, {}, { negativePrompt: "blurry", cfg: 3, preset: "slow" });
    expect(a.values).toEqual({ ...start, negativePrompt: "blurry", cfg: 3, preset: "slow" });
    const touched = { ...a.values, negativePrompt: "blurry, hats" };
    const b = switchDefaults(touched, a.prefilled, {});
    expect(b.values).toEqual({ ...start, negativePrompt: "blurry, hats" });
    expect(b.prefilled).toEqual({});
    const c = switchDefaults(a.values, a.prefilled, { cfg: 2 }); // straight to another style
    expect(c.values).toEqual({ ...start, cfg: 2 });
    expect(switchDefaults(c.values, c.prefilled, {}).values).toEqual(start);
  });
});

describe("the tool menu", () => {
  const editInfo = { max_references: 2, max_bytes: 1000, max_pixels: 1000, types: ["png"], resolutions: [{ name: "1024", value: 1024 }] };
  const upscale = { scales: ["2x"], max_bytes: 1000, max_pixels: 1000, types: ["png"] };
  const item = (over: Record<string, unknown> = {}) => ({ id: "t", title: "T", description: null, icon: "image", category: "create", tool: "generate", style: null, available: true, ...over });
  const menu = (items: unknown[], categories: unknown[] = [{ id: "create", title: "Create" }, { id: "edit", title: "Edit" }]) => ({ categories, items });
  const state = (over: Record<string, unknown> = {}) => parseState({ ...base, presets: [], sizes: [], ...over })!;
  const entry = (over: Partial<MenuEntry> = {}): MenuEntry => ({ id: "t", title: "T", description: null, icon: "image", category: "create", tool: "generate", style: null, available: true, ...over });

  it("reads the server's menu and leaves out entries it cannot draw faithfully", () => {
    const s = state({
      menu: menu(
        [
          item({ id: "text_to_image", title: "Text to image", description: "Describe it." }),
          item({ id: "dup", title: "A" }),
          item({ id: "dup", title: "B" }), // a second entry with the same id
          item({ id: "Bad Id" }),
          item({ id: "nocat", category: "nowhere" }),
          item({ id: "blank", title: "  " }),
          item({ id: "long", title: "x".repeat(201) }),
          item({ id: "tool", tool: "audio" }),
          item({ id: "upstyle", tool: "upscale", style: "anything" }), // upscale takes no style
          item({ id: "vidstyle", tool: "video", style: "anything" }), // nor does video
          item({ id: "badstyle", tool: "edit", style: "../x" }),
          item({ id: "off", available: "yes" }), // only true is true
          item({ id: "noicon", icon: 7, description: "   " }),
        ],
        [{ id: "create", title: "Create" }, { id: "create", title: "Again" }, { id: "BAD", title: "x" }, { id: "edit", title: "" }],
      ),
    });
    expect(s.menu!.categories).toEqual([{ id: "create", title: "Create" }]);
    expect(s.menu!.items.map((i) => i.id)).toEqual(["text_to_image", "dup", "off", "noicon"]);
    expect(s.menu!.items[0]).toEqual({ id: "text_to_image", title: "Text to image", description: "Describe it.", icon: "image", category: "create", tool: "generate", style: null, available: true });
    expect(s.menu!.items[1]!.title).toBe("A");
    expect(s.menu!.items[2]!.available).toBe(false);
    expect(s.menu!.items[3]).toMatchObject({ icon: "", description: null });
    expect(state({ menu: "nope" }).menu).toBeNull();
    expect(state().menu).toBeNull();
  });

  it("builds the plain tools and one entry per style and mode when the server sends no menu", () => {
    const styles = [{ id: "a2r", title: "A2R", modes: ["edit"], params: [] }, { id: "mix", title: "Mix", modes: ["generate", "edit"], params: [] }];
    const m = usableMenu(state({ edit: editInfo, upscale, styles }));
    expect(m.categories).toEqual([{ id: "tools", title: "Tools" }]);
    expect(m.items.map((i) => [i.id, i.tool, i.style])).toEqual([
      ["generate", "generate", null], ["edit", "edit", null], ["upscale", "upscale", null],
      ["a2r", "edit", "a2r"], ["mix-generate", "generate", "mix"], ["mix-edit", "edit", "mix"],
    ]);
    // Edit and upscale off: only what generate can do is offered.
    expect(usableMenu(state({ styles })).items.map((i) => i.id)).toEqual(["generate", "mix-generate"]);
  });

  it("offers only available entries whose mode is on and whose style the state lists for that mode", () => {
    const styles = [{ id: "a2r", title: "A2R", modes: ["edit"], params: [] }];
    const items = [
      item({ id: "gen" }),
      item({ id: "free_edit", tool: "edit", category: "edit" }),
      item({ id: "a2r", tool: "edit", style: "a2r", category: "edit" }),
      item({ id: "a2r_gen", tool: "generate", style: "a2r" }), // a2r is edit-only here
      item({ id: "gone", tool: "edit", style: "gone", category: "edit" }),
      item({ id: "up", tool: "upscale", category: "edit" }),
      item({ id: "off", available: false }),
    ];
    const on = usableMenu(state({ edit: editInfo, upscale, styles, menu: menu(items) }));
    expect(on.items.map((i) => i.id)).toEqual(["gen", "free_edit", "a2r", "up"]);
    const editOff = usableMenu(state({ upscale: null, styles, menu: menu(items) }));
    expect(editOff.items.map((i) => i.id)).toEqual(["gen"]);
    expect(editOff.categories.map((c) => c.id)).toEqual(["create"]); // a category without entries is left out
  });

  it("chooses the wanted entry only when the menu has it, else the first", () => {
    const items = [entry({ id: "a" }), entry({ id: "b" })];
    expect(chooseEntry("b", items)!.id).toBe("b");
    expect(chooseEntry("zzz", items)!.id).toBe("a");
    expect(chooseEntry(null, items)!.id).toBe("a");
    expect(chooseEntry("__proto__", items)!.id).toBe("a");
    expect(chooseEntry("constructor", items)!.id).toBe("a");
    expect(chooseEntry("a", [])).toBeNull();
    expect(TOOL_STORAGE_KEY).toBe("vast-comfy.tool");
  });

  it("matches the search on title and description, ignoring case and surrounding blanks", () => {
    const e = entry({ title: "Face swap", description: "Put the FACE from one photo onto another." });
    expect(matchesQuery(e, "")).toBe(true);
    expect(matchesQuery(e, "   ")).toBe(true);
    expect(matchesQuery(e, "SWAP")).toBe(true);
    expect(matchesQuery(e, "  face ")).toBe(true);
    expect(matchesQuery(e, "onto")).toBe(true);
    expect(matchesQuery(e, "upscale")).toBe(false);
    expect(matchesQuery(entry({ description: null }), "photo")).toBe(false);
    expect(matchesQuery(entry({ title: "Face swap", description: null }), "FACE")).toBe(true);
    expect(matchesQuery(entry({ title: "x", description: "Old PHOTO" }), "photo")).toBe(true);
    expect(matchesQuery(entry({ title: "<b>x</b>" }), "<b>")).toBe(true); // plain text, never markup
  });

  it("groups the entries that match the search under their category, in menu order", () => {
    const m = {
      categories: [{ id: "create", title: "Create" }, { id: "edit", title: "Edit" }, { id: "enhance", title: "Enhance" }],
      items: [
        entry({ id: "t2i", title: "Text to image", category: "create" }),
        entry({ id: "free", title: "Free edit", category: "edit", tool: "edit" }),
        entry({ id: "swap", title: "Face swap", category: "edit", tool: "edit", style: "faceswap" }),
        entry({ id: "up", title: "Upscale", category: "enhance", tool: "upscale" }),
      ],
    };
    const ids = (q: string) => menuGroups(m, q).map((g) => [g.category.id, g.items.map((i) => i.id)]);
    expect(ids("")).toEqual([["create", ["t2i"]], ["edit", ["free", "swap"]], ["enhance", ["up"]]]);
    expect(ids("E")).toEqual([["create", ["t2i"]], ["edit", ["free", "swap"]], ["enhance", ["up"]]]);
    expect(ids("swap")).toEqual([["edit", ["swap"]]]);
    expect(ids("nothing")).toEqual([]);
  });

  it("lists the ways to continue from a result: every edit entry, then upscale", () => {
    const items = [
      entry({ id: "t2i" }),
      entry({ id: "free", tool: "edit" }),
      entry({ id: "swap", title: "Face swap", tool: "edit", style: "faceswap" }),
      entry({ id: "up", tool: "upscale" }),
    ];
    expect(chainTargets(items)).toEqual([
      { id: "free", title: "Use as reference" },
      { id: "swap", title: "Use as reference: Face swap" },
      { id: "up", title: "Upscale" },
    ]);
    expect(chainTargets([entry()])).toEqual([]);
  });
});

describe("the shipped profile's menu", () => {
  it("is drawn whole by the page: every category, entry and icon", () => {
    const profile = loadProfile(fileURLToPath(new URL("../../../../instance/profiles/image.yaml", import.meta.url)));
    const entries = menuItems(profile.menu, profile.styles);
    const s = parseState({ ...base, menu: { categories: profile.menu.categories, items: entries.map((e) => ({ ...e, available: true })) } })!;
    expect(s.menu!.items.map((i) => i.id)).toEqual(entries.map((e) => e.id));
    expect(s.menu!.categories.map((c) => c.id)).toEqual(profile.menu.categories.map((c) => c.id));
    for (const e of s.menu!.items) expect(Object.hasOwn(ICONS, e.icon)).toBe(true);
  });
});

describe("menu icons", () => {
  it("draws exactly the closed set the profile may name", () => {
    expect(Object.keys(ICONS).sort()).toEqual([...MENU_ICONS].sort());
    expect(Object.hasOwn(ICONS, DEFAULT_ICON)).toBe(true);
  });
});

describe("advanced server choice (Start dialog)", () => {
  const f = (over: Partial<typeof DEFAULT_START_FILTERS> = {}) => ({ ...DEFAULT_START_FILTERS, ...over });

  it("reads the error code only when it is a plain identifier", () => {
    expect(errorCode({ error: { code: "offer_gone" } })).toBe("offer_gone");
    for (const bad of [null, {}, { error: {} }, { error: { code: "Offer Gone" } }, { error: { code: "<b>" } }, { error: { code: 5 } }]) expect(errorCode(bad)).toBeNull();
  });

  it("the defaults mean no filter at all: nothing in the query or the body", () => {
    expect(startFiltersAreDefault(DEFAULT_START_FILTERS)).toBe(true);
    expect(filterQueryString(DEFAULT_START_FILTERS, null)).toBe("");
    expect(filterBodyMembers(DEFAULT_START_FILTERS, null)).toEqual({});
    expect(startFiltersAreDefault(f({ region: "europe" }))).toBe(false);
  });

  it("builds the query and the body from what was chosen, only the members that are set", () => {
    const chosen = f({ region: "europe", maxDph: "0.4", minDown: "300", sort: "speed" });
    expect(filterQueryString(chosen, null)).toBe("region=europe&max_dph=0.4&min_down_mbps=300&sort=speed");
    expect(filterQueryString(chosen, 42)).toBe("region=europe&max_dph=0.4&min_down_mbps=300&sort=speed&offer_id=42");
    expect(filterBodyMembers(chosen, 42)).toEqual({ region: "europe", max_dph: 0.4, min_down_mbps: 300, sort: "speed", offer_id: 42 });
    expect(filterBodyMembers(f({ sort: "price" }), null)).toEqual({}); // price is the default order
    expect(filterBodyMembers(f({ maxDph: " 0.5 " }), null)).toEqual({ max_dph: 0.5 });
  });

  it("checks the inputs before anything is sent", () => {
    expect(startFilterProblem(f())).toBeNull();
    expect(startFilterProblem(f({ maxDph: "0.4", minDown: "300" }))).toBeNull();
    for (const bad of [f({ maxDph: "abc" }), f({ maxDph: "0" }), f({ maxDph: "-1" }), f({ maxDph: "1e3" }), f({ minDown: "1.5" }), f({ minDown: "-3" }), f({ minDown: "x" }), f({ region: "mars" }), f({ sort: "random" })]) {
      expect(startFilterProblem(bad), JSON.stringify(bad)).toEqual(expect.any(String));
    }
  });

  it("reads the remembered choice only when every member is valid, else the defaults", () => {
    const ok = JSON.stringify({ region: "asia", maxDph: "0.3", minDown: "100", sort: "reliability" });
    expect(parseStoredFilters(ok)).toEqual({ region: "asia", maxDph: "0.3", minDown: "100", sort: "reliability" });
    for (const bad of [null, "", "{", "[]", "5", JSON.stringify({ region: "mars" }), JSON.stringify({ maxDph: 5 }), JSON.stringify({ sort: "<b>" }), JSON.stringify({ region: "asia", extra: 1 })]) {
      expect(parseStoredFilters(bad), String(bad)).toEqual(DEFAULT_START_FILTERS);
    }
    expect(START_FILTERS_STORAGE_KEY).toBe("vast-comfy.start-filters");
  });

  it("parses the offer list and drops entries it cannot trust", () => {
    const good = { id: 7, gpu_name: "RTX 3090", dph: 0.31, vram_gb: 24, location: "Quebec, CA", region: "north_america", down_mbps: 812, reliability: 0.99 };
    const list = parseOffers({ offers: [good, { ...good, id: 0 }, { ...good, id: "8" }, { ...good, dph: "x" }, null, { ...good, id: 9, location: 5, down_mbps: -4, reliability: 7 }] });
    expect(list!.map((o) => o.id)).toEqual([7, 9]);
    expect(list![1]).toMatchObject({ location: null, down_mbps: null, reliability: null });
    expect(parseOffers({})).toBeNull();
    expect(parseOffers("x")).toBeNull();
  });

  it("labels an offer with price, place, speed and reliability, leaving out what is unknown", () => {
    expect(offerLabel({ id: 7, gpu_name: "RTX 3090", dph: 0.31, vram_gb: 24, location: "Quebec, CA", region: "north_america", down_mbps: 812, reliability: 0.991 })).toBe(
      "RTX 3090 - $0.31/h - Quebec, CA - 812 Mbps down - reliability 99%",
    );
    expect(offerLabel({ id: 8, gpu_name: null, dph: 0.2, vram_gb: null, location: null, region: null, down_mbps: null, reliability: null })).toBe("$0.20/h");
  });
});

describe("server panel helpers", () => {
  it("tones the credit: used up, low (about two hours at the current price, at least $1), fine, or unknown", () => {
    expect(creditTone(null, 0.3)).toBe("neutral");
    expect(creditTone(0, 0.3)).toBe("bad");
    expect(creditTone(-0.2, 0.3)).toBe("bad");
    expect(creditTone(0.99, null)).toBe("warn"); // no price: under $1 is low
    expect(creditTone(1, null)).toBe("ok");
    expect(creditTone(1.1, 0.6)).toBe("warn"); // two hours at $0.60 = $1.20
    expect(creditTone(1.2, 0.6)).toBe("ok");
    expect(creditTone(0.9, 0.2)).toBe("warn"); // two hours is $0.40, but under $1 stays low
    expect(creditTone(4.54, 0.31)).toBe("ok");
    expect(creditTone(5, Number.NaN)).toBe("ok");
    expect(creditTone(Number.NaN, 0.3)).toBe("neutral");
    expect(creditToneText("warn")).toBe("low");
    expect(creditToneText("bad")).toBe("used up");
    expect(creditToneText("ok")).toBe("");
    expect(creditToneText("neutral")).toBe("");
  });

  it("names the layout by width: three columns from 1280, a drawer panel below, a drawer menu below 900", () => {
    expect(layoutMode(1280)).toBe("wide");
    expect(layoutMode(1920)).toBe("wide");
    expect(layoutMode(1279.5)).toBe("medium");
    expect(layoutMode(900)).toBe("medium");
    expect(layoutMode(899)).toBe("narrow");
    expect(layoutMode(375)).toBe("narrow");
    expect(layoutMode(Number.NaN)).toBe("narrow");
  });

  it("reads the remembered panel choice: only the exact word collapsed collapses it", () => {
    expect(PANEL_STORAGE_KEY).toBe("vast-comfy.panel");
    expect(parsePanelPref("collapsed")).toBe("collapsed");
    expect(parsePanelPref("open")).toBe("open");
    for (const other of [null, "", "Collapsed", " collapsed", "1", "true", "<b>collapsed</b>", "{}"]) expect(parsePanelPref(other), String(other)).toBe("open");
  });

  it("gives the header pill a short label and a tone", () => {
    expect(pillView(null, null, null)).toEqual({ label: "Loading", tone: "idle" });
    expect(pillView("none", null, null)).toEqual({ label: "Stopped", tone: "idle" });
    expect(pillView("creating", null, null)).toEqual({ label: "Booting", tone: "busy" });
    expect(pillView("booting", null, null)).toEqual({ label: "Booting", tone: "busy" });
    expect(pillView("downloading", 42, null)).toEqual({ label: "Booting 42%", tone: "busy" });
    expect(pillView("ready", null, 1500)).toEqual({ label: "Ready", tone: "ok" });
    expect(pillView("idle-warning", null, 161)).toEqual({ label: "Idle 3m", tone: "warn" });
    expect(pillView("idle-warning", null, 30)).toEqual({ label: "Idle 1m", tone: "warn" });
    expect(pillView("idle-warning", null, 0)).toEqual({ label: "Idle 0m", tone: "warn" });
    expect(pillView("idle-warning", null, null)).toEqual({ label: "Idle soon", tone: "warn" });
    expect(pillView("stopping", null, null)).toEqual({ label: "Stopping", tone: "warn" });
    expect(pillView("failed", null, null)).toEqual({ label: "Failed", tone: "bad" });
    expect(pillView("destroy_failed", null, null)).toEqual({ label: "Destroy failed", tone: "bad" });
    expect(pillView("weird", null, null)).toEqual({ label: "Unknown", tone: "warn" });
  });

  it("shows the floating widget only while the panel is off screen, an instance has an uptime and nothing covers the page", () => {
    const v = (over: Partial<Parameters<typeof widgetVisible>[0]> = {}) => widgetVisible({ mode: "medium", collapsed: false, overlayOpen: false, uptime: 60, ...over });
    expect(v()).toBe(true); // drawer closed below 1280
    expect(v({ mode: "narrow" })).toBe(true);
    expect(v({ mode: "wide" })).toBe(false); // the panel is on screen
    expect(v({ mode: "wide", collapsed: true })).toBe(true);
    expect(v({ mode: "medium", collapsed: true })).toBe(true);
    expect(v({ uptime: null })).toBe(false);
    expect(v({ uptime: 0 })).toBe(true);
    expect(v({ overlayOpen: true })).toBe(false);
    expect(v({ mode: "wide", collapsed: true, overlayOpen: true })).toBe(false);
  });

  it("warns in the Start dialog when the known credit is below the most it can cost", () => {
    expect(startCreditWarning(null, 1)).toBeNull();
    expect(startCreditWarning(5, 1.08)).toBeNull();
    expect(startCreditWarning(1.08, 1.08)).toBeNull();
    expect(startCreditWarning(1.07, 1.08)).toBe("Your Vast credit ($1.07) is less than this estimate ($1.08). The instance may stop when the credit runs out.");
    expect(startCreditWarning(-0.2, 1)).toContain("(-$0.20)");
    expect(startCreditWarning(Number.NaN, 1)).toBeNull();
  });
});

describe("the panel's actions per state (admin)", () => {
  it("offers Start without an instance, Extend while it runs (first choice near the idle shutdown), Destroy whenever one exists", () => {
    expect(panelActions(null)).toEqual({ start: false, extend: false, extendPrimary: false, destroy: false, destroyLabel: "Destroy instance…", hint: "" });
    expect(panelActions("none")).toMatchObject({ start: true, extend: false, destroy: false });
    for (const s of ["creating"]) expect(panelActions(s)).toMatchObject({ start: false, extend: false, destroy: true });
    for (const s of ["booting", "downloading", "ready"]) expect(panelActions(s)).toMatchObject({ start: false, extend: true, extendPrimary: false, destroy: true });
    expect(panelActions("idle-warning")).toMatchObject({ extend: true, extendPrimary: true, destroy: true });
    expect(panelActions("stopping")).toMatchObject({ start: false, extend: false, destroy: false });
    for (const s of ["failed", "destroy_failed"]) {
      expect(panelActions(s)).toMatchObject({ start: false, extend: false, destroy: true, destroyLabel: "Destroy instance (retry)" });
      expect(panelActions(s).hint).toBe("Destroy it in the danger zone below, then start again.");
    }
  });
});

describe("edit sizes from the state", () => {
  const edit = { max_references: 4, max_bytes: 8_388_608, max_pixels: 16_777_216, types: ["png"], resolutions: [{ name: "1024", value: 1024 }] };
  it("are an empty list when the server sends none or something unusable", () => {
    expect(parseState({ ...base, edit })!.edit!.sizes).toEqual([]);
    expect(parseState({ ...base, edit: { ...edit, sizes: "x" } })!.edit!.sizes).toEqual([]);
  });
  it("keep the valid entries and drop the rest", () => {
    const sizes = [{ name: "1:1", width: 1024, height: 1024 }, { name: "", width: 1, height: 1 }, { name: "x", width: 0, height: 5 }, { name: "y", width: 1.5, height: 5 }, null, { name: "9:16", width: 768, height: 1344 }];
    expect(parseState({ ...base, edit: { ...edit, sizes } })!.edit!.sizes).toEqual([
      { name: "1:1", width: 1024, height: 1024 },
      { name: "9:16", width: 768, height: 1344 },
    ]);
  });
});

describe("video", () => {
  const video = {
    sizes: [{ name: "Landscape", width: 1280, height: 704 }],
    durations: [{ name: "About 3 s", seconds: 3 }, { name: "Short", seconds: 2 }],
    max_bytes: 2 * 1024 * 1024,
    max_pixels: 1_000_000,
    types: ["png", "jpeg"],
    download_bytes: 18_000_000_000,
    models: { state: "ready" as const, bytes_done: 5, bytes_total: 5, percent: 100, reason: null },
    model: null as { file: string; linked: boolean; sha256: string | null } | null,
  };
  const state = (over: Record<string, unknown> = {}) => parseState({ ...base, ...over })!;
  const entry = (over: Partial<MenuEntry> = {}): MenuEntry => ({ id: "t", title: "T", description: null, icon: "image", category: "create", tool: "generate", style: null, available: true, ...over });

  it("reads the server's video offer, and treats anything malformed as no video", () => {
    expect(state({ video }).video).toEqual(video);
    expect(state().video).toBeNull();
    const bad: Record<string, unknown>[] = [
      { ...video, sizes: [] },
      { ...video, durations: [] },
      { ...video, sizes: [{ name: "x", width: 0, height: 10 }] },
      { ...video, durations: [{ name: "x", seconds: -1 }] },
      { ...video, durations: [{ name: "x", seconds: 1.5 }] },
      { ...video, durations: [{ name: "", seconds: 3 }] },
      { ...video, durations: [null] },
      { ...video, types: ["gif"] },
      { ...video, max_bytes: 0 },
    ];
    for (const v of bad) expect(state({ video: v }).video, JSON.stringify(v)).toBeNull();
  });

  it("can make a video only when the server offers it, the instance is ready and no job runs", () => {
    expect(controls(state({ video }), false, false).canVideo).toBe(true);
    expect(controls(state({ video }), false, true).canVideo).toBe(false);
    expect(controls(state({ video, state: "booting" }), false, false).canVideo).toBe(false);
    expect(controls(state(), false, false).canVideo).toBe(false);
    // Not while the instance lacks its video models (or does not say).
    for (const models of [null, { ...video.models, state: "downloading" }, { ...video.models, state: "not_installed" }, { ...video.models, state: "failed" }]) {
      expect(controls(state({ video: { ...video, models } }), false, false).canVideo).toBe(false);
    }
  });

  it("reads the video model state strictly; anything odd is 'not reported'", () => {
    expect(state({ video: { ...video, models: { state: "downloading", bytes_done: 3, bytes_total: 9, percent: 33, reason: null } } }).video!.models).toEqual({
      state: "downloading", bytes_done: 3, bytes_total: 9, percent: 33, reason: null,
    });
    expect(state({ video: { ...video, models: { state: "maybe" } } }).video!.models).toBeNull();
    expect(state({ video: { ...video, models: { state: "failed", bytes_done: -1, percent: 101, reason: "" } } }).video!.models).toEqual({
      state: "failed", bytes_done: 0, bytes_total: 0, percent: null, reason: null,
    });
    expect(state({ video: { ...video, download_bytes: -5 } }).video!.download_bytes).toBe(0);
  });

  it("words the video model state for admins (with the download button) and members (ask an admin)", () => {
    const at = (models: unknown) => ({ ...video, models } as typeof video);
    expect(videoModelsNote(video, true)).toEqual({ text: "", download: false });
    expect(videoModelsNote(at({ state: "not_installed", bytes_done: 0, bytes_total: 1, percent: 0, reason: null }), true)).toEqual({ text: "This instance was started without the video models.", download: true });
    expect(videoModelsNote(at({ state: "not_installed", bytes_done: 0, bytes_total: 1, percent: 0, reason: null }), false)).toEqual({
      text: "The video models are not installed on this instance. Ask an admin to download them.", download: false,
    });
    expect(videoModelsNote(at({ state: "downloading", bytes_done: 4_500_000_000, bytes_total: 18_000_000_000, percent: 25, reason: null }), false).text).toBe(
      "Downloading the video models: 4.5 GB of 18.0 GB (25%). Images keep working meanwhile; Make video unlocks when it is done.",
    );
    expect(videoModelsNote(at({ state: "failed", bytes_done: 0, bytes_total: 1, percent: 0, reason: "disk full" }), true)).toEqual({ text: "The video model download failed: disk full.", download: true });
    expect(videoModelsNote(at({ state: "failed", bytes_done: 0, bytes_total: 1, percent: 0, reason: null }), false).text).toBe("The video model download failed. Ask an admin to try again.");
    expect(videoModelsNote(at(null), true).download).toBe(false);
    expect(videoModelsNote(at({ state: "unavailable", bytes_done: 0, bytes_total: 0, percent: null, reason: null }), true)).toEqual({ text: "This instance has no video models.", download: false });
    // A linked model in use: admins are reminded it is not pinned; members are told nothing.
    const linked = { ...video, model: { file: "better.gguf", linked: true, sha256: "a".repeat(64) } };
    expect(videoModelsNote(linked, true).text).toContain("Video model in use: better.gguf, from a link. A linked model is NOT integrity-pinned or licence-checked");
    expect(videoModelsNote(linked, true).text).toContain(`sha256 ${"a".repeat(64)}`);
    expect(videoModelsNote(linked, false).text).toBe("");
    expect(state({ video: { ...video, model: { file: "x.gguf", linked: true, sha256: "nothex" } } }).video!.model).toEqual({ file: "x.gguf", linked: true, sha256: null });
    expect(state({ video: { ...video, model: { file: "" } } }).video!.model).toBeNull();
    expect(videoDownloadLabel(video)).toBe("Download video models (about 18.0 GB, several minutes)");
    expect(videoDownloadLabel({ ...video, download_bytes: 0 })).toBe("Download video models (several minutes)");
  });

  it("offers the video entry only while video is on, never with a style, and continues a result into it", () => {
    const items = [entry({ id: "gen" }), entry({ id: "video", tool: "video" }), entry({ id: "up", tool: "upscale" })];
    const menu = { categories: [{ id: "create", title: "Create" }], items };
    expect(usableMenu(state({ menu, video })).items.map((i) => i.id)).toEqual(["gen", "video"]);
    expect(usableMenu(state({ menu })).items.map((i) => i.id)).toEqual(["gen"]);
    expect(chainTargets([entry({ id: "video", tool: "video" }), entry({ id: "up", tool: "upscale" }), entry({ id: "e", tool: "edit" })])).toEqual([
      { id: "e", title: "Use as reference" }, { id: "up", title: "Upscale" }, { id: "video", title: "Make a video" },
    ]);
    // Without a server menu the page builds one with a Video entry.
    expect(usableMenu(state({ video })).items.map((i) => [i.id, i.tool, i.icon])).toEqual([["generate", "generate", "image"], ["video", "video", "film"]]);
    expect(knobsFor(state({ video }), "video")).toEqual({ negativePrompt: false, cfg: false });
  });

  it("builds the file path from the job id and index only", () => {
    expect(videoUrl("job-1", 0)).toBe("/api/video/job-1/0");
    for (const [id, index] of [["../x", 0], ["job-1", -1], ["job-1", 1.5], ["job-1", "0"], ["job 1", 0], ["job-1", 1000]] as const) {
      expect(videoUrl(id as string, index)).toBeNull();
    }
  });

  it("words the form: one optional start image, the length, the label and the long wait", () => {
    expect(videoAsEdit(video)).toEqual({ max_references: 1, max_bytes: video.max_bytes, max_pixels: 1_000_000, types: ["png", "jpeg"], resolutions: [], sizes: [] });
    expect(videoHint(video)).toBe("Optional: one start image (PNG, JPEG), 2.0 MB at most, brings that picture to life. Without one the video is made from the prompt alone. You can also paste an image (Ctrl/Cmd+V).");
    expect(durationLabel(video.durations[0]!)).toBe("About 3 s");
    expect(durationLabel(video.durations[1]!)).toBe("Short (about 2 s)");
    expect(videoLabel("Landscape", "About 3 s", false)).toBe("Video: Landscape, About 3 s");
    expect(videoLabel("Landscape", "About 3 s", true)).toBe("Video: Landscape, About 3 s, from an image");
    expect(VIDEO_WAIT_TEXT).toContain("several minutes");
    expect(durationText("video", 312)).toBe("Made in 5 min 12 s");
  });
});


describe("video families", () => {
  const video = {
    sizes: [{ name: "Landscape", width: 1280, height: 704 }],
    durations: [{ name: "About 3 s", seconds: 3 }],
    max_bytes: 2 * 1024 * 1024,
    max_pixels: 1_000_000,
    types: ["png", "jpeg"],
    download_bytes: 18_000_000_000,
    models: { state: "not_installed" as const, bytes_done: 0, bytes_total: 5, percent: null, reason: null },
    model: { file: "x.safetensors", linked: true, sha256: null },
  };
  const ready = { state: "ready" as const, bytes_done: 5, bytes_total: 5, percent: 100, reason: null };
  const baseFam = { id: "wan22_5b", title: "Fast (5B)", base: true, sizes: video.sizes, durations: video.durations, download_bytes: 18_000_000_000, models: video.models, slots: null, experts: null, extra_loras: [] };
  const big = {
    id: "wan22_a14b", title: "Quality (14B, 4 steps)", base: false,
    sizes: [{ name: "Landscape", width: 832, height: 480 }], durations: [{ name: "About 5 s", seconds: 5 }],
    download_bytes: 60_000_000_000, models: ready, slots: { text: ["high", "low"], image: ["high", "low"] },
    experts: [{ mode: "text" as const, slot: "high", file: "h.gguf", linked: true, sha256: "a".repeat(64) }, { mode: "text" as const, slot: "low", file: "l.gguf", linked: true, sha256: null }],
    extra_loras: [{ id: "calisthenic_moves", title: "Calisthenic moves", description: "Adds moves.", modes: ["text" as const], strength: 0.6, trigger_words: "" }],
  };
  const state = (over: Record<string, unknown> = {}) => parseState({ ...base, video, ...over })!;

  it("reads the families (base first) and treats anything malformed, or video off, as no families", () => {
    expect(state({ video_families: [baseFam, big] }).video_families).toEqual([baseFam, big]);
    expect(state().video_families).toBeNull();
    expect(state({ video: null, video_families: [baseFam, big] }).video_families).toBeNull();
    const bad: unknown[] = [
      [baseFam], // the base one alone is no choice
      [big, baseFam], // the base one comes first
      [baseFam, { ...big, id: "Bad Id" }],
      [baseFam, { ...big, title: "" }],
      [baseFam, { ...big, sizes: [] }],
      [baseFam, { ...big, durations: [{ name: "x", seconds: -1 }] }],
      [baseFam, { ...big, slots: { text: ["high"], image: ["high", "low"] } }],
      [baseFam, { ...big, slots: null }],
      [baseFam, { ...big, id: "wan22_5b" }],
      "x",
    ];
    for (const v of bad) expect(state({ video_families: v }).video_families, JSON.stringify(v).slice(0, 80)).toBeNull();
    // An odd expert entry is left out, not the family.
    expect(state({ video_families: [baseFam, { ...big, experts: [{ mode: "x", slot: "high", file: "h" }] }] }).video_families![1]!.experts).toEqual([]);
  });

  it("can make a video when any family is ready", () => {
    expect(controls(state(), false, false).canVideo).toBe(false);
    expect(controls(state({ video_families: [baseFam, big] }), false, false).canVideo).toBe(true);
  });

  it("the chosen family's sizes, durations, size and model state stand in for the base ones", () => {
    const s = state({ video_families: [baseFam, big] });
    expect(familyVideo(s.video!, s.video_families, "wan22_a14b")).toEqual({ ...s.video!, sizes: big.sizes, durations: big.durations, download_bytes: 60_000_000_000, models: ready, model: null });
    expect(familyVideo(s.video!, s.video_families, "wan22_5b")).toBe(s.video);
    expect(familyVideo(s.video!, s.video_families, null)).toBe(s.video);
    expect(familyVideo(s.video!, null, "wan22_a14b")).toBe(s.video);
  });

  it("labels a family's job with its title, like the server", () => {
    expect(videoLabel("Landscape", "About 5 s", true, "Quality (14B, 4 steps)")).toBe("Video: Landscape, About 5 s, Quality (14B, 4 steps), from an image");
    expect(videoLabel("Landscape", "About 5 s", false)).toBe("Video: Landscape, About 5 s");
  });

  it("builds a download body: the family alone, or every expert link of the mode (one-sided is refused)", () => {
    expect(familyDownloadBody(big, "text", {})).toEqual({ body: { family: "wan22_a14b" } });
    expect(familyDownloadBody(big, "text", { high: " ", low: "" })).toEqual({ body: { family: "wan22_a14b" } });
    expect(familyDownloadBody(big, "image", { high: " a ", low: "b" })).toEqual({ body: { family: "wan22_a14b", mode: "image", links: { high: "a", low: "b" } } });
    expect(familyDownloadBody(big, "text", { high: "a" })).toEqual({ error: "Give a link for every expert (high and low), or none." });
    expect(familyDownloadBody(big, "text", { high: "a", low: "x".repeat(3000) })).toEqual({ error: "A link is too long." });
  });

  it("tells an admin which experts are linked, with their sha256, and why links need care", () => {
    expect(expertsNote(big)).toBe(`Linked experts in use: text high: h.gguf (sha256 ${"a".repeat(64)}); text low: l.gguf. Not integrity-pinned.`);
    expect(expertsNote({ ...big, experts: null })).toBe("");
    expect(EXPERT_LINK_NOTICE).toMatch(/both .* together/);
    expect(EXPERT_LINK_NOTICE).toMatch(/UNVERIFIED/);
  });
});


describe("extra LoRAs of a video family", () => {
  const lora = { id: "calisthenic_moves", title: "Calisthenic moves", description: "Adds moves.", modes: ["text" as const], strength: 0.6, trigger_words: "" };
  it("sends the LoRA's id and a strength from 0 to 1 (its default when empty), only for a mode it is offered for", () => {
    expect(extraLoraMembers(null, "0.3", false)).toEqual({ members: {} });
    expect(extraLoraMembers(lora, "", false)).toEqual({ members: { extra_lora: "calisthenic_moves", extra_lora_strength: 0.6 } });
    expect(extraLoraMembers(lora, " 0.25 ", false)).toEqual({ members: { extra_lora: "calisthenic_moves", extra_lora_strength: 0.25 } });
    for (const bad of ["1.5", "-0.1", "x", "NaN"]) expect(extraLoraMembers(lora, bad, false), bad).toEqual({ error: "The LoRA strength must be a number from 0 to 1." });
    expect(extraLoraMembers(lora, "0.5", true)).toEqual({ error: "Calisthenic moves is not offered for image to video." });
  });

  it("describes the LoRA with its trigger words, or says none are known, and that it is untested", () => {
    expect(extraLoraNote(lora)).toBe("Adds moves. No trigger words are known for it yet. Untested with this 4-step model: results may vary.");
    expect(extraLoraNote({ ...lora, description: "", trigger_words: "push-up" })).toBe("Trigger words: push-up Untested with this 4-step model: results may vary.");
  });

  it("reads the entries strictly: an odd one is left out", () => {
    const fam = (extra: unknown) => ({ id: "big", title: "Big", base: false, sizes: [{ name: "L", width: 832, height: 480 }], durations: [{ name: "5 s", seconds: 5 }], download_bytes: 1, models: null, slots: { text: ["high", "low"], image: ["high", "low"] }, experts: null, extra_loras: extra });
    const baseFam = { id: "small", title: "Small", base: true, sizes: [{ name: "L", width: 832, height: 480 }], durations: [{ name: "5 s", seconds: 5 }], download_bytes: 1, models: null, slots: null, experts: null, extra_loras: [] };
    const video = { sizes: [{ name: "L", width: 832, height: 480 }], durations: [{ name: "5 s", seconds: 5 }], max_bytes: 10, max_pixels: 10, types: ["png"], download_bytes: 1, models: null, model: null };
    const read = (extra: unknown) => parseState({ ...base, video, video_families: [baseFam, fam(extra)] })!.video_families![1]!.extra_loras;
    expect(read([lora])).toEqual([lora]);
    expect(read([{ ...lora, strength: 2 }, { ...lora, modes: ["video"] }, { ...lora, id: "Bad" }, "x"])).toEqual([]);
    expect(read(undefined)).toEqual([]);
  });
});


describe("an experimental video duration", () => {
  const video = {
    sizes: [{ name: "Landscape", width: 1280, height: 704 }],
    durations: [{ name: "About 5 s", seconds: 5 }, { name: "About 12 s (experimental)", seconds: 12, experimental: true as const }],
    max_bytes: 1000, max_pixels: 1000, types: ["png"], download_bytes: 1, models: null, model: null,
  };
  it("is read from the state (only a literal true counts) and labelled experimental", () => {
    expect(parseState({ ...base, video })!.video!.durations).toEqual(video.durations);
    const odd = parseState({ ...base, video: { ...video, durations: [{ name: "Long", seconds: 12, experimental: "yes" }] } })!.video!.durations;
    expect(odd).toEqual([{ name: "Long", seconds: 12 }]);
    expect(durationLabel(video.durations[1]!)).toBe("About 12 s (experimental)");
    expect(durationLabel({ name: "Long", seconds: 12, experimental: true })).toBe("Long (about 12 s, experimental)");
    expect(durationLabel(video.durations[0]!)).toBe("About 5 s");
  });
  it("comes with the owner's warning", () => {
    expect(EXPERIMENTAL_DURATION_WARNING).toBe("Longer than the model was trained for (about 5 s): quality may drop and it may run out of memory or time out.");
  });
});
