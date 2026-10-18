import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_PHASES,
  BOOT_STEPS,
  CONSOLE_END_REASONS,
  ConsoleBuffer,
  ConsoleCorruptError,
  ConsoleStore,
  GAP_MARKER,
  consoleFileCap,
  logLines,
  maskLine,
  normalizeLine,
  truncateLine,
  type ConsoleLimits,
} from "../src/console.js";

const SECRET = "Zq9SECRETvalue0123456789";
const LIMITS: ConsoleLimits = { maxLines: 500, maxLineChars: 400, tailLines: 300 };

function buffer(limits: Partial<ConsoleLimits> = {}, secrets: string[] = [SECRET], clock = () => 1000): ConsoleBuffer {
  return new ConsoleBuffer({ ...LIMITS, ...limits }, () => secrets, clock);
}

const texts = (b: ConsoleBuffer, after = 0) => b.since(after).lines.map((l) => l.text);
const statuses = (b: ConsoleBuffer) => Object.fromEntries(b.phases().map((p) => [p.id, p.status]));

describe("maskLine", () => {
  const cases: [string, string, RegExp][] = [
    ["known secret", `value is ${SECRET} here`, new RegExp(SECRET)],
    ["tailscale key", "tailscale up --authkey tskey-auth-kAbC123-XyZ987 --hostname x", /kAbC123|XyZ987/],
    ["bearer token", "curl -H 'Bearer abc.def.ghi'", /abc\.def\.ghi/],
    ["authorization header", "Authorization: Basic dXNlcjpwYXNz", /dXNlcjpwYXNz/],
    ["api_key=", "url?api_key=hunter2hunter2&x=1", /hunter2/],
    ["api-key=", "API-KEY=plainvalue1", /plainvalue1/],
    ["token=", "AGENT_TOKEN=placeholdervalue", /placeholdervalue/],
    ["secret=", "client_secret=s3cr3tvalue", /s3cr3tvalue/],
    ["password=", "PASSWORD=correct-horse", /correct-horse/],
    ["json token", '{"token": "jsonsecretvalue"}', /jsonsecretvalue/],
    ["cli flag", 'vastai destroy instance 1 --api-key flagsecretvalue', /flagsecretvalue/],
    ["long hex", `key ${"a1b2c3d4".repeat(5)} end`, /a1b2c3d4a1b2c3d4/],
    ["long base64", `blob ${"QmFzZTY0U2VjcmV0VmFsdWUxMjM0NTY3ODkwYWJjZGVm"} end`, /QmFzZTY0U2VjcmV0/],
    ["padded base64", `b ${"QWxhZGRpbjpvcGVuIHNlc2FtZQ/AbCdEfGh1234567890+xyz=="} e`, /QWxhZGRpbjpv/],
    ["url credentials", "git clone https://user:pa55word@github.com/x/y.git", /pa55word|user:/],
    ["presigned signature", "GET https://s3.example.test/f?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIAXX", /deadbeefcafe|AKIAXX/],
  ];
  for (const [name, line, leak] of cases) {
    it(`masks ${name}`, () => {
      const out = maskLine(line, [SECRET]);
      expect(out).not.toMatch(leak);
      expect(out).toMatch(/\[redacted\]|\[hex\]/);
    });
  }

  // Each input is caught by exactly one rule, so removing any rule fails here.
  const exact: [string, string, string][] = [
    ["known secret", `v ${SECRET} x`, "v [redacted] x"],
    ["tailscale key", "printed tskey-auth-kAbC123-XyZ987 ok", "printed tskey-[redacted] ok"],
    ["authorization header", "Authorization: Basic dXNlcjpwYXNz", "Authorization: [redacted]"],
    ["bearer token", "sent Bearer abc.def.ghi now", "sent Bearer [redacted] now"],
    ["cli flag", "run --password hunter22 now", "run --password [redacted] now"],
    ["name=value", "AGENT_TOKEN=placeholdervalue next", "AGENT_TOKEN=[redacted] next"],
    ["long hex", `id ${"a1b2c3d4".repeat(4)} end`, "id [hex] end"],
    ["long base64url", "b QmFzZTY0U2VjcmV0VmFsdWUxMjM0NTY3ODkwYWJjZGVm e", "b [redacted] e"],
    ["padded base64", "b QWxhZGRpbjpvcGVuIHNlc2FtZQ/AbCdEfGh1234567890+xyz== e", "b [redacted] e"],
    ["url credentials", "clone https://user:pa55@github.com/x", "clone https://[redacted]@github.com/x"],
  ];
  for (const [name, line, want] of exact) {
    it(`masks exactly: ${name}`, () => expect(maskLine(line, [SECRET])).toBe(want));
  }

  it("leaves ordinary boot output alone", () => {
    for (const line of [
      "Cloning into '/opt/vast-comfy'...",
      "HEAD is now at 1a2b3c4 feat: something",
      "2fcf58654f0c: Verifying Checksum",
      "2fcf58654f0c: Download complete",
      "[boot] step 3/8: tailscale",
      "Get:1 http://archive.ubuntu.com/ubuntu jammy InRelease [270 kB]",
      "/opt/vast-comfy/instance/agent/vast_agent/downloads.py started",
      "max_tokens=5 tokenizer_mode=auto",
    ]) {
      expect(maskLine(line, [SECRET])).toBe(line);
    }
  });

  it("masks unpadded base64 with '/', ?key= values, multi-word passwords and upper-case tskey", () => {
    expect(maskLine("blob AbCdEfGhIjKlMnOp/QrStUvWxYz0123456789abcdEFGH end", [])).toBe("blob [redacted] end");
    expect(maskLine("GET https://api.example.test/v1/x?key=plainkeyvalue&y=1", [])).toBe(
      "GET https://api.example.test/v1/x?key=[redacted]&y=1",
    );
    expect(maskLine("DB_PASSWORD=correct horse battery staple", [])).toBe("DB_PASSWORD=[redacted]");
    expect(maskLine('{"password": "two words", "user": "bob"}', [])).toBe('{"password": "[redacted]", "user": "bob"}');
    expect(maskLine("key TSKEY-AUTH-kAbC123-XyZ987 end", [])).toBe("key tskey-[redacted] end");
    // Paths are not base64 even when long and mixed case with digits.
    for (const path of [
      "/workspace/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors",
      "models/checkpoints/Flux1Dev/unet/diffusion_pytorch_model.safetensors",
      "/opt/vast-comfy/instance/ComfyUI/custom_nodes/Impact-Pack/v8/install",
    ]) {
      expect(maskLine(path, [])).toBe(path);
    }
  });

  it("masks URL credentials whatever precedes the scheme", () => {
    for (const [line, want] of [
      ["clone -https://user:hunter2pass@github.com/x", "clone -https://[redacted]@github.com/x"],
      ["1.https://user:hunter2pass@host", "1.https://[redacted]@host"],
      [
        "downloading-from-the-primary-mirror-https://user:hunter2pass@host",
        "downloading-from-the-primary-mirror-https://[redacted]@host",
      ],
    ]) {
      expect(maskLine(line!, [])).toBe(want);
    }
  });

  it("masks short-part base64 with '/' (AWS-shaped) and leaves ordinary paths alone", () => {
    expect(maskLine("aws_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end", [])).toBe("aws_key [redacted] end");
    for (const path of ["/usr/local/bin", "cd /usr/local/bin/python3", "/workspace/ComfyUI/models3checkpointsdirectory"]) {
      expect(maskLine(path, [])).toBe(path);
    }
  });

  it("masks a known secret split over three or more lines (a middle line that is only a fragment)", () => {
    const long = "Zq9SECRETvalue0123456789-and-more-and-more";
    const parts = [long.slice(0, 12), long.slice(12, 26), long.slice(26)];
    expect(parts.map((p) => maskLine(p, [long]))).toEqual(["[redacted]", "[redacted]", "[redacted]"]);
  });

  it("masks hostile lines in linear time", () => {
    const shapes = ["a-", "a.", "a+", "x-y.", "token-", "a_b-", "aA1-"];
    for (const shape of shapes) {
      const line = shape.repeat(Math.ceil(3200 / shape.length)).slice(0, 3200);
      const t = performance.now();
      for (let i = 0; i < 300; i++) maskLine(line, [SECRET]);
      expect(performance.now() - t, shape).toBeLessThan(1000);
    }
  });

  it("masks the head of a known secret at the end of a line and its tail at the start", () => {
    expect(maskLine(`export X=${SECRET.slice(0, 10)}`, [SECRET])).toBe("export X=[redacted]");
    expect(maskLine(`${SECRET.slice(-9)} continues`, [SECRET])).toBe("[redacted] continues");
    // Short known values are not treated as secrets (they would mask ordinary words).
    expect(maskLine("the cat sat", ["cat"])).toBe("the cat sat");
  });
});

