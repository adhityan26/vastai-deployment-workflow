import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.js";

const schema = fileURLToPath(new URL("../../../contracts/config-schema.yaml", import.meta.url));
const base = { VAST_API_KEY: "k-secret-123", REPO_URL: "git-url", REPO_COMMIT: "abc", PROFILE: "image" };

function customSchema(lines: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "cfg-")), "schema.yaml");
  writeFileSync(path, `version: 1\nkeys:\n${lines}\n`);
  return path;
}

describe("loadConfig", () => {
  it("loads defaults", () => {
    const cfg = loadConfig(base, schema);
    expect(cfg["webAdminGroup"]).toBe("authentik Admins");
    expect(cfg["webMemberGroup"]).toBe("member");
    expect(cfg["vastDiskGb"]).toBe(50);
    expect(cfg["vastMinVramGb"]).toBe(24);
    expect(cfg["vastMaxDph"]).toBe("0.50");
    expect(cfg["vastAllowedGpus"]).toEqual([]);
    expect(cfg["startFailsafeHours"]).toBe(3);
    expect(cfg["webRepoDir"]).toBe(".");
    expect(cfg.secretNames).toContain("VAST_API_KEY");
  });

  it("reports every invalid key at once", () => {
    let error: unknown;
    try {
      loadConfig({ REPO_URL: "u", REPO_COMMIT: "c", PROFILE: "p", VAST_DISK_GB: "0", START_FAILSAFE_HOURS: "99", WEB_PORT: "abc" }, schema);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const text = (error as ConfigError).problems.join("\n");
    expect(text).toContain("VAST_API_KEY");
    expect(text).toContain("VAST_DISK_GB");
    expect(text).toContain("START_FAILSAFE_HOURS");
    expect(text).toContain("WEB_PORT");
  });

  it("rejects a bad bool", () => {
    const path = customSchema(
      '  - {name: FLAG, components: [apps], type: bool, secret: false, required: false, default: false, description: "x"}',
    );
    expect(() => loadConfig({ FLAG: "yes" }, path)).toThrow(/FLAG: expected true or false/);
    expect(loadConfig({ FLAG: "true" }, path)["flag"]).toBe(true);
  });

  it("parses csv", () => {
    expect(loadConfig({ ...base, VAST_ALLOWED_GPUS: "a, b" }, schema)["vastAllowedGpus"]).toEqual(["a", "b"]);
    expect(loadConfig({ ...base, VAST_ALLOWED_GPUS: "" }, schema)["vastAllowedGpus"]).toEqual([]);
  });

  it("never includes secret values in error messages", () => {
    const path = customSchema(
      '  - {name: TOKEN, components: [apps], type: int, secret: true, required: false, default: null, min: 100, description: "x"}',
    );
    let message = "";
    try {
      loadConfig({ TOKEN: "hunter2-secret" }, path);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("TOKEN");
    expect(message).not.toContain("hunter2");
    try {
      loadConfig({ TOKEN: "5" }, path);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("5 ");
  });

  it("ignores keys of other components", () => {
    const cfg = loadConfig(base, schema);
    expect(cfg["agentHost"]).toBeUndefined();
  });
});
