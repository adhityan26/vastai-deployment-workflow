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
    assert "HANDLED=1" in body and "exit 1" in body
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


@pytest.mark.parametrize("key", ["VENV_DIR", "VASTAI_VERSION"])
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


def fake_python3(bindir, log, *, venv_rc=0, agent_rc=0, vastai_rc=0):
    """python3 -m venv DIR creates DIR/bin/python; that python records pip calls and fails as asked."""
    venv_python = (
        '#!/bin/sh\n'
        f'printf "venv-python %s\\n" "$*" >> "{log}"\n'
        f'case "$*" in *" -e "*) exit {agent_rc};; *vastai==*) exit {vastai_rc};; esac\n'
        'exit 0\n'
    )
    script = (
        '#!/bin/sh\n'
        f'printf "python3 %s\\n" "$*" >> "{log}"\n'
        f'[ "$1 $2" = "-m venv" ] || exit 1\n'
        f'[ {venv_rc} -eq 0 ] || exit {venv_rc}\n'
        'mkdir -p "$3/bin"\n'
        f"cat > \"$3/bin/python\" <<'EOF'\n{venv_python}EOF\n"
        'chmod 755 "$3/bin/python"\n'
    )
    return write_exec(bindir / "python3", script)


def source_and_run(tmp_path, snippet, extra_env=None):
    bindir = tmp_path / "bin"
    env = {
        "PATH": f"{bindir}:/usr/bin:/bin", "HOME": str(tmp_path), "VENV_DIR": str(tmp_path / "venv"),
        "CONTAINER_ID": "42", "CONTAINER_API_KEY": KEY, "DESTROY_BACKOFF_S": "0",
        "STOCK_VASTAI_BIN": str(tmp_path / "no-stock-vastai"),
    }
    env.update(extra_env or {})
    return subprocess.run([BASH, "-c", f'. "$1"; {snippet}', "_", str(SCRIPT)], env=env, capture_output=True,
                          text=True, timeout=30, cwd=tmp_path)


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
