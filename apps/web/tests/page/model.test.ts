import { describe, expect, it } from "vitest";
import {
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
  errorReason,
  estimatePath,
  etaSeconds,
  formatEta,
  formatSpeed,
  gpuOptionLabel,
  nextSamples,
  parseGpus,
  windowSpeed,
  parseSeed,
  parseState,
  pollIntervalMs,
  progressPercent,
  stateInfo,
} from "../../public/model.js";

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
    { name: "RTX A5000", dph: 0.25, vram_gb: 24, available: true },
    { name: "RTX 3090", dph: null, vram_gb: null, available: false },
    { name: "RTX 4090", dph: 0.45, vram_gb: 24, available: true },
  ];
  it("parses the list and treats a missing price as unavailable", () => {
    expect(parseGpus({ gpus: list })).toEqual(list);
    expect(parseGpus({ gpus: [{ name: "X", dph: null, vram_gb: 1, available: true }, { name: "", dph: 1 }, 5] })).toEqual([{ name: "X", dph: null, vram_gb: 1, available: false }]);
    expect(parseGpus({})).toBeNull();
    expect(parseGpus(null)).toBeNull();
  });
  it("labels options", () => {
    expect(gpuOptionLabel(list[0]!)).toBe("RTX A5000 - $0.25/h");
    expect(gpuOptionLabel(list[1]!)).toBe("RTX 3090 - no offers now");
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
