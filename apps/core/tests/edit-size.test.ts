import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppsConfig } from "../src/config.js";
import { ComfyClient } from "../src/comfy.js";
import { edit, type EditDeps } from "../src/generate.js";
import { ProfileError } from "../src/profile-errors.js";
import { buildEditPrompt, loadProfile } from "../src/profile.js";

type Doc = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const profile = loadProfile(repo("instance/profiles/image.yaml"));
const template = JSON.parse(readFileSync(repo("instance/workflows/qwen-image-edit.json"), "utf8"));

function profileWith(mutate: (doc: Doc) => void) {
  const doc = parseYaml(readFileSync(repo("instance/profiles/image.yaml"), "utf8"));
  mutate(doc);
  const dir = mkdtempSync(join(tmpdir(), "edit-size-"));
  const path = join(dir, "image.yaml");
  writeFileSync(path, stringifyYaml(doc));
  return loadProfile(path);
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

const base = { prompt: "make it real", preset: "preview", resolution: "1024", seed: 5, imageNames: ["a.png"] };

describe("the shipped edit sizes", () => {
  it("offers the four aspect ratios, all multiples of 32, and maps the sampler's latent input", () => {
    expect(profile.edit!.sizes.map((s) => [s.name, s.width, s.height])).toEqual([
      ["1:1", 1024, 1024],
      ["3:4", 896, 1152],
      ["16:9", 1344, 768],
      ["9:16", 768, 1344],
    ]);
    expect(profile.edit!.sizeLatent).toEqual({ node: "7", input: "latent_image" });
  });
});

describe("buildEditPrompt with a size", () => {
  it("without a size the workflow is exactly what it was (same latent as the encoder's)", () => {
    const p = buildEditPrompt(profile, template, base);
    expect(p["7"]!.inputs["latent_image"]).toEqual(["6", 2]);
    expect(Object.keys(p).some((k) => k.startsWith("edit_size"))).toBe(false);
  });

  it("with a size an empty latent of that width and height replaces the encoder's latent", () => {
    const p = buildEditPrompt(profile, template, { ...base, size: "16:9" });
    expect(p["edit_size_latent"]).toEqual({ class_type: "EmptySD3LatentImage", inputs: { width: 1344, height: 768, batch_size: 1 } });
    expect(p["7"]!.inputs["latent_image"]).toEqual(["edit_size_latent", 0]);
    expect(p["7"]!.inputs["positive"]).toEqual(["6", 0]); // the conditioning (references, prompt) is untouched
    expect(template["7"].inputs.latent_image).toEqual(["6", 2]); // the template is not mutated
  });

  it("refuses a size the profile does not offer, and a workflow that cannot take it", () => {
    expect(() => buildEditPrompt(profile, template, { ...base, size: "5:4" })).toThrow(expect.objectContaining({ code: "unknown_size" }));
    const bad = structuredClone(template);
    delete bad["7"].inputs.latent_image;
    expect(() => buildEditPrompt(profile, bad, { ...base, size: "1:1" })).toThrow(expect.objectContaining({ code: "workflow_mismatch" }));
    const taken = structuredClone(template);
    taken["edit_size_latent"] = { class_type: "Foo", inputs: {} };
    expect(() => buildEditPrompt(profile, taken, { ...base, size: "1:1" })).toThrow(expect.objectContaining({ code: "workflow_mismatch" }));
  });

  it("a profile without sizes refuses any size", () => {
    const none = profileWith((d) => { delete d.edit.sizes; delete d.edit.size_latent; });
    expect(none.edit!.sizes).toEqual([]);
    expect(() => buildEditPrompt(none, template, { ...base, size: "1:1" })).toThrow(expect.objectContaining({ code: "unknown_size" }));
  });
});

describe("parsing the edit sizes", () => {
  it.each<[string, (d: Doc) => void]>([
    ["sizes without size_latent", (d) => delete d.edit.size_latent],
    ["size_latent without sizes", (d) => delete d.edit.sizes],
    ["a width that is not a multiple of 32", (d) => (d.edit.sizes[0].width = 1000)],
    ["a duplicate name", (d) => (d.edit.sizes[1].name = "1:1")],
    ["an empty list", (d) => (d.edit.sizes = [])],
    ["a size_latent onto an input another param sets", (d) => (d.edit.size_latent = { node: "7", input: "seed" })],
    ["an unknown member of a size", (d) => (d.edit.sizes[0].dpi = 300)],
  ])("refuses %s", (_n, mutate) => {
    expect(() => profileWith(mutate)).toThrow(ProfileError);
  });
});

describe("edit() with a size", () => {
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
      generateMaxPromptChars: 40, generateMaxNegativePromptChars: 30, editMaxReferences: 3, editReferenceMaxBytes: 4096,
      editReferenceMaxPixels: 1_000_000, editReferenceMaxSide: 8192, editReferenceTypes: ["png", "jpeg", "webp"], secretNames: [],
    } as unknown as AppsConfig;
    const deps: EditDeps = { comfy: new ComfyClient("127.0.0.1", cfg), profile, template, cfg, newName: () => "n" };
    return { deps, seen, sent: () => JSON.parse(seen[seen.length - 1]!.body.toString()).prompt };
  }
  const req = (over: Record<string, unknown> = {}) => ({ prompt: "x", preset: "preview", resolution: "1024", seed: 1, images: [png(64, 64).toString("base64")], ...over });

  it("sends the empty latent of the chosen size; without a size nothing changes", async () => {
    const { deps, sent } = await fake();
    await edit(deps, req({ size: "9:16" }));
    expect(sent()["edit_size_latent"].inputs).toEqual({ width: 768, height: 1344, batch_size: 1 });
    await edit(deps, req());
    expect(sent()["edit_size_latent"]).toBeUndefined();
    await edit(deps, req({ size: null }));
    expect(sent()["edit_size_latent"]).toBeUndefined();
  });

  it("refuses a bad size before anything is uploaded", async () => {
    const { deps, seen } = await fake();
    for (const size of ["5:4", 5, "", "<b>", ["1:1"]]) await expect(edit(deps, req({ size })), JSON.stringify(size)).rejects.toMatchObject({ code: "unknown_size" });
    expect(seen).toHaveLength(0);
  });
});
