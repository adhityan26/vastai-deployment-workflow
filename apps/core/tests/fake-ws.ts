import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

// A fake ComfyUI websocket endpoint (RFC 6455 server side, written by hand so tests can also send frames a
// real server never would). Plain HTTP requests go to `http`, upgrades to /ws are accepted unless `onUpgrade`
// says otherwise.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface FrameOptions {
  fin?: boolean;
  rsv?: number;
  /** Mask the frame (a server must not; the client must refuse it). */
  masked?: boolean;
  /** Claim this payload length in the header instead of the real one. */
  claimLength?: number;
}

/** One server frame. */
export function serverFrame(op: number, payload: Buffer, o: FrameOptions = {}): Buffer {
  const len = o.claimLength ?? payload.length;
  const head: number[] = [((o.fin ?? true) ? 0x80 : 0) | ((o.rsv ?? 0) << 4) | op];
  const maskBit = o.masked ? 0x80 : 0;
  let ext = Buffer.alloc(0);
  if (len < 126) head.push(maskBit | len);
  else if (len <= 0xffff) {
    head.push(maskBit | 126);
    ext = Buffer.alloc(2);
    ext.writeUInt16BE(len);
  } else {
    head.push(maskBit | 127);
    ext = Buffer.alloc(8);
    ext.writeBigUInt64BE(BigInt(len));
  }
  const mask = o.masked ? Buffer.from([1, 2, 3, 4]) : Buffer.alloc(0);
  const body = o.masked ? Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!)) : payload;
  return Buffer.concat([Buffer.from(head), ext, mask, body]);
}

export const textFrame = (value: unknown): Buffer => serverFrame(0x1, Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));

/** A ComfyUI PREVIEW_IMAGE message: u32 event 1, u32 format (1 JPEG, 2 PNG), image bytes. */
export function previewFrame(image: Buffer, format = 1, event = 1): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(event, 0);
  head.writeUInt32BE(format, 4);
  return serverFrame(0x2, Buffer.concat([head, image]));
}

export const JPEG = (marker = "J"): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg-${marker}`)]);
export const PNG_IMG = (marker = "P"): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`png-${marker}`)]);

/** One client frame decoded (the client must mask every frame). */
export interface ClientFrame { op: number; masked: boolean; payload: Buffer }

export function parseClientFrames(data: Buffer): ClientFrame[] {
  const out: ClientFrame[] = [];
  let at = 0;
  while (data.length - at >= 2) {
    const op = data[at]! & 0x0f;
    const masked = (data[at + 1]! & 0x80) !== 0;
    let len = data[at + 1]! & 0x7f;
    let off = at + 2;
    if (len === 126) {
      len = data.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      len = Number(data.readBigUInt64BE(off));
      off += 8;
    }
    const mask = masked ? data.subarray(off, off + 4) : null;
    if (masked) off += 4;
    if (data.length < off + len) break;
    const raw = data.subarray(off, off + len);
    out.push({ op, masked, payload: mask ? Buffer.from(raw.map((b, i) => b ^ mask[i % 4]!)) : Buffer.from(raw) });
    at = off + len;
  }
  return out;
}

export interface Peer {
  url: string;
  clientId: string | null;
  socket: Socket;
  received: Buffer;
  send(frame: Buffer): void;
  frames(): ClientFrame[];
  closed: boolean;
}

export interface FakeComfyWs {
  port: number;
  peers: Peer[];
  /** Plain HTTP requests (for example POST /prompt) seen so far. */
  requests: { method: string; url: string; body: string }[];
  /** Resolves with the next peer that connects. */
  nextPeer(): Promise<Peer>;
  close(): Promise<void>;
}

export interface WsOptions {
  /** Return false to leave the upgrade unanswered (or answer it yourself on the socket). */
  onUpgrade?: (req: IncomingMessage, socket: Socket) => boolean;
  /** Response headers of the 101 instead of the right accept key (to test refusals). */
  acceptHeaders?: (key: string) => Record<string, string>;
}

/** Accept websocket upgrades on an existing HTTP server (for example the fake ComfyUI of a route test). */
export function acceptWebSockets(server: Server, opts: WsOptions = {}): { peers: Peer[]; nextPeer(): Promise<Peer> } {
  const peers: Peer[] = [];
  const waiters: ((p: Peer) => void)[] = [];
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    socket.on("error", () => undefined);
    if (opts.onUpgrade && !opts.onUpgrade(req, socket)) return;
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    const headers = opts.acceptHeaders?.(key) ?? { "Sec-WebSocket-Accept": accept };
    socket.write(
      ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n"),
    );
    const url = req.url ?? "";
    const peer: Peer = {
      url,
      clientId: new URL(url, "http://x").searchParams.get("clientId"),
      socket,
      received: Buffer.alloc(0),
      send: (frame) => {
        if (!socket.destroyed) socket.write(frame);
      },
      frames: () => parseClientFrames(peer.received),
      closed: false,
    };
    socket.on("data", (d: Buffer) => (peer.received = Buffer.concat([peer.received, d])));
    socket.on("close", () => (peer.closed = true));
    peers.push(peer);
    waiters.shift()?.(peer);
  });
  return { peers, nextPeer: () => new Promise<Peer>((resolve) => waiters.push(resolve)) };
}

export async function startFakeComfyWs(
  opts: WsOptions & { http?: (req: { method: string; url: string; body: string }, res: ServerResponse) => void } = {},
): Promise<FakeComfyWs> {
  const requests: FakeComfyWs["requests"] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const seen = { method: req.method ?? "", url: req.url ?? "", body };
      requests.push(seen);
      if (opts.http) return opts.http(seen, res);
      res.writeHead(404);
      res.end();
    });
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  const ws = acceptWebSockets(server, opts);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    peers: ws.peers,
    requests,
    nextPeer: ws.nextPeer,
    close: async () => {
      for (const s of sockets) s.destroy();
      for (const p of ws.peers) p.socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Wait until `check` holds (polling), or fail after `ms`. */
export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}
