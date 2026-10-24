import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { AppsConfig } from "../src/config.js";
import { ComfyClient } from "../src/comfy.js";
import { video, type VideoDeps } from "../src/generate.js";
import { ProfileError } from "../src/profile-errors.js";
import type { Profile } from "../src/profile.js";
import {
  VIDEO_START_NODE, buildVideoPrompt, checkVideoFamily, parseVideo, parseVideoFamilies, type VideoFamily,
} from "../src/video.js";

type Doc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const shipped = () => parseYaml(readFileSync(repo("instance/profiles/image.yaml"), "utf8"));
const tpl = (name: string) => JSON.parse(readFileSync(repo(`instance/workflows/${name}`), "utf8"));
const raw14 = () => structuredClone(shipped().video_families[0]);
const T2V = tpl(raw14().text.workflow);
const I2V = tpl(raw14().image.workflow);
const TEMPLATES = { text: T2V, image: I2V };

/** Pinned-looking entries for every file of the 14B family (they are not pinned in the shipped profile yet). */
const PINS = (raw14().models as Doc[]).map((m) => ({ file: `split_files/x/${m.file}`, dest: m.dest }));
const families = (mutate?: (f: Doc) => void, on: string[] = ["wan22_a14b"], videoEnabled = true, pins = PINS) => {
  const f = raw14();
  mutate?.(f);
  return parseVideoFamilies([f], pins, { enabled: on, videoEnabled, baseId: "wan22_5b" });
};
const fam = (): VideoFamily => families()[0]!;
const ok = { prompt: "a fox runs", seed: 7, size: "Landscape", duration: "About 5 s" };

describe("parseVideo: the base family's id and title", () => {
  it("reads the shipped id and title of the base section; both are optional", () => {
    const doc = shipped();
    expect(doc.video).toMatchObject({ id: "wan22_5b", title: "Fast (5B)" });
    const s = structuredClone(doc.video);
    delete s.id;
    delete s.title;
    expect(parseVideo(s, doc.models, true)).not.toBeNull();
  });

  it.each([["a bad id", (s: Doc) => (s.id = "Bad Id")], ["a blank title", (s: Doc) => (s.title = " ")]])("refuses %s", (_n, mutate) => {
    const s = structuredClone(shipped().video);
    mutate(s);
    expect(() => parseVideo(s, shipped().models, true)).toThrow(ProfileError);
  });
});

