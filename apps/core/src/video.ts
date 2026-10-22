import { GenerateInputError, ProfileError } from "./profile-errors.js";
import { isLinkedModelName, loaderFor } from "./model-link.js";
import { isPlainFileName, landsIn, parseSizeList, type ComfyPrompt, type ModelEntry, type ParamRef, type SizeSpec } from "./profile.js";

// Video mode: text to video, or image to video with exactly one start image, through one model and native
// ComfyUI nodes. Declared in the profile's `video:` section; OFF until `enabled: true` (its model files must be
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
}

export interface VideoModel {
  /** The plain file name the workflow's loader reads. */
  readonly file: string;
  /** The ComfyUI folder its `models:` entry must download into. */
  readonly dest: string;
}

export interface VideoSpec {
  readonly workflow: string;
  readonly models: readonly VideoModel[];
  readonly params: Readonly<Record<VideoParamKey, ParamRef>>;
  /** The input of the latent node that takes the optional start image (a LoadImage node is added for it). */
  readonly startImage: ParamRef;
  /** The SaveVideo node whose files are the result. */
  readonly outputNode: string;
  readonly fps: number;
  readonly sizes: readonly SizeSpec[];
  readonly durations: readonly VideoDuration[];
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
}

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
const KEYS = new Set(["enabled", "workflow", "models", "node_classes", "params", "start_image", "output_node", "fps", "sizes", "durations"]);
const DURATION_KEYS = new Set(["name", "frames"]);
const MAX_MODELS = 8;
const MAX_FPS = 60;
const MIN_FRAMES = 5;
// About 10 s at 24 fps; longer clips need far more VRAM and time than a 24 GB card is known to give.
const MAX_FRAMES = 257;
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

