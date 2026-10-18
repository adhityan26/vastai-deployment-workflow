from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

# instance/agent/vastcomfy_agent/config.py -> repository root is parents[3]
SCHEMA_PATH = Path(__file__).resolve().parents[3] / "contracts" / "config-schema.yaml"

_TYPES = {"str", "int", "bool", "csv"}
_INT_TEXT = re.compile(r"[0-9]+")  # ASCII digits only: no sign, underscore, spaces or other scripts


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class KeySpec:
    name: str
    components: tuple[str, ...]
    type: str
    secret: bool
    required: bool
    default: Any
    description: str
    min: int | None = None
    max: int | None = None
    choices: tuple[str, ...] | None = None


def _choices(item: dict) -> tuple[str, ...] | None:
    """The closed list of values a str key may take (`choices:` in the schema), or None."""
    value = item.get("choices")
    if value is None:
        return None
    if item["type"] != "str":
        raise ConfigError(f"{item['name']}: choices are only allowed on str keys")
    if not isinstance(value, list) or not value or not all(isinstance(c, str) and c for c in value):
        raise ConfigError(f"{item['name']}: choices must be a non-empty list of non-empty strings")
    if len(set(value)) != len(value):
        raise ConfigError(f"{item['name']}: choices must be distinct")
    default = item.get("default")
    if default not in (None, "") and default not in value:
        raise ConfigError(f"{item['name']}: the default is not one of the choices")
    return tuple(value)


def _bound(item: dict, which: str) -> int | None:
    value = item.get(which)
    if value is None:
        return None
    if item["type"] != "int":
        raise ConfigError(f"{item['name']}: {which} is only allowed on int keys")
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{item['name']}: {which} must be an integer")
    return value


def load_schema(path: Path | None = None) -> list[KeySpec]:
    path = path or SCHEMA_PATH
    try:
        raw = yaml.safe_load(path.read_text())
    except FileNotFoundError:
        raise ConfigError(f"config schema not found at {path}") from None
    specs: list[KeySpec] = []
    for item in raw["keys"]:
        if item["type"] not in _TYPES:
            raise ConfigError(f"{item['name']}: unknown type {item['type']!r}")
        low, high = _bound(item, "min"), _bound(item, "max")
        if low is not None and high is not None and low > high:
            raise ConfigError(f"{item['name']}: min {low} is greater than max {high}")
        specs.append(
            KeySpec(
                name=item["name"],
                components=tuple(item["components"]),
                type=item["type"],
                secret=bool(item["secret"]),
                required=bool(item["required"]),
                default=item.get("default"),
                description=item["description"],
                min=low,
                max=high,
                choices=_choices(item),
            )
        )
    names = [s.name for s in specs]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        raise ConfigError(f"duplicate keys in schema: {', '.join(dupes)}")
    return specs


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines. No quoting, no expansion; the value is everything after the first '='."""
    values: dict[str, str] = {}
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise ConfigError(f"{path}:{lineno}: expected KEY=VALUE")
        key, _, value = line.lstrip().partition("=")
        values[key.strip()] = value
    return values


def default_text(spec: KeySpec) -> str:
    default = spec.default
    if default is None:
        return ""
    if isinstance(default, bool):
        return "true" if default else "false"
    if isinstance(default, (list, tuple)):
        return ",".join(str(x) for x in default)
    return str(default)


def _coerce(spec: KeySpec, text: str) -> Any:
    if spec.type == "str":
        if spec.choices is not None and text not in spec.choices:
            raise ConfigError(f"{spec.name}: must be one of {', '.join(spec.choices)}")
        return text
    if spec.type == "int":
        if not _INT_TEXT.fullmatch(text):
            raise ConfigError(f"{spec.name}: expected an integer (digits only)")
        value = int(text)
        if spec.min is not None and value < spec.min:
            raise ConfigError(f"{spec.name}: {value} is below the minimum {spec.min}")
        if spec.max is not None and value > spec.max:
            raise ConfigError(f"{spec.name}: {value} is above the maximum {spec.max}")
        return value
    if spec.type == "bool":
        if text in ("true", "false"):
            return text == "true"
        raise ConfigError(f"{spec.name}: expected true or false")
    return [part.strip() for part in text.split(",") if part.strip()]


class Config:
    """Typed, read-only view of one component's configuration."""

    def __init__(self, values: dict[str, Any], specs: dict[str, KeySpec]):
        self._values = values
        self._specs = specs

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            return self._values[name.upper()]
        except KeyError:
            raise AttributeError(name) from None

    def get(self, key: str) -> Any:
        return self._values[key]

    def redacted(self) -> dict[str, Any]:
        return {
            key: ("***" if self._specs[key].secret and value not in ("", None) else value)
            for key, value in self._values.items()
        }

    def __repr__(self) -> str:
        return f"Config({self.redacted()!r})"


def load_config(env_file: Path, component: str, schema_path: Path | None = None) -> Config:
    specs = [s for s in load_schema(schema_path) if component in s.components]
    by_name = {s.name: s for s in specs}
    raw = parse_env_file(env_file)

    unknown = sorted(set(raw) - set(by_name))
    if unknown:
        raise ConfigError(f"unknown keys for component {component!r}: {', '.join(unknown)}")

    values: dict[str, Any] = {}
    missing: list[str] = []
    for spec in specs:
        text = raw.get(spec.name, "")
        if text == "":
            if spec.required:
                missing.append(spec.name)
                continue
            text = default_text(spec)
        values[spec.name] = _coerce(spec, text)
    if missing:
        raise ConfigError(f"missing required keys for {component!r}: {', '.join(missing)}")
    return Config(values, by_name)


def _specs_for(component: str, schema_path: Path | None) -> list[KeySpec]:
    return [s for s in load_schema(schema_path) if component in s.components]


def cmd_list(component: str, schema_path: Path | None = None) -> int:
    for spec in _specs_for(component, schema_path):
        flags = ["secret" if spec.secret else "plain", "required" if spec.required else "optional"]
        default = "" if spec.secret else default_text(spec)
        bounds = " ".join(f"{which}={value}" for which, value in (("min", spec.min), ("max", spec.max)) if value is not None)
        print(f"{spec.name:28} {' '.join(flags):18} default={default!r:34} {bounds:14} {spec.description}")
    return 0


def cmd_init(component: str, out: Path, schema_path: Path | None = None) -> int:
    if out.exists():
        print(f"refusing to overwrite {out}", file=sys.stderr)
        return 1
    lines: list[str] = []
    for spec in _specs_for(component, schema_path):
        lines.append(f"# {spec.description}")
        if spec.required or spec.secret:
            lines.append(f"{spec.name}=")
        else:
            lines.append(f"#{spec.name}={default_text(spec)}")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n")
    out.chmod(0o600)
    return 0


def cmd_gen_keys(out: Path, schema_path: Path | None = None) -> int:
    names = sorted(s.name for s in _specs_for("instance", schema_path))
    out.write_text("\n".join(names) + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vastcomfy_agent.config")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "init"):
        p = sub.add_parser(name)
        p.add_argument("--component", default="instance", choices=["instance", "apps"])
        if name == "init":
            p.add_argument("--out", type=Path, required=True)
    gen = sub.add_parser("gen-keys")
    gen.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "list":
        return cmd_list(args.component)
    if args.command == "init":
        return cmd_init(args.component, args.out)
    return cmd_gen_keys(args.out)


if __name__ == "__main__":
    sys.exit(main())
