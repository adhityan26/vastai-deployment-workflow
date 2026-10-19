import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { AppsConfig } from "../src/config.js";
import { ComfyClient } from "../src/comfy.js";
import { edit, generate, type EditDeps, type GenerateDeps } from "../src/generate.js";
import { onGrid, parseGuidance, resolveCfg, resolveNegative } from "../src/guidance.js";
import { ProfileError } from "../src/profile-errors.js";
import { loadProfile } from "../src/profile.js";
import { checkRecipeReferences, composePrompt, parseRecipes, resolveRecipe } from "../src/recipes.js";

type Doc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const shippedProfile = loadProfile(repo("instance/profiles/image.yaml"));
const t2i = JSON.parse(readFileSync(repo("instance/workflows/qwen-image-t2i.json"), "utf8"));
const editTemplate = JSON.parse(readFileSync(repo("instance/workflows/qwen-image-edit.json"), "utf8"));
const shipped = parseYaml(readFileSync(repo("instance/profiles/image.yaml"), "utf8"));
const GUIDANCE = { min: 1, max: 6, step: 0.5, default: 1 };
// The shipped sample recipes are off; the service tests run with them switched on.
const profile = { ...shippedProfile, recipes: parseRecipes(structuredClone(shipped.recipes).map((r: Doc) => ({ ...r, enabled: true })), GUIDANCE) };
it("ships every sample recipe switched off, so nothing is offered until the owner decides", () => {
  expect(shippedProfile.recipes).toEqual([]);
  expect(shipped.recipes.every((r: Doc) => r.enabled === false)).toBe(true);
});

function png(width: number, height: number, marker = ""): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from(marker)]);
}

describe("guidance", () => {
  it("parses the shipped section and refuses a broken one", () => {
    expect(parseGuidance(shipped.guidance)).toEqual(GUIDANCE);
    expect(parseGuidance(undefined)).toBeNull();
    for (const bad of [{ ...GUIDANCE, min: 0 }, { ...GUIDANCE, step: 0 }, { ...GUIDANCE, max: 0.5 }, { ...GUIDANCE, default: 1.25 }, { ...GUIDANCE, extra: 1 }, { ...GUIDANCE, min: "1" }, "x"]) {
      expect(() => parseGuidance(bad), JSON.stringify(bad)).toThrow(ProfileError);
    }
  });

  it("knows the grid", () => {
    expect(onGrid(GUIDANCE, 3.5)).toBe(true);
    for (const v of [0.5, 6.5, 3.25, Number.NaN, Infinity]) expect(onGrid(GUIDANCE, v), String(v)).toBe(false);
  });

  it("resolves cfg: the request first, then the recipe, else nothing; refuses off-grid and unsupported", () => {
    expect(resolveCfg(GUIDANCE, 4, 3)).toBe(4);
    expect(resolveCfg(GUIDANCE, undefined, 3)).toBe(3);
    expect(resolveCfg(GUIDANCE, null, null)).toBeNull();
    for (const bad of [7, 1.25, "3", true]) expect(() => resolveCfg(GUIDANCE, bad, null)).toThrow(expect.objectContaining({ code: "invalid_cfg" }));
    expect(() => resolveCfg(null, 3, null)).toThrow(expect.objectContaining({ code: "cfg_unavailable" }));
  });

  it("joins the recipe's negative prompt with the user's, and bounds the user's", () => {
    expect(resolveNegative("", undefined, 50)).toBeUndefined();
    expect(resolveNegative("blurry", undefined, 50)).toBe("blurry");
    expect(resolveNegative("blurry", "  extra fingers ", 50)).toBe("blurry, extra fingers");
    expect(resolveNegative("", "   ", 50)).toBeUndefined();
    expect(() => resolveNegative("", "x".repeat(51), 50)).toThrow(expect.objectContaining({ code: "negative_prompt_too_long" }));
    expect(() => resolveNegative("", 5, 50)).toThrow(expect.objectContaining({ code: "invalid_negative_prompt" }));
  });
});

