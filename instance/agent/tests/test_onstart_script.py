import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

INSTANCE = Path(__file__).resolve().parents[2]
SCRIPT = INSTANCE / "onstart.sh"
BOOTSTRAP = INSTANCE / "bootstrap.sh"
BASH = "/bin/bash" if Path("/bin/bash").exists() else shutil.which("bash")
KEY = "fake-container-key"


def lines():
    return SCRIPT.read_text().splitlines()


def index_of(fragment):
    for number, line in enumerate(lines()):
        if fragment in line and not line.lstrip().startswith("#"):
            return number
    raise AssertionError(f"{fragment!r} not found in onstart.sh")


def schema_default(name):
    from vastcomfy_agent.config import load_schema

    return str(next(s for s in load_schema() if s.name == name).default)


# --- static checks -------------------------------------------------------------------------------

def test_script_exists_is_executable_and_has_valid_bash_syntax():
    assert SCRIPT.exists() and os.access(SCRIPT, os.X_OK)
    assert subprocess.run([BASH, "-n", str(SCRIPT)], capture_output=True).returncode == 0


def test_manager_is_renamed_before_the_entrypoint_starts_before_bootstrap_is_execed():
    rename = index_of('mv "$MANAGER" "$MANAGER.disabled"')
    entry = index_of('"$STOCK_ENTRYPOINT"')
    launch = next(i for i, line in enumerate(lines()) if "nohup" in line and "STOCK_ENTRYPOINT" in line)
    exec_line = index_of('exec bash "$HERE/bootstrap.sh"')
    assert rename < entry <= launch < exec_line
    assert lines()[exec_line].strip() == 'exec bash "$HERE/bootstrap.sh"'


def test_pre_config_fallbacks_are_marked_and_match_the_schema():
    text = SCRIPT.read_text()
    assert f'COMFY_DIR="${{COMFY_DIR:-{schema_default("COMFY_DIR")}}}"' in text
    assert 'STOCK_ENTRYPOINT="${STOCK_ENTRYPOINT:-entrypoint.sh}"' in text
    for line in lines():
        if ":-/" in line:
            assert "# config-lint: ok" in line, line


def test_the_rename_failure_aborts_closed():
    rename = lines()[index_of('mv "$MANAGER" "$MANAGER.disabled"')]
    assert "|| fail_closed" in rename


# --- behaviour in a temp tree with fakes (the real bootstrap.sh is never executed) --------------------

def write_exec(path, text):
    path.write_text(text)
    path.chmod(0o755)
    return path


@pytest.fixture
def tree(tmp_path):
    repo = tmp_path / "repo" / "instance"
    repo.mkdir(parents=True)
    shutil.copy(SCRIPT, repo / "onstart.sh")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    comfy = tmp_path / "ComfyUI"
    (comfy / "custom_nodes" / "ComfyUI-Manager").mkdir(parents=True)
    (comfy / "custom_nodes" / "ComfyUI-Manager" / "__init__.py").write_text("")
    seen = tmp_path / "entry.seen"
    # The fake entrypoint records whether the Manager was still enabled when it started.
    write_exec(bindir / "entrypoint.sh",
               f'#!/bin/sh\n[ -e "{comfy}/custom_nodes/ComfyUI-Manager" ] && s=enabled || s=disabled\n'
               f'echo entry-output\necho "$s" > "{seen}"\n')
    write_exec(bindir / "vastai", f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{tmp_path}/vastai.log"\n'
                                  'printf "destroying instance 42.\\n"\n')
    # Safety net: should the real bootstrap ever run, its venv build fails on this python3 and only the fake
    # vastai above is reachable.
    write_exec(bindir / "python3", "#!/bin/sh\nexit 1\n")
    return {"tmp": tmp_path, "repo": repo, "bin": bindir, "comfy": comfy, "seen": seen}


def fake_bootstrap(tree, rc=0):
    write_exec(tree["repo"] / "bootstrap.sh",
               f'#!/usr/bin/env bash\necho "ran" > "{tree["tmp"]}/bootstrap.ran"\nexit {rc}\n')


def run_onstart(tree, **env):
    base = {
        "PATH": f"{tree['bin']}:/usr/bin:/bin", "HOME": str(tree["tmp"]), "COMFY_DIR": str(tree["comfy"]),
        "ENTRYPOINT_LOG": str(tree["tmp"] / "entry.log"), "CONTAINER_ID": "42", "CONTAINER_API_KEY": KEY,
        "VENV_DIR": str(tree["tmp"] / "venv"),
    }
    base.update(env)
    return subprocess.run([BASH, str(tree["repo"] / "onstart.sh")], env=base, capture_output=True, text=True,
                          timeout=30)


