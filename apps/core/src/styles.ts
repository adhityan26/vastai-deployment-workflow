import { onGrid, type GuidanceSpec } from "./guidance.js";
import { GenerateInputError, ProfileError } from "./profile-errors.js";
import { landsIn, type ComfyPrompt, type ModelEntry } from "./profile.js";

// Styles: a LoRA (or other workflow variation) with its own parameters, offered under a mode.
// The profile declares them; the browser only ever sends a style id and parameter values, and
// every value is checked against the profile before it reaches a workflow. Node classes, input
// names and file names inside workflows never come from a request.

export type StyleMode = "generate" | "edit";
export type StyleParamType = "float" | "int" | "choice" | "bool";
export type StyleParamValue = number | string | boolean;

export type ParamTarget = { kind: "lora_strength" } | { kind: "input"; node: string; input: string };

export interface StyleParam {
  readonly id: string;
  readonly title: string;
  readonly type: StyleParamType;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly choices?: readonly string[];
  readonly default: StyleParamValue;
  readonly target: ParamTarget;
}

/** `lora`: a LoRA loader is inserted into the workflow. `preset`: no model at all, only a prompt template and rules. */
export type StyleKind = "lora" | "preset";

/** How many reference images an edit style takes, and what each one is for (in order). */
export interface StyleReferences {
  readonly min: number;
  readonly max: number;
  readonly labels: readonly string[];
}

/**
 * Values the page pre-fills when the style is chosen; the user can change every one of them. The server
 * never applies them on its own: a request carries what the user saw, so what runs is what was sent.
 */
export interface StyleDefaults {
  readonly negativePrompt: string | null;
  readonly cfg: number | null;
  /** A quality preset name (which sets the steps). */
  readonly preset: string | null;
  /** A generate size name; only for a style offered in generate. */
  readonly size: string | null;
  /** An edit resolution name; only for a style offered in edit. */
  readonly resolution: string | null;
}

/** What the rest of the profile offers, for checking a style's defaults against it. */
export interface StyleContext {
  readonly guidance: GuidanceSpec | null;
  readonly presets: readonly string[];
  readonly sizes: readonly string[];
  readonly resolutions: readonly string[];
  /** Per mode: does its workflow map a negative prompt / a cfg. */
  readonly negativePrompt: Readonly<Record<StyleMode, boolean>>;
  readonly cfg: Readonly<Record<StyleMode, boolean>>;
  /**
   * Per mode, the inputs the workflow's own params and knobs already set ("<node>/<input>" to what sets it),
   * and the encoder inputs that receive edit references. A style param may not target any of them: applyStyle
   * runs last and would silently overwrite them.
   */
  readonly taken: Readonly<Record<StyleMode, Readonly<Record<string, string>>>>;
  readonly referenceInputs: { readonly node: string; readonly prefix: string } | null;
}

export interface StyleSpec {
  readonly id: string;
  readonly title: string;
  readonly kind: StyleKind;
  readonly modes: readonly StyleMode[];
  /** Null for a preset. */
  readonly lora: {
    /** File name in ComfyUI's loras folder (the profile lists the same file in `models`). */
    readonly file: string;
    /** The node whose MODEL output the loader takes. */
    readonly modelFrom: string;
    /** The node input that is rewired to the loader's output. */
    readonly modelTo: { readonly node: string; readonly input: string };
  } | null;
  readonly params: readonly StyleParam[];
  /**
   * The prompt the style sends, with exactly one `{prompt}` where the user's optional notes go; null means
   * the user's prompt is sent as it is (and is required).
   */
  readonly promptTemplate: string | null;
  /** The reference images the style needs (edit only); null means the mode's usual rule. */
  readonly references: StyleReferences | null;
  /** A short note the page shows with the style; null for none. */
  readonly hint: string | null;
  readonly defaults: StyleDefaults;
}

export interface ResolvedStyle {
  readonly style: StyleSpec;
  readonly values: Readonly<Record<string, StyleParamValue>>;
}

