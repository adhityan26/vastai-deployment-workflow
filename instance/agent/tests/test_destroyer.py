import subprocess

import pytest

from vastcomfy_agent.destroy_flow import DestroyFlow
from vastcomfy_agent.destroyer import Destroyer
from vastcomfy_agent.files import read_json
from vastcomfy_agent.state import State, StateStore

KEY = "k-secret-123"
OK = "destroying instance 42."
GONE = "Failed with error 404: Instance 42 not found."
DENIED = ("Failed with error 401: Authorization Error. Your key lacks proper privileges to perform "
          "this action, due to a constraint on id")


def proc(code=0, out="", err=""):
    """The real vastai CLI exits 0 even on failure, so tests pass code=0 unless they probe the exit status."""
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


def make(tmp_path, results, retries=3, markers=("failed with error 404",), ok_markers=("destroying instance",),
         container_id="42", api_key=KEY):
    run = FakeRun(results)
    sleeps = []
    destroyer = Destroyer(
        vastai_bin="vastai", container_id=container_id, api_key=api_key, retries=retries, backoff_s=7,
        timeout_s=9, gone_markers=list(markers), ok_markers=list(ok_markers), state_dir=tmp_path, run=run,
        sleep=sleeps.append,
    )
    return destroyer, run, sleeps


def test_success_on_first_attempt_builds_the_expected_command(tmp_path):
    destroyer, run, sleeps = make(tmp_path, [proc(0, out=OK)])
    assert destroyer.destroy() is True
    cmd, kwargs = run.calls[0]
    assert cmd == ["vastai", "destroy", "instance", "42", "-y", "--api-key", KEY]
    assert kwargs["timeout"] == 9
    assert len(run.calls) == 1 and sleeps == []
    assert read_json(tmp_path / "destroy_agent.json") == {"attempts": 1, "last_error": None}


def test_retries_with_backoff_then_succeeds(tmp_path):
    destroyer, _, sleeps = make(tmp_path, [proc(0, out=DENIED), proc(0, out=DENIED), proc(0, out=OK)])
    assert destroyer.destroy() is True
    assert sleeps == [7, 7]
    assert read_json(tmp_path / "destroy_agent.json")["attempts"] == 3


def test_gives_up_after_the_configured_attempts_and_records_the_error(tmp_path):
    destroyer, run, sleeps = make(tmp_path, [proc(0, out="Failed with error 503: api down")] * 3)
    assert destroyer.destroy() is False
    assert len(run.calls) == 3 and sleeps == [7, 7]
    record = read_json(tmp_path / "destroy_agent.json")
    assert record == {"attempts": 3, "last_error": "Failed with error 503: api down"}


def test_already_gone_counts_as_success_with_exit_status_0(tmp_path):
    destroyer, run, _ = make(tmp_path, [proc(0, out=GONE)])
    assert destroyer.destroy() is True
    assert len(run.calls) == 1


def test_exit_status_0_with_an_authorization_error_is_a_failed_attempt(tmp_path):
    destroyer, run, sleeps = make(tmp_path, [proc(0, out=DENIED)] * 3)
    assert destroyer.destroy() is False
    assert len(run.calls) == 3 and sleeps == [7, 7]
    last_error = read_json(tmp_path / "destroy_agent.json")["last_error"]
    assert "401" in last_error and KEY not in last_error


@pytest.mark.parametrize("output", ["", "Aborted.", "   \n"])
def test_exit_status_0_with_empty_output_or_aborted_is_a_failed_attempt(tmp_path, output):
    destroyer, run, sleeps = make(tmp_path, [proc(0, out=output)] * 2, retries=2)
    assert destroyer.destroy() is False
    assert len(run.calls) == 2 and sleeps == [7]
    assert read_json(tmp_path / "destroy_agent.json")["last_error"]


@pytest.mark.parametrize("code", [124, 126, 127])
def test_exit_status_124_126_127_is_a_failure_even_with_a_marker_in_the_output(tmp_path, code):
    destroyer, _, _ = make(tmp_path, [proc(code, out=OK), proc(code, out=GONE)], retries=2)
    assert destroyer.destroy() is False


