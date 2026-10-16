from __future__ import annotations

from typing import Callable

from .deadlines import DeadlineStore
from .state import State, StateStore


class IdleWatcher:
    """Advances the idle timer and the ready <-> idle-warning states. The caller acts on 'destroy'."""

    def __init__(
        self,
        states: StateStore,
        deadlines: DeadlineStore,
        now: Callable[[], int],
        idle_minutes: int,
        warn_minutes: int,
    ):
        self._states = states
        self._deadlines = deadlines
        self._now = now
        self._idle = idle_minutes
        self._warn = warn_minutes

    def start(self) -> None:
        self._deadlines.set_idle_destroy_at(self._now() + self._idle * 60)

    def tick(self, queue_total: int | None) -> str:
        record = self._states.get()
        if record.state not in (State.READY, State.IDLE_WARNING):
            return "none"
        now = self._now()
        if queue_total is not None and queue_total > 0:
            self._deadlines.set_idle_destroy_at(now + self._idle * 60)
            if record.state == State.IDLE_WARNING:
                self._states.set(State.READY)
            return "none"
        destroy_at = self._deadlines.idle_destroy_at()
        if destroy_at is None:
            self.start()
            return "none"
        if now >= destroy_at:
            return "destroy"
        if now >= destroy_at - self._warn * 60:
            if record.state == State.READY:
                self._states.set(State.IDLE_WARNING)
                return "warn"
            return "none"
        if record.state == State.IDLE_WARNING:  # extended while warning
            self._states.set(State.READY)
        return "none"
