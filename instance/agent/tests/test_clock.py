import time

from vastcomfy_agent.clock import utc_now


def test_utc_now_is_integer_epoch_seconds():
    value = utc_now()
    assert isinstance(value, int)
    assert abs(value - int(time.time())) <= 1
