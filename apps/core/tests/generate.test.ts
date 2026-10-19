import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import type { AppsConfig } from "../src/config.js";
import { ComfyClient, Unreachable } from "../src/comfy.js";
import { GenerateInputError, type Profile } from "../src/profile.js";
import { parseStyles } from "../src/styles.js";
import { awaitResult, generate, GenerateFailed, GenerateTimeout, pollResult, type GenerateDeps } from "../src/generate.js";

const template = JSON.parse(readFileSync(new URL("../../../instance/workflows/qwen-image-t2i.json", import.meta.url), "utf8"));
const profile: Profile = {
  name: "t",
  edit: null,
  styles: [],
  guidance: null,
  recipes: [],
  upscale: null,
  models: [],
  generate: {
    workflow: "qwen-image-t2i.json",
    optional: { negativePrompt: null, cfg: null },
    params: {
      prompt: { node: "5", input: "text" },
      steps: { node: "8", input: "steps" },
      width: { node: "7", input: "width" },
      height: { node: "7", input: "height" },
      seed: { node: "8", input: "seed" },
    },
    qualityPresets: [{ name: "fast", steps: 8 }],
    sizes: [{ name: "square", width: 1024, height: 1024 }],
  },
};

interface Seen { method: string; url: string; body: string }
let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections?.();
  server?.close();
  server = undefined;
});

async function fake(handler: (s: Seen, res: ServerResponse) => void, extra: Partial<GenerateDeps> = {}) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", body: raw };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const cfg = {
    comfyPort: port, httpTimeoutSApps: 5, webJsonMaxBytes: 65536, webImageMaxBytes: 65536, webImageTimeoutS: 5, generateMaxPromptChars: 20, generateTimeoutS: 10, statusPollS: 2, secretNames: [],
  } as unknown as AppsConfig;
  let t = 0;
  const sleeps: number[] = [];
  const deps: GenerateDeps = {
    comfy: new ComfyClient("127.0.0.1", cfg), profile, template, cfg,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    now: () => t,
    ...extra,
  };
  return { deps, seen, sleeps };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const ok = { prompt: "a fox", preset: "fast", size: "square" };

describe("generate", () => {
  it("rejects invalid input with GenerateInputError and never submits", async () => {
    const { deps, seen } = await fake((_s, res) => json(res, 200, { prompt_id: "x" }));
    const bad: [Partial<typeof ok> & { seed?: number }, string][] = [
      [{ prompt: "x".repeat(21) }, "prompt_too_long"],
      [{ prompt: "   \n" }, "invalid_prompt"],
      [{ preset: "ultra" }, "unknown_preset"],
      [{ size: "huge" }, "unknown_size"],
      [{ seed: -1 }, "invalid_seed"],
      [{ seed: 1.5 }, "invalid_seed"],
      [{ seed: 2 ** 53 }, "invalid_seed"],
    ];
    for (const [patch, code] of bad) {
      await expect(generate(deps, { ...ok, ...patch })).rejects.toMatchObject({ name: "GenerateInputError", code });
      await expect(generate(deps, { ...ok, ...patch })).rejects.toBeInstanceOf(GenerateInputError);
    }
    expect(seen).toHaveLength(0);
  });

  it("uses a random seed when none is given and the given seed otherwise", async () => {
    const { deps, seen } = await fake((_s, res) => json(res, 200, { prompt_id: "p1" }), { random: () => 0.5 });
    expect(await generate(deps, ok)).toEqual({ promptId: "p1" });
    const sent = JSON.parse(seen[0]!.body).prompt;
    expect(sent["8"].inputs.seed).toBe(Math.floor(0.5 * 2 ** 53));
    expect(sent["8"].inputs.steps).toBe(8);
    expect(sent["5"].inputs.text).toBe("a fox");
    await generate(deps, { ...ok, seed: 7 });
    expect(JSON.parse(seen[1]!.body).prompt["8"].inputs.seed).toBe(7);
    await generate({ ...deps, random: () => 0.9999999999999999 }, ok);
    expect(Number.isSafeInteger(JSON.parse(seen[2]!.body).prompt["8"].inputs.seed)).toBe(true);
  });

  it("applies a style to the generate workflow, and refuses a style that is unknown or edit-only", async () => {
    const styles = parseStyles(
      [
        { id: "both", title: "Both", modes: ["generate", "edit"], enabled: true, lora: { file: "both.safetensors", model_from: "1", model_to: { node: "4", input: "model" } }, params: [{ id: "strength", title: "S", type: "float", min: 0, max: 1, step: 0.1, default: 0.5, target: "lora_strength" }] },
        { id: "editonly", title: "Edit only", modes: ["edit"], enabled: true, lora: { file: "e.safetensors", model_from: "1", model_to: { node: "4", input: "model" } } },
      ],
      ["both.safetensors", "e.safetensors"],
    );
    const { deps, seen } = await fake((_s, res) => json(res, 200, { prompt_id: "p1" }), { profile: { ...profile, styles } });
    await generate(deps, { ...ok, style: { id: "both", params: { strength: 0.3 } } });
    const sent = JSON.parse(seen[0]!.body).prompt;
    expect(sent["style_lora"].inputs).toEqual({ model: ["1", 0], lora_name: "both.safetensors", strength_model: 0.3 });
    expect(sent["4"].inputs.model).toEqual(["style_lora", 0]);
    await expect(generate(deps, { ...ok, style: { id: "editonly" } })).rejects.toMatchObject({ code: "style_not_for_mode" });
    await expect(generate(deps, { ...ok, style: { id: "nope" } })).rejects.toMatchObject({ code: "unknown_style" });
    expect(seen).toHaveLength(1);
  });

  it("propagates Unreachable unchanged", async () => {
    const { deps } = await fake((_s, res) => json(res, 200, {}));
    server!.closeAllConnections?.();
    await new Promise<void>((r) => server!.close(() => r()));
    await expect(generate(deps, ok)).rejects.toBeInstanceOf(Unreachable);
    await expect(awaitResult(deps, "p1")).rejects.toBeInstanceOf(Unreachable);
  });
});

