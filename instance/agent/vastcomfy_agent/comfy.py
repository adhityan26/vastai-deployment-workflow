from __future__ import annotations

import subprocess
from typing import Callable
from urllib.parse import quote

import httpx


class ComfyUnavailable(Exception):
    """ComfyUI could not be asked (unreachable, HTTP error or a non-JSON answer)."""


class ComfyClient:
    def __init__(self, base_url: str, client: httpx.Client):
        self._base = base_url.rstrip("/")
        self._client = client

    def queue_counts(self) -> tuple[int, int] | None:
        """(running, pending), or None when ComfyUI is unreachable or answers nonsense."""
        try:
            response = self._client.get(f"{self._base}/queue")
            response.raise_for_status()
            data = response.json()
            return len(data["queue_running"]), len(data["queue_pending"])
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            return None

    def node_class_registered(self, name: str) -> bool:
        """True when ComfyUI registered the node class: GET /object_info/<name> answers with that key
        (ComfyUI answers {} for an unknown class, e.g. one whose module failed to import)."""
        try:
            response = self._client.get(f"{self._base}/object_info/{quote(name, safe='')}")
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ComfyUnavailable(f"object_info/{name}: {type(exc).__name__}: {exc}") from None
        return isinstance(data, dict) and name in data

    def unlisted_files(self, classes: tuple[str, ...], names: tuple[str, ...]) -> list[str]:
        """The file names no input of these node classes offers (GET /object_info/<class> lists a loader's files).
        Raises ComfyUnavailable when ComfyUI cannot be asked."""
        seen: set[str] = set()

        def walk(value) -> None:
            if isinstance(value, str):
                seen.add(value)
            elif isinstance(value, list):
                for item in value:
                    walk(item)
            elif isinstance(value, dict):
                for item in value.values():
                    walk(item)

        for name in classes:
            try:
                response = self._client.get(f"{self._base}/object_info/{quote(name, safe='')}")
                response.raise_for_status()
                walk(response.json())
            except (httpx.HTTPError, ValueError) as exc:
                raise ComfyUnavailable(f"object_info/{name}: {type(exc).__name__}") from None
        return [n for n in names if n not in seen]

    def ready(self) -> bool:
        try:
            return self._client.get(f"{self._base}/system_stats").status_code == 200
        except httpx.HTTPError:
            return False


def read_gpu(run: Callable, nvidia_smi_bin: str, timeout_s: int) -> dict | None:
    cmd = [nvidia_smi_bin, "--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]
    try:
        proc = run(cmd, capture_output=True, text=True, timeout=timeout_s)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    lines = (proc.stdout or "").strip().splitlines()
    if not lines:
        return None
    try:
        util, used, total = (int(part.strip()) for part in lines[0].split(","))
    except ValueError:
        return None
    return {"util_percent": util, "vram_used_mb": used, "vram_total_mb": total}
