from __future__ import annotations

import threading
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable

from .files import read_json, write_json
from .paths import StatePaths


class State(str, Enum):
    BOOTING = "booting"
    DOWNLOADING = "downloading"
    READY = "ready"
    IDLE_WARNING = "idle-warning"
    STOPPING = "stopping"
    FAILED = "failed"
    DESTROY_FAILED = "destroy_failed"


REASONS = frozenset(
    {
        "missing_container_credentials", "config_invalid", "hard_cap_missing", "failsafe_failed",
        "tailscale_failed", "node_install_failed", "download_failed", "disk_insufficient",
        "comfyui_start_failed", "idle_timeout", "failsafe_deadline", "manual", "watchdog",
        "agent_start_failed", "supervisor_failed", "boot_failed", "node_import_failed",
    }
)

TRANSITIONS: dict[State | None, frozenset[State]] = {
    None: frozenset({State.BOOTING, State.FAILED}),
    State.BOOTING: frozenset({State.DOWNLOADING, State.FAILED, State.STOPPING}),
    State.DOWNLOADING: frozenset({State.READY, State.FAILED, State.STOPPING}),
    State.READY: frozenset({State.IDLE_WARNING, State.STOPPING}),
    State.IDLE_WARNING: frozenset({State.READY, State.STOPPING}),
    State.FAILED: frozenset({State.STOPPING}),
    State.STOPPING: frozenset({State.DESTROY_FAILED}),
    State.DESTROY_FAILED: frozenset({State.STOPPING}),
}


class InvalidTransition(Exception):
    pass


@dataclass(frozen=True)
class StateRecord:
    state: State | None
    reason: str | None
    updated_at: int | None


class StateStore:
    def __init__(self, state_dir: Path, now: Callable[[], int]):
        self._path = StatePaths(state_dir).state_json
        self._now = now
        self._lock = threading.Lock()

    def get(self) -> StateRecord:
        data = read_json(self._path)
        if not isinstance(data, dict):
            return StateRecord(None, None, None)
        try:
            state = State(data.get("state"))
        except ValueError:
            return StateRecord(None, None, None)
        return StateRecord(state, data.get("reason"), data.get("updated_at"))

    def reset_for_boot(self) -> StateRecord:
        """A container (re)start begins a new boot: force `booting` regardless of the previous state."""
        with self._lock:
            record = StateRecord(State.BOOTING, None, self._now())
            write_json(self._path, {"state": State.BOOTING.value, "reason": None, "updated_at": record.updated_at})
            return record

    def set(self, new: State, reason: str | None = None) -> StateRecord:
        if reason is not None and reason not in REASONS:
            raise ValueError(f"unknown reason {reason!r}")
        with self._lock:
            current = self.get()
            if current.state == new:
                return current
            if new not in TRANSITIONS.get(current.state, frozenset()):
                raise InvalidTransition(f"{current.state} -> {new}")
            record = StateRecord(new, reason, self._now())
            write_json(
                self._path,
                {"state": new.value, "reason": reason, "updated_at": record.updated_at},
            )
            return record
