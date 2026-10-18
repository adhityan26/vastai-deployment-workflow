import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { AppsConfig } from "../src/config.js";
import { ComfyClient } from "../src/comfy.js";
import { upscale, type UpscaleDeps } from "../src/generate.js";
import { GenerateInputError, ProfileError } from "../src/profile-errors.js";
import type { Profile } from "../src/profile.js";
import { buildUpscalePrompt, parseUpscale } from "../src/upscale.js";

type Doc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const template = JSON.parse(readFileSync(repo("instance/workflows/image-upscale.json"), "utf8"));
const MODEL = "4x-test.pth";

/** The section as it ships in the profile, switched on with a pinned model. */
function section(mutate?: (s: Doc) => void): Doc {
  const s = structuredClone(parseYaml(readFileSync(repo("instance/profiles/image.yaml"), "utf8")).upscale);
  s.enabled = true;
  s.model = MODEL;
  mutate?.(s);
  return s;
}
const MODELS = [MODEL];
const spec = () => parseUpscale(section(), MODELS)!;

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

describe("parseUpscale", () => {
  it("is null when absent or disabled, even with a model that is not pinned yet", () => {
    expect(parseUpscale(undefined, [])).toBeNull();
    expect(parseUpscale(parseYaml(readFileSync(repo("instance/profiles/image.yaml"), "utf8")).upscale, [])).toBeNull();
  });

  it("reads an enabled section", () => {
    const s = spec();
    expect(s.model).toBe(MODEL);
    expect(s.scales.map((x) => x.name)).toEqual(["2x", "4x"]);
  });

  it("refuses an enabled section whose model is not listed in models", () => {
    expect(() => parseUpscale(section(), ["other.pth"])).toThrow(ProfileError);
  });

  it("derives the final factor from the model factor when a scale leaves it out", () => {
    const s = parseUpscale(section((x) => { x.scales = [{ name: "2x", value: 0.5 }]; }), MODELS)!;
    expect(s.modelFactor).toBe(4);
    expect(s.scales[0]!.factor).toBe(2);
  });

  it.each<[string, (s: Doc) => void]>([
    ["unknown key", (s) => (s.extra = 1)],
    ["enabled not boolean", (s) => (s.enabled = "yes")],
    ["bad workflow", (s) => (s.workflow = "../x.json")],
    ["bad node id", (s) => (s.image.node = "a b")],
    ["bad input name", (s) => (s.scale.input = "x y")],
    ["no scales", (s) => (s.scales = [])],
    ["duplicate scale", (s) => (s.scales[1].name = "2x")],
    ["zero value", (s) => (s.scales[0].value = 0)],
    ["huge factor", (s) => (s.scales[0].factor = 1000)],
    ["factor that is not model_factor times value", (s) => (s.scales[0].factor = 3)],
    ["no model_factor", (s) => delete s.model_factor],
    ["zero model_factor", (s) => (s.model_factor = 0)],
    ["fractional model_factor", (s) => (s.model_factor = 2.5)],
    ["no model_loader", (s) => delete s.model_loader],
  ])("refuses a section with %s (also when disabled)", (_n, mutate) => {
    expect(() => parseUpscale(section((s) => { mutate(s); }), MODELS)).toThrow(ProfileError);
    if (_n !== "enabled not boolean") expect(() => parseUpscale(section((s) => { s.enabled = false; mutate(s); }), MODELS)).toThrow(ProfileError);
  });
});

describe("buildUpscalePrompt", () => {
  it("sets the model, the uploaded image and the scale, and changes nothing else", () => {
    const p = buildUpscalePrompt(spec(), template, "up-1.png", "2x");
    expect(p["2"]!.inputs["model_name"]).toBe(MODEL);
    expect(p["1"]!.inputs["image"]).toBe("up-1.png");
    expect(p["4"]!.inputs["scale_by"]).toBe(0.5);
    expect(p["3"]).toEqual(template["3"]);
    expect(template["1"].inputs.image).toBe("input.png"); // the template is not mutated
  });

  it("refuses an unknown scale and a workflow that lacks a mapped input", () => {
    expect(() => buildUpscalePrompt(spec(), template, "a.png", "8x")).toThrow(GenerateInputError);
    const bad = structuredClone(template);
    delete bad["4"].inputs.scale_by;
    expect(() => buildUpscalePrompt(spec(), bad, "a.png", "2x")).toThrow(expect.objectContaining({ code: "workflow_mismatch" }));
  });
});

