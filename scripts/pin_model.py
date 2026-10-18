#!/usr/bin/env python3
"""Print the `models:` entry of a Hugging Face file, pinned to a commit and with its size.

    python3 scripts/pin_model.py WarmBloodAban/Qwen-Image-2.1-LoRAs Qwen2.1_Anything2RealCharacters.safetensors
    python3 scripts/pin_model.py Comfy-Org/Real-ESRGAN_repackaged RealESRGAN_x4plus.safetensors models/upscale_models/

Paste the printed line into instance/profiles/image.yaml. Every string in it is JSON-quoted (valid YAML), so a
file name with YAML syntax in it stays one value. The dest defaults by extension (.gguf, .safetensors as a LoRA,
.pth as an upscale model); pass it for anything else, e.g. an upscale model in .safetensors. Needs network access to huggingface.co (the
cloud sessions of this project do not have it: run this on the laptop). Only the standard library.
"""
import json
import re
import sys
import urllib.parse
import urllib.request

REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
DEST = {"gguf": "models/diffusion_models/", "safetensors": "models/loras/", "pth": "models/upscale_models/"}
# One ComfyUI model folder, relative, with the trailing slash the profile uses.
DEST_PATTERN = re.compile(r"^models/[a-z0-9_]+/$")


def default_dest(file: str) -> str | None:
    """The usual ComfyUI folder for `file` by its extension; None when there is no safe guess."""
    return DEST.get(file.rsplit(".", 1)[-1].lower()) if "." in file else None


def entry_line(info: dict, repo: str, file: str, dest: str) -> str:
    """The profile line for `file` from the JSON of /api/models/<repo>/revision/<rev>?blobs=true."""
    sha = info.get("sha")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("the reply has no commit sha")
    for sibling in info.get("siblings") or []:
        if sibling.get("rfilename") == file:
            size = sibling.get("size")
            if not isinstance(size, int) or size <= 0:
                raise ValueError(f"{file} has no size in the reply")
            q = json.dumps  # a JSON string is a YAML flow scalar: quotes and escapes whatever the name holds
            return f"  - {{file: {q(file)}, repo: {q(repo)}, revision: {q(sha)}, dest: {q(dest)}, size_bytes: {size}}}"
    raise ValueError(f"{file} is not in {repo}")


def fetch(repo: str, revision: str) -> dict:
    url = f"https://huggingface.co/api/models/{repo}/revision/{urllib.parse.quote(revision, safe='')}?blobs=true"  # config-lint: ok (public Hugging Face API, a laptop tool)
    with urllib.request.urlopen(url, timeout=30) as res:  # noqa: S310 - fixed https host
        return json.load(res)


def main(argv: list[str]) -> int:
    if len(argv) not in (3, 4, 5):
        print("usage: pin_model.py <owner/repo> <file> [dest] [revision]", file=sys.stderr)
        return 2
    repo, file = argv[1], argv[2]
    if not REPO.match(repo):
        print("the repo must look like owner/name", file=sys.stderr)
        return 2
    dest = argv[3] if len(argv) > 3 else default_dest(file)
    if dest is None:
        print("no default dest for this file type: pass one, e.g. models/upscale_models/", file=sys.stderr)
        return 2
    if not DEST_PATTERN.match(dest):
        print("the dest must be one ComfyUI model folder like models/loras/", file=sys.stderr)
        return 2
    revision = argv[4] if len(argv) > 4 else "main"
    try:
        print(entry_line(fetch(repo, revision), repo, file, dest))
    except (OSError, ValueError) as err:
        print(f"could not pin: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