describe("awaitResult", () => {
  it("polls until done and returns only SaveImage outputs", async () => {
    let calls = 0;
    const { deps, sleeps } = await fake((_s, res) => {
      calls++;
      if (calls < 3) return json(res, 200, {});
      json(res, 200, {
        p1: {
          outputs: {
            "10": { images: [{ filename: "a.png", subfolder: "", type: "output" }, { filename: "bad.png", subfolder: "", type: "weird" }] },
            "9": { images: [{ filename: "preview.png", subfolder: "", type: "temp" }] },
          },
          status: { completed: true, status_str: "success" },
        },
      });
    });
    expect(await awaitResult(deps, "p1")).toEqual({ images: [{ filename: "a.png", subfolder: "", type: "output" }] });
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("times out with GenerateTimeout", async () => {
    const { deps } = await fake((_s, res) => json(res, 200, {}));
    await expect(awaitResult(deps, "p1")).rejects.toBeInstanceOf(GenerateTimeout);
  });

  it("maps a ComfyUI error to GenerateFailed with the node message only", async () => {
    const { deps } = await fake((_s, res) =>
      json(res, 200, {
        p1: {
          outputs: {},
          prompt: ["secret-workflow-dump"],
          status: {
            completed: false,
            status_str: "error",
            messages: [["execution_start", {}], ["execution_error", { node_type: "KSampler", exception_message: "CUDA out of memory" }]],
          },
        },
      }),
    );
    const err = await awaitResult(deps, "p1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GenerateFailed);
    expect((err as Error).message).toBe("KSampler: CUDA out of memory");
    expect((err as Error).message).not.toContain("secret-workflow-dump");
  });

  it("fails with 'no images' when finished without images", async () => {
    const { deps } = await fake((_s, res) => json(res, 200, { p1: { outputs: {}, status: { completed: true } } }));
    await expect(awaitResult(deps, "p1")).rejects.toThrow(new GenerateFailed("no images"));
  });
});

describe("pollResult", () => {
  it("reads history exactly once and never sleeps: null while pending, images when done", async () => {
    let done = false;
    const { deps, seen, sleeps } = await fake((_s, res) =>
      done
        ? json(res, 200, {
            p1: {
              outputs: { "10": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } },
              status: { completed: true, status_str: "success" },
            },
          })
        : json(res, 200, {}),
    );
    expect(await pollResult(deps, "p1")).toBeNull();
    expect(seen).toHaveLength(1);
    done = true;
    expect(await pollResult(deps, "p1")).toEqual({ images: [{ filename: "a.png", subfolder: "", type: "output" }] });
    expect(seen).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });

  it("returns null for a running entry and throws GenerateFailed on error", async () => {
    let entry: unknown = { p1: { outputs: {}, status: { completed: false, status_str: "running" } } };
    const { deps } = await fake((_s, res) => json(res, 200, entry));
    expect(await pollResult(deps, "p1")).toBeNull();
    entry = { p1: { outputs: {}, status: { status_str: "error", messages: [] } } };
    await expect(pollResult(deps, "p1")).rejects.toThrow(new GenerateFailed("generation failed"));
  });
});
