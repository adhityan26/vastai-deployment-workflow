import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

INSTANCE = Path(__file__).resolve().parents[2]
SCRIPT = INSTANCE / "bootstrap.sh"
# bash 3.2 (macOS /bin/bash) is the portability floor; fall back to whatever bash is on PATH.
BASH = "/bin/bash" if Path("/bin/bash").exists() else shutil.which("bash")
KEY = "fake-container-key"


def lines():
    return SCRIPT.read_text().splitlines()


def code_lines():
    return [line for line in lines() if not line.lstrip().startswith("#")]


def index_of(fragment):
    for number, line in enumerate(lines()):
        if fragment in line and not line.lstrip().startswith("#"):
            return number
    raise AssertionError(f"{fragment!r} not found in bootstrap.sh")


def function_body(name):
    start = index_of(f"{name}() {{")
    body = []
    for line in lines()[start + 1:]:
        if line.startswith("}"):
            return body
        body.append(line)
    raise AssertionError(f"{name} has no closing brace")


def schema_default(name):
    from vastcomfy_agent.config import load_schema

    return str(next(s for s in load_schema() if s.name == name).default)


# --- static checks -------------------------------------------------------------------------------

def test_script_has_valid_bash_syntax():
    assert subprocess.run([BASH, "-n", str(SCRIPT)], capture_output=True).returncode == 0


def test_safety_nets_come_before_anything_that_can_fail():
    order = [
        index_of("emergency_destroy() {"), index_of("-m venv"),
        index_of('"vastai=='), index_of_call("install_runtime"),
        index_of("write-env"), index_of("trap on_exit EXIT"), index_of("set-key VASTAI_BIN"),
        index_of("boot begin"), index_of("init-times"), index_of("failsafe.sh"), index_of('kill -0 "$FAILSAFE_PID"'),
        index_of("render-supervisor-conf"), index_of("ctl reread"), index_of("ctl update"),
        index_of("start tailscaled"), index_of("wipe-key TS_AUTHKEY"), index_of("start agent"),
        index_of("--target agent"), index_of("install-nodes"), index_of("install-models"), index_of("copy-workflows"),
        index_of('restart "$COMFY_PROGRAM"'), index_of("--target comfy"), index_of("boot verify-nodes"),
        index_of("mark-ready"), index_of("BOOT_DONE=1"),
    ]
    assert order == sorted(order) and len(set(order)) == len(order)


def index_of_call(name):
    """Line of a bare top-level call of `name` (not its definition)."""
    for number, line in enumerate(lines()):
        if line.strip() == name:
            return number
    raise AssertionError(f"no top-level call of {name}")


def test_no_second_supervisord_and_no_env_expansion_remain():
    text = SCRIPT.read_text()
    assert "SUPERVISORD_BIN" not in text and "%(ENV_" not in text
    assert not any(re.match(r"\s*\"?\$?\{?supervisord\b", line) for line in code_lines())
    assert not (INSTANCE / "supervisord.conf").exists()


def test_programs_are_registered_with_the_running_supervisord():
    for fragment in ("boot render-supervisor-conf", "ctl reread", "ctl update"):
        line = lines()[index_of(fragment)].strip()
        assert line.endswith(("|| exit $?", "|| die_with supervisor_failed")), line
    assert "|| die_with supervisor_failed" in lines()[index_of("ctl reread")]
    assert "|| die_with supervisor_failed" in lines()[index_of("ctl update")]


def test_comfyui_is_restarted_not_started_after_the_workflows():
    assert 'ctl start "$COMFY_PROGRAM"' not in SCRIPT.read_text()
    assert "|| die_with comfyui_start_failed" in lines()[index_of('restart "$COMFY_PROGRAM"')]


def test_comfyui_arguments_with_the_preview_method_are_written_right_before_the_restart():
    line = index_of("boot comfy-args")
    assert index_of("copy-workflows") < line < index_of("disable_comfy_manager ||") < index_of('restart "$COMFY_PROGRAM"')
    assert lines()[line].strip() == 'boot comfy-args --env-file "$ENV_FILE" || exit $?'


def test_authkey_is_never_placed_on_a_command_line():
    text = SCRIPT.read_text()
    assert '--auth-key="file:$AUTH_FILE"' in text
    assert '--auth-key="$TS_AUTHKEY"' not in text and "--auth-key=$TS_AUTHKEY" not in text


def test_exit_trap_is_installed_after_write_env_and_before_init_times():
    assert index_of("write-env") < index_of("trap on_exit EXIT") < index_of("init-times")
    assert "boot_failed" in SCRIPT.read_text()


def test_trap_placement_check_catches_a_misplaced_trap(monkeypatch):
    # Mutant: the installing line moved after install-nodes must fail the placement check.
    mutant = [line for line in lines() if line != "trap on_exit EXIT"]
    position = next(i for i, line in enumerate(mutant) if "install-nodes" in line)
    mutant.insert(position + 1, "trap on_exit EXIT")
    monkeypatch.setattr(sys.modules[__name__], "lines", lambda: mutant)
    assert not (index_of("write-env") < index_of("trap on_exit EXIT") < index_of("init-times"))


def test_node_classes_are_verified_after_comfyui_answers_and_right_before_ready():
    verify = index_of("boot verify-nodes")
    assert index_of("--target comfy") < verify < index_of("mark-ready")
    line = lines()[verify].strip()
    assert line == 'boot verify-nodes --env-file "$ENV_FILE" || exit $?', line
    # Nothing but comments between it and mark-ready: no step may slip in between the check and `ready`.
    between = [l for l in lines()[verify + 1:index_of("mark-ready")] if l.strip() and not l.lstrip().startswith("#")]
    assert between == []


def test_boot_done_is_set_after_mark_ready():
    assert index_of("mark-ready") < index_of("BOOT_DONE=1")


def test_every_step_after_the_trap_is_guarded():
    start = index_of("trap on_exit EXIT") + 1
    end = index_of("BOOT_DONE=1")
    step_markers = ("boot ", "ctl ")
    for line in lines()[start:end]:
        stripped = line.strip()
        if not stripped.startswith(step_markers):
            continue
        assert any(guard in stripped for guard in ("|| die_with", "|| exit $?", "|| emergency_destroy",
                                                   "|| pre_failsafe_failed $?")), stripped


def test_the_vastai_fallback_switches_the_env_to_the_stock_cli_without_y():
    install = function_body("install_pinned_vastai")
    assert any('"vastai==${VASTAI_VERSION:-' in line for line in install)
    runtime = " ".join(function_body("install_runtime"))
    assert "install_pinned_vastai || " in runtime and "VASTAI_FALLBACK=1" in runtime
    block = lines()[index_of('"$VASTAI_FALLBACK" = 1'):index_of("boot begin")]
    text = "\n".join(block)
    assert "boot get STOCK_VASTAI_BIN" in text
    assert 'boot set-key VASTAI_BIN "$STOCK_VASTAI' in text
    assert "boot set-key DESTROY_ASSUME_YES false" in text
    # a set-key failure exits 13, which on_exit treats as handled; only the stock CLI can still destroy here
    for line in block:
        if line.strip().startswith(("boot ", "STOCK_VASTAI")):
            assert "|| emergency_destroy" in line, line
    # the failsafe reads the .env at start, so the switch must happen before it is launched
    assert index_of("set-key DESTROY_ASSUME_YES") < index_of("failsafe.sh")


def test_emergency_destroy_uses_the_stock_cli_from_path_without_y_and_never_prints_the_key():
    body = "\n".join(function_body("emergency_destroy"))
    assert "command -v vastai" in body
    assert " -y" not in body
    assert "destroy instance" in body and '--api-key "$CONTAINER_API_KEY"' in body
    # Exit 1 unless the caller names another non-zero code (slow_network: 14).
    assert "HANDLED=1" in body and 'code="${2:-1}"' in body and body.count('exit "$code"') == 2 and "exit 0" not in body
    for line in function_body("emergency_destroy"):
        if re.search(r"\b(echo|printf)\b", line) and "CONTAINER_API_KEY" in line:
            assert '//"$CONTAINER_API_KEY"/' in line, line  # printed only with the key stripped


