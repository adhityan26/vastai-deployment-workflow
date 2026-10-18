import { createHash } from "node:crypto";
import { ConfigError, type AppsConfig } from "./config.js";
import type { ObjectStore } from "./object-store.js";
import { inspectImage, type ReferenceType } from "./references.js";

// The gallery: saved result images in an object store, with no database. Layout:
//   u/<owner>/<rts>-<jobId>-<index>      the image; its own Content-Type; metadata as below
// <owner> is the first 32 hex characters of SHA-256(identity subject), so a key never contains the
// raw subject. <rts> is 10^13 - createdMs, zero-padded to 13 digits, so a plain key-ordered listing
// is newest first. The public id of an image is `<owner>.<rts>.<jobId>.<index>`: the key is
// rebuilt from it and nothing else is accepted. Metadata values are URL-encoded (S3 metadata must be
// ASCII) and trimmed to a bounded size.

export type GalleryErrorCode = "quota_images" | "quota_bytes" | "invalid_image" | "invalid_id" | "invalid_input" | "forbidden" | "not_found";

/** A gallery rule was broken; the message is short and safe to show. */
export class GalleryError extends Error {
  readonly code: GalleryErrorCode;
  constructor(code: GalleryErrorCode, message: string) {
    super(message);
    this.name = "GalleryError";
    this.code = code;
  }
}

export interface GalleryLimits {
  maxImages: number;
  maxBytes: number;
  pageSize: number;
  adminScanMax: number;
  /** Largest single image the gallery will store or serve. */
  maxImageBytes: number;
}

export type GalleryKind = "generate" | "edit" | "upscale";

export interface Viewer {
  subject: string;
  admin: boolean;
}

export interface SaveInput {
  /** Identity subject of the owner. */
  owner: string;
  ownerName: string;
  jobId: string;
  index: number;
  createdMs: number;
  bytes: Buffer;
  contentType: string;
  kind: GalleryKind;
  prompt: string;
  label: string;
  /** How long the image took in seconds; optional (absent or null stores nothing). */
  seconds?: number | null;
}

export interface GalleryItem {
  id: string;
  createdMs: number;
  size: number;
  contentType: string;
  kind: GalleryKind;
  prompt: string;
  label: string;
  ownerName: string;
  /** True when the viewer owns it. */
  mine: boolean;
  /** How long the image took, or null (older images, or a value that is not a plain bounded number). */
  seconds: number | null;
}

// Protocol constants of the key scheme.
const OWNER_HEX = 32;
const RTS_DIGITS = 13;
const RTS_BASE = 10 ** RTS_DIGITS;
const KEY_ROOT = "u";
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ID_PATTERN = /^([0-9a-f]{32})\.(\d{13})\.([A-Za-z0-9_-]{1,128})\.(\d{1,3})$/;
const MAX_INDEX = 999;
const TYPES: Record<string, ReferenceType> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };
// S3 user metadata is limited to about 2 KB in total; these budgets (encoded characters) stay well inside.
const PROMPT_BUDGET = 900;
const LABEL_BUDGET = 200;
const NAME_BUDGET = 200;
const LIST_PAGE = 1000;
// `seconds` metadata: a plain decimal with at most one fraction digit, bounded to a day.
const SECONDS_TEXT = /^[0-9]{1,5}(\.[0-9])?$/;
const SECONDS_MAX = 86_400;

/** The stored text for a duration, or null when it is not a plausible number of seconds. */
function secondsText(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > SECONDS_MAX) return null;
  return String(Math.round(value * 10) / 10);
}

/** A stored duration back as a number; anything else (missing, tampered) is null. */
function parseSeconds(text: string | undefined): number | null {
  if (text === undefined || !SECONDS_TEXT.test(text)) return null;
  const value = Number(text);
  return value <= SECONDS_MAX ? value : null;
}

