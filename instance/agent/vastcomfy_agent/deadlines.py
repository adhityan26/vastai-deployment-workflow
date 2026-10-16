from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

from .files import read_int, write_int
from .paths import StatePaths


class ExtendError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _validate_minutes(minutes: object, max_per_call: int) -> int:
    if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes <= 0:
        raise ExtendError("invalid_minutes", "minutes must be a positive integer")
    if minutes > max_per_call:
        raise ExtendError("too_large", f"at most {max_per_call} minutes per call")
    return minutes


class DeadlineStore:
    def __init__(self, state_dir: Path, now: Callable[[], int]):
        self._p = StatePaths(state_dir)
        self._now = now
        self._lock = threading.Lock()

    def first_boot_at(self) -> int | None:
        return read_int(self._p.first_boot_at)

    def hard_cap(self) -> int | None:
        return read_int(self._p.hard_cap)

    def deadline(self) -> int | None:
        return read_int(self._p.deadline)

    def idle_destroy_at(self) -> int | None:
        return read_int(self._p.idle_destroy_at)

    def set_idle_destroy_at(self, value: int) -> None:
        write_int(self._p.idle_destroy_at, value)

    def push_idle_destroy_at(self, value: int) -> int:
        """Move the idle destroy time to `value` unless it is already later (never backwards)."""
        with self._lock:
            current = self.idle_destroy_at()
            if current is None or value > current:
                write_int(self._p.idle_destroy_at, value)
                return value
            return current

    def init_first_boot(self, failsafe_hours: int, hard_cap_hours: int) -> str:
        """Write the boot files once. Returns 'fresh', 'restart' or 'hard_cap_missing'."""
        with self._lock:
            if self.first_boot_at() is None:
                t = self._now()
                hard_cap = t + hard_cap_hours * 3600
                deadline = min(t + failsafe_hours * 3600, hard_cap)
                write_int(self._p.hard_cap, hard_cap)
                write_int(self._p.deadline, deadline)
                write_int(self._p.first_boot_at, t)  # written last: a crash before it means "still fresh"
                return "fresh"
            if self.hard_cap() is None:
                return "hard_cap_missing"
            return "restart"

    def _require_cap(self) -> int:
        cap = self.hard_cap()
        if cap is None:
            raise ExtendError("hard_cap_missing", "hard cap file is missing")
        return cap

    @staticmethod
    def _check_cap(cap: int, current: int, minutes: int) -> int:
        new = current + minutes * 60
        if new > cap:
            remaining = max(0, (cap - current) // 60)
            raise ExtendError("beyond_hard_cap", f"would pass the hard cap; at most {remaining} more minutes")
        return new

    def extend_failsafe(self, minutes: object, max_per_call: int) -> int:
        minutes = _validate_minutes(minutes, max_per_call)
        with self._lock:
            cap = self._require_cap()
            current = self.deadline()
            if current is None:
                current = cap
            new = self._check_cap(cap, current, minutes)
            write_int(self._p.deadline, new)
            return new

    def extend_idle(self, minutes: object, max_per_call: int) -> int:
        minutes = _validate_minutes(minutes, max_per_call)
        with self._lock:
            cap = self._require_cap()
            current = self.idle_destroy_at()
            if current is None:
                raise ExtendError("not_ready", "idle timer has not started")
            new = self._check_cap(cap, current, minutes)
            write_int(self._p.idle_destroy_at, new)
            return new
