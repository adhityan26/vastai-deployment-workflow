import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { AppsConfig } from "../src/config.js";
import { ComfyClient } from "../src/comfy.js";
import { pollResult, video, type GenerateDeps, type VideoDeps } from "../src/generate.js";
import { GenerateInputError, ProfileError } from "../src/profile-errors.js";
import type { Profile } from "../src/profile.js";
import { VIDEO_START_NODE, buildVideoPrompt, checkVideoTemplate, parseVideo, sniffVideo } from "../src/video.js";

type Doc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const shipped = () => parseYaml(readFileSync(repo("instance/profiles/image.yaml"), "utf8"));
const template = JSON.parse(readFileSync(repo(`instance/workflows/${shipped().video.workflow}`), "utf8"));

/** Pinned-looking entries for the section's three model files (a path in the repo, like the real pins). */
const MODELS = (shipped().video.models as Doc[]).map((m) => ({ file: `split_files/x/${m.file}`, dest: m.dest }));

/** The section as it ships, switched on. */
function section(mutate?: (s: Doc) => void): Doc {
  const s = structuredClone(shipped().video);
  s.enabled = true;
  mutate?.(s);
  return s;
}
const spec = () => parseVideo(section(), MODELS)!;

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

/** The first bytes of an ISO base media (mp4) file: a ftyp box with the given major brand. */
function mp4(brand = "isom", size = 32): Buffer {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(24, 0);
  b.write("ftyp", 4, "latin1");
  b.write(brand, 8, "latin1");
  b.write("isomiso2avc1mp41", 16 > size ? 0 : 16, "latin1");
  return b;
}
/** The first bytes of a WebM file: an EBML header whose DocType is webm. */
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(16)]);

