import json
import os
import subprocess
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "failsafe.sh"
KEY = "ck=with spaces#and=equals"


@pytest.fixture
def procs():
    started = []
    yield started
    for proc in started:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        if proc.stderr is not None:
            proc.stderr.close()


def write_exec(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o755)


def setup(tmp_path, *, deadline=None, hard_cap=None, hard_cap_hours=6, fail_times=0, stub_out="boom",
          stub_sleep=0, timeout_s=5, key=KEY, markers="404,not found", drop_key=None,
          stub_rc=1, sctl_sleep=0, overrides=None, stub_pre=""):
    """deadline/hard_cap: int offset in seconds from now, a raw str, or None for 'file missing'."""
    state = tmp_path / "state"
    state.mkdir()
    now = int(time.time())
    for name, value in (("deadline", deadline), ("hard_cap", hard_cap)):
        if value is not None:
            (state / name).write_text(str(now + value) if isinstance(value, int) else value)
    log, count, sctl_log = tmp_path / "vast.log", tmp_path / "count", tmp_path / "sctl.log"
    write_exec(
        tmp_path / "vastai",
        f'#!/usr/bin/env bash\necho "$*" >> {log}\nn=$(cat {count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {count}\n'
        + (f'echo "{stub_pre}"\n' if stub_pre else "")
        + f'sleep {stub_sleep}\nif [ "$n" -le {fail_times} ]; then echo "{stub_out}" >&2; exit {stub_rc}; fi\nexit 0\n',
    )
    write_exec(tmp_path / "sctl", f'#!/usr/bin/env bash\necho "$*" >> {sctl_log}\nsleep {sctl_sleep}\nexit 0\n')
    values = {
        "STATE_DIR": str(state), "CONTAINER_ID": "42", "CONTAINER_API_KEY": key,
        "HARD_CAP_HOURS": str(hard_cap_hours), "FAILSAFE_POLL_S": "1", "VASTAI_BIN": str(tmp_path / "vastai"),
        "DESTROY_GONE_MARKERS": markers, "DESTROY_TIMEOUT_S": str(timeout_s),
        "SUPERVISORCTL_BIN": str(tmp_path / "sctl"), "SUPERVISOR_CONF": "/unused/sup.conf", "COMFY_PROGRAM": "comfy",
    }
    if drop_key:
        values.pop(drop_key)
    values.update(overrides or {})
    env = tmp_path / "instance.env"
    env.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    return env, state, log, sctl_log


def start(env, procs):
    proc = subprocess.Popen(["bash", str(SCRIPT), "--env-file", str(env)], stderr=subprocess.PIPE, text=True)
    procs.append(proc)
    return proc


def wait_until(predicate, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


def record(state):
    return json.loads((state / "destroy_failsafe.json").read_text())


def test_destroys_when_the_deadline_passes_and_exits(tmp_path, procs):
    env, state, log, sctl = setup(tmp_path, deadline=2, hard_cap=1000)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None)
    assert proc.returncode == 0
    assert log.read_text().strip() == f"destroy instance 42 --api-key {KEY}"
    assert record(state) == {"attempts": 1, "last_error": None, "pending": False}
    assert "stop comfy" in sctl.read_text()


def test_does_not_destroy_before_the_deadline_and_writes_its_pid(tmp_path, procs):
    env, state, log, _ = setup(tmp_path, deadline=1000, hard_cap=2000)
    proc = start(env, procs)
    assert wait_until(lambda: (state / "failsafe.pid").exists())
    time.sleep(2.5)
    assert proc.poll() is None and not log.exists()
    assert int((state / "failsafe.pid").read_text()) == proc.pid


def test_hard_cap_wins_over_a_later_deadline(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1000, hard_cap=2)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and log.exists()


def test_corrupt_deadline_falls_back_to_hard_cap(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline="garbage\n", hard_cap=2)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and log.exists()


def test_deadline_in_the_past_after_a_restart_destroys_on_the_first_loop(tmp_path, procs):
    # Review focus 3
    env, _, log, _ = setup(tmp_path, deadline=-100, hard_cap=1000)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5) and log.exists()


def test_missing_hard_cap_file_is_computed_from_the_configured_hours(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=None, hard_cap=None, hard_cap_hours=0)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5) and log.exists()


def test_elapsed_time_guard_fires_even_when_the_files_say_far_future(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=10**6, hard_cap=10**6, hard_cap_hours=0)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5) and log.exists()


def test_retries_until_the_api_works_and_counts_attempts(tmp_path, procs):
    env, state, log, sctl = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=2)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=30)
    assert len(log.read_text().strip().splitlines()) == 3
    assert record(state)["attempts"] == 3 and record(state)["pending"] is False
    assert len(sctl.read_text().strip().splitlines()) == 1


def test_already_gone_counts_as_success(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, stub_out="Instance Not Found (404)")
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and proc.returncode == 0
    assert len(log.read_text().strip().splitlines()) == 1


def test_persistent_failure_keeps_pending_and_never_leaks_the_key(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, stub_out=f"bad key {KEY}")
    proc = start(env, procs)
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists() and record(state)["attempts"] >= 2)
    assert proc.poll() is None
    # the record is rewritten with last_error=null at the start of each attempt; wait for the failure to land
    assert wait_until(lambda: record(state)["last_error"] is not None)
    data = record(state)
    assert data["pending"] is True and KEY not in data["last_error"] and "bad key" in data["last_error"]


