import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoraStore, LoraStoreError, loraFileName, parseLoraLink, type LoraInput } from "../src/lora-store.js";

const HOSTS = ["huggingface.co"];
const HIGH = "https://huggingface.co/someone/moves/resolve/main/moves_high.safetensors"; // config-lint: ok (test fixture)
const LOW = "https://huggingface.co/someone/moves/blob/abc123/sub/moves_low.safetensors?download=true"; // config-lint: ok (test fixture)
const dir = () => mkdtempSync(join(tmpdir(), "loras-"));
let n = 0;
const make = (path = join(dir(), "extra-loras.json"), maxEntries = 3) =>
  new LoraStore(path, { maxEntries, hosts: HOSTS, now: () => 1_800_000_000, newId: () => `lora_${(n++).toString(16).padStart(8, "0")}` });
const input = (over: Partial<LoraInput> = {}): LoraInput => ({ title: "Moves", family: "wan22_a14b", modes: ["image"], high: HIGH, ...over });

describe("parseLoraLink", () => {
  it("takes the model-link rules and .safetensors files only", () => {
    expect(parseLoraLink(HIGH, HOSTS)).toMatchObject({ repo: "someone/moves", revision: "main", file: "moves_high.safetensors" });
    expect(parseLoraLink(LOW, HOSTS).url).toBe("https://huggingface.co/someone/moves/resolve/abc123/sub/moves_low.safetensors"); // config-lint: ok (test fixture)
    expect(() => parseLoraLink(HIGH.replace(".safetensors", ".gguf"), HOSTS)).toThrow(expect.objectContaining({ code: "model_link_unsupported_type" }));
    for (const [bad, code] of [
      ["http://huggingface.co/o/r/resolve/main/x.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
      ["https://user@huggingface.co/o/r/resolve/main/x.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
      ["https://huggingface.co:8443/o/r/resolve/main/x.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
      ["https://huggingface.co/o/r/resolve/main/%2e%2e/x.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
      ["https://evil.example/o/r/resolve/main/x.safetensors", "model_link_host_not_allowed"], // config-lint: ok (test fixture)
      ["https://huggingface.co/o/r/resolve/main/x.ckpt", "model_link_unsupported_type"], // config-lint: ok (test fixture)
    ]) {
      expect(() => parseLoraLink(bad, HOSTS), bad).toThrow(expect.objectContaining({ code }));
    }
  });
});

describe("LoraStore", () => {
  it("starts empty without a file, adds an entry with a generated id and server-chosen file names, and keeps it", () => {
    const path = join(dir(), "extra-loras.json");
    const store = make(path);
    expect(store.list()).toEqual([]);
    const added = store.add(input({ low: LOW, description: "d", strength: 0.7, hidden: true, trigger_words: "jump" }));
    expect(added.id).toMatch(/^lora_[0-9a-f]{8}$/);
    expect(added).toMatchObject({
      title: "Moves", description: "d", family: "wan22_a14b", modes: ["image"], strength: 0.7, hidden: true, trigger_words: "jump", created_at: 1_800_000_000,
      high: { url: HIGH, repo: "someone/moves", revision: "main", path: "moves_high.safetensors", name: loraFileName(added.id, "high") },
      low: { repo: "someone/moves", revision: "abc123", path: "sub/moves_low.safetensors", name: `xl_${added.id}_low.safetensors` },
    });
    // The stored file names never come from the link.
    expect(added.high!.name).toBe(`xl_${added.id}_high.safetensors`);
    expect(make(path).list()).toEqual([added]);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.version).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(path, ".."))).toEqual(["extra-loras.json"]); // no temp file left
  });

  it("defaults: no description, both modes as given, strength 1, not hidden, no trigger words", () => {
    const a = make().add(input());
    expect(a).toMatchObject({ description: "", strength: 1, hidden: false, trigger_words: "" });
    expect(a.low).toBeUndefined();
  });

  it.each<[string, Partial<LoraInput> | Record<string, unknown>, string]>([
    ["no side at all", { high: undefined }, "invalid_lora"],
    ["a blank title", { title: " " }, "invalid_lora"],
    ["a long title", { title: "x".repeat(61) }, "invalid_lora"],
    ["a title on two lines", { title: "a\nb" }, "invalid_lora"],
    ["a long description", { description: "x".repeat(401) }, "invalid_lora"],
    ["long trigger words", { trigger_words: "x".repeat(201) }, "invalid_lora"],
    ["no modes", { modes: [] }, "invalid_lora"],
    ["an unknown mode", { modes: ["video"] }, "invalid_lora"],
    ["a mode twice", { modes: ["image", "image"] }, "invalid_lora"],
    ["a strength above 1", { strength: 1.2 }, "invalid_lora"],
    ["a strength that is not a number", { strength: "1" }, "invalid_lora"],
    ["hidden that is not a boolean", { hidden: "yes" }, "invalid_lora"],
    ["a bad family id", { family: "../x" }, "invalid_lora"],
    ["a gguf link", { high: HIGH.replace(".safetensors", ".gguf") }, "model_link_unsupported_type"],
    ["a link to another host", { high: "https://evil.example/o/r/resolve/main/x.safetensors" }, "model_link_host_not_allowed"], // config-lint: ok (test fixture)
    ["the same file on both sides", { low: HIGH }, "model_link_name_clash"],
    ["an unknown member", { file: "x.safetensors" }, "invalid_lora"],
  ])("refuses %s and stores nothing", (_n, over, code) => {
    const path = join(dir(), "extra-loras.json");
    const store = make(path);
    expect(() => store.add({ ...input(), ...over } as LoraInput)).toThrow(expect.objectContaining({ code }));
    expect(existsSync(path)).toBe(false);
  });

  it("refuses an entry past the cap", () => {
    const store = make(undefined, 2);
    store.add(input());
    store.add(input());
    expect(() => store.add(input())).toThrow(expect.objectContaining({ code: "lora_limit_reached" }));
    expect(store.list()).toHaveLength(2);
  });

  it("updates the editable fields only; links are immutable", () => {
    const store = make();
    const a = store.add(input());
    const b = store.update(a.id, { title: "New", description: "x", modes: ["text", "image"], strength: 0.5, hidden: true, trigger_words: "t" });
    expect(b).toEqual({ ...a, title: "New", description: "x", modes: ["text", "image"], strength: 0.5, hidden: true, trigger_words: "t" });
    for (const bad of [{ high: LOW }, { family: "other" }, { id: "x" }, { title: "" }, { strength: 2 }, { hidden: 1 }]) {
      expect(() => store.update(a.id, bad as never), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: "invalid_lora" }));
    }
    expect(() => store.update("lora_nope", { title: "x" })).toThrow(expect.objectContaining({ code: "unknown_lora" }));
    expect(store.list()).toEqual([b]);
  });

  it("removes an entry", () => {
    const store = make();
    const a = store.add(input());
    store.remove(a.id);
    expect(store.list()).toEqual([]);
    expect(() => store.remove(a.id)).toThrow(expect.objectContaining({ code: "unknown_lora" }));
  });

  it("never reuses a taken id", () => {
    let i = 0;
    const ids = ["lora_00000001", "lora_00000001", "lora_00000002"];
    const store = new LoraStore(join(dir(), "x.json"), { maxEntries: 5, hosts: HOSTS, now: () => 1, newId: () => ids[i++]! });
    expect(store.add(input()).id).toBe("lora_00000001");
    expect(store.add(input()).id).toBe("lora_00000002");
  });

  it("a corrupt or foreign file: nothing listed and every write refused (never overwritten)", () => {
    for (const text of ["{not json", JSON.stringify({ version: 2, loras: [] }), JSON.stringify({ version: 1, loras: [{ id: "x" }] }), JSON.stringify([1])]) {
      const path = join(dir(), "extra-loras.json");
      writeFileSync(path, text);
      const store = make(path);
      expect(store.list(), text).toEqual([]);
      expect(() => store.add(input())).toThrow(LoraStoreError);
      expect(() => store.add(input())).toThrow(expect.objectContaining({ code: "lora_store_unavailable" }));
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  it("a stored entry whose file name or link was tampered with is refused on load", () => {
    const path = join(dir(), "extra-loras.json");
    const store = make(path);
    const a = store.add(input());
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.loras[0].high.name = "../../evil.safetensors";
    writeFileSync(path, JSON.stringify(raw));
    expect(make(path).list()).toEqual([]);
    raw.loras[0].high.name = a.high!.name;
    raw.loras[0].high.url = "https://evil.example/o/r/resolve/main/x.safetensors"; // config-lint: ok (test fixture)
    writeFileSync(path, JSON.stringify(raw));
    expect(make(path).list()).toEqual([]);
  });
});

describe("lorasDigest", () => {
  it("is the agent's: sha256 of the sorted name-url lines", async () => {
    const { createHash } = await import("node:crypto");
    const { lorasDigest } = await import("../src/lora-store.js");
    const a = { name: "xl_a_high.safetensors", url: "u1" };
    const b = { name: "xl_b_low.safetensors", url: "u2" };
    expect(lorasDigest([b, a])).toBe(createHash("sha256").update("xl_a_high.safetensors u1\nxl_b_low.safetensors u2").digest("hex"));
    expect(lorasDigest([])).toBe(createHash("sha256").update("").digest("hex"));
  });
});
