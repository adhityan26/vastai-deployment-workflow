import { describe, expect, it } from "vitest";
import { serverInfo, serverLocation } from "../src/vast.js";

describe("serverInfo: where the rented server is, from a Vast offer or instance row", () => {
  it("reads location, speeds, reliability and machine id", () => {
    expect(
      serverInfo({ geolocation: "Quebec, CA", inet_down: 860.4, inet_up: 512, reliability2: 0.993, reliability: 0.5, machine_id: 45608 }),
    ).toEqual({ location: "Quebec, CA", down_mbps: 860, up_mbps: 512, reliability: 0.993, machine_id: 45608 });
  });

  it("falls back to reliability and degrades every bad field to null", () => {
    expect(serverInfo({ reliability: 0.98 }).reliability).toBe(0.98);
    expect(
      serverInfo({ geolocation: 7, inet_down: -1, inet_up: Number.NaN, reliability2: 1.5, machine_id: 1.5 }),
    ).toEqual({ location: null, down_mbps: null, up_mbps: null, reliability: null, machine_id: null });
    expect(serverInfo({ inet_down: "860" }).down_mbps).toBeNull();
    expect(serverInfo({ inet_down: 1e12 }).down_mbps).toBeNull();
  });

  it("sanitises the free-text location to a short plain string", () => {
    expect(serverLocation("  Quebec,\n  CA  ")).toBe("Quebec, CA");
    expect(serverLocation("<script>alert(1)</script> Paris, FR")).toBe("scriptalert(1)script Paris, FR");
    expect(serverLocation("São Paulo, BR")).toBe("São Paulo, BR");
    expect(serverLocation("x".repeat(200))).toHaveLength(64);
    expect(serverLocation("<>")).toBeNull();
    expect(serverLocation("")).toBeNull();
    expect(serverLocation(null)).toBeNull();
  });
});
