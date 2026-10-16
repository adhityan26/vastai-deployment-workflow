import pytest

from vastcomfy_agent.deadlines import DeadlineStore, ExtendError

T0 = 1_000_000


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def make(tmp_path, clock=None):
    return DeadlineStore(tmp_path, clock or Clock())


def test_first_boot_writes_all_files(tmp_path):
    store = make(tmp_path)
    assert store.init_first_boot(failsafe_hours=3, hard_cap_hours=6) == "fresh"
    assert store.first_boot_at() == T0
    assert store.deadline() == T0 + 3 * 3600
    assert store.hard_cap() == T0 + 6 * 3600


def test_deadline_never_exceeds_hard_cap_at_creation(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(failsafe_hours=9, hard_cap_hours=6)
    assert store.deadline() == store.hard_cap()


def test_restart_does_not_rewrite_files_even_when_deadline_passed(tmp_path):
    # Review focus 3: restart after the deadline already passed.
    clock = Clock()
    make(tmp_path, clock).init_first_boot(3, 6)
    clock.t = T0 + 10 * 3600
    again = make(tmp_path, clock)
    assert again.init_first_boot(3, 6) == "restart"
    assert again.deadline() == T0 + 3 * 3600
    assert again.hard_cap() == T0 + 6 * 3600


def test_missing_hard_cap_after_first_boot_is_reported_not_recomputed(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    (tmp_path / "hard_cap").unlink()
    assert store.init_first_boot(3, 6) == "hard_cap_missing"
    assert store.hard_cap() is None


def test_crash_before_first_boot_marker_is_treated_as_fresh(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    (tmp_path / "first_boot_at").unlink()
    assert store.init_first_boot(3, 6) == "fresh"


def test_extend_failsafe_moves_deadline(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    new = store.extend_failsafe(60, max_per_call=180)
    assert new == T0 + 4 * 3600
    assert store.deadline() == new


def test_extend_failsafe_beyond_hard_cap_is_rejected_with_the_remaining_minutes(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    with pytest.raises(ExtendError) as err:
        store.extend_failsafe(181, max_per_call=999)
    assert err.value.code == "beyond_hard_cap"
    assert "180" in err.value.message
    assert store.deadline() == T0 + 3 * 3600


@pytest.mark.parametrize("bad", [0, -5, 10**9, "10", 1.5, True, None])
def test_extend_rejects_hostile_minutes_and_changes_nothing(tmp_path, bad):
    # Review focus 1.
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    store.set_idle_destroy_at(T0 + 1800)
    with pytest.raises(ExtendError):
        store.extend_failsafe(bad, max_per_call=180)
    with pytest.raises(ExtendError):
        store.extend_idle(bad, max_per_call=120)
    assert store.deadline() == T0 + 3 * 3600
    assert store.idle_destroy_at() == T0 + 1800


def test_extend_idle_moves_idle_destroy_at_and_respects_hard_cap(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    store.set_idle_destroy_at(T0 + 1800)
    assert store.extend_idle(30, max_per_call=120) == T0 + 3600
    store.set_idle_destroy_at(T0 + 6 * 3600 - 60)
    with pytest.raises(ExtendError) as err:
        store.extend_idle(5, max_per_call=120)
    assert err.value.code == "beyond_hard_cap"


def test_extend_idle_before_the_idle_timer_started_is_rejected(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    with pytest.raises(ExtendError) as err:
        store.extend_idle(10, max_per_call=120)
    assert err.value.code == "not_ready"


def test_extend_without_hard_cap_is_rejected(tmp_path):
    store = make(tmp_path)
    with pytest.raises(ExtendError) as err:
        store.extend_failsafe(10, max_per_call=180)
    assert err.value.code == "hard_cap_missing"
