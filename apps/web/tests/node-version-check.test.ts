import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { check } = createRequire(import.meta.url)("../../../scripts/check-node-version.js") as { check: (v: string) => string | null };

describe("scripts/check-node-version.js (CVE-2026-111497)", () => {
  it.each(["v22.23.4", "22.23.5", "v22.24.0", "v24.22.1", "v24.23.0", "v24.99.0", "v26.12.1", "v26.13.0"])("accepts the fixed release %s", (v) => {
    expect(check(v)).toBeNull();
  });
  it.each(["v22.23.3", "v22.22.0", "v24.22.0", "v24.21.9", "v26.12.0", "v26.11.9"])("refuses the vulnerable release %s", (v) => {
    expect(check(v)).toMatch(/vulnerable to CVE-2026-111497/);
  });
  it.each(["v20.19.0", "v18.20.0", "v23.5.0", "v25.1.0", "v28.0.0"])("refuses a line without a fix (%s)", (v) => {
    expect(check(v)).toMatch(/without a fix/);
  });
  it("refuses an unreadable version", () => {
    expect(check("nonsense")).toMatch(/unreadable/);
  });
});
