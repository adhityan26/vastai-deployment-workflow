import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { JsonFileStore } from "./console.js";
import { ModelLinkError, parseModelLink, type ModelLink } from "./model-link.js";

// Extra LoRAs an admin adds from the page by a Hugging Face link (LORA_STORE_PATH, next to the registry). They join
// the profile's `extra_loras:` of their video family at request time. The store holds only what an admin gave and
// what the server derived: the checked link (repo, revision, path) and a file name the server chooses
// (xl_<id>_<side>.safetensors), never one from the link. The instance downloads the files (it checks the link again,
// every redirect, the size and the file's header) and reports their size and sha256: the web process never contacts
// the model host. A linked LoRA is NOT integrity-pinned or licence-checked.

export const LORA_SIDES = ["high", "low"] as const;
export type LoraSideName = (typeof LORA_SIDES)[number];
export type LoraMode = "text" | "image";

export interface LoraSide {
  /** The canonical resolve URL. */
  readonly url: string;
  readonly repo: string;
  readonly revision: string;
  /** The file's path inside the repo. */
  readonly path: string;
  /** The file name on the instance, chosen by the server. */
  readonly name: string;
}

export interface StoredLora {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** The video family it applies to. */
  readonly family: string;
  readonly modes: readonly LoraMode[];
  /** The default strength, 0 to 1. */
  readonly strength: number;
  /** Shown to admins only (the server enforces it). */
  readonly hidden: boolean;
  readonly trigger_words: string;
  readonly high?: LoraSide;
  readonly low?: LoraSide;
  readonly created_at: number;
}

export interface LoraInput {
  title: unknown;
  description?: unknown;
  family: unknown;
  modes: unknown;
  strength?: unknown;
  hidden?: unknown;
  trigger_words?: unknown;
  /** The links, one per expert branch (at least one). */
  high?: unknown;
  low?: unknown;
}

export type LoraPatch = Partial<Pick<StoredLora, "title" | "description" | "modes" | "strength" | "hidden" | "trigger_words">>;

export class LoraStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LoraStoreError";
    this.code = code;
  }
}

// Protocol and safety rules, not configuration.
const FILE_VERSION = 1;
const ID = /^[a-z0-9_]{3,32}$/;
const FAMILY = /^[a-z][a-z0-9_]{0,31}$/;
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 400;
const TRIGGER_MAX = 200;
const ENTRY_BYTES = 16 * 1024; // generous upper bound of one serialised entry
const FILE_SLACK_BYTES = 1024;
const INPUT_KEYS = new Set(["title", "description", "family", "modes", "strength", "hidden", "trigger_words", "high", "low"]);
const PATCH_KEYS = new Set(["title", "description", "modes", "strength", "hidden", "trigger_words"]);
const ID_BYTES = 4;
const NEW_ID_TRIES = 8;
const DEFAULT_STRENGTH = 1;