describe("parseVideoFamilies", () => {
  it("the shipped 14B family is pinned, validated, and on only when VIDEO_FAMILIES names it with VIDEO_ENABLED", () => {
    const doc = shipped();
    expect(parseVideoFamilies(doc.video_families, doc.models, { enabled: [], videoEnabled: true, baseId: "wan22_5b" })).toEqual([]);
    expect(parseVideoFamilies(doc.video_families, doc.models, { enabled: ["wan22_a14b"], videoEnabled: false, baseId: "wan22_5b" })).toEqual([]);
    expect(parseVideoFamilies(doc.video_families, doc.models, { enabled: ["wan22_a14b"], videoEnabled: true, baseId: "wan22_5b" }).map((f) => f.id)).toEqual(["wan22_a14b"]);
    // Without its own pins (as before 2026-10-24) the family is refused while it is on.
    const own = new Set((doc.video_families[0].models as Doc[]).map((m) => m.file).filter((f) => f !== "umt5_xxl_fp8_e4m3fn_scaled.safetensors"));
    const unpinned = (doc.models as Doc[]).filter((e) => !own.has(e.file.split("/").pop()));
    expect(() => parseVideoFamilies(doc.video_families, unpinned, { enabled: ["wan22_a14b"], videoEnabled: true, baseId: "wan22_5b" }))
      .toThrow(/wan2\.2_t2v_high_noise_14B_fp8_scaled\.safetensors is not listed in models \(pin it with scripts\/pin_model\.py\)/);
    expect(parseVideoFamilies(undefined, [], { enabled: [], videoEnabled: true, baseId: null })).toEqual([]);
  });

  it("ships the owner's pins of the family (2026-10-24): repo, revision, folder and size of each file", () => {
    const W22 = ["Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "ee6f4a40737a995bf5818954cfce6d59443b0f04"];
    const W21 = ["Comfy-Org/Wan_2.1_ComfyUI_repackaged", "123acf1cc74bccbb9bfff8ac1ee72edc08c2341d"];
    const expected: [string, string[], string, number][] = [
      ["split_files/diffusion_models/wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors", W22, "models/diffusion_models/", 14293923632],
      ["split_files/diffusion_models/wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors", W22, "models/diffusion_models/", 14293923632],
      ["split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", W22, "models/diffusion_models/", 14294742832],
      ["split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", W22, "models/diffusion_models/", 14294742832],
      ["split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors", W22, "models/loras/", 1226977424],
      ["split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors", W22, "models/loras/", 1226977424],
      ["split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", W22, "models/loras/", 1226977424],
      ["split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", W22, "models/loras/", 1226977424],
      ["split_files/vae/wan_2.1_vae.safetensors", W21, "models/vae/", 253815318],
      ["split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", W21, "models/text_encoders/", 6735906897], // shared with the 5B
      ["calisthenics_moves_high_noise.safetensors", ["Aisha-AI-Official/wan2.2-calisthenic-moves", "32a3d164f03f18624bbbd2754efeccc926354c80"], "models/loras/", 153453560], // its extra LoRA
    ];
    const doc = shipped();
    for (const [file, [repo, revision], dest, size] of expected) {
      expect((doc.models as Doc[]).filter((m) => m.file === file), file).toEqual([{ file, repo, revision, dest, size_bytes: size }]);
    }
    const familyFiles = new Set((doc.video_families[0].models as Doc[]).map((m) => m.file));
    expect([...familyFiles].sort()).toEqual(expected.map(([f]) => f.split("/").pop()).sort());
    // 62.49 GB of its own files (the extra LoRA's 0.15 GB included) plus the shared 6.74 GB text encoder.
    expect(expected.reduce((n, e) => n + e[3], 0)).toBe(69_228_418_399);
  });

  it("reads an enabled, pinned family: both modes, fixed inputs and the expert slots", () => {
    const f = fam();
    expect(f).toMatchObject({ id: "wan22_a14b", title: "Quality (14B, 4 steps)", fps: 16 });
    expect(f.sizes.map((z) => [z.name, z.width, z.height])).toEqual([["Landscape", 832, 480], ["Portrait", 480, 832]]);
    expect(f.durations).toEqual([{ name: "About 3 s", frames: 49, seconds: 3 }, { name: "About 5 s", frames: 81, seconds: 5 }]);
    expect(f.text.startImage).toBeNull();
    expect(f.image.startImage).toEqual({ node: "11", input: "start_image" });
    expect(f.text.experts).toEqual([
      { slot: "high", file: "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors" },
      { slot: "low", file: "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors" },
    ]);
    expect(f.image.experts.map((e) => e.file)).toEqual(["wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"]);
    expect(f.text.fixed).toContainEqual({ node: "5", input: "shift", value: 5 });
    expect(f.text.fixed).toContainEqual({ node: "3", input: "strength_model", value: 1 });
    expect(f.models).toHaveLength(11);
  });

  it("refuses an unknown id in VIDEO_FAMILIES (also while video is off) and accepts the base id", () => {
    expect(() => families(undefined, ["wan22_a14b", "nope"])).toThrow(/VIDEO_FAMILIES names an unknown video family: nope/);
    expect(() => families(undefined, ["nope"], false)).toThrow(/unknown video family/);
    expect(families(undefined, ["wan22_5b", "wan22_a14b"])).toHaveLength(1);
  });

  it("refuses an enabled family whose file is missing or downloads into another folder", () => {
    expect(() => families(undefined, undefined, true, PINS.slice(1))).toThrow(/is not listed in models/);
    const wrong = PINS.map((m, i) => (i === 9 ? { ...m, dest: "models/loras/" } : m));
    expect(() => families(undefined, undefined, true, wrong)).toThrow(/must have dest models\/vae\//);
  });

  it.each<[string, (f: Doc) => void]>([
    ["an unknown key", (f) => (f.extra = 1)],
    ["the old enabled switch", (f) => (f.enabled = true)],
    ["a bad id", (f) => (f.id = "A-B")],
    ["the base family's id", (f) => (f.id = "wan22_5b")],
    ["a blank title", (f) => (f.title = "")],
    ["no models", (f) => (f.models = [])],
    ["too many models", (f) => (f.models = Array.from({ length: 17 }, (_x, i) => ({ file: `m${i}.safetensors`, dest: "models/loras/" })))],
    ["a model with a path", (f) => (f.models[0].file = "a/b.safetensors")],
    ["a bad node class", (f) => (f.node_classes = ["a b"])],
    ["fps zero", (f) => (f.fps = 0)],
    ["no sizes", (f) => (f.sizes = [])],
    ["frames not 4n+1", (f) => (f.durations[0].frames = 50)],
    ["no text mode", (f) => delete f.text],
    ["no image mode", (f) => delete f.image],
    ["a mode with an unknown key", (f) => (f.text.steps = 4)],
    ["a text mode with a start image", (f) => (f.text.start_image = { node: "11", input: "start_image" })],
    ["an image mode without a start image", (f) => delete f.image.start_image],
    ["a mode workflow with a bad name", (f) => (f.text.workflow = "../x.json")],
    ["a mode without a param", (f) => delete f.text.params.seed],
    ["a mode with an unknown param", (f) => (f.text.params.cfg = { node: "12", input: "cfg" })],
    ["a bad output node", (f) => (f.text.output_node = "a b")],
    ["no experts", (f) => (f.text.experts = [])],
    ["one expert only", (f) => f.text.experts.pop()],
    ["a duplicate expert slot", (f) => (f.text.experts[1].slot = "high")],
    ["a bad expert slot", (f) => (f.text.experts[0].slot = "High!")],
    ["an expert that is not a family model", (f) => (f.text.experts[0].file = "other.safetensors")],
    ["an expert that is not a diffusion model", (f) => (f.text.experts[0].file = "wan_2.1_vae.safetensors")],
    ["a fixed value that is not a number", (f) => (f.text.fixed[0].value = "1")],
    ["a fixed value out of range", (f) => (f.text.fixed[0].value = 1e9)],
    ["a fixed input a param sets", (f) => (f.text.fixed[0] = { node: "12", input: "noise_seed", value: 1 })],
    ["a fixed input twice", (f) => (f.text.fixed[1] = { ...f.text.fixed[0] })],
    ["a fixed entry with an extra key", (f) => (f.text.fixed[0].why = "x")],
  ])("refuses a family with %s (also when off)", (_n, mutate) => {
    expect(() => families(mutate)).toThrow(ProfileError);
    expect(() => families(mutate, [], false)).toThrow(ProfileError);
  });

  it("refuses duplicate ids and a list that is not a list", () => {
    const f = raw14();
    expect(() => parseVideoFamilies([f, structuredClone(f)], PINS, { enabled: [], videoEnabled: true, baseId: null })).toThrow(/unique/);
    expect(() => parseVideoFamilies({ a: 1 }, PINS, { enabled: [], videoEnabled: true, baseId: null })).toThrow(ProfileError);
  });
});

describe("checkVideoFamily", () => {
  it("accepts the shipped 14B workflows", () => {
    expect(() => checkVideoFamily(fam(), TEMPLATES)).not.toThrow();
  });

  it.each<[string, "text" | "image", (t: Doc) => void, RegExp]>([
    ["a mapped input is missing", "text", (t) => delete t["11"].inputs.length, /node 11 input length/],
    ["a fixed input is missing", "image", (t) => delete t["5"].inputs.shift, /node 5 input shift/],
    ["the output node is not SaveVideo", "text", (t) => (t["16"].class_type = "SaveImage"), /SaveVideo/],
    ["an expert is not loaded by a UNETLoader", "text", (t) => (t["1"].class_type = "CheckpointLoaderSimple"), /UNETLoader/],
    ["an expert is not loaded at all", "image", (t) => (t["2"].inputs.unet_name = "x.safetensors"), /wan2\.2_i2v_low_noise/],
    ["the start image input is already wired", "image", (t) => (t["11"].inputs.start_image = ["1", 0]), /start_image/],
    ["the start image node id is taken", "image", (t) => (t[VIDEO_START_NODE] = { class_type: "LoadImage", inputs: {} }), new RegExp(VIDEO_START_NODE)],
  ])("refuses a workflow where %s", (_n, mode, mutate, message) => {
    const t = { text: structuredClone(T2V), image: structuredClone(I2V) };
    mutate(t[mode]);
    expect(() => checkVideoFamily(fam(), t)).toThrow(message);
  });

  it("refuses a family whose models neither workflow loads", () => {
    const t = { text: structuredClone(T2V), image: structuredClone(I2V) };
    t.text["8"].inputs.vae_name = "x.safetensors";
    t.image["8"].inputs.vae_name = "x.safetensors";
    expect(() => checkVideoFamily(fam(), t)).toThrow(/wan_2\.1_vae\.safetensors/);
  });
});

describe("buildVideoPrompt for a two-expert family", () => {
  it("text mode: sets the user's inputs and the fixed recipe, and adds no start image", () => {
    const p = buildVideoPrompt(fam().text, T2V, ok);
    expect(p["9"]!.inputs["text"]).toBe("a fox runs");
    expect(p["12"]!.inputs["noise_seed"]).toBe(7);
    expect(p["11"]!.inputs).toMatchObject({ width: 832, height: 480, length: 81 });
    expect(p["15"]!.inputs["fps"]).toBe(16);
    expect(p["12"]!.inputs).toMatchObject({ steps: 4, cfg: 1, start_at_step: 0, end_at_step: 2, add_noise: "enable", return_with_leftover_noise: "enable" });
    expect(p["13"]!.inputs).toMatchObject({ steps: 4, cfg: 1, start_at_step: 2, end_at_step: 4, add_noise: "disable" });
    expect(p[VIDEO_START_NODE]).toBeUndefined();
  });

  it("applies the fixed values over whatever the workflow file says", () => {
    const t = structuredClone(T2V);
    t["5"].inputs.shift = 8;
    t["3"].inputs.strength_model = 0.3;
    const p = buildVideoPrompt(fam().text, t, ok);
    expect(p["5"]!.inputs["shift"]).toBe(5);
    expect(p["3"]!.inputs["strength_model"]).toBe(1);
    expect(t["5"].inputs.shift).toBe(8); // the template is not mutated
  });

  it("text mode refuses a start image (image mode takes it)", () => {
    expect(() => buildVideoPrompt(fam().text, T2V, { ...ok, startImage: "a.png" })).toThrow(expect.objectContaining({ code: "workflow_mismatch" }));
    const p = buildVideoPrompt(fam().image, I2V, { ...ok, startImage: "video-abc.png" });
    expect(p[VIDEO_START_NODE]).toEqual({ class_type: "LoadImage", inputs: { image: "video-abc.png" } });
    expect(p["11"]!.inputs["start_image"]).toEqual([VIDEO_START_NODE, 0]);
  });

  it("linked experts replace both pinned files, each in its own loader (a .gguf one gets the GGUF loader)", () => {
    const p = buildVideoPrompt(fam().text, T2V, { ...ok, links: { high: "hi-Q4_K_M.gguf", low: "lo.safetensors" } });
    expect(p["1"]).toEqual({ class_type: "UnetLoaderGGUF", inputs: { unet_name: "hi-Q4_K_M.gguf" } });
    expect(p["2"]).toEqual({ class_type: "UNETLoader", inputs: { unet_name: "lo.safetensors", weight_dtype: "default" } });
    expect(p["3"]!.inputs["model"]).toEqual(["1", 0]);
    expect(JSON.stringify(p)).not.toContain("t2v_high_noise_14B");
  });

  it("refuses one-sided links, an unknown slot and an unsafe name", () => {
    const bad: Record<string, string>[] = [
      { high: "hi.gguf" },
      { low: "lo.gguf" },
      { high: "hi.gguf", low: "lo.gguf", mid: "x.gguf" },
      { high: "../hi.gguf", low: "lo.gguf" },
      { high: "hi.ckpt", low: "lo.gguf" },
      { high: "same.gguf", low: "same.gguf" },
      { high: "wan_2.1_vae.safetensors", low: "lo.gguf" },
    ];
    for (const links of bad) expect(() => buildVideoPrompt(fam().text, T2V, { ...ok, links }), JSON.stringify(links)).toThrow(expect.objectContaining({ code: "workflow_mismatch" }));
  });
});

describe("video with a family", () => {
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
  const png = (): Buffer => {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "latin1");
    ihdr.writeUInt32BE(64, 8);
    ihdr.writeUInt32BE(64, 12);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
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
        if (req.url === "/prompt") return json(res, 200, { prompt_id: "p-14" });
        json(res, 404, {});
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const cfg = {
      comfyPort: port, httpTimeoutSApps: 5, webJsonMaxBytes: 65536, webImageMaxBytes: 65536, webImageTimeoutS: 5,
      generateMaxPromptChars: 40,
      editMaxReferences: 3, editReferenceMaxBytes: 4096, editReferenceMaxPixels: 1_000_000, editReferenceMaxSide: 8192, editReferenceTypes: ["png", "jpeg", "webp"],
      secretNames: [],
    } as unknown as AppsConfig;
    // The base section is off here: a family's job never reads it.
    const profile = { video: null } as unknown as Profile;
    const f = fam();
    const deps: VideoDeps = {
      comfy: new ComfyClient("127.0.0.1", cfg), profile, template: null, cfg, newName: () => "tok", random: () => 0.5,
      family: { text: { spec: f.text, template: T2V }, image: { spec: f.image, template: I2V } },
    };
    return { deps, seen };
  }

  it("text to video uses the text workflow; image to video the image workflow with the uploaded start image", async () => {
    const { deps, seen } = await fake();
    expect(await video(deps, { prompt: "a fox", size: "Portrait", duration: "About 3 s", seed: 3 })).toEqual({ promptId: "p-14", startImage: false });
    const text = JSON.parse(seen[0]!.body.toString()).prompt;
    expect(text["1"].inputs.unet_name).toBe("wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors");
    expect(text["11"].inputs).toMatchObject({ width: 480, height: 832, length: 49 });
    expect(await video(deps, { prompt: "a fox", size: "Landscape", duration: "About 5 s", image: png().toString("base64") })).toEqual({ promptId: "p-14", startImage: true });
    const image = JSON.parse(seen[2]!.body.toString()).prompt;
    expect(image["1"].inputs.unet_name).toBe("wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors");
    expect(image[VIDEO_START_NODE].inputs.image).toBe("video-tok.png");
  });

  it("uses the mode's linked experts, and refuses before anything is sent when a link is one-sided", async () => {
    const { deps, seen } = await fake();
    await video({ ...deps, links: { high: "h.gguf", low: "l.gguf" } }, { prompt: "a fox", size: "Landscape", duration: "About 3 s" });
    const p = JSON.parse(seen[0]!.body.toString()).prompt;
    expect(p["1"]).toEqual({ class_type: "UnetLoaderGGUF", inputs: { unet_name: "h.gguf" } });
    await expect(video({ ...deps, links: { high: "h.gguf" } }, { prompt: "a fox", size: "Landscape", duration: "About 3 s", image: png().toString("base64") }))
      .rejects.toMatchObject({ code: "workflow_mismatch" });
    expect(seen).toHaveLength(1);
  });

  it("refuses a size or duration the family does not offer", async () => {
    const { deps, seen } = await fake();
    await expect(video(deps, { prompt: "a fox", size: "Landscape, faster", duration: "About 3 s" })).rejects.toMatchObject({ code: "unknown_size" });
    await expect(video(deps, { prompt: "a fox", size: "Landscape", duration: "About 3 s".replace("3", "4") })).rejects.toMatchObject({ code: "unknown_duration" });
    expect(seen).toHaveLength(0);
  });
});

describe("extra LoRAs of a family", () => {
  const LORA = "calisthenics_moves_high_noise.safetensors";
  const withLow = (f: Doc) => {
    f.models.push({ file: "low_extra.safetensors", dest: "models/loras/" });
    f.extra_loras[0].low = { file: "low_extra.safetensors" };
  };
  const pinsWithLow = [...PINS, { file: "split_files/x/low_extra.safetensors", dest: "models/loras/" }];

  it("reads the shipped entry: title, modes, default strength, its high-side file and no trigger words yet", () => {
    const f = fam();
    expect(f.extraLoras).toEqual([
      { id: "calisthenic_moves", title: "Calisthenic moves", description: "Adds calisthenics moves (high-noise expert only).", modes: ["text", "image"], files: { high: LORA }, strength: 0.6, triggerWords: "" },
    ]);
    expect(f.text.extraLoras).toBe(f.extraLoras);
    expect(f.text.loraAfter).toEqual({ high: "3", low: "4" });
    expect(f.models.map((m) => m.file)).toContain(LORA); // downloaded with the family
  });

  it.each<[string, (f: Doc) => void]>([
    ["an unknown key", (f) => (f.extra_loras[0].weight = 1)],
    ["a bad id", (f) => (f.extra_loras[0].id = "Bad")],
    ["a duplicate id", (f) => f.extra_loras.push(structuredClone(f.extra_loras[0]))],
    ["a blank title", (f) => (f.extra_loras[0].title = " ")],
    ["a description that is not text", (f) => (f.extra_loras[0].description = 5)],
    ["no modes", (f) => (f.extra_loras[0].modes = [])],
    ["an unknown mode", (f) => (f.extra_loras[0].modes = ["video"])],
    ["a mode twice", (f) => (f.extra_loras[0].modes = ["text", "text"])],
    ["no file at all", (f) => delete f.extra_loras[0].high],
    ["a file that is not a family model", (f) => (f.extra_loras[0].high.file = "other.safetensors")],
    ["a file that is not a LoRA", (f) => (f.extra_loras[0].high.file = "wan_2.1_vae.safetensors")],
    ["a side with an extra key", (f) => (f.extra_loras[0].high.strength = 1)],
    ["a strength above 1", (f) => (f.extra_loras[0].strength = 1.5)],
    ["a negative strength", (f) => (f.extra_loras[0].strength = -0.1)],
    ["a strength that is not a number", (f) => (f.extra_loras[0].strength = "0.6")],
    ["trigger words that are not text", (f) => (f.extra_loras[0].trigger_words = ["x"])],
    ["a mode without lora_after", (f) => delete f.text.lora_after],
    ["a lora_after missing the used side", (f) => (f.image.lora_after = { low: "4" })],
    ["a lora_after with an unknown slot", (f) => (f.text.lora_after = { high: "3", low: "4", mid: "5" })],
    ["a lora_after with a bad node id", (f) => (f.text.lora_after = { high: "a b", low: "4" })],
    ["a lora_after on a param's node input", (f) => (f.text.lora_after = 5)],
  ])("refuses an entry with %s (also when off)", (_n, mutate) => {
    expect(() => families(mutate)).toThrow(ProfileError);
    expect(() => families(mutate, [], false)).toThrow(ProfileError);
  });

  it("an entry without a strength gets 0.6, the usual recommendation (UNVERIFIED for this LoRA)", () => {
    expect(families((f) => delete f.extra_loras[0].strength)[0]!.extraLoras[0]!.strength).toBe(0.6);
  });

  it("a family without extra_loras has none, and needs no lora_after", () => {
    const f = families((x) => {
      delete x.extra_loras;
      delete x.text.lora_after;
      delete x.image.lora_after;
      x.models = x.models.filter((m: Doc) => m.file !== LORA);
    })[0]!;
    expect(f.extraLoras).toEqual([]);
    expect(f.text.loraAfter).toEqual({});
  });

  it("checkVideoFamily: an extra LoRA file need not be in a workflow; lora_after must be a LoRA node", () => {
    expect(() => checkVideoFamily(fam(), TEMPLATES)).not.toThrow();
    const t = { text: structuredClone(T2V), image: structuredClone(I2V) };
    t.image["3"].class_type = "ModelSamplingSD3";
    expect(() => checkVideoFamily(fam(), t)).toThrow(/node 3 .*LoraLoaderModelOnly/);
    const taken = { text: structuredClone(T2V), image: structuredClone(I2V) };
    taken.text["video_lora_high"] = { class_type: "LoadImage", inputs: {} };
    expect(() => checkVideoFamily(fam(), taken)).toThrow(/video_lora_high/);
  });

  it("inserts the chosen LoRA after the 4-step LoRA of its branch, before ModelSamplingSD3, with the strength", () => {
    const p = buildVideoPrompt(fam().text, T2V, { ...ok, extraLora: { id: "calisthenic_moves", strength: 0.45 } });
    expect(p["video_lora_high"]).toEqual({ class_type: "LoraLoaderModelOnly", inputs: { model: ["3", 0], lora_name: LORA, strength_model: 0.45 } });
    expect(p["5"]!.inputs["model"]).toEqual(["video_lora_high", 0]);
    expect(p["6"]!.inputs["model"]).toEqual(["4", 0]); // no low file: the low branch is unchanged
    expect(p["video_lora_low"]).toBeUndefined();
    expect(T2V["5"].inputs.model).toEqual(["3", 0]); // the template is not mutated
    const i = buildVideoPrompt(fam().image, I2V, { ...ok, startImage: "a.png", extraLora: { id: "calisthenic_moves", strength: 1 } });
    expect(i["5"]!.inputs["model"]).toEqual(["video_lora_high", 0]);
  });

  it("an entry with both sides gets a node in each branch", () => {
    const f = families(withLow, undefined, true, pinsWithLow)[0]!;
    const p = buildVideoPrompt(f.text, T2V, { ...ok, extraLora: { id: "calisthenic_moves", strength: 0.6 } });
    expect(p["video_lora_low"]).toEqual({ class_type: "LoraLoaderModelOnly", inputs: { model: ["4", 0], lora_name: "low_extra.safetensors", strength_model: 0.6 } });
    expect(p["6"]!.inputs["model"]).toEqual(["video_lora_low", 0]);
  });

  it("refuses an unknown LoRA, one not of this mode, a strength out of range, and a LoRA for a spec without any", () => {
    const one = (strength: number) => ({ id: "calisthenic_moves", strength });
    expect(() => buildVideoPrompt(fam().text, T2V, { ...ok, extraLora: { id: "nope", strength: 0.5 } })).toThrow(expect.objectContaining({ code: "unknown_extra_lora" }));
    const textOnly = families((f) => (f.extra_loras[0].modes = ["text"]))[0]!;
    expect(() => buildVideoPrompt(textOnly.image, I2V, { ...ok, startImage: "a.png", extraLora: one(0.5) })).toThrow(expect.objectContaining({ code: "extra_lora_mode" }));
    expect(() => buildVideoPrompt(textOnly.text, T2V, { ...ok, extraLora: one(0.5) })).not.toThrow();
    for (const strength of [-0.01, 1.01, Number.NaN, Infinity]) {
      expect(() => buildVideoPrompt(fam().text, T2V, { ...ok, extraLora: one(strength) })).toThrow(expect.objectContaining({ code: "invalid_strength" }));
    }
    for (const strength of [0, 1]) expect(() => buildVideoPrompt(fam().text, T2V, { ...ok, extraLora: one(strength) })).not.toThrow();
    const base = parseVideo(shipped().video, shipped().models, true)!;
    const baseTpl = tpl(shipped().video.workflow);
    expect(() => buildVideoPrompt(base, baseTpl, { ...ok, size: "Landscape", duration: "About 3 s", extraLora: one(0.5) })).toThrow(expect.objectContaining({ code: "extra_lora_unavailable" }));
  });

  it("video(): takes extra_lora and extra_lora_strength (the entry's default when absent), checked before anything is sent", async () => {
    const f = fam();
    const sent: unknown[] = [];
    const comfy = { submit: async (p: unknown) => (sent.push(p), { promptId: "p-x" }), uploadImage: async () => ({ name: "u.png", subfolder: "", type: "input" }) };
    const cfg = { generateMaxPromptChars: 40, editMaxReferences: 3, editReferenceMaxBytes: 4096, editReferenceMaxPixels: 1_000_000, editReferenceMaxSide: 8192, editReferenceTypes: ["png"], secretNames: [] } as unknown as AppsConfig;
    const deps: VideoDeps = {
      comfy: comfy as unknown as VideoDeps["comfy"], profile: { video: null } as unknown as Profile, template: null, cfg, random: () => 0.5,
      family: { text: { spec: f.text, template: T2V }, image: { spec: f.image, template: I2V } },
    };
    const body = { prompt: "a fox", size: "Landscape", duration: "About 5 s" };
    await video(deps, { ...body, extra_lora: "calisthenic_moves" });
    expect((sent[0] as Doc)["video_lora_high"].inputs.strength_model).toBe(0.6);
    await video(deps, { ...body, extra_lora: "calisthenic_moves", extra_lora_strength: 0.25 });
    expect((sent[1] as Doc)["video_lora_high"].inputs.strength_model).toBe(0.25);
    await video(deps, { ...body, extra_lora: null });
    expect((sent[2] as Doc)["video_lora_high"]).toBeUndefined();
    const bad: [Doc, string][] = [
      [{ ...body, extra_lora: 5 }, "unknown_extra_lora"],
      [{ ...body, extra_lora: "nope" }, "unknown_extra_lora"],
      [{ ...body, extra_lora: "calisthenic_moves", extra_lora_strength: "0.5" }, "invalid_strength"],
      [{ ...body, extra_lora: "calisthenic_moves", extra_lora_strength: 2 }, "invalid_strength"],
      [{ ...body, extra_lora_strength: 0.5 }, "invalid_strength"], // a strength without a LoRA
    ];
    for (const [input, code] of bad) await expect(video(deps, input), JSON.stringify(input)).rejects.toMatchObject({ code });
    expect(sent).toHaveLength(3);
  });
});