/** The video section when it is enabled, else null. Everything is validated even when disabled. */
export function parseVideo(raw: unknown, models: readonly ModelEntry[]): VideoSpec | null {
  if (raw === undefined || raw === null) return null;
  const m = mapping(raw, "video");
  const unknown = Object.keys(m).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) throw new ProfileError(`video has unknown keys: ${unknown.sort().join(", ")}`);
  if (typeof m["enabled"] !== "boolean") throw new ProfileError("video enabled must be true or false");
  const workflow = m["workflow"];
  if (typeof workflow !== "string" || !WORKFLOW_NAME.test(workflow)) throw new ProfileError("video workflow is not a valid workflow name");

  const modelsRaw = m["models"];
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0 || modelsRaw.length > MAX_MODELS) {
    throw new ProfileError(`video models must be a non-empty list of at most ${MAX_MODELS} entries`);
  }
  const files: VideoModel[] = modelsRaw.map((item) => {
    const e = mapping(item, "video model");
    const { file, dest } = e;
    if (typeof file !== "string" || !MODEL_FILE.test(file)) throw new ProfileError("video model file must be one plain file name");
    if (typeof dest !== "string" || !MODEL_DEST.test(dest)) throw new ProfileError(`video model ${file}: dest must be one ComfyUI model folder like models/vae/`);
    return { file, dest: dest.replace(/\/+$/, "") };
  });

  const classes = m["node_classes"];
  if (!Array.isArray(classes) || !classes.every((c) => typeof c === "string" && NODE_CLASS.test(c))) {
    throw new ProfileError("video node_classes must be a list of plain node class names");
  }

  const paramsRaw = mapping(m["params"], "video params");
  const extra = Object.keys(paramsRaw).filter((k) => !(VIDEO_PARAM_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) throw new ProfileError(`video params has unknown keys: ${extra.sort().join(", ")}`);
  const params = {} as Record<VideoParamKey, ParamRef>;
  const taken = new Set<string>();
  for (const key of VIDEO_PARAM_KEYS) {
    if (!(key in paramsRaw)) throw new ProfileError(`video params is missing ${key}`);
    params[key] = ref(paramsRaw[key], `video param ${key}`);
    const at = `${params[key].node}/${params[key].input}`;
    if (taken.has(at)) throw new ProfileError(`video param ${key} uses node ${params[key].node} input ${params[key].input}, which another param already sets`);
    taken.add(at);
  }
  const startImage = ref(m["start_image"], "video start_image");
  if (taken.has(`${startImage.node}/${startImage.input}`)) throw new ProfileError("video start_image uses an input a param already sets");

  const outputNode = m["output_node"];
  if (typeof outputNode !== "string" || !NODE_ID.test(outputNode)) throw new ProfileError("video output_node must be a plain node id");

  const fps = m["fps"];
  if (typeof fps !== "number" || !Number.isInteger(fps) || fps < 1 || fps > MAX_FPS) {
    throw new ProfileError(`video fps must be a whole number from 1 to ${MAX_FPS}`);
  }

  const sizesRaw = m["sizes"];
  if (!Array.isArray(sizesRaw) || sizesRaw.length === 0) throw new ProfileError("video sizes must be a non-empty list");
  const sizes = parseSizeList(sizesRaw);
  for (const z of sizes) {
    if (z.width > MAX_SIDE || z.height > MAX_SIDE) throw new ProfileError(`video size ${z.name} must be at most ${MAX_SIDE} pixels on each side`);
  }

  const durationsRaw = m["durations"];
  if (!Array.isArray(durationsRaw) || durationsRaw.length === 0) throw new ProfileError("video durations must be a non-empty list");
  const durations: VideoDuration[] = durationsRaw.map((item) => {
    const d = mapping(item, "video duration");
    const keys = Object.keys(d).filter((k) => !DURATION_KEYS.has(k));
    if (keys.length > 0) throw new ProfileError(`a video duration has unknown keys: ${keys.sort().join(", ")}`);
    const name = plainName(d["name"], "video duration name");
    const frames = d["frames"];
    if (typeof frames !== "number" || !Number.isInteger(frames) || frames < MIN_FRAMES || frames > MAX_FRAMES || (frames - 1) % FRAMES_PER_LATENT !== 0) {
      throw new ProfileError(`video duration ${name}: frames must be 4n+1 between ${MIN_FRAMES} and ${MAX_FRAMES}`);
    }
    return { name, frames, seconds: Math.round(frames / fps) };
  });
  if (new Set(durations.map((d) => d.name)).size !== durations.length) throw new ProfileError("video duration names must be unique");

  const spec: VideoSpec = { workflow, models: files, params, startImage, outputNode, fps, sizes, durations };
  if (!m["enabled"]) return null;
  for (const f of files) {
    const entry = models.find((e) => e.file.split("/").pop() === f.file);
    if (entry === undefined) throw new ProfileError(`video model ${f.file} is not listed in models (pin it with scripts/pin_model.py)`);
    if (!landsIn(entry, f.dest)) throw new ProfileError(`video: the models entry for ${f.file} must have dest ${f.dest}/`);
  }
  return spec;
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
export function checkVideoTemplate(spec: VideoSpec, template: unknown): void {
  for (const key of VIDEO_PARAM_KEYS) {
    const r = spec.params[key];
    const node = nodeOf(template, r.node);
    if (node === null || !(r.input in node.inputs)) throw new ProfileError(`video workflow lacks node ${r.node} input ${r.input} (param ${key})`);
  }
  const start = nodeOf(template, spec.startImage.node);
  if (start === null) throw new ProfileError(`video workflow lacks the start image node ${spec.startImage.node}`);
  if (spec.startImage.input in start.inputs) throw new ProfileError(`video workflow already sets node ${spec.startImage.node} input ${spec.startImage.input} (start_image must be left free)`);
  if (nodeOf(template, VIDEO_START_NODE) !== null) throw new ProfileError(`video workflow already has a node ${VIDEO_START_NODE}`);
  if (nodeOf(template, spec.outputNode)?.class_type !== VIDEO_OUTPUT_CLASS) {
    throw new ProfileError(`video output_node ${spec.outputNode} must be a ${VIDEO_OUTPUT_CLASS} node`);
  }
  const used = new Set<unknown>();
  for (const node of Object.values(template as Record<string, { inputs?: Record<string, unknown> }>)) {
    for (const v of Object.values(node?.inputs ?? {})) used.add(v);
  }
  for (const f of spec.models) {
    if (!used.has(f.file)) throw new ProfileError(`video workflow does not load the listed model file ${f.file}`);
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
  if (input.diffusionFile !== undefined) {
    const slot = spec.models.find((m) => m.dest === DIFFUSION_FOLDER);
    if (slot === undefined || !isLinkedModelName(input.diffusionFile)) {
      throw new GenerateInputError("workflow_mismatch", "the linked video model cannot be used with this workflow");
    }
    const loader = loaderFor(input.diffusionFile);
    let used = 0;
    for (const node of Object.values(copy)) {
      for (const [k, v] of Object.entries(node.inputs ?? {})) {
        if (v !== slot.file) continue;
        used++;
        if (loader === null) {
          node.inputs[k] = input.diffusionFile;
        } else {
          // A .gguf file needs the GGUF loader: the native UNETLoader node becomes one (its only input is unet_name).
          if (node.class_type !== "UNETLoader" || k !== "unet_name") {
            throw new GenerateInputError("workflow_mismatch", "the workflow's diffusion model loader is not a UNETLoader");
          }
          node.class_type = loader;
          node.inputs = { unet_name: input.diffusionFile };
          break;
        }
      }
    }
    if (used === 0) throw new GenerateInputError("workflow_mismatch", `workflow does not load ${slot.file}`);
  }
  if (input.startImage !== undefined) {
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
