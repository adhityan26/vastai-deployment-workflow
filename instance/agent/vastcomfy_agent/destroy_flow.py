from __future__ import annotations

import threading
from typing import Callable

from .destroyer import Destroyer
from .state import InvalidTransition, State, StateStore


class DestroyFlow:
    """stopping -> destroy (retries) -> destroy_failed (+ stop ComfyUI). Safe to call repeatedly."""

    def __init__(self, states: StateStore, destroyer: Destroyer, stop_comfy: Callable[[], None]):
        self._states = states
        self._destroyer = destroyer
        self._stop_comfy = stop_comfy
        self._lock = threading.Lock()
        self._running = False

    def run(self, reason: str) -> bool:
        with self._lock:
            if self._running:
                return True
            self._running = True
        try:
            try:
                self._states.set(State.STOPPING, reason)
            except InvalidTransition:
                pass
            if self._destroyer.destroy():
                return True
            try:
                self._states.set(State.DESTROY_FAILED)
            except InvalidTransition:
                pass
            try:
                self._stop_comfy()
            except Exception:
                pass
            return False
        finally:
            with self._lock:
                self._running = False
