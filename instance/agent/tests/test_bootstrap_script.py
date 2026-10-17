import os
import re
import shutil
import subprocess
import sys
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
        index_of("boot begin"), index_of("init-times"), index_of("failsafe.sh"), index_of("kill -0"),
        index_of("render-supervisor-conf"), index_of("ctl reread"), index_of("ctl update"),
        index_of("start tailscaled"), index_of("wipe-key TS_AUTHKEY"), index_of("start agent"),
        index_of("--target agent"), index_of("install-nodes"), index_of("install-models"), index_of("copy-workflows"),
        index_of('restart "$COMFY_PROGRAM"'), index_of("--target comfy"), index_of("mark-ready"), index_of("BOOT_DONE=1"),
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


def test_boot_done_is_set_after_mark_ready():
    assert index_of("mark-ready") < index_of("BOOT_DONE=1")


def test_every_step_after_the_trap_is_guarded():
    start = index_of("trap on_exit EXIT") + 1
    end = index_of("BOOT_DONE=1")
    step_markers = ("boot ", "ctl ", "serve_port ")
    for line in lines()[start:end]:
        stripped = line.strip()
        if not stripped.startswith(step_markers):
            continue
        assert "|| die_with" in stripped or "|| exit $?" in stripped or "|| emergency_destroy" in stripped, stripped


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
        "CONTAINER_ID": "42", "CONTAINER_API_KEY": KEY,
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


@pytest.mark.parametrize("output", ["WARNING: deprecated\\n\\ndestroying instance 42.\\n",
                                    f"Failed with error 401: key {KEY} lacks privileges\\n"])
def test_emergency_destroy_calls_the_stock_cli_without_y_hides_the_key_and_always_fails(tmp_path, bindir, output):
    log = tmp_path / "vastai.log"
    fake_vastai(bindir, log, output)
    result = source_and_run(tmp_path, "emergency_destroy agent_install_failed; echo not-reached")
    assert result.returncode != 0
    assert "not-reached" not in result.stdout
    assert log.read_text().splitlines() == [f"destroy instance 42 --api-key {KEY}"]
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
