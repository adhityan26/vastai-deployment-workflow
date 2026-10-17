import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppsConfig } from "../src/config.js";
import { ComfyClient, ComfyError, ResponseTooLarge, Unreachable } from "../src/comfy.js";

interface Seen { method: string; url: string; body: string }
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
      const s = { method: req.method ?? "", url: req.url ?? "", body: raw };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const cfg = { comfyPort: port, httpTimeoutSApps: timeoutS, webJsonMaxBytes: 4096, webImageMaxBytes: 8192, secretNames: [] } as unknown as AppsConfig;
  return { client: new ComfyClient("127.0.0.1", cfg), seen };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("ComfyClient", () => {
  it("submit returns the prompt id", async () => {
    const { client, seen } = await fake((_s, res) => json(res, 200, { prompt_id: "abc" }));
    expect(await client.submit({ "1": {} })).toEqual({ promptId: "abc" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ prompt: { "1": {} } });
  });

  it("history is null until finished", async () => {
    let done = false;
    const { client } = await fake((_s, res) => json(res, 200, done ? { p1: { outputs: {}, status: { completed: true } } } : {}));
    expect(await client.history("p1")).toBeNull();
    done = true;
    expect((await client.history("p1"))?.status?.completed).toBe(true);
  });

  it("view returns bytes with content type and encodes parameters", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    const { client, seen } = await fake((_s, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    });
    const out = await client.view("a b&c.png", "sub dir/x", "output");
    expect(out.contentType).toBe("image/png");
    expect(out.bytes.equals(png)).toBe(true);
    const q = new URL(seen[0]!.url, "http://x").searchParams;
    expect(q.get("filename")).toBe("a b&c.png");
    expect(q.get("subfolder")).toBe("sub dir/x");
    expect(seen[0]!.url).not.toContain(" ");
  });

  it("rejects path traversal and absolute paths before any request", async () => {
    const { client, seen } = await fake((_s, res) => json(res, 200, {}));
    for (const [f, s] of [["../x.png", ""], ["a.png", "../.."], ["a.png", "ok/../.."], ["/etc/passwd", ""], ["a.png", "/abs"], ["..\\x", ""]] as const) {
      await expect(client.view(f, s, "output")).rejects.toBeInstanceOf(ComfyError);
    }
    expect(seen).toHaveLength(0);
  });

  it("view rejects NUL, an empty filename and a bad type with zero requests", async () => {
    const { client, seen } = await fake((_s, res) => json(res, 200, {}));
    await expect(client.view("a\0.png", "", "output")).rejects.toBeInstanceOf(ComfyError);
    await expect(client.view("", "", "output")).rejects.toBeInstanceOf(ComfyError);
    await expect(client.view("a.png", "", "models" as unknown as "output")).rejects.toBeInstanceOf(ComfyError);
    expect(seen).toHaveLength(0);
  });

  it("history rejects a malformed promptId without a request", async () => {
    const { client, seen } = await fake((_s, res) => json(res, 200, {}));
    await expect(client.history("../queue")).rejects.toBeInstanceOf(ComfyError);
    await expect(client.history("")).rejects.toBeInstanceOf(ComfyError);
    expect(seen).toHaveLength(0);
  });

  it("a 5xx is a ComfyError, not Unreachable", async () => {
    const { client } = await fake((_s, res) => json(res, 500, { error: "boom" }));
    const err = (await client.queue().catch((e: unknown) => e)) as ComfyError;
    expect(err).toBeInstanceOf(ComfyError);
    expect(err).not.toBeInstanceOf(Unreachable);
  });

  it("queue returns running and pending", async () => {
    const { client } = await fake((_s, res) => json(res, 200, { queue_running: [1], queue_pending: [] }));
    expect(await client.queue()).toEqual({ running: [1], pending: [] });
  });

  it("HTTP error -> ComfyError with status", async () => {
    const { client } = await fake((_s, res) => json(res, 400, { error: "bad prompt" }));
    const err = (await client.submit({}).catch((e: unknown) => e)) as ComfyError;
    expect(err).toBeInstanceOf(ComfyError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("bad prompt");
  });

  it("unreachable host -> Unreachable", async () => {
    const { client } = await fake((_s, res) => json(res, 200, {}));
    server!.close();
    await new Promise((r) => setTimeout(r, 20));
    await expect(client.queue()).rejects.toBeInstanceOf(Unreachable);
  });

  it("hung server -> Unreachable within the timeout", async () => {
    const { client } = await fake(() => undefined, 1);
    const t0 = Date.now();
    await expect(client.queue()).rejects.toBeInstanceOf(Unreachable);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});

describe("ComfyClient response caps", () => {
  it("view rejects an honest oversized content-length before reading the body", async () => {
    let written = 0;
    const { client } = await fake((_s, res) => {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(10 * 1024 * 1024) });
      const chunk = Buffer.alloc(64 * 1024);
      const pump = () => {
        while (written < 10 * 1024 * 1024 && !res.destroyed && res.write(chunk)) written += chunk.length;
        if (written < 10 * 1024 * 1024 && !res.destroyed) res.once("drain", pump);
      };
      pump();
    });
    await expect(client.view("a.png", "", "output")).rejects.toBeInstanceOf(ResponseTooLarge);
    expect(written).toBeLessThan(10 * 1024 * 1024);
  });

  it("view stops reading an endless chunked body as soon as it passes the cap", async () => {
    let closed = false;
    let written = 0;
    const { client } = await fake((_s, res) => {
      res.writeHead(200, { "Content-Type": "image/png" }); // no content-length: chunked
      res.on("close", () => (closed = true));
      const chunk = Buffer.alloc(4096, 1);
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        res.write(chunk);
        written += chunk.length;
      }, 1);
    });
    const started = Date.now();
    const err = await client.view("a.png", "", "output").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLarge);
    expect(err).not.toBeInstanceOf(Unreachable);
    expect(Date.now() - started).toBeLessThan(3000); // well before the 5 s timeout
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
    const at = written;
    await new Promise((r) => setTimeout(r, 50));
    expect(written).toBe(at); // the server is no longer writing
  });

  it("history rejects a JSON body over the JSON cap", async () => {
    const { client } = await fake((_s, res) => json(res, 200, { p1: { outputs: {}, junk: "x".repeat(5000) } }));
    await expect(client.history("p1")).rejects.toBeInstanceOf(ResponseTooLarge);
  });
});
