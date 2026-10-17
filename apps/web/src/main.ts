import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentClient,
  ComfyClient,
  Lifecycle,
  Registry,
  VastClient,
  camelCase,
  loadConfigFromProcess,
  loadProfile,
  type AppsConfig,
  type InstanceRecord,
} from "@vast-comfy/core";
import { createAuthStack } from "./auth.js";
import { buildServer } from "./server.js";

// Process entry: wire config, registry, Vast, lifecycle, auth and the reconcile loop, then
// listen. All behaviour worth testing lives in buildServer() and apps/core.

const CONTRACTS = new URL("../../../contracts/", import.meta.url);
const contract = (name: string) => fileURLToPath(new URL(name, CONTRACTS));
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOKEN_BYTES = 32;
const HOSTNAME_ID_BYTES = 4;
const HOSTNAME_PREFIX = "vast-";

type Level = "info" | "warn" | "error";
function log(level: Level, message: string): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message });
  if (level === "info") console.log(line);
  else console.error(line);
}

function str(cfg: AppsConfig, key: string): string {
  const v = cfg[key];
  return typeof v === "string" ? v : "";
}

function int(cfg: AppsConfig, key: string): number {
  const v = cfg[key];
  if (typeof v !== "number") throw new Error(`config ${key} is not a number`);
  return v;
}

async function main(): Promise<void> {
  const cfg = loadConfigFromProcess(contract("config-schema.yaml"));

  const profileName = str(cfg, "profile");
  if (!PROFILE_NAME.test(profileName)) throw new Error("PROFILE is not a valid profile name");
  const repoDir = str(cfg, "webRepoDir");
  const profile = loadProfile(join(repoDir, "instance", "profiles", `${profileName}.yaml`));
  const template: unknown = JSON.parse(
    readFileSync(join(repoDir, "instance", "workflows", profile.generate.workflow), "utf8"),
  );

  const allowedGpus = cfg["vastAllowedGpus"];
  if (!Array.isArray(allowedGpus) || allowedGpus.length === 0) {
    // Fail closed: an empty allow-list no longer means "any GPU".
    log("warn", "VAST_ALLOWED_GPUS is empty: Start, the estimate and the GPU list are refused (no_gpu_configured)");
  }

  const registry = new Registry(str(cfg, "registryPath"), contract("instance-registry.schema.json"));
  const vast = new VastClient(cfg);
  const statusSchema = contract("status.schema.json");

  // Every secret value handled here, so buildServer can make sure none leaves in a response.
  const seenSecrets = new Set<string>();
  for (const name of cfg.secretNames) {
    const value = cfg[camelCase(name)];
    if (typeof value === "string" && value !== "") seenSecrets.add(value);
  }

  // One AgentClient per record (the client compiles the status schema once).
  const agents = new Map<string, { token: string; client: AgentClient }>();
  const agentFor = (record: InstanceRecord): AgentClient => {
    const cached = agents.get(record.tailnet_hostname);
    if (cached && cached.token === record.agent_token) return cached.client;
    const client = new AgentClient(record.tailnet_hostname, cfg, record.agent_token, statusSchema);
    agents.set(record.tailnet_hostname, { token: record.agent_token, client });
    return client;
  };

  const tsAuthKey = async (): Promise<string> => {
    const file = str(cfg, "tsAuthkeyFile");
    if (file === "") throw new Error("TS_AUTHKEY_FILE is not configured");
    const key = (await readFile(file, "utf8")).trim();
    if (key !== "") seenSecrets.add(key);
    return key;
  };

  const lifecycle = new Lifecycle({
    cfg,
    vast,
    registry,
    agentFor,
    clock: () => Date.now() / 1000,
    tsAuthKey,
    profileModels: profile.models,
    newToken: () => randomBytes(TOKEN_BYTES).toString("hex"),
    newHostname: () => `${HOSTNAME_PREFIX}${randomBytes(HOSTNAME_ID_BYTES).toString("hex")}`,
  });

  // Login: OIDC client + signed session cookies. Fail-closed and loud when anything is missing:
  // createAuthStack logs which keys (never their values) and every /api request is then 401.
  const { auth, oidc, sessions } = createAuthStack(cfg, { onMisconfigured: (message) => log("error", message) });

  const app = buildServer({
    cfg,
    auth,
    lifecycle,
    registry,
    comfyFor: (hostname) => new ComfyClient(hostname, cfg),
    profile,
    template,
    login: { configured: auth.configured, oidc, sessions },
    publicDir: PUBLIC_DIR,
    secrets: () => [...seenSecrets],
    log,
  });

  // Reconcile loop: never overlaps, never stops on an error, logs no secrets or messages.
  const intervalMs = int(cfg, "reconcileIntervalS") * 1000;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const reconcile = (): Promise<void> => {
    inFlight = reconcileOnce();
    return inFlight;
  };
  const reconcileOnce = async (): Promise<void> => {
    try {
      const r = await lifecycle.reconcile();
      if (r.vast_error !== null) log("warn", "reconcile: Vast list unavailable; nothing changed");
      const changes = r.linked.length + r.gone.length + r.destroyed.length + r.destroy_failed.length;
      if (changes > 0 || r.unknown.length > 0) {
        log(
          r.destroy_failed.length > 0 ? "error" : "info",
          `reconcile: linked=${r.linked.length} gone=${r.gone.length} destroyed=${r.destroyed.length} ` +
            `destroy_failed=${r.destroy_failed.length} unknown=${r.unknown.length}`,
        );
      }
    } catch (err) {
      log("error", `reconcile failed: ${err instanceof Error ? err.name : "error"}`);
    } finally {
      if (!stopped) timer = setTimeout(() => void reconcile(), intervalMs);
    }
  };

  const shutdownWaitMs = int(cfg, "webShutdownWaitS") * 1000;
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    let code = 0;
    try {
      await app.close();
    } catch (err) {
      code = 1;
      log("error", `server close failed: ${err instanceof Error ? err.name : "error"}`);
    }
    // Let an in-flight reconcile finish (it may be mid-destroy), but never wait forever.
    let waitTimer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([
      inFlight.then(() => true, () => true),
      new Promise<boolean>((r) => (waitTimer = setTimeout(() => r(false), shutdownWaitMs))),
    ]);
    clearTimeout(waitTimer);
    if (!waited) log("warn", "shutdown: reconcile still running after WEB_SHUTDOWN_WAIT_S; exiting anyway");
    process.exit(code);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await app.listen({ port: int(cfg, "webPort"), host: str(cfg, "webHost") });
  log("info", `listening on port ${int(cfg, "webPort")}`);
  void reconcile();
}

main().catch((err: unknown) => {
  // These errors name keys or paths, never values; any other error is reduced to its name.
  const safe = new Set(["ConfigError", "ProfileError", "VastError"]);
  const text = err instanceof Error ? (safe.has(err.name) ? err.message : err.name) : "error";
  log("error", `startup failed: ${text}`);
  process.exit(1);
});
