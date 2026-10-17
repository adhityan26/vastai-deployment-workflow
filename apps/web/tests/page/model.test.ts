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
