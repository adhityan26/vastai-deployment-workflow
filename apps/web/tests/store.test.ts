import { describe, expect, it } from "vitest";
import { JobStore, RateLimiter } from "../src/store.js";

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
