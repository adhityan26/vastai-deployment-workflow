import type { ComfyClient } from "./comfy.js";
import type { AppsConfig } from "./config.js";
import { buildPrompt, GenerateInputError, type Profile } from "./profile.js";

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

/** Validate the request, then submit the filled workflow. Validation errors never reach ComfyUI. */
export async function generate(deps: GenerateDeps, input: GenerateRequest): Promise<{ promptId: string }> {
  const maxChars = intKey(deps.cfg, "generateMaxPromptChars");
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    throw new GenerateInputError("invalid_prompt", "prompt must be a non-empty string");
  }
  if (input.prompt.length > maxChars) {
    throw new GenerateInputError("prompt_too_long", `prompt exceeds ${maxChars} characters`);
  }
  let seed: number;
  if (input.seed === undefined || input.seed === null) {
    const r = (deps.random ?? Math.random)();
    seed = Math.min(MAX_SEED, Math.max(0, Math.floor(r * (MAX_SEED + 1))));
  } else {
    if (typeof input.seed !== "number" || !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > MAX_SEED) {
      throw new GenerateInputError("invalid_seed", "seed must be an integer between 0 and 2^53-1");
    }
    seed = input.seed;
  }
  const prompt = buildPrompt(deps.profile, deps.template, {
    prompt: input.prompt,
    preset: input.preset,
    size: input.size,
    seed,
  });
  return deps.comfy.submit(prompt);
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
