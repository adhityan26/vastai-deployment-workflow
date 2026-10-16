from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.idle import IdleWatcher
from vastcomfy_agent.state import State, StateStore

T0 = 5_000_000


class Clock:
    def __init__(self):
        self.t = T0

    def __call__(self):
        return self.t


def setup(tmp_path):
    clock = Clock()
    states = StateStore(tmp_path, clock)
    for s in (State.BOOTING, State.DOWNLOADING, State.READY):
        states.set(s)
    deadlines = DeadlineStore(tmp_path, clock)
    deadlines.init_first_boot(3, 6)
    watcher = IdleWatcher(states, deadlines, clock, idle_minutes=30, warn_minutes=10)
    watcher.start()
    return clock, states, deadlines, watcher


def test_start_sets_idle_destroy_at(tmp_path):
    clock, _, deadlines, _ = setup(tmp_path)
    assert deadlines.idle_destroy_at() == T0 + 1800


def test_empty_queue_warns_then_destroys_on_schedule(tmp_path):
    clock, states, _, watcher = setup(tmp_path)
    clock.t = T0 + 19 * 60
    assert watcher.tick(0) == "none" and states.get().state == State.READY
    clock.t = T0 + 20 * 60
    assert watcher.tick(0) == "warn" and states.get().state == State.IDLE_WARNING
    assert watcher.tick(0) == "none"
    clock.t = T0 + 30 * 60
    assert watcher.tick(0) == "destroy"


def test_busy_queue_resets_timer_and_leaves_warning(tmp_path):
    clock, states, deadlines, watcher = setup(tmp_path)
    clock.t = T0 + 25 * 60
    watcher.tick(0)
    assert states.get().state == State.IDLE_WARNING
    assert watcher.tick(2) == "none"
    assert states.get().state == State.READY
    assert deadlines.idle_destroy_at() == clock.t + 1800


def test_extend_while_warning_returns_to_ready(tmp_path):
    clock, states, deadlines, watcher = setup(tmp_path)
    clock.t = T0 + 22 * 60
    watcher.tick(0)
    deadlines.extend_idle(30, max_per_call=120)
    assert watcher.tick(0) == "none"
    assert states.get().state == State.READY


def test_unknown_queue_counts_as_idle_and_never_resets_the_timer(tmp_path):
    # Review focus 4: ComfyUI down while ready.
    clock, states, deadlines, watcher = setup(tmp_path)
    clock.t = T0 + 21 * 60
    assert watcher.tick(None) == "warn"
    clock.t = T0 + 31 * 60
    assert watcher.tick(None) == "destroy"
    assert deadlines.idle_destroy_at() == T0 + 1800


def test_idle_state_survives_a_new_watcher_instance(tmp_path):
    clock, states, deadlines, _ = setup(tmp_path)
    clock.t = T0 + 29 * 60
    fresh = IdleWatcher(states, deadlines, clock, idle_minutes=30, warn_minutes=10)
    assert fresh.tick(0) == "warn"
    clock.t = T0 + 30 * 60
    assert fresh.tick(0) == "destroy"


def test_only_ready_states_are_watched(tmp_path):
    clock = Clock()
    states = StateStore(tmp_path, clock)
    states.set(State.BOOTING)
    deadlines = DeadlineStore(tmp_path, clock)
    watcher = IdleWatcher(states, deadlines, clock, 30, 10)
    clock.t = T0 + 10**6
    assert watcher.tick(0) == "none"


def test_busy_queue_never_moves_an_extended_idle_timer_backwards(tmp_path):
    clock, states, deadlines, watcher = setup(tmp_path)
    extended = deadlines.extend_idle(120, max_per_call=120)
    assert extended == T0 + 1800 + 7200
    clock.t = T0 + 60
    assert watcher.tick(3) == "none"
    assert deadlines.idle_destroy_at() == extended


def test_busy_queue_still_pushes_the_timer_forward_past_an_extension(tmp_path):
    clock, states, deadlines, watcher = setup(tmp_path)
    deadlines.extend_idle(10, max_per_call=120)
    clock.t = T0 + 30 * 60
    watcher.tick(1)
    assert deadlines.idle_destroy_at() == clock.t + 1800
