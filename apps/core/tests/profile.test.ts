import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { GenerateInputError, ProfileError, buildPrompt, loadProfile } from "../src/profile.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const shipped = join(root, "instance/profiles/image.yaml");
const workflowPath = join(root, "instance/workflows/qwen-image-t2i.json");
const template = JSON.parse(readFileSync(workflowPath, "utf8")) as Record<string, { inputs: Record<string, unknown> }>;

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function writeProfile(mutate: (doc: Doc) => void): string {
  const doc = parse(readFileSync(shipped, "utf8")) as Doc;
  mutate(doc);
  const path = join(mkdtempSync(join(tmpdir(), "prof-")), "p.yaml");
  writeFileSync(path, stringify(doc));
  return path;
}

describe("loadProfile", () => {
  it("loads the shipped profile and maps every node/input in the workflow", () => {
    const profile = loadProfile(shipped);
    expect(profile.name).toBe("image");
    for (const ref of Object.values(profile.generate.params)) {
      expect(template[ref.node]?.inputs).toHaveProperty(ref.input);
    }
    expect(profile.generate.workflow).toBe("qwen-image-t2i.json");
  });

  it("still loads the shipped profile with instance-only fields such as provides_node_classes", () => {
    const doc = parse(readFileSync(shipped, "utf8")) as Doc;
    expect(doc["provides_node_classes"]).toEqual(["UnetLoaderGGUF"]);
    expect(loadProfile(shipped).generate.sizes.length).toBeGreaterThan(0);
    const extra = writeProfile((d) => (d.provides_node_classes = ["UnetLoaderGGUF", "OtherNode"]));
    expect(loadProfile(extra).name).toBe("image");
  });

  // Mirrors BAD_GENERATE in instance/agent/tests/test_profile.py: both loaders reject the same inputs.
  const bad: Record<string, (g: Doc) => void> = {
    unknown_param: (g) => (g.params.cfg = { node: "8", input: "cfg" }),
    missing_param: (g) => delete g.params.seed,
    missing_node: (g) => delete g.params.prompt.node,
    missing_input: (g) => delete g.params.prompt.input,
    preset_without_steps: (g) => (g.quality_presets.bad = {}),
    preset_zero_steps: (g) => (g.quality_presets.bad = { steps: 0 }),
    empty_presets: (g) => (g.quality_presets = {}),
    empty_sizes: (g) => (g.sizes = []),
    width_not_32: (g) => g.sizes.push({ name: "x", width: 1000, height: 1024 }),
    height_not_32: (g) => g.sizes.push({ name: "x", width: 1024, height: 1000 }),
    duplicate_size: (g) => g.sizes.push({ name: "1:1", width: 512, height: 512 }),
    workflow_path: (g) => (g.workflow = "../x.json"),
    workflow_no_json: (g) => (g.workflow = "flow.txt"),
  };
  it.each(Object.keys(bad))("rejects %s", (name) => {
    const path = writeProfile((doc) => bad[name]!(doc.generate));
    expect(() => loadProfile(path)).toThrow(ProfileError);
  });

  it("ignores the rest of the profile", () => {
    const path = writeProfile((doc) => (doc.nodes = "anything"));
    expect(loadProfile(path).name).toBe("image");
  });
});

describe("buildPrompt", () => {
  const profile = loadProfile(shipped);
  const input = { prompt: "a cat", preset: "high", size: "3:4", seed: 7 };

  it("changes only mapped inputs", () => {
    const before = structuredClone(template);
    const out = buildPrompt(profile, template, input);
    const expected = structuredClone(before);
    expected["5"]!.inputs["text"] = "a cat";
    expected["8"]!.inputs["steps"] = 40;
    expected["8"]!.inputs["seed"] = 7;
    expected["7"]!.inputs["width"] = 896;
    expected["7"]!.inputs["height"] = 1152;
    expect(out).toEqual(expected);
  });

  it("does not mutate the template", () => {
    const before = structuredClone(template);
    buildPrompt(profile, template, input);
    expect(template).toEqual(before);
  });

  it("rejects unknown preset", () => {
    expect(() => buildPrompt(profile, template, { ...input, preset: "ultra" })).toThrowError(
      expect.objectContaining({ name: "GenerateInputError", code: "unknown_preset" }),
    );
  });

  it("rejects size not in profile", () => {
    const run = () => buildPrompt(profile, template, { ...input, size: "5000:5000" });
    expect(run).toThrow(GenerateInputError);
    expect(run).toThrowError(expect.objectContaining({ code: "unknown_size" }));
  });

  it("rejects a workflow that lacks a mapped node", () => {
    expect(() => buildPrompt(profile, {}, input)).toThrowError(expect.objectContaining({ code: "workflow_mismatch" }));
  });
});
