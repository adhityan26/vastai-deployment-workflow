import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppsConfig } from "../src/config.js";
import { VastClient, VastError } from "../src/vast.js";

// Fake Vast API (local http server) for the log-request flow; the log FILE URL is https, so it is
// answered by the injected fetch (no network): that is where the headers are checked.

const KEY = "k".repeat(40) + "SECRET";
const LOG_URL = "https://logs.example.test/instance_logs/77.log?X-Amz-Signature=sigsecret123"; // config-lint: ok (test fixture)

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

interface FileRequest {
  url: string;
  headers: Headers;
  init: RequestInit | undefined;
}

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections?.();
  server?.close();
  server = undefined;
});

type FileResponder = (n: number) => Response;

async function fake(
  api: (s: Seen, res: ServerResponse) => void,
  file: FileResponder,
  over: Record<string, unknown> = {},
): Promise<{ client: VastClient; seen: Seen[]; files: FileRequest[]; sleeps: number[] }> {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      seen.push(s);
      api(s, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const files: FileRequest[] = [];
  const sleeps: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : String(input);
    if (url.startsWith("https:")) {
      files.push({ url, headers: new Headers(init?.headers), init });
      return file(files.length);
    }
    return fetch(input, init);
  };
  const cfg = {
    vastApiKey: KEY,
    vastApiUrl: `http://127.0.0.1:${port}/api/v0`,
    httpTimeoutSApps: 5,
    bootLogMaxBytes: 1024,
    secretNames: [],
    ...over,
  } as unknown as AppsConfig;
  const client = new VastClient(cfg, { fetch: fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
  return { client, seen, files, sleeps };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const logsOk = (url = LOG_URL) => (_s: Seen, res: ServerResponse) => json(res, 200, { success: true, result_url: url });
const text = (body: string, status = 200) => new Response(body, { status });

describe("VastClient.listInstances status_msg", () => {
  it("carries status_msg, null when absent", async () => {
    const { client } = await fake(
      (_s, res) =>
        json(res, 200, {
          instances: [
            { id: 1, actual_status: "loading", status_msg: "2fcf58654f0c: Verifying Checksum\n2fcf58654f0c: Download complete" },
            { id: 2, actual_status: "running" },
          ],
        }),
      () => text(""),
    );
    const rows = await client.listInstances();
    expect(rows[0]?.status_msg).toBe("2fcf58654f0c: Verifying Checksum\n2fcf58654f0c: Download complete");
    expect(rows[1]?.status_msg).toBeNull();
  });
});

describe("VastClient.instanceLogs", () => {
  it("requests the tail, then downloads the https file without the API key", async () => {
    const { client, seen, files } = await fake(logsOk(), () => text("line one\nline two\n"));
    expect(await client.instanceLogs(77, 300)).toBe("line one\nline two\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "PUT", url: "/api/v0/instances/request_logs/77/", auth: `Bearer ${KEY}` });
    expect(seen[0]?.body).toEqual({ tail: "300" });
    expect(files).toHaveLength(1);
    expect(files[0]!.url).toBe(LOG_URL);
    expect(files[0]!.headers.get("authorization")).toBeNull();
    expect([...files[0]!.headers.values()].join(" ")).not.toContain(KEY);
    expect(files[0]!.init?.credentials).toBe("omit");
    expect(files[0]!.init?.redirect).toBe("error");
  });

  it("waits for a file that is not written yet", async () => {
    const { client, files, sleeps } = await fake(logsOk(), (n) => (n < 3 ? text("<Error>NoSuchKey</Error>", 404) : text("ready\n")));
    expect(await client.instanceLogs(77, 10)).toBe("ready\n");
    expect(files).toHaveLength(3);
    expect(sleeps).toEqual([300, 300]);
  });

  it("gives up with a fixed error when the file never appears", async () => {
    const { client } = await fake(logsOk(), () => text("", 404), { httpTimeoutSApps: 1 });
    // The injected sleep returns at once, so the loop runs until the real deadline.
    const err = (await client.instanceLogs(77, 10).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(VastError);
    expect(err.message).toMatch(/not ready in time/);
    expect(err.message).not.toContain("sigsecret");
  });

  it("refuses a log URL that is not https and never fetches it", async () => {
    let hit = 0;
    const plain = createServer((_req, res) => {
      hit++;
      res.end("x\n");
    });
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
    const plainUrl = `http://127.0.0.1:${(plain.address() as AddressInfo).port}/log`;
    try {
      const { client, files } = await fake(logsOk(plainUrl), () => text("x\n"));
      await expect(client.instanceLogs(77, 10)).rejects.toThrow(/not https/);
      expect(files).toHaveLength(0);
      expect(hit).toBe(0);
    } finally {
      plain.close();
    }
  });

  it("refuses a log URL with credentials, a missing or bad result_url", async () => {
    for (const url of ["https://u:p@logs.example.test/x", "not a url", "", null]) { // config-lint: ok (test fixture)
      const { client, files } = await fake((_s, res) => json(res, 200, { success: true, result_url: url }), () => text("x\n"));
      const err = (await client.instanceLogs(77, 10).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(VastError);
      expect(files).toHaveLength(0);
      server?.close();
    }
  });

  it("caps an oversized log, drops the partial last line and stops reading", async () => {
    let pulled = 0;
    const line = "0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789\n"; // 75 bytes
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++;
            controller.enqueue(new TextEncoder().encode(line.repeat(4)));
          },
        }),
        { status: 200 },
      );
    const { client } = await fake(logsOk(), endless, { bootLogMaxBytes: 1024 });
    const out = await client.instanceLogs(77, 10);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1024);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n").slice(0, -1).every((l) => `${l}\n` === line)).toBe(true);
    // The tail is kept, so reading goes on past the cap, but only up to a bounded amount.
    expect(pulled).toBeLessThan(40);
  });

  it("keeps the last bytes of an oversized log (the most recent lines), from a whole line", async () => {
    const body = Array.from({ length: 200 }, (_v, i) => `line ${String(i).padStart(5, "0")}\n`).join(""); // 11 bytes each
    const { client } = await fake(logsOk(), () => text(body), { bootLogMaxBytes: 1024 });
    const out = await client.instanceLogs(77, 200);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1024);
    expect(out.endsWith("line 00199\n")).toBe(true);
    expect(out.startsWith("line ")).toBe(true);
    expect(out.split("\n").slice(0, -1).every((l) => /^line \d{5}$/.test(l))).toBe(true);
    expect(out).not.toContain("line 00000");
  });

  it("turns Vast API failures into VastError without the key", async () => {
    const { client, files } = await fake((_s, res) => json(res, 500, { msg: `boom ${KEY}` }), () => text("x\n"));
    const err = (await client.instanceLogs(77, 10).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(VastError);
    expect(err.message).not.toContain(KEY);
    expect(files).toHaveLength(0);
  });

  it("reports a failed download with fixed text (never the signed URL)", async () => {
    const { client } = await fake(logsOk(), () => {
      throw new TypeError(`fetch failed for ${LOG_URL}`);
    });
    const err = (await client.instanceLogs(77, 10).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(VastError);
    expect(err.message).toBe("request logs: the log download failed");
  });

  it("validates its arguments", async () => {
    const { client, seen } = await fake(logsOk(), () => text("x\n"));
    await expect(client.instanceLogs(0, 10)).rejects.toThrow(VastError);
    await expect(client.instanceLogs(1, 0)).rejects.toThrow(VastError);
    expect(seen).toHaveLength(0);
  });
});