def test_agent_install_failure_reaches_the_emergency_destroy():
    runtime = function_body("install_runtime")
    assert any(line.strip().startswith("install_agent || emergency_destroy") for line in runtime)
    agent = " ".join(function_body("install_agent"))
    assert '-m venv "$VENV_DIR"' in agent and '"$PY" -m pip install -q -e "$HERE/agent"' in agent


def test_bootstrap_uses_the_venv_python_for_the_boot_cli():
    assert lines()[index_of("PY=")].strip() == 'PY="$VENV_DIR/bin/python"'
    assert lines()[index_of("boot() {")].lstrip().startswith('boot() { "$PY" -m vastcomfy_agent.boot')
    assert "COMFY_PYTHON" not in SCRIPT.read_text()


@pytest.mark.parametrize("key", ["VENV_DIR", "VASTAI_VERSION", "NET_PROBE_BYTES", "NET_PROBE_MIN_MBPS", "HF_BASE_URL", "STATE_DIR", "COMFY_DIR"])
def test_pre_config_fallbacks_match_the_schema_defaults(key):
    assert f'${{{key}:-{schema_default(key)}}}' in SCRIPT.read_text()


def test_sourcing_guard_comes_before_any_action():
    guard = index_of('[ "${BASH_SOURCE[0]}" = "$0" ] || return 0')
    assert guard < index_of_call("install_runtime")
    assert guard < index_of("write-env")


def test_agent_python_is_a_plain_instance_key_defaulting_to_the_venv_python():
    from vastcomfy_agent.config import load_schema

    spec = next(s for s in load_schema() if s.name == "AGENT_PYTHON")
    assert spec.components == ("instance",) and not spec.secret and not spec.required and spec.default == "/opt/vastcomfy-venv/bin/python"
    assert spec.default == f"{schema_default('VENV_DIR')}/bin/python"


def test_no_code_or_test_still_references_the_removed_supervisord_conf():
    for path in [INSTANCE / "bootstrap.sh", INSTANCE / "onstart.sh", INSTANCE / "failsafe.sh",
                 *(INSTANCE / "agent" / "vastcomfy_agent").glob("*.py")]:
        assert "instance/supervisord.conf" not in path.read_text(), path


# --- behaviour of the pre-config functions (the script is only sourced; its main flow never runs) --------

def write_exec(path, text):
    path.write_text(text)
    path.chmod(0o755)
    return path


