import { randomBytes } from "node:crypto";
import type { ComfyClient } from "./comfy.js";
import type { AppsConfig } from "./config.js";
import { buildEditPrompt, buildPrompt, GenerateInputError, type Profile } from "./profile.js";
import { buildUpscalePrompt } from "./upscale.js";
import { resolveStyle } from "./styles.js";
import { decodeReferences, referenceLimits, type ReferenceType } from "./references.js";

export class GenerateTimeout extends Error {
  constructor(message = "generation timed out") {
    super(message);
    this.name = "GenerateTimeout";
  }
}

/** ComfyUI reported an error (or produced nothing); the message is short and safe to show. */
export class GenerateFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateFailed";
  }
}

export interface GenerateDeps {
  comfy: Pick<ComfyClient, "submit" | "history">;
  profile: Profile;
  /** The workflow template JSON from the profile (never from the request). */
  template: unknown;
  cfg: AppsConfig;
  /** Uniform random in [0, 1); injectable for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface GenerateRequest {
  prompt: string;
  preset: string;
  size: string;
  seed?: number;
  /** Optional `{id, params}` of one of the profile's styles; checked against the profile. */
  style?: unknown;
}

export interface ResultImage {
  filename: string;
  subfolder: string;
  type: "input" | "output" | "temp";
}

const MAX_SEED = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const VIEW_TYPES = ["input", "output", "temp"];
const MESSAGE_MAX = 300;

function intKey(cfg: AppsConfig, key: string): number {
  const v = cfg[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`config ${key} must be a positive integer`);
  return v;
}

/** The prompt and seed checks shared by generate and edit; returns the seed to use. */
function checkPromptAndSeed(cfg: AppsConfig, random: (() => number) | undefined, input: { prompt: unknown; seed?: unknown }): number {
  const maxChars = intKey(cfg, "generateMaxPromptChars");
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    throw new GenerateInputError("invalid_prompt", "prompt must be a non-empty string");
  }
  if (input.prompt.length > maxChars) {
    throw new GenerateInputError("prompt_too_long", `prompt exceeds ${maxChars} characters`);
  }
  if (input.seed === undefined || input.seed === null) {
    const r = (random ?? Math.random)();
    return Math.min(MAX_SEED, Math.max(0, Math.floor(r * (MAX_SEED + 1))));
  }
  if (typeof input.seed !== "number" || !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > MAX_SEED) {
    throw new GenerateInputError("invalid_seed", "seed must be an integer between 0 and 2^53-1");
  }
  return input.seed;
}

/** Validate the request, then submit the filled workflow. Validation errors never reach ComfyUI. */
export async function generate(deps: GenerateDeps, input: GenerateRequest): Promise<{ promptId: string }> {
  const seed = checkPromptAndSeed(deps.cfg, deps.random, input);
  const style = resolveStyle(deps.profile.styles, "generate", input.style);
  const prompt = buildPrompt(deps.profile, deps.template, {
    prompt: input.prompt,
    preset: input.preset,
    size: input.size,
    seed,
    style,
  });
  return deps.comfy.submit(prompt);
}

export interface EditDeps {
  comfy: Pick<ComfyClient, "submit" | "uploadImage">;
  profile: Profile;
  /** The edit workflow template JSON from the profile (never from the request). */
  template: unknown;
  cfg: AppsConfig;
  /** Uniform random in [0, 1); injectable for deterministic tests. */
  random?: () => number;
  /** A fresh random token for an uploaded file name; injectable for tests. */
  newName?: () => string;
}

export interface EditRequest {
  prompt: string;
  /** A quality preset name (the generate presets). */
  preset: string;
  /** A resolution name from the profile's edit section. */
  resolution: string;
  seed?: number;
  /** Base64 reference images, in order: the first one is image_1 in the prompt. */
  images: unknown;
  /** Optional `{id, params}` of one of the profile's styles; checked against the profile. */
  style?: unknown;
}

const FILE_TYPES: Record<ReferenceType, { ext: string; contentType: string }> = {
  png: { ext: "png", contentType: "image/png" },
  jpeg: { ext: "jpg", contentType: "image/jpeg" },
  webp: { ext: "webp", contentType: "image/webp" },
};
const NAME_TOKEN_BYTES = 8;

/**
 * Validate an edit request completely (prompt, preset, resolution, every reference), then upload the
 * references to the instance one by one under names chosen here and submit the filled edit workflow.
 * Anything wrong with the request is a GenerateInputError raised before the first byte leaves; a
 * failed upload (ComfyError, Unreachable, ResponseTooLarge) stops the job without submitting.
 */
export async function edit(deps: EditDeps, input: EditRequest): Promise<{ promptId: string }> {
  const seed = checkPromptAndSeed(deps.cfg, deps.random, input);
  const references = decodeReferences(input.images, referenceLimits(deps.cfg));
  // Dry run with placeholder names: preset, resolution, edit section and workflow mismatches
  // surface now, before anything is uploaded.
  const style = resolveStyle(deps.profile.styles, "edit", input.style);
  const fields = { prompt: input.prompt, preset: input.preset, resolution: input.resolution, seed, style };
  buildEditPrompt(deps.profile, deps.template, { ...fields, imageNames: references.map((_r, i) => `check-${i}.png`) });

  const token = deps.newName ?? (() => randomBytes(NAME_TOKEN_BYTES).toString("hex"));
  const names: string[] = [];
  for (const ref of references) {
    const kind = FILE_TYPES[ref.type];
    const stored = await deps.comfy.uploadImage(`edit-${token()}.${kind.ext}`, ref.bytes, kind.contentType);
    names.push(stored.name);
  }
  return deps.comfy.submit(buildEditPrompt(deps.profile, deps.template, { ...fields, imageNames: names }));
}