def test_markers_match_case_insensitively(tmp_path):
    destroyer, _, _ = make(tmp_path, [proc(0, out="DESTROYING INSTANCE 42.")], retries=1)
    assert destroyer.destroy() is True
    destroyer, _, _ = make(tmp_path, [proc(0, out="failed WITH Error 404: Instance 42 not found.")], retries=1)
    assert destroyer.destroy() is True


def test_missing_binary_and_timeout_are_failed_attempts_not_crashes(tmp_path):
    destroyer, _, _ = make(
        tmp_path, [FileNotFoundError("vastai"), subprocess.TimeoutExpired("vastai", 9), proc(0, out=OK)]
    )
    assert destroyer.destroy() is True


def test_error_text_never_contains_the_api_key(tmp_path):
    destroyer, _, _ = make(tmp_path, [proc(0, err=f"Failed with error 401: bad key {KEY}")] * 3)
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


class _Always:
    def destroy(self):
        self.called = getattr(self, "called", 0) + 1
        return self.result


class _BrokenStates:
    def set(self, *args, **kwargs):
        raise OSError("disk full")


def test_destroy_flow_still_destroys_when_the_state_cannot_be_written():
    for result in (True, False):
        destroyer = _Always()
        destroyer.result = result
        flow = DestroyFlow(_BrokenStates(), destroyer, lambda: None)
        assert flow.run("manual") is result
        assert destroyer.called == 1


def test_a_non_404_error_echoing_an_instance_id_containing_404_is_a_failure(tmp_path):
    destroyer, _, _ = make(tmp_path, [proc(0, out="Failed with error 500: backend 14040404 timeout")],
                           retries=1, container_id="14040404", markers=("404",))
    assert destroyer.destroy() is False


def test_output_echoing_a_key_containing_404_is_not_gone(tmp_path):
    destroyer, _, _ = make(tmp_path, [proc(0, err="bad key k404k")], retries=1, api_key="k404k",
                           markers=("404",))
    assert destroyer.destroy() is False
    assert "k404k" not in read_json(tmp_path / "destroy_agent.json")["last_error"]


def test_genuine_404_is_gone_even_when_the_id_contains_404(tmp_path):
    destroyer, _, _ = make(tmp_path, [proc(0, out="Failed with error 404: Instance 14040404 not found.")],
                           retries=1, container_id="14040404")
    assert destroyer.destroy() is True


def test_os_errors_from_the_call_are_failed_attempts_not_crashes(tmp_path):
    destroyer, run, sleeps = make(tmp_path, [PermissionError("denied"), OSError("exec format error")], retries=2)
    assert destroyer.destroy() is False
    assert len(run.calls) == 2 and sleeps == [7]
    assert read_json(tmp_path / "destroy_agent.json")["attempts"] == 2
    assert "exec format error" in read_json(tmp_path / "destroy_agent.json")["last_error"]


def test_a_failure_text_containing_an_ok_marker_is_a_failed_attempt(tmp_path):
    text = "Failed with error 500: error destroying instance 42, retry later"
    destroyer, run, _ = make(tmp_path, [proc(0, out=text)] * 2, retries=2)
    assert destroyer.destroy() is False
    assert len(run.calls) == 2


def test_the_ok_marker_must_start_the_output_so_a_preamble_line_reads_as_failure(tmp_path):
    # Known limitation: a warning line before the success text is treated as a failure (and retried; the
    # next attempt finds the instance gone, a 404, which counts as success).
    destroyer, _, _ = make(tmp_path, [proc(0, out="warning: update available\ndestroying instance 42.")], retries=1)
    assert destroyer.destroy() is False


def test_ok_marker_with_surrounding_whitespace_still_succeeds(tmp_path):
    destroyer, _, _ = make(tmp_path, [proc(0, out="\n destroying instance 42.\n")], retries=1)
    assert destroyer.destroy() is True


def test_plain_404_still_counts_as_gone_with_the_new_default_marker(tmp_path):
    destroyer, _, _ = make(tmp_path, [proc(0, out=GONE)], retries=1, markers=("Failed with error 404: Instance",))
    assert destroyer.destroy() is True
