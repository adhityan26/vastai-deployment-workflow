import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AppsConfig } from "../src/config.js";
import { ComfyClient } from "../src/comfy.js";
import { edit, generate, type EditDeps, type GenerateDeps } from "../src/generate.js";
import { onGrid, parseGuidance, resolveTuning } from "../src/guidance.js";
import { ProfileError } from "../src/profile-errors.js";
import { buildEditPrompt, buildPrompt, checkGuidanceDefault, loadProfile, tuningSupport, type Profile } from "../src/profile.js";
import { parseStyles, type StyleContext } from "../src/styles.js";

// Negative prompt and guidance (cfg): the profile maps them per workflow, the request is checked against
// that, and a request that leaves them out runs exactly the shipped workflow. Styles may carry defaults the
// page pre-fills; the server never applies them on its own.

type Doc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const PROFILE_PATH = repo("instance/profiles/image.yaml");
const shipped = loadProfile(PROFILE_PATH);
const shippedRaw = parseYaml(readFileSync(PROFILE_PATH, "utf8"));
const t2i = JSON.parse(readFileSync(repo("instance/workflows/qwen-image-t2i.json"), "utf8"));
const editTemplate = JSON.parse(readFileSync(repo("instance/workflows/qwen-image-edit.json"), "utf8"));
const GUIDANCE = { min: 1, max: 6, step: 0.5, default: 1 };
const FULL = { negativePrompt: true, cfg: true };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** The shipped profile after `change`, loaded from a temp file. */
function variant(change: (doc: Doc) => void): Profile {
  const doc = structuredClone(shippedRaw);
  change(doc);
  const dir = mkdtempSync(join(tmpdir(), "tuning-profile-"));
  dirs.push(dir);
  const path = join(dir, "image.yaml");
  writeFileSync(path, stringifyYaml(doc));
  return loadProfile(path);
}

/**
 * Drop the edit workflow's negative prompt and cfg mappings, and with them the edit styles' defaults for those
 * knobs (an enabled style may not pre-fill a knob its workflow does not map).
 */
const noEditKnobsChange = (d: Doc): void => {
  delete d.edit.params.negative_prompt;
  delete d.edit.params.cfg;
  for (const st of d.styles) if (st.modes.includes("edit") && st.defaults) {
    delete st.defaults.negative_prompt;
    delete st.defaults.cfg;
  }
};

