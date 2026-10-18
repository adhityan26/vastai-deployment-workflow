#!/usr/bin/env python3
"""Print the `models:` entry of a Hugging Face file, pinned to a commit and with its size.

    python3 scripts/pin_model.py WarmBloodAban/Qwen-Image-2.1-LoRAs Qwen2.1_Anything2RealCharacters.safetensors

Paste the printed line into instance/profiles/image.yaml. Needs network access to huggingface.co (the
cloud sessions of this project do not have it: run this on the laptop). Only the standard library.
"""
import json
import re
import sys
import urllib.parse
import urllib.request

REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
DEST = {"gguf": "models/diffusion_models/", "safetensors": "models/loras/"}


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
            return f"  - {{file: {file}, repo: {repo}, revision: {sha}, dest: {dest}, size_bytes: {size}}}"
    raise ValueError(f"{file} is not in {repo}")


def fetch(repo: str, revision: str) -> dict:
    url = f"https://huggingface.co/api/models/{repo}/revision/{urllib.parse.quote(revision, safe='')}?blobs=true"
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
    dest = argv[3] if len(argv) > 3 else DEST.get(file.rsplit(".", 1)[-1], "models/")
    revision = argv[4] if len(argv) > 4 else "main"
    try:
        print(entry_line(fetch(repo, revision), repo, file, dest))
    except (OSError, ValueError) as err:
        print(f"could not pin: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