def wait_for(path, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists() and path.read_text().strip():
            return path.read_text().strip()
        time.sleep(0.05)
    raise AssertionError(f"{path} never appeared")


def test_disables_the_manager_then_starts_the_entrypoint_then_execs_bootstrap(tree):
    fake_bootstrap(tree)
    result = run_onstart(tree)
    assert result.returncode == 0, result.stderr
    nodes = tree["comfy"] / "custom_nodes"
    assert not (nodes / "ComfyUI-Manager").exists()
    assert (nodes / "ComfyUI-Manager.disabled" / "__init__.py").exists()
    assert wait_for(tree["seen"]) == "disabled"
    assert (tree["tmp"] / "bootstrap.ran").read_text().strip() == "ran"
    deadline = time.monotonic() + 10
    while "entry-output" not in (tree["tmp"] / "entry.log").read_text() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert "entry-output" in (tree["tmp"] / "entry.log").read_text()
    assert not (tree["tmp"] / "vastai.log").exists()


def test_the_exit_status_is_the_bootstrap_status(tree):
    fake_bootstrap(tree, rc=5)
    assert run_onstart(tree).returncode == 5


def test_without_a_manager_it_still_starts_the_entrypoint_and_bootstrap(tree):
    shutil.rmtree(tree["comfy"] / "custom_nodes" / "ComfyUI-Manager")
    fake_bootstrap(tree)
    result = run_onstart(tree)
    assert result.returncode == 0, result.stderr
    assert wait_for(tree["seen"]) == "disabled"
    assert (tree["tmp"] / "bootstrap.ran").exists()


def test_a_restart_with_an_already_disabled_manager_is_a_no_op(tree):
    nodes = tree["comfy"] / "custom_nodes"
    (nodes / "ComfyUI-Manager").rename(nodes / "ComfyUI-Manager.disabled")
    fake_bootstrap(tree)
    assert run_onstart(tree).returncode == 0
    assert (nodes / "ComfyUI-Manager.disabled" / "__init__.py").exists()
    assert not (nodes / "ComfyUI-Manager").exists()


def test_a_reappeared_manager_replaces_the_stale_disabled_copy(tree):
    nodes = tree["comfy"] / "custom_nodes"
    (nodes / "ComfyUI-Manager.disabled").mkdir()
    (nodes / "ComfyUI-Manager.disabled" / "old").write_text("")
    fake_bootstrap(tree)
    assert run_onstart(tree).returncode == 0
    assert not (nodes / "ComfyUI-Manager").exists()
    assert (nodes / "ComfyUI-Manager.disabled" / "__init__.py").exists()
    assert not (nodes / "ComfyUI-Manager.disabled" / "ComfyUI-Manager").exists()


def emergency_tree(tree):
    """Failure cases source the real bootstrap.sh for emergency_destroy; it is never executed."""
    shutil.copy(BOOTSTRAP, tree["repo"] / "bootstrap.sh")


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_a_failing_rename_aborts_before_the_entrypoint_and_destroys_with_the_stock_cli(tree):
    emergency_tree(tree)
    nodes = tree["comfy"] / "custom_nodes"
    nodes.chmod(0o555)
    try:
        result = run_onstart(tree)
    finally:
        nodes.chmod(0o755)
    assert result.returncode != 0
    assert (nodes / "ComfyUI-Manager").exists()
    time.sleep(0.3)
    assert not tree["seen"].exists()
    assert (tree["tmp"] / "vastai.log").read_text().splitlines() == [f"destroy instance 42 --api-key {KEY}"]
    assert not (tree["tmp"] / "venv").exists()  # bootstrap's main flow never ran
    assert KEY not in result.stdout + result.stderr


def test_a_missing_entrypoint_aborts_closed(tree):
    emergency_tree(tree)
    result = run_onstart(tree, STOCK_ENTRYPOINT="no-such-entrypoint.sh")
    assert result.returncode != 0
    assert "no-such-entrypoint.sh" in result.stderr
    assert (tree["tmp"] / "vastai.log").read_text().splitlines() == [f"destroy instance 42 --api-key {KEY}"]
    assert not (tree["tmp"] / "venv").exists()


def test_an_unwritable_entrypoint_log_aborts_closed(tree):
    emergency_tree(tree)
    result = run_onstart(tree, ENTRYPOINT_LOG=str(tree["tmp"] / "no" / "such" / "dir" / "entry.log"))
    assert result.returncode != 0
    time.sleep(0.3)
    assert not tree["seen"].exists()
    assert (tree["tmp"] / "vastai.log").exists()
