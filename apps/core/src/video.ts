import { GenerateInputError, ProfileError } from "./profile-errors.js";
import { isLinkedModelName, loaderFor } from "./model-link.js";
import { isPlainFileName, landsIn, parseSizeList, type ComfyPrompt, type ModelEntry, type ParamRef, type SizeSpec } from "./profile.js";

// Video mode: text to video, or image to video with exactly one start image, through one model and native
// ComfyUI nodes. Declared in the profile's `video:` section; OFF until VIDEO_ENABLED=true (its model files must be
// pinned first). The section is validated even while it is off; the workflow template is checked against it at
// startup (checkVideoTemplate), so a mismatch stops the web app instead of failing a job.

export const VIDEO_PARAM_KEYS = ["prompt", "seed", "width", "height", "length", "fps"] as const;
type VideoParamKey = (typeof VIDEO_PARAM_KEYS)[number];

export interface VideoDuration {
  readonly name: string;
  /** Frames the model makes (4n+1: the latent packs four frames per step, plus the first). */
  readonly frames: number;
  /** Whole seconds at the section's fps, for the page. */
  readonly seconds: number;
  /** Longer than the model was trained for: the page labels it and warns (absent for a normal duration). */
  readonly experimental?: true;
}

export interface VideoModel {
  /** The plain file name the workflow's loader reads. */
  readonly file: string;
  /** The ComfyUI folder its `models:` entry must download into. */
  readonly dest: string;
}

/** An input the web app sets on every job of a mode (a recipe value the page does not offer, like LoRA strength). */
export interface VideoFixed {
  readonly node: string;
  readonly input: string;
  readonly value: number;
}

/** A diffusion model file of a mode an admin may replace with a link (`slot` names it, like high or low). */
export interface VideoExpert {
  readonly slot: string;
  readonly file: string;
}

/** An optional extra LoRA of a family (profile `extra_loras:`): its files per expert branch, by slot. */
export interface VideoExtraLora {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly modes: readonly ("text" | "image")[];
  /** The LoRA file per expert slot (`high` and/or `low`); a branch without one gets no extra LoRA node. */
  readonly files: Readonly<Record<string, string>>;
  /** The default strength (0 to 1). */
  readonly strength: number;
  readonly triggerWords: string;
}

export interface VideoSpec {
  readonly workflow: string;
  readonly models: readonly VideoModel[];
  readonly params: Readonly<Record<VideoParamKey, ParamRef>>;
  /**
   * The input of the latent node that takes the optional start image (a LoadImage node is added for it); null for
   * a family's text mode, which takes no start image.
   */
  readonly startImage: ParamRef | null;
  /** The SaveVideo node whose files are the result. */
  readonly outputNode: string;
  readonly fps: number;
  readonly sizes: readonly SizeSpec[];
  readonly durations: readonly VideoDuration[];
  /** The expert slots a link may replace, all together (empty for the base section: it has its one diffusion slot). */
  readonly experts: readonly VideoExpert[];
  /** Inputs set on every job. */
  readonly fixed: readonly VideoFixed[];
  /** Per expert slot, the node after which an extra LoRA joins that branch (empty without extra LoRAs). */
  readonly loraAfter: Readonly<Record<string, string>>;
  /** The family's extra LoRAs (each says which modes it is for); empty for the base section. */
  readonly extraLoras: readonly VideoExtraLora[];
}

/**
 * A video model family: the base section (`video:`, one workflow for both modes) or one of `video_families:`
 * (a workflow per mode). Each is switched on separately: the base by VIDEO_ENABLED, the others by VIDEO_FAMILIES too.
 */
export interface VideoFamily {
  readonly id: string;
  readonly title: string;
  /** True for the `video:` section. */
  readonly base: boolean;
  readonly models: readonly VideoModel[];
  readonly fps: number;
  readonly sizes: readonly SizeSpec[];
  readonly durations: readonly VideoDuration[];
  /** Text to video (no start image). */
  readonly text: VideoSpec;
  /** Image to video (exactly one start image). For the base section both are the same spec. */
  readonly image: VideoSpec;
  /** The optional extra LoRAs (empty for the base section). */
  readonly extraLoras: readonly VideoExtraLora[];
}

export interface VideoInput {
  prompt: string;
  seed: number;
  size: string;
  duration: string;
  /** The uploaded start image (image to video); absent for text to video. */
  startImage?: string;
  /**
   * A linked diffusion model the instance has in place of the pinned one (its plain file name, as the instance
   * reports it): every input of the workflow that names the pinned diffusion file names this one instead.
   */
  diffusionFile?: string;
  /**
   * Linked experts of a family mode by slot (their plain file names, as the instance reports them): each replaces
   * its pinned expert file. All of the mode's slots or none.
   */
  links?: Readonly<Record<string, string>>;
  /** An extra LoRA of the family (its id from the profile) and the strength to use (0 to 1). */
  extraLora?: { id: string; strength: number };
}

