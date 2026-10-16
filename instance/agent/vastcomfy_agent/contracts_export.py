from __future__ import annotations

import argparse
import json
from pathlib import Path

from .app import Deps, create_app
from .models import Status


def _dump(value) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def build_contracts() -> dict[str, str]:
    """Contracts generated from the code, so they cannot drift (the registry schema is hand-written)."""
    app = create_app(Deps(cfg=None, states=None, deadlines=None, status=None, flow=None, workflows=None))
    return {
        "agent.openapi.json": _dump(app.openapi()),
        "status.schema.json": _dump(Status.model_json_schema()),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vastcomfy_agent.contracts_export")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    for name, text in build_contracts().items():
        (args.out / name).write_text(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
