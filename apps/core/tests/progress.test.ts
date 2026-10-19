import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppsConfig } from "../src/config.js";
import { ComfyClient } from "../src/comfy.js";
import { FrameReader, parsePreviewMessage, sniffPreview, watchProgress, type PreviewFrame, type ProgressOptions, type ProgressSocket } from "../src/progress.js";
import { JPEG, PNG_IMG, previewFrame, serverFrame, startFakeComfyWs, textFrame, until, type FakeComfyWs } from "./fake-ws.js";

class Sink {
  steps: [number, number][] = [];
  previews: PreviewFrame[] = [];
  starts = 0;
  finishes = 0;
  progress(step: number, max: number) {
    this.steps.push([step, max]);
  }
  preview(frame: PreviewFrame) {
    this.previews.push(frame);
  }
  started() {
    this.starts++;
  }
  finished() {
    this.finishes++;
  }
}

let fake: FakeComfyWs | null = null;
const sockets: ProgressSocket[] = [];
const extra: Server[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await fake?.close();
  fake = null;
  for (const s of extra.splice(0)) {
    s.closeAllConnections?.();
    s.close();
  }
});

function open(port: number, over: Partial<ProgressOptions> = {}, sink = new Sink()) {
  const socket = watchProgress(
    { host: "127.0.0.1", port, clientId: "job-a", connectTimeoutMs: 2000, lifetimeMs: 10_000, maxTextBytes: 1024, maxPreviewBytes: 64, progressNode: null, ...over },
    sink,
  );
  sockets.push(socket);
  return { socket, sink };
}

async function connected(over: Partial<ProgressOptions> = {}) {
  fake = await startFakeComfyWs();
  const peerP = fake.nextPeer();
  const { socket, sink } = open(fake.port, over);
  const peer = await peerP;
  await socket.ready;
  return { socket, sink, peer };
}

const progress = (value: unknown, max: unknown, extra: Record<string, unknown> = {}) => textFrame({ type: "progress", data: { value, max, prompt_id: "p-1", node: "8", ...extra } });