/** The digest of a wanted set, as the instance reports it: sha256 of the sorted "<name> <url>" lines. */
export function lorasDigest(items: readonly { name: string; url: string }[]): string {
  const lines = items.map((i) => `${i.name} ${i.url}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The file name of a stored LoRA's side on the instance (server-chosen; the instance accepts only this shape). */
export function loraFileName(id: string, side: LoraSideName): string {
  return `xl_${id}_${side}.safetensors`;
}

/** A LoRA link: the model-link rules exactly, and a .safetensors file only (never .gguf for a LoRA). */
export function parseLoraLink(url: unknown, hosts: readonly string[]): ModelLink {
  const link = parseModelLink(url, hosts);
  if (!link.name.endsWith(".safetensors")) throw new ModelLinkError("model_link_unsupported_type", "only .safetensors LoRA files can be linked");
  return link;
}

const bad = (message: string): LoraStoreError => new LoraStoreError("invalid_lora", message);

function oneLine(v: unknown, what: string, max: number, required: boolean): string {
  if (v === undefined && !required) return "";
  if (typeof v !== "string" || v.length > max || /[\r\n]/.test(v) || (required && v.trim() === "")) {
    throw bad(`${what} must be one line of at most ${max} characters${required ? " and not blank" : ""}`);
  }
  return v;
}

function modesOf(v: unknown): LoraMode[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((m) => m === "text" || m === "image") || new Set(v).size !== v.length) {
    throw bad("modes must list text and/or image, each once");
  }
  return v as LoraMode[];
}

function strengthOf(v: unknown): number {
  if (v === undefined) return DEFAULT_STRENGTH;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw bad("strength must be a number from 0 to 1");
  return v;
}

function hiddenOf(v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw bad("hidden must be true or false");
  return v;
}

function sideOf(link: ModelLink, id: string, side: LoraSideName): LoraSide {
  return { url: link.url, repo: link.repo, revision: link.revision, path: link.file, name: loraFileName(id, side) };
}

/** One stored entry, checked on load exactly as a new one would be (a tampered file is refused). */
function checkStored(raw: unknown, hosts: readonly string[]): StoredLora {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad("an entry is not an object");
  const r = raw as Record<string, unknown>;
  const id = r["id"];
  if (typeof id !== "string" || !ID.test(id)) throw bad("an entry has an invalid id");
  if (typeof r["family"] !== "string" || !FAMILY.test(r["family"])) throw bad("an entry has an invalid family");
  if (!Number.isSafeInteger(r["created_at"])) throw bad("an entry has an invalid created_at");
  const sides: Partial<Record<LoraSideName, LoraSide>> = {};
  for (const side of LORA_SIDES) {
    const s = r[side];
    if (s === undefined) continue;
    const link = parseLoraLink((s as { url?: unknown } | null)?.url, hosts);
    const expected = sideOf(link, id, side);
    if (JSON.stringify(s) !== JSON.stringify(expected)) throw bad("an entry's link or file name does not match");
    sides[side] = expected;
  }
  if (Object.keys(sides).length === 0) throw bad("an entry has no link");
  const known = new Set(["id", "title", "description", "family", "modes", "strength", "hidden", "trigger_words", "high", "low", "created_at"]);
  if (Object.keys(r).some((k) => !known.has(k))) throw bad("an entry has unknown members");
  if (typeof r["hidden"] !== "boolean" || typeof r["strength"] !== "number") throw bad("an entry has an invalid flag");
  return {
    id,
    title: oneLine(r["title"], "title", TITLE_MAX, true),
    description: oneLine(r["description"], "description", DESCRIPTION_MAX, false),
    family: r["family"],
    modes: modesOf(r["modes"]),
    strength: strengthOf(r["strength"]),
    hidden: r["hidden"],
    trigger_words: oneLine(r["trigger_words"], "trigger_words", TRIGGER_MAX, false),
    ...sides,
    created_at: r["created_at"] as number,
  };
}

export class LoraStore {
  private readonly file: JsonFileStore;
  private readonly path: string;
  private entries: StoredLora[] = [];
  /** False when the file exists but cannot be used: nothing is listed and nothing is written over it. */
  private usable = true;

  constructor(
    path: string,
    private readonly opts: { maxEntries: number; hosts: readonly string[]; now: () => number; newId?: () => string },
  ) {
    this.path = path;
    this.file = new JsonFileStore(path, opts.maxEntries * ENTRY_BYTES + FILE_SLACK_BYTES, "LORA_STORE_PATH");
    if (!existsSync(path)) return;
    try {
      const raw = this.file.load();
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad("not an object");
      const doc = raw as Record<string, unknown>;
      if (doc["version"] !== FILE_VERSION || !Array.isArray(doc["loras"])) throw bad("unknown version");
      const list = doc["loras"].map((e) => checkStored(e, opts.hosts));
      if (new Set(list.map((e) => e.id)).size !== list.length) throw bad("duplicate ids");
      this.entries = list;
    } catch {
      this.usable = false;
      this.entries = [];
    }
  }

  /** Every entry, hidden ones included (callers decide who may see them). */
  list(): StoredLora[] {
    return [...this.entries];
  }

  get(id: string): StoredLora | null {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  private writable(): void {
    if (!this.usable) {
      throw new LoraStoreError("lora_store_unavailable", `the LoRA store file ${this.path} cannot be read; fix or remove it first`);
    }
  }

  private save(next: StoredLora[]): void {
    this.file.save({ version: FILE_VERSION, loras: next });
    this.entries = next;
  }

  private newId(taken: ReadonlySet<string>): string {
    const make = this.opts.newId ?? (() => `lora_${randomBytes(ID_BYTES).toString("hex")}`);
    for (let i = 0; i < NEW_ID_TRIES; i++) {
      const id = make();
      if (ID.test(id) && !taken.has(id)) return id;
    }
    throw new LoraStoreError("lora_store_unavailable", "no free LoRA id");
  }

  /** Check and store a new entry; `taken` are ids that must not be reused (the profile's extra LoRA ids). */
  add(input: LoraInput, taken: readonly string[] = []): StoredLora {
    this.writable();
    if (typeof input !== "object" || input === null || Object.keys(input).some((k) => !INPUT_KEYS.has(k))) throw bad("unknown members");
    const title = oneLine(input.title, "title", TITLE_MAX, true);
    const description = oneLine(input.description, "description", DESCRIPTION_MAX, false);
    if (typeof input.family !== "string" || !FAMILY.test(input.family)) throw bad("family is not a video family id");
    const modes = modesOf(input.modes);
    const strength = strengthOf(input.strength);
    const hidden = hiddenOf(input.hidden);
    const trigger = oneLine(input.trigger_words, "trigger_words", TRIGGER_MAX, false);
    const links: Partial<Record<LoraSideName, ModelLink>> = {};
    for (const side of LORA_SIDES) {
      const v = input[side];
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
      links[side] = parseLoraLink(typeof v === "string" ? v.trim() : v, this.opts.hosts);
    }
    if (links.high === undefined && links.low === undefined) throw bad("give a link for the high and/or the low branch");
    if (links.high !== undefined && links.low !== undefined && links.high.url === links.low.url) {
      throw new ModelLinkError("model_link_name_clash", "the two links name the same file");
    }
    if (this.entries.length >= this.opts.maxEntries) {
      throw new LoraStoreError("lora_limit_reached", `at most ${this.opts.maxEntries} LoRAs can be added (LORA_MAX_ENTRIES)`);
    }
    const id = this.newId(new Set([...this.entries.map((e) => e.id), ...taken]));
    const entry: StoredLora = {
      id, title, description, family: input.family, modes, strength, hidden, trigger_words: trigger,
      ...(links.high ? { high: sideOf(links.high, id, "high") } : {}),
      ...(links.low ? { low: sideOf(links.low, id, "low") } : {}),
      created_at: this.opts.now(),
    };
    this.save([...this.entries, entry]);
    return entry;
  }

  /** Change the editable fields of an entry (its links and family are fixed: delete and add again to change them). */
  update(id: string, patch: LoraPatch): StoredLora {
    this.writable();
    const old = this.get(id);
    if (old === null) throw new LoraStoreError("unknown_lora", "no such LoRA");
    if (typeof patch !== "object" || patch === null || Object.keys(patch).some((k) => !PATCH_KEYS.has(k))) {
      throw bad("only title, description, modes, strength, hidden and trigger_words can be changed");
    }
    const next: StoredLora = {
      ...old,
      ...(patch.title !== undefined ? { title: oneLine(patch.title, "title", TITLE_MAX, true) } : {}),
      ...(patch.description !== undefined ? { description: oneLine(patch.description, "description", DESCRIPTION_MAX, false) } : {}),
      ...(patch.modes !== undefined ? { modes: modesOf(patch.modes) } : {}),
      ...(patch.strength !== undefined ? { strength: strengthOf(patch.strength) } : {}),
      ...(patch.hidden !== undefined ? { hidden: hiddenOf(patch.hidden) } : {}),
      ...(patch.trigger_words !== undefined ? { trigger_words: oneLine(patch.trigger_words, "trigger_words", TRIGGER_MAX, false) } : {}),
    };
    this.save(this.entries.map((e) => (e.id === id ? next : e)));
    return next;
  }

  remove(id: string): void {
    this.writable();
    if (this.get(id) === null) throw new LoraStoreError("unknown_lora", "no such LoRA");
    this.save(this.entries.filter((e) => e.id !== id));
  }
}
