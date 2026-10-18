import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppsConfig } from "../src/config.js";
import { ComfyClient, ComfyError, Unreachable } from "../src/comfy.js";
import { edit, type EditDeps } from "../src/generate.js";
import { loadProfile } from "../src/profile.js";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const profile = loadProfile(repo("instance/profiles/image.yaml"));
const template = JSON.parse(readFileSync(repo("instance/workflows/qwen-image-edit.json"), "utf8"));

function png(width: number, height: number, marker = ""): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from(marker)]);
}
function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(11, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), sof, scan]);
}
const b64 = (b: Buffer) => b.toString("base64");

interface Seen { method: string; url: string; body: Buffer }
let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections?.();
  server?.close();
  server = undefined;
});

async function fake(handler: (s: Seen, res: ServerResponse) => void, over: Record<string, unknown> = {}) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks) };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const cfg = {
    comfyPort: port, httpTimeoutSApps: 5, webJsonMaxBytes: 65536, webImageMaxBytes: 65536, webImageTimeoutS: 5,
    generateMaxPromptChars: 40, generateTimeoutS: 10, statusPollS: 2,
    editMaxReferences: 3, editReferenceMaxBytes: 4096, editReferenceMaxPixels: 1_000_000, editReferenceMaxSide: 8192, editReferenceTypes: ["png", "jpeg", "webp"],
    secretNames: [], ...over,
  } as unknown as AppsConfig;
  let n = 0;
  const deps: EditDeps = { comfy: new ComfyClient("127.0.0.1", cfg), profile, template, cfg, newName: () => `n${n++}` };
  return { deps, seen };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** A ComfyUI that stores uploads under the name it was sent and accepts prompts. */
function comfy(): (s: Seen, res: ServerResponse) => void {
  return (s, res) => {
    if (s.url === "/upload/image") {
      const name = /filename="([^"]+)"/.exec(s.body.toString("latin1"))![1]!;
      return json(res, 200, { name, subfolder: "", type: "input" });
    }
    if (s.url === "/prompt") return json(res, 200, { prompt_id: "p-edit" });
    json(res, 404, {});
  };
}

const request = (over: Record<string, unknown> = {}) => ({
  prompt: "make it real",
  preset: "preview",
  resolution: "1024",
  seed: 5,
  images: [b64(png(64, 64, "ONE")), b64(jpeg(32, 32))],
  ...over,
});

describe("edit", () => {
  it("uploads every reference in order under server-chosen names, then submits the filled workflow", async () => {
    const { deps, seen } = await fake(comfy());
    expect(await edit(deps, request())).toEqual({ promptId: "p-edit" });

    expect(seen.map((s) => s.url)).toEqual(["/upload/image", "/upload/image", "/prompt"]);
    expect(seen[0]!.body.toString("latin1")).toContain('filename="edit-n0.png"');
    expect(seen[0]!.body.toString("latin1")).toContain("Content-Type: image/png");
    expect(seen[0]!.body.includes(Buffer.from("ONE"))).toBe(true);
    expect(seen[1]!.body.toString("latin1")).toContain('filename="edit-n1.jpg"');
    expect(seen[1]!.body.toString("latin1")).toContain("Content-Type: image/jpeg");

    const prompt = JSON.parse(seen[2]!.body.toString("utf8")).prompt;
    expect(prompt["ref_1"]).toEqual({ class_type: "LoadImage", inputs: { image: "edit-n0.png" } });
    expect(prompt["ref_2"]).toEqual({ class_type: "LoadImage", inputs: { image: "edit-n1.jpg" } });
    expect(prompt["6"].inputs["images.image_1"]).toEqual(["ref_1", 0]);
    expect(prompt["6"].inputs["images.image_2"]).toEqual(["ref_2", 0]);
    expect(prompt["6"].inputs["prompt"]).toBe("make it real");
    expect(prompt["6"].inputs["resolution"]).toBe(1024);
    expect(prompt["7"].inputs["steps"]).toBe(10);
    expect(prompt["7"].inputs["seed"]).toBe(5);
  });

  it("uses the names ComfyUI reports when it renamed a file", async () => {
    const { deps, seen } = await fake((s, res) => {
      if (s.url === "/upload/image") return json(res, 200, { name: "renamed-1.png", subfolder: "", type: "input" });
      return comfy()(s, res);
    });
    await edit(deps, request({ images: [b64(png(8, 8))] }));
    const prompt = JSON.parse(seen[seen.length - 1]!.body.toString("utf8")).prompt;
    expect(prompt["ref_1"].inputs.image).toBe("renamed-1.png");
  });

  it("picks a random seed in range when none is given", async () => {
    const { deps, seen } = await fake(comfy());
    await edit({ ...deps, random: () => 0.5 }, request({ seed: undefined }));
    const prompt = JSON.parse(seen[seen.length - 1]!.body.toString("utf8")).prompt;
    expect(prompt["7"].inputs.seed).toBe(Math.floor(0.5 * (Number.MAX_SAFE_INTEGER + 1)));
  });

  const refused: Record<string, [Record<string, unknown>, string]> = {
    empty_prompt: [{ prompt: "  " }, "invalid_prompt"],
    long_prompt: [{ prompt: "x".repeat(41) }, "prompt_too_long"],
    bad_preset: [{ preset: "ultra" }, "unknown_preset"],
    bad_resolution: [{ resolution: "9999" }, "unknown_resolution"],
    bad_seed: [{ seed: -3 }, "invalid_seed"],
    no_images: [{ images: [] }, "no_references"],
    too_many: [{ images: [1, 2, 3, 4].map(() => b64(png(4, 4))) }, "too_many_references"],
    not_base64: [{ images: ["***"] }, "invalid_reference"],
    not_an_image: [{ images: [b64(Buffer.from("plain text"))] }, "invalid_reference"],
    too_big: [{ images: [b64(png(4, 4, "x".repeat(5000)))] }, "reference_too_large"],
    too_many_pixels: [{ images: [b64(png(4000, 4000))] }, "reference_too_many_pixels"],
    second_bad: [{ images: [b64(png(4, 4)), "***"] }, "invalid_reference"],
  };
  it.each(Object.keys(refused))("refuses %s before anything is sent to the instance", async (name) => {
    const { deps, seen } = await fake(comfy());
    const [over, code] = refused[name]!;
    await expect(edit(deps, request(over))).rejects.toMatchObject({ name: "GenerateInputError", code });
    expect(seen).toHaveLength(0);
  });

  it("refuses when the profile has no edit section", async () => {
    const { deps, seen } = await fake(comfy());
    const noEdit = { ...profile, edit: null };
    await expect(edit({ ...deps, profile: noEdit }, request())).rejects.toMatchObject({ code: "edit_unavailable" });
    expect(seen).toHaveLength(0);
  });

  it("stops at the first failed upload and does not submit", async () => {
    let uploads = 0;
    const { deps, seen } = await fake((s, res) => {
      if (s.url === "/upload/image" && ++uploads === 2) return json(res, 500, { error: "disk full" });
      return comfy()(s, res);
    });
    await expect(edit(deps, request())).rejects.toBeInstanceOf(ComfyError);
    expect(seen.map((s) => s.url)).toEqual(["/upload/image", "/upload/image"]);
  });

  it("an unreachable instance surfaces as Unreachable", async () => {
    const { deps } = await fake(comfy());
    server?.closeAllConnections?.();
    server?.close();
    await expect(edit(deps, request())).rejects.toBeInstanceOf(Unreachable);
  });

  it("never lets the browser influence the uploaded file names", async () => {
    const { deps, seen } = await fake(comfy());
    await edit(deps, request({ images: [b64(png(4, 4))], name: "../../evil.png", filename: "x" } as Record<string, unknown>));
    expect(seen[0]!.body.toString("latin1")).toContain('filename="edit-n0.png"');
    expect(seen[0]!.body.toString("latin1")).not.toContain("evil");
  });
});

