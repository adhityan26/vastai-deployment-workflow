import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { AppsConfig } from "./config.js";

// Object storage behind the gallery. The gallery logic talks to the small ObjectStore interface;
// S3ObjectStore implements it for MinIO (or any S3-compatible server), MemoryObjectStore is the
// same behaviour in memory for tests. Errors are ObjectStoreError with a fixed message: server
// error bodies, hosts, bucket names and keys never travel in an error.

export class ObjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

export interface ObjectHead {
  size: number;
  contentType: string;
  /** User metadata, lower-case keys, values exactly as stored. */
  metadata: Record<string, string>;
}

export interface ObjectEntry {
  key: string;
  size: number;
}

export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string, metadata: Record<string, string>): Promise<void>;
  /** Null when the object does not exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** Null when the object does not exist; an object larger than `maxBytes` is an error. */
  get(key: string, maxBytes: number): Promise<{ bytes: Buffer; contentType: string } | null>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** Keys under `prefix` in key order, after `startAfter` when given; at most `maxKeys`. */
  list(prefix: string, opts: { maxKeys: number; startAfter?: string }): Promise<{ entries: ObjectEntry[]; truncated: boolean }>;
  /**
   * The "folders" directly under `prefix` (each `prefix` + segment + "/"), in key order, for keys after
   * `startAfter`; at most `maxKeys` folders (S3 ListObjectsV2 with Delimiter "/").
   */
  listPrefixes(prefix: string, opts: { maxKeys: number; startAfter?: string }): Promise<{ prefixes: string[]; truncated: boolean }>;
}

/** In-memory ObjectStore with the same behaviour as the S3 one; for tests. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, { bytes: Buffer; contentType: string; metadata: Record<string, string> }>();

  async put(key: string, bytes: Buffer, contentType: string, metadata: Record<string, string>): Promise<void> {
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType, metadata: { ...metadata } });
  }

  async head(key: string): Promise<ObjectHead | null> {
    const o = this.objects.get(key);
    return o ? { size: o.bytes.length, contentType: o.contentType, metadata: { ...o.metadata } } : null;
  }

  async get(key: string, maxBytes: number): Promise<{ bytes: Buffer; contentType: string } | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    if (o.bytes.length > maxBytes) throw new ObjectStoreError("object is larger than allowed");
    return { bytes: Buffer.from(o.bytes), contentType: o.contentType };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string, opts: { maxKeys: number; startAfter?: string }) {
    const after = opts.startAfter ?? "";
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
    const page = keys.slice(0, opts.maxKeys);
    return { entries: page.map((key) => ({ key, size: this.objects.get(key)!.bytes.length })), truncated: keys.length > page.length };
  }

  async listPrefixes(prefix: string, opts: { maxKeys: number; startAfter?: string }) {
    const after = opts.startAfter ?? "";
    const folders: string[] = [];
    for (const k of [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort()) {
      const slash = k.indexOf("/", prefix.length);
      if (slash === -1) continue;
      const folder = k.slice(0, slash + 1);
      if (folders[folders.length - 1] !== folder) folders.push(folder);
    }
    const page = folders.slice(0, opts.maxKeys);
    return { prefixes: page, truncated: folders.length > page.length };
  }

  /** Test helper: every stored key. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

// ---- S3 ----

const MAX_ATTEMPTS = 2;

function setting(cfg: AppsConfig, key: string, env: string): string {
  const v = cfg[key];
  if (typeof v !== "string" || v.trim() === "") throw new ObjectStoreError(`${env} is not configured`);
  return v;
}

function endpointOf(cfg: AppsConfig): string {
  const raw = setting(cfg, "galleryS3Endpoint", "GALLERY_S3_ENDPOINT");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ObjectStoreError("GALLERY_S3_ENDPOINT is not a valid URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new ObjectStoreError("GALLERY_S3_ENDPOINT must be an http(s) URL without credentials");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** An S3 "not there" answer: a 404, or the SDK's NotFound / NoSuchKey error names. */
