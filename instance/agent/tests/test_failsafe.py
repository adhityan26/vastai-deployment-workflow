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


def setup(tmp_path, *, deadline=None, hard_cap=None, hard_cap_hours=6, fail_times=0,
          stub_out="Failed with error 401: Authorization Error. Your key lacks proper privileges",
          stub_sleep=0, timeout_s=5, key=KEY, markers="Failed with error 404: Instance", ok_markers="destroying instance",
          drop_key=None, stub_rc=0, sctl_sleep=0, overrides=None, stub_pre="", success_out="destroying instance $3."):
    """deadline/hard_cap: int offset in seconds from now, a raw str, or None for 'file missing'.

    The vastai stub mimics the real CLI (spike S4): it exits 0 (stub_rc) also when it fails and prints the
    outcome on stdout: stub_out for the first fail_times calls, then success_out ('' prints nothing).
    """
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
        + f'sleep {stub_sleep}\nif [ "$n" -le {fail_times} ]; then echo "{stub_out}"; exit {stub_rc}; fi\n'
        + (f'echo "{success_out}"\n' if success_out else "")
        + "exit 0\n",
    )
    write_exec(tmp_path / "sctl", f'#!/usr/bin/env bash\necho "$*" >> {sctl_log}\nsleep {sctl_sleep}\nexit 0\n')
    values = {
        "STATE_DIR": str(state), "CONTAINER_ID": "42", "CONTAINER_API_KEY": key,
        "HARD_CAP_HOURS": str(hard_cap_hours), "FAILSAFE_POLL_S": "1", "VASTAI_BIN": str(tmp_path / "vastai"),
        "DESTROY_GONE_MARKERS": markers, "DESTROY_OK_MARKERS": ok_markers, "DESTROY_TIMEOUT_S": str(timeout_s),
        "DESTROY_ASSUME_YES": "true",
        "SUPERVISORCTL_BIN": str(tmp_path / "sctl"), "SUPERVISOR_CONF": "/unused/sup.conf", "COMFY_PROGRAM": "comfy",
    }
    if drop_key:
        values.pop(drop_key)
    values.update(overrides or {})
    env = tmp_path / "instance.env"
    env.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    return env, state, log, sctl_log


def start(env, procs, extra_env=None):
    environ = {**os.environ, **(extra_env or {})}
    proc = subprocess.Popen(["bash", str(SCRIPT), "--env-file", str(env)], stderr=subprocess.PIPE, text=True,
                            env=environ)
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
    assert log.read_text().strip() == f"destroy instance 42 -y --api-key {KEY}"
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
    assert wait_until(lambda: proc.poll() is not None, timeout=20) and log.exists()


def test_missing_hard_cap_file_is_computed_from_the_configured_hours(tmp_path, procs):
    # HARD_CAP_HOURS must be >= 1 (I3), so the computed cap lies an hour ahead: no destroy yet,
    # and an earlier deadline still wins over the computed cap.
    env, state, log, _ = setup(tmp_path, deadline=None, hard_cap=None, hard_cap_hours=1)
    proc = start(env, procs)
    assert wait_until(lambda: (state / "failsafe.pid").exists())
    time.sleep(2.5)
    assert proc.poll() is None and not log.exists()


def test_missing_hard_cap_file_still_honours_a_passed_deadline(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=-100, hard_cap=None, hard_cap_hours=1)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and log.exists()


def test_elapsed_time_guard_fires_even_when_the_files_say_far_future(tmp_path, procs):
    # bash takes SECONDS from the environment, which stands in for an hour of uptime here.
    env, _, log, _ = setup(tmp_path, deadline=10**6, hard_cap=10**6, hard_cap_hours=1)
    proc = start(env, procs, extra_env={"SECONDS": "3600"})
    assert wait_until(lambda: proc.poll() is not None) and log.exists()


def test_elapsed_time_guard_is_not_early(tmp_path, procs):
    env, state, log, _ = setup(tmp_path, deadline=10**6, hard_cap=10**6, hard_cap_hours=1)
    proc = start(env, procs, extra_env={"SECONDS": "3590"})
    assert wait_until(lambda: (state / "failsafe.pid").exists())
    time.sleep(2.5)
    assert proc.poll() is None and not log.exists()


@pytest.mark.parametrize("key", ["DESTROY_TIMEOUT_S", "HARD_CAP_HOURS", "FAILSAFE_POLL_S"])
@pytest.mark.parametrize("value", ["1_0", "0", "-5", "+5", " 5", "5 ", "abc", "1.5"])
def test_non_strict_or_zero_numeric_key_exits_2_and_names_it(tmp_path, procs, key, value):
    # I3: exit 2 at startup makes bootstrap's kill -0 check fail closed (failsafe_failed).
    env, _, log, _ = setup(tmp_path, deadline=-100, hard_cap=1000, overrides={key: value})
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5)
    assert proc.returncode == 2 and key in proc.stderr.read()
    assert not log.exists()