// Protocol/safety rules, not configuration.
const STYLE_ID = /^[a-z][a-z0-9_]{0,31}$/;
const PARAM_ID = /^[a-z][a-z0-9_]{0,31}$/;
/** One plain file name (no folder): LoRA files and the upscale model are checked against it. */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LORA_FOLDER = "models/loras";
const NODE_ID = /^[A-Za-z0-9_]{1,32}$/;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const TITLE_MAX = 60;
const CHOICE_MAX = 64;
const MODES: readonly StyleMode[] = ["generate", "edit"];
const TYPES: readonly StyleParamType[] = ["float", "int", "choice", "bool"];
const STYLE_KEYS = new Set(["id", "title", "kind", "modes", "enabled", "lora", "params", "prompt_template", "references", "hint", "defaults"]);
const DEFAULT_KEYS = new Set(["negative_prompt", "cfg", "preset", "size", "resolution"]);
/** Longest default negative prompt; the request limit (GENERATE_MAX_NEGATIVE_PROMPT_CHARS) is checked at startup. */
const DEFAULT_NEGATIVE_MAX = 4000;
/** A profile that offers nothing a default could name (every default is then refused). */
const BARE_CONTEXT: StyleContext = {
  guidance: null,
  presets: [],
  sizes: [],
  resolutions: [],
  negativePrompt: { generate: false, edit: false },
  cfg: { generate: false, edit: false },
  taken: { generate: {}, edit: {} },
  referenceInputs: null,
};
const NO_DEFAULTS: StyleDefaults = { negativePrompt: null, cfg: null, preset: null, size: null, resolution: null };
const REFERENCE_KEYS = new Set(["min", "max", "labels"]);
const KINDS: readonly StyleKind[] = ["lora", "preset"];
/** The placeholder of a prompt template; replaced once, never re-expanded. */
export const PROMPT_PLACEHOLDER = "{prompt}";
const TEMPLATE_MAX = 4000;
const HINT_MAX = 300;
const LABEL_MAX = 40;
const REFERENCES_MAX = 16;
const LORA_KEYS = new Set(["file", "model_from", "model_to"]);
const PARAM_KEYS = new Set(["id", "title", "type", "min", "max", "step", "choices", "default", "target"]);
/** The node id of the LoRA loader the web app inserts. */
export const STYLE_LORA_NODE = "style_lora";
const LORA_CLASS = "LoraLoaderModelOnly";
const STEP_TOLERANCE = 1e-6;

function mapping(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProfileError(`${what} must be a mapping`);
  return value as Record<string, unknown>;
}

function noUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, what: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length > 0) throw new ProfileError(`${what} has unknown keys: ${unknown.sort().join(", ")}`);
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new ProfileError(`${what} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ProfileError(`${what} must be a number`);
  return value;
}

function parseTarget(raw: unknown, what: string): ParamTarget {
  if (raw === "lora_strength") return { kind: "lora_strength" };
  const t = mapping(raw, `${what} target (use lora_strength or {node, input})`);
  noUnknownKeys(t, new Set(["node", "input"]), `${what} target`);
  const node = text(t["node"], `${what} target node`, 32);
  const input = text(t["input"], `${what} target input`, 64);
  if (!NODE_ID.test(node) || !INPUT_NAME.test(input)) throw new ProfileError(`${what} target is not a plain node id and input name`);
  return { kind: "input", node, input };
}

function parseParam(raw: unknown, styleId: string): StyleParam {
  const p = mapping(raw, `style ${styleId} param`);
  noUnknownKeys(p, PARAM_KEYS, `style ${styleId} param`);
  const id = text(p["id"], `style ${styleId} param id`, 32);
  if (!PARAM_ID.test(id)) throw new ProfileError(`style ${styleId}: param id '${id}' is not a plain lower-case identifier`);
  const what = `style ${styleId} param ${id}`;
  const title = text(p["title"], `${what} title`, TITLE_MAX);
  const type = p["type"] as StyleParamType;
  if (!TYPES.includes(type)) throw new ProfileError(`${what} type must be one of ${TYPES.join(", ")}`);
  const target = parseTarget(p["target"], what);
  if (target.kind === "lora_strength" && type !== "float") throw new ProfileError(`${what}: lora_strength needs a float param`);
  const common = { id, title, type, target };
  if (type === "float" || type === "int") {
    const min = finite(p["min"], `${what} min`);
    const max = finite(p["max"], `${what} max`);
    const step = finite(p["step"], `${what} step`);
    if (min >= max) throw new ProfileError(`${what}: min must be below max`);
    if (step <= 0) throw new ProfileError(`${what}: step must be positive`);
    if (type === "int" && ![min, max, step].every(Number.isInteger)) throw new ProfileError(`${what}: an int param needs whole min, max and step`);
    const def = finite(p["default"], `${what} default`);
    if (def < min || def > max) throw new ProfileError(`${what}: default is outside min..max`);
    if (type === "int" && !Number.isInteger(def)) throw new ProfileError(`${what}: default must be a whole number`);
    return { ...common, min, max, step, default: def };
  }
  if (type === "choice") {
    const list = p["choices"];
    if (!Array.isArray(list) || list.length === 0) throw new ProfileError(`${what}: choices must be a non-empty list`);
    const choices = list.map((c) => text(c, `${what} choice`, CHOICE_MAX));
    if (new Set(choices).size !== choices.length) throw new ProfileError(`${what}: choices must be unique`);
    if (typeof p["default"] !== "string" || !choices.includes(p["default"])) throw new ProfileError(`${what}: default must be one of the choices`);
    return { ...common, choices, default: p["default"] };
  }
  if (typeof p["default"] !== "boolean") throw new ProfileError(`${what}: default must be true or false`);
  return { ...common, default: p["default"] };
}

function parseDefaults(raw: unknown, id: string, modes: readonly StyleMode[], enabled: boolean, ctx: StyleContext): StyleDefaults {
  if (raw === undefined) return NO_DEFAULTS;
  const d = mapping(raw, `style ${id} defaults`);
  noUnknownKeys(d, DEFAULT_KEYS, `style ${id} defaults`);
  const what = `style ${id} defaults`;
  // An enabled style's default must be usable in every mode it is offered in, or the page would pre-fill a value
  // the server then refuses. A disabled style skips only that mapping check (so a profile may drop a knob without
  // first editing every sample style); its values are still checked (cfg on the guidance grid, names offered).
  const everyMode = (offered: Readonly<Record<StyleMode, boolean>>, knob: string): void => {
    if (!enabled) return;
    const missing = modes.filter((m) => !offered[m]);
    if (missing.length > 0) throw new ProfileError(`${what}: ${knob} is not mapped in the ${missing.join(", ")} workflow`);
  };
  const name = (key: string, list: readonly string[], mode: StyleMode | null): string | null => {
    if (d[key] === undefined) return null;
    if (mode !== null && !modes.includes(mode)) throw new ProfileError(`${what}: ${key} is only for a style offered in ${mode}`);
    const v = text(d[key], `${what} ${key}`, CHOICE_MAX);
    if (!list.includes(v)) throw new ProfileError(`${what}: ${key} '${v}' is not offered by the profile`);
    return v;
  };
  let negativePrompt: string | null = null;
  if (d["negative_prompt"] !== undefined) {
    negativePrompt = text(d["negative_prompt"], `${what} negative_prompt`, DEFAULT_NEGATIVE_MAX).trim();
    everyMode(ctx.negativePrompt, "negative_prompt");
  }
  let cfg: number | null = null;
  if (d["cfg"] !== undefined) {
    const v = finite(d["cfg"], `${what} cfg`);
    if (ctx.guidance === null || !onGrid(ctx.guidance, v)) throw new ProfileError(`${what}: cfg must lie on the profile's guidance range and step`);
    everyMode(ctx.cfg, "cfg");
    cfg = v;
  }
  return {
    negativePrompt,
    cfg,
    preset: name("preset", ctx.presets, null),
    size: name("size", ctx.sizes, "generate"),
    resolution: name("resolution", ctx.resolutions, "edit"),
  };
}

