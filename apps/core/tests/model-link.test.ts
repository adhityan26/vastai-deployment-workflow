import { describe, expect, it } from "vitest";
import { ModelLinkError, isLinkedModelName, loaderFor, parseModelLink } from "../src/model-link.js";

const HOSTS = ["huggingface.co"];
const GOOD = "https://huggingface.co/org/video-model/resolve/main/split_files/diffusion_models/model_fp16.safetensors"; // config-lint: ok (test fixture)

describe("parseModelLink", () => {
  it("parses a resolve link into repo, revision and file", () => {
    expect(parseModelLink(GOOD, HOSTS)).toEqual({
      host: "huggingface.co", repo: "org/video-model", revision: "main", file: "split_files/diffusion_models/model_fp16.safetensors",
      name: "model_fp16.safetensors", url: GOOD,
    });
  });

  it("turns a blob link and ?download=true into the resolve link", () => {
    expect(parseModelLink(`${GOOD.replace("/resolve/", "/blob/")}?download=true`, HOSTS).url).toBe(GOOD);
  });

  const B = "https://huggingface.co/o/r/resolve/main"; // config-lint: ok (test fixture)
  it.each<[unknown, string]>([
    [`${B.replace("https", "http")}/m.safetensors`, "invalid_model_link"],
    ["https://user:pw@huggingface.co/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://huggingface.co@evil.com/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://huggingface.co:443/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://127.0.0.1/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://[::1]/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://localhost/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://huggingface.co./o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://HUGGINGFACE.CO/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    ["https://huggingface.co.evil.com/o/r/resolve/main/m.safetensors", "model_link_host_not_allowed"], // config-lint: ok (test fixture)
    ["https://evilhuggingface.co/o/r/resolve/main/m.safetensors", "model_link_host_not_allowed"], // config-lint: ok (test fixture)
    ["https://xn--hggingface-q9a.co/o/r/resolve/main/m.safetensors", "model_link_host_not_allowed"], // config-lint: ok (test fixture)
    ["https://hüggingface.co/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    [`${B}/../../m.safetensors`, "invalid_model_link"],
    [`${B}/a/..%2Fm.safetensors`, "invalid_model_link"],
    [`${B}/%252e%252e/m.safetensors`, "invalid_model_link"],
    [`${B}/a//m.safetensors`, "invalid_model_link"],
    [`${B.replace("resolve", "tree")}/m.safetensors`, "invalid_model_link"],
    ["https://huggingface.co/datasets/o/r/resolve/main/m.safetensors", "invalid_model_link"], // config-lint: ok (test fixture)
    [`${B}/m.safetensors?x=1`, "invalid_model_link"],
    [`${B}/m.safetensors#f`, "invalid_model_link"],
    [`${B}/m.safetensors\n`, "invalid_model_link"],
    [` ${B}/m.safetensors`, "invalid_model_link"],
    [`${B}/a/b/c/d/e/m.safetensors`, "invalid_model_link"],
    [`${B}/m.ckpt`, "model_link_unsupported_type"],
    [`${B}/m.bin`, "model_link_unsupported_type"],
    [`${B}/m.pt`, "model_link_unsupported_type"],
    [`${B}/m.gguf.bin`, "model_link_unsupported_type"],
    [`${B}/.gguf`, "invalid_model_link"],
    [`${B}/m.safetensors.pt`, "model_link_unsupported_type"],
    [`${B}/.safetensors`, "invalid_model_link"],
    ["", "invalid_model_link"],
    [null, "invalid_model_link"],
    [5, "invalid_model_link"],
    [`${B}/${"a".repeat(3000)}.safetensors`, "invalid_model_link"],
  ])("refuses %j (%s)", (url, code) => {
    let caught: unknown = null;
    try {
      parseModelLink(url, HOSTS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelLinkError);
    expect((caught as ModelLinkError).code).toBe(code);
  });

  it("takes its hosts from configuration", () => {
    expect(parseModelLink(GOOD.replace("huggingface.co", "hf-mirror.example"), ["hf-mirror.example"]).host).toBe("hf-mirror.example");
    expect(() => parseModelLink(GOOD, ["hf-mirror.example"])).toThrow(ModelLinkError);
  });

  it("accepts a .gguf link, which needs the GGUF loader", () => {
    expect(parseModelLink(`${B}/q/model-Q5_K_M.gguf`, HOSTS).name).toBe("model-Q5_K_M.gguf");
    expect(loaderFor("model-Q5_K_M.gguf")).toBe("UnetLoaderGGUF");
    expect(loaderFor("m.safetensors")).toBeNull();
  });

  it("knows a plain linked model name", () => {
    expect(isLinkedModelName("better_unet.safetensors")).toBe(true);
    expect(isLinkedModelName("better_unet.gguf")).toBe(true);
    for (const bad of ["../x.safetensors", "a/b.safetensors", "x.ckpt", ".safetensors", "", 5, "a..b.safetensors"]) expect(isLinkedModelName(bad)).toBe(false);
  });
});
