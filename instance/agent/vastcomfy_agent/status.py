from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from pydantic import ValidationError

from .comfy import ComfyClient
from .deadlines import DeadlineStore
from .files import read_int, read_json
from .models import DestroyInfo, Gpu, Progress, QueueCounts, Status
from .paths import StatePaths
from .state import State, StateStore


def _pid_alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, OverflowError):
        return False
    except PermissionError:
        return True
    return True


class StatusBuilder:
    def __init__(
        self,
        *,
        state_dir: Path,
        states: StateStore,
        deadlines: DeadlineStore,
        comfy: ComfyClient,
        gpu_reader: Callable[[], dict | None],
        profile: str,
        commit: str,
        now: Callable[[], int],
    ):
        self._p = StatePaths(state_dir)
        self._states = states
        self._deadlines = deadlines
        self._comfy = comfy
        self._gpu_reader = gpu_reader
        self._profile = profile
        self._commit = commit
        self._now = now

    def _progress(self, state: State | None) -> Progress | None:
        if state != State.DOWNLOADING:
            return None
        data = read_json(self._p.progress_json)
        try:
            return Progress(**data) if isinstance(data, dict) else None
        except (ValidationError, TypeError):
            return None

    def _destroy_info(self) -> DestroyInfo:
        failsafe = read_json(self._p.destroy_failsafe, {}) or {}
        agent = read_json(self._p.destroy_agent, {}) or {}
        return DestroyInfo(
            pending=bool(failsafe.get("pending", False)),
            attempts=max(int(failsafe.get("attempts", 0) or 0), int(agent.get("attempts", 0) or 0)),
            last_error=agent.get("last_error") or failsafe.get("last_error"),
        )

    def build(self) -> Status:
        record = self._states.get()
        now = self._now()
        boot_at = self._deadlines.first_boot_at()
        counts = self._comfy.queue_counts()
        gpu = self._gpu_reader() or {}
        return Status(
            state=record.state,
            reason=record.reason,
            progress=self._progress(record.state),
            now=now,
            boot_at=boot_at,
            uptime_s=None if boot_at is None else now - boot_at,
            idle_destroy_at=self._deadlines.idle_destroy_at(),
            failsafe_at=self._deadlines.deadline(),
            hard_cap_at=self._deadlines.hard_cap(),
            queue=None if counts is None else QueueCounts(running=counts[0], pending=counts[1]),
            gpu=Gpu(**gpu),
            profile=self._profile,
            commit=self._commit,
            failsafe_alive=_pid_alive(read_int(self._p.failsafe_pid)),
            destroy=self._destroy_info(),
        )
