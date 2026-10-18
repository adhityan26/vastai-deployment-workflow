import { describe, expect, it } from "vitest";
import { GenerateInputError, ProfileError } from "../src/profile-errors.js";
import { applyStyle, parseStyles, resolveStyle, type StyleSpec } from "../src/styles.js";

type Doc = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const LORA = "Qwen2.1_Anything2RealCharacters.safetensors";

/** A valid raw `styles:` list (what yaml.parse gives); each test edits a copy. */
function raw(): Doc[] {
  return [
    {
      id: "anything2real",
      title: "Anything to Real",
      modes: ["edit"],
      enabled: true,
      lora: { file: LORA, model_from: "1", model_to: { node: "4", input: "model" } },
      params: [
        { id: "strength", title: "LoRA strength", type: "float", min: 0.4, max: 1.0, step: 0.05, default: 0.7, target: "lora_strength" },
      ],
    },
  ];
}
type Entry = { file: string; dest: string };
const lora = (file: string): Entry => ({ file, dest: "models/loras/" });
const models: Entry[] = [lora(LORA), { file: "other.gguf", dest: "models/diffusion_models/" }];
const parse = (mutate?: (list: Doc[]) => void, files: readonly Entry[] = models) => {
  const list = raw();
  mutate?.(list);
  return parseStyles(list, files);
};

describe("parseStyles", () => {
  it("returns the enabled styles with their parts", () => {
    const [style] = parse();
    expect(style).toMatchObject({
      id: "anything2real",
      title: "Anything to Real",
      modes: ["edit"],
      lora: { file: LORA, modelFrom: "1", modelTo: { node: "4", input: "model" } },
    });
    expect(style!.params[0]).toMatchObject({ id: "strength", type: "float", min: 0.4, max: 1, step: 0.05, default: 0.7, target: { kind: "lora_strength" } });
  });

  it("accepts a missing section as 'no styles'", () => {
    expect(parseStyles(undefined, models)).toEqual([]);
    expect(parseStyles(null, models)).toEqual([]);
  });

  it("validates a disabled style but does not offer it, and does not require its file in models", () => {
    expect(parse((l) => (l[0].enabled = false), [])).toEqual([]);
    expect(() => parse((l) => { l[0].enabled = false; l[0].id = "Bad Id"; })).toThrow(ProfileError);
  });

  it("an enabled style needs its LoRA file among the models (compared by file name)", () => {
    expect(() => parse(undefined, [{ file: "other.gguf", dest: "models/diffusion_models/" }])).toThrow(/anything2real.*models/);
    expect(parse(undefined, [lora(`loras/${LORA}`)])).toHaveLength(1);
  });

  it("an enabled style needs that models entry to download into models/loras/", () => {
    expect(() => parse(undefined, [{ file: LORA, dest: "models/upscale_models/" }])).toThrow(/models\/loras/);
    expect(() => parse(undefined, [{ file: LORA }] as Entry[])).toThrow(/models\/loras/);
    expect(parse(undefined, [{ file: LORA, dest: "models/loras" }])).toHaveLength(1);
    expect(parse((l) => (l[0].enabled = false), [{ file: LORA, dest: "models/vae/" }])).toEqual([]); // only checked when enabled
  });

  it("supports all four param types and workflow-input targets", () => {
    const [style] = parse((l) => {
      l[0].params = [
        { id: "strength", title: "S", type: "float", min: 0, max: 2, step: 0.5, default: 1, target: "lora_strength" },
        { id: "angle", title: "Angle", type: "int", min: 0, max: 360, step: 15, default: 90, target: { node: "7", input: "denoise_steps" } },
        { id: "mode", title: "Mode", type: "choice", choices: ["a", "b"], default: "b", target: { node: "7", input: "sampler_name" } },
        { id: "sharp", title: "Sharp", type: "bool", default: false, target: { node: "7", input: "flag" } },
      ];
    });
    expect(style!.params.map((p) => p.type)).toEqual(["float", "int", "choice", "bool"]);
    expect(style!.params[1]!.target).toEqual({ kind: "input", node: "7", input: "denoise_steps" });
  });

  const bad: Record<string, (l: Doc[]) => void> = {
    not_a_list: (l) => { l.length = 0; l.push("nope" as never); },
    no_id: (l) => delete l[0].id,
    bad_id: (l) => (l[0].id = "Any Thing"),
    long_id: (l) => (l[0].id = "a".repeat(40)),
    duplicate_id: (l) => l.push(structuredClone(l[0])),
    no_title: (l) => (l[0].title = ""),
    long_title: (l) => (l[0].title = "t".repeat(70)),
    no_modes: (l) => (l[0].modes = []),
    unknown_mode: (l) => (l[0].modes = ["upscale"]),
    duplicate_mode: (l) => (l[0].modes = ["edit", "edit"]),
    enabled_not_bool: (l) => (l[0].enabled = "yes"),
    no_lora: (l) => delete l[0].lora,
    lora_path: (l) => (l[0].lora.file = "../x.safetensors"),
    lora_subdir: (l) => (l[0].lora.file = "a/b.safetensors"),
    no_model_from: (l) => delete l[0].lora.model_from,
    no_model_to: (l) => delete l[0].lora.model_to,
    model_to_incomplete: (l) => delete l[0].lora.model_to.input,
    unknown_style_key: (l) => (l[0].extra = 1),
    unknown_lora_key: (l) => (l[0].lora.extra = 1),
    param_unknown_type: (l) => (l[0].params[0].type = "string"),
    param_bad_id: (l) => (l[0].params[0].id = "Strength!"),
    param_duplicate: (l) => l[0].params.push(structuredClone(l[0].params[0])),
    param_unknown_key: (l) => (l[0].params[0].extra = 1),
    param_no_target: (l) => delete l[0].params[0].target,
    param_bad_target: (l) => (l[0].params[0].target = "somewhere"),
    param_target_incomplete: (l) => (l[0].params[0].target = { node: "7" }),
    float_no_min: (l) => delete l[0].params[0].min,
    float_min_ge_max: (l) => (l[0].params[0].min = 2),
    float_zero_step: (l) => (l[0].params[0].step = 0),
    float_default_out_of_range: (l) => (l[0].params[0].default = 5),
    float_default_text: (l) => (l[0].params[0].default = "0.7"),
    int_fractional_step: (l) => (l[0].params[0] = { id: "n", title: "N", type: "int", min: 0, max: 10, step: 0.5, default: 1, target: { node: "7", input: "n" } }),
    choice_empty: (l) => (l[0].params[0] = { id: "c", title: "C", type: "choice", choices: [], default: "a", target: { node: "7", input: "c" } }),
    choice_default_missing: (l) => (l[0].params[0] = { id: "c", title: "C", type: "choice", choices: ["a"], default: "z", target: { node: "7", input: "c" } }),
    choice_duplicate: (l) => (l[0].params[0] = { id: "c", title: "C", type: "choice", choices: ["a", "a"], default: "a", target: { node: "7", input: "c" } }),
    bool_default_text: (l) => (l[0].params[0] = { id: "b", title: "B", type: "bool", default: "no", target: { node: "7", input: "b" } }),
    lora_strength_on_int: (l) => (l[0].params[0] = { id: "n", title: "N", type: "int", min: 0, max: 5, step: 1, default: 1, target: "lora_strength" }),
    two_lora_strengths: (l) => l[0].params.push({ ...structuredClone(l[0].params[0]), id: "strength2" }),
  };
  it.each(Object.keys(bad))("rejects %s", (name) => {
    expect(() => parse(bad[name])).toThrow(ProfileError);
  });
});