/** The node id prefix of an extra LoRA node the web app adds (one per branch: video_lora_<slot>). */
export const VIDEO_LORA_NODE_PREFIX = "video_lora_";
const LORA_CLASS = "LoraLoaderModelOnly";
const LORA_FOLDER = "models/loras";

/** The ComfyUI folder of the diffusion model slot (the one a link may replace). */
export const DIFFUSION_FOLDER = "models/diffusion_models";

/** Node id of the LoadImage node the web app adds for a start image. */
export const VIDEO_START_NODE = "video_start";
/** The class of the node that makes the result file (its history output lists the file). */
export const VIDEO_OUTPUT_CLASS = "SaveVideo";
const START_IMAGE_CLASS = "LoadImage";
const START_IMAGE_INPUT = "image";

// Protocol and safety rules, not configuration.
const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,100}\.json$/;
const NODE_ID = /^[A-Za-z0-9_]{1,32}$/;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const NODE_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const MODEL_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_DEST = /^models\/[a-z0-9_]+\/?$/;
const NAME_MAX = 40;
const KEYS = new Set(["id", "title", "workflow", "models", "node_classes", "params", "start_image", "output_node", "fps", "sizes", "durations"]);
const FAMILY_KEYS = new Set(["id", "title", "models", "node_classes", "fps", "sizes", "durations", "text", "image", "extra_loras"]);
const MODE_KEYS = new Set(["workflow", "params", "start_image", "output_node", "experts", "fixed", "lora_after"]);
const EXTRA_LORA_KEYS = new Set(["id", "title", "description", "modes", "high", "low", "strength", "trigger_words"]);
const EXTRA_LORA_SIDES = ["high", "low"] as const;
const MAX_EXTRA_LORAS = 8;
const DESCRIPTION_MAX = 300;
const TRIGGER_WORDS_MAX = 300;
const DEFAULT_EXTRA_LORA_STRENGTH = 0.6;
const EXPERT_KEYS = new Set(["slot", "file"]);
const FIXED_KEYS = new Set(["node", "input", "value"]);
const FAMILY_ID = /^[a-z][a-z0-9_]{0,31}$/;
const EXPERT_SLOT = /^[a-z][a-z0-9]{0,15}$/;
const DEFAULT_BASE_ID = "standard";
const DEFAULT_BASE_TITLE = "Standard";
const MAX_FAMILIES = 8;
const MAX_FAMILY_MODELS = 16;
const MIN_EXPERTS = 2;
const MAX_EXPERTS = 4;
const MAX_FIXED = 16;
// Fixed values are recipe numbers (LoRA strength, sampling shift): small, never a size or a step count of thousands.
const MAX_FIXED_ABS = 1000;
const DURATION_KEYS = new Set(["name", "frames", "experimental"]);
const MAX_MODELS = 8;
const MAX_FPS = 60;
const MIN_FRAMES = 5;
// About 12 s at 24 fps (12 x 24 + 1), the longest experimental duration; longer clips need far more VRAM and time
// than a 24 GB card is known to give.
const MAX_FRAMES = 289;
const FRAMES_PER_LATENT = 4;
const MAX_SIDE = 1920;

const mapping = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ProfileError(`${what} must be a mapping`);
  return v as Record<string, unknown>;
};

function ref(raw: unknown, what: string): ParamRef {
  const m = mapping(raw, what);
  const node = m["node"];
  const input = m["input"];
  if (typeof node !== "string" || !NODE_ID.test(node)) throw new ProfileError(`${what} node is not a plain node id`);
  if (typeof input !== "string" || !INPUT_NAME.test(input)) throw new ProfileError(`${what} input is not a plain input name`);
  if (Object.keys(m).some((k) => k !== "node" && k !== "input")) throw new ProfileError(`${what} has unknown keys`);
  return { node, input };
}

function plainName(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "" || v.length > NAME_MAX || /[\r\n]/.test(v)) {
    throw new ProfileError(`${what} must be a non-empty one-line name of at most ${NAME_MAX} characters`);
  }
  return v;
}


function parseModelList(raw: unknown, what: string, max: number): VideoModel[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
    throw new ProfileError(`${what} models must be a non-empty list of at most ${max} entries`);
  }
  return raw.map((item) => {
    const e = mapping(item, `${what} model`);
    const { file, dest } = e;
    if (typeof file !== "string" || !MODEL_FILE.test(file)) throw new ProfileError(`${what} model file must be one plain file name`);
    if (typeof dest !== "string" || !MODEL_DEST.test(dest)) throw new ProfileError(`${what} model ${file}: dest must be one ComfyUI model folder like models/vae/`);
    return { file, dest: dest.replace(/\/+$/, "") };
  });
}

function checkNodeClasses(raw: unknown, what: string): void {
  if (!Array.isArray(raw) || !raw.every((c) => typeof c === "string" && NODE_CLASS.test(c))) {
    throw new ProfileError(`${what} node_classes must be a list of plain node class names`);
  }
}

