from __future__ import annotations

import json
import re
from pathlib import Path

from .files import atomic_write

# ASCII only, no path separators, must end in .json (protocol rule, not configuration).
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,100}\.json$")


class WorkflowError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class WorkflowStore:
    def __init__(self, directory: Path, max_bytes: int):
        self._dir = Path(directory)
        self._max = max_bytes

    def _path(self, name: str) -> Path:
        if not NAME_RE.fullmatch(name):
            raise WorkflowError(400, "invalid workflow name")
        return self._dir / name

    def list(self) -> list[dict]:
        if not self._dir.is_dir():
            return []
        return [
            {"name": p.name, "modified_at": int(p.stat().st_mtime)}
            for p in sorted(self._dir.iterdir())
            if p.is_file() and NAME_RE.fullmatch(p.name)
        ]

    def read(self, name: str):
        path = self._path(name)
        if not path.is_file():
            raise WorkflowError(404, "workflow not found")
        return json.loads(path.read_text())

    def write(self, name: str, body: bytes) -> int:
        path = self._path(name)
        if len(body) > self._max:
            raise WorkflowError(413, f"workflow larger than {self._max} bytes")
        try:
            json.loads(body.decode())
        except (ValueError, UnicodeDecodeError):
            raise WorkflowError(422, "workflow is not valid JSON") from None
        atomic_write(path, body.decode())
        return len(body)