def fake_vastai(bindir, log, output):
    return write_exec(bindir / "vastai", f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{log}"\nprintf "{output}"\nexit 0\n')


def fake_venv_python(log, *, agent_rc=0, vastai_rc=0, offline_rc=0):
    return (
        '#!/bin/sh\n'
        f'printf "venv-python %s\\n" "$*" >> "{log}"\n'
        f'case "$*" in *--no-index*) exit {offline_rc};; *" -e "*) exit {agent_rc};; *vastai==*) exit {vastai_rc};; esac\n'
        'exit 0\n'
    )


def fake_python3(bindir, log, *, venv_rc=0, agent_rc=0, vastai_rc=0):
    """python3 -m venv DIR creates DIR/bin/python; that python records pip calls and fails as asked.
    `python3 -I script` (the image marker helper) runs the real interpreter."""
    venv_python = fake_venv_python(log, agent_rc=agent_rc, vastai_rc=vastai_rc)
    script = (
        '#!/bin/sh\n'
        f'[ "$1" = "-I" ] && exec "{sys.executable}" "$@"\n'
        f'printf "python3 %s\\n" "$*" >> "{log}"\n'
        f'[ "$1 $2" = "-m venv" ] || exit 1\n'
        f'[ {venv_rc} -eq 0 ] || exit {venv_rc}\n'
        'mkdir -p "$3/bin"\n'
        f"cat > \"$3/bin/python\" <<'EOF'\n{venv_python}EOF\n"
        'chmod 755 "$3/bin/python"\n'
    )
    return write_exec(bindir / "python3", script)


def source_and_run(tmp_path, snippet, extra_env=None, marker=None):
    """Sources bootstrap.sh and runs the snippet; IMAGE_MARKER points at `marker` (default: a missing file,
    the stock image)."""
    bindir = tmp_path / "bin"
    env = {
        "PATH": f"{bindir}:/usr/bin:/bin", "HOME": str(tmp_path), "VENV_DIR": str(tmp_path / "venv"),
        "CONTAINER_ID": "42", "CONTAINER_API_KEY": KEY, "DESTROY_BACKOFF_S": "0",
        "STOCK_VASTAI_BIN": str(tmp_path / "no-stock-vastai"),
    }
    env.update(extra_env or {})
    marker = marker or tmp_path / "no-image-marker.json"
    return subprocess.run([BASH, "-c", f'. "$1"; IMAGE_MARKER="$2"; {snippet}', "_", str(SCRIPT), str(marker)],
                          env=env, capture_output=True, text=True, timeout=30, cwd=tmp_path)


@pytest.fixture
def bindir(tmp_path):
    path = tmp_path / "bin"
    path.mkdir()
    # The fakes come first on PATH; only a missing CLI must really be missing.
    if any((Path(d) / "vastai").exists() for d in ("/usr/bin", "/bin")):
        pytest.skip("a real vastai on the system PATH would break the missing-CLI case")
    return path


def test_sourcing_only_defines_functions_and_runs_nothing(tmp_path, bindir):
    log = tmp_path / "calls.log"
    fake_python3(bindir, log)
    fake_vastai(bindir, log, "destroying instance 42.")
    result = source_and_run(tmp_path, 'type emergency_destroy install_runtime >/dev/null && echo sourced')
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "sourced"
    assert not log.exists() and not (tmp_path / "venv").exists()


@pytest.mark.parametrize("output,attempts", [("WARNING: deprecated\\n\\ndestroying instance 42.\\n", 1),
                                             (f"Failed with error 401: key {KEY} lacks privileges\\n", 3)])
def test_emergency_destroy_calls_the_stock_cli_without_y_hides_the_key_and_always_fails(tmp_path, bindir, output,
                                                                                         attempts):
    log = tmp_path / "vastai.log"
    fake_vastai(bindir, log, output)
    result = source_and_run(tmp_path, "emergency_destroy agent_install_failed; echo not-reached")
    assert result.returncode != 0
    assert "not-reached" not in result.stdout
    assert log.read_text().splitlines() == [f"destroy instance 42 --api-key {KEY}"] * attempts
    assert KEY not in result.stdout + result.stderr
    assert "agent_install_failed" in result.stderr


def test_emergency_destroy_without_a_cli_still_exits_non_zero(tmp_path, bindir):
    result = source_and_run(tmp_path, "emergency_destroy agent_install_failed; echo not-reached")
    assert result.returncode != 0 and "not-reached" not in result.stdout
    assert "vastai" in result.stderr and KEY not in result.stderr


def test_emergency_destroy_without_credentials_still_exits_non_zero(tmp_path, bindir):
    log = tmp_path / "vastai.log"
    fake_vastai(bindir, log, "destroying instance 42.")
    result = source_and_run(tmp_path, "emergency_destroy x; echo not-reached", {"CONTAINER_API_KEY": ""})
    assert result.returncode != 0 and "not-reached" not in result.stdout
    assert not log.exists()


@pytest.mark.parametrize("failing", ["venv_rc", "agent_rc"])
def test_agent_install_failure_destroys_with_the_stock_cli_and_exits_non_zero(tmp_path, bindir, failing):
    log = tmp_path / "calls.log"
    fake_python3(bindir, log, **{failing: 1})
    fake_vastai(bindir, log, "destroying instance 42.")
    result = source_and_run(tmp_path, "install_runtime; echo not-reached")
    assert result.returncode != 0 and "not-reached" not in result.stdout
    calls = log.read_text().splitlines()
    assert calls[-1] == f"destroy instance 42 --api-key {KEY}"
    assert not any("vastai==" in call for call in calls)  # the pinned CLI is never attempted
    assert KEY not in result.stdout + result.stderr


def test_pinned_vastai_failure_only_sets_the_fallback(tmp_path, bindir):
    log = tmp_path / "calls.log"
    fake_python3(bindir, log, vastai_rc=1)
    fake_vastai(bindir, log, "destroying instance 42.")
    result = source_and_run(tmp_path, 'install_runtime; echo "fallback=$VASTAI_FALLBACK"')
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().splitlines()[-1] == "fallback=1"
    assert not any(call.startswith("destroy") for call in log.read_text().splitlines())


def test_successful_install_builds_the_venv_then_the_agent_then_the_pinned_cli(tmp_path, bindir):
    log = tmp_path / "calls.log"
    fake_python3(bindir, log)
    fake_vastai(bindir, log, "destroying instance 42.")
    result = source_and_run(tmp_path, 'install_runtime; echo "fallback=$VASTAI_FALLBACK py=$PY"')
    assert result.returncode == 0, result.stderr
    venv = tmp_path / "venv"
    assert result.stdout.strip().splitlines()[-1] == f"fallback=0 py={venv}/bin/python"
    assert log.read_text().splitlines() == [
        f"python3 -m venv {venv}",
        f"venv-python -m pip install -q -e {INSTANCE}/agent",
        f"venv-python -m pip install -q vastai=={schema_default('VASTAI_VERSION')}",
    ]


# --- fix round 1: failures before the failsafe runs must not leave the instance alive ---------------------

WRITE_ENV_LINE = 'ENV_FILE="$(boot write-env)" || write_env_failed $?'


def test_write_env_failure_goes_to_the_emergency_destroy_except_missing_credentials():
    assert lines()[index_of("boot write-env")].strip() == WRITE_ENV_LINE
    body = [line.strip() for line in function_body("write_env_failed")]
    assert body.index('[ "$1" -eq 10 ] && exit 10') < next(i for i, line in enumerate(body)
                                                            if line.startswith("emergency_destroy"))


def test_begin_and_init_times_hand_unhandled_codes_to_the_emergency_destroy_before_the_failsafe():
    for step, reason in (("boot begin", "begin_failed"), ("boot init-times", "init_times_failed")):
        line = lines()[index_of(step)].strip()
        assert line.endswith(f"|| pre_failsafe_failed $? {reason}"), line
        assert index_of(step) < index_of("failsafe.sh")
    body = " ".join(line.strip() for line in function_body("pre_failsafe_failed"))
    assert '11|12) exit "$1" ;;' in body and "*) emergency_destroy" in body


def test_the_pre_failsafe_handlers_are_defined_above_the_sourcing_guard():
    guard = index_of('[ "${BASH_SOURCE[0]}" = "$0" ] || return 0')
    for name in ("write_env_failed() {", "pre_failsafe_failed() {", "boot() {"):
        assert index_of(name) < guard, name


def fake_boot_venv(tmp_path, rcs):
    """A venv python whose `-m vastcomfy_agent.boot <cmd>` exits with rcs[cmd] (write-env prints a path on 0)."""
    venv_python = tmp_path / "venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True)
    cases = "".join(f"  {cmd}) exit {rc};;\n" for cmd, rc in rcs.items())
    write_exec(venv_python,
               '#!/bin/sh\n[ "$1 $2" = "-m vastcomfy_agent.boot" ] || exit 99\n'
               f'[ "$3" = write-env ] && [ {rcs.get("write-env", 0)} -eq 0 ] && echo "{tmp_path}/.env"\n'
               f'case "$3" in\n{cases}esac\nexit 0\n')


def run_script_lines(tmp_path, *fragments):
    script_lines = "\n".join(lines()[index_of(fragment)].strip() for fragment in fragments)
    return source_and_run(tmp_path, 'ENV_FILE="${ENV_FILE:-unset}"; eval "$STEPS"; echo "reached ENV_FILE=$ENV_FILE"',
                          {"STEPS": script_lines})


@pytest.mark.parametrize("rc", [13, 1, 12])
def test_a_failing_write_env_destroys_with_the_stock_cli_and_exits_non_zero(tmp_path, bindir, rc):
    log = tmp_path / "vastai.log"
    fake_vastai(bindir, log, "WARNING: deprecated\\n\\ndestroying instance 42.\\n")
    fake_boot_venv(tmp_path, {"write-env": rc})
    result = run_script_lines(tmp_path, "boot write-env")
    assert result.returncode != 0 and "reached" not in result.stdout
    assert log.read_text().splitlines() == [f"destroy instance 42 --api-key {KEY}"]
    assert KEY not in result.stdout + result.stderr


def test_missing_container_credentials_exit_10_without_a_destroy(tmp_path, bindir):
    log = tmp_path / "vastai.log"
    fake_vastai(bindir, log, "destroying instance 42.")
    fake_boot_venv(tmp_path, {"write-env": 10})
    result = run_script_lines(tmp_path, "boot write-env")
    assert result.returncode == 10 and "reached" not in result.stdout
    assert not log.exists()


def test_a_successful_write_env_continues_without_a_destroy(tmp_path, bindir):
    log = tmp_path / "vastai.log"
    fake_vastai(bindir, log, "destroying instance 42.")
    fake_boot_venv(tmp_path, {"write-env": 0})
    result = run_script_lines(tmp_path, "boot write-env")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == f"reached ENV_FILE={tmp_path}/.env"
    assert not log.exists()


@pytest.mark.parametrize("step", ["begin", "init-times"])
@pytest.mark.parametrize("rc", [13, 1])
def test_unhandled_begin_or_init_times_failures_destroy_with_the_stock_cli(tmp_path, bindir, step, rc):
    log = tmp_path / "vastai.log"
    fake_vastai(bindir, log, "destroying instance 42.")
    fake_boot_venv(tmp_path, {step: rc})
    result = run_script_lines(tmp_path, "boot begin", "boot init-times")
    assert result.returncode != 0 and "reached" not in result.stdout
    assert log.read_text().splitlines() == [f"destroy instance 42 --api-key {KEY}"]
    assert KEY not in result.stdout + result.stderr


@pytest.mark.parametrize("step", ["begin", "init-times"])
@pytest.mark.parametrize("rc", [11, 12])
def test_already_handled_begin_or_init_times_codes_exit_without_a_second_destroy(tmp_path, bindir, step, rc):
    log = tmp_path / "vastai.log"
    fake_vastai(bindir, log, "destroying instance 42.")
    fake_boot_venv(tmp_path, {step: rc})
    result = run_script_lines(tmp_path, "boot begin", "boot init-times")
    assert result.returncode == rc and "reached" not in result.stdout
    assert not log.exists()


# --- cross-task review wave ---------------------------------------------------------------------------------

DESTROY_CALL = f"destroy instance 42 --api-key {KEY}"


def sequenced_vastai(bindir, tmp_path, outputs):
    """Fake stock CLI: attempt n prints outputs[n-1] ('HANG' sleeps instead); always exits 0 like the real one."""
    count = tmp_path / "vastai.count"
    log = tmp_path / "vastai.log"
    cases = "".join(
        f"  {n}) exec sleep 30;;\n" if text == "HANG" else f"  {n}) printf '{text}';;\n"
        for n, text in enumerate(outputs, 1)
    )
    write_exec(bindir / "vastai",
               f'#!/bin/sh\nn=$(cat "{count}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "{count}"\n'
               f'printf "%s\\n" "$*" >> "{log}"\ncase "$n" in\n{cases}esac\nexit 0\n')
    return log


# I2: bounded, retried emergency destroy

def test_emergency_destroy_retries_until_a_success_text(tmp_path, bindir):
    log = sequenced_vastai(bindir, tmp_path, [f"WARNING: x\\nFailed with error 500: key {KEY} busy\\n",
                                              "WARNING: deprecated\\n\\nDestroying instance 42.\\n",
                                              "destroying instance 42.\\n"])
    result = source_and_run(tmp_path, "emergency_destroy x; echo not-reached")
    assert result.returncode != 0 and "not-reached" not in result.stdout
    assert log.read_text().splitlines() == [DESTROY_CALL] * 2
    assert KEY not in result.stdout + result.stderr


def test_emergency_destroy_stops_on_the_gone_marker(tmp_path, bindir):
    log = sequenced_vastai(bindir, tmp_path, ["Failed with error 404: Instance 42 not found.\\n"] * 3)
    result = source_and_run(tmp_path, "emergency_destroy x")
    assert result.returncode != 0
    assert log.read_text().splitlines() == [DESTROY_CALL]


def test_a_hanging_emergency_destroy_is_killed_at_the_timeout_and_retried(tmp_path, bindir):
    log = sequenced_vastai(bindir, tmp_path, ["HANG", "destroying instance 42.\\n"])
    started = time.monotonic()
    result = source_and_run(tmp_path, "emergency_destroy x", {"DESTROY_TIMEOUT_S": "1"})
    assert time.monotonic() - started < 15
    assert result.returncode != 0
    assert log.read_text().splitlines() == [DESTROY_CALL] * 2


def test_all_emergency_attempts_failing_still_exits_non_zero_without_printing_the_key(tmp_path, bindir):
    log = sequenced_vastai(bindir, tmp_path, [f"Failed with error 401: {KEY}\\n"] * 5)
    result = source_and_run(tmp_path, "emergency_destroy x; echo not-reached")
    assert result.returncode != 0 and "not-reached" not in result.stdout
    assert log.read_text().splitlines() == [DESTROY_CALL] * 3
    assert KEY not in result.stdout + result.stderr


def test_the_key_is_removed_before_the_success_text_is_matched(tmp_path, bindir):
    # "destroying instance" must start a line once the id and the key are removed from the output.
    log = sequenced_vastai(bindir, tmp_path, [f"{KEY} destroying instance 42?\\n"] * 3)
    result = source_and_run(tmp_path, "emergency_destroy x")
    assert result.returncode != 0
    assert len(log.read_text().splitlines()) == 1  # the key is stripped, so the line then starts with the marker


def test_without_vastai_on_path_the_stock_fallback_path_is_used(tmp_path, bindir):
    stock = tmp_path / "stock"
    stock.mkdir()
    log = sequenced_vastai(stock, tmp_path, ["destroying instance 42.\\n"])
    result = source_and_run(tmp_path, "emergency_destroy x", {"STOCK_VASTAI_BIN": str(stock / "vastai")})
    assert result.returncode != 0
    assert log.read_text().splitlines() == [DESTROY_CALL]


def test_emergency_destroy_static_shape():
    body = "\n".join(function_body("emergency_destroy"))
    assert '${STOCK_VASTAI_BIN:-/opt/instance-tools/bin/vastai}' in body
    assert '${DESTROY_TIMEOUT_S:-60}' in body and '${DESTROY_BACKOFF_S:-5}' in body
    assert "bounded_run" in body and " -y" not in body
    helper = "\n".join(function_body("bounded_run"))
    assert "kill -0" in helper and "kill -9" in helper and "sleep 1" in helper and "timeout " not in helper


# I1: dead failsafe, env-export failure, runtime binaries

def test_a_dead_failsafe_also_runs_the_emergency_destroy():
    assert lines()[index_of('kill -0 "$FAILSAFE_PID"')].strip() == \
        'kill -0 "$FAILSAFE_PID" 2>/dev/null || failsafe_failed_closed'
    body = [line.strip() for line in function_body("failsafe_failed_closed")]
    assert body.index("HANDLED=1") < next(i for i, l in enumerate(body) if l.startswith("boot fail failsafe_failed"))
    assert next(i for i, l in enumerate(body) if l.startswith("boot fail failsafe_failed")) < \
        next(i for i, l in enumerate(body) if l.startswith("emergency_destroy failsafe_failed"))


def test_failsafe_failed_closed_runs_boot_fail_then_the_stock_cli(tmp_path, bindir):
    log = sequenced_vastai(bindir, tmp_path, ["destroying instance 42.\\n"])
    fake_boot_venv(tmp_path, {"fail": 12})
    boot_log = tmp_path / "boot.log"
    venv_python = tmp_path / "venv" / "bin" / "python"
    venv_python.write_text(venv_python.read_text().replace("#!/bin/sh\n", f'#!/bin/sh\necho "$*" >> "{boot_log}"\n', 1))
    result = source_and_run(tmp_path, 'ENV_FILE=/x/.env; failsafe_failed_closed; echo "not-reached"')
    assert result.returncode != 0 and "not-reached" not in result.stdout
    assert boot_log.read_text().splitlines() == ["-m vastcomfy_agent.boot fail failsafe_failed --env-file /x/.env"]
    assert log.read_text().splitlines() == [DESTROY_CALL]


def test_env_export_failure_is_explicit():
    text = SCRIPT.read_text()
    assert 'eval "$(boot env-export' not in text
    line = lines()[index_of("boot env-export")].strip()
    assert line == 'EXPORTS="$(boot env-export --env-file "$ENV_FILE")" || emergency_destroy env_export_failed'
    assert lines()[index_of("boot env-export") + 1].strip().startswith('eval "$EXPORTS"')


def test_a_failing_env_export_destroys_with_the_stock_cli(tmp_path, bindir):
    log = sequenced_vastai(bindir, tmp_path, ["destroying instance 42.\\n"])
    fake_boot_venv(tmp_path, {"env-export": 1})
    result = run_script_lines(tmp_path, "boot env-export")
    assert result.returncode != 0 and "reached" not in result.stdout
    assert log.read_text().splitlines() == [DESTROY_CALL]


def test_runtime_binaries_are_cross_checked_before_the_failsafe():
    check = index_of("check_runtime_binaries || emergency_destroy runtime_binaries_missing")
    assert index_of("boot env-export") < check < index_of("failsafe.sh")
    body = " ".join(function_body("check_runtime_binaries"))
    assert 'command -v "$VASTAI_BIN"' in body and 'command -v "$AGENT_PYTHON"' in body


@pytest.mark.parametrize("vastai,agent,ok", [
    ("{bin}/vastai", "{bin}/python3", True), ("vastai", "python3", True),
    ("{tmp}/missing/vastai", "{bin}/python3", False), ("{bin}/vastai", "{tmp}/plain-file", False),
    ("no-such-cli", "python3", False),
])
def test_check_runtime_binaries_resolves_names_and_paths(tmp_path, bindir, vastai, agent, ok):
    write_exec(bindir / "vastai", "#!/bin/sh\n")
    write_exec(bindir / "python3", "#!/bin/sh\n")
    (tmp_path / "plain-file").write_text("not executable")
    fill = {"bin": bindir, "tmp": tmp_path}
    result = source_and_run(tmp_path, "check_runtime_binaries && echo ok || echo missing",
                            {"VASTAI_BIN": vastai.format(**fill), "AGENT_PYTHON": agent.format(**fill)})
    assert result.stdout.strip() == ("ok" if ok else "missing"), result.stderr


# I3: wait for the image supervisord

def test_supervisord_is_waited_for_before_the_programs_are_registered():
    wait = index_of("wait_for_supervisor || die_with supervisor_failed")
    assert index_of('kill -0 "$FAILSAFE_PID"') < wait < index_of("render-supervisor-conf") < index_of("ctl reread")
    body = " ".join(function_body("wait_for_supervisor"))
    assert "ctl pid" in body and "$SUPERVISOR_WAIT_S" in body and "sleep 1" in body


def test_supervisor_wait_is_a_schema_key():
    from vastcomfy_agent.config import load_schema

    spec = next(s for s in load_schema() if s.name == "SUPERVISOR_WAIT_S")
    assert spec.components == ("instance",) and spec.type == "int" and spec.default == 120 and spec.min == 1
    assert not spec.secret and not spec.required and "S1" in spec.description


def fake_supervisorctl(bindir, tmp_path, failures, ok_output="603"):
    count = tmp_path / "sctl.count"
    return write_exec(bindir / "sctl",
                      f'#!/bin/sh\necho "$*" >> "{tmp_path}/sctl.log"\n'
                      f'n=$(cat "{count}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "{count}"\n'
                      f'if [ "$n" -le {failures} ]; then echo "unix:///var/run/supervisor.sock no such file"; exit 2; fi\n'
                      f'echo "{ok_output}"\n')


def supervisor_env(bindir, wait_s):
    return {"SUPERVISORCTL_BIN": str(bindir / "sctl"), "SUPERVISOR_CONF": "/x/supervisord.conf",
            "SUPERVISOR_WAIT_S": str(wait_s)}


def test_wait_for_supervisor_succeeds_once_the_daemon_answers(tmp_path, bindir):
    fake_supervisorctl(bindir, tmp_path, failures=2)
    result = source_and_run(tmp_path, "wait_for_supervisor && echo up", supervisor_env(bindir, 10))
    assert result.stdout.strip() == "up", result.stderr
    assert (tmp_path / "sctl.log").read_text().splitlines() == ["-c /x/supervisord.conf pid"] * 3


@pytest.mark.parametrize("ok_output", ["603", "unix:///var/run/supervisor.sock refused connection"])
def test_wait_for_supervisor_gives_up_after_supervisor_wait_s(tmp_path, bindir, ok_output):
    # supervisorctl 3.x exits 0 even when it cannot connect, so only a numeric pid counts as up.
    fake_supervisorctl(bindir, tmp_path, failures=100 if ok_output == "603" else 0, ok_output=ok_output)
    started = time.monotonic()
    result = source_and_run(tmp_path, "wait_for_supervisor && echo up || echo gave-up", supervisor_env(bindir, 2))
    assert time.monotonic() - started < 10
    assert result.stdout.strip() == "gave-up"
    assert 2 <= len((tmp_path / "sctl.log").read_text().splitlines()) <= 4


# I5: ComfyUI-Manager re-checked before the ComfyUI restart

def test_manager_is_rechecked_right_before_the_comfyui_restart():
    check = index_of("disable_comfy_manager || die_with comfyui_start_failed")
    assert index_of("copy-workflows") < check < index_of('restart "$COMFY_PROGRAM"')
    assert check + 1 == index_of('restart "$COMFY_PROGRAM"')


def comfy_tree(tmp_path, manager=True, stale=False):
    nodes = tmp_path / "ComfyUI" / "custom_nodes"
    nodes.mkdir(parents=True)
    if manager:
        (nodes / "ComfyUI-Manager").mkdir()
        (nodes / "ComfyUI-Manager" / "__init__.py").write_text("")
    if stale:
        (nodes / "ComfyUI-Manager.disabled").mkdir()
        (nodes / "ComfyUI-Manager.disabled" / "old").write_text("")
    return nodes


@pytest.mark.parametrize("stale", [False, True])
def test_disable_comfy_manager_renames_a_present_manager(tmp_path, bindir, stale):
    nodes = comfy_tree(tmp_path, stale=stale)
    result = source_and_run(tmp_path, "disable_comfy_manager && echo done", {"COMFY_DIR": str(tmp_path / "ComfyUI")})
    assert result.stdout.strip() == "done", result.stderr
    assert not (nodes / "ComfyUI-Manager").exists()
    assert sorted(p.name for p in (nodes / "ComfyUI-Manager.disabled").iterdir()) == ["__init__.py"]
    assert len([l for l in result.stderr.splitlines() if "ComfyUI-Manager" in l]) == 1
    assert "found" in result.stderr


def test_disable_comfy_manager_logs_an_absent_manager(tmp_path, bindir):
    comfy_tree(tmp_path, manager=False)
    result = source_and_run(tmp_path, "disable_comfy_manager && echo done", {"COMFY_DIR": str(tmp_path / "ComfyUI")})
    assert result.stdout.strip() == "done"
    assert len([l for l in result.stderr.splitlines() if "ComfyUI-Manager" in l]) == 1 and "absent" in result.stderr


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_disable_comfy_manager_fails_when_the_rename_fails(tmp_path, bindir):
    nodes = comfy_tree(tmp_path)
    nodes.chmod(0o555)
    try:
        result = source_and_run(tmp_path, "disable_comfy_manager && echo done || echo failed",
                                {"COMFY_DIR": str(tmp_path / "ComfyUI")})
    finally:
        nodes.chmod(0o755)
    assert result.stdout.strip() == "failed"
    assert (nodes / "ComfyUI-Manager").exists()


# --- Tailscale install (S2) ---------------------------------------------------------------------------------

def test_tailscale_is_installed_after_the_failsafe_and_before_its_supervisor_program_is_registered():
    assert index_of('kill -0 "$FAILSAFE_PID"') < index_of("install_tailscale ||") < index_of("render-supervisor-conf")
    assert "die_with tailscale_failed" in lines()[index_of("install_tailscale ||")]


def test_tailscale_serve_is_gone():
    text = "\n".join(code_lines())
    assert "serve" not in text and "TS_SERVE_ENABLED" not in text


def tailscale_env(tmp_path, **extra):
    env = {
        "TAILSCALE_DIR": str(tmp_path / "ts"), "TAILSCALE_BIN": str(tmp_path / "ts" / "tailscale"),
        "TAILSCALED_BIN": str(tmp_path / "ts" / "tailscaled"), "TAILSCALE_VERSION": "9.9.9",
        "TAILSCALE_URL_BASE": "https://pkgs.example/stable", "TAILSCALE_INSTALL_TIMEOUT_S": "5",
    }
    env.update(extra)
    return env


def fake_curl(bindir, log, *, rc=0, hang=False):
    """Writes a real tarball (dir tailscale_9.9.9_amd64/{tailscale,tailscaled}) to the -o target."""
    body = (
        '#!/bin/sh\n'
        f'printf "curl %s\\n" "$*" >> "{log}"\n'
        + ('sleep 30\n' if hang else '')
        + f'[ {rc} -eq 0 ] || {{ echo "curl: (22) 404" >&2; exit {rc}; }}\n'
        'while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\n'
        'd="$(mktemp -d)"; mkdir "$d/tailscale_9.9.9_amd64"\n'
        'for b in tailscale tailscaled; do printf "#!/bin/sh\\n" > "$d/tailscale_9.9.9_amd64/$b"; '
        'chmod 755 "$d/tailscale_9.9.9_amd64/$b"; done\n'
        'tar -czf "$out" -C "$d" tailscale_9.9.9_amd64\n'
    )
    return write_exec(bindir / "curl", body)


def test_install_tailscale_downloads_the_pinned_tarball_and_extracts_the_binaries(tmp_path, bindir):
    log = tmp_path / "calls.log"
    fake_curl(bindir, log, rc=0)
    result = source_and_run(tmp_path, "install_tailscale && echo done", tailscale_env(tmp_path))
    assert result.stdout.strip() == "done", result.stderr
    assert (tmp_path / "ts" / "tailscaled").stat().st_mode & 0o111
    assert (tmp_path / "ts" / "tailscale").stat().st_mode & 0o111
    assert "https://pkgs.example/stable/tailscale_9.9.9_" in log.read_text()


def test_install_tailscale_skips_the_download_when_the_binaries_exist(tmp_path, bindir):
    log = tmp_path / "calls.log"
    fake_curl(bindir, log, rc=0)
    ts = tmp_path / "ts"
    ts.mkdir()
    write_exec(ts / "tailscale", "#!/bin/sh\n")
    write_exec(ts / "tailscaled", "#!/bin/sh\n")
    result = source_and_run(tmp_path, "install_tailscale && echo done", tailscale_env(tmp_path))
    assert result.stdout.strip() == "done" and not log.exists()


def test_install_tailscale_fails_when_the_download_fails(tmp_path, bindir):
    fake_curl(bindir, tmp_path / "calls.log", rc=22)
    result = source_and_run(tmp_path, "install_tailscale && echo done || echo failed", tailscale_env(tmp_path))
    assert result.stdout.strip() == "failed" and not (tmp_path / "ts" / "tailscaled").exists()


def test_install_tailscale_fails_when_the_download_hangs(tmp_path, bindir):
    fake_curl(bindir, tmp_path / "calls.log", hang=True)
    started = time.monotonic()
    result = source_and_run(tmp_path, "install_tailscale && echo done || echo failed",
                            tailscale_env(tmp_path, TAILSCALE_INSTALL_TIMEOUT_S="1"))
    assert result.stdout.strip() == "failed" and time.monotonic() - started < 15


# --- boot step markers and the early network probe (step net_probe) -----------------------------------------

CONSOLE_TS = INSTANCE.parent / "apps" / "core" / "src" / "console.ts"
STEP_IDS = ["net_probe", "install_tools", "failsafe", "tailscale", "agent", "nodes", "models", "comfyui", "ready"]


def script_step_ids():
    line = lines()[index_of("BOOT_STEP_IDS=")].strip()
    return line.split("=", 1)[1].strip('"').split()


def test_the_step_list_equals_the_web_boot_steps_and_the_documented_list():
    block = CONSOLE_TS.read_text().split("export const BOOT_STEPS = [", 1)[1].split("] as const;", 1)[0]
    assert re.findall(r'id: "([a-z_]+)"', block) == script_step_ids() == STEP_IDS


def test_every_step_marker_is_printed_once_in_order_before_its_step():
    calls = [line.strip().split()[1] for line in code_lines() if re.match(r"\s*boot_step [a-z_]+$", line)]
    assert calls == STEP_IDS
    order = [index_of("boot_step net_probe"), index_of("net_probe || emergency_destroy slow_network"),
             index_of("boot_step install_tools"), index_of_call("install_runtime"), index_of("write-env"),
             index_of("boot_step failsafe"), index_of("boot begin"), index_of("boot_step tailscale"),
             index_of("install_tailscale ||"), index_of("boot_step agent"), index_of("ctl start agent"),
             index_of("boot_step nodes"), index_of("install-nodes"), index_of("boot_step models"),
             index_of("install-models"), index_of("boot_step comfyui"), index_of("copy-workflows"),
             index_of("mark-ready"), index_of("BOOT_DONE=1"), index_of("boot_step ready")]
    assert order == sorted(order) and len(set(order)) == len(order)


def test_the_probe_runs_first_and_a_slow_network_ends_in_the_stock_cli_destroy_with_its_own_code():
    guard = index_of('[ "${BASH_SOURCE[0]}" = "$0" ] || return 0')
    assert guard < index_of("boot_step net_probe") < index_of_call("install_runtime")
    assert lines()[index_of("net_probe || emergency_destroy")].strip() == \
        'net_probe || emergency_destroy slow_network "$EXIT_SLOW_NETWORK"'
    from vastcomfy_agent.boot import EXIT_CONFIG, EXIT_SLOW_NETWORK

    assert f"EXIT_SLOW_NETWORK={EXIT_SLOW_NETWORK}" in SCRIPT.read_text() and EXIT_SLOW_NETWORK == EXIT_CONFIG + 1


def test_the_probe_sends_no_token_and_names_no_url():
    body = "\n".join(function_body("net_probe") + function_body("net_probe_measure") + function_body("net_probe_url"))
    assert "HF_TOKEN" not in body and "Authorization" not in body
    assert not any("console_line" in line and "$url" in line for line in function_body("net_probe"))


def probe_curl(bindir, tmp_path, answers):
    """Fake curl: call n prints answers[n-1] = (write_out, rc) (printf %b: \n are line breaks) and exits rc."""
    count = tmp_path / "curl.count"
    log = tmp_path / "curl.log"
    cases = "".join(f"  {n}) printf '%b' '{out}'; exit {rc};;\n" for n, (out, rc) in enumerate(answers, 1))
    write_exec(bindir / "curl",
               f'#!/bin/sh\nn=$(cat "{count}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "{count}"\n'
               f'printf "%s\\n" "$*" >> "{log}"\ncase "$n" in\n{cases}esac\nexit 0\n')
    return log


def probe_env(tmp_path, **extra):
    env = {"PROFILE": "image", "STATE_DIR": str(tmp_path / "state"), "COMFY_DIR": str(tmp_path / "comfy")}
    env.update(extra)
    return env


def run_probe(tmp_path, bindir, answers, snippet="net_probe; echo rc=$?", **env):
    os.symlink(sys.executable, bindir / "python3")
    log = probe_curl(bindir, tmp_path, answers)
    sink = tmp_path / "pid1.log"
    sink.write_text("")
    result = source_and_run(tmp_path, f'NET_PROBE_RETRY_S=0; BOOT_LOG_SINK="{sink}"; {snippet}', probe_env(tmp_path, **env))
    calls = log.read_text().splitlines() if log.exists() else []
    return result, calls, sink.read_text()


HALF = 25165824  # the default 48 MiB range in two halves over one connection


def two(first, second, rc=0):
    """curl's write-out for the two halves (code size time_starttransfer time_total), and its exit code."""
    return (f"{first}\\n{second}\\n", rc)


WARM = f"206 {HALF} 0.500 1.800"  # the first half, slowed by TCP slow start (19 MB/s)
FAST = two(WARM, f"206 {HALF} 0.050 0.5076")   # second half about 55 MB/s (the healthy Quebec boot)
SLOW = two(f"206 {HALF} 0.500 9.500", f"206 {HALF} 0.050 9.038")   # about 2.8 MB/s (the Lithuania boot)


def test_a_fast_network_passes_measured_on_the_warm_second_half_of_the_largest_files_repo(tmp_path, bindir):
    result, calls, sink = run_probe(tmp_path, bindir, [FAST])
    assert result.stdout.strip().splitlines()[-1] == "rc=0", result.stderr
    assert len(calls) == 1
    call = calls[0]
    assert "-r 0-25165823" in call and "--next" in call and "-r 25165824-50331647" in call
    assert call.count("--max-time 31") == 2 and call.count("-L") == 2
    # The largest pinned model (the text encoder): the repo and CDN path of the big downloads.
    url = ("https://huggingface.co/0xSojalSec/Qwen-Image-2.1-Uncensored-HF/resolve/"
           "d94be5d7a09b47b0211b03d0f23d20bc18203358/text_encoders/qwen3vl_8b_int8_convrot.safetensors")
    assert call.count(url) == 2
    assert sink.splitlines() == ["[boot] net_probe: measured 55.0 MB/s (minimum 6 MB/s)"]


def test_slow_start_alone_never_fails_a_healthy_link(tmp_path, bindir):
    # A 55 MB/s link with a long RTT reads about 19.6 MB/s over its first 24 MiB; only the second half counts.
    result, calls, _ = run_probe(tmp_path, bindir, [two(f"206 {HALF} 0.500 1.784", f"206 {HALF} 0.050 1.334")])
    assert result.stdout.strip().splitlines()[-1] == "rc=0"
    assert "measured 19.6 MB/s" in result.stdout


def test_a_slow_network_is_retried_once_and_then_reported(tmp_path, bindir):
    result, calls, _ = run_probe(tmp_path, bindir, [SLOW, SLOW])
    assert result.stdout.strip().splitlines()[-1] == "rc=1"
    assert len(calls) == 2
    assert result.stdout.count("[boot] net_probe: measured 2.8 MB/s (minimum 6 MB/s)") == 2


def test_a_transient_dip_passes_on_the_retry(tmp_path, bindir):
    result, calls, _ = run_probe(tmp_path, bindir, [SLOW, FAST])
    assert result.stdout.strip().splitlines()[-1] == "rc=0" and len(calls) == 2


def test_a_cut_slow_transfer_measures_the_link_when_enough_body_arrived(tmp_path, bindir):
    # Timed out (28) after 3 s of body: a valid sample of a slow link.
    result, _, _ = run_probe(tmp_path, bindir, [two(f"206 {HALF} 0.5 31.0", "206 3000000 0.5 3.5", 28)] * 2)
    assert result.stdout.strip().splitlines()[-1] == "rc=1"
    assert "measured 1.0 MB/s" in result.stdout


@pytest.mark.parametrize("answer", [
    ("000 0 0 0\\n", 6), two(WARM, "403 0 0.2 0.2"), two(WARM, "206 0 0 31.0", 28),
    two(WARM, "206 1000000 0.5 1.5", 28),  # timed out with under 4 MiB and under 2 s of body: no sample
    two(WARM, "206 1000 0.1 0.2"), ("garbage\\n", 0), (f"{WARM}\\n", 0), two(WARM, "200 x"),
])
def test_a_probe_malfunction_is_a_warning_and_the_boot_goes_on(tmp_path, bindir, answer):
    result, calls, sink = run_probe(tmp_path, bindir, [answer, answer])
    assert result.stdout.strip().splitlines()[-1] == "rc=0"
    assert len(calls) == 1
    assert "warning: network probe failed" in result.stderr
    assert "FAILED" not in result.stdout + sink


@pytest.mark.parametrize("env,warning", [
    ({"NET_PROBE_MIN_MBPS": "0"}, "network probe off"),
    ({"NET_PROBE_BYTES": "12x"}, "NET_PROBE_BYTES is not a number"),
    ({"NET_PROBE_MIN_MBPS": "-1"}, "NET_PROBE_MIN_MBPS is not a number"),
    ({"NET_PROBE_BYTES": "2097151"}, "below 2 MiB"),
    ({"PROFILE": "no-such-profile"}, "no pinned model file"),
    ({"PROFILE": ""}, "no pinned model file"),
    ({"HF_BASE_URL": "ftp://x"}, "no pinned model file"),
])
def test_the_probe_is_skipped_without_a_download_when_off_or_misconfigured(tmp_path, bindir, env, warning):
    result, calls, _ = run_probe(tmp_path, bindir, [SLOW], **env)
    assert result.stdout.strip().splitlines()[-1] == "rc=0"
    assert calls == [] and warning in result.stderr


def test_a_container_restart_never_probes(tmp_path, bindir):
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "first_boot_at").write_text("1800000000\n")
    result, calls, _ = run_probe(tmp_path, bindir, [SLOW, SLOW])
    assert result.stdout.strip().splitlines()[-1] == "rc=0"
    assert calls == [] and "container restart" in result.stderr


