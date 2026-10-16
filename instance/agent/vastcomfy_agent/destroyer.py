from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Callable, Sequence

from .files import write_json
from .paths import StatePaths


class Destroyer:
    """Destroys this instance through the vastai CLI with retries (spec 5.4, 10).

    The exact CLI form comes from spike S4; adjust `_command` if S4 found a safer way to pass the key.
    """

    def __init__(
        self,
        *,
        vastai_bin: str,
        container_id: str,
        api_key: str,
        retries: int,
        backoff_s: int,
        timeout_s: int,
        gone_markers: Sequence[str],
        state_dir: Path,
        run: Callable = subprocess.run,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._bin = vastai_bin
        self._id = container_id
        self._key = api_key
        self._retries = retries
        self._backoff = backoff_s
        self._timeout = timeout_s
        self._markers = [m.lower() for m in gone_markers]
        self._record_path = StatePaths(state_dir).destroy_agent
        self._run = run
        self._sleep = sleep

    def _command(self) -> list[str]:
        return [self._bin, "destroy", "instance", self._id, "--api-key", self._key]

    def _redact(self, text: str) -> str:
        return text.replace(self._key, "***") if self._key else text

    def attempt(self) -> tuple[bool, str | None]:
        try:
            proc = self._run(self._command(), capture_output=True, text=True, timeout=self._timeout)
        except FileNotFoundError:
            return False, "vastai binary not found"
        except subprocess.TimeoutExpired:
            return False, "vastai call timed out"
        output = ((proc.stdout or "") + (proc.stderr or "")).strip()
        if proc.returncode == 0:
            return True, None
        lowered = output.lower()
        if any(marker in lowered for marker in self._markers):
            return True, None
        return False, self._redact(output)[:500] or "vastai failed without output"

    def destroy(self) -> bool:
        error: str | None = None
        for attempt_no in range(1, self._retries + 1):
            ok, error = self.attempt()
            write_json(self._record_path, {"attempts": attempt_no, "last_error": error})
            if ok:
                return True
            if attempt_no < self._retries:
                self._sleep(self._backoff)
        return False
