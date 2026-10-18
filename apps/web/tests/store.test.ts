import { describe, expect, it } from "vitest";
import { JobStore, LiveProgress, RateLimiter } from "../src/store.js";

describe("RateLimiter", () => {
  it("allows `limit` hits per window per key and frees them as the window slides", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect(rl.take("a")).toBe(true);
    t = 500;
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false);
    expect(rl.take("b")).toBe(true);
    t = 1000;
    expect(rl.take("a")).toBe(true); // the hit at 0 left the window
    expect(rl.take("a")).toBe(false);
  });
});

describe("JobStore", () => {
  it("forgets jobs after the TTL and evicts the oldest at the cap", () => {
    let t = 0;
    const store = new JobStore(2, 100, () => t);
    store.add({ id: "a", owner: "u", hostname: "h" });
    t = 10;
    store.add({ id: "b", owner: "u", hostname: "h" });
    t = 50;
    store.add({ id: "c", owner: "u", hostname: "h" });
    expect(store.get("a")).toBeNull();
    expect(store.get("b")?.state).toEqual({ kind: "pending" });
    expect(store.size).toBe(2);
    t = 110;
    expect(store.get("b")).toBeNull();
    expect(store.get("c")?.owner).toBe("u");
    t = 150;
    expect(store.get("c")).toBeNull();
  });
});

describe("LiveProgress", () => {
  const live = (t = { now: 0 }) => {
    const closed: string[] = [];
    const l = new LiveProgress(() => t.now);
    l.socket = { setPromptId: () => undefined, close: () => void closed.push("closed") };
    return { l, closed, t };
  };
  const frame = (marker: string) => ({ bytes: Buffer.from(marker), contentType: "image/jpeg" as const });

  it("keeps only the newest step and preview, counting previews, and the first start time", () => {
    const { l, t } = live();
    l.progress(1, 25);
    l.preview(frame("a"));
    t.now = 7;
    l.started();
    t.now = 9;
    l.started();
    l.progress(2, 25);
    l.preview(frame("b"));
    expect(l.step).toEqual({ step: 2, max: 25 });
    expect(l.frame?.bytes.toString()).toBe("b");
    expect(l.previewSeq).toBe(2);
    expect(l.startedAt).toBe(7);
  });

  it("end closes the socket once, drops the preview and ignores anything later", () => {
    const { l, closed } = live();
    l.preview(frame("a"));
    l.end();
    l.end();
    l.preview(frame("b"));
    l.progress(3, 4);
    expect(closed).toEqual(["closed"]);
    expect(l.frame).toBeNull();
    expect(l.previewSeq).toBe(1);
    expect(l.step).toBeNull();
  });

  it("the job store closes the socket of a job it forgets (expiry, eviction, replacement) and on endAllLive", () => {
    let t = 0;
    const store = new JobStore(2, 100, () => t);
    const sockets = ["a", "b", "c", "d"].map((id) => {
      const x = live();
      store.add({ id, owner: "u", hostname: "h", live: x.l });
      return x;
    });
    // a and b were evicted at the cap when c and d came.
    expect(sockets.map((x) => x.closed.length)).toEqual([1, 1, 0, 0]);
    t = 100;
    expect(store.get("c")).toBeNull();
    expect(sockets[2]!.closed).toEqual(["closed"]);
    const e = live();
    t = 100;
    store.add({ id: "e", owner: "u", hostname: "h", live: e.l });
    store.endAllLive();
    expect(e.closed).toEqual(["closed"]);
    expect(store.get("e")?.live).toBe(e.l);
  });
});
