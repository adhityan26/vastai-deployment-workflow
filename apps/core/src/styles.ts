import { GenerateInputError, ProfileError } from "./profile-errors.js";
import type { ComfyPrompt } from "./profile.js";

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

export interface StyleSpec {
  readonly id: string;
  readonly title: string;
  readonly modes: readonly StyleMode[];
  readonly lora: {
    /** File name in ComfyUI's loras folder (the profile lists the same file in `models`). */
    readonly file: string;
    /** The node whose MODEL output the loader takes. */
    readonly modelFrom: string;
    /** The node input that is rewired to the loader's output. */
    readonly modelTo: { readonly node: string; readonly input: string };
  };
  readonly params: readonly StyleParam[];
}

export interface ResolvedStyle {
  readonly style: StyleSpec;
  readonly values: Readonly<Record<string, StyleParamValue>>;
}

// Protocol/safety rules, not configuration.
const STYLE_ID = /^[a-z][a-z0-9_]{0,31}$/;
const PARAM_ID = /^[a-z][a-z0-9_]{0,31}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NODE_ID = /^[A-Za-z0-9_]{1,32}$/;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const TITLE_MAX = 60;
const CHOICE_MAX = 64;
const MODES: readonly StyleMode[] = ["generate", "edit"];
const TYPES: readonly StyleParamType[] = ["float", "int", "choice", "bool"];
const STYLE_KEYS = new Set(["id", "title", "modes", "enabled", "lora", "params"]);
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

function parseOne(raw: unknown, modelFiles: readonly string[]): { style: StyleSpec; enabled: boolean } {
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

  const lora = mapping(s["lora"], `style ${id} lora`);
  noUnknownKeys(lora, LORA_KEYS, `style ${id} lora`);
  const file = text(lora["file"], `style ${id} lora file`, 128);
  if (!FILE_NAME.test(file)) throw new ProfileError(`style ${id}: lora file must be one plain file name`);
  const modelFrom = text(lora["model_from"], `style ${id} lora model_from`, 32);
  const to = mapping(lora["model_to"], `style ${id} lora model_to`);
  noUnknownKeys(to, new Set(["node", "input"]), `style ${id} lora model_to`);
  const modelTo = { node: text(to["node"], `style ${id} lora model_to node`, 32), input: text(to["input"], `style ${id} lora model_to input`, 64) };
  if (!NODE_ID.test(modelFrom) || !NODE_ID.test(modelTo.node) || !INPUT_NAME.test(modelTo.input)) {
    throw new ProfileError(`style ${id}: lora model_from/model_to must be plain node ids and an input name`);
  }

  const paramsRaw = s["params"] === undefined ? [] : s["params"];
  if (!Array.isArray(paramsRaw)) throw new ProfileError(`style ${id}: params must be a list`);
  const params = paramsRaw.map((p) => parseParam(p, id));
  if (new Set(params.map((p) => p.id)).size !== params.length) throw new ProfileError(`style ${id}: param ids must be unique`);
  if (params.filter((p) => p.target.kind === "lora_strength").length > 1) throw new ProfileError(`style ${id}: only one param may target lora_strength`);

  const enabled = s["enabled"];
  if (enabled && !modelFiles.some((m) => m.split("/").pop() === file)) {
    throw new ProfileError(`style ${id} is enabled but its LoRA file ${file} is not listed in models`);
  }
  return { style: { id, title, modes: modesRaw as StyleMode[], lora: { file, modelFrom, modelTo }, params }, enabled };
}

/**
 * Parse and validate the profile's `styles:` list. Every entry is validated; only the enabled ones are
 * returned (a disabled style is documented in the profile but never offered, downloaded or accepted).
 * `modelFiles` are the `file` values of the profile's models.
 */
export function parseStyles(raw: unknown, modelFiles: readonly string[]): StyleSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ProfileError("styles must be a list");
  const parsed = raw.map((item) => parseOne(item, modelFiles));
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
  const { modelFrom, modelTo, file } = style.lora;
  if (STYLE_LORA_NODE in prompt) mismatch(`workflow already has a node ${STYLE_LORA_NODE}`);
  if (!prompt[modelFrom]) mismatch(`workflow lacks node ${modelFrom}`);
  const consumer = prompt[modelTo.node];
  if (!consumer || typeof consumer.inputs !== "object" || consumer.inputs === null) mismatch(`workflow lacks node ${modelTo.node}`);
  const link = consumer!.inputs[modelTo.input];
  if (!Array.isArray(link) || link[0] !== modelFrom) mismatch(`node ${modelTo.node} input ${modelTo.input} is not fed by node ${modelFrom}`);

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
  prompt[STYLE_LORA_NODE] = { class_type: LORA_CLASS, inputs: { model: [modelFrom, 0], lora_name: file, strength_model: strength } };
  consumer!.inputs[modelTo.input] = [STYLE_LORA_NODE, 0];
}