describe("parseRecipes", () => {
  const raw = (): Doc[] => structuredClone(shipped.recipes).map((r: Doc) => ({ ...r, enabled: true }));

  it("reads the shipped recipes", () => {
    const list = parseRecipes(raw(), GUIDANCE);
    expect(list.map((r) => r.id)).toEqual(["portrait_photo", "family_photo", "anime", "face_swap", "outfit_swap", "photo_restore", "to_anime"]);
    expect(list.find((r) => r.id === "face_swap")).toMatchObject({ modes: ["edit"], promptOptional: true, references: { min: 2, max: 2 }, cfg: null });
  });

  it("returns only enabled recipes, but validates the disabled ones too", () => {
    const list = raw();
    list[0].enabled = false;
    expect(parseRecipes(list, GUIDANCE).map((r) => r.id)).not.toContain("portrait_photo");
    list[0].prompt = 5;
    expect(() => parseRecipes(list, GUIDANCE)).toThrow(ProfileError);
  });

  it.each<[string, (l: Doc[]) => void]>([
    ["unknown key", (l) => (l[0].lora = "x")],
    ["bad id", (l) => (l[0].id = "Bad Id")],
    ["duplicate id", (l) => (l[1].id = l[0].id)],
    ["enabled missing", (l) => delete l[0].enabled],
    ["no modes", (l) => (l[0].modes = [])],
    ["unknown mode", (l) => (l[0].modes = ["upscale"])],
    ["empty prompt", (l) => (l[0].prompt = "  ")],
    ["two placeholders", (l) => (l[0].prompt = "{prompt} and {prompt}")],
    ["title too long", (l) => (l[0].title = "x".repeat(41))],
    ["cfg off the grid", (l) => (l[0].cfg = 3.25)],
    ["cfg outside the range", (l) => (l[0].cfg = 9)],
    ["references on a generate recipe", (l) => (l[0].references = { min: 1, max: 1 })],
    ["references min above max", (l) => (l[3].references = { min: 3, max: 2 })],
    ["references above 10", (l) => (l[3].references = { min: 1, max: 11 })],
  ])("refuses %s", (_n, mutate) => {
    const l = raw();
    mutate(l);
    expect(() => parseRecipes(l, GUIDANCE)).toThrow(ProfileError);
  });

  it("refuses a cfg when the profile has no guidance", () => {
    expect(() => parseRecipes(raw(), null)).toThrow(ProfileError);
  });
});

describe("resolving and composing", () => {
  const list = parseRecipes(structuredClone(shipped.recipes).map((r: Doc) => ({ ...r, enabled: true })), GUIDANCE);

  it("finds a recipe by id for its mode and refuses the rest", () => {
    expect(resolveRecipe(list, "generate", undefined)).toBeNull();
    expect(resolveRecipe(list, "generate", "anime")?.id).toBe("anime");
    expect(() => resolveRecipe(list, "generate", "face_swap")).toThrow(expect.objectContaining({ code: "recipe_not_for_mode" }));
    expect(() => resolveRecipe(list, "edit", "anime")).toThrow(expect.objectContaining({ code: "recipe_not_for_mode" }));
    expect(() => resolveRecipe(list, "edit", "nope")).toThrow(expect.objectContaining({ code: "unknown_recipe" }));
    expect(() => resolveRecipe(list, "edit", 5)).toThrow(expect.objectContaining({ code: "invalid_recipe" }));
  });

  it("puts the user's text at the placeholder, literally", () => {
    const anime = list.find((r) => r.id === "anime")!;
    expect(composePrompt(anime, "a girl with a red scarf")).toContain("detailed cel shading and a balanced color palette. a girl with a red scarf");
    expect(composePrompt(anime, "$& {prompt} $1")).toContain("$& {prompt} $1");
    const noSlot = { ...anime, prompt: "Base text." };
    expect(composePrompt(noSlot, "more")).toBe("Base text. more");
    expect(composePrompt(noSlot, "")).toBe("Base text.");
  });

  it("checks the reference count a recipe needs", () => {
    const swap = list.find((r) => r.id === "face_swap")!;
    expect(() => checkRecipeReferences(swap, 1)).toThrow(expect.objectContaining({ code: "recipe_references" }));
    expect(() => checkRecipeReferences(swap, 3)).toThrow(expect.objectContaining({ code: "recipe_references" }));
    expect(() => checkRecipeReferences(swap, 2)).not.toThrow();
    expect(() => checkRecipeReferences(null, 7)).not.toThrow();
  });
});

