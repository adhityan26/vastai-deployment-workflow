from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write(path: Path, data: str) -> None:
    """Write via a temp file in the same directory, then rename (readers never see a partial file)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def read_int(path: Path) -> int | None:
    try:
        return int(Path(path).read_text().strip())
    except (OSError, ValueError):  # missing, unreadable, undecodable (UnicodeDecodeError) or not an int
        return None


def write_int(path: Path, value: int) -> None:
    atomic_write(path, f"{value}\n")


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):  # missing, unreadable, undecodable or invalid JSON (JSONDecodeError)
        return default


def write_json(path: Path, value: Any) -> None:
    atomic_write(path, json.dumps(value, sort_keys=True) + "\n")
