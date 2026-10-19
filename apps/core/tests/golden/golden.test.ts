import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadProfile } from "../../src/profile.js";
import { capture, cases, type Captured } from "./cases.js";

// Untouched requests (no negative prompt, no cfg, no style defaults) must submit exactly the prompts master
// d929a9f submitted: the fixtures were captured there (see README.md here). Any drift in a workflow, the
// profile mapping or the services fails this test; regenerate the fixtures only on purpose.
const repo = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./golden-prompts.json", import.meta.url)), "utf8")) as Captured[];
const profile = loadProfile(repo("instance/profiles/image.yaml"));
const read = (f: string) => JSON.parse(readFileSync(repo(`instance/workflows/${f}`), "utf8"));
const templates = { generate: read("qwen-image-t2i.json"), edit: read("qwen-image-edit.json"), upscale: read("image-upscale.json") };

describe("golden ComfyUI prompts (captured on master d929a9f)", () => {
  it("covers every preset and size, edit, both live styles and upscale", () => {
    expect(golden).toHaveLength(21);
    // The case list of today's profile is the one the fixtures were made from.
    expect(cases(profile).map(({ name, kind, request }) => ({ name, kind, request }))).toEqual(golden.map(({ name, kind, request }) => ({ name, kind, request })));
  });

  it.each(golden.map((g) => [g.name, g] as const))("%s is byte-identical", async (_name, g) => {
    expect(await capture(g, profile, templates)).toBe(g.prompt);
  });
});