def test_numeric_keys_with_a_leading_zero_are_read_as_decimal(tmp_path, procs):
    # bash arithmetic would read 08 as a bad octal number and leave the cap unset.
    env, _, log, _ = setup(tmp_path, deadline=-100, hard_cap=None,
                           overrides={"HARD_CAP_HOURS": "08", "DESTROY_TIMEOUT_S": "09", "FAILSAFE_POLL_S": "01"})
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and proc.returncode == 0 and log.exists()


def test_retries_until_the_api_works_and_counts_attempts(tmp_path, procs):
    env, state, log, sctl = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=2)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=30)
    assert len(log.read_text().strip().splitlines()) == 3
    assert record(state)["attempts"] == 3 and record(state)["pending"] is False
    assert len(sctl.read_text().strip().splitlines()) == 1


def test_already_gone_counts_as_success(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, stub_out="Failed with error 404: Instance 42 not found.")
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
    assert log.read_text().strip() == "destroy instance 42 -y --api-key a=b#c d"


@pytest.mark.parametrize("missing", ["STATE_DIR", "CONTAINER_API_KEY", "VASTAI_BIN", "FAILSAFE_POLL_S", "DESTROY_OK_MARKERS"])
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


def test_exit_127_with_an_ok_marker_is_a_failure_not_a_success(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, stub_rc=127,
                             stub_out="destroying instance 42.")
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
    assert log.read_text().strip() == f"destroy instance 42 -y --api-key {KEY}"


def test_unusable_output_file_still_runs_the_destroy(tmp_path, procs):
    env, state, log, _ = setup(tmp_path, deadline=1, hard_cap=1000)
    (state / ".failsafe_out").mkdir()
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=10)
    assert log.read_text().strip() == f"destroy instance 42 -y --api-key {KEY}"


def test_a_hung_supervisorctl_cannot_delay_the_destroy_beyond_the_timeout(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, sctl_sleep=30, timeout_s=2)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=10)
    assert proc.returncode == 0 and log.exists()


def test_timeout_with_partial_gone_output_is_a_failure_not_a_success(tmp_path, procs):
    # I1: a call killed by the timeout (rc 124) never counts as gone, whatever it printed first.
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, stub_pre="destroying instance 42.",
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
                             markers="404", ok_markers="destroying instance",
                             stub_out=f"Failed with error 500: rate limited {ident} with {key}",
                             overrides={"CONTAINER_ID": ident})
    proc = start(env, procs)
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists() and record(state)["attempts"] >= 2)
    assert proc.poll() is None
    assert wait_until(lambda: record(state)["last_error"] is not None)
    assert record(state)["pending"] is True and key not in record(state)["last_error"]


def test_genuine_not_found_still_counts_as_gone_when_the_id_contains_404(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99,
                           stub_out="Failed with error 404: Instance 14040404 not found.",
                           overrides={"CONTAINER_ID": "14040404"})
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and proc.returncode == 0
    assert len(log.read_text().strip().splitlines()) == 1


@pytest.mark.parametrize("noise", ["\x1b[31mred error\x1b[0m\tbad\x01 caf\u00e9 \x7f", "\u00e9" * 300],
                         ids=["ansi-and-controls", "long-multibyte"])
def test_last_error_is_valid_json_without_control_or_non_ascii_bytes(tmp_path, procs, noise):
    # minor (a): ANSI escapes, tabs, DEL and multi-byte text must not break the JSON record.
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, stub_out=noise)
    start(env, procs)
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists()
                      and '"last_error": null' not in (state / "destroy_failsafe.json").read_text())
    raw = (state / "destroy_failsafe.json").read_bytes()
    assert all(0x20 <= b < 0x7f for b in raw.rstrip(b"\n"))
    data = json.loads(raw)
    assert data["pending"] is True
    if "red" in noise:
        assert "red error" in data["last_error"] and "bad" in data["last_error"]


def failing_attempts(state, proc):
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists() and record(state)["attempts"] >= 2)
    assert proc.poll() is None
    assert wait_until(lambda: record(state)["last_error"] is not None)
    assert record(state)["pending"] is True


def test_exit_status_0_with_an_authorization_error_is_a_failure_and_is_retried(tmp_path, procs):
    # The real CLI exits 0 on failure; the exit status must never count as a success.
    env, state, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99)
    proc = start(env, procs)
    failing_attempts(state, proc)
    assert len(log.read_text().strip().splitlines()) >= 2
    assert "401" in record(state)["last_error"] and KEY not in record(state)["last_error"]


