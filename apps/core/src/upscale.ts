import { GenerateInputError, ProfileError } from "./profile-errors.js";
import type { ComfyPrompt } from "./profile.js";

// Upscale mode: one image in, the same image bigger out, through an upscale model. Declared in the
// profile's `upscale:` section; OFF until `enabled: true` (the model file must be pinned first).

export interface ScaleOption {
  readonly name: string;
  /** What goes into the workflow's scale input (the model upscales by a fixed factor; this trims it). */
  readonly value: number;
  /** The final enlargement factor: model factor times value. Bounds the result size before anything is sent. */
  readonly factor: number;
}

export interface UpscaleSpec {
  readonly workflow: string;
  /** The profile `models` file the workflow's upscale model loader reads. */
  readonly model: string;
  /**
   * The model's own enlargement (ImageUpscaleWithModel always makes it, before the scale trims it):
   * the intermediate image is width x height x modelFactor squared.
   */
  readonly modelFactor: number;
  /** The loader input that takes the model file name (set from `model`, so the file is named once). */
  readonly modelLoader: { readonly node: string; readonly input: string };
  readonly image: { readonly node: string; readonly input: string };
  readonly scale: { readonly node: string; readonly input: string };
  readonly scales: readonly ScaleOption[];
}

const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,100}\.json$/;
const NODE_ID = /^[A-Za-z0-9_]{1,32}$/;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const SCALE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._x-]{0,15}$/;
const KEYS = new Set(["enabled", "workflow", "model", "model_factor", "model_loader", "image", "scale", "scales"]);
const MAX_FACTOR = 16;
const MAX_MODEL_FACTOR = 8;
// Tolerance when checking a declared factor against model_factor x value (values like 0.5 are exact; 1/3 is not).
const FACTOR_EPSILON = 1e-9;

const mapping = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ProfileError(`${what} must be a mapping`);
  return v as Record<string, unknown>;
};

function ref(raw: unknown, what: string): { node: string; input: string } {
  const m = mapping(raw, what);
  const node = m["node"];
  const input = m["input"];
  if (typeof node !== "string" || !NODE_ID.test(node)) throw new ProfileError(`${what} node is not a plain node id`);
  if (typeof input !== "string" || !INPUT_NAME.test(input)) throw new ProfileError(`${what} input is not a plain input name`);
  return { node, input };
}

/** The upscale section when it is enabled, else null. Everything is validated even when disabled. */
export function parseUpscale(raw: unknown, modelFiles: readonly string[]): UpscaleSpec | null {
  if (raw === undefined || raw === null) return null;
  const m = mapping(raw, "upscale");
  const unknown = Object.keys(m).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) throw new ProfileError(`upscale has unknown keys: ${unknown.sort().join(", ")}`);
  if (typeof m["enabled"] !== "boolean") throw new ProfileError("upscale enabled must be true or false");
  const workflow = m["workflow"];
  if (typeof workflow !== "string" || !WORKFLOW_NAME.test(workflow)) throw new ProfileError("upscale workflow is not a valid workflow name");
  const model = m["model"];
  if (typeof model !== "string" || model === "") throw new ProfileError("upscale model must be a file name");
  const modelFactor = m["model_factor"];
  if (typeof modelFactor !== "number" || !Number.isInteger(modelFactor) || modelFactor < 1 || modelFactor > MAX_MODEL_FACTOR) {
    throw new ProfileError(`upscale model_factor must be the model's whole enlargement factor (1 to ${MAX_MODEL_FACTOR})`);
  }
  const list = m["scales"];
  if (!Array.isArray(list) || list.length === 0) throw new ProfileError("upscale scales must be a non-empty list");
  const scales = list.map((item): ScaleOption => {
    const s = mapping(item, "upscale scale");
    const { name, value } = s;
    if (typeof name !== "string" || !SCALE_NAME.test(name)) throw new ProfileError("upscale scale name is not plain");
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new ProfileError(`upscale scale ${name} value must be a positive number`);
    // The final enlargement follows from the model and the trim; a declared `factor` must agree with it.
    const factor = modelFactor * value;
    if (factor > MAX_FACTOR) throw new ProfileError(`upscale scale ${name} factor must be between 0 and ${MAX_FACTOR}`);
    const declared = s["factor"];
    if (declared !== undefined && (typeof declared !== "number" || Math.abs(declared - factor) > FACTOR_EPSILON)) {
      throw new ProfileError(`upscale scale ${name} factor must equal model_factor x value (${factor})`);
    }
    return { name, value, factor };
  });
  if (new Set(scales.map((s) => s.name)).size !== scales.length) throw new ProfileError("upscale scale names must be unique");
  const spec: UpscaleSpec = { workflow, model, modelFactor, modelLoader: ref(m["model_loader"], "upscale model_loader"), image: ref(m["image"], "upscale image"), scale: ref(m["scale"], "upscale scale input"), scales };
  if (!m["enabled"]) return null;
  if (!modelFiles.some((f) => f.split("/").pop() === model)) throw new ProfileError(`upscale model ${model} is not listed in models`);
  return spec;
}

/** Fill the upscale workflow: the uploaded file name and the chosen scale go into their mapped inputs. */
export function buildUpscalePrompt(spec: UpscaleSpec, workflowJson: unknown, imageName: string, scaleName: string): ComfyPrompt {
  const scale = spec.scales.find((s) => s.name === scaleName);
  if (!scale) throw new GenerateInputError("unknown_scale", "scale is not offered by the profile");
  const copy = structuredClone(workflowJson) as ComfyPrompt;
  const set = (target: { node: string; input: string }, value: string | number): void => {
    const node = copy[target.node];
    if (!node || typeof node.inputs !== "object" || node.inputs === null || !(target.input in node.inputs)) {
      throw new GenerateInputError("workflow_mismatch", `workflow lacks node ${target.node} input ${target.input}`);
    }
    node.inputs[target.input] = value;
  };
  set(spec.modelLoader, spec.model.split("/").pop()!);
  set(spec.image, imageName);
  set(spec.scale, scale.value);
  return copy;
}
