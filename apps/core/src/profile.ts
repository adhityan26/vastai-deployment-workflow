import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { GenerateInputError, ProfileError } from "./profile-errors.js";
import { applyStyle, parseStyles, type ResolvedStyle, type StyleSpec } from "./styles.js";
import { parseGuidance, type GuidanceSpec, type TuningSupport } from "./guidance.js";
import { parseUpscale, type UpscaleSpec } from "./upscale.js";
import { checkStyleMenus, parseMenu, type MenuSpec } from "./menu.js";
import { parseVideo, type VideoSpec } from "./video.js";

// Same rule as vastcomfy_agent.workflows.NAME_RE (protocol rule, not configuration).
const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,100}\.json$/;
const PARAM_KEYS = ["prompt", "steps", "width", "height", "seed"] as const;
type ParamKey = (typeof PARAM_KEYS)[number];
// Optional knobs: a profile without them simply does not offer a negative prompt or guidance for that workflow.
const OPTIONAL_PARAM_KEYS = ["negative_prompt", "cfg"] as const;
const EDIT_PARAM_KEYS = ["prompt", "steps", "seed", "resolution"] as const;
type EditParamKey = (typeof EDIT_PARAM_KEYS)[number];
// Plain identifiers only: these end up in a workflow graph that ComfyUI executes.
const NODE_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
// Names ComfyUI returns for an uploaded reference (and the ones we choose): one plain file name.
const REFERENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** True for a plain, single-segment file name (what an uploaded reference is called). */
export function isPlainFileName(value: unknown): value is string {
  return typeof value === "string" && REFERENCE_NAME.test(value);
}
/** Prefix of the LoadImage node ids the web app adds to the edit workflow (ref_1 .. ref_N). */
const REFERENCE_NODE_PREFIX = "ref_";

export interface ParamRef {
  readonly node: string;
  readonly input: string;
}
export interface QualityPreset {
  readonly name: string;
  readonly steps: number;
}
export interface SizeSpec {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}
/** Where the optional negative prompt and cfg go in a workflow; null when the workflow has no such input. */
export interface OptionalParams {
  readonly negativePrompt: ParamRef | null;
  readonly cfg: ParamRef | null;
}
export interface GenerateSpec {
  readonly workflow: string;
  readonly params: Readonly<Record<ParamKey, ParamRef>>;
  readonly optional: OptionalParams;
  readonly qualityPresets: readonly QualityPreset[];
  readonly sizes: readonly SizeSpec[];
}
export interface ResolutionSpec {
  readonly name: string;
  /** The encoder's total pixel budget (not width/height). */
  readonly value: number;
}
export interface ReferenceSpec {
  /** Node class added once per reference (LoadImage). */
  readonly nodeClass: string;
  /** Its input that takes the uploaded file name. */
  readonly imageInput: string;
  /** The node whose `<inputPrefix><k>` inputs receive the k-th reference (k starts at 1). */
  readonly encoderNode: string;
  readonly inputPrefix: string;
}
export interface EditSpec {
  readonly workflow: string;
  readonly params: Readonly<Record<EditParamKey, ParamRef>>;
  readonly optional: OptionalParams;
  readonly references: ReferenceSpec;
  readonly resolutions: readonly ResolutionSpec[];
  /** Output sizes an edit may ask for instead of the reference's own; empty when the profile offers none. */
  readonly sizes: readonly SizeSpec[];
  /** The sampler input that takes the chosen size's empty latent; null exactly when `sizes` is empty. */
  readonly sizeLatent: ParamRef | null;
}
/** One model file of the profile, in download order (the instance loader owns the other fields). */
export interface ModelSpec {
  /** As written in the profile; may include a subpath (the agent reports the basename). */
  readonly file: string;
  readonly size_bytes: number;
}

/** What styles and upscale check about a model entry: the file and the folder it lands in. */
export interface ModelEntry {
  readonly file: string;
  readonly dest?: string;
}