describe("normalizeLine, truncateLine, logLines", () => {
  it("keeps the last carriage-return segment and strips escape and control characters", () => {
    expect(normalizeLine("10%\r50%\r100% done\r")).toBe("100% done");
    expect(normalizeLine("\x1b[32mgreen\x1b[0m\ttab\x07bell")).toBe("green tabbell");
  });

  it("cuts with an ellipsis and never splits a surrogate pair", () => {
    expect(truncateLine("abcdef", 4)).toBe("abc…");
    expect(truncateLine("ab\u{1F600}cd", 4)).toBe("ab…");
    expect(truncateLine("abc", 4)).toBe("abc");
  });

  it("drops a last line without its newline", () => {
    expect(logLines("a\nb\nhalf")).toEqual(["a", "b"]);
    expect(logLines("a\nb\n")).toEqual(["a", "b"]);
    expect(logLines("")).toEqual([]);
  });
});

describe("ConsoleBuffer merge", () => {
  it("adds nothing when the same tail is read twice", () => {
    const b = buffer();
    b.append("vast_logs", ["a", "b", "c"]);
    b.append("vast_logs", ["a", "b", "c"]);
    expect(texts(b)).toEqual(["a", "b", "c"]);
  });

  it("adds only the new lines of a sliding tail", () => {
    const b = buffer();
    b.append("vast_logs", ["a", "b", "c"]);
    b.append("vast_logs", ["b", "c", "d", "e"]);
    b.append("vast_logs", ["d", "e", "f"]);
    expect(texts(b)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("keeps repeated lines that are really new", () => {
    const b = buffer();
    b.append("vast_logs", ["x", "x"]);
    b.append("vast_logs", ["x", "x", "x"]);
    expect(texts(b)).toEqual(["x", "x", "x"]);
  });

  it("adds a gap marker when the new tail does not overlap the previous one", () => {
    const b = buffer();
    b.append("vast_logs", ["a", "b"]);
    b.append("vast_logs", ["p", "q"]);
    expect(texts(b)).toEqual(["a", "b", GAP_MARKER, "p", "q"]);
  });

  it("treats a shorter tail found inside the previous one as stale", () => {
    const b = buffer();
    b.append("vast_logs", ["a", "b", "c", "d"]);
    b.append("vast_logs", ["b", "c"]);
    expect(texts(b)).toEqual(["a", "b", "c", "d"]);
  });

  it("skips status lines seen recently and repeated agent summaries", () => {
    const b = buffer();
    b.append("vast_status", ["layer1: Downloading", "layer2: Waiting"]);
    b.append("vast_status", ["layer1: Downloading", "layer2: Download complete"]);
    b.append("agent", ["agent: state=booting"]);
    b.append("agent", ["agent: state=booting"]);
    b.append("agent", ["agent: state=ready"]);
    expect(texts(b)).toEqual([
      "layer1: Downloading",
      "layer2: Waiting",
      "layer2: Download complete",
      "agent: state=booting",
      "agent: state=ready",
    ]);
    expect(b.since(0).lines.map((l) => l.source)).toEqual(["vast_status", "vast_status", "vast_status", "agent", "agent"]);
  });

  it("masks lines from every source before storing them", () => {
    const b = buffer();
    b.append("vast_logs", [`log ${SECRET}`]);
    b.append("vast_status", [`status Bearer ${SECRET}x`]);
    b.append("agent", [`agent reason=token=${SECRET}`]);
    const stored = JSON.stringify(b.toJSON());
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(SECRET.slice(0, 8));
    for (const t of texts(b)) expect(t).toContain("[redacted]");
  });

  it("masks a secret split across the tail overlap boundary", () => {
    const b = buffer();
    // First read: the line with the secret is still being written (no newline yet).
    b.append("vast_logs", logLines(`start\nprinting ${SECRET.slice(0, 11)}`));
    // Second read: the line is complete.
    b.append("vast_logs", logLines(`start\nprinting ${SECRET}\nnext\n`));
    // A secret broken over two lines.
    b.append("vast_logs", logLines(`start\nprinting ${SECRET}\nnext\nwrap ${SECRET.slice(0, 12)}\n${SECRET.slice(12)} tail\n`));
    const all = texts(b).join("\n");
    expect(texts(b)).toEqual(["start", "printing [redacted]", "next", "wrap [redacted]", "[redacted] tail"]);
    for (let k = 6; k <= SECRET.length; k++) expect(all).not.toContain(SECRET.slice(0, k));
  });

  it("re-masks on the way out with secrets learned later", () => {
    const known: string[] = [];
    const b = new ConsoleBuffer(LIMITS, () => known, () => 1);
    b.append("vast_logs", ["late Zq9LATESECRET42 value"]);
    known.push("Zq9LATESECRET42");
    expect(texts(b)).toEqual(["late [redacted] value"]);
  });
});

describe("ConsoleBuffer bounds", () => {
  it("keeps at most maxLines lines and reports truncation", () => {
    const b = buffer({ maxLines: 10, tailLines: 30 });
    b.append("vast_logs", Array.from({ length: 25 }, (_v, i) => `line ${i}`));
    const all = b.since(0);
    expect(all.lines).toHaveLength(10);
    expect(all.lines[0]!.text).toBe("line 15");
    expect(all.last_seq).toBe(25);
    expect(all.truncated).toBe(true);
    // "line 15" is seq 16: asking after 15 misses nothing, after 14 misses seq 15.
    expect(b.since(15).truncated).toBe(false);
    expect(b.since(14).truncated).toBe(true);
    expect(b.since(25).lines).toEqual([]);
  });

  it("is not truncated while nothing was dropped", () => {
    const b = buffer();
    b.append("vast_logs", ["a"]);
    expect(b.since(0).truncated).toBe(false);
  });

  it("cuts each line after masking", () => {
    const b = buffer({ maxLineChars: 20 });
    b.append("vast_logs", ["x".repeat(100), `${"y".repeat(10)} ${SECRET}`]);
    const [first, second] = texts(b);
    expect(first).toBe(`${"x".repeat(19)}…`);
    expect(first!.length).toBe(20);
    expect(second).toBe(`${"y".repeat(10)} [redacted]`.slice(0, 19) + "…");
    expect(second).not.toContain(SECRET.slice(0, 6));
  });

  it("bounds the work on a huge single line", () => {
    const b = buffer({ maxLineChars: 40 });
    b.append("vast_status", ["z".repeat(5_000_000)]);
    expect(texts(b)[0]!.length).toBe(40);
  });

  it("keeps the tail (most recent part) of an oversized line", () => {
    const b = buffer({ maxLineChars: 40 });
    // Longer than the pre-cut (8 x 40): the end is what is shown.
    b.append("vast_logs", [`HEAD${"x".repeat(1000)}${SECRET} TAILEND`]);
    const [line] = texts(b);
    expect(line!.length).toBeLessThanOrEqual(40);
    expect(line!.startsWith("…")).toBe(true);
    expect(line!.endsWith("[redacted] TAILEND")).toBe(true);
    expect(line).not.toContain("HEAD");
  });

  it("buffers 300 hostile lines per poll well under a second", () => {
    const b = buffer({ maxLines: 1000, tailLines: 300 });
    const lines = Array.from({ length: 300 }, (_v, i) => `${i} ${"a-".repeat(1600)}`);
    const t = performance.now();
    b.append("vast_logs", lines);
    b.append("vast_logs", [...lines.slice(1), "next"]);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(b.lastSeq).toBe(301);
  });
});

describe("ConsoleBuffer lifecycle", () => {
  it("reset clears lines and the ended flag, keeps counting seq and bumps the generation", () => {
    const b = buffer();
    b.reset("vast-one");
    b.append("vast_logs", ["a", "b"]);
    b.markEnded("destroyed");
    b.markEnded("gone");
    expect(b.ended).toBe(true);
    expect(b.endedReason).toBe("destroyed");
    expect(texts(b)).toEqual(["a", "b"]);
    const gen = b.generation;
    b.reset("vast-two");
    expect(b.generation).toBe(gen + 1);
    expect(b.ended).toBe(false);
    expect(b.owner).toBe("vast-two");
    expect(texts(b)).toEqual([]);
    b.append("vast_logs", ["a"]);
    expect(b.since(0).lines[0]!.seq).toBe(3);
  });
});

describe("phases", () => {
  it("lists every phase in the fixed order", () => {
    expect(BOOT_PHASES.map((p) => p.id)).toEqual([
      "image_pull", "install_tools", "failsafe", "tailscale", "agent", "nodes", "models", "comfyui", "ready",
    ]);
    expect(BOOT_STEPS).toHaveLength(8);
    const b = buffer();
    expect(new Set(Object.values(statuses(b)))).toEqual(new Set(["pending"]));
    expect(b.phases().every((p) => p.name.length > 0 && p.name.length <= 20)).toBe(true);
  });

  it("follows Vast loading for the image pull", () => {
    const b = buffer();
    b.setVastStatus("loading");
    expect(statuses(b)["image_pull"]).toBe("running");
    b.setVastStatus("running");
    expect(statuses(b)["image_pull"]).toBe("done");
    expect(statuses(b)["install_tools"]).toBe("pending");
  });

  it("derives the steps from the markers", () => {
    const b = buffer();
    b.setVastStatus("loading");
    b.append("vast_logs", ["[boot] step 1/8: install_tools", "apt output", "[boot] step 3/8: tailscale"]);
    expect(statuses(b)).toMatchObject({
      image_pull: "done", install_tools: "done", failsafe: "done", tailscale: "running", agent: "pending", ready: "pending",
    });
    b.append("vast_logs", ["[boot] FAILED: tailscale_up"]);
    expect(statuses(b)).toMatchObject({ failsafe: "done", tailscale: "failed", agent: "pending" });
    b.append("vast_logs", ["[boot] step 8/8: ready"]);
    expect(new Set(Object.values(statuses(b)))).toEqual(new Set(["done"]));
  });

  it("fails the first phase not done when the boot dies before any step", () => {
    const b = buffer();
    b.setVastStatus("running");
    b.append("vast_logs", ["[boot] FAILED: clone_failed"]);
    expect(statuses(b)).toMatchObject({ image_pull: "done", install_tools: "failed", failsafe: "pending" });
  });

  it("reads only the exact marker grammar from the container log", () => {
    const b = buffer();
    b.append("vast_logs", [
      "echo [boot] step 4/8: agent",
      "[boot] step 4/8: unknown_step",
      "[boot] step 4/8: Agent",
      "[boot] FAILED: Bad Code",
    ]);
    b.append("agent", ["[boot] step 5/8: nodes"]);
    b.append("vast_status", ["[boot] FAILED: x"]);
    expect(new Set(Object.values(statuses(b)))).toEqual(new Set(["pending"]));
  });
});

describe("persistence", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "boot-console-"));

  it("round-trips through the store atomically with mode 600", () => {
    const d = dir();
    const path = join(d, "sub", "boot-console.json");
    const store = new ConsoleStore(path, consoleFileCap(LIMITS));
    const b = buffer();
    b.reset("vast-abc");
    b.setVastStatus("running");
    b.append("vast_logs", ["[boot] step 2/8: failsafe", "x"]);
    b.markEnded("vanished");
    store.save(b.toJSON());
    expect(readdirSync(join(d, "sub"))).toEqual(["boot-console.json"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const back = ConsoleBuffer.fromJSON(store.load(), LIMITS, () => [SECRET], () => 1);
    expect(texts(back)).toEqual(texts(b));
    expect(back.since(0)).toEqual(b.since(0));
    expect(back.phases()).toEqual(b.phases());
    expect(back.owner).toBe("vast-abc");
    expect(back.endedReason).toBe("vanished");
    // The overlap memory survives: the same tail again adds nothing.
    back.append("vast_logs", ["[boot] step 2/8: failsafe", "x"]);
    expect(back.lastSeq).toBe(b.lastSeq);
  });

  it("ignores a corrupt, oversized or foreign file", () => {
    const d = dir();
    const path = join(d, "boot-console.json");
    const store = new ConsoleStore(path, 1024);
    expect(store.load()).toBeNull();
    writeFileSync(path, "{not json");
    expect(store.load()).toBeNull();
    writeFileSync(path, JSON.stringify({ pad: "x".repeat(2000) }));
    expect(store.load()).toBeNull();
    for (const bad of [
      null,
      [],
      { version: 2 },
      { ...buffer().toJSON(), lines: [{ seq: "1" }] },
      { ...buffer().toJSON(), step: 99 },
      { ...buffer().toJSON(), ended: true, ended_reason: "<script>" },
      { ...buffer().toJSON(), ended: true, ended_reason: "x".repeat(10) },
    ]) {
      expect(() => ConsoleBuffer.fromJSON(bad, LIMITS, () => [], () => 1)).toThrow(ConsoleCorruptError);
    }
  });

  it("restores every allowed ended_reason and loads a file exactly at the cap", () => {
    for (const reason of CONSOLE_END_REASONS) {
      const b = buffer();
      b.reset("vast-x");
      b.markEnded(reason);
      expect(ConsoleBuffer.fromJSON(b.toJSON(), LIMITS, () => [], () => 1).endedReason).toBe(reason);
    }
    const path = join(dir(), "f.json");
    const body = JSON.stringify({ pad: "y".repeat(100) });
    writeFileSync(path, body);
    expect(new ConsoleStore(path, Buffer.byteLength(body)).load()).toEqual({ pad: "y".repeat(100) });
    expect(new ConsoleStore(path, Buffer.byteLength(body) - 1).load()).toBeNull();
  });

  it("clamps a restored state to the current limits and masks it again", () => {
    const b = new ConsoleBuffer(LIMITS, () => [], () => 1);
    b.append("vast_logs", Array.from({ length: 30 }, (_v, i) => `line ${i} ${SECRET}`));
    const back = ConsoleBuffer.fromJSON(b.toJSON(), { maxLines: 5, maxLineChars: 12, tailLines: 5 }, () => [SECRET], () => 1);
    const out = back.since(0);
    expect(out.lines).toHaveLength(5);
    expect(out.truncated).toBe(true);
    for (const l of out.lines) {
      expect(l.text.length).toBeLessThanOrEqual(12);
      expect(l.text).not.toContain(SECRET.slice(0, 6));
    }
  });

  it("refuses to save a state larger than the cap", () => {
    const store = new ConsoleStore(join(dir(), "f.json"), 100);
    const b = buffer();
    b.append("vast_logs", ["x".repeat(200)]);
    expect(() => store.save(b.toJSON())).toThrow(/larger/);
  });
});