function isMissing(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.$metadata?.httpStatusCode === 404 && e?.name !== "NoSuchBucket";
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly timeoutMs: number;

  constructor(cfg: AppsConfig) {
    const endpoint = endpointOf(cfg);
    this.bucket = setting(cfg, "galleryS3Bucket", "GALLERY_S3_BUCKET");
    const region = setting(cfg, "galleryS3Region", "GALLERY_S3_REGION");
    const accessKeyId = setting(cfg, "galleryS3AccessKey", "GALLERY_S3_ACCESS_KEY");
    const secretAccessKey = setting(cfg, "galleryS3SecretKey", "GALLERY_S3_SECRET_KEY");
    this.timeoutMs = Number(cfg["webImageTimeoutS"]) * 1000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new ObjectStoreError("WEB_IMAGE_TIMEOUT_S must be a positive number");
    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true, // MinIO serves buckets by path, not by sub-domain
      // The SDK adds CRC32 checksum headers by default; several S3-compatible servers reject them.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: MAX_ATTEMPTS,
    });
  }

  /**
   * One command with an overall deadline (retries included). The SDK's own requestTimeout is a socket
   * idle timeout that a slow-answering server can defeat, so the deadline is an abort signal.
   */
  private send<T>(run: (opts: { abortSignal: AbortSignal }) => Promise<T>): Promise<T> {
    return run({ abortSignal: AbortSignal.timeout(this.timeoutMs) });
  }

  private fail(what: string): never {
    throw new ObjectStoreError(`object store ${what} failed`);
  }

  async put(key: string, bytes: Buffer, contentType: string, metadata: Record<string, string>): Promise<void> {
    try {
      await this.send((o) => this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, Metadata: metadata }), o));
    } catch {
      this.fail("write");
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const r = await this.send((o) => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), o));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? "", metadata: { ...(r.Metadata ?? {}) } };
    } catch (err) {
      if (isMissing(err)) return null;
      return this.fail("read");
    }
  }

  /**
   * The object, read with one deadline for the request AND its body, and a running byte cap: the
   * read stops (and the connection is dropped) as soon as the cap is passed, whether or not the server
   * sent a Content-Length. With a known length the bytes go straight into one buffer of that size.
   */
  async get(key: string, maxBytes: number): Promise<{ bytes: Buffer; contentType: string } | null> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let reply;
    try {
      reply = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
    } catch (err) {
      if (isMissing(err)) return null;
      return this.fail("read");
    }
    const body = reply.Body as (AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void }) | undefined;
    const declared = reply.ContentLength;
    if (typeof declared === "number" && declared > maxBytes) {
      body?.destroy?.();
      throw new ObjectStoreError("object is larger than allowed");
    }
    if (body === undefined || typeof body[Symbol.asyncIterator] !== "function") return this.fail("read");
    const onAbort = () => body.destroy?.(new Error("deadline"));
    signal.addEventListener("abort", onAbort, { once: true });
    const exact = typeof declared === "number" ? Buffer.allocUnsafe(declared) : null;
    const chunks: Buffer[] = [];
    let used = 0;
    try {
      for await (const chunk of body) {
        if (signal.aborted) return this.fail("read");
        used += chunk.length;
        if (used > maxBytes || (exact !== null && used > exact.length)) {
          body.destroy?.();
          throw new ObjectStoreError("object is larger than allowed");
        }
        if (exact !== null) exact.set(chunk, used - chunk.length);
        else chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
      }
    } catch (err) {
      if (err instanceof ObjectStoreError) throw err;
      return this.fail("read");
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted || (exact !== null && used !== exact.length)) return this.fail("read");
    return { bytes: exact ?? Buffer.concat(chunks, used), contentType: reply.ContentType ?? "" };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.send((o) => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), o));
    } catch (err) {
      if (!isMissing(err)) this.fail("delete");
    }
  }

  async list(prefix: string, opts: { maxKeys: number; startAfter?: string }) {
    try {
      const r = await this.send((o) =>
        this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: opts.maxKeys, ...(opts.startAfter ? { StartAfter: opts.startAfter } : {}) }),
          o,
        ),
      );
      const entries = (r.Contents ?? []).flatMap((o) => (typeof o.Key === "string" ? [{ key: o.Key, size: o.Size ?? 0 }] : []));
      return { entries, truncated: r.IsTruncated === true };
    } catch {
      return this.fail("list");
    }
  }

  async listPrefixes(prefix: string, opts: { maxKeys: number; startAfter?: string }) {
    try {
      const r = await this.send((o) =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket, Prefix: prefix, Delimiter: "/", MaxKeys: opts.maxKeys, ...(opts.startAfter ? { StartAfter: opts.startAfter } : {}),
          }),
          o,
        ),
      );
      const prefixes = (r.CommonPrefixes ?? []).flatMap((p) => (typeof p.Prefix === "string" ? [p.Prefix] : []));
      return { prefixes, truncated: r.IsTruncated === true };
    } catch {
      return this.fail("list");
    }
  }
}
