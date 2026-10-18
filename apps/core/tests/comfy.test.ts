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

async function fake(handler: (s: Seen, res: ServerResponse) => void, timeoutS = 5, imageTimeoutS = timeoutS) {
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
  const cfg = { comfyPort: port, httpTimeoutSApps: timeoutS, webImageTimeoutS: imageTimeoutS, webJsonMaxBytes: 4096, webImageMaxBytes: 8192, secretNames: [] } as unknown as AppsConfig;
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

describe("ComfyClient image timeout", () => {
  // /view answers after `delayMs`; JSON calls get HTTP_TIMEOUT_S_APPS (1 s), /view WEB_IMAGE_TIMEOUT_S (3 s).
  const slow = (delayMs: number) => (s: Seen, res: ServerResponse) => {
    const timer = setTimeout(() => {
      if (res.destroyed) return;
      if (s.url.startsWith("/view")) {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } else json(res, 200, { queue_running: [], queue_pending: [] });
    }, delayMs);
    res.on("close", () => clearTimeout(timer));
  };

  it("a /view slower than the JSON timeout but within the image timeout succeeds", async () => {
    const { client } = await fake(slow(1800), 1, 3);
    const out = await client.view("a.png", "", "output");
    expect(out.contentType).toBe("image/png");
    expect(out.bytes.length).toBe(4);
    // The same delay on a JSON call still hits the 1 s JSON timeout.
    await expect(client.queue()).rejects.toBeInstanceOf(Unreachable);
  }, 10_000);

  it("a /view beyond the image timeout is Unreachable", async () => {
    const { client } = await fake(slow(6000), 1, 2);
    const t0 = Date.now();
    const err = await client.view("a.png", "", "output").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Unreachable);
    expect((err as Error).message).toContain("2000 ms");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 10_000);

  it("a missing or invalid WEB_IMAGE_TIMEOUT_S is refused at construction", () => {
    for (const bad of [undefined, 0, -1, 1.5, "60"]) {
      const cfg = { comfyPort: 1, httpTimeoutSApps: 1, webImageTimeoutS: bad, webJsonMaxBytes: 4096, webImageMaxBytes: 8192 } as unknown as AppsConfig;
      expect(() => new ComfyClient("127.0.0.1", cfg)).toThrow(/WEB_IMAGE_TIMEOUT_S/);
    }
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

describe("ComfyClient.uploadImage", () => {
  interface Upload { method: string; url: string; contentType: string; body: Buffer }
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 1, 2, 255, 254, 13, 10, 45, 45])]);

  async function fakeUpload(handler: (u: Upload, res: ServerResponse) => void, over: Record<string, unknown> = {}) {
    const seen: Upload[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const u = { method: req.method ?? "", url: req.url ?? "", contentType: String(req.headers["content-type"] ?? ""), body: Buffer.concat(chunks) };
        seen.push(u);
        handler(u, res);
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const cfg = { comfyPort: port, httpTimeoutSApps: 5, webImageTimeoutS: 5, webJsonMaxBytes: 4096, webImageMaxBytes: 8192, secretNames: [], ...over } as unknown as AppsConfig;
    return { client: new ComfyClient("127.0.0.1", cfg), seen };
  }

  const ok = (name: string) => (_u: Upload, res: ServerResponse) => json(res, 200, { name, subfolder: "", type: "input" });

  it("posts a multipart form with the file, type=input and overwrite=false, and returns the stored name", async () => {
    const { client, seen } = await fakeUpload(ok("edit-ab12.png"));
    expect(await client.uploadImage("edit-ab12.png", PNG, "image/png")).toEqual({ name: "edit-ab12.png" });
    expect(seen).toHaveLength(1);
    const u = seen[0]!;
    expect(u.method).toBe("POST");
    expect(u.url).toBe("/upload/image");
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(u.contentType)?.[1];
    expect(boundary).toBeTruthy();
    const text = u.body.toString("latin1");
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(text).toContain('Content-Disposition: form-data; name="image"; filename="edit-ab12.png"\r\nContent-Type: image/png\r\n\r\n');
    expect(text).toContain('name="type"\r\n\r\ninput\r\n');
    expect(text).toContain('name="overwrite"\r\n\r\nfalse\r\n');
    // The file bytes travel untouched, binary content and CRLF included.
    expect(u.body.includes(PNG)).toBe(true);
  });

  it("returns the name ComfyUI chose when it renamed the file", async () => {
    const { client } = await fakeUpload(ok("edit-ab12-1.png"));
    expect(await client.uploadImage("edit-ab12.png", PNG, "image/png")).toEqual({ name: "edit-ab12-1.png" });
  });

  it("refuses a file name that is not one plain name, a content type that is not an image type, and an empty file, with no request", async () => {
    const { client, seen } = await fakeUpload(ok("x.png"));
    for (const name of ["../x.png", "a/b.png", 'a"b.png', "a\r\nb.png", "", "a b.png", ".hidden"]) {
      await expect(client.uploadImage(name, PNG, "image/png")).rejects.toBeInstanceOf(ComfyError);
    }
    await expect(client.uploadImage("x.png", PNG, "text/html")).rejects.toBeInstanceOf(ComfyError);
    await expect(client.uploadImage("x.png", Buffer.alloc(0), "image/png")).rejects.toBeInstanceOf(ComfyError);
    expect(seen).toHaveLength(0);
  });

  const badReplies: Record<string, (res: ServerResponse) => void> = {
    http_error: (res) => json(res, 500, { error: "boom" }),
    not_json: (res) => res.end("nope"),
    no_name: (res) => json(res, 200, { subfolder: "", type: "input" }),
    name_not_plain: (res) => json(res, 200, { name: "../../etc/passwd", subfolder: "", type: "input" }),
    name_not_string: (res) => json(res, 200, { name: 7, subfolder: "", type: "input" }),
    in_subfolder: (res) => json(res, 200, { name: "x.png", subfolder: "sub", type: "input" }),
    wrong_type: (res) => json(res, 200, { name: "x.png", subfolder: "", type: "output" }),
  };
  it.each(Object.keys(badReplies))("treats a %s reply as a ComfyError", async (name) => {
    const { client } = await fakeUpload((_u, res) => badReplies[name]!(res));
    await expect(client.uploadImage("edit-ab12.png", PNG, "image/png")).rejects.toBeInstanceOf(ComfyError);
  });

  it("an unreachable instance is Unreachable, an oversized reply is ResponseTooLarge", async () => {
    const big = await fakeUpload((_u, res) => res.end("x".repeat(5000)));
    await expect(big.client.uploadImage("edit-ab12.png", PNG, "image/png")).rejects.toBeInstanceOf(ResponseTooLarge);
    server?.closeAllConnections?.();
    server?.close();
    const dead = new ComfyClient("127.0.0.1", { comfyPort: 1, httpTimeoutSApps: 1, webImageTimeoutS: 1, webJsonMaxBytes: 4096, webImageMaxBytes: 8192, secretNames: [] } as unknown as AppsConfig);
    await expect(dead.uploadImage("edit-ab12.png", PNG, "image/png")).rejects.toBeInstanceOf(Unreachable);
  });

  it("uses the longer image timeout, not the JSON timeout", async () => {
    const { client } = await fakeUpload(
      (_u, res) => setTimeout(() => json(res, 200, { name: "edit-ab12.png", subfolder: "", type: "input" }), 1300),
      { httpTimeoutSApps: 1, webImageTimeoutS: 5 },
    );
    expect(await client.uploadImage("edit-ab12.png", PNG, "image/png")).toEqual({ name: "edit-ab12.png" });
  });
});
