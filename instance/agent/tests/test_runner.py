import threading

from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.files import write_json
from vastcomfy_agent.idle import IdleWatcher
from vastcomfy_agent.runner import Runner
from vastcomfy_agent.state import State, StateStore

T0 = 4_000_000
RETRY_S = 300


class Clock:
    t = T0

    def __call__(self):
        return self.t


class FakeComfy:
    def __init__(self, counts=(0, 0)):
        self.counts = counts

    def queue_counts(self):
        return self.counts


class FakeFlow:
    def __init__(self):
        self.reasons = []

    def run(self, reason):
        self.reasons.append(reason)
        return True


def make(tmp_path, counts=(0, 0), ready=True):
    clock = Clock()
    states = StateStore(tmp_path, clock)
    states.set(State.BOOTING)
    if ready:
        states.set(State.DOWNLOADING)
        states.set(State.READY)
    deadlines = DeadlineStore(tmp_path, clock)
    deadlines.init_first_boot(3, 6)
    idle = IdleWatcher(states, deadlines, clock, 30, 10)
    idle.start()
    flow = FakeFlow()
    runner = Runner(states=states, idle=idle, comfy=FakeComfy(counts), flow=flow, state_dir=tmp_path,
                    now=clock, destroy_failed_retry_s=RETRY_S)
    return clock, states, flow, runner


def test_idle_timeout_triggers_the_destroy_flow(tmp_path):
    clock, states, flow, runner = make(tmp_path)
    runner.tick()
    assert flow.reasons == []
    clock.t = T0 + 31 * 60
    runner.tick()
    assert flow.reasons == ["idle_timeout"]


def test_busy_queue_keeps_the_instance_alive(tmp_path):
    clock, states, flow, runner = make(tmp_path, counts=(1, 0))
    clock.t = T0 + 60 * 60
    runner.tick()
    assert flow.reasons == []


def test_unreachable_comfy_is_counted_as_idle_and_does_not_crash(tmp_path):
    clock, states, flow, runner = make(tmp_path, counts=None)
    clock.t = T0 + 31 * 60
    runner.tick()
    assert flow.reasons == ["idle_timeout"]


def test_failsafe_marker_moves_the_state_to_stopping_without_a_second_destroy(tmp_path):
    clock, states, flow, runner = make(tmp_path)
    write_json(tmp_path / "destroy_failsafe.json", {"pending": True, "attempts": 1, "last_error": "x"})
    runner.tick()
    record = states.get()
    assert (record.state, record.reason) == (State.STOPPING, "failsafe_deadline")
    assert flow.reasons == []


def test_failsafe_marker_carries_the_hard_cap_reason(tmp_path):
    clock, states, flow, runner = make(tmp_path)
    write_json(tmp_path / "destroy_failsafe.json", {"pending": True, "attempts": 1, "last_error": None, "reason": "hard_cap"})
    runner.tick()
    record = states.get()
    assert (record.state, record.reason) == (State.STOPPING, "hard_cap")


def test_failsafe_marker_with_an_unknown_reason_is_failsafe_deadline(tmp_path):
    clock, states, flow, runner = make(tmp_path)
    write_json(tmp_path / "destroy_failsafe.json", {"pending": True, "attempts": 1, "last_error": None, "reason": "manual"})
    runner.tick()
    assert states.get().reason == "failsafe_deadline"


def test_boot_states_are_left_alone(tmp_path):
    clock, states, flow, runner = make(tmp_path, ready=False)
    clock.t = T0 + 10**6
    runner.tick()
    assert flow.reasons == [] and states.get().state == State.BOOTING


def test_run_forever_survives_exceptions_and_stops_on_event(tmp_path):
    clock, states, flow, runner = make(tmp_path)
    stop = threading.Event()
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")
        stop.set()

    runner.tick = flaky
    runner.run_forever(stop, interval_s=0)
    assert len(calls) == 2


def destroy_failed(tmp_path, reason=None):
    clock, states, flow, runner = make(tmp_path, ready=False)
    states.set(State.STOPPING, "manual")
    states.set(State.DESTROY_FAILED)
    if reason is not None:
        write_json(tmp_path / "state.json", {"state": "destroy_failed", "reason": reason, "updated_at": T0})
    return clock, states, flow, runner


def test_destroy_failed_is_not_retried_before_the_interval(tmp_path):
    clock, _, flow, runner = destroy_failed(tmp_path)
    runner.tick()
    clock.t = T0 + RETRY_S - 1
    runner.tick()
    assert flow.reasons == []


def test_destroy_failed_is_retried_after_the_interval_and_then_waits_again(tmp_path):
    clock, _, flow, runner = destroy_failed(tmp_path)
    runner.tick()
    clock.t = T0 + RETRY_S
    runner.tick()
    assert flow.reasons == ["manual"]
    clock.t = T0 + 2 * RETRY_S - 1
    runner.tick()
    assert flow.reasons == ["manual"]
    clock.t = T0 + 2 * RETRY_S
    runner.tick()
    assert flow.reasons == ["manual", "manual"]


def test_destroy_failed_retry_uses_the_stored_reason(tmp_path):
    clock, _, flow, runner = destroy_failed(tmp_path, reason="watchdog")
    runner.tick()
    clock.t = T0 + RETRY_S
    runner.tick()
    assert flow.reasons == ["watchdog"]


def test_other_states_are_never_retried(tmp_path):
    for name, steps in (("booting", []), ("failed", [State.FAILED]), ("stopping", [State.STOPPING])):
        path = tmp_path / name
        path.mkdir()
        clock, states, flow, runner = make(path, ready=False)
        for step in steps:
            states.set(step, "manual" if step == State.STOPPING else "boot_failed")
        for offset in (0, RETRY_S, 10 * RETRY_S):
            clock.t = T0 + offset
            runner.tick()
        assert flow.reasons == [], name