def test_with_every_pinned_model_already_present_it_never_probes(tmp_path, bindir):
    import yaml

    profile = yaml.safe_load((INSTANCE / "profiles" / "image.yaml").read_text())
    for m in profile["models"]:
        target = tmp_path / "comfy" / m["dest"] / Path(m["file"]).name
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "wb") as handle:
            handle.truncate(m["size_bytes"])  # sparse: right size, no disk
    result, calls, _ = run_probe(tmp_path, bindir, [SLOW, SLOW])
    assert result.stdout.strip().splitlines()[-1] == "rc=0"
    assert calls == [] and "models already present" in result.stderr


def test_one_model_missing_still_probes(tmp_path, bindir):
    result, calls, _ = run_probe(tmp_path, bindir, [FAST])
    assert len(calls) == 1


def test_without_curl_the_probe_is_skipped(tmp_path, bindir):
    only = tmp_path / "only"
    only.mkdir()
    for tool in ("awk", "cut", "tr"):
        os.symlink(shutil.which(tool), only / tool)
    os.symlink(sys.executable, only / "python3")
    result = source_and_run(tmp_path, f'PATH="{only}"; net_probe; echo rc=$?', probe_env(tmp_path))
    assert result.stdout.strip().splitlines()[-1] == "rc=0"
    assert "curl or awk missing" in result.stderr


