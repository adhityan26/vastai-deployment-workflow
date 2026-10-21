"""The marker of the custom instance image (instance/image/Dockerfile) and the checks around it.

The custom image bakes, outside /workspace, the agent venv (the agent's third-party dependencies and the
pinned vastai CLI, never the agent package itself) and the pinned Tailscale tarball, and records what it baked
in a small JSON marker. At boot, instance/bootstrap.sh asks this helper whether the marker vouches for exactly
what the configuration wants (`check runtime`, `check tailscale`); only then it skips the matching install.
Any doubt (no marker: the stock image; an unreadable or unknown marker; another version, place or dependency
set) is a non-zero exit and bootstrap installs at boot as it always did.

Runs BEFORE the agent venv exists, as a plain script of the system python3 (`python3 -I image_marker.py ...`),
so it uses the standard library only (no tomllib: the image's system Python may be older than 3.11).
scripts/build-image.sh uses the same helper for the schema defaults and the dependency set, so the image, its
tag and the boot check agree by construction.

Exit codes of `check`: 0 the marker vouches for it, 1 no marker, 2 unreadable or unknown marker, 3 the marker
names another version or dependency set (the baked files are stale), 4 baked somewhere else than configured.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

MARKER_SCHEMA = 1
EXIT_MATCH = 0
EXIT_MISSING = 1
EXIT_CORRUPT = 2
EXIT_STALE = 3
EXIT_ELSEWHERE = 4
EXIT_USAGE = 64

REQUIRED = ("vastai_version", "tailscale_version", "venv_dir", "tailscale_dir", "agent_deps_hash")
VALUE_RE = re.compile(r"/?[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}")
DEP_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?(?:(?:===|==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+!-]+)*"
                    r"(?:,(?:===|==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+!-]+)*")
SECTION_RE = re.compile(r"^\s*\[([^\]]+)\]\s*(?:#.*)?$")
ARRAY_START_RE = re.compile(r"^\s*([A-Za-z0-9_-]+)\s*=\s*\[(.*)$")
STRING_RE = re.compile(r"\"([^\"\\]*)\"|'([^']*)'")
SCHEMA_NAME_RE = re.compile(r"\bname:\s*([A-Z0-9_]+)\s*,")
SCHEMA_DEFAULT_RE = re.compile(r"\bdefault:\s*(\"(?:[^\"\\]|\\.)*\"|[^,}]*)")


class MarkerError(Exception):
    """An unreadable marker, pyproject or schema entry."""


# --- inputs shared with scripts/build-image.sh ---------------------------------------------------------------

def schema_default(schema_text: str, name: str) -> str:
    """The default of one key of contracts/config-schema.yaml (its one-line flow mappings), as text."""
    for line in schema_text.splitlines():
        found = SCHEMA_NAME_RE.search(line)
        if not found or found.group(1) != name:
            continue
        default = SCHEMA_DEFAULT_RE.search(line)
        if not default:
            break
        raw = default.group(1).strip()
        if raw in ("", "null", "~"):
            break
        if len(raw) >= 2 and raw[0] == raw[-1] == '"':
            return json.loads(raw)
        return raw
    raise MarkerError(f"no default for {name} in the schema")


def _arrays(text: str, wanted: dict[str, str]) -> dict[tuple[str, str], list[str]]:
    """The string arrays `key = [...]` under the wanted `[section]` headers (a tiny TOML subset)."""
    found: dict[tuple[str, str], list[str]] = {}
    section = None
    collecting: tuple[str, str] | None = None
    for line in text.splitlines():
        if collecting is not None:
            found[collecting].extend(a or b for a, b in STRING_RE.findall(line))
            if "]" in STRING_RE.sub("", line).split("#", 1)[0]:
                collecting = None
            continue
        header = SECTION_RE.match(line)
        if header:
            section = header.group(1).strip()
            continue
        start = ARRAY_START_RE.match(line)
        if start and wanted.get(section) == start.group(1):
            key = (section, start.group(1))
            rest = start.group(2)
            found[key] = [a or b for a, b in STRING_RE.findall(rest)]
            if "]" not in STRING_RE.sub("", rest):
                collecting = key
    if collecting is not None:
        raise MarkerError("unterminated array in pyproject.toml")
    return found


def agent_deps(pyproject_text: str) -> list[str]:
    """What the image installs into the agent venv for the agent: its build requirements (an offline editable
    install builds without isolation) and its runtime dependencies. Sorted, without duplicates."""
    arrays = _arrays(pyproject_text, {"build-system": "requires", "project": "dependencies"})
    requires = arrays.get(("build-system", "requires"))
    deps = arrays.get(("project", "dependencies"))
    if not requires or not deps:
        raise MarkerError("pyproject.toml has no build-system requires or project dependencies")
    out = sorted({item.strip() for item in requires + deps})
    for item in out:
        if not DEP_RE.fullmatch(item):
            raise MarkerError(f"unexpected dependency text: {item!r}")
    return out


def deps_hash(deps: list[str]) -> str:
    """Short, order-independent fingerprint of a dependency set (used in the marker and the image tag)."""
    return hashlib.sha256(("\n".join(sorted(deps)) + "\n").encode()).hexdigest()[:12]


# --- the marker and the boot decisions -------------------------------------------------------------------------

def read_marker(path: Path) -> dict:
    try:
        text = Path(path).read_text()
    except FileNotFoundError:
        raise FileNotFoundError(str(path)) from None
    except (OSError, UnicodeDecodeError) as exc:
        raise MarkerError(f"image marker unreadable ({exc.__class__.__name__})") from None
    try:
        data = json.loads(text)
    except ValueError:
        raise MarkerError("image marker is not JSON") from None
    if not isinstance(data, dict):
        raise MarkerError("image marker is not a JSON object")
    if type(data.get("schema")) is not int or data["schema"] != MARKER_SCHEMA:
        raise MarkerError(f"image marker schema {data.get('schema')!r} is not {MARKER_SCHEMA}")
    for key in REQUIRED:
        value = data.get(key)
        if not isinstance(value, str) or not VALUE_RE.fullmatch(value):
            raise MarkerError(f"image marker field {key} missing or malformed")
    return data


def _load(path: Path) -> tuple[int, str, dict | None]:
    try:
        return EXIT_MATCH, "", read_marker(path)
    except FileNotFoundError:
        return EXIT_MISSING, "no image marker", None
    except MarkerError as exc:
        return EXIT_CORRUPT, str(exc), None


def check_runtime(marker: Path, *, vastai_version: str, venv_dir: str, pyproject: Path) -> tuple[int, str]:
    code, reason, data = _load(marker)
    if data is None:
        return code, reason
    if data["venv_dir"] != venv_dir:
        return EXIT_ELSEWHERE, f"image venv is {data['venv_dir']}, configured {venv_dir}"
    if data["vastai_version"] != vastai_version:
        return EXIT_STALE, f"image vastai {data['vastai_version']}, configured {vastai_version}"
    try:
        wanted = deps_hash(agent_deps(Path(pyproject).read_text()))
    except (OSError, UnicodeDecodeError, MarkerError) as exc:
        return EXIT_CORRUPT, f"agent dependencies unreadable ({exc})"
    if data["agent_deps_hash"] != wanted:
        return EXIT_STALE, f"agent dependencies changed since the image was built ({data['agent_deps_hash']} != {wanted})"
    return EXIT_MATCH, f"vastai {vastai_version}, agent dependencies {wanted}"


def check_tailscale(marker: Path, *, tailscale_version: str, tailscale_dir: str) -> tuple[int, str]:
    code, reason, data = _load(marker)
    if data is None:
        return code, reason
    if data["tailscale_dir"] != tailscale_dir:
        return EXIT_ELSEWHERE, f"image Tailscale is in {data['tailscale_dir']}, configured {tailscale_dir}"
    if data["tailscale_version"] != tailscale_version:
        return EXIT_STALE, f"image Tailscale {data['tailscale_version']}, configured {tailscale_version}"
    return EXIT_MATCH, f"Tailscale {tailscale_version}"


# --- command line ----------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check")
    check.add_argument("component", choices=["runtime", "tailscale"])
    check.add_argument("--marker", type=Path, required=True)
    check.add_argument("--vastai-version")
    check.add_argument("--venv-dir")
    check.add_argument("--pyproject", type=Path)
    check.add_argument("--tailscale-version")
    check.add_argument("--tailscale-dir")
    for name in ("deps", "deps-hash"):
        sub.add_parser(name).add_argument("--pyproject", type=Path, required=True)
    default = sub.add_parser("schema-default")
    default.add_argument("--schema", type=Path, required=True)
    default.add_argument("name")
    try:
        args = parser.parse_args(argv)
    except SystemExit:
        return EXIT_USAGE
    try:
        if args.command == "check":
            if args.component == "runtime":
                if not (args.vastai_version and args.venv_dir and args.pyproject):
                    return EXIT_USAGE
                code, reason = check_runtime(args.marker, vastai_version=args.vastai_version, venv_dir=args.venv_dir,
                                             pyproject=args.pyproject)
            else:
                if not (args.tailscale_version and args.tailscale_dir):
                    return EXIT_USAGE
                code, reason = check_tailscale(args.marker, tailscale_version=args.tailscale_version,
                                               tailscale_dir=args.tailscale_dir)
            print(reason)
            return code
        if args.command in ("deps", "deps-hash"):
            deps = agent_deps(args.pyproject.read_text())
            print("\n".join(deps) if args.command == "deps" else deps_hash(deps))
            return 0
        print(schema_default(args.schema.read_text(), args.name))
        return 0
    except (OSError, UnicodeDecodeError, MarkerError) as exc:
        print(f"image_marker: {exc}", file=sys.stderr)
        return EXIT_CORRUPT


if __name__ == "__main__":
    sys.exit(main())