function parseOne(raw: unknown, models: readonly ModelEntry[], ctx: StyleContext): { style: StyleSpec; enabled: boolean } {
  const s = mapping(raw, "style");
  noUnknownKeys(s, STYLE_KEYS, "style");
  const id = text(s["id"], "style id", 32);
  if (!STYLE_ID.test(id)) throw new ProfileError(`style id '${id}' is not a plain lower-case identifier`);
  const title = text(s["title"], `style ${id} title`, TITLE_MAX);
  const modesRaw = s["modes"];
  if (!Array.isArray(modesRaw) || modesRaw.length === 0 || !modesRaw.every((m) => MODES.includes(m as StyleMode)) || new Set(modesRaw).size !== modesRaw.length) {
    throw new ProfileError(`style ${id}: modes must be a non-empty list of distinct values from ${MODES.join(", ")}`);
  }
  if (typeof s["enabled"] !== "boolean") throw new ProfileError(`style ${id}: enabled must be true or false`);
  const kind = (s["kind"] ?? "lora") as StyleKind;
  if (!KINDS.includes(kind)) throw new ProfileError(`style ${id}: kind must be one of ${KINDS.join(", ")}`);

  let lora: StyleSpec["lora"] = null;
  if (kind === "preset") {
    if (s["lora"] !== undefined) throw new ProfileError(`style ${id}: a preset has no lora`);
  } else {
    const l = mapping(s["lora"], `style ${id} lora`);
    noUnknownKeys(l, LORA_KEYS, `style ${id} lora`);
    const file = text(l["file"], `style ${id} lora file`, 128);
    if (!FILE_NAME.test(file)) throw new ProfileError(`style ${id}: lora file must be one plain file name`);
    const modelFrom = text(l["model_from"], `style ${id} lora model_from`, 32);
    const to = mapping(l["model_to"], `style ${id} lora model_to`);
    noUnknownKeys(to, new Set(["node", "input"]), `style ${id} lora model_to`);
    const modelTo = { node: text(to["node"], `style ${id} lora model_to node`, 32), input: text(to["input"], `style ${id} lora model_to input`, 64) };
    if (!NODE_ID.test(modelFrom) || !NODE_ID.test(modelTo.node) || !INPUT_NAME.test(modelTo.input)) {
      throw new ProfileError(`style ${id}: lora model_from/model_to must be plain node ids and an input name`);
    }
    lora = { file, modelFrom, modelTo };
  }

  const paramsRaw = s["params"] === undefined ? [] : s["params"];
  if (!Array.isArray(paramsRaw)) throw new ProfileError(`style ${id}: params must be a list`);
  const params = paramsRaw.map((p) => parseParam(p, id));
  if (new Set(params.map((p) => p.id)).size !== params.length) throw new ProfileError(`style ${id}: param ids must be unique`);
  if (params.filter((p) => p.target.kind === "lora_strength").length > 1) throw new ProfileError(`style ${id}: only one param may target lora_strength`);
  if (lora === null && params.some((p) => p.target.kind === "lora_strength")) throw new ProfileError(`style ${id}: a preset has no LoRA strength`);
  for (const p of params) {
    if (p.target.kind !== "input") continue;
    const { node, input } = p.target;
    for (const mode of modesRaw as StyleMode[]) {
      const owner = ctx.taken[mode][`${node}/${input}`];
      const refs = ctx.referenceInputs;
      const setter = owner ?? (mode === "edit" && refs !== null && node === refs.node && input.startsWith(refs.prefix) ? "reference images" : undefined);
      if (setter !== undefined) {
        throw new ProfileError(`style ${id} param ${p.id} targets node ${node} input ${input}, which the ${mode} workflow's ${setter} already set${setter === "reference images" ? "" : "s"}`);
      }
    }
  }

  let promptTemplate: string | null = null;
  if (s["prompt_template"] !== undefined) {
    promptTemplate = text(s["prompt_template"], `style ${id} prompt_template`, TEMPLATE_MAX);
    if (promptTemplate.split(PROMPT_PLACEHOLDER).length !== 2) throw new ProfileError(`style ${id}: prompt_template must contain ${PROMPT_PLACEHOLDER} exactly once`);
  }

  let references: StyleReferences | null = null;
  if (s["references"] !== undefined) {
    if (!(modesRaw as StyleMode[]).every((m) => m === "edit")) throw new ProfileError(`style ${id}: references are only for edit styles`);
    const r = mapping(s["references"], `style ${id} references`);
    noUnknownKeys(r, REFERENCE_KEYS, `style ${id} references`);
    const min = r["min"];
    const max = r["max"];
    if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) < 1 || (min as number) > (max as number) || (max as number) > REFERENCES_MAX) {
      throw new ProfileError(`style ${id}: references min and max must be whole numbers with 1 <= min <= max <= ${REFERENCES_MAX}`);
    }
    const labelsRaw = r["labels"] ?? [];
    if (!Array.isArray(labelsRaw) || labelsRaw.length > (max as number)) throw new ProfileError(`style ${id}: references labels must be a list of at most max entries`);
    const labels = labelsRaw.map((l) => text(l, `style ${id} references label`, LABEL_MAX));
    references = { min: min as number, max: max as number, labels };
  }
  const hint = s["hint"] === undefined ? null : text(s["hint"], `style ${id} hint`, HINT_MAX);
  if (kind === "preset" && promptTemplate === null && params.length === 0) throw new ProfileError(`style ${id}: a preset needs a prompt_template or params`);

  const enabled = s["enabled"];
  const defaults = parseDefaults(s["defaults"], id, modesRaw as StyleMode[], enabled, ctx);

  if (enabled && lora !== null) {
    const entry = models.find((m) => m.file.split("/").pop() === lora.file);
    if (entry === undefined) throw new ProfileError(`style ${id} is enabled but its LoRA file ${lora.file} is not listed in models`);
    // LoraLoaderModelOnly only lists ComfyUI's loras folder: anywhere else the style would fail at run time.
    if (!landsIn(entry, LORA_FOLDER)) throw new ProfileError(`style ${id}: the models entry for ${lora.file} must have dest ${LORA_FOLDER}/`);
  }
  return { style: { id, title, kind, modes: modesRaw as StyleMode[], lora, params, promptTemplate, references, hint, defaults }, enabled };
}