def test_a_hanging_vastai_call_is_killed_after_the_timeout(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, stub_sleep=30, timeout_s=2)
    start(env, procs)
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists() and "timed out" in (record(state)["last_error"] or ""), timeout=15)


def test_env_value_with_equals_spaces_and_hash_reaches_the_command_intact(tmp_path, procs):
    # Review focus 2
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, key="a=b#c d")
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None)
    assert log.read_text().strip() == "destroy instance 42 --api-key a=b#c d"


@pytest.mark.parametrize("missing", ["STATE_DIR", "CONTAINER_API_KEY", "VASTAI_BIN", "FAILSAFE_POLL_S"])
def test_missing_required_key_exits_2_and_names_it(tmp_path, procs, missing):
    env, _, _, _ = setup(tmp_path, deadline=1000, hard_cap=2000, drop_key=missing)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5)
    assert proc.returncode == 2 and missing in proc.stderr.read()


def test_usage_errors_exit_2():
    assert subprocess.run(["bash", str(SCRIPT)], capture_output=True).returncode == 2
    assert subprocess.run(["bash", str(SCRIPT), "--env-file", "/no/such/file"], capture_output=True).returncode == 2


def test_missing_vastai_binary_exits_2_at_startup_and_names_the_key(tmp_path, procs):
    env, _, _, _ = setup(tmp_path, deadline=1000, hard_cap=2000, overrides={"VASTAI_BIN": "no-such-vastai-bin"})
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5)
    assert proc.returncode == 2 and "VASTAI_BIN" in proc.stderr.read()


def test_exit_127_with_a_gone_marker_is_a_failure_not_a_success(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, stub_rc=127,
                             stub_out="vastai: command not found")
    proc = start(env, procs)
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists() and record(state)["attempts"] >= 2)
    assert proc.poll() is None
    assert wait_until(lambda: record(state)["last_error"] is not None)
    assert record(state)["pending"] is True


def test_binary_vanishing_after_startup_keeps_retrying(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=3, hard_cap=1000)
    proc = start(env, procs)
    assert wait_until(lambda: (state / "failsafe.pid").exists())
    (tmp_path / "vastai").unlink()
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists() and record(state)["attempts"] >= 2)
    assert proc.poll() is None
    assert wait_until(lambda: record(state)["last_error"] is not None)
    assert record(state)["pending"] is True


needs_non_root = pytest.mark.skipif(os.geteuid() == 0, reason="chmod does not restrict root")


@needs_non_root
def test_unwritable_state_dir_at_startup_exits_2(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1000, hard_cap=2000)
    state.chmod(0o555)
    try:
        proc = start(env, procs)
        assert wait_until(lambda: proc.poll() is not None, timeout=5)
        assert proc.returncode == 2 and "STATE_DIR" in proc.stderr.read()
    finally:
        state.chmod(0o755)


@needs_non_root
def test_state_dir_becoming_unwritable_after_startup_still_destroys(tmp_path, procs):
    env, state, log, _ = setup(tmp_path, deadline=3, hard_cap=1000)
    proc = start(env, procs)
    assert wait_until(lambda: (state / "failsafe.pid").exists())
    state.chmod(0o555)
    try:
        assert wait_until(lambda: proc.poll() is not None, timeout=10)
    finally:
        state.chmod(0o755)
    assert log.read_text().strip() == f"destroy instance 42 --api-key {KEY}"


def test_unusable_output_file_still_runs_the_destroy(tmp_path, procs):
    env, state, log, _ = setup(tmp_path, deadline=1, hard_cap=1000)
    (state / ".failsafe_out").mkdir()
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=10)
    assert log.read_text().strip() == f"destroy instance 42 --api-key {KEY}"


def test_a_hung_supervisorctl_cannot_delay_the_destroy_beyond_the_timeout(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, sctl_sleep=30, timeout_s=2)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=10)
    assert proc.returncode == 0 and log.exists()


def test_timeout_with_partial_gone_output_is_a_failure_not_a_success(tmp_path, procs):
    # I1: a call killed by the timeout (rc 124) never counts as gone, whatever it printed first.
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, stub_pre="Instance Not Found (404)",
                             stub_sleep=30, timeout_s=2)
    proc = start(env, procs)
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists()
                      and "timed out" in (record(state)["last_error"] or ""), timeout=15)
    assert proc.poll() is None
    assert record(state)["pending"] is True


@pytest.mark.parametrize("field", ["id", "key"])
def test_output_echoing_the_instance_id_or_key_containing_404_is_a_failure(tmp_path, procs, field):
    # I2: a bare "404" marker must not match the instance id or the API key echoed in an error.
    ident, key = ("14040404", KEY) if field == "id" else ("42", "k404k")
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, key=key,
                             stub_out=f"error: rate limited destroying {ident} with {key}",
                             overrides={"CONTAINER_ID": ident})
    proc = start(env, procs)
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists() and record(state)["attempts"] >= 2)
    assert proc.poll() is None
    assert wait_until(lambda: record(state)["last_error"] is not None)
    assert record(state)["pending"] is True and key not in record(state)["last_error"]


def test_genuine_not_found_still_counts_as_gone_when_the_id_contains_404(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99,
                           stub_out="Instance Not Found (404)", overrides={"CONTAINER_ID": "14040404"})
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and proc.returncode == 0
    assert len(log.read_text().strip().splitlines()) == 1
