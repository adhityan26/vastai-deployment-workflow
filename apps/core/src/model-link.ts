// A video diffusion model given as a link by an admin (Start dialog, or the Video tool's download). The same narrow
// shape as instance/agent/vastcomfy_agent/model_link.py, checked here before anything is rented or sent, and again on
// the instance (which also checks every redirect and the size). Untrusted input: https only, ASCII only, no user
// info, no port, no percent-encoding, an allowed host (VIDEO_MODEL_LINK_HOSTS), a Hugging Face file path ending in
// .safetensors. A linked model is NOT integrity-pinned or licence-checked.

export class ModelLinkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelLinkError";
    this.code = code;
  }
}

export interface ModelLink {
  readonly host: string;
  readonly repo: string;
  readonly revision: string;
  /** The file's path inside the repo, and the plain name it is stored under. */
  readonly file: string;
  readonly name: string;
  /** The canonical resolve URL (a blob link and ?download=true become this). */
  readonly url: string;
}

export const MODEL_LINK_MAX_CHARS = 2048;
// Protocol rules: the shapes of a Hugging Face file URL.
const URL_SHAPE = /^https:\/\/([a-z0-9.-]{1,253})(\/[A-Za-z0-9._/-]{1,1500})(\?download=true)?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IPV4 = /^[0-9.]+$/;
const PATH_SEGMENTS_MAX = 4;
// The linkable model formats (neither is pickle); the extension also picks the loader node (loaderFor).
const SUFFIXES = [".safetensors", ".gguf"] as const;
/** The ComfyUI-GGUF loader a .gguf diffusion model needs (its input that takes the file is unet_name). */
export const GGUF_LOADER = "UnetLoaderGGUF";
const hasSuffix = (name: string): boolean => SUFFIXES.some((s) => name.endsWith(s) && name !== s);
// eslint-disable-next-line no-control-regex
const ASCII = /^[\x21-\x7e]+$/;

const invalid = (message: string): ModelLinkError => new ModelLinkError("invalid_model_link", message);

/** The link's parts, or ModelLinkError (invalid_model_link, model_link_host_not_allowed, model_link_unsupported_type). */
export function parseModelLink(url: unknown, hosts: readonly string[]): ModelLink {
  if (typeof url !== "string" || url === "" || url.length > MODEL_LINK_MAX_CHARS || !ASCII.test(url)) {
    throw invalid("the model link must be an https Hugging Face file link");
  }
  const m = URL_SHAPE.exec(url);
  if (m === null) throw invalid("the model link must be a plain https Hugging Face link: <host>/<owner>/<repo>/resolve/<revision>/<file>");
  const host = m[1]!;
  const path = m[2]!;
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..") || IPV4.test(host) || host === "localhost") {
    throw invalid("the model link has no usable host name");
  }
  if (!hosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== "").includes(host)) {
    throw new ModelLinkError("model_link_host_not_allowed", "links are only accepted from the allowed model hosts");
  }
  const parts = path.split("/").slice(1);
  if (parts.length < 5 || (parts[2] !== "resolve" && parts[2] !== "blob") || parts.length - 4 > PATH_SEGMENTS_MAX) {
    throw invalid("the model link must point to one file: <owner>/<repo>/resolve/<revision>/<file>");
  }
  const [owner, repo, , revision, ...rest] = parts as [string, string, string, string, ...string[]];
  if (!NAME.test(owner) || !NAME.test(repo) || !REVISION.test(revision)) throw invalid("the model link has an invalid repo or revision");
  if (!rest.every((s) => SEGMENT.test(s)) || [owner, repo, revision, ...rest].some((s) => s.includes(".."))) {
    throw invalid("the model link has an invalid file path");
  }
  const name = rest[rest.length - 1]!;
  if (!hasSuffix(name)) throw new ModelLinkError("model_link_unsupported_type", "only .safetensors or .gguf model files can be linked");
  const file = rest.join("/");
  return { host, repo: `${owner}/${repo}`, revision, file, name, url: `https://${host}/${owner}/${repo}/resolve/${revision}/${file}` }; // config-lint: ok (protocol shape of a checked link)
}

/** True for a plain .safetensors or .gguf file name an instance may report as its linked model. */
export function isLinkedModelName(value: unknown): value is string {
  return typeof value === "string" && SEGMENT.test(value) && hasSuffix(value) && !value.includes("..");
}

/** The loader class a linked model needs in place of the workflow's own; null when the workflow's loader fits. */
export function loaderFor(name: string): string | null {
  return name.endsWith(".gguf") ? GGUF_LOADER : null;
}