/**
 * Parse and validate the profile's `styles:` list. Every entry is validated; only the enabled ones are
 * returned (a disabled style is documented in the profile but never offered, downloaded or accepted).
 * `models` are the profile's model entries (file and dest); `ctx` is what a style's defaults are checked against.
 */
export function parseStyles(raw: unknown, models: readonly ModelEntry[], ctx: StyleContext = BARE_CONTEXT): StyleSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ProfileError("styles must be a list");
  const parsed = raw.map((item) => parseOne(item, models, ctx));
  const ids = parsed.map((p) => p.style.id);
  if (new Set(ids).size !== ids.length) throw new ProfileError("style ids must be unique");
  return parsed.filter((p) => p.enabled).map((p) => p.style);
}

function checkValue(param: StyleParam, value: unknown): StyleParamValue {
  const bad = (): never => {
    throw new GenerateInputError("invalid_style_param", `style parameter '${param.id}' is not valid`);
  };
  switch (param.type) {
    case "float":
    case "int": {
      if (typeof value !== "number" || !Number.isFinite(value)) return bad();
      if (param.type === "int" && !Number.isInteger(value)) return bad();
      const { min, max, step } = param as Required<Pick<StyleParam, "min" | "max" | "step">>;
      if (value < min || value > max) return bad();
      const steps = (value - min) / step;
      if (Math.abs(steps - Math.round(steps)) > STEP_TOLERANCE) return bad();
      return value;
    }
    case "choice":
      return typeof value === "string" && param.choices!.includes(value) ? value : bad();
    case "bool":
      return typeof value === "boolean" ? value : bad();
  }
}

/**
 * Check the style a request asks for against the profile. Null when none is asked for; otherwise the
 * style and the value of every one of its params (a param that is not sent takes its default).
 */
export function resolveStyle(styles: readonly StyleSpec[], mode: StyleMode, raw: unknown): ResolvedStyle | null {
  if (raw === undefined || raw === null) return null;
  const bad = (code: string, message: string): never => {
    throw new GenerateInputError(code, message);
  };
  if (typeof raw !== "object" || Array.isArray(raw)) return bad("invalid_style", "style must be an object with an id");
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((k) => k !== "id" && k !== "params")) return bad("invalid_style", "style may only have an id and params");
  if (typeof body["id"] !== "string") return bad("invalid_style", "style id must be text");
  const style = styles.find((s) => s.id === body["id"]);
  if (!style) return bad("unknown_style", "this style is not offered");
  if (!style.modes.includes(mode)) return bad("style_not_for_mode", "this style cannot be used here");
  const sent = body["params"] ?? {};
  if (typeof sent !== "object" || Array.isArray(sent)) return bad("invalid_style", "style params must be an object");
  const known = new Set(style.params.map((p) => p.id));
  const stray = Object.keys(sent).find((k) => !known.has(k));
  if (stray !== undefined) return bad("unknown_style_param", "the style has no such parameter");
  const values: Record<string, StyleParamValue> = {};
  for (const param of style.params) {
    const given = (sent as Record<string, unknown>)[param.id];
    values[param.id] = given === undefined ? param.default : checkValue(param, given);
  }
  return { style, values };
}