describe("upscale", () => {
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

  async function fake(over: Record<string, number> = {}, enabled = true, cfgOver: Record<string, unknown> = {}) {
    const seen: { url: string; body: Buffer }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ url: req.url ?? "", body });
        if (req.url === "/upload/image") return json(res, 200, { name: /filename="([^"]+)"/.exec(body.toString("latin1"))![1], subfolder: "", type: "input" });
        if (req.url === "/prompt") return json(res, 200, { prompt_id: "p-up" });
        json(res, 404, {});
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const cfg = {
      comfyPort: port, httpTimeoutSApps: 5, webJsonMaxBytes: 65536, webImageMaxBytes: 65536, webImageTimeoutS: 5,
      editMaxReferences: 3, editReferenceMaxBytes: 4096, editReferenceMaxPixels: 1_000_000, editReferenceMaxSide: 8192, editReferenceTypes: ["png", "jpeg", "webp"],
      secretNames: [], ...cfgOver,
    } as unknown as AppsConfig;
    const profile = { upscale: enabled ? spec() : null } as unknown as Profile;
    const limits = { maxOutputPixels: 4_000_000, maxIntermediatePixels: 64_000_000, ...over };
    const deps: UpscaleDeps = { comfy: new ComfyClient("127.0.0.1", cfg), profile, template, cfg, limits, newName: () => "tok" };
    return { deps, seen };
  }

  it("uploads the image under a server-chosen name, then submits the filled workflow", async () => {
    const { deps, seen } = await fake();
    expect(await upscale(deps, { image: png(100, 50).toString("base64"), scale: "4x" })).toEqual({ promptId: "p-up", width: 100, height: 50 });
    expect(seen.map((s) => s.url)).toEqual(["/upload/image", "/prompt"]);
    expect(seen[0]!.body.toString("latin1")).toContain('filename="upscale-tok.png"');
    const prompt = JSON.parse(seen[1]!.body.toString()).prompt;
    expect(prompt["1"].inputs.image).toBe("upscale-tok.png");
    expect(prompt["4"].inputs.scale_by).toBe(1);
  });

  it("refuses bad input before anything is sent", async () => {
    const { deps, seen } = await fake();
    const ok = png(100, 100).toString("base64");
    const bad: [Doc, string][] = [
      [{ image: ok, scale: "8x" }, "unknown_scale"],
      [{ image: ok, scale: 4 }, "unknown_scale"],
      [{ image: 5, scale: "2x" }, "no_references"],
      [{ image: "!!!!", scale: "2x" }, "invalid_reference"],
      [{ image: Buffer.from("not an image").toString("base64"), scale: "2x" }, "invalid_reference"],
      [{ image: png(1000, 1000).toString("base64"), scale: "4x" }, "upscale_too_large"], // 16 MP > 4 MP
    ];
    for (const [input, code] of bad) await expect(upscale(deps, input)).rejects.toMatchObject({ code });
    expect(seen).toHaveLength(0);
  });

  it("allows a result exactly at the limit and refuses one pixel more", async () => {
    const { deps } = await fake({ maxOutputPixels: 100 * 100 * 4 });
    await expect(upscale(deps, { image: png(100, 100).toString("base64"), scale: "2x" })).resolves.toBeDefined();
    await expect(upscale(deps, { image: png(101, 100).toString("base64"), scale: "2x" })).rejects.toMatchObject({ code: "upscale_too_large" });
  });

  it("also bounds the model's native-factor image that comes before the trim", async () => {
    // 8 MP in at 2x: the result (32 MP) is inside the final bound, but the model first makes 4x (128 MP).
    const { deps, seen } = await fake({ maxOutputPixels: 33_554_432, maxIntermediatePixels: 33_554_432 }, true, { editReferenceMaxPixels: 16_777_216 });
    await expect(upscale(deps, { image: png(4096, 2048).toString("base64"), scale: "2x" })).rejects.toMatchObject({ code: "upscale_too_large", message: expect.stringContaining("intermediate") });
    expect(seen).toHaveLength(0);
    await expect(upscale(deps, { image: png(1448, 1448).toString("base64"), scale: "2x" })).resolves.toBeDefined(); // 4x of it is 33.5 MP
  });

  it("is unavailable without an upscale section", async () => {
    const { deps } = await fake({}, false);
    await expect(upscale(deps, { image: png(10, 10).toString("base64"), scale: "2x" })).rejects.toMatchObject({ code: "upscale_unavailable" });
  });
});