def test_console_line_never_blocks_on_a_sink_without_a_reader(tmp_path, bindir):
    fifo = tmp_path / "pid1"
    os.mkfifo(fifo)  # opening it for writing blocks until a reader comes: none ever does
    started = time.monotonic()
    result = source_and_run(tmp_path, f'BOOT_LOG_SINK="{fifo}"; console_line hello; console_line again; echo rc=$?')
    assert time.monotonic() - started < 10
    assert result.stdout.splitlines() == ["hello", "again", "rc=0"]


def test_slow_network_prints_the_failed_marker_and_destroys_with_the_stock_cli_and_code_14(tmp_path, bindir):
    vlog = sequenced_vastai(bindir, tmp_path, ["destroying instance 42.\\n"])
    result, calls, sink = run_probe(
        tmp_path, bindir, [SLOW, SLOW], snippet='net_probe || emergency_destroy slow_network "$EXIT_SLOW_NETWORK"; echo not-reached')
    assert result.returncode == 14 and "not-reached" not in result.stdout
    assert vlog.read_text().splitlines() == [DESTROY_CALL]
    assert "[boot] FAILED: slow_network" in result.stdout.splitlines()
    assert sink.splitlines()[-1] == "[boot] FAILED: slow_network"
    assert "measured 2.8 MB/s" in sink
    assert KEY not in result.stdout + result.stderr + sink