describe("guidance section", () => {
  it("parses the shipped section and refuses a broken one", () => {
    expect(parseGuidance(shippedRaw.guidance)).toEqual(GUIDANCE);
    expect(shipped.guidance).toEqual(GUIDANCE);
    expect(parseGuidance(undefined)).toBeNull();
    for (const bad of [{ ...GUIDANCE, min: 0 }, { ...GUIDANCE, step: 0 }, { ...GUIDANCE, max: 0.5 }, { ...GUIDANCE, default: 1.25 }, { ...GUIDANCE, extra: 1 }, { ...GUIDANCE, min: "1" }, "x"]) {
      expect(() => parseGuidance(bad), JSON.stringify(bad)).toThrow(ProfileError);
    }
  });

  it("knows the grid", () => {
    expect(onGrid(GUIDANCE, 3.5)).toBe(true);
    for (const v of [0.5, 6.5, 3.25, Number.NaN, Infinity]) expect(onGrid(GUIDANCE, v), String(v)).toBe(false);
  });

  it("a cfg mapping needs a guidance section, and a guidance section needs a cfg mapping", () => {
    expect(() => variant((d) => delete d.guidance)).toThrow(/cfg param needs a guidance section/);
    expect(() =>
      variant((d) => {
        delete d.generate.params.cfg;
        delete d.edit.params.cfg;
      }),
    ).toThrow(/guidance section needs a cfg param/);
  });

  it("refuses a knob mapped onto an input another param already fills", () => {
    expect(() => variant((d) => (d.generate.params.negative_prompt = { node: "5", input: "text" }))).toThrow(/negative_prompt uses node 5 input text/);
    expect(() => variant((d) => (d.edit.params.cfg = { node: "7", input: "steps" }))).toThrow(/edit param cfg uses node 7 input steps/);
  });

  it("the guidance default must be the cfg the workflows ship with", () => {
    expect(() => checkGuidanceDefault(shipped, { generate: t2i, edit: editTemplate })).not.toThrow();
    const hot = structuredClone(editTemplate);
    hot["7"].inputs.cfg = 2.5;
    expect(() => checkGuidanceDefault(shipped, { generate: t2i, edit: hot })).toThrow(/differs from the edit workflow's cfg/);
    expect(() => checkGuidanceDefault(shipped, { generate: t2i, edit: null })).not.toThrow(); // edit off: nothing to compare
  });

  it("says per mode what the shipped workflows take", () => {
    expect(tuningSupport(shipped, "generate")).toEqual(FULL);
    expect(tuningSupport(shipped, "edit")).toEqual(FULL);
    // Keeping an edit style's default for a knob the workflow no longer maps is refused at load.
    expect(() => variant((d) => {
      delete d.edit.params.negative_prompt;
      delete d.edit.params.cfg;
    })).toThrow(/negative_prompt is not mapped in the edit workflow/);
    const noEditKnobs = variant(noEditKnobsChange);
    expect(tuningSupport(noEditKnobs, "edit")).toEqual({ negativePrompt: false, cfg: false });
    expect(tuningSupport({ ...shipped, edit: null }, "edit")).toEqual({ negativePrompt: false, cfg: false });
  });
});

describe("resolveTuning", () => {
  const check = (input: { negativePrompt?: unknown; cfg?: unknown }, support = FULL) => resolveTuning(GUIDANCE, support, input, 20);

  it("leaves absent and blank knobs out, so the workflow keeps its own values", () => {
    expect(check({})).toEqual({});
    expect(check({ negativePrompt: null, cfg: null })).toEqual({});
    expect(check({ negativePrompt: "   " })).toEqual({});
    // A blank negative prompt is not an attempt to use the knob: no refusal even where it is not mapped.
    expect(check({ negativePrompt: "" }, { negativePrompt: false, cfg: false })).toEqual({});
  });

  it("returns the trimmed negative prompt and the cfg", () => {
    expect(check({ negativePrompt: "  blurry, text ", cfg: 3.5 })).toEqual({ negativePrompt: "blurry, text", cfg: 3.5 });
  });

  it("refuses bad values with a clear code", () => {
    const bad: [Doc, string][] = [
      [{ negativePrompt: 5 }, "invalid_negative_prompt"],
      [{ negativePrompt: ["x"] }, "invalid_negative_prompt"],
      [{ negativePrompt: "x".repeat(21) }, "negative_prompt_too_long"],
      [{ cfg: "3" }, "invalid_cfg"],
      [{ cfg: true }, "invalid_cfg"],
      [{ cfg: 1.25 }, "invalid_cfg"],
      [{ cfg: 6.5 }, "invalid_cfg"],
      [{ cfg: 0.5 }, "invalid_cfg"],
      [{ cfg: Number.NaN }, "invalid_cfg"],
    ];
    for (const [input, code] of bad) expect(() => check(input), code).toThrow(expect.objectContaining({ code }));
    expect(check({ negativePrompt: `  ${"x".repeat(20)}  ` })).toEqual({ negativePrompt: "x".repeat(20) }); // the limit applies after trimming
  });

  it("refuses a knob the mode's workflow does not map instead of dropping it", () => {
    expect(() => check({ negativePrompt: "blurry" }, { negativePrompt: false, cfg: true })).toThrow(expect.objectContaining({ code: "negative_prompt_unavailable" }));
    expect(() => check({ cfg: 2 }, { negativePrompt: true, cfg: false })).toThrow(expect.objectContaining({ code: "cfg_unavailable" }));
    expect(() => resolveTuning(null, FULL, { cfg: 2 }, 20)).toThrow(expect.objectContaining({ code: "cfg_unavailable" }));
  });
});

describe("workflow filling", () => {
  const gen = { prompt: "a fox", preset: "preview", size: "1:1", seed: 7 };
  const ed = { prompt: "a fox", preset: "preview", resolution: "1024", seed: 7, imageNames: ["a.png"] };

  it("without knobs the workflows keep their own negative prompt and cfg", () => {
    const g = buildPrompt(shipped, t2i, gen);
    expect(g["6"]!.inputs).toEqual(t2i["6"].inputs);
    expect(g["8"]!.inputs["cfg"]).toBe(1);
    const e = buildEditPrompt(shipped, editTemplate, ed);
    expect(e["6"]!.inputs["negative_prompt"]).toBe("");
    expect(e["7"]!.inputs["cfg"]).toBe(1);
  });

  it("puts each knob only where the profile maps it", () => {
    const g = buildPrompt(shipped, t2i, { ...gen, negativePrompt: "blurry", cfg: 3 });
    expect(g["6"]!.inputs["text"]).toBe("blurry");
    expect(g["5"]!.inputs["text"]).toBe("a fox");
    expect(g["8"]!.inputs["cfg"]).toBe(3);
    const e = buildEditPrompt(shipped, editTemplate, { ...ed, negativePrompt: "blurry", cfg: 2.5 });
    expect(e["6"]!.inputs["negative_prompt"]).toBe("blurry");
    expect(e["6"]!.inputs["prompt"]).toBe("a fox");
    expect(e["7"]!.inputs["cfg"]).toBe(2.5);
  });
});

describe("style defaults", () => {
  const ctx: StyleContext = {
    guidance: GUIDANCE,
    presets: ["preview", "standard"],
    sizes: ["1:1"],
    resolutions: ["1024"],
    negativePrompt: { generate: true, edit: false },
    cfg: { generate: true, edit: true },
    taken: { generate: {}, edit: {} },
    referenceInputs: null,
  };
  const style = (over: Doc = {}): Doc => ({ id: "s", title: "S", kind: "preset", modes: ["generate"], enabled: true, prompt_template: "x {prompt}", ...over });
  const parse = (over: Doc) => parseStyles([style(over)], [], ctx);

  it("parses the defaults a page pre-fills; a style without defaults has none", () => {
    expect(parse({}).at(0)!.defaults).toEqual({ negativePrompt: null, cfg: null, preset: null, size: null, resolution: null });
    expect(parse({ defaults: { negative_prompt: " blurry ", cfg: 3, preset: "standard", size: "1:1" } }).at(0)!.defaults).toEqual({
      negativePrompt: "blurry", cfg: 3, preset: "standard", size: "1:1", resolution: null,
    });
    expect(parse({ modes: ["edit"], defaults: { resolution: "1024", cfg: 2 } }).at(0)!.defaults).toMatchObject({ resolution: "1024", cfg: 2 });
  });

  it("refuses defaults the profile could not run", () => {
    const bad: [Doc, RegExp][] = [
      [{ defaults: { steps: 10 } }, /unknown keys: steps/],
      [{ defaults: "x" }, /defaults must be a mapping/],
      [{ defaults: { cfg: 3.25 } }, /guidance range/],
      [{ defaults: { cfg: "3" } }, /cfg must be a number/],
      [{ defaults: { negative_prompt: "" } }, /negative_prompt must be a non-empty string/],
      [{ defaults: { preset: "ultra" } }, /preset 'ultra' is not offered/],
      [{ defaults: { size: "2:1" } }, /size '2:1' is not offered/],
      [{ modes: ["edit"], defaults: { size: "1:1" } }, /size is only for a style offered in generate/],
      [{ defaults: { resolution: "1024" } }, /resolution is only for a style offered in edit/],
      // Edit does not map a negative prompt in this context: a default would be pre-filled and then refused.
      [{ modes: ["generate", "edit"], defaults: { negative_prompt: "blurry" } }, /negative_prompt is not mapped in the edit workflow/],
    ];
    for (const [over, message] of bad) expect(() => parse(over), JSON.stringify(over)).toThrow(message);
    expect(() => parseStyles([style({ defaults: { cfg: 2 } })], [])).toThrow(/guidance range/); // no guidance at all
  });

  it("refuses a style param that targets an input a mapped knob or param of the same mode already sets", () => {
    const withParam = (modes: string[], target: Doc, enabled = true) =>
      variant((d) =>
        d.styles.push({
          id: "clash", title: "Clash", kind: "preset", modes, enabled, prompt_template: "x {prompt}",
          params: [{ id: "knob", title: "Knob", type: "float", min: 1, max: 6, step: 0.5, default: 1, target }],
        }),
      );
    const bad: [string[], Doc, RegExp][] = [
      [["generate"], { node: "8", input: "cfg" }, /style clash param knob targets node 8 input cfg, which the generate workflow's cfg already sets/],
      [["generate"], { node: "6", input: "text" }, /node 6 input text, which the generate workflow's negative_prompt already sets/],
      [["generate"], { node: "8", input: "steps" }, /node 8 input steps, which the generate workflow's steps already sets/],
      [["edit"], { node: "7", input: "cfg" }, /node 7 input cfg, which the edit workflow's cfg already sets/],
      [["edit"], { node: "6", input: "prompt" }, /which the edit workflow's prompt already sets/],
      [["edit"], { node: "6", input: "images.image_1" }, /which the edit workflow's reference images already set/],
    ];
    for (const [modes, target, message] of bad) expect(() => withParam(modes, target), JSON.stringify(target)).toThrow(message);
    expect(() => withParam(["generate"], { node: "8", input: "cfg" }, false)).toThrow(/generate workflow's cfg/); // disabled styles too
    // The check is per mode: in the edit workflow node 8 is the VAEDecode, which no param of edit sets.
    expect(() => withParam(["edit"], { node: "8", input: "samples" })).not.toThrow();
    expect(() => withParam(["generate"], { node: "7", input: "batch_size" })).not.toThrow();
  });

  it("validates the defaults of a disabled style too, except whether every mode maps the knob", () => {
    expect(() => parse({ enabled: false, defaults: { cfg: 9 } })).toThrow(ProfileError);
    expect(parse({ enabled: false, modes: ["generate", "edit"], defaults: { negative_prompt: "blurry" } })).toEqual([]);
  });

  it("the shipped sample presets (ported recipes) are on for the live test, valid, download nothing, and the live styles are unchanged", () => {
    const samples = ["portrait_photo", "family_photo", "anime", "outfit_swap", "photo_restore", "to_anime"];
    expect(shipped.styles.map((s) => s.id)).toEqual(["anything2real", "faceswap", ...samples]);
    for (const s of shipped.styles.slice(0, 2)) expect(s.defaults).toEqual({ negativePrompt: null, cfg: null, preset: null, size: null, resolution: null });
    expect(shippedRaw.styles.filter((s: Doc) => s.enabled === false)).toEqual([]);
    expect(shippedRaw).not.toHaveProperty("recipes");
    // Presets without a LoRA: they add no model to the boot download.
    for (const id of samples) expect(shipped.styles.find((s) => s.id === id)).toMatchObject({ kind: "preset", lora: null });
    expect(shipped.models.map((m) => m.file.split("/").pop())).toEqual([
      "qwen-image-2.1-UC-Q4_K_M.gguf", "qwen3vl_8b_int8_convrot.safetensors", "qwen_image_2.1_vae_bf16.safetensors",
      "Qwen2.1_Anything2RealCharacters.safetensors", "RealESRGAN_x4plus.safetensors",
    ]);
    // The three generate samples pre-fill guidance 3 and a negative prompt (UNVERIFIED on this model); the edit
    // samples only a negative prompt.
    for (const id of ["portrait_photo", "family_photo", "anime"]) {
      expect(shipped.styles.find((s) => s.id === id), id).toMatchObject({ modes: ["generate"], defaults: { cfg: 3, negativePrompt: expect.any(String) } });
    }
    for (const id of ["outfit_swap", "photo_restore", "to_anime"]) {
      expect(shipped.styles.find((s) => s.id === id), id).toMatchObject({ modes: ["edit"], defaults: { cfg: null, negativePrompt: expect.any(String) } });
    }
    expect(shipped.styles.find((s) => s.id === "anime")).toMatchObject({ defaults: { negativePrompt: expect.stringMatching(/^photorealistic/) } });
    expect(shipped.styles.find((s) => s.id === "outfit_swap")).toMatchObject({ references: { min: 2, max: 2, labels: ["Person", "Clothing to use"] } });
  });
});

describe("generate and edit services", () => {
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
  function png(width: number, height: number): Buffer {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "latin1");
    ihdr.writeUInt32BE(width, 8);
    ihdr.writeUInt32BE(height, 12);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
  }

  async function fake(profile: Profile = shipped) {
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
      generateMaxPromptChars: 2000, generateMaxNegativePromptChars: 30, editMaxReferences: 3, editReferenceMaxBytes: 4096,
      editReferenceMaxPixels: 1_000_000, editReferenceMaxSide: 8192, editReferenceTypes: ["png", "jpeg", "webp"], secretNames: [],
    } as unknown as AppsConfig;
    const comfy = new ComfyClient("127.0.0.1", cfg);
    const gen: GenerateDeps = { comfy, profile, template: t2i, cfg };
    const ed: EditDeps = { comfy, profile, template: editTemplate, cfg, newName: () => "n" };
    const sent = () => JSON.parse(seen[seen.length - 1]!.body.toString()).prompt;
    return { gen, ed, seen, sent };
  }
  const base = { prompt: "two kids on a beach", preset: "preview", size: "1:1", seed: 1 };
  const editBase = () => ({ prompt: "make it night", preset: "preview", resolution: "1024", seed: 1, images: [png(64, 64).toString("base64")] });

  it("a request without knobs keeps the workflow's own negative prompt and cfg", async () => {
    // Byte-identity with master for untouched requests is checked against captured fixtures in golden/golden.test.ts.
    const { gen, sent } = await fake();
    await generate(gen, base);
    expect(sent()["6"].inputs.text).toBe("");
    expect(sent()["8"].inputs.cfg).toBe(1);
  });

  it("generate and edit set the knobs the user sent", async () => {
    const { gen, ed, sent } = await fake();
    await generate(gen, { ...base, negativePrompt: "blurry", cfg: 3.5 });
    expect(sent()["6"].inputs.text).toBe("blurry");
    expect(sent()["8"].inputs.cfg).toBe(3.5);
    await edit(ed, { ...editBase(), negativePrompt: " text ", cfg: 2 });
    expect(sent()["6"].inputs.negative_prompt).toBe("text");
    expect(sent()["7"].inputs.cfg).toBe(2);
  });

  it("works with a style: the style's own prompt and the user's knobs, and no default applied by the server", async () => {
    const profile = variant((d) => d.styles.forEach((s: Doc) => (s.enabled = true)));
    const { gen, sent } = await fake(profile);
    await generate(gen, { ...base, prompt: "", style: { id: "anime" } });
    expect(sent()["5"].inputs.text).toMatch(/^A high-quality anime illustration/);
    expect(sent()["6"].inputs.text).toBe(""); // the style's default negative prompt is the page's to pre-fill
    expect(sent()["8"].inputs.cfg).toBe(1);
    await generate(gen, { ...base, style: { id: "anime" }, negativePrompt: "photorealistic", cfg: 3 });
    expect(sent()["6"].inputs.text).toBe("photorealistic");
    expect(sent()["8"].inputs.cfg).toBe(3);
  });

  it("refuses bad knobs before anything is sent, also a knob the mode's workflow does not map", async () => {
    const noEditKnobs = variant(noEditKnobsChange);
    const { gen, ed, seen } = await fake(noEditKnobs);
    await expect(generate(gen, { ...base, cfg: 9 })).rejects.toMatchObject({ code: "invalid_cfg" });
    await expect(generate(gen, { ...base, negativePrompt: "x".repeat(31) })).rejects.toMatchObject({ code: "negative_prompt_too_long" });
    await expect(edit(ed, { ...editBase(), negativePrompt: "blurry" })).rejects.toMatchObject({ code: "negative_prompt_unavailable" });
    await expect(edit(ed, { ...editBase(), cfg: 2 })).rejects.toMatchObject({ code: "cfg_unavailable" });
    expect(seen).toHaveLength(0); // no upload either
    await edit(ed, editBase()); // without knobs that profile still edits
    expect(seen.map((s) => s.url)).toEqual(["/upload/image", "/prompt"]);
  });
});
