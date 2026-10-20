"""The file the early network probe of instance/bootstrap.sh downloads a range of.

Runs BEFORE the agent venv exists (bootstrap step net_probe), as a plain script of the system python3
(`python3 -I net_probe.py url ...`), so it uses the standard library only; PyYAML is used when the
system Python happens to have it, otherwise the `models:` entries of the profile are read with a small
parser of the one-line flow mappings the profiles use. Any doubt (unreadable profile, no usable entry,
a value outside the expected characters) exits non-zero: the probe is best effort and bootstrap then
continues without it.

The URL is the profile's own pinned file (never a hardcoded one): the smallest pinned model that is at
least as large as the probe range, else the largest one.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
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


def read_models(profile: Path) -> list[dict]:
    text = profile.read_text()
    try:
        import yaml  # noqa: PLC0415 (optional on the system Python)
    except ImportError:
        return _flow_models(text)
    data = yaml.safe_load(text)
    models = data.get("models") if isinstance(data, dict) else None
    return [m for m in models if isinstance(m, dict)] if isinstance(models, list) else []


def _valid(entry: dict) -> tuple[str, str, str, int] | None:
    file, repo, revision, size = (str(entry.get(k, "")) for k in ("file", "repo", "revision", "size_bytes"))
    if not (FILE_RE.fullmatch(file) and ".." not in file.split("/") and REPO_RE.fullmatch(repo)
            and REVISION_RE.fullmatch(revision) and size.isdigit() and size.isascii()):
        return None
    return file, repo, revision, int(size)


def probe_url(profile: Path, base: str, min_bytes: int) -> str | None:
    entries = [v for v in (_valid(m) for m in read_models(profile)) if v is not None and v[3] > 0]
    if not entries:
        return None
    big_enough = [e for e in entries if e[3] >= min_bytes]
    file, repo, revision, _size = min(big_enough, key=lambda e: e[3]) if big_enough else max(entries, key=lambda e: e[3])
    return f"{base.rstrip('/')}/{repo}/resolve/{quote(revision)}/{quote(file)}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="net_probe")
    sub = parser.add_subparsers(dest="command", required=True)
    url = sub.add_parser("url")
    url.add_argument("--profile", type=Path, required=True)
    url.add_argument("--base", required=True)
    url.add_argument("--min-bytes", type=int, required=True)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/?", args.base):  # config-lint: ok (URL shape check, no URL)
        return EXIT_NO_URL
    try:
        found = probe_url(args.profile, args.base, args.min_bytes)
    except Exception:  # best effort: any problem means "no probe"
        return EXIT_NO_URL
    if found is None:
        return EXIT_NO_URL
    print(found)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
