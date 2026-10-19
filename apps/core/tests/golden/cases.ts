import type { AppsConfig } from "../../src/config.js";
import { edit, generate, upscale } from "../../src/generate.js";
import type { Profile } from "../../src/profile.js";

// Golden submissions: the exact ComfyUI prompt the services submit for untouched requests (no negative prompt,
// no cfg). golden-prompts.json was produced from master d929a9f (before negative prompt, guidance and style
// defaults existed) by running `capture` there; golden.test.ts replays the same requests on the current code and
// demands byte-identical prompts. Regenerate only on purpose, with this file copied into a worktree of the
// reference commit (see the README in this folder).

export type Kind = "generate" | "edit" | "upscale";
export interface GoldenCase {
  name: string;
  kind: Kind;
  request: Record<string, unknown>;
}
export interface Captured extends GoldenCase {
  /** The prompt as JSON text, exactly as it would be sent (the client JSON-encodes it). */
  prompt: string;
}

/** A minimal valid PNG header of the given size (what the reference checks read). */
export function png(width: number, height: number, marker = ""): string {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from(marker)]).toString("base64");
}

export const CFG = {
  generateMaxPromptChars: 2000,
  generateMaxNegativePromptChars: 1000,
  editMaxReferences: 4,
  editReferenceMaxBytes: 8_388_608,
  editReferenceMaxPixels: 16_777_216,
  editReferenceMaxSide: 8192,
  editReferenceTypes: ["png", "jpeg", "webp"],
} as unknown as AppsConfig;

export function cases(profile: Profile): GoldenCase[] {
  const out: GoldenCase[] = [];
  for (const p of profile.generate.qualityPresets) {
    for (const z of profile.generate.sizes) {
      out.push({ name: `generate ${p.name} ${z.name}`, kind: "generate", request: { prompt: "A red fox in the snow", preset: p.name, size: z.name, seed: 42 } });
    }
  }
  const two = [png(640, 480, "A"), png(512, 512, "B")];
  out.push({ name: "edit 2 references", kind: "edit", request: { prompt: "Make the girl in <image1> wear the jacket from <image2>.", preset: "standard", resolution: "1024", seed: 7, images: two } });
  for (const strength of [0.7, 0]) {
    out.push({
      name: `edit anything2real ${strength}`,
      kind: "edit",
      request: { prompt: "keep the freckles", preset: "standard", resolution: "1024", seed: 9, images: [png(800, 600, "C")], style: { id: "anything2real", params: { strength } } },
    });
  }
  out.push({ name: "edit faceswap", kind: "edit", request: { prompt: "", preset: "preview", resolution: "1024", seed: 11, images: two, style: { id: "faceswap" } } });
  for (const scale of ["2x", "4x"]) out.push({ name: `upscale ${scale}`, kind: "upscale", request: { image: png(256, 256, "D"), scale } });
  return out;
}

/** Run one case through the real service with a fake ComfyUI and return the submitted prompt as JSON text. */
export async function capture(c: GoldenCase, profile: Profile, templates: Record<Kind, unknown>): Promise<string> {
  let submitted: unknown = null;
  let n = 0;
  const comfy = {
    submit: async (prompt: unknown) => {
      submitted = prompt;
      return { promptId: "golden" };
    },
    uploadImage: async (name: string) => ({ name, subfolder: "", type: "input" }),
    history: async () => null,
  };
  const newName = () => `n${++n}`;
  const base = { comfy: comfy as never, profile, cfg: CFG, newName };
  if (c.kind === "generate") await generate({ ...base, template: templates.generate }, c.request as never);
  else if (c.kind === "edit") await edit({ ...base, template: templates.edit }, c.request as never);
  else await upscale({ ...base, template: templates.upscale, limits: { maxOutputPixels: 33_554_432, maxIntermediatePixels: 33_554_432 } }, c.request as never);
  return JSON.stringify(submitted);
}