describe("resolveStyle", () => {
  const styles = parse() as StyleSpec[];
  const resolve = (mode: "generate" | "edit", raw: unknown) => resolveStyle(styles, mode, raw);

  it("is null when no style is asked for", () => {
    expect(resolve("edit", undefined)).toBeNull();
    expect(resolve("edit", null)).toBeNull();
  });

  it("takes the default of a param that is not sent, and the value of one that is", () => {
    expect(resolve("edit", { id: "anything2real" })!.values).toEqual({ strength: 0.7 });
    expect(resolve("edit", { id: "anything2real", params: {} })!.values).toEqual({ strength: 0.7 });
    expect(resolve("edit", { id: "anything2real", params: { strength: 0.85 } })!.values).toEqual({ strength: 0.85 });
    expect(resolve("edit", { id: "anything2real", params: { strength: 0.4 } })!.values).toEqual({ strength: 0.4 });
    expect(resolve("edit", { id: "anything2real", params: { strength: 1 } })!.values).toEqual({ strength: 1 });
  });

  const refused: Record<string, [string, unknown, string]> = {
    not_an_object: ["edit", "anything2real", "invalid_style"],
    array: ["edit", [], "invalid_style"],
    id_not_text: ["edit", { id: 5 }, "invalid_style"],
    unknown_style: ["edit", { id: "nope" }, "unknown_style"],
    wrong_mode: ["generate", { id: "anything2real" }, "style_not_for_mode"],
    params_not_object: ["edit", { id: "anything2real", params: [] }, "invalid_style"],
    unknown_param: ["edit", { id: "anything2real", params: { evil: 1 } }, "unknown_style_param"],
    extra_key: ["edit", { id: "anything2real", node: "4" }, "invalid_style"],
    below_min: ["edit", { id: "anything2real", params: { strength: 0.39 } }, "invalid_style_param"],
    above_max: ["edit", { id: "anything2real", params: { strength: 1.01 } }, "invalid_style_param"],
    off_step: ["edit", { id: "anything2real", params: { strength: 0.72 } }, "invalid_style_param"],
    text_value: ["edit", { id: "anything2real", params: { strength: "0.7" } }, "invalid_style_param"],
    nan_value: ["edit", { id: "anything2real", params: { strength: Number.NaN } }, "invalid_style_param"],
    infinity: ["edit", { id: "anything2real", params: { strength: Infinity } }, "invalid_style_param"],
  };
  it.each(Object.keys(refused))("refuses %s", (name) => {
    const [mode, body, code] = refused[name]!;
    expect(() => resolve(mode as "edit", body)).toThrowError(expect.objectContaining({ name: "GenerateInputError", code }));
  });

  it("the message names the param, not the sent value", () => {
    try {
      resolve("edit", { id: "anything2real", params: { strength: 9.87654 } });
      expect.unreachable();
    } catch (e) {
      expect((e as GenerateInputError).message).toContain("strength");
      expect((e as GenerateInputError).message).not.toContain("9.87654");
    }
  });

  it("checks ints, choices and bools against their rules", () => {
    const rich = parse((l) => {
      l[0].modes = ["generate", "edit"];
      l[0].params = [
        { id: "angle", title: "A", type: "int", min: 0, max: 360, step: 15, default: 90, target: { node: "7", input: "a" } },
        { id: "mode", title: "M", type: "choice", choices: ["a", "b"], default: "a", target: { node: "7", input: "m" } },
        { id: "sharp", title: "S", type: "bool", default: false, target: { node: "7", input: "s" } },
      ];
    }) as StyleSpec[];
    const r = (params: unknown) => resolveStyle(rich, "generate", { id: "anything2real", params });
    expect(r({ angle: 45, mode: "b", sharp: true })!.values).toEqual({ angle: 45, mode: "b", sharp: true });
    for (const params of [{ angle: 1.5 }, { angle: 50 }, { angle: 375 }, { mode: "c" }, { mode: 1 }, { sharp: "true" }, { sharp: 1 }]) {
      expect(() => r(params), JSON.stringify(params)).toThrowError(expect.objectContaining({ name: "GenerateInputError" }));
    }
  });
});