describe("parseVideo", () => {
  it("is null when absent or disabled, even before the model files are pinned", () => {
    expect(parseVideo(undefined, [])).toBeNull();
    expect(parseVideo(null, [])).toBeNull();
    expect(parseVideo(section((s) => (s.enabled = false)), [])).toBeNull();
  });

  it("the shipped profile has the section switched off (its model files are not pinned yet)", () => {
    const doc = shipped();
    expect(doc.video.enabled).toBe(false);
    expect(parseVideo(doc.video, doc.models)).toBeNull();
    expect(() => parseVideo({ ...doc.video, enabled: true }, doc.models)).toThrow(/is not listed in models/);
  });

  it("reads an enabled section: sizes, durations with their seconds, fps, the mapped inputs", () => {
    const s = spec();
    expect(s.workflow).toBe("video-ti2v.json");
    expect(s.fps).toBe(24);
    expect(s.sizes.map((z) => [z.name, z.width, z.height])).toEqual([
      ["Landscape", 1280, 704], ["Portrait", 704, 1280], ["Landscape, faster", 832, 480], ["Portrait, faster", 480, 832],
    ]);
    expect(s.durations).toEqual([{ name: "About 3 s", frames: 73, seconds: 3 }, { name: "About 5 s", frames: 121, seconds: 5 }]);
    expect(s.params.seed).toEqual({ node: "8", input: "seed" });
    expect(s.startImage).toEqual({ node: "7", input: "start_image" });
    expect(s.outputNode).toBe("11");
  });

  it("refuses an enabled section whose model is missing or downloads into another folder", () => {
    expect(() => parseVideo(section(), MODELS.slice(1))).toThrow(/video model .* is not listed in models/);
    const wrong = MODELS.map((m, i) => (i === 2 ? { ...m, dest: "models/loras/" } : m));
    expect(() => parseVideo(section(), wrong)).toThrow(/must have dest models\/vae\//);
    expect(parseVideo(section(), MODELS.map((m) => ({ ...m, dest: m.dest.replace(/\/$/, "") })))).not.toBeNull();
  });

  it.each<[string, (s: Doc) => void]>([
    ["an unknown key", (s) => (s.extra = 1)],
    ["enabled not boolean", (s) => (s.enabled = "yes")],
    ["a bad workflow name", (s) => (s.workflow = "../x.json")],
    ["no models", (s) => (s.models = [])],
    ["a model with a path", (s) => (s.models[0].file = "a/b.safetensors")],
    ["a model with a bad dest", (s) => (s.models[0].dest = "/abs/")],
    ["a bad node class", (s) => (s.node_classes = ["a/b"])],
    ["a missing param", (s) => delete s.params.length],
    ["an unknown param", (s) => (s.params.cfg = { node: "8", input: "cfg" })],
    ["a param with a bad node id", (s) => (s.params.seed.node = "a b")],
    ["two params on one input", (s) => (s.params.height = { node: "7", input: "width" })],
    ["the start image on a param's input", (s) => (s.start_image = { node: "7", input: "length" })],
    ["no output node", (s) => delete s.output_node],
    ["a bad output node", (s) => (s.output_node = "a b")],
    ["fps zero", (s) => (s.fps = 0)],
    ["fps fractional", (s) => (s.fps = 23.976)],
    ["fps too high", (s) => (s.fps = 61)],
    ["no sizes", (s) => (s.sizes = [])],
    ["a size not on the 32 grid", (s) => (s.sizes[0].width = 1290)],
    ["a size too large", (s) => (s.sizes[0] = { name: "huge", width: 4096, height: 2304 })],
    ["duplicate sizes", (s) => (s.sizes[1].name = s.sizes[0].name)],
    ["no durations", (s) => (s.durations = [])],
    ["frames not 4n+1", (s) => (s.durations[0].frames = 72)],
    ["too many frames", (s) => (s.durations[0].frames = 4 * 100 + 1)],
    ["too few frames", (s) => (s.durations[0].frames = 1)],
    ["fractional frames", (s) => (s.durations[0].frames = 73.5)],
    ["duplicate durations", (s) => (s.durations[1].name = s.durations[0].name)],
    ["a duration with an extra key", (s) => (s.durations[0].seconds = 3)],
    ["a blank duration name", (s) => (s.durations[0].name = " ")],
  ])("refuses a section with %s (also when disabled)", (name, mutate) => {
    expect(() => parseVideo(section(mutate), MODELS)).toThrow(ProfileError);
    if (name !== "enabled not boolean") expect(() => parseVideo(section((s) => { s.enabled = false; mutate(s); }), MODELS)).toThrow(ProfileError);
  });
});

describe("checkVideoTemplate", () => {
  it("accepts the shipped workflow", () => {
    expect(() => checkVideoTemplate(spec(), template)).not.toThrow();
  });

  it.each<[string, (t: Doc) => void, RegExp]>([
    ["a mapped input is missing", (t) => delete t["7"].inputs.length, /node 7 input length/],
    ["the start image node is missing", (t) => delete t["7"], /node 7/],
    ["the output node is not SaveVideo", (t) => (t["11"].class_type = "SaveImage"), /SaveVideo/],
    ["a listed model file is not used", (t) => (t["3"].inputs.vae_name = "other.safetensors"), /wan2.2_vae.safetensors/],
    ["the start image node id is taken", (t) => (t[VIDEO_START_NODE] = { class_type: "LoadImage", inputs: {} }), new RegExp(VIDEO_START_NODE)],
    ["the start image input is already wired", (t) => (t["7"].inputs.start_image = ["1", 0]), /start_image/],
  ])("refuses a workflow where %s", (_n, mutate, message) => {
    const t = structuredClone(template);
    mutate(t);
    expect(() => checkVideoTemplate(spec(), t)).toThrow(message);
  });
});

describe("buildVideoPrompt", () => {
  it("text to video: sets prompt, seed, size, frames and fps and changes nothing else", () => {
    const p = buildVideoPrompt(spec(), template, { prompt: "a fox runs", seed: 7, size: "Landscape, faster", duration: "About 3 s" });
    expect(p["5"]!.inputs["text"]).toBe("a fox runs");
    expect(p["8"]!.inputs["seed"]).toBe(7);
    expect(p["7"]!.inputs).toMatchObject({ width: 832, height: 480, length: 73 });
    expect(p["7"]!.inputs["start_image"]).toBeUndefined();
    expect(p["10"]!.inputs["fps"]).toBe(24);
    expect(p[VIDEO_START_NODE]).toBeUndefined();
    expect(p["6"]).toEqual(template["6"]);
    expect(template["5"].inputs.text).toBe(""); // the template is not mutated
  });

  it("image to video: adds one LoadImage node and wires it to the start image input", () => {
    const p = buildVideoPrompt(spec(), template, { prompt: "it moves", seed: 1, size: "Portrait", duration: "About 5 s", startImage: "video-abc.png" });
    expect(p[VIDEO_START_NODE]).toEqual({ class_type: "LoadImage", inputs: { image: "video-abc.png" } });
    expect(p["7"]!.inputs["start_image"]).toEqual([VIDEO_START_NODE, 0]);
    expect(p["7"]!.inputs).toMatchObject({ width: 704, height: 1280, length: 121 });
  });

  it("refuses unknown names, a bad seed, a blank prompt and an unsafe file name", () => {
    const ok = { prompt: "x", seed: 1, size: "Landscape", duration: "About 3 s" };
    expect(() => buildVideoPrompt(spec(), template, { ...ok, size: "8K" })).toThrow(expect.objectContaining({ code: "unknown_size" }));
    expect(() => buildVideoPrompt(spec(), template, { ...ok, duration: "1 h" })).toThrow(expect.objectContaining({ code: "unknown_duration" }));
    expect(() => buildVideoPrompt(spec(), template, { ...ok, seed: -1 })).toThrow(expect.objectContaining({ code: "invalid_seed" }));
    expect(() => buildVideoPrompt(spec(), template, { ...ok, prompt: " " })).toThrow(expect.objectContaining({ code: "invalid_prompt" }));
    expect(() => buildVideoPrompt(spec(), template, { ...ok, startImage: "../x.png" })).toThrow(expect.objectContaining({ code: "invalid_reference_name" }));
    const bad = structuredClone(template);
    delete bad["8"].inputs.seed;
    expect(() => buildVideoPrompt(spec(), bad, ok)).toThrow(expect.objectContaining({ code: "workflow_mismatch" }));
  });
});

describe("buildVideoPrompt with a linked diffusion model", () => {
  const ok = { prompt: "x", seed: 1, size: "Landscape", duration: "About 3 s" };
  it("names the linked file wherever the workflow named the pinned diffusion model", () => {
    const pinned = (shipped().video.models as Doc[]).find((m) => m.dest.startsWith("models/diffusion_models"))!.file;
    const p = buildVideoPrompt(spec(), template, { ...ok, diffusionFile: "better_unet.safetensors" });
    expect(JSON.stringify(p)).not.toContain(pinned);
    expect(p["1"]!.inputs["unet_name"]).toBe("better_unet.safetensors");
    expect(p["2"]).toEqual(template["2"]); // text encoder and VAE stay pinned
    expect(p["3"]).toEqual(template["3"]);
  });

  it("a .gguf file turns the UNETLoader into the GGUF loader with only its unet_name input", () => {
    const p = buildVideoPrompt(spec(), template, { ...ok, diffusionFile: "better-Q5_K_M.gguf" });
    expect(p["1"]).toEqual({ class_type: "UnetLoaderGGUF", inputs: { unet_name: "better-Q5_K_M.gguf" } });
    expect(p["4"]!.inputs["model"]).toEqual(["1", 0]); // the sampler still reads node 1's model
    expect(template["1"].class_type).toBe("UNETLoader"); // the template is not mutated
    const odd = structuredClone(template);
    odd["1"].class_type = "SomethingElse";
    expect(() => buildVideoPrompt(spec(), odd, { ...ok, diffusionFile: "b.gguf" })).toThrow(expect.objectContaining({ code: "workflow_mismatch" }));
  });

  it("refuses a name that is not a plain .safetensors or .gguf file", () => {
    for (const bad of ["../x.safetensors", "x.ckpt", "a/b.safetensors", ""]) {
      expect(() => buildVideoPrompt(spec(), template, { ...ok, diffusionFile: bad })).toThrow(expect.objectContaining({ code: "workflow_mismatch" }));
    }
  });
});

describe("sniffVideo", () => {
  it("recognises mp4 (ISO base media with a ftyp box) and WebM by their first bytes", () => {
    expect(sniffVideo(mp4())).toBe("video/mp4");
    expect(sniffVideo(mp4("mp42"))).toBe("video/mp4");
    expect(sniffVideo(webm())).toBe("video/webm");
  });

  it("refuses anything else: images, HTML, a truncated or empty body, a ftyp of another family", () => {
    expect(sniffVideo(png(10, 10))).toBeNull();
    expect(sniffVideo(Buffer.from("<!doctype html><html><body>hi</body></html>"))).toBeNull();
    expect(sniffVideo(Buffer.alloc(0))).toBeNull();
    expect(sniffVideo(mp4().subarray(0, 10))).toBeNull();
    expect(sniffVideo(mp4("heic"))).toBeNull(); // an image in the same container family
    expect(sniffVideo(mp4("qt  "))).toBeNull();
    const shortBox = mp4();
    shortBox.writeUInt32BE(4, 0); // a box smaller than its own header
    expect(sniffVideo(shortBox)).toBeNull();
    const notWebm = webm();
    notWebm.write("mkv!", 12, "latin1");
    expect(sniffVideo(notWebm)).toBeNull();
    const longerDocType = webm();
    longerDocType[11] = 0x85; // "webm" is only the start of a five-byte DocType
    expect(sniffVideo(longerDocType)).toBeNull();
  });
});

describe("video", () => {
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

  async function fake(enabled = true) {
    const seen: { url: string; body: Buffer }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ url: req.url ?? "", body });
        if (req.url === "/upload/image") return json(res, 200, { name: /filename="([^"]+)"/.exec(body.toString("latin1"))![1], subfolder: "", type: "input" });
        if (req.url === "/prompt") return json(res, 200, { prompt_id: "p-vid" });
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
    const profile = { video: enabled ? spec() : null } as unknown as Profile;
    const deps: VideoDeps = { comfy: new ComfyClient("127.0.0.1", cfg), profile, template, cfg, newName: () => "tok", random: () => 0.5 };
    return { deps, seen };
  }
  const ok = { prompt: "a fox runs", size: "Landscape", duration: "About 3 s" };

  it("text to video: submits the filled workflow without an upload", async () => {
    const { deps, seen } = await fake();
    expect(await video(deps, { ...ok, seed: 42 })).toEqual({ promptId: "p-vid", startImage: false });
    expect(seen.map((s) => s.url)).toEqual(["/prompt"]);
    const prompt = JSON.parse(seen[0]!.body.toString()).prompt;
    expect(prompt["8"].inputs.seed).toBe(42);
    expect(prompt["7"].inputs.length).toBe(73);
    expect(prompt[VIDEO_START_NODE]).toBeUndefined();
  });

  it("image to video: uploads the one start image under a server-chosen name, then submits", async () => {
    const { deps, seen } = await fake();
    expect(await video(deps, { ...ok, image: png(64, 64).toString("base64") })).toEqual({ promptId: "p-vid", startImage: true });
    expect(seen.map((s) => s.url)).toEqual(["/upload/image", "/prompt"]);
    expect(seen[0]!.body.toString("latin1")).toContain('filename="video-tok.png"');
    const prompt = JSON.parse(seen[1]!.body.toString()).prompt;
    expect(prompt[VIDEO_START_NODE].inputs.image).toBe("video-tok.png");
    expect(prompt["8"].inputs.seed).toBeGreaterThanOrEqual(0); // a random seed when none is asked
  });

  it("refuses bad input before anything is sent", async () => {
    const { deps, seen } = await fake();
    const bad: [Doc, string][] = [
      [{ ...ok, size: "8K" }, "unknown_size"],
      [{ ...ok, size: 5 }, "unknown_size"],
      [{ ...ok, duration: "1 h" }, "unknown_duration"],
      [{ ...ok, duration: ["About 3 s"] }, "unknown_duration"],
      [{ ...ok, prompt: "" }, "invalid_prompt"],
      [{ ...ok, prompt: 5 }, "invalid_prompt"],
      [{ ...ok, prompt: "x".repeat(41) }, "prompt_too_long"],
      [{ ...ok, seed: -1 }, "invalid_seed"],
      [{ ...ok, seed: 1.5 }, "invalid_seed"],
      [{ ...ok, image: 5 }, "invalid_reference"],
      [{ ...ok, image: "" }, "invalid_reference"],
      [{ ...ok, image: ["a", "b"] }, "invalid_reference"],
      [{ ...ok, image: "!!!!" }, "invalid_reference"],
      [{ ...ok, image: Buffer.from("not an image").toString("base64") }, "invalid_reference"],
      [{ ...ok, image: Buffer.alloc(5000).toString("base64") }, "reference_too_large"],
    ];
    for (const [input, code] of bad) await expect(video(deps, input), JSON.stringify(input).slice(0, 80)).rejects.toMatchObject({ code });
    expect(seen).toHaveLength(0);
  });

  it("is unavailable without an enabled video section", async () => {
    const { deps, seen } = await fake(false);
    await expect(video(deps, ok)).rejects.toMatchObject({ code: "video_unavailable" });
    expect(seen).toHaveLength(0);
  });
});

describe("pollResult of a video job", () => {
  const deps = (entry: unknown): GenerateDeps => ({
    comfy: { submit: async () => ({ promptId: "p" }), history: async () => entry as never },
    profile: {} as Profile,
    template,
    cfg: {} as AppsConfig,
  });

  it("takes the files the SaveVideo node reports (under images, as ComfyUI's video preview does)", async () => {
    const entry = { outputs: { "11": { images: [{ filename: "vastcomfy_00001_.mp4", subfolder: "video", type: "output" }], animated: [true] } }, status: { completed: true, status_str: "success" } };
    expect((await pollResult(deps(entry), "p"))!.images).toEqual([{ filename: "vastcomfy_00001_.mp4", subfolder: "video", type: "output" }]);
  });

  it("ignores files of other nodes and fails with no output", async () => {
    const entry = { outputs: { "9": { images: [{ filename: "frame.png", subfolder: "", type: "temp" }] } }, status: { completed: true, status_str: "success" } };
    await expect(pollResult(deps(entry), "p")).rejects.toThrow("no images");
  });
});

it("GenerateInputError is the error type of every refusal", () => {
  expect(new GenerateInputError("x", "y")).toBeInstanceOf(Error);
});