def test_exit_status_0_with_empty_output_is_a_failure(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, success_out="")
    proc = start(env, procs)
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists() and record(state)["attempts"] >= 2)
    assert proc.poll() is None and record(state)["pending"] is True


def test_aborted_output_is_a_failure(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, stub_out="Aborted.")
    proc = start(env, procs)
    failing_attempts(state, proc)
    assert "Aborted" in record(state)["last_error"]


def test_markers_match_case_insensitively(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, success_out="DESTROYING INSTANCE $3.")
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and proc.returncode == 0
    assert len(log.read_text().strip().splitlines()) == 1


def test_a_missing_ok_markers_key_exits_2_and_names_it(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, drop_key="DESTROY_OK_MARKERS")
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5)
    assert proc.returncode == 2 and "DESTROY_OK_MARKERS" in proc.stderr.read() and not log.exists()


def test_a_failure_text_containing_the_ok_marker_is_a_failure(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99,
                             stub_out="Failed with error 500: error destroying instance 42, retry later")
    proc = start(env, procs)
    failing_attempts(state, proc)


STOCK_PREAMBLE = ("WARNING: The python vast.py CLI is deprecated and will be removed.\n"
                  "         Please run: pip install --upgrade vastai\n\n")


def test_the_stock_cli_preamble_before_the_success_line_is_a_success(tmp_path, procs):
    env, state, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, stub_pre=STOCK_PREAMBLE.rstrip("\n"))
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and proc.returncode == 0
    assert len(log.read_text().strip().splitlines()) == 1
    assert record(state) == {"attempts": 1, "last_error": None, "pending": False}


def test_the_stock_cli_preamble_before_a_failure_is_a_failure(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99,
                             stub_pre=STOCK_PREAMBLE.rstrip("\n"),
                             stub_out="Failed with error 500: error destroying instance 42, retry later")
    proc = start(env, procs)
    failing_attempts(state, proc)


def test_the_stock_cli_preamble_before_a_plain_404_is_gone(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99,
                           stub_pre=STOCK_PREAMBLE.rstrip("\n"), stub_out="Failed with error 404: Instance 42 not found.")
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and proc.returncode == 0
    assert len(log.read_text().strip().splitlines()) == 1


def test_a_failure_line_wins_over_an_ok_line(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, success_out="destroying instance 42.\nFailed with error 500: boom")
    proc = start(env, procs)
    failing_attempts(state, proc)


def test_a_warning_only_output_is_a_failure(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, success_out="WARNING: deprecated")
    proc = start(env, procs)
    failing_attempts(state, proc)


def test_an_ok_marker_in_the_middle_of_a_line_is_not_a_success(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, success_out="while destroying instance 42 nothing happened")
    proc = start(env, procs)
    failing_attempts(state, proc)


def test_assume_yes_false_drops_the_dash_y_from_the_command(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, overrides={"DESTROY_ASSUME_YES": "false"})
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and proc.returncode == 0
    assert log.read_text().strip() == f"destroy instance 42 --api-key {KEY}"


@pytest.mark.parametrize("value", ["yes", "TRUE", "1", ""])
def test_invalid_assume_yes_exits_2_and_names_the_key(tmp_path, procs, value):
    env, _, log, _ = setup(tmp_path, deadline=1000, hard_cap=2000, overrides={"DESTROY_ASSUME_YES": value})
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5)
    assert proc.returncode == 2 and "DESTROY_ASSUME_YES" in proc.stderr.read() and not log.exists()


def test_a_missing_assume_yes_key_exits_2_and_names_it(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1000, hard_cap=2000, drop_key="DESTROY_ASSUME_YES")
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5)
    assert proc.returncode == 2 and "DESTROY_ASSUME_YES" in proc.stderr.read() and not log.exists()


def test_a_blank_marker_entry_does_not_match_everything(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, ok_markers="destroying instance, ")
    proc = start(env, procs)
    failing_attempts(state, proc)
    assert "401" in record(state)["last_error"]


def test_markers_are_trimmed_so_a_real_404_is_still_gone(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99,
                           stub_out="Failed with error 404: Instance 42 not found.",
                           ok_markers="destroying instance", markers="x,  Failed with error 404: Instance  ")
    env.write_text(env.read_text().replace("DESTROY_OK_MARKERS=destroying instance\n",
                                           "DESTROY_OK_MARKERS=destroying instance, Failed with error 404: Instance\n"))
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and proc.returncode == 0
    assert len(log.read_text().strip().splitlines()) == 1
