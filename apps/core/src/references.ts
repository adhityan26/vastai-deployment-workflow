import type { AppsConfig } from "./config.js";
import { GenerateInputError } from "./profile.js";

// Reference images for edit requests. They arrive from a browser as base64 text inside a JSON
// body, so everything here treats them as hostile: the type comes from the magic bytes (never
// from a name or a declared content type), the size and the pixel count are bounded before the
// bytes are sent to the instance, and error messages name the position of a reference, never its
// content.

export type ReferenceType = "png" | "jpeg" | "webp";
const KNOWN_TYPES: readonly ReferenceType[] = ["png", "jpeg", "webp"];

export interface ReferenceLimits {
  readonly maxCount: number;
  /** Largest decoded size of one image. */
  readonly maxBytes: number;
  /** Largest width times height of one image. */
  readonly maxPixels: number;
  /** Largest width or height of one image. */
  readonly maxSide: number;
  readonly types: readonly ReferenceType[];
}

export interface ReferenceImage {
  readonly type: ReferenceType;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

export interface ImageInfo {
  type: ReferenceType;
  width: number;
  height: number;
  /**
   * Set when the file carries more than one frame (APNG, animated WebP, MPO or a JPEG with a second
   * frame header). ComfyUI LoadImage decodes every frame into one float32 batch, so the pixel limit
   * of the first frame says nothing about the memory such a file needs.
   */
  animated?: true;
}

// Protocol constants: file signatures and the base64 alphabet.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_DIMENSION = 0x7fffffff;

function dims(type: ReferenceType, width: number, height: number, animated = false): ImageInfo | null {
  const ok = (n: number) => Number.isInteger(n) && n > 0 && n <= MAX_DIMENSION;
  if (!ok(width) || !ok(height)) return null;
  return animated ? { type, width, height, animated: true } : { type, width, height };
}

/**
 * Walk the chunks after IHDR up to the first IDAT (where Pillow stops reading the header) and
 * report whether an APNG animation control chunk (acTL) appears there. Each step advances by at
 * least one chunk header, so the walk is linear in the file size.
 */
function pngHasAnimation(b: Buffer): boolean {
  let i = 8;
  while (i + 8 <= b.length) {
    const type = b.toString("latin1", i + 4, i + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    i += 12 + b.readUInt32BE(i);
  }
  return false;
}

function pngInfo(b: Buffer): ImageInfo | null {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  return dims("png", b.readUInt32BE(16), b.readUInt32BE(20), pngHasAnimation(b));
}

const MPF_ID = "MPF\0";

/**
 * Whether a byte after 0xFF is a marker defined by ITU T.81: TEM (0x01) and 0xC0..0xFE (SOFn, DHT,
 * JPG, DAC, RSTn, SOI, EOI, SOS, DQT, DNL, DRI, DHP, EXP, APPn, JPGn, COM). Anything else, 0x00
 * included, is data a decoder skips byte by byte until the next 0xFF, which a length-based walk
 * would not follow.
 */
function isJpegMarker(m: number): boolean {
  return m === 0x01 || (m >= 0xc0 && m <= 0xfe);
}

/**
 * Walk the marker segments up to the start of scan and read the frame size from the start-of-frame
 * (SOFn) segment. A second SOFn before the scan (Pillow would use the last one) or an APP2 "MPF"
 * segment (a multi-picture MPO file, which Pillow opens with every picture as a frame) marks the
 * file as animated. The walk fails closed: an undefined marker (FF 00 included), an end of image
 * before the scan, or no scan at all make the file unsupported, so the walk never resynchronises
 * differently from the decoder.
 */
function jpegInfo(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let frame: { width: number; height: number } | null = null;
  let multi = false;
  let scan = false;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (!isJpegMarker(marker)) return null;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9) return null; // end of image before any scan
    if (marker === 0xda) {
      scan = true;
      break;
    }
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 > b.length) return null;
      if (frame !== null) multi = true;
      frame = { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    } else if (marker === 0xe2 && length >= 6 && i + 8 <= b.length && b.toString("latin1", i + 4, i + 8) === MPF_ID) {
      multi = true;
    }
    i += 2 + length;
  }
  return frame === null || !scan ? null : dims("jpeg", frame.width, frame.height, multi);
}

/**
 * Report whether a WebP file is animated: the VP8X animation flag, or an ANIM / ANMF chunk anywhere
 * in the RIFF container. The walk is bounded by the buffer and advances by at least one chunk
 * header per step.
 */