describe("edit with a style", () => {
  const LORA = "Qwen2.1_Anything2RealCharacters.safetensors";
  async function styled() {
    const { parse, stringify } = await import("yaml");
    const doc = parse(readFileSync(repo("instance/profiles/image.yaml"), "utf8"));
    doc.models.push({ file: LORA, repo: "org/loras", revision: "a".repeat(40), dest: "models/loras/", size_bytes: 1000 });
    doc.styles[0].enabled = true;
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "styled-")), "p.yaml");
    writeFileSync(path, stringify(doc));
    return loadProfile(path);
  }

  it("adds the LoRA loader to the submitted workflow with the asked strength", async () => {
    const { deps, seen } = await fake(comfy());
    const out = await edit({ ...deps, profile: await styled() }, request({ style: { id: "anything2real", params: { strength: 0.85 } } }));
    expect(out.promptId).toBe("p-edit");
    const prompt = JSON.parse(seen[seen.length - 1]!.body.toString("utf8")).prompt;
    expect(prompt["style_lora"].inputs).toEqual({ model: ["1", 0], lora_name: LORA, strength_model: 0.85 });
    expect(prompt["4"].inputs.model).toEqual(["style_lora", 0]);
  });

  it("uses the default strength when none is sent", async () => {
    const { deps, seen } = await fake(comfy());
    await edit({ ...deps, profile: await styled() }, request({ style: { id: "anything2real" } }));
    expect(JSON.parse(seen[seen.length - 1]!.body.toString("utf8")).prompt["style_lora"].inputs.strength_model).toBe(0.7);
  });

  const refused: Record<string, [unknown, string]> = {
    unknown: [{ id: "nope" }, "unknown_style"],
    bad_param: [{ id: "anything2real", params: { strength: 5 } }, "invalid_style_param"],
    stray_param: [{ id: "anything2real", params: { node: "4" } }, "unknown_style_param"],
    not_object: ["anything2real", "invalid_style"],
  };
  it.each(Object.keys(refused))("refuses a bad style (%s) before anything is uploaded", async (name) => {
    const { deps, seen } = await fake(comfy());
    const [style, code] = refused[name]!;
    await expect(edit({ ...deps, profile: await styled() }, request({ style }))).rejects.toMatchObject({ name: "GenerateInputError", code });
    expect(seen).toHaveLength(0);
  });

  it("a profile with the style off refuses it as unknown", async () => {
    const { deps, seen } = await fake(comfy());
    await expect(edit({ ...deps, profile: { ...deps.profile, styles: [] } }, request({ style: { id: "anything2real" } }))).rejects.toMatchObject({ code: "unknown_style" });
    expect(seen).toHaveLength(0);
  });

  it("without a style the workflow has no LoRA loader", async () => {
    const { deps, seen } = await fake(comfy());
    await edit({ ...deps, profile: await styled() }, request());
    expect(JSON.parse(seen[seen.length - 1]!.body.toString("utf8")).prompt["style_lora"]).toBeUndefined();
  });
});