/** True when `entry` downloads into the ComfyUI folder `folder` (e.g. "models/loras"), trailing slash or not. */
export function landsIn(entry: ModelEntry, folder: string): boolean {
  return (entry.dest ?? "").replace(/\/+$/, "") === folder;
}
export interface Profile {
  readonly name: string;
  readonly generate: GenerateSpec;
  /** Null when the profile has no edit section (edit with reference images is then off). */
  readonly edit: EditSpec | null;
  /** The enabled styles (LoRA variations with their own parameters); empty when the profile has none. */
  readonly styles: readonly StyleSpec[];
  /** The allowed guidance (cfg) range; null when the profile offers no guidance setting. */
  readonly guidance: GuidanceSpec | null;
  /** The upscale mode when the profile enables it; null otherwise. */
  readonly upscale: UpscaleSpec | null;
  /** The video mode when VIDEO_ENABLED switches it on; null otherwise. */
  readonly video: VideoSpec | null;
  /**
   * The plain names of the video section's model files, also while video is off: an instance never downloads them
   * then, so the boot download progress must leave them out (empty without a video section).
   */
  readonly videoFiles: readonly string[];
  /** The tool menu's categories and built-in tools (styles add their own entries: see menuItems). */
  readonly menu: MenuSpec;
  readonly models: readonly ModelSpec[];
}

export type ComfyPrompt = Record<string, { class_type?: string; inputs: Record<string, unknown> }>;

export interface GenerateInput {
  prompt: string;
  preset: string;
  size: string;
  seed: number;
  /** Already checked by resolveTuning; absent leaves the workflow's own value. */
  negativePrompt?: string;
  cfg?: number;
  /** A style already checked by resolveStyle; null or absent for the plain workflow. */
  style?: ResolvedStyle | null;
}

export interface EditInput {
  prompt: string;
  /** A quality preset name from the generate section. */
  preset: string;
  /** A resolution name from the edit section. */
  resolution: string;
  /** A size name from the edit section; absent keeps the reference's own size (the workflow as shipped). */
  size?: string;
  seed: number;
  /** Names of the already uploaded references, in order: the first one is image_1. */
  imageNames: readonly string[];
  /** Already checked by resolveTuning; absent leaves the workflow's own value. */
  negativePrompt?: string;
  cfg?: number;
  /** A style already checked by resolveStyle; null or absent for the plain workflow. */
  style?: ResolvedStyle | null;
}

export { GenerateInputError, ProfileError };

function mapping(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProfileError(`${what} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function required(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ProfileError(`${what} must be a non-empty string`);
  return value;
}

function positiveInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ProfileError(`${what} must be a positive integer`);
  }
  return value;
}

function parseModels(raw: unknown): ModelSpec[] {
  // A profile without models is still valid for the web (nothing to report while downloading).
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ProfileError("models must be a list");
  return raw.map((item, i) => {
    const entry = mapping(item, `model ${i}`);
    const file = required(entry["file"], `model ${i} file`);
    const size = entry["size_bytes"];
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
      throw new ProfileError(`model ${file} size_bytes must be a positive integer`);
    }
    return { file, size_bytes: size };
  });
}

/** File and dest of each model entry (already checked by parseModels), for the styles and upscale checks. */
function modelEntries(raw: unknown): ModelEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const entry = item as Record<string, unknown>;
    const dest = entry["dest"];
    return { file: String(entry["file"]), ...(typeof dest === "string" ? { dest } : {}) };
  });
}

function parseOptional(paramsRaw: Record<string, unknown>, section: string, mandatory: readonly ParamRef[]): OptionalParams {
  const ref = (key: string): ParamRef | null => (key in paramsRaw ? paramRef(paramsRaw[key], `${section} param ${key}`) : null);
  const optional = { negativePrompt: ref("negative_prompt"), cfg: ref("cfg") };
  // A knob mapped onto an input another param already fills would silently overwrite it (for example the
  // negative prompt landing in the positive prompt's text).
  const taken = new Set(mandatory.map((r) => `${r.node}/${r.input}`));
  for (const [key, r] of [["negative_prompt", optional.negativePrompt], ["cfg", optional.cfg]] as const) {
    if (r === null) continue;
    const at = `${r.node}/${r.input}`;
    if (taken.has(at)) throw new ProfileError(`${section} param ${key} uses node ${r.node} input ${r.input}, which another param already sets`);
    taken.add(at);
  }
  return optional;
}

/** "<node>/<input>" to the param or knob that sets it, for one workflow. */
function takenInputs(params: Readonly<Record<string, ParamRef>>, optional: OptionalParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, ref] of Object.entries(params)) out[`${ref.node}/${ref.input}`] = name;
  if (optional.negativePrompt !== null) out[`${optional.negativePrompt.node}/${optional.negativePrompt.input}`] = "negative_prompt";
  if (optional.cfg !== null) out[`${optional.cfg.node}/${optional.cfg.input}`] = "cfg";
  return out;
}

/** Which optional knobs a mode's workflow accepts; nothing for a mode the profile does not have. */
export function tuningSupport(profile: Profile, mode: "generate" | "edit"): TuningSupport {
  const optional = mode === "generate" ? profile.generate.optional : (profile.edit?.optional ?? null);
  return { negativePrompt: optional?.negativePrompt != null, cfg: optional?.cfg != null };
}

/**
 * Refuse a profile whose guidance default differs from the cfg its workflows ship with: the page shows the
 * default when the user chooses nothing and then sends no cfg, so both must be the same number.
 */
export function checkGuidanceDefault(profile: Profile, templates: { generate: unknown; edit: unknown }): void {
  if (profile.guidance === null) return;
  const check = (ref: ParamRef | null, template: unknown, mode: string): void => {
    if (ref === null || template === null || template === undefined) return;
    const inputs = (template as ComfyPrompt)[ref.node]?.inputs;
    // A missing node or input is a workflow mismatch, refused (profile_mismatch) when a job is built.
    if (typeof inputs !== "object" || inputs === null || !(ref.input in inputs)) return;
    if (inputs[ref.input] !== profile.guidance!.default) {
      throw new ProfileError(`guidance default ${profile.guidance!.default} differs from the ${mode} workflow's cfg (node ${ref.node} input ${ref.input})`);
    }
  };
  check(profile.generate.optional.cfg, templates.generate, "generate");
  check(profile.edit?.optional.cfg ?? null, templates.edit, "edit");
}

