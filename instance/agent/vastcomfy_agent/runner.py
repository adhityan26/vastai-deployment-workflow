from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Callable

from .destroy_flow import DestroyFlow
from .files import read_json
from .idle import IdleWatcher
from .paths import StatePaths
from .state import REASONS, InvalidTransition, State, StateRecord, StateStore

log = logging.getLogger(__name__)

# What instance/failsafe.sh writes as "reason" in destroy_failsafe.json.
FAILSAFE_REASONS = frozenset({"failsafe_deadline", "hard_cap"})


class Runner:
    """Periodic work of the agent: mirror the failsafe's destroy, advance idle, destroy on idle timeout,
    and retry the destroy from destroy_failed at most every `destroy_failed_retry_s` seconds."""

    def __init__(self, *, states: StateStore, idle: IdleWatcher, comfy, flow: DestroyFlow, state_dir: Path,
                 now: Callable[[], int], destroy_failed_retry_s: int, busy: Callable[[], bool] = lambda: False):
        self._states = states
        self._idle = idle
        self._comfy = comfy
        self._flow = flow
        self._paths = StatePaths(state_dir)
        self._now = now
        self._retry_s = destroy_failed_retry_s
        self._last_retry: int | None = None  # in memory: start of the current wait in destroy_failed
        self._busy = busy  # other work that counts as activity (a background video model download)

    def _failsafe_destroying(self) -> str | None:
        """The failsafe's destroy reason while it is destroying (failsafe_deadline or hard_cap), else None."""
        record = read_json(self._paths.destroy_failsafe, {}) or {}
        if not isinstance(record, dict) or not record.get("pending"):
            return None
        reason = record.get("reason")
        return reason if reason in FAILSAFE_REASONS else "failsafe_deadline"

    def tick(self) -> None:
        failsafe_reason = self._failsafe_destroying()
        if failsafe_reason is not None:
            try:
                self._states.set(State.STOPPING, failsafe_reason)
            except InvalidTransition:
                pass
            return
        record = self._states.get()
        if record.state == State.DESTROY_FAILED:
            self._retry_destroy(record)
            return
        self._last_retry = None
        if record.state not in (State.READY, State.IDLE_WARNING):
            return
        counts = self._comfy.queue_counts()
        total = None if counts is None else counts[0] + counts[1]
        if self._busy():
            # A running download is activity like a queued job: the idle timer must not stop the instance under it.
            total = (total or 0) + 1
        if self._idle.tick(total) == "destroy":
            self._flow.run("idle_timeout")

    def _retry_destroy(self, record: StateRecord) -> None:
        now = self._now()
        if self._last_retry is None:  # first sighting: the failed attempt just ended, wait one interval
            self._last_retry = now
            return
        if now - self._last_retry < self._retry_s:
            return
        reason = record.reason if record.reason in REASONS else "manual"
        try:
            self._flow.run(reason)
        finally:
            self._last_retry = self._now()

    def run_forever(self, stop: threading.Event, interval_s: float) -> None:
        while not stop.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("runner tick failed")
            stop.wait(interval_s)