function webpHasAnimation(b: Buffer): boolean {
  if (b.toString("latin1", 12, 16) === "VP8X" && (b[20]! & 0x02) !== 0) return true;
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString("latin1", i, i + 4);
    if (type === "ANIM" || type === "ANMF") return true;
    const size = b.readUInt32LE(i + 4);
    i += 8 + size + (size % 2);
  }
  return false;
}

function webpInfo(b: Buffer): ImageInfo | null {
  const info = webpFirstFrame(b);
  return info === null ? null : dims("webp", info.width, info.height, webpHasAnimation(b));
}

function webpFirstFrame(b: Buffer): ImageInfo | null {
  if (b.length < 25 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return dims("webp", b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const width = 1 + (b[21]! | ((b[22]! & 0x3f) << 8));
    const height = 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10));
    return dims("webp", width, height);
  }
  if (chunk === "VP8X") {
    if (b.length < 30) return null;
    return dims("webp", 1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
  }
  return null;
}

/** The type and size of a PNG, JPEG or WebP read from its header, or null for anything else. */
export function inspectImage(bytes: Buffer): ImageInfo | null {
  return pngInfo(bytes) ?? jpegInfo(bytes) ?? webpInfo(bytes);
}

function positive(cfg: AppsConfig, key: string, env: string): number {
  const v = cfg[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`${env} must be a positive integer`);
  return v;
}

/** The reference limits from the configuration; throws a plain Error naming the key when one is unusable. */
export function referenceLimits(cfg: AppsConfig): ReferenceLimits {
  const raw = cfg["editReferenceTypes"];
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((t) => (KNOWN_TYPES as readonly string[]).includes(t as string))) {
    throw new Error(`EDIT_REFERENCE_TYPES must list one or more of: ${KNOWN_TYPES.join(", ")}`);
  }
  return {
    maxCount: positive(cfg, "editMaxReferences", "EDIT_MAX_REFERENCES"),
    maxBytes: positive(cfg, "editReferenceMaxBytes", "EDIT_REFERENCE_MAX_BYTES"),
    maxPixels: positive(cfg, "editReferenceMaxPixels", "EDIT_REFERENCE_MAX_PIXELS"),
    maxSide: positive(cfg, "editReferenceMaxSide", "EDIT_REFERENCE_MAX_SIDE"),
    types: raw as ReferenceType[],
  };
}

/** Longest base64 text that can decode to `maxBytes` bytes. */
function maxEncodedLength(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4;
}

/**
 * Decode and validate the base64 references of an edit request, in order. Throws GenerateInputError
 * (fixed code, short message that names the reference by position) on the first problem; nothing
 * has been sent anywhere at that point.
 */
export function decodeReferences(items: unknown, limits: ReferenceLimits): ReferenceImage[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new GenerateInputError("no_references", "attach at least one reference image");
  }
  if (items.length > limits.maxCount) {
    throw new GenerateInputError("too_many_references", `at most ${limits.maxCount} reference images are allowed`);
  }
  return items.map((item, index): ReferenceImage => {
    const n = index + 1;
    if (typeof item !== "string" || item === "") {
      throw new GenerateInputError("invalid_reference", `reference ${n} is not valid image data`);
    }
    if (item.length > maxEncodedLength(limits.maxBytes)) {
      throw new GenerateInputError("reference_too_large", `reference ${n} is larger than ${limits.maxBytes} bytes`);
    }
    if (item.length % 4 !== 0 || !BASE64.test(item)) {
      throw new GenerateInputError("invalid_reference", `reference ${n} is not valid image data`);
    }
    const bytes = Buffer.from(item, "base64");
    if (bytes.length > limits.maxBytes) {
      throw new GenerateInputError("reference_too_large", `reference ${n} is larger than ${limits.maxBytes} bytes`);
    }
    const info = inspectImage(bytes);
    if (info === null) throw new GenerateInputError("invalid_reference", `reference ${n} is not a supported image`);
    if (!limits.types.includes(info.type)) {
      throw new GenerateInputError("reference_type_not_allowed", `reference ${n}: this image type is not accepted`);
    }
    if (info.animated) {
      throw new GenerateInputError("reference_animated", `reference ${n} is animated or has more than one frame`);
    }
    if (info.width > limits.maxSide || info.height > limits.maxSide) {
      throw new GenerateInputError("reference_side_too_long", `reference ${n} is wider or taller than ${limits.maxSide} pixels`);
    }
    if (info.width * info.height > limits.maxPixels) {
      throw new GenerateInputError("reference_too_many_pixels", `reference ${n} has more than ${limits.maxPixels} pixels`);
    }
    return { type: info.type, bytes, width: info.width, height: info.height };
  });
}