/** The mapped inputs, each on its own node input; `taken` collects them. */
function parseParams(raw: unknown, what: string, taken: Set<string>): Record<VideoParamKey, ParamRef> {
  const paramsRaw = mapping(raw, `${what} params`);
  const extra = Object.keys(paramsRaw).filter((k) => !(VIDEO_PARAM_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) throw new ProfileError(`${what} params has unknown keys: ${extra.sort().join(", ")}`);
  const params = {} as Record<VideoParamKey, ParamRef>;
  for (const key of VIDEO_PARAM_KEYS) {
    if (!(key in paramsRaw)) throw new ProfileError(`${what} params is missing ${key}`);
    params[key] = ref(paramsRaw[key], `${what} param ${key}`);
    const at = `${params[key].node}/${params[key].input}`;
    if (taken.has(at)) throw new ProfileError(`${what} param ${key} uses node ${params[key].node} input ${params[key].input}, which another param already sets`);
    taken.add(at);
  }
  return params;
}

function parseOutputNode(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !NODE_ID.test(raw)) throw new ProfileError(`${what} output_node must be a plain node id`);
  return raw;
}

function parseFps(raw: unknown, what: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_FPS) {
    throw new ProfileError(`${what} fps must be a whole number from 1 to ${MAX_FPS}`);
  }
  return raw;
}

function parseVideoSizes(raw: unknown, what: string): SizeSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ProfileError(`${what} sizes must be a non-empty list`);
  const sizes = parseSizeList(raw);
  for (const z of sizes) {
    if (z.width > MAX_SIDE || z.height > MAX_SIDE) throw new ProfileError(`${what} size ${z.name} must be at most ${MAX_SIDE} pixels on each side`);
  }
  return sizes;
}

function parseDurations(raw: unknown, fps: number, what: string): VideoDuration[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ProfileError(`${what} durations must be a non-empty list`);
  const durations: VideoDuration[] = raw.map((item) => {
    const d = mapping(item, `${what} duration`);
    const keys = Object.keys(d).filter((k) => !DURATION_KEYS.has(k));
    if (keys.length > 0) throw new ProfileError(`a ${what} duration has unknown keys: ${keys.sort().join(", ")}`);
    const name = plainName(d["name"], `${what} duration name`);
    const frames = d["frames"];
    if (typeof frames !== "number" || !Number.isInteger(frames) || frames < MIN_FRAMES || frames > MAX_FRAMES || (frames - 1) % FRAMES_PER_LATENT !== 0) {
      throw new ProfileError(`${what} duration ${name}: frames must be 4n+1 between ${MIN_FRAMES} and ${MAX_FRAMES}`);
    }
    const experimental = d["experimental"];
    if (experimental !== undefined && experimental !== true) throw new ProfileError(`${what} duration ${name}: experimental must be true (or left out)`);
    return { name, frames, seconds: Math.round(frames / fps), ...(experimental === true ? { experimental: true as const } : {}) };
  });
  if (new Set(durations.map((d) => d.name)).size !== durations.length) throw new ProfileError(`${what} duration names must be unique`);
  return durations;
}

/** Every file must be a `models` entry (pinned) that downloads into its folder. */
function checkPinned(files: readonly VideoModel[], models: readonly ModelEntry[], what: string): void {
  for (const f of files) {
    const entry = models.find((e) => e.file.split("/").pop() === f.file);
    if (entry === undefined) throw new ProfileError(`${what} model ${f.file} is not listed in models (pin it with scripts/pin_model.py)`);
    if (!landsIn(entry, f.dest)) throw new ProfileError(`${what}: the models entry for ${f.file} must have dest ${f.dest}/`);
  }
}

function parseId(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !FAMILY_ID.test(raw)) throw new ProfileError(`${what} id must be lower case letters, digits and _ (at most 32)`);
  return raw;
}

/** The base section's family id and title (both optional). */
export function videoBaseIdentity(raw: unknown): { id: string; title: string } {
  const m = raw === undefined || raw === null ? {} : mapping(raw, "video");
  return {
    id: m["id"] === undefined ? DEFAULT_BASE_ID : parseId(m["id"], "video"),
    title: m["title"] === undefined ? DEFAULT_BASE_TITLE : plainName(m["title"], "video title"),
  };
}

/**
 * The video section when video is on (`enabled`: VIDEO_ENABLED), else null. Everything is validated either way. The
 * profile itself has no switch: a section with `enabled:` is refused, so nobody believes it does something.
 */
