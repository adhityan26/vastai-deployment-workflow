import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { GenerateInputError, ProfileError, buildEditPrompt, buildPrompt, loadProfile } from "../src/profile.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const shipped = join(root, "instance/profiles/image.yaml");
const workflowPath = join(root, "instance/workflows/qwen-image-t2i.json");
const template = JSON.parse(readFileSync(workflowPath, "utf8")) as Record<string, { inputs: Record<string, unknown> }>;
const editTemplate = JSON.parse(readFileSync(join(root, "instance/workflows/qwen-image-edit.json"), "utf8")) as Record<
  string,
  { class_type?: string; inputs: Record<string, unknown> }
>;

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
    expect(doc["provides_node_classes"]).toEqual(["UnetLoaderGGUF", "TextEncodeQwenImage21", "QwenImage21Cache"]);
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

  it("reads models (file, size_bytes) and accepts a profile without models", () => {
    expect(loadProfile(shipped).models.map((m) => m.file)).toEqual([
      "qwen-image-2.1-UC-Q4_K_M.gguf",
      "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
      "vae/qwen_image_2.1_vae_bf16.safetensors",
    ]);
    expect(loadProfile(writeProfile((d) => delete d.models)).models).toEqual([]);
    // Fields the web does not need are not copied.
    expect(Object.keys(loadProfile(shipped).models[0]!)).toEqual(["file", "size_bytes"]);
  });

  const badModels: Record<string, (d: Doc) => void> = {
    not_a_list: (d) => (d.models = { file: "a" }),
    entry_not_mapping: (d) => (d.models = ["a.gguf"]),
    missing_file: (d) => delete d.models[0].file,
    empty_file: (d) => (d.models[0].file = ""),
    missing_size: (d) => delete d.models[0].size_bytes,
    zero_size: (d) => (d.models[0].size_bytes = 0),
    text_size: (d) => (d.models[0].size_bytes = "12"),
    fractional_size: (d) => (d.models[0].size_bytes = 1.5),
  };
  it.each(Object.keys(badModels))("rejects models %s", (name) => {
    expect(() => loadProfile(writeProfile(badModels[name]!))).toThrow(ProfileError);
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

describe("edit section", () => {
  it("loads the shipped edit section and maps every node/input in its workflow", () => {
    const edit = loadProfile(shipped).edit;
    expect(edit).not.toBeNull();
    expect(edit!.workflow).toBe("qwen-image-edit.json");
    for (const ref of Object.values(edit!.params)) expect(editTemplate[ref.node]?.inputs).toHaveProperty(ref.input);
    expect(editTemplate[edit!.references.encoderNode]?.class_type).toBe("TextEncodeQwenImage21");
    expect(edit!.references.nodeClass).toBe("LoadImage");
    expect(edit!.references.inputPrefix).toBe("images.image_");
    expect(edit!.resolutions).toEqual([{ name: "1024", value: 1024 }]);
  });

  it("treats a profile without an edit section as edit-disabled", () => {
    expect(loadProfile(writeProfile((d) => delete d.edit)).edit).toBeNull();
  });

  const bad: Record<string, (e: Doc) => void> = {
    not_a_mapping: (e) => Object.keys(e).forEach((k) => delete e[k]),
    missing_workflow: (e) => delete e.workflow,
    workflow_path: (e) => (e.workflow = "../x.json"),
    unknown_param: (e) => (e.params.cfg = { node: "7", input: "cfg" }),
    missing_param: (e) => delete e.params.resolution,
    missing_param_node: (e) => delete e.params.seed.node,
    missing_references: (e) => delete e.references,
    bad_node_class: (e) => (e.references.node_class = "Load Image;rm"),
    missing_image_input: (e) => delete e.references.image_input,
    missing_encoder: (e) => delete e.references.encoder,
    bad_prefix: (e) => (e.references.encoder.input_prefix = "images image_"),
    empty_resolutions: (e) => (e.resolutions = []),
    resolution_zero: (e) => (e.resolutions[0].value = 0),
    resolution_text: (e) => (e.resolutions[0].value = "1024"),
    duplicate_resolution: (e) => e.resolutions.push({ name: "1024", value: 2048 }),
  };
  it.each(Object.keys(bad))("rejects %s", (name) => {
    expect(() => loadProfile(writeProfile((doc) => bad[name]!(doc.edit)))).toThrow(ProfileError);
  });
});

describe("buildEditPrompt", () => {
  const profile = loadProfile(shipped);
  const input = { prompt: "make it real", preset: "high", resolution: "1024", seed: 9, imageNames: ["edit-aa.png", "edit-bb.jpg"] };

  it("adds one LoadImage per reference, wires images.image_k in order and sets only mapped inputs", () => {
    const out = buildEditPrompt(profile, editTemplate, input);
    const expected = structuredClone(editTemplate);
    expected["6"]!.inputs["prompt"] = "make it real";
    expected["6"]!.inputs["resolution"] = 1024;
    expected["7"]!.inputs["steps"] = 40;
    expected["7"]!.inputs["seed"] = 9;
    expected["ref_1"] = { class_type: "LoadImage", inputs: { image: "edit-aa.png" } };
    expected["ref_2"] = { class_type: "LoadImage", inputs: { image: "edit-bb.jpg" } };
    expected["6"]!.inputs["images.image_1"] = ["ref_1", 0];
    expected["6"]!.inputs["images.image_2"] = ["ref_2", 0];
    expect(out).toEqual(expected);
  });

  it("does not mutate the template", () => {
    const before = structuredClone(editTemplate);
    buildEditPrompt(profile, editTemplate, input);
    expect(editTemplate).toEqual(before);
  });

  const refused: Record<string, [Partial<typeof input>, string]> = {
    unknown_preset: [{ preset: "ultra" }, "unknown_preset"],
    unknown_resolution: [{ resolution: "4096" }, "unknown_resolution"],
    empty_prompt: [{ prompt: "  " }, "invalid_prompt"],
    negative_seed: [{ seed: -1 }, "invalid_seed"],
    no_references: [{ imageNames: [] }, "no_references"],
    unsafe_name: [{ imageNames: ["../x.png"] }, "invalid_reference_name"],
    name_with_slash: [{ imageNames: ["a/b.png"] }, "invalid_reference_name"],
  };
  it.each(Object.keys(refused))("refuses %s", (name) => {
    const [over, code] = refused[name]!;
    expect(() => buildEditPrompt(profile, editTemplate, { ...input, ...over })).toThrowError(
      expect.objectContaining({ name: "GenerateInputError", code }),
    );
  });

  it("refuses when the profile has no edit section", () => {
    const noEdit = loadProfile(writeProfile((d) => delete d.edit));
    expect(() => buildEditPrompt(noEdit, editTemplate, input)).toThrowError(expect.objectContaining({ code: "edit_unavailable" }));
  });

  it("refuses a workflow that lacks a mapped node or already has a ref_ node", () => {
    expect(() => buildEditPrompt(profile, {}, input)).toThrowError(expect.objectContaining({ code: "workflow_mismatch" }));
    const clash = { ...structuredClone(editTemplate), ref_1: { class_type: "LoadImage", inputs: { image: "x.png" } } };
    expect(() => buildEditPrompt(profile, clash, input)).toThrowError(expect.objectContaining({ code: "workflow_mismatch" }));
  });
});

describe("styles in the profile", () => {
  const LORA = "Qwen2.1_Anything2RealCharacters.safetensors";
  const loraModel = { file: LORA, repo: "org/loras", revision: "a".repeat(40), dest: "models/loras/", size_bytes: 123456 };
  const enable = (doc: Doc) => {
    doc.models.push(loraModel);
    doc.styles[0].enabled = true;
  };

  it("the shipped profile declares Anything to Real but keeps it off until its LoRA is pinned", () => {
    const doc = parse(readFileSync(shipped, "utf8")) as Doc;
    expect(doc.styles[0].id).toBe("anything2real");
    expect(doc.styles[0].enabled).toBe(false);
    expect(loadProfile(shipped).styles).toEqual([]);
    // no LoRA among the models: nothing for the agent to download
    expect(loadProfile(shipped).models.map((m) => m.file)).not.toContain(LORA);
  });

  it("turning the style on (model entry added, enabled true) offers it and counts its download", () => {
    const profile = loadProfile(writeProfile(enable));
    expect(profile.styles.map((s) => s.id)).toEqual(["anything2real"]);
    expect(profile.models.map((m) => m.file)).toContain(LORA);
  });

  it("enabling it without the model entry is refused at load", () => {
    expect(() => loadProfile(writeProfile((d) => (d.styles[0].enabled = true)))).toThrow(ProfileError);
  });

  it("the shipped lora placement fits both shipped workflows", () => {
    const profile = loadProfile(writeProfile(enable));
    const style = profile.styles[0]!;
    for (const [workflow, mode] of [[template, "generate"], [editTemplate, "edit"]] as const) {
      const copy = structuredClone(workflow) as Record<string, { inputs: Record<string, unknown> }>;
      expect(copy[style.lora.modelFrom]).toBeDefined();
      expect(copy[style.lora.modelTo.node]!.inputs[style.lora.modelTo.input]).toEqual([style.lora.modelFrom, 0]);
      void mode;
    }
  });

  it("buildEditPrompt inserts the LoRA loader into the edit workflow", () => {
    const profile = loadProfile(writeProfile(enable));
    const style = { style: profile.styles[0]!, values: { strength: 0.8 } };
    const out = buildEditPrompt(profile, editTemplate, { prompt: "x", preset: "preview", resolution: "1024", seed: 1, imageNames: ["a.png"], style });
    expect(out["style_lora"]).toEqual({ class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: LORA, strength_model: 0.8 } });
    expect(out["4"]!.inputs["model"]).toEqual(["style_lora", 0]);
    const plain = buildEditPrompt(profile, editTemplate, { prompt: "x", preset: "preview", resolution: "1024", seed: 1, imageNames: ["a.png"] });
    expect(plain["style_lora"]).toBeUndefined();
  });

  it("buildPrompt inserts it into the generate workflow too when a style is given", () => {
    const profile = loadProfile(writeProfile(enable));
    const style = { style: profile.styles[0]!, values: { strength: 0.6 } };
    const out = buildPrompt(profile, template, { prompt: "x", preset: "preview", size: "1:1", seed: 1, style });
    expect(out["style_lora"]!.inputs["strength_model"]).toBe(0.6);
    expect(out["4"]!.inputs["model"]).toEqual(["style_lora", 0]);
  });
});
