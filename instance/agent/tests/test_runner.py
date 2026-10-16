import threading

from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.files import write_json
from vastcomfy_agent.idle import IdleWatcher
from vastcomfy_agent.runner import Runner
from vastcomfy_agent.state import State, StateStore

T0 = 4_000_000


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
    runner = Runner(states=states, idle=idle, comfy=FakeComfy(counts), flow=flow, state_dir=tmp_path)
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
