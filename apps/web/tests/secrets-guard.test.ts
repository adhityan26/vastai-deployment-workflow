import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/check-secrets.sh", import.meta.url));

let repo = "";
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "guard-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** Stage one file with the given content and run the guard; returns exit status and stderr. */
function guard(path: string, content: string): { status: number | null; err: string } {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  execFileSync("git", ["add", "-f", path], { cwd: repo });
  const r = spawnSync("bash", [script], { cwd: repo, encoding: "utf8", env: { ...process.env, SKIP_GITLEAKS: "1" } });
  return { status: r.status, err: r.stderr };
}

const PLACEHOLDERS = [
  "# comment",
  "VAST_API_KEY=",
  "AUTHENTIK_CLIENT_SECRET=",
  "WEB_SESSION_SECRET=",
  "WEB_PUBLIC_URL=https://gen.3dprintingbandung.my.id",
  "TS_AUTHKEY_FILE=/run/secrets/ts-authkey",
  "# SOME_TOKEN=",
  "",
].join("\n");

describe("check-secrets.sh .env.example handling", () => {
  it("passes a placeholders-only root .env.example", () => {
    expect(guard(".env.example", PLACEHOLDERS).status).toBe(0);
  });
  it("passes a path value for a *_FILE key", () => {
    expect(guard(".env.example", "TS_AUTHKEY_FILE=/run/secrets/ts-authkey\n").status).toBe(0);
  });
  it("blocks a key with a value and reports line and key, never the value", () => {
    const value = ["abc", "123", "def", "456"].join("");
    const r = guard(".env.example", `PROFILE=image\nVAST_API_KEY=${value}\n`);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("2: VAST_API_KEY");
    expect(r.err).not.toContain(value);
  });
  it("blocks a secret-named key with any value", () => {
    expect(guard(".env.example", "AUTHENTIK_CLIENT_SECRET=x\n").status).not.toBe(0);
  });
  it("blocks secret-looking values under any key name", () => {
    for (const v of ["tskey-auth-abc", "ghp_abcdef", "a".repeat(32).replace(/a/g, "1"), "Ab1".repeat(14)])
      expect(guard(".env.example", `SOMETHING=${v}\n`).status, v).not.toBe(0);
  });
  it("checks the staged blob, not the working tree", () => {
    writeFileSync(join(repo, ".env.example"), "VAST_API_KEY=realvalue\n");
    execFileSync("git", ["add", ".env.example"], { cwd: repo });
    writeFileSync(join(repo, ".env.example"), "VAST_API_KEY=\n");
    const r = spawnSync("bash", [script], { cwd: repo, encoding: "utf8", env: { ...process.env, SKIP_GITLEAKS: "1" } });
    expect(r.status).not.toBe(0);
  });
  it("still blocks .env, nested .env.example and secrets/.env.example", () => {
    expect(guard(".env", "A=\n").status).not.toBe(0);
  });
  it.each(["secrets/.env.example", "apps/web/.env.example"])("blocks %s", (p) => {
    expect(guard(p, PLACEHOLDERS).status).not.toBe(0);
  });
});
