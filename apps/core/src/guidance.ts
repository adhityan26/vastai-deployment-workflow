import { GenerateInputError, ProfileError } from "./profile-errors.js";

// Guidance (the sampler's cfg) and the negative prompt: both are optional knobs the profile maps to workflow
// inputs. The profile states the allowed range; the request is checked against it.

export interface GuidanceSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
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

/** The cfg for a job: the request's value, else the recipe's, else null (the workflow keeps its own). */
export function resolveCfg(guidance: GuidanceSpec | null, requested: unknown, recipeCfg: number | null): number | null {
  if (requested !== undefined && requested !== null) {
    if (guidance === null) throw new GenerateInputError("cfg_unavailable", "this server does not offer a guidance setting");
    if (typeof requested !== "number" || !onGrid(guidance, requested)) {
      throw new GenerateInputError("invalid_cfg", `guidance must be a number from ${guidance.min} to ${guidance.max} in steps of ${guidance.step}`);
    }
    return requested;
  }
  return recipeCfg;
}

/** The negative prompt for a job: the recipe's text then the user's, or undefined when both are empty. */
export function resolveNegative(recipeNegative: string, requested: unknown, maxChars: number): string | undefined {
  if (requested !== undefined && requested !== null && typeof requested !== "string") {
    throw new GenerateInputError("invalid_negative_prompt", "negative prompt must be text");
  }
  const user = typeof requested === "string" ? requested.trim() : "";
  if (user.length > maxChars) throw new GenerateInputError("negative_prompt_too_long", `negative prompt exceeds ${maxChars} characters`);
  const parts = [recipeNegative.trim(), user].filter((p) => p !== "");
  return parts.length === 0 ? undefined : parts.join(", ");
}