def test_console_line_survives_an_unwritable_sink(tmp_path, bindir):
    result = source_and_run(tmp_path, f'BOOT_LOG_SINK="{tmp_path}/missing/dir/x"; console_line hello; echo rc=$?')
    assert result.stdout.splitlines() == ["hello", "rc=0"] and result.stderr == ""


def test_step_markers_and_the_failed_marker_follow_the_web_grammar(tmp_path, bindir):
    sink = tmp_path / "pid1.log"
    sink.write_text("")
    snippet = (f'BOOT_LOG_SINK="{sink}"; boot_step net_probe; boot_step models; boot_step ready; boot_step unknown; '
               'boot_failed_marker "write_env_failed (exit 13)"; boot_failed_marker other')
    result = source_and_run(tmp_path, snippet)
    expected = ["[boot] step 1/9: net_probe", "[boot] step 7/9: models", "[boot] step 9/9: ready",
                "[boot] FAILED: write_env_failed"]
    assert result.stdout.splitlines() == expected and sink.read_text().splitlines() == expected
    for line in expected:
        assert re.fullmatch(r"\[boot\] step [1-9]/9: [a-z_]{1,32}|\[boot\] FAILED: [a-z0-9_]{1,64}", line)


def test_emergency_destroy_prints_one_failed_marker(tmp_path, bindir):
    sequenced_vastai(bindir, tmp_path, ["destroying instance 42.\\n"])
    result = source_and_run(tmp_path, f'BOOT_LOG_SINK="{tmp_path}/none"; emergency_destroy "env_export_failed (x)"')
    assert result.returncode == 1
    assert [l for l in result.stdout.splitlines() if l.startswith("[boot]")] == ["[boot] FAILED: env_export_failed"]


