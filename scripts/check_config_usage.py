#!/usr/bin/env python3
"""No-hardcode lint (spec 14.7): environment reads outside the config modules, and literal
IPs, URLs, ports and absolute system paths in code. A line with `config-lint: ok` is exempt."""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

MARKER = "config-lint: ok"
ENV_MODULES = {"config.py", "boot.py", "config.ts", "config.js", "config.mjs"}
SKIP_DIRS = {"tests", ".venv", "node_modules", "dist", "__pycache__", ".git"}
COMMENT_PREFIX = {".py": "#", ".sh": "#", ".conf": ";", ".ts": "//", ".js": "//", ".mjs": "//"}

IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
URL = re.compile(r"https?://")
PORT = re.compile(r"(?:\bport\s*[=:]\s*\d{2,5}\b)|(?:(?<=[A-Za-z0-9.\]]):\d{4,5}\b)", re.IGNORECASE)
SYSTEM_DIRS = r"(?:etc|var|opt|usr|workspace|tmp|home|root|srv|mnt|run)"
ABS_QUOTED = re.compile(rf"""["'`]/{SYSTEM_DIRS}(?:/|\b)""")
ABS_BARE = re.compile(rf"""(?<![\w$%){{}}"'])/{SYSTEM_DIRS}/""")
ENV_READ = re.compile(r"os\.environ|os\.getenv|process\.env")


def scan_text(name: str, suffix: str, text: str) -> list[tuple[int, str, str]]:
    comment = COMMENT_PREFIX[suffix]
    shell_like = suffix in {".sh", ".conf"}
    findings: list[tuple[int, str, str]] = []
    in_docstring = False
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if suffix == ".py":
            if stripped.startswith('"""') and stripped.endswith('"""') and len(stripped) > 3:
                continue
            if stripped.count('"""') % 2 == 1:
                in_docstring = not in_docstring
                continue
            if in_docstring:
                continue
        if not stripped or stripped.startswith(comment) or MARKER in line:
            continue
        if not shell_like and name not in ENV_MODULES and ENV_READ.search(line):
            findings.append((number, "env-read", stripped))
        if URL.search(line):
            findings.append((number, "url", stripped))
        if IPV4.search(line):
            findings.append((number, "ipv4", stripped))
        if PORT.search(line):
            findings.append((number, "port", stripped))
        if (ABS_BARE.search(line) if shell_like else ABS_QUOTED.search(line)) or (shell_like and ABS_QUOTED.search(line)):
            findings.append((number, "abs-path", stripped))
    return findings


def _files(path: Path):
    """Yield lintable files under `path`; skip directories are judged relative to `path`."""
    if path.is_file():
        yield path
        return
    for item in sorted(path.rglob("*")):
        if item.is_file() and item.suffix in COMMENT_PREFIX and not (set(item.relative_to(path).parts) & SKIP_DIRS):
            yield item


def scan_paths(paths: list[Path]) -> list[tuple[Path, int, str, str]]:
    found = []
    for path in paths:
        for file in _files(Path(path)):
            for number, rule, text in scan_text(file.name, file.suffix, file.read_text()):
                found.append((file, number, rule, text))
    return found


def _staged() -> list[Path]:
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"], capture_output=True, text=True, check=True
    ).stdout
    return [
        Path(line)
        for line in out.splitlines()
        if Path(line).suffix in COMMENT_PREFIX and not (set(Path(line).parts) & SKIP_DIRS)
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--staged", action="store_true", help="lint only staged files")
    args = parser.parse_args(argv)
    targets = _staged() if args.staged else (args.paths or [Path("instance"), Path("apps")])
    findings = scan_paths([t for t in targets if t.exists()])
    for path, number, rule, text in findings:
        print(f"{path}:{number}: [{rule}] {text}", file=sys.stderr)
    if findings:
        print(f"{len(findings)} hardcoded-config finding(s); move them to contracts/config-schema.yaml "
              f"or mark the line with '{MARKER}'", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