function parseGenerate(raw: unknown): GenerateSpec {
  const gen = mapping(raw, "generate");
  const workflow = required(gen["workflow"], "generate workflow");
  if (!WORKFLOW_NAME.test(workflow)) throw new ProfileError(`generate workflow is not a valid workflow name: ${workflow}`);

  const paramsRaw = mapping(gen["params"], "generate params");
  const unknown = Object.keys(paramsRaw).filter((k) => !(PARAM_KEYS as readonly string[]).includes(k) && !(OPTIONAL_PARAM_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new ProfileError(`generate params has unknown keys: ${unknown.sort().join(", ")}`);
  const params = {} as Record<ParamKey, ParamRef>;
  for (const key of PARAM_KEYS) {
    if (!(key in paramsRaw)) throw new ProfileError(`generate params is missing ${key}`);
    const ref = mapping(paramsRaw[key], `generate param ${key}`);
    params[key] = {
      node: required(ref["node"], `generate param ${key} node`),
      input: required(ref["input"], `generate param ${key} input`),
    };
  }

  const presetsRaw = mapping(gen["quality_presets"], "generate quality_presets");
  const qualityPresets = Object.entries(presetsRaw).map(([name, preset]) => ({
    name: required(name, "preset name"),
    steps: positiveInt(mapping(preset, `preset ${name}`)["steps"], `preset ${name} steps`),
  }));
  if (qualityPresets.length === 0) throw new ProfileError("generate quality_presets must not be empty");

  const sizesRaw = gen["sizes"];
  if (!Array.isArray(sizesRaw) || sizesRaw.length === 0) throw new ProfileError("generate sizes must be a non-empty list");
  const sizes = parseSizeList(sizesRaw);
  return { workflow, params, optional: parseOptional(paramsRaw, "generate", Object.values(params)), qualityPresets, sizes };
}

const SIZE_KEYS = new Set(["name", "width", "height"]);
const SIZE_MULTIPLE = 32;

/** A list of named output sizes (multiples of 32, unique names, no other members). */
export function parseSizeList(list: unknown[]): SizeSpec[] {
  const sizes: SizeSpec[] = [];
  for (const item of list) {
    const entry = mapping(item, "size");
    const unknown = Object.keys(entry).filter((k) => !SIZE_KEYS.has(k));
    if (unknown.length > 0) throw new ProfileError(`a size has unknown keys: ${unknown.sort().join(", ")}`);
    const name = required(entry["name"], "size name");
    const width = positiveInt(entry["width"], `size ${name} width`);
    const height = positiveInt(entry["height"], `size ${name} height`);
    if (width % SIZE_MULTIPLE !== 0 || height % SIZE_MULTIPLE !== 0) {
      throw new ProfileError(`size ${name} must be a multiple of 32: ${width}x${height}`);
    }
    if (sizes.some((s) => s.name === name)) throw new ProfileError(`duplicate size name '${name}'`);
    sizes.push({ name, width, height });
  }
  return sizes;
}

function paramRef(raw: unknown, what: string): ParamRef {
  const ref = mapping(raw, what);
  return { node: required(ref["node"], `${what} node`), input: required(ref["input"], `${what} input`) };
}

function parseEdit(raw: unknown): EditSpec {
  const edit = mapping(raw, "edit");
  const workflow = required(edit["workflow"], "edit workflow");
  if (!WORKFLOW_NAME.test(workflow)) throw new ProfileError(`edit workflow is not a valid workflow name: ${workflow}`);

  const paramsRaw = mapping(edit["params"], "edit params");
  const unknown = Object.keys(paramsRaw).filter((k) => !(EDIT_PARAM_KEYS as readonly string[]).includes(k) && !(OPTIONAL_PARAM_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new ProfileError(`edit params has unknown keys: ${unknown.sort().join(", ")}`);
  const params = {} as Record<EditParamKey, ParamRef>;
  for (const key of EDIT_PARAM_KEYS) {
    if (!(key in paramsRaw)) throw new ProfileError(`edit params is missing ${key}`);
    params[key] = paramRef(paramsRaw[key], `edit param ${key}`);
  }

  const refs = mapping(edit["references"], "edit references");
  const nodeClass = required(refs["node_class"], "edit references node_class");
  if (!NODE_CLASS.test(nodeClass)) throw new ProfileError(`edit references node_class is not a plain class name: ${nodeClass}`);
  const imageInput = required(refs["image_input"], "edit references image_input");
  if (!INPUT_NAME.test(imageInput)) throw new ProfileError(`edit references image_input is not a plain input name: ${imageInput}`);
  const encoder = mapping(refs["encoder"], "edit references encoder");
  const inputPrefix = required(encoder["input_prefix"], "edit references encoder input_prefix");
  if (!INPUT_NAME.test(inputPrefix)) throw new ProfileError(`edit references encoder input_prefix is not plain: ${inputPrefix}`);

  const resolutionsRaw = edit["resolutions"];
  if (!Array.isArray(resolutionsRaw) || resolutionsRaw.length === 0) {
    throw new ProfileError("edit resolutions must be a non-empty list");
  }
  const resolutions: ResolutionSpec[] = [];
  for (const item of resolutionsRaw) {
    const entry = mapping(item, "resolution");
    const name = required(entry["name"], "resolution name");
    const value = positiveInt(entry["value"], `resolution ${name} value`);
    if (resolutions.some((r) => r.name === name)) throw new ProfileError(`duplicate resolution name '${name}'`);
    resolutions.push({ name, value });
  }
  // Optional output sizes: `sizes` and `size_latent` (the sampler input that takes the new empty latent) come together.
  const sizesRaw = edit["sizes"];
  const latentRaw = edit["size_latent"];
  if ((sizesRaw === undefined || sizesRaw === null) !== (latentRaw === undefined || latentRaw === null)) {
    throw new ProfileError("edit sizes and edit size_latent must be set together");
  }
  let sizes: SizeSpec[] = [];
  let sizeLatent: ParamRef | null = null;
  if (Array.isArray(sizesRaw)) {
    if (sizesRaw.length === 0) throw new ProfileError("edit sizes must be a non-empty list when set");
    sizes = parseSizeList(sizesRaw);
    sizeLatent = paramRef(latentRaw, "edit size_latent");
    const taken = new Set(Object.values(params).map((r) => `${r.node}/${r.input}`));
    if (taken.has(`${sizeLatent.node}/${sizeLatent.input}`)) {
      throw new ProfileError(`edit size_latent uses node ${sizeLatent.node} input ${sizeLatent.input}, which another param already sets`);
    }
  } else if (sizesRaw !== undefined && sizesRaw !== null) {
    throw new ProfileError("edit sizes must be a list");
  }
  return {
    workflow,
    params,
    optional: parseOptional(paramsRaw, "edit", Object.values(params)),
    sizes,
    sizeLatent,
    references: { nodeClass, imageInput, encoderNode: required(encoder["node"], "edit references encoder node"), inputPrefix },
    resolutions,
  };
}

/** Load the parts of a profile the web app needs (name, generate, models); the rest is the instance loader's business. */
export function loadProfile(path: string, opts: { videoEnabled?: boolean } = {}): Profile {
  try {
    const raw = mapping(parse(readFileSync(path, "utf8")), "profile");
    if (raw["generate"] === undefined || raw["generate"] === null) throw new ProfileError("profile has no generate section");
    const models = parseModels(raw["models"]);
    const generate = parseGenerate(raw["generate"]);
    const edit = raw["edit"] === undefined || raw["edit"] === null ? null : parseEdit(raw["edit"]);
    const guidance = parseGuidance(raw["guidance"]);
    if (guidance === null && (generate.optional.cfg !== null || edit?.optional.cfg != null)) {
      throw new ProfileError("a cfg param needs a guidance section (min, max, step, default)");
    }
    if (guidance !== null && generate.optional.cfg === null && (edit?.optional.cfg ?? null) === null) {
      throw new ProfileError("a guidance section needs a cfg param in generate or edit");
    }
    const menu = parseMenu(raw["menu"]);
    const styles = parseStyles(raw["styles"], modelEntries(raw["models"]), {
      guidance,
      presets: generate.qualityPresets.map((p) => p.name),
      sizes: generate.sizes.map((z) => z.name),
      resolutions: edit?.resolutions.map((r) => r.name) ?? [],
      negativePrompt: { generate: generate.optional.negativePrompt !== null, edit: (edit?.optional.negativePrompt ?? null) !== null },
      cfg: { generate: generate.optional.cfg !== null, edit: (edit?.optional.cfg ?? null) !== null },
      taken: { generate: takenInputs(generate.params, generate.optional), edit: edit === null ? {} : takenInputs(edit.params, edit.optional) },
      referenceInputs: edit === null ? null : { node: edit.references.encoderNode, prefix: edit.references.inputPrefix },
    });
    checkStyleMenus(raw["styles"], menu);
    return {
      name: required(raw["name"], "name"),
      generate,
      edit,
      guidance,
      styles,
      upscale: parseUpscale(raw["upscale"], modelEntries(raw["models"])),
      video: parseVideo(raw["video"], modelEntries(raw["models"]), opts.videoEnabled === true),
      videoFiles: videoFilesOf(raw["video"]),
      menu,
      models,
    };
  } catch (e) {
    if (e instanceof ProfileError) throw new ProfileError(`${path}: ${e.message}`);
    throw new ProfileError(`${path}: invalid profile (${(e as Error).message})`);
  }
}

/** The file names of a (validated) video section's models; empty without one. */
function videoFilesOf(raw: unknown): string[] {
  const models = (raw as { models?: unknown } | null | undefined)?.models;
  return Array.isArray(models) ? models.map((m) => String((m as { file?: unknown }).file)) : [];
}

/** Set the optional negative prompt and cfg inputs of a copied workflow. */
function applyOptional(copy: ComfyPrompt, optional: OptionalParams, input: { negativePrompt?: string; cfg?: number }): void {
  const put = (ref: ParamRef | null, value: string | number, code: string, what: string): void => {
    if (ref === null) throw new GenerateInputError(code, `this server does not offer ${what}`);
    const node = copy[ref.node];
    if (!node || typeof node.inputs !== "object" || node.inputs === null || !(ref.input in node.inputs)) {
      throw new GenerateInputError("workflow_mismatch", `workflow lacks node ${ref.node} input ${ref.input}`);
    }
    node.inputs[ref.input] = value;
  };
  if (input.negativePrompt !== undefined) put(optional.negativePrompt, input.negativePrompt, "negative_prompt_unavailable", "a negative prompt");
  if (input.cfg !== undefined) put(optional.cfg, input.cfg, "cfg_unavailable", "a guidance setting");
}

/** Fill the workflow template: a deep copy with only the mapped inputs changed. */
export function buildPrompt(profile: Profile, workflowJson: unknown, input: GenerateInput): ComfyPrompt {
  const { generate } = profile;
  const preset = generate.qualityPresets.find((p) => p.name === input.preset);
  if (!preset) throw new GenerateInputError("unknown_preset", "unknown quality preset");
  const size = generate.sizes.find((s) => s.name === input.size);
  if (!size) throw new GenerateInputError("unknown_size", "size is not offered by the profile");
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    throw new GenerateInputError("invalid_prompt", "prompt must be a non-empty string");
  }
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) {
    throw new GenerateInputError("invalid_seed", "seed must be a non-negative integer");
  }
  const copy = structuredClone(workflowJson) as ComfyPrompt;
  const values: Record<ParamKey, string | number> = {
    prompt: input.prompt,
    steps: preset.steps,
    width: size.width,
    height: size.height,
    seed: input.seed,
  };
  for (const key of PARAM_KEYS) {
    const ref = generate.params[key];
    const node = copy[ref.node];
    if (!node || typeof node.inputs !== "object" || node.inputs === null || !(ref.input in node.inputs)) {
      throw new GenerateInputError("workflow_mismatch", `workflow lacks node ${ref.node} input ${ref.input}`);
    }
    node.inputs[ref.input] = values[key];
  }
  applyOptional(copy, generate.optional, input);
  if (input.style) applyStyle(copy, input.style);
  return copy;
}

/**
 * Fill the edit workflow: a deep copy with the mapped inputs set, one LoadImage node per uploaded
 * reference (ids ref_1..ref_N) and each wired to the encoder as `<inputPrefix><k>`.
 */
export function buildEditPrompt(profile: Profile, workflowJson: unknown, input: EditInput): ComfyPrompt {
  const edit = profile.edit;
  if (edit === null) throw new GenerateInputError("edit_unavailable", "this profile has no edit section");
  const preset = profile.generate.qualityPresets.find((p) => p.name === input.preset);
  if (!preset) throw new GenerateInputError("unknown_preset", "unknown quality preset");
  const resolution = edit.resolutions.find((r) => r.name === input.resolution);
  if (!resolution) throw new GenerateInputError("unknown_resolution", "resolution is not offered by the profile");
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    throw new GenerateInputError("invalid_prompt", "prompt must be a non-empty string");
  }
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) {
    throw new GenerateInputError("invalid_seed", "seed must be a non-negative integer");
  }
  if (input.imageNames.length === 0) throw new GenerateInputError("no_references", "at least one reference image is required");
  if (!input.imageNames.every((n) => REFERENCE_NAME.test(n))) {
    throw new GenerateInputError("invalid_reference_name", "a reference file name is not a plain file name");
  }
  const chosenSize = input.size === undefined ? null : edit.sizes.find((z) => z.name === input.size);
  if (chosenSize === undefined) throw new GenerateInputError("unknown_size", "size is not offered by the profile");
  const copy = structuredClone(workflowJson) as ComfyPrompt;
  const values: Record<EditParamKey, string | number> = {
    prompt: input.prompt,
    steps: preset.steps,
    seed: input.seed,
    resolution: resolution.value,
  };
  for (const key of EDIT_PARAM_KEYS) {
    const ref = edit.params[key];
    const node = copy[ref.node];
    if (!node || typeof node.inputs !== "object" || node.inputs === null || !(ref.input in node.inputs)) {
      throw new GenerateInputError("workflow_mismatch", `workflow lacks node ${ref.node} input ${ref.input}`);
    }
    node.inputs[ref.input] = values[key];
  }
  const encoder = copy[edit.references.encoderNode];
  if (!encoder || typeof encoder.inputs !== "object" || encoder.inputs === null) {
    throw new GenerateInputError("workflow_mismatch", `workflow lacks encoder node ${edit.references.encoderNode}`);
  }
  input.imageNames.forEach((name, i) => {
    const id = `${REFERENCE_NODE_PREFIX}${i + 1}`;
    if (id in copy) throw new GenerateInputError("workflow_mismatch", `workflow already has a node ${id}`);
    copy[id] = { class_type: edit.references.nodeClass, inputs: { [edit.references.imageInput]: name } };
    encoder.inputs[`${edit.references.inputPrefix}${i + 1}`] = [id, 0];
  });
  if (chosenSize !== null) applyEditSize(copy, edit, chosenSize);
  applyOptional(copy, edit.optional, input);
  if (input.style) applyStyle(copy, input.style);
  return copy;
}

/** The node id of the empty latent that gives an edit its own size (data-driven, like the style LoRA node). */
export const EDIT_SIZE_NODE = "edit_size_latent";

/** Feed the sampler an empty latent of the chosen size instead of the encoder's (which follows the reference). */
function applyEditSize(copy: ComfyPrompt, edit: EditSpec, size: SizeSpec): void {
  const target = edit.sizeLatent;
  const node = target === null ? undefined : copy[target.node];
  if (target === null || !node || typeof node.inputs !== "object" || node.inputs === null || !(target.input in node.inputs)) {
    throw new GenerateInputError("workflow_mismatch", "workflow lacks the sampler input the edit size feeds");
  }
  if (EDIT_SIZE_NODE in copy) throw new GenerateInputError("workflow_mismatch", `workflow already has a node ${EDIT_SIZE_NODE}`);
  copy[EDIT_SIZE_NODE] = { class_type: "EmptySD3LatentImage", inputs: { width: size.width, height: size.height, batch_size: 1 } };
  node.inputs[target.input] = [EDIT_SIZE_NODE, 0];
}
