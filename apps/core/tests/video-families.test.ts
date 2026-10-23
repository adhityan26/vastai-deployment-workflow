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
  it("the shipped 14B family is validated but off unless VIDEO_FAMILIES names it (its files are not pinned yet)", () => {
    const doc = shipped();
    expect(parseVideoFamilies(doc.video_families, doc.models, { enabled: [], videoEnabled: true, baseId: "wan22_5b" })).toEqual([]);
    expect(parseVideoFamilies(doc.video_families, doc.models, { enabled: ["wan22_a14b"], videoEnabled: false, baseId: "wan22_5b" })).toEqual([]);
    expect(() => parseVideoFamilies(doc.video_families, doc.models, { enabled: ["wan22_a14b"], videoEnabled: true, baseId: "wan22_5b" }))
      .toThrow(/wan2\.2_t2v_high_noise_14B_fp8_scaled\.safetensors is not listed in models \(pin it with scripts\/pin_model\.py\)/);
    expect(parseVideoFamilies(undefined, [], { enabled: [], videoEnabled: true, baseId: null })).toEqual([]);
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
    expect(f.models).toHaveLength(10);
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