export interface UpscaleDeps {
  comfy: Pick<ComfyClient, "submit" | "uploadImage">;
  profile: Profile;
  /** The upscale workflow template JSON from the profile (never from the request). */
  template: unknown;
  cfg: AppsConfig;
  newName?: () => string;
}

export interface UpscaleRequest {
  /** One base64 image. */
  image: unknown;
  /** A scale name from the profile's upscale section. */
  scale: unknown;
}

/**
 * Validate an upscale request (the image like a reference, the scale against the profile, the output
 * size against UPSCALE_MAX_OUTPUT_PIXELS), upload the image and submit the filled workflow. Nothing
 * leaves for the instance before every check has passed.
 */
export async function upscale(deps: UpscaleDeps, input: UpscaleRequest): Promise<{ promptId: string }> {
  const spec = deps.profile.upscale;
  if (spec === null) throw new GenerateInputError("upscale_unavailable", "this profile has no upscale section");
  if (typeof input.scale !== "string") throw new GenerateInputError("unknown_scale", "scale is not offered by the profile");
  const option = spec.scales.find((s) => s.name === input.scale);
  if (!option) throw new GenerateInputError("unknown_scale", "scale is not offered by the profile");
  const [image] = decodeReferences(typeof input.image === "string" ? [input.image] : null, referenceLimits(deps.cfg));
  const maxOut = deps.cfg["upscaleMaxOutputPixels"];
  if (typeof maxOut !== "number" || !Number.isInteger(maxOut) || maxOut < 1) throw new Error("UPSCALE_MAX_OUTPUT_PIXELS must be a positive integer");
  if (image!.width * image!.height * option.factor * option.factor > maxOut) {
    throw new GenerateInputError("upscale_too_large", `the result would have more than ${maxOut} pixels`);
  }
  buildUpscalePrompt(spec, deps.template, "check-0.png", option.name); // template mismatch surfaces before the upload
  const kind = FILE_TYPES[image!.type];
  const token = deps.newName ?? (() => randomBytes(NAME_TOKEN_BYTES).toString("hex"));
  const stored = await deps.comfy.uploadImage(`upscale-${token()}.${kind.ext}`, image!.bytes, kind.contentType);
  return deps.comfy.submit(buildUpscalePrompt(spec, deps.template, stored.name, option.name));
}

function clipMessage(text: string): string {
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}...` : text;
}

/** The node error message from the status messages, never the whole history. */
function errorMessage(status: Record<string, unknown> | undefined): string {
  const messages = status?.["messages"];
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!Array.isArray(m) || m[0] !== "execution_error") continue;
      const data = m[1] as Record<string, unknown> | undefined;
      const text = data?.["exception_message"];
      if (typeof text === "string" && text.trim() !== "") {
        const node = data?.["node_type"];
        return clipMessage(typeof node === "string" ? `${node}: ${text.trim()}` : text.trim());
      }
    }
  }
  return "generation failed";
}

function saveImageNodes(template: unknown): Set<string> {
  const ids = new Set<string>();
  if (typeof template === "object" && template !== null) {
    for (const [id, node] of Object.entries(template as Record<string, unknown>)) {
      if ((node as { class_type?: unknown } | null)?.class_type === "SaveImage") ids.add(id);
    }
  }
  return ids;
}

/**
 * One history read: the images once the prompt has finished, or null while it has not.
 * Throws GenerateFailed when ComfyUI reports an error or produced no images; Unreachable and
 * ComfyError propagate. Never sleeps, so a web request can poll without blocking.
 */
export async function pollResult(deps: GenerateDeps, promptId: string): Promise<{ images: ResultImage[] } | null> {
  const entry = await deps.comfy.history(promptId);
  if (!entry) return null;
  const status = entry.status as Record<string, unknown> | undefined;
  if (status?.["status_str"] === "error") throw new GenerateFailed(errorMessage(status));
  if (status?.["completed"] !== true && status?.["status_str"] !== "success") return null;
  const saveNodes = saveImageNodes(deps.template);
  const images: ResultImage[] = [];
  for (const [id, out] of Object.entries(entry.outputs ?? {})) {
    if (!saveNodes.has(id) || !Array.isArray(out?.images)) continue;
    for (const img of out.images) {
      if (
        typeof img?.filename === "string" && img.filename !== "" &&
        typeof img.subfolder === "string" && VIEW_TYPES.includes(img.type)
      ) {
        images.push({ filename: img.filename, subfolder: img.subfolder, type: img.type as ResultImage["type"] });
      }
    }
  }
  if (images.length === 0) throw new GenerateFailed("no images");
  return { images };
}

/** Poll history until the prompt finishes; throws GenerateTimeout / GenerateFailed. Unreachable and ComfyError propagate. */
export async function awaitResult(deps: GenerateDeps, promptId: string): Promise<{ images: ResultImage[] }> {
  const pollMs = intKey(deps.cfg, "statusPollS") * 1000;
  const timeoutMs = intKey(deps.cfg, "generateTimeoutS") * 1000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + timeoutMs;

  for (;;) {
    const result = await pollResult(deps, promptId);
    if (result) return result;
    if (now() + pollMs > deadline) throw new GenerateTimeout();
    await sleep(pollMs);
  }
}