function positive(cfg: AppsConfig, key: string, env: string): number {
  const v = cfg[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new ConfigError([`${env} must be a positive integer`]);
  return v;
}

/** The gallery limits from the configuration; throws a ConfigError naming the key (never a value) when one is unusable. */
export function galleryLimits(cfg: AppsConfig): GalleryLimits {
  return {
    maxImages: positive(cfg, "galleryMaxImagesPerUser", "GALLERY_MAX_IMAGES_PER_USER"),
    maxBytes: positive(cfg, "galleryMaxBytesPerUser", "GALLERY_MAX_BYTES_PER_USER"),
    pageSize: positive(cfg, "galleryPageSize", "GALLERY_PAGE_SIZE"),
    adminScanMax: positive(cfg, "galleryAdminScanMax", "GALLERY_ADMIN_SCAN_MAX"),
    maxImageBytes: positive(cfg, "webImageMaxBytes", "WEB_IMAGE_MAX_BYTES"),
  };
}

/** URL-encode `value`, dropping trailing characters until the encoded text fits the budget. */
function fitEncoded(value: string, budget: number): string {
  const chars = Array.from(value);
  for (;;) {
    const encoded = encodeURIComponent(chars.join(""));
    if (encoded.length <= budget || chars.length === 0) return encoded;
    chars.length = Math.max(0, Math.min(chars.length - 1, Math.floor((chars.length * budget) / encoded.length)));
  }
}

function decoded(value: string | undefined): string {
  if (value === undefined) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

interface ParsedId {
  owner: string;
  rts: string;
  jobId: string;
  index: number;
  key: string;
  /** Orders images of different owners by time: newest first, then by owner and job. */
  sortKey: string;
}

function parseId(id: unknown): ParsedId {
  const m = typeof id === "string" ? ID_PATTERN.exec(id) : null;
  if (m === null) throw new GalleryError("invalid_id", "not a valid image id");
  const [, owner, rts, jobId, indexText] = m as unknown as [string, string, string, string, string];
  const index = Number(indexText);
  if (index > MAX_INDEX) throw new GalleryError("invalid_id", "not a valid image id");
  return { owner, rts, jobId, index, key: `${KEY_ROOT}/${owner}/${rts}-${jobId}-${index}`, sortKey: `${rts}.${owner}.${jobId}.${index}` };
}

/** The id for a stored key, or null when the key is not one of ours. */
function idOfKey(key: string): ParsedId | null {
  const m = /^u\/([0-9a-f]{32})\/(\d{13})-([A-Za-z0-9_-]{1,128})-(\d{1,3})$/.exec(key);
  if (m === null) return null;
  try {
    return parseId(`${m[1]}.${m[2]}.${m[3]}.${m[4]}`);
  } catch {
    return null;
  }
}

const idOf = (p: ParsedId): string => `${p.owner}.${p.rts}.${p.jobId}.${p.index}`;

/** At most `slots` tasks at a time; the others wait in order (they hold no image while waiting). */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly slots: number) {
    if (!Number.isInteger(slots) || slots < 1) throw new Error("a semaphore needs at least one slot");
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.slots) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next !== undefined) next(); // the slot passes straight to the next task
      else this.active--;
    }
  }
}

