import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppsConfig } from "../src/config.js";
import { MemoryObjectStore, ObjectStoreError, S3ObjectStore, type ObjectStore } from "../src/object-store.js";

// ---- a tiny S3-compatible server: path-style, PUT/HEAD/GET/DELETE and ListObjectsV2 ----

interface Stored { bytes: Buffer; contentType: string; meta: Record<string, string> }
interface Seen { method: string; url: string; auth: string; sha: string }

const ACCESS = "AKIATESTACCESS";
const SECRET = "test-secret-key-must-never-travel";
const BUCKET = "vast-gallery";
let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections?.();
  server?.close();
  server = undefined;
});

async function fakeS3(opts: { failWith?: number; hangMs?: number; chunked?: { size: number; every: number; count: number }; stallAfterFirstChunk?: boolean } = {}) {
  const objects = new Map<string, Stored>();
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: String(req.headers.authorization ?? ""), sha: String(req.headers["x-amz-content-sha256"] ?? "") });
      const send = () => {
        if (opts.failWith) {
          res.writeHead(opts.failWith, { "Content-Type": "application/xml" });
          return res.end(`<Error><Code>InternalError</Code><Message>secret-detail ${SECRET}</Message></Error>`);
        }
        const [, bucket, ...rest] = url.pathname.split("/");
        const key = decodeURIComponent(rest.join("/"));
        if (bucket !== BUCKET) {
          res.writeHead(404, { "Content-Type": "application/xml" });
          return res.end("<Error><Code>NoSuchBucket</Code></Error>");
        }
        if (req.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const after = url.searchParams.get("start-after") ?? "";
          const max = Number(url.searchParams.get("max-keys") ?? "1000");
          const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
          const page = keys.slice(0, max);
          const body =
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><Prefix>${prefix}</Prefix>` +
            `<KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${keys.length > page.length}</IsTruncated>` +
            page.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.bytes.length}</Size></Contents>`).join("") +
            "</ListBucketResult>";
          res.writeHead(200, { "Content-Type": "application/xml" });
          return res.end(body);
        }
        if (req.method === "PUT") {
          const meta: Record<string, string> = {};
          for (const [h, v] of Object.entries(req.headers)) if (h.startsWith("x-amz-meta-")) meta[h.slice(11)] = String(v);
          objects.set(key, { bytes: Buffer.concat(chunks), contentType: String(req.headers["content-type"] ?? ""), meta });
          res.writeHead(200, { ETag: '"etag"' });
          return res.end();
        }
        const found = objects.get(key);
        if (req.method === "DELETE") {
          objects.delete(key);
          res.writeHead(204);
          return res.end();
        }
        if (!found) {
          res.writeHead(404, { "Content-Type": "application/xml" });
          return res.end("<Error><Code>NoSuchKey</Code></Error>");
        }
        const headers: Record<string, string | number> = { "Content-Type": found.contentType, "Content-Length": found.bytes.length };
        for (const [k, v] of Object.entries(found.meta)) headers[`x-amz-meta-${k}`] = v;
        if (req.method === "GET" && (opts.chunked || opts.stallAfterFirstChunk)) {
          // No Content-Length: the body arrives in pieces (or stalls after the first one).
          delete headers["Content-Length"];
          res.writeHead(200, headers);
          const c = opts.chunked ?? { size: 64, every: 10_000, count: 1 };
          let sent = 0;
          const tick = () => {
            if (res.destroyed) return;
            res.write(Buffer.alloc(c.size, 0x41));
            if (++sent < c.count) setTimeout(tick, c.every);
            else if (!opts.stallAfterFirstChunk) res.end();
          };
          return tick();
        }
        res.writeHead(200, headers);
        res.end(req.method === "HEAD" ? undefined : found.bytes);
      };
      if (opts.hangMs) setTimeout(send, opts.hangMs);
      else send();
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const cfg = {
    galleryS3Endpoint: `http://127.0.0.1:${port}`,
    galleryS3Bucket: BUCKET,
    galleryS3Region: "us-east-1",
    galleryS3AccessKey: ACCESS,
    galleryS3SecretKey: SECRET,
    webImageTimeoutS: 5,
    secretNames: [],
  } as unknown as AppsConfig;
  return { store: new S3ObjectStore(cfg), objects, seen, cfg };
}

