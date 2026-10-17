from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Callable, Sequence

from .files import write_json
from .paths import StatePaths


class Destroyer:
    """Destroys this instance through the vastai CLI with retries (spec 5.4, 10).

    The CLI form and its behaviour come from spikes S1/S4: the new CLI needs `-y` (without a TTY it prints
    "Aborted." and destroys nothing) while the stock CLI in the image does not know `-y` (`assume_yes=False`),
    the exit status is always 0, and the stock CLI prints a deprecation preamble before its result, so success
    is decided per output line: see `_is_success_text`.
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
        ok_markers: Sequence[str],
        state_dir: Path,
        assume_yes: bool = True,
        run: Callable = subprocess.run,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._bin = vastai_bin
        self._id = container_id
        self._key = api_key
        self._retries = retries
        self._backoff = backoff_s
        self._timeout = timeout_s
        self._ok = [m.strip().lower() for m in ok_markers if m.strip()]
        self._gone = [m.strip().lower() for m in gone_markers if m.strip()]
        self._record_path = StatePaths(state_dir).destroy_agent
        self._assume_yes = assume_yes
        self._run = run
        self._sleep = sleep

    def _command(self) -> list[str]:
        yes = ["-y"] if self._assume_yes else []
        return [self._bin, "destroy", "instance", self._id, *yes, "--api-key", self._key]

    def _is_success_text(self, lowered: str) -> bool:
        """Per-line rule on the id/key-stripped, lowercased text (blank lines ignored):
        (a) a line with "failed with error" that matches no gone marker -> failure, even if another line is OK;
        (b) a gone marker anywhere -> success;
        (c) otherwise success only if some line STARTS with an OK marker (tolerates the stock CLI's leading
            WARNING lines); anything else is a failure."""
        lines = [line.strip() for line in lowered.splitlines() if line.strip()]
        for line in lines:
            if "failed with error" in line and not any(m in line for m in self._gone):
                return False
        if any(m in line for line in lines for m in self._gone):
            return True
        return any(line.startswith(m) for line in lines for m in self._ok)

    def _redact(self, text: str) -> str:
        return text.replace(self._key, "***") if self._key else text

    def attempt(self) -> tuple[bool, str | None]:
        try:
            proc = self._run(self._command(), capture_output=True, text=True, timeout=self._timeout)
        except FileNotFoundError:
            return False, "vastai binary not found"
        except subprocess.TimeoutExpired:
            return False, "vastai call timed out"
        except OSError as exc:  # PermissionError, exec format error, ...: a failed attempt, never a crash
            return False, self._redact(f"vastai could not run: {type(exc).__name__}: {exc}")[:500]
        output = ((proc.stdout or "") + (proc.stderr or "")).strip()
        # 124 = killed by a timeout, 126/127 = could not execute: never a success, whatever was printed.
        if proc.returncode not in (124, 126, 127):
            # Strip the id and key first so a bare marker such as "404" cannot match them.
            scrubbed = output
            for value in (self._id, self._key):
                if value:
                    scrubbed = scrubbed.replace(value, "")
            # The exit status carries no information (the CLI always exits 0): only the text decides.
            if self._is_success_text(scrubbed.lower()):
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
