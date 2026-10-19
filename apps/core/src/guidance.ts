import { GenerateInputError, ProfileError } from "./profile-errors.js";

// Guidance (the sampler's cfg) and the negative prompt: two optional knobs the profile maps to workflow
// inputs per mode (`generate.params` / `edit.params`). The profile states the allowed cfg range; every
// request value is checked against it and against the mode's mapping. A request that leaves a knob out
// gets exactly the workflow's own value.

export interface GuidanceSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** What the page shows when nothing is chosen; must equal the cfg in the workflows (checked at startup). */
  readonly default: number;
}

/** Which knobs a mode's workflow accepts (the profile maps an input for it). */
export interface TuningSupport {
  readonly negativePrompt: boolean;
  readonly cfg: boolean;
}

/** The checked knobs of one request; a missing member leaves the workflow's own value. */
export interface Tuning {
  negativePrompt?: string;
  cfg?: number;
}

const STEP_TOLERANCE = 1e-6;
const KEYS = new Set(["min", "max", "step", "default"]);

export function parseGuidance(raw: unknown): GuidanceSpec | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ProfileError("guidance must be a mapping");
  const g = raw as Record<string, unknown>;
  const unknown = Object.keys(g).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) throw new ProfileError(`guidance has unknown keys: ${unknown.sort().join(", ")}`);
  const num = (key: string): number => {
    const v = g[key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new ProfileError(`guidance ${key} must be a number`);
    return v;
  };
  const spec = { min: num("min"), max: num("max"), step: num("step"), default: num("default") };
  if (spec.min <= 0 || spec.max < spec.min || spec.step <= 0) throw new ProfileError("guidance needs 0 < min <= max and step > 0");
  if (!onGrid(spec, spec.default)) throw new ProfileError("guidance default must be inside min..max and on the step grid");
  return spec;
}

export function onGrid(spec: GuidanceSpec, value: number): boolean {
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return false;
  const steps = (value - spec.min) / spec.step;
  return Math.abs(steps - Math.round(steps)) <= STEP_TOLERANCE;
}

/**
 * Check the negative prompt and cfg of a request for one mode. Absent (undefined or null) and an empty
 * or blank negative prompt leave the workflow's value. A value for a knob the mode's workflow does not
 * map is refused (`negative_prompt_unavailable`, `cfg_unavailable`), never dropped silently.
 */
export function resolveTuning(
  guidance: GuidanceSpec | null,
  support: TuningSupport,
  input: { negativePrompt?: unknown; cfg?: unknown },
  maxNegativeChars: number,
): Tuning {
  const out: Tuning = {};
  const neg = input.negativePrompt;
  if (neg !== undefined && neg !== null) {
    if (typeof neg !== "string") throw new GenerateInputError("invalid_negative_prompt", "negative prompt must be text");
    const text = neg.trim();
    if (text !== "") {
      if (!support.negativePrompt) throw new GenerateInputError("negative_prompt_unavailable", "this mode does not take a negative prompt");
      if (text.length > maxNegativeChars) throw new GenerateInputError("negative_prompt_too_long", `negative prompt exceeds ${maxNegativeChars} characters`);
      out.negativePrompt = text;
    }
  }
  const cfg = input.cfg;
  if (cfg !== undefined && cfg !== null) {
    if (!support.cfg || guidance === null) throw new GenerateInputError("cfg_unavailable", "this mode does not take a guidance value");
    if (typeof cfg !== "number" || !onGrid(guidance, cfg)) {
      throw new GenerateInputError("invalid_cfg", `guidance must be a number from ${guidance.min} to ${guidance.max} in steps of ${guidance.step}`);
    }
    out.cfg = cfg;
  }
  return out;
}
