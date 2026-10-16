import subprocess

from vastcomfy_agent.destroy_flow import DestroyFlow
from vastcomfy_agent.destroyer import Destroyer
from vastcomfy_agent.files import read_json
from vastcomfy_agent.state import State, StateStore

KEY = "k-secret-123"


def proc(code=0, out="", err=""):
    return subprocess.CompletedProcess(args=[], returncode=code, stdout=out, stderr=err)


class FakeRun:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append((cmd, kwargs))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def make(tmp_path, results, retries=3, markers=("404", "not found")):
    run = FakeRun(results)
    sleeps = []
    destroyer = Destroyer(
        vastai_bin="vastai", container_id="42", api_key=KEY, retries=retries, backoff_s=7,
        timeout_s=9, gone_markers=list(markers), state_dir=tmp_path, run=run, sleep=sleeps.append,
    )
    return destroyer, run, sleeps


def test_success_on_first_attempt_builds_the_expected_command(tmp_path):
    destroyer, run, sleeps = make(tmp_path, [proc(0)])
    assert destroyer.destroy() is True
    cmd, kwargs = run.calls[0]
    assert cmd == ["vastai", "destroy", "instance", "42", "--api-key", KEY]
    assert kwargs["timeout"] == 9
    assert sleeps == []
    assert read_json(tmp_path / "destroy_agent.json") == {"attempts": 1, "last_error": None}


def test_retries_with_backoff_then_succeeds(tmp_path):
    destroyer, _, sleeps = make(tmp_path, [proc(1, err="boom"), proc(1, err="boom"), proc(0)])
    assert destroyer.destroy() is True
    assert sleeps == [7, 7]
    assert read_json(tmp_path / "destroy_agent.json")["attempts"] == 3


def test_gives_up_after_the_configured_attempts_and_records_the_error(tmp_path):
    destroyer, run, sleeps = make(tmp_path, [proc(1, err="api down")] * 3)
    assert destroyer.destroy() is False
    assert len(run.calls) == 3 and sleeps == [7, 7]
    record = read_json(tmp_path / "destroy_agent.json")
    assert record == {"attempts": 3, "last_error": "api down"}


def test_already_gone_counts_as_success(tmp_path):
    destroyer, run, _ = make(tmp_path, [proc(1, out="Error: Instance Not Found (404)")])
    assert destroyer.destroy() is True
    assert len(run.calls) == 1


def test_missing_binary_and_timeout_are_failed_attempts_not_crashes(tmp_path):
    destroyer, _, _ = make(
        tmp_path, [FileNotFoundError("vastai"), subprocess.TimeoutExpired("vastai", 9), proc(0)]
    )
    assert destroyer.destroy() is True


def test_error_text_never_contains_the_api_key(tmp_path):
    destroyer, _, _ = make(tmp_path, [proc(1, err=f"bad key {KEY}")] * 3)
    destroyer.destroy()
    assert KEY not in read_json(tmp_path / "destroy_agent.json")["last_error"]


class FakeDestroyer:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    def destroy(self):
        self.calls += 1
        return self.result


def flow_setup(tmp_path, result):
    states = StateStore(tmp_path, lambda: 1)
    for s in (State.BOOTING, State.DOWNLOADING, State.READY):
        states.set(s)
    stopped = []
    destroyer = FakeDestroyer(result)
    return states, destroyer, stopped, DestroyFlow(states, destroyer, lambda: stopped.append(1))


def test_flow_success_leaves_state_stopping_with_reason(tmp_path):
    states, destroyer, stopped, flow = flow_setup(tmp_path, True)
    assert flow.run("idle_timeout") is True
    record = states.get()
    assert (record.state, record.reason) == (State.STOPPING, "idle_timeout")
    assert stopped == []


def test_flow_failure_marks_destroy_failed_and_stops_comfy(tmp_path):
    states, destroyer, stopped, flow = flow_setup(tmp_path, False)
    assert flow.run("manual") is False
    assert states.get().state == State.DESTROY_FAILED
    assert stopped == [1]


def test_flow_can_be_retried_after_destroy_failed(tmp_path):
    states, destroyer, _, flow = flow_setup(tmp_path, False)
    flow.run("manual")
    destroyer.result = True
    assert flow.run("manual") is True
    assert states.get().state == State.STOPPING
    assert destroyer.calls == 2


def test_flow_survives_a_failing_stop_comfy(tmp_path):
    states = StateStore(tmp_path, lambda: 1)
    states.set(State.BOOTING)

    def boom():
        raise RuntimeError("supervisorctl missing")

    flow = DestroyFlow(states, FakeDestroyer(False), boom)
    assert flow.run("manual") is False
    assert states.get().state == State.DESTROY_FAILED
