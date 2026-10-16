import subprocess
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
