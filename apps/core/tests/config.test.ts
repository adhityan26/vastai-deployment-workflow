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
    // Ampere or newer only; empty no longer means "any GPU".
    expect(cfg["vastAllowedGpus"]).toEqual(["RTX A5000", "RTX 3090", "RTX 4090"]);
    expect(cfg["startFailsafeHours"]).toBe(3);
    expect(cfg["webRepoDir"]).toBe(".");
    expect(cfg.secretNames).toContain("VAST_API_KEY");
  });

  it("stuck start keys default to 5 and 60 minutes and refuse 0", () => {
    const cfg = loadConfig(base, schema);
    expect(cfg["vastStartStuckMin"]).toBe(5);
    expect(cfg["vastBadMachineTtlMin"]).toBe(60);
    expect(() => loadConfig({ ...base, VAST_START_STUCK_MIN: "0" }, schema)).toThrow(/VAST_START_STUCK_MIN: below the minimum 1/);
    expect(() => loadConfig({ ...base, VAST_BAD_MACHINE_TTL_MIN: "0" }, schema)).toThrow(/VAST_BAD_MACHINE_TTL_MIN: below the minimum 1/);
    expect(() => loadConfig({ ...base, VAST_START_STUCK_MIN: "25", BOOT_TIMEOUT_MIN: "25" }, schema)).toThrow(
      /VAST_START_STUCK_MIN: must be less than BOOT_TIMEOUT_MIN/,
    );
    expect(loadConfig({ ...base, VAST_START_STUCK_MIN: "24", BOOT_TIMEOUT_MIN: "25" }, schema)["vastStartStuckMin"]).toBe(24);
  });

  it("slow boot keys default to 10 min, 120 s and 20 min; the agent grace stays below the boot timeout", () => {
    const cfg = loadConfig(base, schema);
    expect(cfg["bootAgentGraceMin"]).toBe(10);
    expect(cfg["modelEtaMinObserveS"]).toBe(120);
    expect(cfg["bootMaxDownloadEtaMin"]).toBe(20);
    expect(() => loadConfig({ ...base, BOOT_AGENT_GRACE_MIN: "1" }, schema)).toThrow(/BOOT_AGENT_GRACE_MIN: below the minimum 2/);
    expect(() => loadConfig({ ...base, BOOT_MAX_DOWNLOAD_ETA_MIN: "0" }, schema)).toThrow(/BOOT_MAX_DOWNLOAD_ETA_MIN: below the minimum 1/);
    expect(() => loadConfig({ ...base, MODEL_ETA_MIN_OBSERVE_S: "0" }, schema)).toThrow(/MODEL_ETA_MIN_OBSERVE_S: below the minimum 1/);
    expect(() => loadConfig({ ...base, BOOT_AGENT_GRACE_MIN: "25", BOOT_TIMEOUT_MIN: "25" }, schema)).toThrow(
      /BOOT_AGENT_GRACE_MIN: must be less than BOOT_TIMEOUT_MIN/,
    );
    expect(loadConfig({ ...base, BOOT_AGENT_GRACE_MIN: "24", BOOT_TIMEOUT_MIN: "25" }, schema)["bootAgentGraceMin"]).toBe(24);
  });

  it("the preview method defaults to latent2rgb and only takes its listed choices", () => {
    expect(loadConfig(base, schema)["comfyPreviewMethod"]).toBe("latent2rgb");
    for (const ok of ["none", "latent2rgb", "taesd", "auto"]) expect(loadConfig({ ...base, COMFY_PREVIEW_METHOD: ok }, schema)["comfyPreviewMethod"]).toBe(ok);
    expect(() => loadConfig({ ...base, COMFY_PREVIEW_METHOD: "fast" }, schema)).toThrow(/COMFY_PREVIEW_METHOD: must be one of none, latent2rgb, taesd, auto/);
    expect(loadConfig(base, schema)["webProgressEnabled"]).toBe(true);
    expect(loadConfig(base, schema)["webPreviewMaxBytes"]).toBe(524288);
    expect(loadConfig(base, schema)["webProgressMessageMaxBytes"]).toBe(65536);
  });

  it("refuses choices on a non-str key, empty or repeated choices and a default outside them", () => {
    const line = (rest: string) => `  - {name: X_KEY, components: [apps], secret: false, required: false, description: d, ${rest}}`;
    expect(() => loadConfig({}, customSchema(line("type: int, default: 1, choices: [a]")))).toThrow(/choices must be a non-empty list of strings on a str key/);
    expect(() => loadConfig({}, customSchema(line("type: str, default: a, choices: []")))).toThrow(/non-empty list/);
    expect(() => loadConfig({}, customSchema(line("type: str, default: a, choices: [a, a]")))).toThrow(/distinct/);
    expect(() => loadConfig({}, customSchema(line("type: str, default: z, choices: [a]")))).toThrow(/default is not one of the choices/);
    expect(loadConfig({ X_KEY: "b" }, customSchema(line("type: str, default: a, choices: [a, b]")))["xKey"]).toBe("b");
  });

  it("rejects a failsafe longer than the hard cap", () => {
    expect(() => loadConfig({ ...base, START_FAILSAFE_HOURS: "7", START_HARD_CAP_HOURS: "6" }, schema)).toThrow(
      /START_FAILSAFE_HOURS: must not be greater than START_HARD_CAP_HOURS/,
    );
    expect(() => loadConfig({ ...base, START_FAILSAFE_HOURS: "7", START_HARD_CAP_HOURS: "6" }, schema)).toThrow(ConfigError);
    const equal = loadConfig({ ...base, START_FAILSAFE_HOURS: "6", START_HARD_CAP_HOURS: "6" }, schema);
    expect(equal["startFailsafeHours"]).toBe(6);
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
    // An empty value falls back to the default list, never to "any".
    expect(loadConfig({ ...base, VAST_ALLOWED_GPUS: "" }, schema)["vastAllowedGpus"]).toEqual(["RTX A5000", "RTX 3090", "RTX 4090"]);
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
