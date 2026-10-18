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
  "DOCKER_HOST", // Docker client variable used in README commands
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

  const composeText = read("docker-compose.yml");
  const compose = parse(composeText) as {
    services: Record<string, Record<string, unknown>>;
    volumes: Record<string, unknown>;
  };
  const svc = Object.values(compose.services)[0] ?? {};

  it("compose parses as YAML with one service, one published port and the hardening", () => {
    expect(Object.keys(compose.services)).toEqual(["vast-comfy-web"]);
    expect(svc["ports"]).toEqual(["3400:3000"]);
    expect(svc["env_file"]).toBe(".env");
    expect(svc["restart"]).toBe("unless-stopped");
    expect(svc["read_only"]).toBe(true);
    expect(svc["cap_drop"]).toEqual(["ALL"]);
    expect(svc["security_opt"]).toContain("no-new-privileges:true");
    expect(svc["healthcheck"]).toBeDefined();
    expect(svc["networks"]).toBeUndefined();
    expect(compose).not.toHaveProperty("networks");
    expect(svc["pids_limit"]).toBe(128);
    const limits = (svc["deploy"] as { resources: { limits: Record<string, unknown> } }).resources.limits;
    expect(limits["memory"]).toBe("256M");
    expect(limits["cpus"]).toBe("0.50");
    expect(compose.volumes["vast-comfy-keys"]).toEqual({ external: true, name: "vast-comfy-keys" });
    const volumes = svc["volumes"] as string[];
    expect(volumes).toContain("vast-comfy-keys:/run/secrets:ro");
    // The daemon is remote: no host path may be bind-mounted.
    for (const v of volumes) expect(v.startsWith("/") || v.startsWith("."), v).toBe(false);
    expect(Object.keys(compose.volumes)).toEqual(expect.arrayContaining(["vast-comfy-registry", "vast-comfy-keys"]));
  });

  it("env names in .env.example, compose and README all exist in the schema", () => {
    const check = (names: string[], where: string) => {
      for (const n of names) {
        if (NOT_SCHEMA.has(n)) continue;
        expect(schemaKeys.has(n), `${n} (${where}) is not in the schema`).toBe(true);
      }
    };
    const example = read(".env.example")
      .split("\n")
      .map((l) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
      .filter((n): n is string => n !== undefined);
    expect(example).toEqual(expect.arrayContaining(["VAST_API_KEY", "AUTHENTIK_ISSUER", "WEB_SESSION_SECRET", "TS_AUTHKEY_FILE"]));
    check(example, ".env.example");
    const env = (svc["environment"] ?? {}) as Record<string, string>;
    check(Object.keys(env), "compose environment");
    for (const k of ["VAST_API_KEY", "DISCORD_BOT_TOKEN", "TS_API_CREDENTIAL", "AUTHENTIK_CLIENT_SECRET", "WEB_SESSION_SECRET"])
      expect(env).not.toHaveProperty(k);
  });

  it("the boot console file sits on the data volume next to the registry", () => {
    const env = (svc["environment"] ?? {}) as Record<string, string>;
    expect(env["REGISTRY_PATH"]).toBe("/data/registry.json");
    expect(env["BOOT_LOG_PATH"]).toBe("/data/boot-console.json");
    expect(svc["volumes"] as string[]).toContain("vast-comfy-registry:/data");
    const example = read(".env.example");
    for (const n of ["BOOT_LOG_MAX_LINES", "BOOT_LOG_MAX_LINE_CHARS", "BOOT_LOG_POLL_MIN_S", "BOOT_LOG_WATCH_S", "BOOT_LOG_MAX_BYTES", "BOOT_LOG_TAIL_LINES"]) {
      expect(example).toMatch(new RegExp(`^# ${n}=`, "m"));
      expect(schemaKeys.has(n)).toBe(true);
    }
  });

  it("the usage history file sits on the data volume too and its tunables are documented", () => {
    const env = (svc["environment"] ?? {}) as Record<string, string>;
    expect(env["USAGE_LOG_PATH"]).toBe("/data/usage-history.json");
    const example = read(".env.example");
    for (const n of ["USAGE_LOG_MAX_ENTRIES", "USAGE_REASON_SLACK_S"]) {
      expect(example).toMatch(new RegExp(`^# ${n}=`, "m"));
      expect(schemaKeys.has(n)).toBe(true);
    }
    expect(schemaKeys.has("USAGE_LOG_PATH")).toBe(true);
  });

  it("the Tailscale OAuth keys exist in the schema and in .env.example (secrets empty, tunables commented)", () => {
    const keys = schema.keys as { name: string; secret?: boolean; components?: string[] }[];
    const byName = new Map(keys.map((k) => [k.name, k]));
    for (const n of ["TS_OAUTH_CLIENT_ID", "TS_OAUTH_CLIENT_SECRET", "TS_OAUTH_TAG", "TS_KEY_TTL_S", "TS_API_URL"]) {
      expect(byName.get(n)?.components, n).toContain("apps");
    }
    expect(byName.get("TS_OAUTH_CLIENT_SECRET")?.secret).toBe(true);
    expect(byName.get("TS_OAUTH_CLIENT_ID")?.secret).toBe(true);
    const example = read(".env.example");
    expect(example).toMatch(/^TS_OAUTH_CLIENT_ID=$/m);
    expect(example).toMatch(/^TS_OAUTH_CLIENT_SECRET=$/m);
    for (const n of ["TS_OAUTH_TAG", "TS_KEY_TTL_S", "TS_API_URL"]) expect(example).toMatch(new RegExp(`^# ${n}=`, "m"));
    const env = (svc["environment"] ?? {}) as Record<string, string>;
    for (const n of ["TS_OAUTH_CLIENT_ID", "TS_OAUTH_CLIENT_SECRET"]) expect(env).not.toHaveProperty(n);
    const readme = read("deploy/web/README.md");
    expect(readme).toContain("## Tailscale OAuth client");
    expect(readme).toContain("`TS_OAUTH_CLIENT_ID`");
    expect(readme).toContain("`TS_OAUTH_CLIENT_SECRET`");
  });

  it("compose and .env.example carry no literal secrets", () => {
    const secretLike = /\b[0-9a-f]{32,}\b|\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/;
    for (const text of [composeText, read(".env.example")]) {
      expect(text).not.toMatch(/tskey-|ghp_/);
      expect(text).not.toMatch(secretLike);
    }
    const example = read(".env.example");
    for (const name of ["VAST_API_KEY", "AUTHENTIK_CLIENT_ID", "AUTHENTIK_CLIENT_SECRET", "WEB_SESSION_SECRET"])
      expect(example).toMatch(new RegExp(`^${name}=$`, "m"));
    expect(example).toMatch(/^WEB_PUBLIC_URL=https:\/\/gen\.3dprintingbandung\.my\.id$/m);
    expect(example).toMatch(/^TS_AUTHKEY_FILE=\/run\/secrets\/ts-authkey$/m);
    expect(example).toMatch(/^WEB_OIDC_SKEW_S=5$/m);
  });

  it("README documents the redirect URI and the issuer trailing slash", () => {
    const readme = read("deploy/web/README.md");
    expect(readme).toContain("https://gen.3dprintingbandung.my.id/auth/callback");
    expect(readme).toMatch(/trailing slash/);
    expect(readme).toContain("192.168.88.113:3400");
    expect(readme).not.toContain("compose.snippet");
  });

  it("README points every docker command at the remote daemon and keeps the dangerous ones prefixed", () => {
    const readme = read("deploy/web/README.md");
    const deploying = readme.indexOf("## Deploying");
    const exportAt = readme.indexOf("export DOCKER_HOST=tcp://192.168.88.113:2375");
    expect(exportAt).toBeGreaterThan(deploying);
    expect(readme).toContain("unset DOCKER_HOST");
    // No docker command appears before the export.
    expect(readme.slice(0, exportAt)).not.toMatch(/`docker |^\s+docker /m);
    expect(readme).toContain("DOCKER_HOST=tcp://192.168.88.113:2375 docker compose stop vast-comfy-web");
    expect(readme).toContain("DOCKER_HOST=tcp://192.168.88.113:2375 docker run --rm -i -v vast-comfy-keys:/k");
    expect(readme).not.toMatch(/(?<!2375 )docker compose stop/);
    expect(readme).toContain("curl -s -o /dev/null -w '%{http_code}\\n' https://gen.3dprintingbandung.my.id/api/state");
    expect(readme).not.toContain("curl -sI");
    expect(readme).toMatch(/Include claims in id_token/);
    expect(readme).toMatch(/discovery_failed/);
    expect(readme).toContain("http://192.168.88.113:3400");
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
