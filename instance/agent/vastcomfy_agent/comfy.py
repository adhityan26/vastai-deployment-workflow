from __future__ import annotations

import subprocess
from typing import Callable

import httpx


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