describe("generate and edit with recipes, negative prompt and guidance", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections?.();
    server?.close();
    server = undefined;
  });
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  async function fake() {
    const seen: { url: string; body: Buffer }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ url: req.url ?? "", body });
        if (req.url === "/upload/image") return json(res, 200, { name: /filename="([^"]+)"/.exec(body.toString("latin1"))![1], subfolder: "", type: "input" });
        if (req.url === "/prompt") return json(res, 200, { prompt_id: "p1" });
        json(res, 404, {});
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const cfg = {
      comfyPort: port, httpTimeoutSApps: 5, webJsonMaxBytes: 65536, webImageMaxBytes: 65536, webImageTimeoutS: 5,
      generateMaxPromptChars: 60, editMaxReferences: 3, editReferenceMaxBytes: 4096, editReferenceMaxPixels: 1_000_000, editReferenceMaxSide: 8192,
      editReferenceTypes: ["png", "jpeg", "webp"], secretNames: [],
    } as unknown as AppsConfig;
    const comfy = new ComfyClient("127.0.0.1", cfg);
    const gen: GenerateDeps = { comfy, profile, template: t2i, cfg };
    const ed: EditDeps = { comfy, profile, template: editTemplate, cfg, newName: () => "n" };
    const sent = () => JSON.parse(seen[seen.length - 1]!.body.toString()).prompt;
    return { gen, ed, seen, sent };
  }
  const base = { prompt: "two kids on a beach", preset: "preview", size: "1:1", seed: 1 };

  it("a plain request keeps the workflow's own negative prompt and cfg", async () => {
    const { gen, sent } = await fake();
    await generate(gen, base);
    expect(sent()["8"].inputs.cfg).toBe(1);
    expect(sent()["6"].inputs.text).toBe("");
  });

  it("sets the negative prompt and cfg the user asked for", async () => {
    const { gen, sent } = await fake();
    await generate(gen, { ...base, negativePrompt: "blurry", cfg: 3.5 });
    expect(sent()["6"].inputs.text).toBe("blurry");
    expect(sent()["8"].inputs.cfg).toBe(3.5);
  });

  it("a recipe wraps the prompt and brings its negative prompt and cfg; the user's negative and cfg add to or win over it", async () => {
    const { gen, sent } = await fake();
    await generate(gen, { ...base, recipe: "anime" });
    expect(sent()["5"].inputs.text).toContain("two kids on a beach");
    expect(sent()["5"].inputs.text).toMatch(/^A high-quality anime illustration/);
    expect(sent()["6"].inputs.text).toMatch(/^photorealistic, 3d render/);
    expect(sent()["8"].inputs.cfg).toBe(3);
    await generate(gen, { ...base, recipe: "anime", negativePrompt: "hat", cfg: 5 });
    expect(sent()["6"].inputs.text).toMatch(/, hat$/);
    expect(sent()["8"].inputs.cfg).toBe(5);
  });

  it("checks the user's prompt length, not the composed one", async () => {
    const { gen, seen } = await fake();
    await expect(generate(gen, { ...base, recipe: "anime", prompt: "x".repeat(61) })).rejects.toMatchObject({ code: "prompt_too_long" });
    await expect(generate(gen, { ...base, recipe: "anime", prompt: "x".repeat(60) })).resolves.toBeDefined();
    expect(seen).toHaveLength(1);
  });

  it("refuses bad recipe, negative prompt and cfg input before anything is sent", async () => {
    const { gen, ed, seen } = await fake();
    const img = png(64, 64).toString("base64");
    const bad: [Doc, string][] = [
      [{ ...base, recipe: "nope" }, "unknown_recipe"],
      [{ ...base, recipe: "face_swap" }, "recipe_not_for_mode"],
      [{ ...base, cfg: 9 }, "invalid_cfg"],
      [{ ...base, cfg: "3" }, "invalid_cfg"],
      [{ ...base, negativePrompt: 5 }, "invalid_negative_prompt"],
      [{ ...base, negativePrompt: "x".repeat(61) }, "negative_prompt_too_long"],
      [{ ...base, prompt: "" }, "invalid_prompt"],
    ];
    for (const [input, code] of bad) await expect(generate(gen, input), code).rejects.toMatchObject({ code });
    const editBase = { prompt: "x", preset: "preview", resolution: "1024", seed: 1, images: [img] };
    await expect(edit(ed, { ...editBase, recipe: "face_swap" })).rejects.toMatchObject({ code: "recipe_references" });
    await expect(edit(ed, { ...editBase, recipe: "anime" })).rejects.toMatchObject({ code: "recipe_not_for_mode" });
    expect(seen).toHaveLength(0);
  });

  it("edit: a recipe with two references composes the prompt, may leave the prompt empty, and sets the negative prompt", async () => {
    const { ed, sent, seen } = await fake();
    const imgs = [png(64, 64, "A").toString("base64"), png(32, 32, "B").toString("base64")];
    await edit(ed, { prompt: "", preset: "preview", resolution: "1024", seed: 1, images: imgs, recipe: "face_swap" });
    expect(seen.map((s) => s.url)).toEqual(["/upload/image", "/upload/image", "/prompt"]);
    expect(sent()["6"].inputs.prompt).toMatch(/^Replace the face of the person in <image1> with the face of the person in <image2>/);
    expect(sent()["6"].inputs.negative_prompt).toMatch(/mismatched skin tone/);
    expect(sent()["7"].inputs.cfg).toBe(1); // no recipe cfg: the workflow keeps its own
    await edit(ed, { prompt: "keep the glasses", preset: "preview", resolution: "1024", seed: 1, images: imgs, recipe: "face_swap", cfg: 2 });
    expect(sent()["6"].inputs.prompt).toMatch(/keep the glasses$/);
    expect(sent()["7"].inputs.cfg).toBe(2);
  });

  it("a recipe whose prompt is not optional still needs the user's prompt", async () => {
    const { gen } = await fake();
    await expect(generate(gen, { ...base, recipe: "anime", prompt: "  " })).rejects.toMatchObject({ code: "invalid_prompt" });
  });
});
