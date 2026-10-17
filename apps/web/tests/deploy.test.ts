import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p: string) => readFileSync(root(p), "utf8");

const schema = parse(read("contracts/config-schema.yaml")) as { keys: { name: string }[] };
const schemaKeys = new Set(schema.keys.map((k) => k.name));
// Names that are intentionally not config-schema keys.
const NOT_SCHEMA = new Set<string>([
  "NODE_ENV", // Node runtime mode, set by the Dockerfile
]);
const ENV_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$|^NODE_ENV$/;

function envNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([A-Z][A-Z0-9_*]*)`/g)) if (m[1] !== undefined) out.add(m[1]);
  return [...out];
}

describe("deploy files", () => {
  it("README mentions only config-schema keys as environment names", () => {
    const names = envNames(read("deploy/web/README.md")).filter((n) => ENV_NAME.test(n) || n.endsWith("_*"));
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) {
      if (NOT_SCHEMA.has(n)) continue;
      if (n.endsWith("_*")) {
        expect([...schemaKeys].some((k) => k.startsWith(n.slice(0, -1)))).toBe(true);
        continue;
      }
      expect(schemaKeys.has(n), `${n} is not in the schema`).toBe(true);
    }
  });

  const compose = parse(read("deploy/web/compose.snippet.yml")) as {
    services: Record<string, Record<string, unknown>>;
  };
  const svc = Object.values(compose.services)[0] ?? {};

  it("compose snippet uses only schema keys, has no ports and no literal secrets", () => {
    expect(Object.keys(compose.services)).toHaveLength(1);
    expect(svc).not.toHaveProperty("ports");
    expect(svc["env_file"]).toBe(".env");
    expect(svc["restart"]).toBe("unless-stopped");
    expect(svc["read_only"]).toBe(true);
    const env = (svc["environment"] ?? {}) as Record<string, string>;
    for (const k of Object.keys(env)) expect(schemaKeys.has(k) || NOT_SCHEMA.has(k), k).toBe(true);
    const text = read("deploy/web/compose.snippet.yml");
    expect(text).not.toMatch(/^\s*ports:/m);
    expect(text).not.toMatch(/(VAST_API_KEY|AUTHKEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*["']?[A-Za-z0-9]{8,}/);
    for (const k of ["VAST_API_KEY", "DISCORD_BOT_TOKEN", "TS_API_CREDENTIAL"]) expect(env).not.toHaveProperty(k);
  });

  it("Dockerfile runs as non-root after the last install and has a HEALTHCHECK", () => {
    const lines = read("apps/web/Dockerfile")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"));
    const lastInstall = Math.max(...lines.map((l, i) => (/\bnpm (ci|install)\b|apk add/.test(l) ? i : -1)));
    const userIdx = lines.map((l, i) => (/^USER\s+(?!root\b|0\b)\S+/.test(l) ? i : -1)).filter((i) => i >= 0);
    expect(userIdx.length).toBeGreaterThan(0);
    expect(Math.max(...userIdx)).toBeGreaterThan(lastInstall);
    expect(lines.some((l) => /^HEALTHCHECK\b/.test(l))).toBe(true);
    expect(lines.some((l) => /^CMD\b.*dist\/main\.js/.test(l))).toBe(true);
  });

  it("compose stop_grace_period covers the shutdown wait plus a destroy retry budget", () => {
    const keys = (parse(read("contracts/config-schema.yaml")) as { keys: { name: string; default: unknown }[] }).keys;
    const def = (n: string) => Number(keys.find((k) => k.name === n)?.default);
    const grace = /^(\d+)s$/.exec(String(svc["stop_grace_period"]));
    expect(grace).not.toBeNull();
    const budget =
      def("WEB_SHUTDOWN_WAIT_S") +
      (def("WEB_DESTROY_RETRIES") - 1) * def("WEB_DESTROY_BACKOFF_S") +
      def("WEB_DESTROY_RETRIES") * def("HTTP_TIMEOUT_S_APPS");
    expect(Number(grace![1])).toBeGreaterThan(budget);
  });
});