// ---- one behaviour, two implementations ----

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 13, 10]);

const implementations: [string, () => Promise<ObjectStore>][] = [
  ["MemoryObjectStore", async () => new MemoryObjectStore()],
  ["S3ObjectStore (fake S3 server)", async () => (await fakeS3()).store],
];

describe.each(implementations)("%s", (_name, make) => {
  it("stores bytes with a content type and metadata and reads them back untouched", async () => {
    const store = await make();
    await store.put("u/a/1", PNG, "image/png", { prompt: "a%20fox", kind: "generate" });
    const head = await store.head("u/a/1");
    expect(head).toEqual({ size: PNG.length, contentType: "image/png", metadata: { prompt: "a%20fox", kind: "generate" } });
    const got = await store.get("u/a/1", 1000);
    expect(got?.contentType).toBe("image/png");
    expect(got?.bytes.equals(PNG)).toBe(true);
  });

  it("answers null for a missing object and treats delete as idempotent", async () => {
    const store = await make();
    expect(await store.head("u/a/none")).toBeNull();
    expect(await store.get("u/a/none", 1000)).toBeNull();
    await store.put("u/a/1", PNG, "image/png", {});
    await store.delete("u/a/1");
    await store.delete("u/a/1");
    expect(await store.head("u/a/1")).toBeNull();
  });

  it("refuses to read an object larger than the cap", async () => {
    const store = await make();
    await store.put("u/a/1", PNG, "image/png", {});
    await expect(store.get("u/a/1", PNG.length - 1)).rejects.toBeInstanceOf(ObjectStoreError);
    expect((await store.get("u/a/1", PNG.length))?.bytes.length).toBe(PNG.length);
  });

  it("lists a prefix in key order with sizes, pages with startAfter and reports truncation", async () => {
    const store = await make();
    for (const k of ["u/a/3", "u/a/1", "u/b/1", "u/a/2"]) await store.put(k, PNG, "image/png", {});
    const first = await store.list("u/a/", { maxKeys: 2 });
    expect(first.entries.map((e) => e.key)).toEqual(["u/a/1", "u/a/2"]);
    expect(first.entries[0]!.size).toBe(PNG.length);
    expect(first.truncated).toBe(true);
    const second = await store.list("u/a/", { maxKeys: 2, startAfter: "u/a/2" });
    expect(second.entries.map((e) => e.key)).toEqual(["u/a/3"]);
    expect(second.truncated).toBe(false);
    expect((await store.list("u/", { maxKeys: 10 })).entries).toHaveLength(4);
    expect((await store.list("x/", { maxKeys: 10 })).entries).toEqual([]);
  });

  it("keeps keys with unusual but legal characters intact", async () => {
    const store = await make();
    const key = "u/0a1b/9999999999999-job_1-A-2";
    await store.put(key, PNG, "image/png", {});
    expect((await store.list("u/0a1b/", { maxKeys: 5 })).entries.map((e) => e.key)).toEqual([key]);
    expect((await store.get(key, 1000))?.bytes.equals(PNG)).toBe(true);
  });
});

