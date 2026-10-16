import pytest

from vastcomfy_agent.state import REASONS, InvalidTransition, State, StateStore

VALID = [
    (None, State.BOOTING), (None, State.FAILED),
    (State.BOOTING, State.DOWNLOADING), (State.BOOTING, State.FAILED), (State.BOOTING, State.STOPPING),
    (State.DOWNLOADING, State.READY), (State.DOWNLOADING, State.FAILED), (State.DOWNLOADING, State.STOPPING),
    (State.READY, State.IDLE_WARNING), (State.READY, State.STOPPING),
    (State.IDLE_WARNING, State.READY), (State.IDLE_WARNING, State.STOPPING),
    (State.FAILED, State.STOPPING),
    (State.STOPPING, State.DESTROY_FAILED),
    (State.DESTROY_FAILED, State.STOPPING),
]

INVALID = [
    (None, State.READY), (State.BOOTING, State.READY), (State.READY, State.FAILED),
    (State.READY, State.BOOTING), (State.STOPPING, State.READY), (State.FAILED, State.READY),
    (State.DESTROY_FAILED, State.READY), (State.IDLE_WARNING, State.FAILED),
]


def make(tmp_path, t=1000):
    return StateStore(tmp_path, lambda: t)


def force(store, state):
    # Walk the shortest legal path to reach `state`.
    paths = {
        None: [], State.BOOTING: [State.BOOTING], State.DOWNLOADING: [State.BOOTING, State.DOWNLOADING],
        State.READY: [State.BOOTING, State.DOWNLOADING, State.READY],
        State.IDLE_WARNING: [State.BOOTING, State.DOWNLOADING, State.READY, State.IDLE_WARNING],
        State.FAILED: [State.FAILED], State.STOPPING: [State.BOOTING, State.STOPPING],
        State.DESTROY_FAILED: [State.BOOTING, State.STOPPING, State.DESTROY_FAILED],
    }
    for step in paths[state]:
        store.set(step)


@pytest.mark.parametrize("src,dst", VALID)
def test_valid_transitions(tmp_path, src, dst):
    store = make(tmp_path)
    force(store, src)
    assert store.set(dst).state == dst


@pytest.mark.parametrize("src,dst", INVALID)
def test_invalid_transitions(tmp_path, src, dst):
    store = make(tmp_path)
    force(store, src)
    with pytest.raises(InvalidTransition):
        store.set(dst)
    assert store.get().state == src


def test_same_state_is_idempotent_and_keeps_original_reason(tmp_path):
    store = make(tmp_path)
    store.set(State.BOOTING)
    store.set(State.STOPPING, "manual")
    again = store.set(State.STOPPING, "watchdog")
    assert again.reason == "manual"


def test_reason_must_be_known(tmp_path):
    store = make(tmp_path)
    with pytest.raises(ValueError):
        store.set(State.FAILED, "because")
    assert "missing_container_credentials" in REASONS and "failsafe_failed" in REASONS


def test_state_persists_across_instances_and_records_time(tmp_path):
    make(tmp_path, 1234).set(State.FAILED, "hard_cap_missing")
    record = make(tmp_path, 9999).get()
    assert (record.state, record.reason, record.updated_at) == (State.FAILED, "hard_cap_missing", 1234)


def test_missing_or_unknown_state_file_reads_as_none(tmp_path):
    assert make(tmp_path).get().state is None
    (tmp_path / "state.json").write_text('{"state": "weird", "reason": null, "updated_at": 1}')
    assert make(tmp_path).get().state is None