export function parseVideo(raw: unknown, models: readonly ModelEntry[], enabled = false): VideoSpec | null {
  if (raw === undefined || raw === null) return null;
  const m = mapping(raw, "video");
  if ("enabled" in m) throw new ProfileError("video `enabled:` is not read from the profile any more: remove it and set VIDEO_ENABLED=true in .env");
  const unknown = Object.keys(m).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) throw new ProfileError(`video has unknown keys: ${unknown.sort().join(", ")}`);
  videoBaseIdentity(m);
  const workflow = m["workflow"];
  if (typeof workflow !== "string" || !WORKFLOW_NAME.test(workflow)) throw new ProfileError("video workflow is not a valid workflow name");
  const files = parseModelList(m["models"], "video", MAX_MODELS);
  checkNodeClasses(m["node_classes"], "video");
  const taken = new Set<string>();
  const params = parseParams(m["params"], "video", taken);
  const startImage = ref(m["start_image"], "video start_image");
  if (taken.has(`${startImage.node}/${startImage.input}`)) throw new ProfileError("video start_image uses an input a param already sets");
  const outputNode = parseOutputNode(m["output_node"], "video");
  const fps = parseFps(m["fps"], "video");
  const sizes = parseVideoSizes(m["sizes"], "video");
  const durations = parseDurations(m["durations"], fps, "video");
  const spec: VideoSpec = { workflow, models: files, params, startImage, outputNode, fps, sizes, durations, experts: [], fixed: [], loraAfter: {}, extraLoras: [] };
  if (!enabled) return null;
  checkPinned(files, models, "video");
  return spec;
}

function parseMode(
  raw: unknown,
  what: string,
  withStart: boolean,
  family: { models: readonly VideoModel[]; fps: number; sizes: readonly SizeSpec[]; durations: readonly VideoDuration[]; extraLoras: readonly VideoExtraLora[] },
): VideoSpec {
  const m = mapping(raw, what);
  const unknown = Object.keys(m).filter((k) => !MODE_KEYS.has(k));
  if (unknown.length > 0) throw new ProfileError(`${what} has unknown keys: ${unknown.sort().join(", ")}`);
  const workflow = m["workflow"];
  if (typeof workflow !== "string" || !WORKFLOW_NAME.test(workflow)) throw new ProfileError(`${what} workflow is not a valid workflow name`);
  const taken = new Set<string>();
  const params = parseParams(m["params"], what, taken);
  let startImage: ParamRef | null = null;
  if (withStart) {
    startImage = ref(m["start_image"], `${what} start_image`);
    if (taken.has(`${startImage.node}/${startImage.input}`)) throw new ProfileError(`${what} start_image uses an input a param already sets`);
    taken.add(`${startImage.node}/${startImage.input}`);
  } else if ("start_image" in m) {
    throw new ProfileError(`${what} takes no start image (start_image belongs to the image mode)`);
  }
  const outputNode = parseOutputNode(m["output_node"], what);

  const expertsRaw = m["experts"];
  if (!Array.isArray(expertsRaw) || expertsRaw.length < MIN_EXPERTS || expertsRaw.length > MAX_EXPERTS) {
    throw new ProfileError(`${what} experts must list ${MIN_EXPERTS} to ${MAX_EXPERTS} diffusion models`);
  }
  const experts: VideoExpert[] = expertsRaw.map((item) => {
    const e = mapping(item, `${what} expert`);
    if (Object.keys(e).some((k) => !EXPERT_KEYS.has(k))) throw new ProfileError(`a ${what} expert has unknown keys`);
    const slot = e["slot"];
    const file = e["file"];
    if (typeof slot !== "string" || !EXPERT_SLOT.test(slot)) throw new ProfileError(`${what} expert slot must be a short lower case name`);
    const model = family.models.find((x) => x.file === file);
    if (model === undefined) throw new ProfileError(`${what} expert ${slot} must name one of the family's models`);
    if (model.dest !== DIFFUSION_FOLDER) throw new ProfileError(`${what} expert ${slot} must be a model with dest ${DIFFUSION_FOLDER}/`);
    return { slot, file: model.file };
  });
  if (new Set(experts.map((e) => e.slot)).size !== experts.length) throw new ProfileError(`${what} expert slots must be unique`);
  if (new Set(experts.map((e) => e.file)).size !== experts.length) throw new ProfileError(`${what} experts must be different files`);

  const fixedRaw = m["fixed"] ?? [];
  if (!Array.isArray(fixedRaw) || fixedRaw.length > MAX_FIXED) throw new ProfileError(`${what} fixed must be a list of at most ${MAX_FIXED} entries`);
  const fixed: VideoFixed[] = fixedRaw.map((item) => {
    const f = mapping(item, `${what} fixed`);
    if (Object.keys(f).some((k) => !FIXED_KEYS.has(k))) throw new ProfileError(`a ${what} fixed entry has unknown keys`);
    const at = ref({ node: f["node"], input: f["input"] }, `${what} fixed`);
    const value = f["value"];
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_FIXED_ABS) {
      throw new ProfileError(`${what} fixed node ${at.node} input ${at.input}: value must be a number of at most ${MAX_FIXED_ABS}`);
    }
    const key = `${at.node}/${at.input}`;
    if (taken.has(key)) throw new ProfileError(`${what} fixed node ${at.node} input ${at.input} is set twice`);
    taken.add(key);
    return { ...at, value };
  });
  let loraAfter: Record<string, string> = {};
  if (m["lora_after"] !== undefined) {
    const raw = mapping(m["lora_after"], `${what} lora_after`);
    loraAfter = {};
    for (const [slot, node] of Object.entries(raw)) {
      if (!experts.some((e) => e.slot === slot)) throw new ProfileError(`${what} lora_after names ${slot}, which is not an expert slot`);
      if (typeof node !== "string" || !NODE_ID.test(node)) throw new ProfileError(`${what} lora_after ${slot} is not a plain node id`);
      loraAfter[slot] = node;
    }
  }
  return {
    workflow, models: family.models, params, startImage, outputNode, fps: family.fps, sizes: family.sizes, durations: family.durations, experts, fixed,
    loraAfter, extraLoras: family.extraLoras,
  };
}