export class Gallery {
  // Per-owner lock: the quota check and the write of one owner's saves never interleave (in this
  // process; the web service is the only writer of the bucket).
  private readonly ownerLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: ObjectStore,
    private readonly limits: GalleryLimits,
  ) {}

  /** Stable, non-reversible owner path segment for an identity subject. */
  ownerKey(subject: string): string {
    return createHash("sha256").update(subject).digest("hex").slice(0, OWNER_HEX);
  }

  private mayTouch(viewer: Viewer, p: ParsedId): boolean {
    return viewer.admin || p.owner === this.ownerKey(viewer.subject);
  }

  /** Save one image. Saving the same job image again is a no-op that reports created=false. */
  async save(input: SaveInput): Promise<{ id: string; created: boolean }> {
    if (typeof input.owner !== "string" || input.owner === "") throw new GalleryError("invalid_input", "an owner is required");
    if (!JOB_ID.test(input.jobId)) throw new GalleryError("invalid_input", "not a valid job id");
    if (!Number.isInteger(input.index) || input.index < 0 || input.index > MAX_INDEX) throw new GalleryError("invalid_input", "not a valid image index");
    if (!Number.isInteger(input.createdMs) || input.createdMs <= 0 || input.createdMs >= RTS_BASE) throw new GalleryError("invalid_input", "not a valid time");
    const type = TYPES[input.contentType];
    const info = inspectImage(input.bytes);
    if (type === undefined || info === null || info.type !== type) throw new GalleryError("invalid_image", "the file is not a PNG, JPEG or WebP image");
    if (input.bytes.length > this.limits.maxImageBytes) throw new GalleryError("invalid_image", "the image is larger than allowed");

    const owner = this.ownerKey(input.owner);
    const rts = String(RTS_BASE - input.createdMs).padStart(RTS_DIGITS, "0");
    const parsed = parseId(`${owner}.${rts}.${input.jobId}.${input.index}`);
    return this.locked(owner, () => this.store_(input, owner, parsed));
  }

  /** Run `fn` after every earlier task of the same owner has finished. */
  private locked<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.ownerLocks.get(owner) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.ownerLocks.set(owner, tail);
    void tail.then(() => {
      if (this.ownerLocks.get(owner) === tail) this.ownerLocks.delete(owner);
    });
    return run;
  }

  private async store_(input: SaveInput, owner: string, parsed: ParsedId): Promise<{ id: string; created: boolean }> {
    if ((await this.store.head(parsed.key)) !== null) return { id: idOf(parsed), created: false };

    // Quota: what this owner already keeps (listing stops as soon as a limit is reached).
    let images = 0;
    let bytes = 0;
    let after: string | undefined;
    for (;;) {
      const page = await this.store.list(`${KEY_ROOT}/${owner}/`, { maxKeys: LIST_PAGE, ...(after ? { startAfter: after } : {}) });
      for (const e of page.entries) {
        images += 1;
        bytes += e.size;
      }
      if (images >= this.limits.maxImages) throw new GalleryError("quota_images", `the gallery is full (${this.limits.maxImages} images)`);
      if (bytes + input.bytes.length > this.limits.maxBytes) throw new GalleryError("quota_bytes", "the gallery storage limit is reached");
      if (!page.truncated || page.entries.length === 0) break;
      after = page.entries[page.entries.length - 1]!.key;
    }

    const seconds = secondsText(input.seconds);
    await this.store.put(parsed.key, input.bytes, input.contentType, {
      kind: input.kind,
      prompt: fitEncoded(input.prompt, PROMPT_BUDGET),
      label: fitEncoded(input.label, LABEL_BUDGET),
      "owner-name": fitEncoded(input.ownerName, NAME_BUDGET),
      ...(seconds === null ? {} : { seconds }),
    });
    return { id: idOf(parsed), created: true };
  }

  /** One page of images, newest first. `scope: "all"` is for admins. */
  async list(viewer: Viewer, opts: { scope: "mine" | "all"; cursor?: string }): Promise<{ items: GalleryItem[]; next: string | null }> {
    if (opts.scope === "all" && !viewer.admin) throw new GalleryError("forbidden", "only an admin can list everyone's images");
    const mine = this.ownerKey(viewer.subject);
    const cursor = opts.cursor === undefined ? null : parseId(opts.cursor);
    if (cursor !== null && opts.scope === "mine" && cursor.owner !== mine) throw new GalleryError("forbidden", "that page belongs to someone else");

    const picked: ParsedId[] = [];
    let more = false;
    if (opts.scope === "mine") {
      const page = await this.store.list(`${KEY_ROOT}/${mine}/`, { maxKeys: this.limits.pageSize + 1, ...(cursor ? { startAfter: cursor.key } : {}) });
      for (const e of page.entries) {
        const p = idOfKey(e.key);
        if (p !== null) picked.push(p);
      }
      more = picked.length > this.limits.pageSize;
    } else {
      picked.push(...(await this.newestOfEveryone(cursor)));
      more = picked.length > this.limits.pageSize;
    }
    const page = picked.slice(0, this.limits.pageSize);

    const items = await Promise.all(
      page.map(async (p): Promise<GalleryItem | null> => {
        const head = await this.store.head(p.key);
        if (head === null) return null; // deleted since the listing
        const stored = head.metadata["kind"];
        const kind: GalleryKind = stored === "edit" || stored === "upscale" ? stored : "generate";
        return {
          id: idOf(p),
          createdMs: RTS_BASE - Number(p.rts),
          size: head.size,
          contentType: head.contentType,
          kind,
          prompt: decoded(head.metadata["prompt"]),
          label: decoded(head.metadata["label"]),
          ownerName: decoded(head.metadata["owner-name"]),
          mine: p.owner === mine,
          seconds: parseSeconds(head.metadata["seconds"]),
        };
      }),
    );
    const last = page[page.length - 1];
    return { items: items.filter((i): i is GalleryItem => i !== null), next: more && last ? idOf(last) : null };
  }

  /**
   * The next page+1 images after `cursor` across every member, newest first: the member folders are
   * listed, each folder gives its own first page+1 keys after the cursor (one folder is already newest
   * first), and those are merged. A page reads about GALLERY_ADMIN_SCAN_MAX keys at most (folders
   * included): each folder costs page+2, so floor(scan / (page + 2)) folders are merged and members
   * past them (in folder order, a hash) are left out of the view.
   */
  private async newestOfEveryone(cursor: ParsedId | null): Promise<ParsedId[]> {
    const want = this.limits.pageSize + 1;
    const maxFolders = Math.max(1, Math.floor(this.limits.adminScanMax / (want + 1)));
    const folders: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.store.listPrefixes(`${KEY_ROOT}/`, { maxKeys: Math.min(LIST_PAGE, maxFolders - folders.length), ...(after ? { startAfter: after } : {}) });
      folders.push(...page.prefixes.filter((f) => /^u\/[0-9a-f]{32}\/$/.test(f)));
      if (!page.truncated || page.prefixes.length === 0 || folders.length >= maxFolders) break;
      // Every key in a folder starts with a digit, which sorts before "~": this skips the whole folder.
      after = `${page.prefixes[page.prefixes.length - 1]!}~`;
    }
    const perFolder = await Promise.all(
      folders.slice(0, maxFolders).map(async (folder) => {
        const got: ParsedId[] = [];
        // From the cursor's time on (same-millisecond keys are filtered by the full sort key).
        let start: string | undefined = cursor === null ? undefined : `${folder}${cursor.rts}`;
        for (let round = 0; round < 2 && got.length < want; round++) {
          const page = await this.store.list(folder, { maxKeys: want, ...(start ? { startAfter: start } : {}) });
          for (const e of page.entries) {
            const p = idOfKey(e.key);
            if (p !== null && (cursor === null || p.sortKey > cursor.sortKey)) got.push(p);
          }
          if (!page.truncated || page.entries.length === 0) break;
          start = page.entries[page.entries.length - 1]!.key;
        }
        return got.slice(0, want);
      }),
    );
    return perFolder.flat().sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)).slice(0, want);
  }

  /** The stored image. Someone else's image looks exactly like a missing one. */
  async read(viewer: Viewer, id: string): Promise<{ bytes: Buffer; contentType: string }> {
    const p = parseId(id);
    if (!this.mayTouch(viewer, p)) throw new GalleryError("not_found", "no such image");
    const got = await this.store.get(p.key, this.limits.maxImageBytes);
    if (got === null) throw new GalleryError("not_found", "no such image");
    const type = TYPES[got.contentType];
    if (type === undefined || inspectImage(got.bytes)?.type !== type) throw new GalleryError("invalid_image", "the stored file is not an image");
    return got;
  }

  /** Delete an image of your own (any, for an admin). Deleting a missing image succeeds. */
  async remove(viewer: Viewer, id: string): Promise<void> {
    const p = parseId(id);
    if (!this.mayTouch(viewer, p)) throw new GalleryError("not_found", "no such image");
    await this.store.delete(p.key);
  }
}
