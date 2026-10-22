"""The file the early network probe of instance/bootstrap.sh downloads a range of.

Runs BEFORE the agent venv exists (bootstrap step net_probe), as a plain script of the system python3
(`python3 -I net_probe.py url ...`), so it uses the standard library only; PyYAML is used when the
system Python happens to have it, otherwise the `models:` entries of the profile are read with a small
parser of the one-line flow mappings the profiles use. Any doubt (unreadable profile, no usable entry,
a value outside the expected characters) exits non-zero: the probe is best effort and bootstrap then
continues without it.

The URL is the profile's own pinned file (never a hardcoded one): the LARGEST pinned model, so the probe
takes the repo and CDN path (Hugging Face's xet/LFS storage) that carries most of the boot download; only a
small range of it is read. `present` tells bootstrap that every pinned file is already in place (a restart
or a reused disk), in which case it does not probe at all. The files of the profile's `video:` section are left out
of both: they are optional (downloaded only with VIDEO_ENABLED and "Include video models", or later on demand), so an
image-only boot probes and skips exactly as before they were pinned.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path, PurePosixPath
from urllib.parse import quote

REPO_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
REVISION_RE = re.compile(r"[0-9A-Za-z._-]{1,64}")
FILE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._ +-]*(?:/[A-Za-z0-9][A-Za-z0-9._ +-]*)*")
FLOW_ITEM = re.compile(r"^\s*-\s*\{(.*)\}\s*(?:#.*)?$")
FLOW_PAIR = re.compile(r"""\s*([a-z_]+)\s*:\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,]*?)\s*(?:,|$)""")
TOP_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\s*:")
EXIT_OK = 0
EXIT_NO_URL = 1


def _scalar(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    return raw


def _flow_models(text: str) -> list[dict]:
    """The one-line `- {key: value, ...}` entries under the top-level `models:` key."""
    out: list[dict] = []
    inside = False
    for line in text.splitlines():
        if TOP_KEY.match(line):
            inside = line.split(":", 1)[0].strip() == "models"
            continue
        if not inside:
            continue
        item = FLOW_ITEM.match(line)
        if item:
            out.append({k: _scalar(v) for k, v in FLOW_PAIR.findall(item.group(1)) if k})
    return out


def _flow_video_files(text: str) -> set[str]:
    """The `file` values of the one-line `- {file: ..., dest: ...}` entries inside the top-level `video:` section."""
    out: set[str] = set()
    inside = False
    for line in text.splitlines():
        if TOP_KEY.match(line):
            inside = line.split(":", 1)[0].strip() == "video"
            continue
        item = FLOW_ITEM.match(line) if inside else None
        if item:
            pairs = {k: _scalar(v) for k, v in FLOW_PAIR.findall(item.group(1)) if k}
            if "file" in pairs and "dest" in pairs:
                out.add(pairs["file"])
    return out


def _without_video(models: list[dict], video_files: set[str]) -> list[dict]:
    return [m for m in models if PurePosixPath(str(m.get("file", ""))).name not in video_files]


def read_models(profile: Path) -> list[dict]:
    """The pinned models a boot always downloads: `models:` minus the video section's files."""
    text = profile.read_text()
    try:
        import yaml  # noqa: PLC0415 (optional on the system Python)
    except ImportError:
        return _without_video(_flow_models(text), _flow_video_files(text))
    data = yaml.safe_load(text)
    models = data.get("models") if isinstance(data, dict) else None
    video = data.get("video") if isinstance(data, dict) else None
    entries = video.get("models") if isinstance(video, dict) else None
    files = {str(e.get("file")) for e in entries if isinstance(e, dict)} if isinstance(entries, list) else set()
    return _without_video([m for m in models if isinstance(m, dict)] if isinstance(models, list) else [], files)


def _valid(entry: dict) -> tuple[str, str, str, int] | None:
    file, repo, revision, size = (str(entry.get(k, "")) for k in ("file", "repo", "revision", "size_bytes"))
    if not (FILE_RE.fullmatch(file) and ".." not in file.split("/") and REPO_RE.fullmatch(repo)
            and REVISION_RE.fullmatch(revision) and size.isdigit() and size.isascii()):
        return None
    return file, repo, revision, int(size)


def _entries(profile: Path) -> list[tuple[str, str, str, int, str]]:
    out = []
    for m in read_models(profile):
        valid = _valid(m)
        dest = str(m.get("dest", ""))
        if valid is not None and valid[3] > 0:
            out.append((*valid, dest))
    return out


def probe_url(profile: Path, base: str) -> str | None:
    entries = _entries(profile)
    if not entries:
        return None
    file, repo, revision, _size, _dest = max(entries, key=lambda e: e[3])
    return f"{base.rstrip('/')}/{repo}/resolve/{quote(revision)}/{quote(file)}"


def all_present(profile: Path, comfy_dir: Path) -> bool:
    """Every pinned file sits at COMFY_DIR/<dest>/<basename> with its pinned size (as the agent places them)."""
    entries = _entries(profile)
    if not entries:
        return False
    for file, _repo, _revision, size, dest in entries:
        if dest.startswith("/") or ".." in PurePosixPath(dest).parts:
            return False
        target = comfy_dir / dest / PurePosixPath(file).name
        if not target.is_file() or target.stat().st_size != size:
            return False
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="net_probe")
    sub = parser.add_subparsers(dest="command", required=True)
    url = sub.add_parser("url")
    url.add_argument("--profile", type=Path, required=True)
    url.add_argument("--base", required=True)
    present = sub.add_parser("present")
    present.add_argument("--profile", type=Path, required=True)
    present.add_argument("--comfy-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "present":
        try:
            return EXIT_OK if all_present(args.profile, args.comfy_dir) else EXIT_NO_URL
        except Exception:  # best effort: any doubt means "not all present", so the probe runs
            return EXIT_NO_URL
    if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/?", args.base):  # config-lint: ok (URL shape check, no URL)
        return EXIT_NO_URL
    try:
        found = probe_url(args.profile, args.base)
    except Exception:  # best effort: any problem means "no probe"
        return EXIT_NO_URL
    if found is None:
        return EXIT_NO_URL
    print(found)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
