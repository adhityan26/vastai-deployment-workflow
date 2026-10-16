from __future__ import annotations

import logging
import threading
from typing import Callable

from .destroyer import Destroyer
from .state import InvalidTransition, State, StateStore

log = logging.getLogger(__name__)


class DestroyFlow:
    """stopping -> destroy (retries) -> destroy_failed (+ stop ComfyUI). Safe to call repeatedly."""

    def __init__(self, states: StateStore, destroyer: Destroyer, stop_comfy: Callable[[], None]):
        self._states = states
        self._destroyer = destroyer
        self._stop_comfy = stop_comfy
        self._lock = threading.Lock()
        self._running = False

    def _record(self, state: State, reason: str | None = None) -> None:
        """A failing state write must never prevent the destroy attempt."""
        try:
            self._states.set(state, reason)
        except InvalidTransition:
            pass
        except Exception as exc:
            log.error("could not record state %s: %s", state.value, type(exc).__name__)

    def run(self, reason: str) -> bool:
        with self._lock:
            if self._running:
                return True
            self._running = True
        try:
            self._record(State.STOPPING, reason)
            if self._destroyer.destroy():
                return True
            self._record(State.DESTROY_FAILED)
            try:
                self._stop_comfy()
            except Exception:
                pass
            return False
        finally:
            with self._lock:
                self._running = False