/**
 * Put the style into a workflow (a deep copy made by the caller): insert the LoRA loader between its
 * source and consumer nodes and set the parameter values. Refuses a workflow that lacks what the
 * profile says is there.
 */
export function applyStyle(prompt: ComfyPrompt, resolved: ResolvedStyle): void {
  const { style, values } = resolved;
  const mismatch = (what: string): never => {
    throw new GenerateInputError("workflow_mismatch", `style ${style.id}: ${what}`);
  };
  const lora = style.lora;
  let consumer: ComfyPrompt[string] | undefined;
  if (lora !== null) {
    const { modelFrom, modelTo } = lora;
    if (STYLE_LORA_NODE in prompt) mismatch(`workflow already has a node ${STYLE_LORA_NODE}`);
    if (!prompt[modelFrom]) mismatch(`workflow lacks node ${modelFrom}`);
    consumer = prompt[modelTo.node];
    if (!consumer || typeof consumer.inputs !== "object" || consumer.inputs === null) mismatch(`workflow lacks node ${modelTo.node}`);
    const link = consumer!.inputs[modelTo.input];
    if (!Array.isArray(link) || link[0] !== modelFrom) mismatch(`node ${modelTo.node} input ${modelTo.input} is not fed by node ${modelFrom}`);
  }

  let strength = 1;
  for (const param of style.params) {
    const value = values[param.id]!;
    if (param.target.kind === "lora_strength") {
      strength = value as number;
      continue;
    }
    const node = prompt[param.target.node];
    if (!node || typeof node.inputs !== "object" || node.inputs === null || !(param.target.input in node.inputs)) {
      mismatch(`workflow lacks node ${param.target.node} input ${param.target.input}`);
    }
    node!.inputs[param.target.input] = value;
  }
  // Strength 0 is "prompt only": the loader is left out entirely, so the workflow is exactly the base one and
  // does not depend on the LoRA file (ComfyUI would still check the file name of a loader at strength 0).
  if (lora === null || strength === 0) return;
  prompt[STYLE_LORA_NODE] = { class_type: LORA_CLASS, inputs: { model: [lora.modelFrom, 0], lora_name: lora.file, strength_model: strength } };
  consumer!.inputs[lora.modelTo.input] = [STYLE_LORA_NODE, 0];
}

/**
 * The prompt a job sends: the user's prompt as it is, or, for a style with a prompt template, the
 * template with the user's optional notes in place of `{prompt}` (trimmed; nothing when empty). The
 * notes are inserted as plain text exactly once: a `{prompt}` or `$&` inside them stays literal. The
 * caller checks the length of the result.
 */
export function stylePrompt(resolved: ResolvedStyle | null, userPrompt: unknown): unknown {
  const template = resolved?.style.promptTemplate ?? null;
  if (template === null) return userPrompt;
  if (userPrompt !== undefined && userPrompt !== null && typeof userPrompt !== "string") {
    throw new GenerateInputError("invalid_prompt", "prompt must be a string");
  }
  const notes = typeof userPrompt === "string" ? userPrompt.trim() : "";
  const at = template.indexOf(PROMPT_PLACEHOLDER);
  const before = template.slice(0, at);
  const after = template.slice(at + PROMPT_PLACEHOLDER.length);
  if (notes !== "") return `${before}${notes}${after}`.trim();
  // No notes: drop the placeholder and the whitespace around it, keeping one space where there was any.
  const left = before.replace(/\s+$/, "");
  const right = after.replace(/^\s+/, "");
  const gap = left !== "" && right !== "" && (left.length !== before.length || right.length !== after.length) ? " " : "";
  return `${left}${gap}${right}`.trim();
}

/** Refuse an edit whose number of references does not match what the style needs. */
export function checkStyleReferences(resolved: ResolvedStyle | null, count: number): void {
  const rule = resolved?.style.references ?? null;
  if (rule === null || (count >= rule.min && count <= rule.max)) return;
  const needs = rule.min === rule.max ? `exactly ${rule.min}` : `between ${rule.min} and ${rule.max}`;
  throw new GenerateInputError("style_reference_count", `this style needs ${needs} reference images`);
}