function parseExtraLoras(raw: unknown, what: string, files: readonly VideoModel[]): VideoExtraLora[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_EXTRA_LORAS) throw new ProfileError(`${what} extra_loras must be a list of at most ${MAX_EXTRA_LORAS} entries`);
  const out = raw.map((item): VideoExtraLora => {
    const e = mapping(item, `${what} extra LoRA`);
    const unknown = Object.keys(e).filter((k) => !EXTRA_LORA_KEYS.has(k));
    if (unknown.length > 0) throw new ProfileError(`a ${what} extra LoRA has unknown keys: ${unknown.sort().join(", ")}`);
    const id = parseId(e["id"], `${what} extra LoRA`);
    const at = `${what} extra LoRA ${id}`;
    const title = plainName(e["title"], `${at} title`);
    const description = e["description"] ?? "";
    if (typeof description !== "string" || description.length > DESCRIPTION_MAX || /[\r\n]/.test(description)) {
      throw new ProfileError(`${at} description must be one line of at most ${DESCRIPTION_MAX} characters`);
    }
    const modes = e["modes"];
    if (!Array.isArray(modes) || modes.length === 0 || !modes.every((x) => x === "text" || x === "image") || new Set(modes).size !== modes.length) {
      throw new ProfileError(`${at} modes must list text and/or image, each once`);
    }
    const sides: Record<string, string> = {};
    for (const side of EXTRA_LORA_SIDES) {
      if (e[side] === undefined) continue;
      const f = mapping(e[side], `${at} ${side}`);
      if (Object.keys(f).some((k) => k !== "file")) throw new ProfileError(`${at} ${side} takes only file`);
      const model = files.find((x) => x.file === f["file"]);
      if (model === undefined) throw new ProfileError(`${at} ${side} file must be one of the family's models`);
      if (model.dest !== LORA_FOLDER) throw new ProfileError(`${at} ${side} file must be a model with dest ${LORA_FOLDER}/`);
      sides[side] = model.file;
    }
    if (Object.keys(sides).length === 0) throw new ProfileError(`${at} needs a high or a low file`);
    const strength = e["strength"] ?? DEFAULT_EXTRA_LORA_STRENGTH;
    if (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0 || strength > 1) throw new ProfileError(`${at} strength must be a number from 0 to 1`);
    const trigger = e["trigger_words"] ?? "";
    if (typeof trigger !== "string" || trigger.length > TRIGGER_WORDS_MAX || /[\r\n]/.test(trigger)) {
      throw new ProfileError(`${at} trigger_words must be one line of at most ${TRIGGER_WORDS_MAX} characters`);
    }
    return { id, title, description, modes: modes as ("text" | "image")[], files: sides, strength, triggerWords: trigger };
  });
  if (new Set(out.map((x) => x.id)).size !== out.length) throw new ProfileError(`${what} extra LoRA ids must be unique`);
  return out;
}

/**
 * The families of `video_families:` that are on: VIDEO_ENABLED (`videoEnabled`) and listed in VIDEO_FAMILIES
 * (`enabled`). Every family is validated either way; an id in VIDEO_FAMILIES that names no family is refused (the
 * base section's id is accepted: it is on with VIDEO_ENABLED alone). An enabled family must have all its files pinned.
 */
export function parseVideoFamilies(
  raw: unknown,
  models: readonly ModelEntry[],
  opts: { enabled: readonly string[]; videoEnabled: boolean; baseId: string | null },
): VideoFamily[] {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list) || list.length > MAX_FAMILIES) throw new ProfileError(`video_families must be a list of at most ${MAX_FAMILIES} families`);
  const ids = new Set<string>();
  const parsed = list.map((item) => {
    const m = mapping(item, "video family");
    const id = parseId(m["id"], "video family");
    const what = `video family ${id}`;
    if ("enabled" in m) throw new ProfileError(`${what}: \`enabled:\` is not read from the profile: list the id in VIDEO_FAMILIES in .env`);
    const unknown = Object.keys(m).filter((k) => !FAMILY_KEYS.has(k));
    if (unknown.length > 0) throw new ProfileError(`${what} has unknown keys: ${unknown.sort().join(", ")}`);
    if (id === opts.baseId || ids.has(id)) throw new ProfileError(`video family ids must be unique (also against the video section's id): ${id}`);
    ids.add(id);
    const title = plainName(m["title"], `${what} title`);
    const files = parseModelList(m["models"], what, MAX_FAMILY_MODELS);
    if (new Set(files.map((f) => f.file)).size !== files.length) throw new ProfileError(`${what} models must be different files`);
    checkNodeClasses(m["node_classes"], what);
    const fps = parseFps(m["fps"], what);
    const sizes = parseVideoSizes(m["sizes"], what);
    const durations = parseDurations(m["durations"], fps, what);
    const extraLoras = parseExtraLoras(m["extra_loras"], what, files);
    const shape = { models: files, fps, sizes, durations, extraLoras };
    const text = parseMode(m["text"], `${what} text`, false, shape);
    const image = parseMode(m["image"], `${what} image`, true, shape);
    // Every branch an extra LoRA of a mode uses needs its join point in that mode.
    for (const lora of extraLoras) {
      for (const mode of lora.modes) {
        const spec = mode === "text" ? text : image;
        for (const side of Object.keys(lora.files)) {
          if (spec.loraAfter[side] === undefined) throw new ProfileError(`${what} ${mode}: lora_after needs ${side} for the extra LoRA ${lora.id}`);
        }
      }
    }
    const family: VideoFamily = { id, title, base: false, models: files, fps, sizes, durations, text, image, extraLoras };
    return family;
  });
  const unknownIds = opts.enabled.filter((id) => id !== opts.baseId && !ids.has(id));
  if (unknownIds.length > 0) throw new ProfileError(`VIDEO_FAMILIES names an unknown video family: ${unknownIds.join(", ")}`);
  if (!opts.videoEnabled) return [];
  const on = parsed.filter((f) => opts.enabled.includes(f.id));
  for (const f of on) checkPinned(f.models, models, `video family ${f.id}`);
  return on;
}

