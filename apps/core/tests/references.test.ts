import { describe, expect, it } from "vitest";
import type { AppsConfig } from "../src/config.js";
import { decodeReferences, inspectImage, referenceLimits, type ReferenceLimits } from "../src/references.js";

// ---- synthetic images: just enough header for the sniffer ----

function png(width: number, height: number, extra = 0): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(extra)]);
}

function jpeg(width: number, height: number, opts: { sof?: number; app?: number } = {}): Buffer {
  const app = Buffer.alloc(2 + (opts.app ?? 14));
  app.writeUInt16BE(app.length, 0);
  const sof = Buffer.alloc(2 + 6 + 3);
  sof.writeUInt16BE(sof.length, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 1;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    app,
    Buffer.from([0xff, opts.sof ?? 0xc0]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function webpLossy(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBPVP8 ", 8, "latin1");
  b.writeUInt32LE(10, 16);
  b.set([0x9d, 0x01, 0x2a], 23);
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

function webpLossless(width: number, height: number): Buffer {
  const b = Buffer.alloc(25);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(17, 4);
  b.write("WEBPVP8L", 8, "latin1");
  b.writeUInt32LE(5, 16);
  b[20] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  b[21] = w & 0xff;
  b[22] = ((w >> 8) & 0x3f) | ((h & 0x3) << 6);
  b[23] = (h >> 2) & 0xff;
  b[24] = (h >> 10) & 0x0f;
  return b;
}

function webpExtended(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBPVP8X", 8, "latin1");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

const limits: ReferenceLimits = { maxCount: 3, maxBytes: 4096, maxPixels: 1_000_000, types: ["png", "jpeg", "webp"] };
const b64 = (b: Buffer) => b.toString("base64");

describe("inspectImage", () => {
  it("reads PNG dimensions", () => {
    expect(inspectImage(png(640, 480))).toEqual({ type: "png", width: 640, height: 480 });
  });

  it("reads JPEG dimensions behind an APP segment, for baseline and progressive frames", () => {
    expect(inspectImage(jpeg(321, 123))).toEqual({ type: "jpeg", width: 321, height: 123 });
    expect(inspectImage(jpeg(321, 123, { sof: 0xc2, app: 40 }))).toEqual({ type: "jpeg", width: 321, height: 123 });
  });

  it("reads WebP dimensions for lossy, lossless and extended files", () => {
    expect(inspectImage(webpLossy(100, 200))).toEqual({ type: "webp", width: 100, height: 200 });
    expect(inspectImage(webpLossless(1234, 4321))).toEqual({ type: "webp", width: 1234, height: 4321 });
    expect(inspectImage(webpExtended(5000, 3000))).toEqual({ type: "webp", width: 5000, height: 3000 });
  });

  const garbage: Record<string, Buffer> = {
    empty: Buffer.alloc(0),
    text: Buffer.from("hello world, definitely not an image"),
    gif: Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"),
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    png_truncated: png(10, 10).subarray(0, 20),
    png_wrong_chunk: Buffer.concat([png(10, 10).subarray(0, 12), Buffer.from("XXXX"), png(10, 10).subarray(16)]),
    png_zero_width: png(0, 10),
    jpeg_without_frame: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]),
    jpeg_segment_overruns: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]),
    jpeg_zero_height: jpeg(10, 0),
    riff_not_webp: Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(20)]),
    webp_truncated: webpLossy(1, 1).subarray(0, 24),
    webp_bad_sync: Buffer.concat([webpLossy(1, 1).subarray(0, 23), Buffer.from([0, 0, 0]), webpLossy(1, 1).subarray(26)]),
  };
  it.each(Object.keys(garbage))("returns null for %s", (name) => {
    expect(inspectImage(garbage[name]!)).toBeNull();
  });
});

describe("decodeReferences", () => {
  it("decodes images in order and reports their detected type", () => {
    const out = decodeReferences([b64(png(10, 20)), b64(jpeg(30, 40))], limits);
    expect(out.map((r) => [r.type, r.width, r.height])).toEqual([["png", 10, 20], ["jpeg", 30, 40]]);
    expect(out[0]!.bytes.equals(png(10, 20))).toBe(true);
  });

  const refused: Record<string, [string[], string]> = {
    none: [[], "no_references"],
    too_many: [[b64(png(1, 1)), b64(png(1, 1)), b64(png(1, 1)), b64(png(1, 1))], "too_many_references"],
    not_a_string: [[123 as unknown as string], "invalid_reference"],
    empty: [[""], "invalid_reference"],
    bad_alphabet: [["not base64!!"], "invalid_reference"],
    bad_padding: [[b64(png(1, 1)).slice(0, -1)], "invalid_reference"],
    data_url: [[`data:image/png;base64,${b64(png(1, 1))}`], "invalid_reference"],
    not_an_image: [[b64(Buffer.from("just some text, not an image"))], "invalid_reference"],
    gif: [[b64(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"))], "invalid_reference"],
    too_large: [[b64(png(10, 10, limits.maxBytes))], "reference_too_large"],
    too_many_pixels: [[b64(png(2000, 2000))], "reference_too_many_pixels"],
  };
  it.each(Object.keys(refused))("refuses %s", (name) => {
    const [items, code] = refused[name]!;
    expect(() => decodeReferences(items, limits)).toThrowError(expect.objectContaining({ name: "GenerateInputError", code }));
  });

  it("refuses a type that is detected but not allowed", () => {
    const onlyPng: ReferenceLimits = { ...limits, types: ["png"] };
    expect(decodeReferences([b64(png(5, 5))], onlyPng)).toHaveLength(1);
    expect(() => decodeReferences([b64(jpeg(5, 5))], onlyPng)).toThrowError(expect.objectContaining({ code: "reference_type_not_allowed" }));
  });

  it("names the offending reference by position, never by content", () => {
    try {
      decodeReferences([b64(png(1, 1)), "!!!"], limits);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("reference 2");
      expect((e as Error).message).not.toContain("!!!");
    }
  });

  it("rejects an oversized string before decoding it", () => {
    const huge = "A".repeat(Math.ceil(limits.maxBytes / 3) * 4 + 8);
    expect(() => decodeReferences([huge], limits)).toThrowError(expect.objectContaining({ code: "reference_too_large" }));
  });
});

describe("referenceLimits", () => {
  const cfg = (over: Record<string, unknown> = {}) =>
    ({ editMaxReferences: 4, editReferenceMaxBytes: 8_388_608, editReferenceMaxPixels: 16_777_216, editReferenceTypes: ["png", "jpeg", "webp"], ...over }) as unknown as AppsConfig;

  it("reads the limits from the configuration", () => {
    expect(referenceLimits(cfg())).toEqual({ maxCount: 4, maxBytes: 8_388_608, maxPixels: 16_777_216, types: ["png", "jpeg", "webp"] });
  });

  it("refuses an unknown type, an empty type list and non-positive numbers", () => {
    expect(() => referenceLimits(cfg({ editReferenceTypes: ["png", "gif"] }))).toThrow(/EDIT_REFERENCE_TYPES/);
    expect(() => referenceLimits(cfg({ editReferenceTypes: [] }))).toThrow(/EDIT_REFERENCE_TYPES/);
    expect(() => referenceLimits(cfg({ editMaxReferences: 0 }))).toThrow(/EDIT_MAX_REFERENCES/);
    expect(() => referenceLimits(cfg({ editReferenceMaxBytes: "8" }))).toThrow(/EDIT_REFERENCE_MAX_BYTES/);
  });
});
