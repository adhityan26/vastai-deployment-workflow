import { describe, expect, it } from "vitest";
import {
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
    expect(parseState({ ...base, edit })!.edit).toEqual(edit);
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
  };
  const file = (name: string, type = "image/png", size = 1000) => ({ name, type, size });

  it("builds the accept list and the hint from the limits", () => {
    expect(acceptTypes(info)).toBe("image/png,image/jpeg");
    expect(referenceHint(info)).toBe("Up to 3 images (PNG, JPEG), 2.0 MB each. Refer to them as <image1>, <image2> in the prompt.");
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
  });

  it("bootSentence follows the running phase and is null otherwise", () => {
    expect(bootSentence(parseConsole(payload())!)).toBe("Installing tools and joining Tailscale, usually 2-4 minutes");
    const run = (id: string) => parseConsole(payload({ phases: [{ id, name: "N", status: "running" }] }))!;
    for (const id of ["image_pull", "install_tools", "failsafe", "agent", "nodes", "models", "comfyui"]) {
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
    expect(page!.items[0]).toEqual({ id: ID, url: `/api/gallery/${ID}/image`, createdAt: 1_800_000_000, kind: "generate", prompt: "a fox", label: "preview, 1:1", ownerName: "Ayu", mine: true, size: 12345 });
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

  it("is an empty list when the server sends none or something unusable", () => {
    expect(parseState(base)!.styles).toEqual([]);
    expect(parseState({ ...base, styles: "x" })!.styles).toEqual([]);
    expect(parseState({ ...base, styles: [style] })!.styles).toEqual([style]);
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
    expect(upscaleHint(up)).toBe("One image (PNG, JPEG), 8.0 MB at most. The result size is limited by the server.");
    expect(upscaleLabel("2x")).toBe("Upscale: 2x");
  });
});