describe("S3ObjectStore", () => {
  it("signs requests with the access key, never sends the secret, and sends a payload hash", async () => {
    const { store, seen } = await fakeS3();
    await store.put("u/a/1", PNG, "image/png", { a: "b" });
    await store.head("u/a/1");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) {
      expect(s.auth).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(s.auth).toContain(`Credential=${ACCESS}/`);
      expect(s.auth).not.toContain(SECRET);
      expect(s.url).not.toContain(SECRET);
    }
    expect(seen.find((s) => s.method === "PUT")!.sha).toMatch(/^[0-9a-f]{64}$/); // a real hash, not a streaming trailer
  });

  it("uses path-style addressing on the configured endpoint", async () => {
    const { store, seen } = await fakeS3();
    await store.put("u/a/1", PNG, "image/png", {});
    expect(new URL(seen[0]!.url, "http://x").pathname).toBe(`/${BUCKET}/u/a/1`);
  });

  it("turns a server error into a plain ObjectStoreError that carries nothing from the server", async () => {
    const { store } = await fakeS3({ failWith: 500 });
    const err = await store.put("u/a/1", PNG, "image/png", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(String((err as Error).message)).not.toContain("secret-detail");
    expect(String((err as Error).message)).not.toContain("127.0.0.1");
    await expect(store.list("u/", { maxKeys: 1 })).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(store.head("u/a/1")).rejects.toBeInstanceOf(ObjectStoreError);
  }, 30_000);

  it("a missing bucket is an error, not 'no objects'", async () => {
    const { cfg } = await fakeS3();
    const wrong = new S3ObjectStore({ ...cfg, galleryS3Bucket: "other-bucket" } as unknown as AppsConfig);
    await expect(wrong.list("u/", { maxKeys: 1 })).rejects.toBeInstanceOf(ObjectStoreError);
  }, 30_000);

  it("gives up on a hung server within the timeout", async () => {
    const { cfg } = await fakeS3({ hangMs: 4000 });
    const quick = new S3ObjectStore({ ...cfg, webImageTimeoutS: 1 } as unknown as AppsConfig);
    const started = Date.now();
    await expect(quick.head("u/a/1")).rejects.toBeInstanceOf(ObjectStoreError);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);

  it("reads a body without Content-Length under a running cap: it stops early instead of buffering it all", async () => {
    const { store } = await fakeS3({ chunked: { size: 1024, every: 100, count: 20 } });
    await store.put("u/a/1", PNG, "image/png", {});
    const started = Date.now();
    await expect(store.get("u/a/1", 1536)).rejects.toBeInstanceOf(ObjectStoreError);
    expect(Date.now() - started).toBeLessThan(1000); // the whole body would take about 2 s
  }, 20_000);

  it("a chunked body within the cap is read completely", async () => {
    const { store } = await fakeS3({ chunked: { size: 100, every: 5, count: 5 } });
    await store.put("u/a/1", PNG, "image/png", {});
    expect((await store.get("u/a/1", 500))?.bytes.length).toBe(500);
  }, 20_000);

  it("the deadline also covers a body that stalls after the headers", async () => {
    const { cfg } = await fakeS3({ stallAfterFirstChunk: true });
    const quick = new S3ObjectStore({ ...cfg, webImageTimeoutS: 1 } as unknown as AppsConfig);
    await quick.put("u/a/1", PNG, "image/png", {});
    const started = Date.now();
    await expect(quick.get("u/a/1", 10_000)).rejects.toBeInstanceOf(ObjectStoreError);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 20_000);

  it("refuses to start without an endpoint, a bucket or credentials, naming the key and not a value", () => {
    const base = { galleryS3Endpoint: "http://127.0.0.1:9", galleryS3Bucket: "b", galleryS3Region: "r", galleryS3AccessKey: "a", galleryS3SecretKey: "s", webImageTimeoutS: 5 };
    expect(() => new S3ObjectStore(base as unknown as AppsConfig)).not.toThrow();
    for (const [key, env] of [
      ["galleryS3Endpoint", "GALLERY_S3_ENDPOINT"],
      ["galleryS3Bucket", "GALLERY_S3_BUCKET"],
      ["galleryS3Region", "GALLERY_S3_REGION"],
      ["galleryS3AccessKey", "GALLERY_S3_ACCESS_KEY"],
      ["galleryS3SecretKey", "GALLERY_S3_SECRET_KEY"],
    ] as const) {
      expect(() => new S3ObjectStore({ ...base, [key]: "" } as unknown as AppsConfig), key).toThrow(env);
    }
    expect(() => new S3ObjectStore({ ...base, galleryS3Endpoint: "ftp://x" } as unknown as AppsConfig)).toThrow(/GALLERY_S3_ENDPOINT/);
    expect(() => new S3ObjectStore({ ...base, galleryS3Endpoint: "http://u:p@host:9000" } as unknown as AppsConfig)).toThrow(/GALLERY_S3_ENDPOINT/);
  });
});