# --- custom image: skip the installs the image already baked (instance/image/Dockerfile) -----------------------

def image_marker(tmp_path, **overrides):
    """A marker as the custom image writes it, for a venv at tmp/venv and Tailscale at tmp/ts."""
    from vastcomfy_agent import image_marker as im

    values = {"schema": 1, "base_image": schema_default("VAST_IMAGE"),
              "vastai_version": schema_default("VASTAI_VERSION"), "tailscale_version": "9.9.9",
              "venv_dir": str(tmp_path / "venv"), "tailscale_dir": str(tmp_path / "ts"),
              "agent_deps_hash": im.deps_hash(im.agent_deps((INSTANCE / "agent" / "pyproject.toml").read_text()))}
    values.update(overrides)
    path = tmp_path / "vastcomfy-image.json"
    path.write_text(json.dumps({k: v for k, v in values.items() if v is not None}))
    return path


def baked_venv(tmp_path, log, **rcs):
    venv = tmp_path / "venv" / "bin"
    venv.mkdir(parents=True)
    write_exec(venv / "python", fake_venv_python(log, **rcs))
    write_exec(venv / "vastai", "#!/bin/sh\n")
    return venv


def path_lines(result, step):
    return [line for line in result.stderr.splitlines() if line.startswith(f"bootstrap: {step}:")]



