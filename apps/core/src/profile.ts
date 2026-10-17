import { readFileSync } from "node:fs";
import { parse } from "yaml";

// Same rule as vastcomfy_agent.workflows.NAME_RE (protocol rule, not configuration).
const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,100}\.json$/;
const PARAM_KEYS = ["prompt", "steps", "width", "height", "seed"] as const;
type ParamKey = (typeof PARAM_KEYS)[number];

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
export interface GenerateSpec {
  readonly workflow: string;
  readonly params: Readonly<Record<ParamKey, ParamRef>>;
  readonly qualityPresets: readonly QualityPreset[];
  readonly sizes: readonly SizeSpec[];
}
export interface Profile {
  readonly name: string;
  readonly generate: GenerateSpec;
}

export type ComfyPrompt = Record<string, { class_type?: string; inputs: Record<string, unknown> }>;

export interface GenerateInput {
  prompt: string;
  preset: string;
  size: string;
  seed: number;
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export class GenerateInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GenerateInputError";
    this.code = code;
  }
}

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

function parseGenerate(raw: unknown): GenerateSpec {
  const gen = mapping(raw, "generate");
  const workflow = required(gen["workflow"], "generate workflow");
  if (!WORKFLOW_NAME.test(workflow)) throw new ProfileError(`generate workflow is not a valid workflow name: ${workflow}`);

  const paramsRaw = mapping(gen["params"], "generate params");
  const unknown = Object.keys(paramsRaw).filter((k) => !(PARAM_KEYS as readonly string[]).includes(k));
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
  const sizes: SizeSpec[] = [];
  for (const item of sizesRaw) {
    const entry = mapping(item, "size");
    const name = required(entry["name"], "size name");
    const width = positiveInt(entry["width"], `size ${name} width`);
    const height = positiveInt(entry["height"], `size ${name} height`);
    if (width % 32 !== 0 || height % 32 !== 0) {
      throw new ProfileError(`size ${name} must be a multiple of 32: ${width}x${height}`);
    }
    if (sizes.some((s) => s.name === name)) throw new ProfileError(`duplicate size name '${name}'`);
    sizes.push({ name, width, height });
  }
  return { workflow, params, qualityPresets, sizes };
}

/** Load the parts of a profile the web app needs (name, generate); the rest is the instance loader's business. */
export function loadProfile(path: string): Profile {
  try {
    const raw = mapping(parse(readFileSync(path, "utf8")), "profile");
    if (raw["generate"] === undefined || raw["generate"] === null) throw new ProfileError("profile has no generate section");
    return { name: required(raw["name"], "name"), generate: parseGenerate(raw["generate"]) };
  } catch (e) {
    if (e instanceof ProfileError) throw new ProfileError(`${path}: ${e.message}`);
    throw new ProfileError(`${path}: invalid profile (${(e as Error).message})`);
  }
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
  return copy;
}
