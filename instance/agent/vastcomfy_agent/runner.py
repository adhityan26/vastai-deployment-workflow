from __future__ import annotations

import logging
import threading
from pathlib import Path

from .destroy_flow import DestroyFlow
from .files import read_json
from .idle import IdleWatcher
from .paths import StatePaths
from .state import InvalidTransition, State, StateStore

log = logging.getLogger(__name__)


class Runner:
    """Periodic work of the agent: mirror the failsafe's destroy, advance idle, destroy on idle timeout."""

    def __init__(self, *, states: StateStore, idle: IdleWatcher, comfy, flow: DestroyFlow, state_dir: Path):
        self._states = states
        self._idle = idle
        self._comfy = comfy
        self._flow = flow
        self._paths = StatePaths(state_dir)

    def _failsafe_destroying(self) -> bool:
        record = read_json(self._paths.destroy_failsafe, {}) or {}
        return bool(record.get("pending"))

    def tick(self) -> None:
        if self._failsafe_destroying():
            try:
                self._states.set(State.STOPPING, "failsafe_deadline")
            except InvalidTransition:
                pass
            return
        if self._states.get().state not in (State.READY, State.IDLE_WARNING):
            return
        counts = self._comfy.queue_counts()
        total = None if counts is None else counts[0] + counts[1]
        if self._idle.tick(total) == "destroy":
            self._flow.run("idle_timeout")

    def run_forever(self, stop: threading.Event, interval_s: float) -> None:
        while not stop.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("runner tick failed")
            stop.wait(interval_s)