def full_install_calls(tmp_path):
    venv = tmp_path / "venv"
    return [f"python3 -m venv {venv}", f"venv-python -m pip install -q -e {INSTANCE}/agent",
            f"venv-python -m pip install -q vastai=={schema_default('VASTAI_VERSION')}"]


def test_a_baked_runtime_only_links_the_agent_offline(tmp_path, bindir):
    log = tmp_path / "calls.log"
    fake_python3(bindir, log)
    baked_venv(tmp_path, log)
    result = source_and_run(tmp_path, 'install_runtime; echo "fallback=$VASTAI_FALLBACK"', marker=image_marker(tmp_path))
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().splitlines()[-1] == "fallback=0"
    assert log.read_text().splitlines() == [
        f"venv-python -m pip install -q --no-index --no-deps --no-build-isolation -e {INSTANCE}/agent"]
    lines_ = path_lines(result, "install_tools")
    assert len(lines_) == 1 and "baked image" in lines_[0], result.stderr


@pytest.mark.parametrize("case", ["missing_marker", "corrupt_marker", "other_vastai", "configured_vastai",
                                  "deps_changed", "other_venv", "no_python", "python_not_executable",
                                  "no_vastai", "vastai_not_executable", "offline_install_fails"])
def test_anything_short_of_a_matching_bake_installs_at_boot_as_before(tmp_path, bindir, case):
    log = tmp_path / "calls.log"
    fake_python3(bindir, log)
    venv = baked_venv(tmp_path, log, offline_rc=1 if case == "offline_install_fails" else 0)
    marker = image_marker(tmp_path, **{"other_vastai": {"vastai_version": "0.0.1"},
                                       "deps_changed": {"agent_deps_hash": "0123456789ab"},
                                       "other_venv": {"venv_dir": "/elsewhere"}}.get(case, {}))
    env = {}
    if case == "missing_marker":
        marker.unlink()
    elif case == "corrupt_marker":
        marker.write_text("{not json")
    elif case == "configured_vastai":
        env["VASTAI_VERSION"] = "9.9.9"
    elif case == "no_python":
        (venv / "python").unlink()
    elif case == "python_not_executable":
        (venv / "python").chmod(0o644)
    elif case == "no_vastai":
        (venv / "vastai").unlink()
    elif case == "vastai_not_executable":
        (venv / "vastai").chmod(0o644)
    result = source_and_run(tmp_path, 'install_runtime; echo "fallback=$VASTAI_FALLBACK"', env, marker=marker)
    assert result.returncode == 0, result.stderr
    calls = [c for c in log.read_text().splitlines() if "--no-index" not in c]
    expected = full_install_calls(tmp_path)
    if case == "configured_vastai":
        expected[-1] = "venv-python -m pip install -q vastai==9.9.9"
    assert calls == expected
    lines_ = path_lines(result, "install_tools")
    assert len(lines_) == 1 and "installing at boot" in lines_[0], result.stderr


def test_the_stock_image_never_runs_the_marker_helper(tmp_path, bindir):
    log = tmp_path / "calls.log"
    fake_python3(bindir, log)
    result = source_and_run(tmp_path, "install_runtime")
    assert result.returncode == 0, result.stderr
    assert log.read_text().splitlines() == full_install_calls(tmp_path)
    assert path_lines(result, "install_tools") == ["bootstrap: install_tools: installing at boot (no image marker)"]


def test_a_broken_marker_helper_never_fails_the_boot(tmp_path, bindir):
    log = tmp_path / "calls.log"
    fake_python3(bindir, log)
    baked_venv(tmp_path, log)
    # python3 -I fails outright (for example a Python without a working standard library)
    script = (bindir / "python3").read_text().replace(f'exec "{sys.executable}" "$@"', "exit 70")
    write_exec(bindir / "python3", script)
    result = source_and_run(tmp_path, "install_runtime; echo alive", marker=image_marker(tmp_path))
    assert result.stdout.strip().splitlines()[-1] == "alive"
    assert [c for c in log.read_text().splitlines() if "--no-index" not in c] == full_install_calls(tmp_path)


def baked_tailscale(tmp_path, *, missing=None, not_executable=None):
    ts = tmp_path / "ts"
    ts.mkdir()
    for name in ("tailscale", "tailscaled"):
        if name != missing:
            write_exec(ts / name, "#!/bin/sh\n").chmod(0o644 if name == not_executable else 0o755)
    return ts


def python3_delegate(bindir):
    write_exec(bindir / "python3", f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')


def test_a_baked_tailscale_of_the_configured_version_is_used_without_a_download(tmp_path, bindir):
    log = tmp_path / "calls.log"
    fake_curl(bindir, log)
    python3_delegate(bindir)
    baked_tailscale(tmp_path)
    result = source_and_run(tmp_path, "install_tailscale && echo done", tailscale_env(tmp_path),
                            marker=image_marker(tmp_path))
    assert result.stdout.strip() == "done" and not log.exists(), result.stderr
    lines_ = path_lines(result, "tailscale")
    assert len(lines_) == 1 and "baked image" in lines_[0] and "9.9.9" in lines_[0]


@pytest.mark.parametrize("case", ["other_version", "missing_binary", "binary_not_executable"])
def test_a_stale_or_incomplete_baked_tailscale_is_downloaded(tmp_path, bindir, case):
    log = tmp_path / "calls.log"
    fake_curl(bindir, log)
    python3_delegate(bindir)
    baked_tailscale(tmp_path, missing="tailscaled" if case == "missing_binary" else None,
                    not_executable="tailscale" if case == "binary_not_executable" else None)
    marker = image_marker(tmp_path, **({"tailscale_version": "9.9.8"} if case == "other_version" else {}))
    result = source_and_run(tmp_path, "install_tailscale && echo done", tailscale_env(tmp_path), marker=marker)
    assert result.stdout.strip() == "done", result.stderr
    assert "https://pkgs.example/stable/tailscale_9.9.9_" in log.read_text()
    assert (tmp_path / "ts" / "tailscaled").stat().st_mode & 0o111 and (tmp_path / "ts" / "tailscale").stat().st_mode & 0o111
    lines_ = path_lines(result, "tailscale")
    assert len(lines_) == 1 and "downloading at boot" in lines_[0], result.stderr


@pytest.mark.parametrize("case", ["missing_marker", "corrupt_marker", "other_dir"])
def test_without_a_vouching_marker_tailscale_behaves_as_before(tmp_path, bindir, case):
    """Today's rule: reuse binaries that are there (a container restart), else download."""
    log = tmp_path / "calls.log"
    fake_curl(bindir, log)
    python3_delegate(bindir)
    baked_tailscale(tmp_path)
    marker = image_marker(tmp_path, **({"tailscale_dir": "/elsewhere"} if case == "other_dir" else {}))
    if case == "missing_marker":
        marker.unlink()
    elif case == "corrupt_marker":
        marker.write_text("[]")
    result = source_and_run(tmp_path, "install_tailscale && echo done", tailscale_env(tmp_path), marker=marker)
    assert result.stdout.strip() == "done" and not log.exists(), result.stderr
    lines_ = path_lines(result, "tailscale")
    assert len(lines_) == 1 and "existing install reused" in lines_[0], result.stderr


def test_the_stock_image_tailscale_download_prints_its_path(tmp_path, bindir):
    log = tmp_path / "calls.log"
    fake_curl(bindir, log)
    result = source_and_run(tmp_path, "install_tailscale && echo done", tailscale_env(tmp_path))
    assert result.stdout.strip() == "done"
    assert path_lines(result, "tailscale") == ["bootstrap: tailscale: downloading at boot (no image marker)"]


def test_the_marker_path_is_a_fixed_path_outside_workspace():
    line = lines()[index_of("IMAGE_MARKER=")].strip()
    assert line.startswith("IMAGE_MARKER=/opt/") and "/workspace" not in line and "${" not in line