describe("progress socket", () => {
  it("connects with the client id, reports steps and the newest previews with their sniffed type", async () => {
    const { socket, sink, peer } = await connected();
    expect(peer.clientId).toBe("job-a");
    expect(peer.url).toBe("/ws?clientId=job-a");
    socket.setPromptId("p-1");
    peer.send(textFrame({ type: "status", data: { status: {}, sid: "job-a" } }));
    peer.send(textFrame({ type: "execution_start", data: { prompt_id: "p-1", timestamp: 1 } }));
    peer.send(progress(1, 25));
    peer.send(previewFrame(JPEG("1"), 1));
    peer.send(progress(2, 25));
    peer.send(previewFrame(PNG_IMG("2"), 2));
    await until(() => sink.previews.length === 2);
    expect(sink.starts).toBe(1);
    expect(sink.steps).toEqual([[1, 25], [2, 25]]);
    expect(sink.previews.map((p) => p.contentType)).toEqual(["image/jpeg", "image/png"]);
    expect(sink.previews[1]!.bytes.equals(PNG_IMG("2"))).toBe(true);
    expect(socket.closed).toBe(false);
  });

  it("ignores malformed, unknown and implausible messages and keeps listening", async () => {
    const { socket, sink, peer } = await connected();
    socket.setPromptId("p-1");
    for (const bad of [
      "not json",
      "[1,2]",
      JSON.stringify({ type: "progress" }),
      JSON.stringify({ type: 5, data: {} }),
      JSON.stringify({ type: "something_new", data: { value: 1 } }),
    ]) peer.send(textFrame(bad));
    peer.send(serverFrame(0x1, Buffer.from([0xc3, 0x28]))); // invalid UTF-8
    for (const [v, m] of [[3, 2], [-1, 5], [1.5, 5], ["1", 5], [1, 0], [1, 1e9]] as [unknown, unknown][]) peer.send(progress(v, m));
    peer.send(progress(1, 5, { prompt_id: "someone-else" }));
    peer.send(previewFrame(Buffer.from("GIF89a-not-allowed"), 1)); // wrong magic bytes
    peer.send(previewFrame(PNG_IMG(), 1)); // declared JPEG, is a PNG
    peer.send(previewFrame(JPEG(), 7)); // unknown format
    peer.send(previewFrame(JPEG(), 1, 3)); // another binary event type
    peer.send(serverFrame(0x2, Buffer.from([0, 0, 0, 1]))); // shorter than the header
    peer.send(progress(4, 5));
    await until(() => sink.steps.length === 1);
    expect(sink.steps).toEqual([[4, 5]]);
    expect(sink.previews).toEqual([]);
    expect(socket.closed).toBe(false);
  });

  it("counts only the sampler node when one is named", async () => {
    const { sink, peer } = await connected({ progressNode: "8" });
    peer.send(progress(1, 4, { node: "12" }));
    peer.send(progress(2, 4));
    await until(() => sink.steps.length === 1);
    expect(sink.steps).toEqual([[2, 4]]);
  });

  it("closes on a binary message above the preview cap, judged from the header before the payload arrives", async () => {
    const { socket, sink, peer } = await connected({ maxPreviewBytes: 64 });
    peer.send(serverFrame(0x2, Buffer.alloc(16), { claimLength: 50_000_000 })); // claims 50 MB, sends 16 bytes
    await until(() => socket.closed);
    expect(sink.previews).toEqual([]);
    await until(() => peer.frames().some((f) => f.op === 0x8));
  });

  it("closes on an oversized text message, a 64-bit length of 4 GiB or more, a masked frame and RSV bits", async () => {
    for (const bad of [
      serverFrame(0x1, Buffer.alloc(2000, 0x20)),
      Buffer.concat([Buffer.from([0x82, 127, 0, 0, 0, 1, 0, 0, 0, 0])]),
      serverFrame(0x1, Buffer.from("{}"), { masked: true }),
      serverFrame(0x1, Buffer.from("{}"), { rsv: 4 }),
      serverFrame(0x3, Buffer.from("x")),
      serverFrame(0x9, Buffer.alloc(126)),
    ]) {
      const { socket, peer } = await connected({ maxTextBytes: 1024 });
      peer.send(bad);
      await until(() => socket.closed);
      await fake!.close();
      fake = null;
    }
  });

  it("answers a ping with a masked pong and reassembles a fragmented message within the cap", async () => {
    const { sink, peer } = await connected();
    peer.send(serverFrame(0x9, Buffer.from("hi")));
    const whole = JSON.stringify({ type: "progress", data: { value: 3, max: 9 } });
    peer.send(serverFrame(0x1, Buffer.from(whole.slice(0, 10)), { fin: false }));
    peer.send(serverFrame(0x0, Buffer.from(whole.slice(10))));
    await until(() => sink.steps.length === 1 && peer.frames().some((f) => f.op === 0xa));
    const pong = peer.frames().find((f) => f.op === 0xa)!;
    expect(pong.masked).toBe(true);
    expect(pong.payload.toString()).toBe("hi");
    expect(sink.steps).toEqual([[3, 9]]);
  });

  it("finishes and closes when its prompt finishes, not on another prompt's success", async () => {
    const { socket, sink, peer } = await connected();
    socket.setPromptId("p-1");
    peer.send(textFrame({ type: "execution_success", data: { prompt_id: "p-other" } }));
    peer.send(progress(1, 2));
    await until(() => sink.steps.length === 1);
    expect(socket.closed).toBe(false);
    peer.send(textFrame({ type: "execution_success", data: { prompt_id: "p-1", timestamp: 5 } }));
    await until(() => socket.closed);
    expect(sink.finishes).toBe(1);
    await until(() => peer.frames().some((f) => f.op === 0x8));
    peer.send(progress(2, 2)); // after the close nothing is reported
    await new Promise((r) => setTimeout(r, 30));
    expect(sink.steps).toEqual([[1, 2]]);
  });

  it("an execution error or an interruption also finishes it", async () => {
    for (const type of ["execution_error", "execution_interrupted"]) {
      const { socket, sink, peer } = await connected();
      socket.setPromptId("p-1");
      peer.send(textFrame({ type, data: { prompt_id: "p-1" } }));
      await until(() => socket.closed);
      expect(sink.finishes).toBe(1);
      await fake!.close();
      fake = null;
    }
  });

  it("gives up on a socket that never connects, without ever throwing", async () => {
    fake = await startFakeComfyWs({ onUpgrade: () => false }); // the upgrade is never answered
    const { socket } = open(fake.port, { connectTimeoutMs: 100 });
    await socket.ready;
    expect(socket.closed).toBe(true);
    // Nothing listens on this port.
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const refused = open(port).socket;
    await refused.ready;
    expect(refused.closed).toBe(true);
  });

  it("never follows a redirect or accepts a plain HTTP answer", async () => {
    fake = await startFakeComfyWs({
      onUpgrade: (_req, sock) => {
        sock.end("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/ws\r\nContent-Length: 0\r\n\r\n");
        return false;
      },
    });
    const { socket } = open(fake.port);
    await socket.ready;
    expect(socket.closed).toBe(true);
    expect(fake.peers).toHaveLength(0);
  });

  it("refuses a handshake with a wrong accept key or an extension it did not ask for", async () => {
    for (const headers of [{ "Sec-WebSocket-Accept": "wrong" }, null]) {
      fake = await startFakeComfyWs({
        acceptHeaders: headers ? () => headers : undefined,
        onUpgrade: headers ? undefined : (req, sock) => {
          const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
          sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`);
          return false;
        },
      });
      const { socket } = open(fake.port);
      await socket.ready;
      await until(() => socket.closed);
      await fake.close();
      fake = null;
    }
  });

  it("closes itself at the end of its lifetime", async () => {
    const { socket, peer } = await connected({ lifetimeMs: 80 });
    await until(() => socket.closed);
    await until(() => peer.frames().some((f) => f.op === 0x8));
  });

  it("an unusable host or client id gives a closed socket without a connection", async () => {
    for (const over of [{ host: "bad host" }, { clientId: "../x" }, { clientId: "" }]) {
      const { socket } = open(1, over);
      expect(socket.closed).toBe(true);
      await socket.ready;
    }
  });

  it("two jobs in a row each get only their own socket's previews", async () => {
    fake = await startFakeComfyWs();
    const first = fake.nextPeer();
    const a = open(fake.port, { clientId: "job-a" });
    const pa = await first;
    const second = fake.nextPeer();
    const b = open(fake.port, { clientId: "job-b" });
    const pb = await second;
    expect([pa.clientId, pb.clientId]).toEqual(["job-a", "job-b"]);
    pa.send(previewFrame(JPEG("A")));
    pb.send(previewFrame(JPEG("B")));
    await until(() => a.sink.previews.length === 1 && b.sink.previews.length === 1);
    expect(a.sink.previews[0]!.bytes.equals(JPEG("A"))).toBe(true);
    expect(b.sink.previews[0]!.bytes.equals(JPEG("B"))).toBe(true);
  });
});

describe("fragmented messages", () => {
  const start = (text: string) => serverFrame(0x1, Buffer.from(text), { fin: false });
  const cont = (text: string, fin = false) => serverFrame(0x0, Buffer.from(text), { fin });

  it("closes on a flood of zero-length continuation frames", async () => {
    const { socket, sink, peer } = await connected({ maxTextBytes: 1024 });
    const empty = cont("");
    peer.send(Buffer.concat([start("{"), ...Array.from({ length: 5000 }, () => empty)]));
    await until(() => socket.closed);
    expect(sink.steps).toEqual([]);
  });

  it("counts a per-frame overhead against the cap: many tiny fragments close the socket", async () => {
    const { socket, peer } = await connected({ maxTextBytes: 1024 });
    peer.send(Buffer.concat([start("{"), ...Array.from({ length: 100 }, () => cont(" "))]));
    await until(() => socket.closed);
  });

  it("closes on a continuation with no start, a new message inside a fragmented one, and fragments past the cap", async () => {
    for (const frames of [
      [cont("x", true)],
      [start("{"), serverFrame(0x1, Buffer.from("{}"))],
      [start("{"), serverFrame(0x2, Buffer.from("x"))],
      [start("x".repeat(600)), cont("x".repeat(600), true)],
    ]) {
      const { socket, peer } = await connected({ maxTextBytes: 1024 });
      peer.send(Buffer.concat(frames));
      await until(() => socket.closed);
      await fake!.close();
      fake = null;
    }
  });

  it("answers a ping inside a fragmented message and still completes the message", async () => {
    const { socket, sink, peer } = await connected();
    const whole = JSON.stringify({ type: "progress", data: { value: 2, max: 7 } });
    peer.send(start(whole.slice(0, 12)));
    peer.send(serverFrame(0x9, Buffer.from("mid")));
    peer.send(cont(whole.slice(12), true));
    await until(() => sink.steps.length === 1 && peer.frames().some((f) => f.op === 0xa));
    expect(sink.steps).toEqual([[2, 7]]);
    expect(peer.frames().find((f) => f.op === 0xa)!.payload.toString()).toBe("mid");
    expect(socket.closed).toBe(false);
  });

  it("ignores a text frame that is not valid UTF-8 and keeps listening", async () => {
    const { socket, sink, peer } = await connected();
    peer.send(serverFrame(0x1, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])));
    peer.send(progress(1, 3));
    await until(() => sink.steps.length === 1);
    expect(socket.closed).toBe(false);
  });

  it("closes when the peer stops reading and floods pings (the ping rate limit closes it first; the write backlog cap is a second guard)", async () => {
    const { socket, peer } = await connected({ lifetimeMs: 60_000 });
    peer.socket.pause(); // the fake never reads again: our pongs queue up locally
    const ping = serverFrame(0x9, Buffer.alloc(125, 0x61));
    for (let i = 0; i < 40; i++) peer.send(Buffer.concat(Array.from({ length: 1000 }, () => ping)));
    await until(() => socket.closed, 8_000);
  }, 15_000);
});

describe("frame reader buffering", () => {
  it("reassembles a frame delivered one byte at a time without copying the buffer on every byte", () => {
    const got: Buffer[] = [];
    const reader = new FrameReader({ maxTextBytes: 1024, maxPreviewBytes: 512 * 1024 }, (_op, p) => void got.push(Buffer.from(p)), () => undefined, () => {
      throw new Error("must not fail");
    });
    const image = Buffer.concat([JPEG("big"), Buffer.alloc(200_000, 7)]);
    const wire = previewFrame(image);
    const concat = vi.spyOn(Buffer, "concat");
    const t0 = Date.now();
    for (let i = 0; i < wire.length; i++) reader.push(wire.subarray(i, i + 1));
    const calls = concat.mock.calls.length;
    concat.mockRestore();
    expect(got).toHaveLength(1);
    expect(got[0]!.subarray(8).equals(image)).toBe(true);
    expect(calls).toBeLessThan(10);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("still parses several frames in one chunk and a header split across chunks", () => {
    const got: string[] = [];
    const reader = new FrameReader({ maxTextBytes: 1024, maxPreviewBytes: 64 }, (_op, p) => void got.push(p.toString()), () => undefined, () => undefined);
    const two = Buffer.concat([textFrame("a"), serverFrame(0x1, Buffer.alloc(300, 0x62))]);
    reader.push(two.subarray(0, 4)); // first frame done, half the 16-bit length header of the second
    reader.push(two.subarray(4, 6));
    reader.push(two.subarray(6));
    expect(got).toEqual(["a", "b".repeat(300)]);
  });
});

describe("ping rate", () => {
  it("closes a socket whose peer floods pings, keeps one that pings now and then", async () => {
    const calm = await connected();
    for (let i = 0; i < 5; i++) calm.peer.send(serverFrame(0x9, Buffer.from(`p${i}`)));
    await until(() => calm.peer.frames().filter((f) => f.op === 0xa).length === 5);
    expect(calm.socket.closed).toBe(false);
    await fake!.close();
    fake = null;
    const { socket, peer } = await connected({ lifetimeMs: 60_000 });
    peer.send(Buffer.concat(Array.from({ length: 200 }, () => serverFrame(0x9, Buffer.from("x")))));
    await until(() => socket.closed);
  });
});

describe("preview parsing", () => {
  it("sniffs only JPEG and PNG", () => {
    expect(sniffPreview(JPEG())).toBe("image/jpeg");
    expect(sniffPreview(PNG_IMG())).toBe("image/png");
    expect(sniffPreview(Buffer.from("RIFF....WEBP"))).toBeNull();
    expect(sniffPreview(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull(); // the magic alone is not an image
  });

  it("returns a copy within the cap", () => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(1, 0);
    head.writeUInt32BE(1, 4);
    const msg = Buffer.concat([head, JPEG()]);
    const frame = parsePreviewMessage(msg, 64)!;
    msg.fill(0);
    expect(frame.bytes.equals(JPEG())).toBe(true);
    expect(parsePreviewMessage(Buffer.concat([head, JPEG(), Buffer.alloc(100)]), 64)).toBeNull();
  });
});

describe("ComfyClient and the progress socket", () => {
  it("submits with the client id and opens the socket on the same host and port", async () => {
    fake = await startFakeComfyWs({
      http: (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prompt_id: "p-9" }));
      },
    });
    const cfg = { comfyPort: fake.port, httpTimeoutSApps: 5, webImageTimeoutS: 5, webJsonMaxBytes: 4096, webImageMaxBytes: 8192, secretNames: [] } as unknown as AppsConfig;
    const client = new ComfyClient("127.0.0.1", cfg);
    const peerP = fake.nextPeer();
    const sink = new Sink();
    const socket = client.progress("cid-1", sink, { lifetimeMs: 5000, maxTextBytes: 1024, maxPreviewBytes: 1024 }, "8");
    sockets.push(socket);
    const peer = await peerP;
    expect(peer.clientId).toBe("cid-1");
    expect(await client.submit({ "1": {} }, "cid-1")).toEqual({ promptId: "p-9" });
    expect(JSON.parse(fake.requests[0]!.body)).toEqual({ prompt: { "1": {} }, client_id: "cid-1" });
    peer.send(progress(1, 3, { node: "9" }));
    peer.send(progress(2, 3, { node: "8" }));
    await until(() => sink.steps.length === 1);
    expect(sink.steps).toEqual([[2, 3]]);
  });
});