/** The plain file names of every video family of the profile (the base section's and `video_families:`), on or off. */
export function videoFamilyFilesOf(rawBase: unknown, rawFamilies: unknown): Record<string, string[]> {
  const files = (raw: unknown): string[] => {
    const models = (raw as { models?: unknown } | null | undefined)?.models;
    return Array.isArray(models) ? models.map((m) => String((m as { file?: unknown }).file)) : [];
  };
  const out: Record<string, string[]> = {};
  if (rawBase !== undefined && rawBase !== null) out[videoBaseIdentity(rawBase).id] = files(rawBase);
  for (const f of Array.isArray(rawFamilies) ? rawFamilies : []) out[String((f as { id?: unknown }).id)] = files(f);
  return out;
}

function nodeOf(template: unknown, id: string): { class_type?: unknown; inputs: Record<string, unknown> } | null {
  if (typeof template !== "object" || template === null) return null;
  const node = (template as Record<string, unknown>)[id];
  if (typeof node !== "object" || node === null) return null;
  const inputs = (node as { inputs?: unknown }).inputs;
  return typeof inputs === "object" && inputs !== null ? (node as { class_type?: unknown; inputs: Record<string, unknown> }) : null;
}

/**
 * Check the video workflow against the section at startup: every mapped input exists, the start image input is
 * free and its node id unused, the output node is a SaveVideo node, and the graph loads every listed model file.
 */
export function checkVideoTemplate(spec: VideoSpec, template: unknown, opts: { allModels?: boolean } = {}): void {
  for (const key of VIDEO_PARAM_KEYS) {
    const r = spec.params[key];
    const node = nodeOf(template, r.node);
    if (node === null || !(r.input in node.inputs)) throw new ProfileError(`video workflow lacks node ${r.node} input ${r.input} (param ${key})`);
  }
  if (spec.startImage !== null) {
    const start = nodeOf(template, spec.startImage.node);
    if (start === null) throw new ProfileError(`video workflow lacks the start image node ${spec.startImage.node}`);
    if (spec.startImage.input in start.inputs) throw new ProfileError(`video workflow already sets node ${spec.startImage.node} input ${spec.startImage.input} (start_image must be left free)`);
    if (nodeOf(template, VIDEO_START_NODE) !== null) throw new ProfileError(`video workflow already has a node ${VIDEO_START_NODE}`);
  }
  for (const f of spec.fixed) {
    const node = nodeOf(template, f.node);
    if (node === null || !(f.input in node.inputs)) throw new ProfileError(`video workflow lacks node ${f.node} input ${f.input} (fixed)`);
  }
  for (const [slot, node] of Object.entries(spec.loraAfter)) {
    if (nodeOf(template, node)?.class_type !== LORA_CLASS) throw new ProfileError(`video workflow node ${node} (lora_after ${slot}) must be a ${LORA_CLASS} node`);
    if (nodeOf(template, `${VIDEO_LORA_NODE_PREFIX}${slot}`) !== null) throw new ProfileError(`video workflow already has a node ${VIDEO_LORA_NODE_PREFIX}${slot}`);
  }
  for (const e of spec.experts) {
    // A link replaces an expert in its loader node (a .gguf one turns it into the GGUF loader): a UNETLoader only.
    const loaders = Object.values(template as Record<string, { class_type?: unknown; inputs?: Record<string, unknown> }>).filter((n) =>
      Object.values(n?.inputs ?? {}).includes(e.file),
    );
    if (loaders.length === 0) throw new ProfileError(`video workflow does not load the expert ${e.file}`);
    if (!loaders.every((n) => n.class_type === "UNETLoader" && n.inputs?.["unet_name"] === e.file)) {
      throw new ProfileError(`video workflow must load the expert ${e.file} with a UNETLoader (unet_name)`);
    }
  }
  if (nodeOf(template, spec.outputNode)?.class_type !== VIDEO_OUTPUT_CLASS) {
    throw new ProfileError(`video output_node ${spec.outputNode} must be a ${VIDEO_OUTPUT_CLASS} node`);
  }
  const used = new Set<unknown>();
  for (const node of Object.values(template as Record<string, { inputs?: Record<string, unknown> }>)) {
    for (const v of Object.values(node?.inputs ?? {})) used.add(v);
  }
  if (opts.allModels === false) return;
  for (const f of spec.models) {
    if (!used.has(f.file)) throw new ProfileError(`video workflow does not load the listed model file ${f.file}`);
  }
}

