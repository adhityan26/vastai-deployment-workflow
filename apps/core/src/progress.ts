import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

// A small, read-mostly WebSocket client (RFC 6455) for ComfyUI's /ws?clientId=<id>: the step counter
// and the live preview of one job. Node's built-in WebSocket would buffer a single frame of up to 2 GiB
// and negotiates permessage-deflate, and the instance is a rented third-party host, so this client
// checks every frame header against a byte cap BEFORE it buffers the payload, asks for no extension
// (no compression, so no decompression bomb), never follows a redirect (a non-101 answer just ends it),
// is time-boxed (connect timeout and total lifetime) and never throws to its caller: anything it does
// not understand is ignored, anything it does not accept closes the socket. Previews and progress are
// optional: when the socket never connects or says nothing, a job works exactly as before.

/** The newest preview image of a job (only JPEG or PNG, recognised by its magic bytes). */
export interface PreviewFrame {
  readonly bytes: Buffer;
  readonly contentType: "image/jpeg" | "image/png";
}

/** Where the socket reports what it saw; every call is already validated. */
export interface ProgressSink {
  /** A sampler step of the job's prompt: `step` of `max` (1 <= max, 0 <= step <= max). */
  progress(step: number, max: number): void;
  preview(frame: PreviewFrame): void;
  /** ComfyUI started executing the prompt. */
  started(): void;
  /** The prompt finished (success, error or interruption); the socket closes itself right after. */
  finished(): void;
}

export interface ProgressOptions {
  readonly host: string;
  readonly port: number;
  /** The client id the prompt is submitted with (POST /prompt client_id). */
  readonly clientId: string;
  readonly connectTimeoutMs: number;
  /** The socket closes itself after this long whatever happens (the job's longest duration). */
  readonly lifetimeMs: number;
  /** Largest text (JSON) message accepted; a larger one closes the socket. */
  readonly maxTextBytes: number;
  /** Largest preview image accepted; a larger binary message closes the socket. */
  readonly maxPreviewBytes: number;
  /** Only progress of this node counts (the sampler); null counts any node. */
  readonly progressNode?: string | null;
}

export interface ProgressSocket {
  /** Resolves once the handshake is done or the socket gave up (never rejects). */
  readonly ready: Promise<void>;
  /** Messages that name another prompt are ignored from now on. */
  setPromptId(id: string): void;
  close(): void;
  readonly closed: boolean;
}

// Protocol constants (RFC 6455 and ComfyUI's protocol.py), not configuration.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const KEY_BYTES = 16;
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const CONTROL_MAX = 125;
const CLOSE_NORMAL = 1000;
const CLOSE_GRACE_MS = 1000;
const PREVIEW_EVENT = 1; // BinaryEventTypes.PREVIEW_IMAGE: u32 event, u32 format, image bytes
const PREVIEW_HEADER = 8;
const FORMAT_JPEG = 1;
const FORMAT_PNG = 2;
const STEP_MAX = 100_000;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FINISH_EVENTS = new Set(["execution_success", "execution_error", "execution_interrupted"]);