describe("applyStyle", () => {
  const styles = parse() as StyleSpec[];
  const base = () => ({
    "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "m.gguf" } },
    "4": { class_type: "QwenImage21Cache", inputs: { model: ["1", 0], device: "auto" } },
    "7": { class_type: "KSampler", inputs: { model: ["4", 0], sampler_name: "euler", flag: false } },
  });
  const apply = (prompt: Record<string, any>, values: Record<string, number | string | boolean>, list = styles) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    applyStyle(prompt, { style: list[0]!, values });
    return prompt;
  };

  it("inserts the LoRA loader between the two nodes and sets its strength", () => {
    const out = apply(base(), { strength: 0.8 });
    expect(out["style_lora"]).toEqual({ class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: LORA, strength_model: 0.8 } });
    expect(out["4"].inputs.model).toEqual(["style_lora", 0]);
    expect(out["1"]).toEqual(base()["1"]);
    expect(out["7"]).toEqual(base()["7"]);
  });

  it("sets input-targeted params on their node", () => {
    const list = parse((l) => {
      l[0].params = [
        { id: "strength", title: "S", type: "float", min: 0, max: 2, step: 0.1, default: 1, target: "lora_strength" },
        { id: "mode", title: "M", type: "choice", choices: ["euler", "heun"], default: "euler", target: { node: "7", input: "sampler_name" } },
      ];
    }) as StyleSpec[];
    const out = apply(base(), { strength: 1, mode: "heun" }, list);
    expect(out["7"].inputs.sampler_name).toBe("heun");
  });

  it("uses strength 1 when the style has no strength param", () => {
    const list = parse((l) => (l[0].params = [])) as StyleSpec[];
    expect(apply(base(), {}, list)["style_lora"].inputs.strength_model).toBe(1);
  });

  const mismatched: Record<string, (p: Record<string, any>) => void> = { // eslint-disable-line @typescript-eslint/no-explicit-any
    no_source_node: (p) => delete p["1"],
    no_consumer_node: (p) => delete p["4"],
    consumer_has_no_input: (p) => delete p["4"].inputs.model,
    consumer_not_fed_by_source: (p) => (p["4"].inputs.model = ["7", 0]),
    consumer_input_not_a_link: (p) => (p["4"].inputs.model = "text"),
    node_id_taken: (p) => (p["style_lora"] = { class_type: "X", inputs: {} }),
  };
  it.each(Object.keys(mismatched))("refuses a workflow with %s", (name) => {
    const prompt = base() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    mismatched[name]!(prompt);
    expect(() => apply(prompt, { strength: 0.7 })).toThrowError(expect.objectContaining({ name: "GenerateInputError", code: "workflow_mismatch" }));
  });

  it("refuses an input-targeted param whose node or input is missing", () => {
    const list = parse((l) => {
      l[0].params = [{ id: "mode", title: "M", type: "choice", choices: ["a"], default: "a", target: { node: "9", input: "x" } }];
    }) as StyleSpec[];
    expect(() => apply(base(), { mode: "a" }, list)).toThrowError(expect.objectContaining({ code: "workflow_mismatch" }));
  });
});