function filesUsed(template: unknown): Set<unknown> {
  const used = new Set<unknown>();
  for (const node of Object.values(template as Record<string, { inputs?: Record<string, unknown> }>)) {
    for (const v of Object.values(node?.inputs ?? {})) used.add(v);
  }
  return used;
}

/** Check a family's two workflows at startup: each mode as checkVideoTemplate does, and every family file is loaded by one. */
export function checkVideoFamily(family: VideoFamily, templates: { text: unknown; image: unknown }): void {
  checkVideoTemplate(family.text, templates.text, { allModels: family.base });
  checkVideoTemplate(family.image, templates.image, { allModels: family.base });
  const used = new Set([...filesUsed(templates.text), ...filesUsed(templates.image)]);
  // An extra LoRA's files are named by the web app when a user picks one, never by the workflow.
  for (const lora of family.extraLoras) for (const file of Object.values(lora.files)) used.add(file);
  for (const f of family.models) {
    if (!used.has(f.file)) throw new ProfileError(`video family ${family.id}: no workflow loads the listed model file ${f.file}`);
  }
}

/** Fill the video workflow: a deep copy with the mapped inputs set and, for a start image, one LoadImage node. */
export function buildVideoPrompt(spec: VideoSpec, workflowJson: unknown, input: VideoInput): ComfyPrompt {
  const size = spec.sizes.find((z) => z.name === input.size);
  if (!size) throw new GenerateInputError("unknown_size", "size is not offered for video");
  const duration = spec.durations.find((d) => d.name === input.duration);
  if (!duration) throw new GenerateInputError("unknown_duration", "duration is not offered for video");
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") throw new GenerateInputError("invalid_prompt", "prompt must be a non-empty string");
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) throw new GenerateInputError("invalid_seed", "seed must be a non-negative integer");
  if (input.startImage !== undefined && !isPlainFileName(input.startImage)) {
    throw new GenerateInputError("invalid_reference_name", "the start image file name is not a plain file name");
  }
  const copy = structuredClone(workflowJson) as ComfyPrompt;
  const values: Record<VideoParamKey, string | number> = {
    prompt: input.prompt,
    seed: input.seed,
    width: size.width,
    height: size.height,
    length: duration.frames,
    fps: spec.fps,
  };
  for (const key of VIDEO_PARAM_KEYS) {
    const r = spec.params[key];
    const node = copy[r.node];
    if (!node || typeof node.inputs !== "object" || node.inputs === null || !(r.input in node.inputs)) {
      throw new GenerateInputError("workflow_mismatch", `workflow lacks node ${r.node} input ${r.input}`);
    }
    node.inputs[r.input] = values[key];
  }
  for (const f of spec.fixed) {
    const node = copy[f.node];
    if (!node || typeof node.inputs !== "object" || node.inputs === null || !(f.input in node.inputs)) {
      throw new GenerateInputError("workflow_mismatch", `workflow lacks node ${f.node} input ${f.input}`);
    }
    node.inputs[f.input] = f.value;
  }
  if (input.diffusionFile !== undefined) {
    const slot = spec.models.find((m) => m.dest === DIFFUSION_FOLDER);
    if (slot === undefined || !isLinkedModelName(input.diffusionFile)) {
      throw new GenerateInputError("workflow_mismatch", "the linked video model cannot be used with this workflow");
    }
    useLinkedFile(copy, slot.file, input.diffusionFile);
  }
  if (input.links !== undefined) {
    // Both experts of a mode are linked together, or neither: a one-sided set is refused.
    const slots = Object.keys(input.links);
    const all = spec.experts.map((e) => e.slot);
    if (all.length === 0 || slots.length !== all.length || !all.every((x) => slots.includes(x))) {
      throw new GenerateInputError("workflow_mismatch", "linked experts must replace all of this mode's experts together");
    }
    for (const e of spec.experts) {
      const name = input.links[e.slot];
      if (name === undefined || !isLinkedModelName(name)) throw new GenerateInputError("workflow_mismatch", "a linked expert is not a plain .safetensors or .gguf file");
    }
    const names = spec.experts.map((e) => input.links![e.slot]!);
    if (new Set(names).size !== names.length || names.some((n) => spec.models.some((m) => m.file === n))) {
      throw new GenerateInputError("workflow_mismatch", "linked experts must have their own file names");
    }
    for (const e of spec.experts) useLinkedFile(copy, e.file, input.links[e.slot]!);
  }
  if (input.extraLora !== undefined) {
    if (spec.extraLoras.length === 0) throw new GenerateInputError("extra_lora_unavailable", "this video model has no extra LoRAs");
    const lora = spec.extraLoras.find((x) => x.id === input.extraLora!.id);
    if (lora === undefined) throw new GenerateInputError("unknown_extra_lora", "extra_lora is not offered for this video model");
    const mode = spec.startImage === null ? "text" : "image";
    if (!lora.modes.includes(mode)) throw new GenerateInputError("extra_lora_mode", `this extra LoRA is not offered for ${mode} to video`);
    const strength = input.extraLora.strength;
    if (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new GenerateInputError("invalid_strength", "extra_lora_strength must be a number from 0 to 1");
    }
    // One LoRA node per branch, after the branch's join point; everything that read the join point reads it instead.
    for (const [slot, file] of Object.entries(lora.files)) {
      const after = spec.loraAfter[slot];
      const id = `${VIDEO_LORA_NODE_PREFIX}${slot}`;
      if (after === undefined || copy[after] === undefined || id in copy) throw new GenerateInputError("workflow_mismatch", `workflow cannot take the extra LoRA on ${slot}`);
      for (const node of Object.values(copy)) {
        for (const [k, v] of Object.entries(node.inputs ?? {})) {
          if (Array.isArray(v) && v[0] === after && v[1] === 0) node.inputs[k] = [id, 0];
        }
      }
      copy[id] = { class_type: LORA_CLASS, inputs: { model: [after, 0], lora_name: file, strength_model: strength } };
    }
  }
  if (input.startImage !== undefined && spec.startImage === null) {
    throw new GenerateInputError("workflow_mismatch", "this workflow takes no start image");
  }
  if (input.startImage !== undefined && spec.startImage !== null) {
    const target = copy[spec.startImage.node];
    if (!target || typeof target.inputs !== "object" || target.inputs === null) {
      throw new GenerateInputError("workflow_mismatch", `workflow lacks node ${spec.startImage.node}`);
    }
    if (VIDEO_START_NODE in copy) throw new GenerateInputError("workflow_mismatch", `workflow already has a node ${VIDEO_START_NODE}`);
    copy[VIDEO_START_NODE] = { class_type: START_IMAGE_CLASS, inputs: { [START_IMAGE_INPUT]: input.startImage } };
    target.inputs[spec.startImage.input] = [VIDEO_START_NODE, 0];
  }
  return copy;
}

