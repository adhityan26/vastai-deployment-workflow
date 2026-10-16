from __future__ import annotations

import time


def utc_now() -> int:
    """Current time as epoch UTC seconds (the only time format used in state files)."""
    return int(time.time())
