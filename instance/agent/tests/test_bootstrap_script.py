import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "bootstrap.sh"
CONF = Path(__file__).resolve().parents[2] / "supervisord.conf"


def lines():
    return SCRIPT.read_text().splitlines()


def index_of(fragment):
    for number, line in enumerate(lines()):
        if fragment in line and not line.lstrip().startswith("#"):
            return number
    raise AssertionError(f"{fragment!r} not found in bootstrap.sh")


def test_script_has_valid_bash_syntax():
    assert subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True).returncode == 0


def test_safety_nets_come_before_anything_that_can_fail():
    order = [index_of("write-env"), index_of("init-times"), index_of("failsafe.sh"), index_of('"$SUPERVISORD_BIN"'),
             index_of("start tailscaled"), index_of("wipe-key TS_AUTHKEY"), index_of("start agent"),
             index_of("install-nodes"), index_of("install-models"), index_of("copy-workflows"),
             index_of('start "$COMFY_PROGRAM"'), index_of("mark-ready")]
    assert order == sorted(order) and len(set(order)) == len(order)


def test_authkey_is_never_placed_on_a_command_line():
    text = SCRIPT.read_text()
    assert '--auth-key="file:$AUTH_FILE"' in text
    assert '--auth-key="$TS_AUTHKEY"' not in text and "--auth-key=$TS_AUTHKEY" not in text


def test_supervisord_programs_do_not_autostart_and_use_env_expansion_only():
    text = CONF.read_text()
    assert text.count("autostart=false") == 3
    for program in ("tailscaled", "agent", "comfyui"):
        assert f"[program:{program}]" in text
    assert "%(ENV_STATE_DIR)s" in text and "%(ENV_COMFY_PORT)s" in text


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
    start = index_of("init-times")
    end = index_of("BOOT_DONE=1")
    step_markers = ("boot ", "ctl ", '"$SUPERVISORD_BIN"', "serve_port ")
    for line in lines()[start:end]:
        stripped = line.strip()
        if not stripped.startswith(step_markers):
            continue
        assert "|| die_with" in stripped or "|| exit $?" in stripped, stripped


def test_agent_is_installed_editable_so_the_repo_schema_resolves():
    install = lines()[index_of("pip install")]
    assert " -e " in install and '"$HERE/agent"' in install