/** Name a linked file wherever the copied workflow names the pinned one; a .gguf file swaps the UNETLoader for the GGUF loader. */
function useLinkedFile(copy: ComfyPrompt, pinned: string, linked: string): void {
  const loader = loaderFor(linked);
  let used = 0;
  for (const node of Object.values(copy)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (v !== pinned) continue;
      used++;
      if (loader === null) {
        node.inputs[k] = linked;
      } else {
        // A .gguf file needs the GGUF loader: the native UNETLoader node becomes one (its only input is unet_name).
        if (node.class_type !== "UNETLoader" || k !== "unet_name") {
          throw new GenerateInputError("workflow_mismatch", "the workflow's diffusion model loader is not a UNETLoader");
        }
        node.class_type = loader;
        node.inputs = { unet_name: linked };
        break;
      }
    }
  }
  if (used === 0) throw new GenerateInputError("workflow_mismatch", `workflow does not load ${pinned}`);
}

// ---- the result file: only an mp4 or WebM recognised by its first bytes is ever served ----

export type VideoType = "video/mp4" | "video/webm";
// Major brands of ISO base media files that browsers play as video/mp4 (not HEIF images or QuickTime).
const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash"]);
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const EBML_DOCTYPE_ID = Buffer.from([0x42, 0x82]);
const EBML_HEADER_SCAN = 64;
const FTYP_HEADER = 12;

/** The video type of a result by its magic bytes; null for anything that is not an mp4 or WebM file. */
export function sniffVideo(bytes: Buffer): VideoType | null {
  if (bytes.length >= FTYP_HEADER && bytes.toString("latin1", 4, 8) === "ftyp") {
    const box = bytes.readUInt32BE(0);
    return box >= FTYP_HEADER && MP4_BRANDS.has(bytes.toString("latin1", 8, 12)) ? "video/mp4" : null;
  }
  if (bytes.length > EBML_MAGIC.length && bytes.subarray(0, EBML_MAGIC.length).equals(EBML_MAGIC)) {
    // The EBML header's DocType element: ID 0x4282, a one-byte size 0x84, then "webm".
    const head = bytes.subarray(0, EBML_HEADER_SCAN);
    const at = head.indexOf(EBML_DOCTYPE_ID);
    return at !== -1 && head[at + 2] === 0x84 && head.toString("latin1", at + 3, at + 7) === "webm" ? "video/webm" : null;
  }
  return null;
}