/** The image type by its magic bytes; null for anything that is not a JPEG or a PNG. */
export function sniffPreview(bytes: Buffer): PreviewFrame["contentType"] | null {
  if (bytes.length > JPEG_MAGIC.length && bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return "image/jpeg";
  if (bytes.length > PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return "image/png";
  return null;
}

/**
 * One binary message: a preview frame only when the event is PREVIEW_IMAGE, the declared format matches
 * the magic bytes and the image fits the cap. Anything else is null (ignored).
 */
export function parsePreviewMessage(data: Buffer, maxPreviewBytes: number): PreviewFrame | null {
  if (data.length <= PREVIEW_HEADER) return null;
  if (data.readUInt32BE(0) !== PREVIEW_EVENT) return null;
  const format = data.readUInt32BE(4);
  const image = data.subarray(PREVIEW_HEADER);
  if (image.length > maxPreviewBytes) return null;
  const sniffed = sniffPreview(image);
  const declared = format === FORMAT_JPEG ? "image/jpeg" : format === FORMAT_PNG ? "image/png" : null;
  if (sniffed === null || sniffed !== declared) return null;
  return { bytes: Buffer.from(image), contentType: sniffed }; // a copy: never keep the socket's buffer alive
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Open the socket of one job. Never throws: an unusable host or client id gives a socket that is already closed. */
export function watchProgress(opts: ProgressOptions, sink: ProgressSink): ProgressSocket {
  let closed = false;
  let promptId: string | null = null;
  let socket: Socket | null = null;
  let req: ClientRequest | null = null;
  let readyResolve: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => (readyResolve = resolve));
  const timers: ReturnType<typeof setTimeout>[] = [];

  const close = (): void => {
    if (closed) return;
    closed = true;
    readyResolve();
    for (const t of timers) clearTimeout(t);
    try {
      if (socket !== null && !socket.destroyed) {
        const s = socket;
        // A polite close frame, then the TCP end; destroyed shortly after whatever the peer does.
        s.end(frame(OP_CLOSE, Buffer.from([CLOSE_NORMAL >> 8, CLOSE_NORMAL & 0xff])));
        setTimeout(() => s.destroy(), CLOSE_GRACE_MS).unref();
      }
      req?.destroy();
    } catch {
      // closing is best effort
    }
  };
  const handle: ProgressSocket = {
    ready,
    setPromptId: (id: string) => {
      promptId = id;
    },
    close,
    get closed() {
      return closed;
    },
  };

  if (!HOST.test(opts.host) || !CLIENT_ID.test(opts.clientId) || !Number.isInteger(opts.port) || opts.port <= 0) {
    close();
    return handle;
  }
  const safe = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A): void => {
    try {
      fn(...args);
    } catch {
      close();
    }
  };

  const key = randomBytes(KEY_BYTES).toString("base64");
  const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");
  // Timers never keep the process alive on their own.
  timers.push(setTimeout(() => close(), opts.lifetimeMs).unref());
  const connectTimer = setTimeout(() => {
    if (socket === null) close();
  }, opts.connectTimeoutMs).unref();
  timers.push(connectTimer);

  try {
    req = httpRequest({
      host: opts.host,
      port: opts.port,
      method: "GET",
      path: `/ws?clientId=${encodeURIComponent(opts.clientId)}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });
  } catch {
    close();
    return handle;
  }
  req.on("error", () => close());
  // Any ordinary HTTP answer (an error, a redirect) ends it: nothing is followed.
  req.on("response", (res: IncomingMessage) => {
    res.resume();
    close();
  });
  req.on(
    "upgrade",
    safe((res: IncomingMessage, sock: Socket, head: Buffer) => {
      if (closed) {
        sock.destroy();
        return;
      }
      const upgrade = String(res.headers["upgrade"] ?? "").toLowerCase();
      if (res.statusCode !== 101 || upgrade !== "websocket" || res.headers["sec-websocket-accept"] !== expectedAccept || res.headers["sec-websocket-extensions"] !== undefined) {
        sock.destroy();
        close();
        return;
      }
      socket = sock;
      clearTimeout(connectTimer);
      sock.on("error", () => close());
      sock.on("close", () => close());
      const reader = new FrameReader(opts, (op, payload) => onMessage(op, payload), (op, payload) => onControl(op, payload), () => close());
      sock.on("data", safe((chunk: Buffer) => reader.push(chunk)));
      readyResolve();
      if (head.length > 0) reader.push(head);
    }),
  );
  req.end();

  function send(op: number, payload: Buffer): void {
    if (socket !== null && !socket.destroyed && !closed) socket.write(frame(op, payload));
  }

  function onControl(op: number, payload: Buffer): void {
    if (op === OP_PING) send(OP_PONG, payload);
    else if (op === OP_CLOSE) close();
  }

  function forUs(data: Record<string, unknown>): boolean {
    const id = data["prompt_id"];
    return promptId === null || id === undefined || id === promptId;
  }

  function onMessage(op: number, payload: Buffer): void {
    if (closed) return;
    if (op === OP_BINARY) {
      const preview = parsePreviewMessage(payload, opts.maxPreviewBytes);
      if (preview !== null) sink.preview(preview);
      return;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    } catch {
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObj(msg) || typeof msg["type"] !== "string" || !isObj(msg["data"])) return;
    const data = msg["data"];
    if (!forUs(data)) return;
    const type = msg["type"];
    if (type === "progress") {
      const { value, max, node } = data as { value?: unknown; max?: unknown; node?: unknown };
      if (!Number.isInteger(value) || !Number.isInteger(max)) return;
      const v = value as number;
      const m = max as number;
      if (m < 1 || m > STEP_MAX || v < 0 || v > m) return;
      if (opts.progressNode != null && typeof node === "string" && node !== opts.progressNode) return;
      sink.progress(v, m);
    } else if (type === "execution_start") {
      sink.started();
    } else if (FINISH_EVENTS.has(type) || (type === "executing" && data["node"] === null && promptId !== null && data["prompt_id"] === promptId)) {
      sink.finished();
      close();
    }
  }

  return handle;
}

/** One client frame: FIN set, masked as RFC 6455 requires of a client. */
function frame(op: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len <= 0xffff ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | op;
  if (len < 126) head[1] = 0x80 | len;
  else if (len <= 0xffff) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, body]);
}

/**
 * Incremental frame parser for server frames. The cap of a message is known from its first header, so
 * an oversized message is refused before its payload is buffered; fragmented messages are reassembled
 * up to the same cap. Server frames must not be masked and use no extension (RSV bits clear).
 */
class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOp = -1;
  private fragmentBytes = 0;
  private failed = false;

  constructor(
    private readonly opts: Pick<ProgressOptions, "maxTextBytes" | "maxPreviewBytes">,
    private readonly message: (op: number, payload: Buffer) => void,
    private readonly control: (op: number, payload: Buffer) => void,
    private readonly fail: () => void,
  ) {}

  private capFor(op: number): number {
    return op === OP_BINARY ? this.opts.maxPreviewBytes + PREVIEW_HEADER : this.opts.maxTextBytes;
  }

  private stop(): void {
    this.failed = true;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fail();
  }

  push(chunk: Buffer): void {
    if (this.failed) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.failed || this.buf.length < 2) return;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (rsv !== 0 || masked) return this.stop();
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) !== 0) return this.stop(); // 4 GiB or more: never
        len = this.buf.readUInt32BE(6);
        offset = 10;
      }
      const isControl = (op & 0x08) !== 0;
      if (isControl) {
        if (!fin || len > CONTROL_MAX || (op !== OP_CLOSE && op !== OP_PING && op !== OP_PONG)) return this.stop();
      } else if (op === OP_CONTINUATION) {
        if (this.fragmentOp === -1 || this.fragmentBytes + len > this.capFor(this.fragmentOp)) return this.stop();
      } else if (op === OP_TEXT || op === OP_BINARY) {
        if (this.fragmentOp !== -1 || len > this.capFor(op)) return this.stop();
      } else {
        return this.stop();
      }
      if (this.buf.length < offset + len) return; // wait for the rest; at most the cap is ever buffered
      const payload = this.buf.subarray(offset, offset + len);
      this.buf = this.buf.subarray(offset + len);
      if (isControl) {
        this.control(op, Buffer.from(payload));
        continue;
      }
      if (op !== OP_CONTINUATION && fin) {
        this.message(op, payload);
        continue;
      }
      if (op !== OP_CONTINUATION) this.fragmentOp = op;
      this.fragments.push(Buffer.from(payload));
      this.fragmentBytes += len;
      if (fin) {
        const whole = Buffer.concat(this.fragments, this.fragmentBytes);
        const kind = this.fragmentOp;
        this.fragments = [];
        this.fragmentOp = -1;
        this.fragmentBytes = 0;
        this.message(kind, whole);
      }
    }
  }
}
