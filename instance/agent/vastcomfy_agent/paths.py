from __future__ import annotations

from pathlib import Path

# File names are a protocol shared with failsafe.sh (spec 5.2).
_NAMES = {
    "state_json": "state.json",
    "progress_json": "progress.json",
    "first_boot_at": "first_boot_at",
    "hard_cap": "hard_cap",
    "deadline": "deadline",
    "idle_destroy_at": "idle_destroy_at",
    "failsafe_pid": "failsafe.pid",
    "destroy_failsafe": "destroy_failsafe.json",
    "destroy_agent": "destroy_agent.json",
}


class StatePaths:
    def __init__(self, root: Path):
        self.root = Path(root)

    def __getattr__(self, name: str) -> Path:
        if name in _NAMES:
            return self.root / _NAMES[name]
        raise AttributeError(name)
