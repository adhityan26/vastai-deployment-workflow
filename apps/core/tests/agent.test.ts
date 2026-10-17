import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { AppsConfig } from "../src/config.js";
import { AgentClient, AgentError, ResponseTooLarge, Unreachable } from "../src/agent.js";

const SCHEMA = fileURLToPath(new URL("../../../contracts/status.schema.json", import.meta.url));
const TOKEN = "tok-" + "z".repeat(30) + "SECRET";

const STATUS = {
  schema_version: 1, state: "ready", reason: null, progress: null, now: 100, boot_at: 1, uptime_s: 99,
  idle_destroy_at: 200, failsafe_at: 300, hard_cap_at: 400, queue: { running: 0, pending: 0 },
  gpu: {}, profile: "p", commit: "abc", failsafe_alive: true, destroy: { pending: false, attempts: 0 },
};

interface Seen { method: string; url: string; auth: string | undefined; body: string }
let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections?.();
  server?.close();
  server = undefined;
});

async function fake(handler: (s: Seen, res: ServerResponse) => void, timeoutS = 5) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: raw };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const cfg = { agentPort: port, httpTimeoutSApps: timeoutS, webJsonMaxBytes: 4096, secretNames: [] } as unknown as AppsConfig;
  return { client: new AgentClient("127.0.0.1", cfg, TOKEN, SCHEMA), seen, cfg };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("AgentClient", () => {
  it("sends the bearer token and returns a validated status", async () => {
    const { client, seen } = await fake((_s, res) => json(res, 200, STATUS));
    const st = await client.status();
    expect(st.state).toBe("ready");
    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("status rejects schema_version 2", async () => {
    const { client } = await fake((_s, res) => json(res, 200, { ...STATUS, schema_version: 2 }));
    await expect(client.status()).rejects.toThrow(/schema_version 2/);
  });

  it("status rejects a body that violates the schema", async () => {
    const { schema_version, ...rest } = STATUS;
    const { client } = await fake((_s, res) => json(res, 200, { ...rest, schema_version, state: "bogus" }));
    await expect(client.status()).rejects.toBeInstanceOf(AgentError);
  });

  it("unreachable host -> Unreachable", async () => {
    const { client } = await fake((_s, res) => json(res, 200, STATUS));
    server!.close();
    await new Promise((r) => setTimeout(r, 20));
    await expect(client.status()).rejects.toBeInstanceOf(Unreachable);
  });

  it("hung server -> Unreachable within the timeout", async () => {
    const { client } = await fake(() => undefined, 1);
    const t0 = Date.now();
    await expect(client.status()).rejects.toBeInstanceOf(Unreachable);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("extend over the hard cap surfaces the agent's message", async () => {
    const { client, seen } = await fake((_s, res) =>
      json(res, 400, { detail: { code: "over_hard_cap", message: "extension would pass the hard cap" } }),
    );
    const err = await client.extend("failsafe", 600).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).status).toBe(400);
    expect((err as AgentError).message).toContain("extension would pass the hard cap");
    expect(JSON.parse(seen[0]!.body)).toEqual({ kind: "failsafe", minutes: 600 });
  });

  it("HTTP errors are AgentError, not Unreachable, and never leak the token", async () => {
    const { client } = await fake((_s, res) => json(res, 401, { detail: `bad ${TOKEN}` }));
    const err = (await client.destroy("manual").catch((e: unknown) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(TOKEN);
  });

  it("Unreachable messages omit the token", async () => {
    const { client } = await fake((_s, res) => json(res, 200, STATUS));
    server!.close();
    await new Promise((r) => setTimeout(r, 20));
    const err = (await client.status().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Unreachable);
    expect(err.message).not.toContain(TOKEN);
  });

  it("a 5xx is an AgentError, not Unreachable", async () => {
    const { client } = await fake((_s, res) => json(res, 503, { detail: "busy" }));
    const err = (await client.status().catch((e: unknown) => e)) as AgentError;
    expect(err).toBeInstanceOf(AgentError);
    expect(err).not.toBeInstanceOf(Unreachable);
    expect(err.status).toBe(503);
  });

  it("never follows a redirect with the bearer token", async () => {
    const { client, seen } = await fake((s, res) => {
      res.writeHead(302, { Location: "/elsewhere" });
      res.end();
      void s;
    });
    await expect(client.status()).rejects.toThrow();
    expect(seen.map((s) => s.url)).toEqual(["/status"]);
  });

  it("destroy rejects a reason outside the enum without a request", async () => {
    const { client, seen } = await fake((_s, res) => json(res, 202, {}));
    await expect(client.destroy("because" as unknown as "manual")).rejects.toThrow(/manual or watchdog/);
    expect(seen).toHaveLength(0);
  });

  it("destroy posts the reason", async () => {
    const { client, seen } = await fake((_s, res) => json(res, 202, {}));
    await client.destroy("manual");
    expect(seen[0]?.url).toBe("/destroy");
    expect(JSON.parse(seen[0]!.body)).toEqual({ reason: "manual" });
  });
});

describe("AgentClient response cap", () => {
  it("status rejects a body over WEB_JSON_MAX_BYTES with ResponseTooLarge", async () => {
    const { client } = await fake((_s, res) => json(res, 200, { ...STATUS, reason: "x".repeat(5000) }));
    await expect(client.status()).rejects.toBeInstanceOf(ResponseTooLarge);
  });
});
