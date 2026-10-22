import json
import stat
import subprocess
import time

import httpx
import pytest

from vastcomfy_agent import boot
from vastcomfy_agent.config import load_config, parse_env_file
from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.state import State, StateStore

T0 = 9_000_000


class Clock:
    def __init__(self):
        self.t = T0

    def __call__(self):
        return self.t


def base_environ(tmp_path, **extra):
    env = {
        "CONTAINER_ID": "42", "CONTAINER_API_KEY": "ck", "AGENT_TOKEN": "tok", "TS_HOSTNAME": "vast-x",
        "REPO_URL": "https://example.invalid/r.git", "REPO_COMMIT": "abc", "PROFILE": "image",
        "STATE_DIR": str(tmp_path / "state"), "ENV_FILE_PATH": str(tmp_path / "etc" / ".env"),
        "REPO_DIR": str(tmp_path / "repo"), "COMFY_DIR": str(tmp_path / "comfy"),
        "WORKFLOWS_DIR": str(tmp_path / "workflows"), "DESTROY_RETRIES": "1", "DESTROY_BACKOFF_S": "0",
        "VASTAI_BIN": "vastai",  # the stub Runner recognises the CLI by this name
        "PATH": "/usr/bin", "PUBLIC_IPADDR": "1.2.3.4", "VAST_CONTAINERLABEL": "C.42",
    }
    env.update(extra)
    return env


class Runner:
    def __init__(self, vast_ok=True):
        self.cmds, self.vast_ok = [], vast_ok

    def __call__(self, cmd, **kwargs):
        self.cmds.append(cmd)
        if cmd[0] == "vastai":  # the real CLI exits 0 and prints the outcome
            out = f"destroying instance {cmd[3]}." if self.vast_ok else "Failed with error 401: denied"
            return subprocess.CompletedProcess(cmd, 0, out, "")
        return subprocess.CompletedProcess(cmd, 0, "", "err")


def run_boot(tmp_path, argv, environ=None, clock=None, runner=None, **kw):
    environ = environ if environ is not None else base_environ(tmp_path)
    runner = runner or Runner()
    clock = clock or Clock()
    code = boot.main(argv, environ=environ, now=clock, run=runner, **kw)
    return code, runner


def env_file(tmp_path):
    return str(tmp_path / "etc" / ".env")


def states(tmp_path):
    return StateStore(tmp_path / "state", Clock())


def test_write_env_keeps_only_schema_keys_with_defaults_resolved_and_mode_600(tmp_path, capsys):
    code, _ = run_boot(tmp_path, ["write-env"])
    assert code == 0 and capsys.readouterr().out.strip() == env_file(tmp_path)
    written = parse_env_file(tmp_path / "etc" / ".env")
    assert "PATH" not in written and "PUBLIC_IPADDR" not in written and "VAST_CONTAINERLABEL" not in written
    assert written["IDLE_MINUTES"] == "30" and written["COMFY_PORT"] == "18188"
    assert written["KEEP_ON_FAILURE"] == "false" and written["DESTROY_GONE_MARKERS"] == "Failed with error 404: Instance"
    assert written["DESTROY_OK_MARKERS"] == "destroying instance"
    assert written["DESTROY_ASSUME_YES"] == "true"
    assert stat.S_IMODE((tmp_path / "etc" / ".env").stat().st_mode) == 0o600
    assert "VAST_API_KEY" not in written


def test_written_env_loads_back_through_the_config_module_with_awkward_values(tmp_path):
    # Review focus 2
    environ = base_environ(tmp_path, TS_AUTHKEY="tskey=abc#def ghi ", HF_TOKEN="hf_a=b")
    assert run_boot(tmp_path, ["write-env"], environ)[0] == 0
    cfg = load_config(tmp_path / "etc" / ".env", "instance")
    assert cfg.ts_authkey == "tskey=abc#def ghi " and cfg.hf_token == "hf_a=b" and cfg.idle_minutes == 30


def test_missing_container_credentials_fails_with_exit_10_and_records_the_reason(tmp_path):
    environ = base_environ(tmp_path)
    del environ["CONTAINER_API_KEY"]
    code, runner = run_boot(tmp_path, ["write-env"], environ)
    assert code == 10
    record = states(tmp_path).get()
    assert (record.state, record.reason) == (State.FAILED, "missing_container_credentials")
    assert runner.cmds == []  # no credentials, so no destroy attempt


def test_other_missing_required_keys_fail_with_exit_13(tmp_path):
    environ = base_environ(tmp_path)
    del environ["AGENT_TOKEN"]
    code, _ = run_boot(tmp_path, ["write-env"], environ)
    assert code == 13 and states(tmp_path).get().reason == "config_invalid"


def test_newline_in_a_value_is_rejected(tmp_path):
    environ = base_environ(tmp_path, TS_HOSTNAME="a\nb")
    assert run_boot(tmp_path, ["write-env"], environ)[0] == 13


def prepared(tmp_path, **extra):
    environ = base_environ(tmp_path, **extra)
    assert run_boot(tmp_path, ["write-env"], environ)[0] == 0
    return environ


def test_begin_resets_the_state_even_after_a_previous_run(tmp_path):
    prepared(tmp_path)
    store = states(tmp_path)
    for s in (State.BOOTING, State.DOWNLOADING, State.READY):
        store.set(s)
    assert run_boot(tmp_path, ["begin", "--env-file", env_file(tmp_path)])[0] == 0
    assert store.get().state == State.BOOTING


def test_init_times_fresh_then_restart_does_not_rewrite(tmp_path, capsys):
    prepared(tmp_path)
    clock = Clock()
    assert run_boot(tmp_path, ["init-times", "--env-file", env_file(tmp_path)], clock=clock)[0] == 0
    assert capsys.readouterr().out.strip().endswith("fresh")
    deadlines = DeadlineStore(tmp_path / "state", clock)
    assert deadlines.deadline() == T0 + 3 * 3600 and deadlines.hard_cap() == T0 + 6 * 3600
    clock.t = T0 + 10 * 3600
    assert run_boot(tmp_path, ["init-times", "--env-file", env_file(tmp_path)], clock=clock)[0] == 0
    assert capsys.readouterr().out.strip().endswith("restart")
    assert deadlines.deadline() == T0 + 3 * 3600


def test_hard_cap_missing_after_first_boot_fails_and_self_destroys(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    run_boot(tmp_path, ["init-times", "--env-file", ef])
    (tmp_path / "state" / "hard_cap").unlink()
    code, runner = run_boot(tmp_path, ["init-times", "--env-file", ef])
    assert code == 11
    assert states(tmp_path).get().state == State.STOPPING and states(tmp_path).get().reason == "hard_cap_missing"
    assert [c[:3] for c in runner.cmds if c[0] == "vastai"] == [["vastai", "destroy", "instance"]]
    assert [c[4] for c in runner.cmds if c[0] == "vastai"] == ["-y"]


def test_fail_self_destroys_unless_disabled(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    code, runner = run_boot(tmp_path, ["fail", "tailscale_failed", "--env-file", ef])
    assert code == 12 and states(tmp_path).get().state == State.STOPPING
    assert any(c[0] == "vastai" for c in runner.cmds)


def test_fail_with_no_destroy_flag_or_keep_on_failure_keeps_the_instance(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    code, runner = run_boot(tmp_path, ["fail", "tailscale_failed", "--env-file", ef, "--no-destroy"])
    assert code == 12 and states(tmp_path).get().state == State.FAILED and runner.cmds == []

    other = tmp_path / "second"
    other.mkdir()
    prepared(other, KEEP_ON_FAILURE="true")
    run_boot(other, ["begin", "--env-file", env_file(other)], environ=base_environ(other, KEEP_ON_FAILURE="true"))
    code, runner = run_boot(other, ["fail", "download_failed", "--env-file", env_file(other)],
                            environ=base_environ(other, KEEP_ON_FAILURE="true"))
    assert code == 12 and StateStore(other / "state", Clock()).get().state == State.FAILED and runner.cmds == []


def test_wipe_key_blanks_only_that_key(tmp_path):
    prepared(tmp_path, TS_AUTHKEY="secret-key")
    assert run_boot(tmp_path, ["wipe-key", "TS_AUTHKEY", "--env-file", env_file(tmp_path)])[0] == 0
    written = parse_env_file(tmp_path / "etc" / ".env")
    assert written["TS_AUTHKEY"] == "" and written["AGENT_TOKEN"] == "tok"
    assert "secret-key" not in (tmp_path / "etc" / ".env").read_text()


def test_get_prints_a_single_value(tmp_path, capsys):
    prepared(tmp_path)
    capsys.readouterr()
    run_boot(tmp_path, ["get", "COMFY_PORT", "--env-file", env_file(tmp_path)])
    assert capsys.readouterr().out.strip() == "18188"


def test_env_export_is_shell_safe_and_leaves_secrets_out(tmp_path, capsys):
    prepared(tmp_path, TS_HOSTNAME="a b'c$d", TS_AUTHKEY="tskey-secret")
    capsys.readouterr()
    run_boot(tmp_path, ["env-export", "--env-file", env_file(tmp_path)])
    exported = capsys.readouterr().out
    assert "tskey-secret" not in exported and "CONTAINER_API_KEY" not in exported and "AGENT_TOKEN" not in exported
    out = subprocess.run(["bash", "-c", f'{exported}\nprintf %s "$TS_HOSTNAME"'], capture_output=True, text=True).stdout
    assert out == "a b'c$d"


PROFILE = """
name: image
requires: {vram_gb: 24, disk_gb: 40}
nodes: []
models:
  - {file: m.bin, repo: org/m, revision: r1, dest: models/x/, size_bytes: 10}
workflows: [flow.json]
"""


def with_profile(tmp_path):
    prof = tmp_path / "repo" / "instance" / "profiles"
    prof.mkdir(parents=True)
    (prof / "image.yaml").write_text(PROFILE)
    wf = tmp_path / "repo" / "instance" / "workflows"
    wf.mkdir(parents=True)
    (wf / "flow.json").write_text('{"a": 1}')


def ok_client():
    return httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * 10)))


def test_install_models_downloads_and_moves_to_downloading(tmp_path):
    prepared(tmp_path)
    with_profile(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    code, _ = run_boot(tmp_path, ["install-models", "--env-file", ef], http_client=ok_client(), free_bytes_fn=lambda p: 10**12)
    assert code == 0
    assert (tmp_path / "comfy" / "models" / "x" / "m.bin").stat().st_size == 10
    assert states(tmp_path).get().state == State.DOWNLOADING


def test_install_models_fails_on_insufficient_disk(tmp_path):
    prepared(tmp_path)
    with_profile(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    code, runner = run_boot(tmp_path, ["install-models", "--env-file", ef], http_client=ok_client(), free_bytes_fn=lambda p: 5)
    assert code == 12
    record = states(tmp_path).get()
    assert record.state == State.STOPPING and record.reason == "disk_insufficient"


def test_install_models_fails_when_the_download_keeps_failing(tmp_path):
    environ = prepared(tmp_path, DOWNLOAD_RETRIES="2", DOWNLOAD_BACKOFF_S="0")
    with_profile(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef], environ=environ)
    bad = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    code, _ = run_boot(tmp_path, ["install-models", "--env-file", ef], environ=environ, http_client=bad,
                       free_bytes_fn=lambda p: 10**12)
    assert code == 12 and states(tmp_path).get().reason == "download_failed"
    assert not list((tmp_path / "comfy" / "models" / "x").glob("*"))


def test_copy_workflows_copies_missing_files_and_never_overwrites(tmp_path):
    prepared(tmp_path)
    with_profile(tmp_path)
    ef = env_file(tmp_path)
    assert run_boot(tmp_path, ["copy-workflows", "--env-file", ef])[0] == 0
    target = tmp_path / "workflows" / "flow.json"
    assert json.loads(target.read_text()) == {"a": 1}
    target.write_text('{"user": "edited"}')
    run_boot(tmp_path, ["copy-workflows", "--env-file", ef])
    assert json.loads(target.read_text()) == {"user": "edited"}


def test_mark_ready_moves_to_ready_and_starts_the_idle_timer(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    clock = Clock()
    for argv in (["begin"], ["init-times"]):
        run_boot(tmp_path, argv + ["--env-file", ef], clock=clock)
    store = StateStore(tmp_path / "state", clock)
    store.set(State.DOWNLOADING)
    assert run_boot(tmp_path, ["mark-ready", "--env-file", ef], clock=clock)[0] == 0
    assert store.get().state == State.READY
    assert DeadlineStore(tmp_path / "state", clock).idle_destroy_at() == T0 + 1800


def test_wait_for_comfy_times_out_and_self_destroys(tmp_path):
    environ = prepared(tmp_path, COMFY_START_TIMEOUT_S="30")
    ef = env_file(tmp_path)
    clock = Clock()
    run_boot(tmp_path, ["begin", "--env-file", ef], environ=environ, clock=clock)
    down = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    code, runner = run_boot(
        tmp_path, ["wait", "--target", "comfy", "--env-file", ef], environ=environ, clock=clock,
        http_client=down, sleep=lambda s: setattr(clock, "t", clock.t + s),
    )
    assert code == 12 and states(tmp_path).get().reason == "comfyui_start_failed"
    assert any(c[0] == "vastai" for c in runner.cmds)


def test_wait_for_comfy_returns_when_it_answers(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    up = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    code, _ = run_boot(tmp_path, ["wait", "--target", "comfy", "--env-file", ef], http_client=up, sleep=lambda s: None)
    assert code == 0


def test_write_env_rejects_type_invalid_values_with_config_invalid(tmp_path):
    for extra in ({"KEEP_ON_FAILURE": "1"}, {"IDLE_MINUTES": "30m"}):
        sub = tmp_path / next(iter(extra))
        sub.mkdir()
        code, runner = run_boot(sub, ["write-env"], base_environ(sub, **extra))
        record = StateStore(sub / "state", Clock()).get()
        assert code == 13 and (record.state, record.reason) == (State.FAILED, "config_invalid")
        assert runner.cmds == []


def test_main_with_an_invalid_env_file_exits_13_without_traceback(tmp_path, capsys):
    prepared(tmp_path)
    ef = tmp_path / "etc" / ".env"
    ef.write_text(ef.read_text().replace("KEEP_ON_FAILURE=false", "KEEP_ON_FAILURE=1"))
    code, runner = run_boot(tmp_path, ["begin", "--env-file", str(ef)])
    assert code == 13 and runner.cmds == []
    assert states(tmp_path).get().reason == "config_invalid"
    assert "Traceback" not in capsys.readouterr().err


def test_uncaught_exception_in_a_boot_command_self_destroys(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    with_profile_nodes(tmp_path)

    class Missing(Runner):
        def __call__(self, cmd, **kwargs):
            if cmd[0] != "vastai":
                self.cmds.append(cmd)
                raise FileNotFoundError(cmd[0])
            return super().__call__(cmd, **kwargs)

    code, runner = run_boot(tmp_path, ["install-nodes", "--env-file", ef], runner=Missing())
    assert code == 12
    record = states(tmp_path).get()
    assert record.state == State.STOPPING and record.reason == "boot_failed"
    assert any(c[0] == "vastai" for c in runner.cmds)


def with_profile_nodes(tmp_path):
    prof = tmp_path / "repo" / "instance" / "profiles"
    prof.mkdir(parents=True)
    (prof / "image.yaml").write_text(PROFILE.replace("nodes: []", "nodes:\n  - {name: n, repo: org/n, commit: abc}"))


def test_copy_workflows_missing_source_file_self_destroys(tmp_path):
    prepared(tmp_path)
    with_profile(tmp_path)
    (tmp_path / "repo" / "instance" / "workflows" / "flow.json").unlink()
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    code, runner = run_boot(tmp_path, ["copy-workflows", "--env-file", ef])
    assert code == 12 and states(tmp_path).get().reason == "boot_failed"
    assert any(c[0] == "vastai" for c in runner.cmds)


def test_mark_ready_crash_self_destroys(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])  # no init-times, so idle.start may raise or not
    original = boot.Boot.__init__

    def patched(self, *a, **k):
        original(self, *a, **k)
        self.wired.idle.start = lambda: (_ for _ in ()).throw(OSError("disk"))

    boot.Boot.__init__ = patched
    try:
        code, runner = run_boot(tmp_path, ["mark-ready", "--env-file", ef])
    finally:
        boot.Boot.__init__ = original
    assert code == 12 and states(tmp_path).get().reason == "boot_failed"
    assert any(c[0] == "vastai" for c in runner.cmds)


def test_failed_state_write_does_not_prevent_the_destroy_attempt(tmp_path, capsys, monkeypatch):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    with_profile_nodes(tmp_path)

    def broken_set(self, *args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(StateStore, "set", broken_set)

    class Missing(Runner):
        def __call__(self, cmd, **kwargs):
            if cmd[0] != "vastai":
                raise FileNotFoundError(cmd[0])
            return super().__call__(cmd, **kwargs)

    code, runner = run_boot(tmp_path, ["install-nodes", "--env-file", ef], runner=Missing())
    assert code == 12
    assert any(c[0] == "vastai" for c in runner.cmds)
    assert "Traceback" not in capsys.readouterr().err


def test_write_env_with_a_missing_schema_exits_13_without_a_traceback(tmp_path, capsys, monkeypatch):
    from vastcomfy_agent import config as cfgmod

    monkeypatch.setattr(cfgmod, "SCHEMA_PATH", tmp_path / "gone" / "config-schema.yaml")
    code, runner = run_boot(tmp_path, ["write-env"])
    err = capsys.readouterr().err
    assert code == 13
    assert "config schema not found at" in err and "Traceback" not in err
    assert runner.cmds == []


@pytest.mark.parametrize("key, value", [("DESTROY_TIMEOUT_S", "1_0"), ("HARD_CAP_HOURS", "48"), ("FAILSAFE_POLL_S", "0")])
def test_write_env_rejects_non_strict_or_out_of_range_ints_with_exit_13(tmp_path, capsys, key, value):
    code, runner = run_boot(tmp_path, ["write-env"], base_environ(tmp_path, **{key: value}))
    assert code == 13 and key in capsys.readouterr().err
    record = states(tmp_path).get()
    assert (record.state, record.reason) == (State.FAILED, "config_invalid")


# --- S1: set-key and render-supervisor-conf ---

def test_set_key_rewrites_only_that_key_keeps_mode_600_and_round_trips(tmp_path):
    prepared(tmp_path, TS_AUTHKEY="tskey-secret")
    path = tmp_path / "etc" / ".env"
    before = parse_env_file(path)
    assert run_boot(tmp_path, ["set-key", "VASTAI_BIN", "/opt/instance-tools/bin/vastai", "--env-file", str(path)])[0] == 0
    assert run_boot(tmp_path, ["set-key", "DESTROY_ASSUME_YES", "false", "--env-file", str(path)])[0] == 0
    after = parse_env_file(path)
    assert after["VASTAI_BIN"] == "/opt/instance-tools/bin/vastai" and after["DESTROY_ASSUME_YES"] == "false"
    assert {k: v for k, v in after.items() if k not in ("VASTAI_BIN", "DESTROY_ASSUME_YES")} == \
        {k: v for k, v in before.items() if k not in ("VASTAI_BIN", "DESTROY_ASSUME_YES")}
    assert list(after) == list(before)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    cfg = load_config(path, "instance")
    assert cfg.vastai_bin == "/opt/instance-tools/bin/vastai" and cfg.destroy_assume_yes is False
    assert not [p for p in path.parent.iterdir() if p.name != ".env"]  # no temp file left behind


def test_set_key_rejects_unknown_keys_and_line_breaks_without_touching_the_file(tmp_path, capsys):
    prepared(tmp_path)
    path = tmp_path / "etc" / ".env"
    original = path.read_text()
    for argv in (["set-key", "NOT_A_KEY", "x"], ["set-key", "VASTAI_BIN", "a\nTS_AUTHKEY=evil"],
                 ["set-key", "VASTAI_BIN", "a\rb"], ["set-key", "DESTROY_ASSUME_YES", "yes"],
                 ["set-key", "COMFY_PORT", "abc"]):
        capsys.readouterr()
        assert run_boot(tmp_path, [*argv, "--env-file", str(path)])[0] == boot.EXIT_CONFIG
        assert "evil" not in capsys.readouterr().err
    assert path.read_text() == original


def test_set_key_never_echoes_a_secret_value(tmp_path, capsys):
    prepared(tmp_path)
    path = tmp_path / "etc" / ".env"
    capsys.readouterr()
    assert run_boot(tmp_path, ["set-key", "HF_TOKEN", "hf-very-secret", "--env-file", str(path)])[0] == 0
    out = capsys.readouterr()
    assert "hf-very-secret" not in out.out + out.err
    assert parse_env_file(path)["HF_TOKEN"] == "hf-very-secret"
    assert run_boot(tmp_path, ["set-key", "COMFY_PORT", "hf-very-secret", "--env-file", str(path)])[0] == boot.EXIT_CONFIG
    out = capsys.readouterr()
    assert "hf-very-secret" not in out.out + out.err


def conf_environ(tmp_path, **extra):
    conf_dir = tmp_path / "conf.d"
    conf_dir.mkdir(exist_ok=True)
    return prepared(tmp_path, SUPERVISOR_CONF_DIR=str(conf_dir), SUPERVISOR_PROGRAMS_FILE="vc.conf", **extra), conf_dir


def test_render_supervisor_conf_writes_the_programs_file_atomically(tmp_path):
    _, conf_dir = conf_environ(tmp_path)
    code, _ = run_boot(tmp_path, ["render-supervisor-conf", "--env-file", env_file(tmp_path)])
    assert code == 0
    text = (conf_dir / "vc.conf").read_text()
    assert "[program:tailscaled]" in text and "[program:agent]" in text and "%" not in text
    assert f"--env-file {env_file(tmp_path)}" in text
    assert [p.name for p in conf_dir.iterdir()] == ["vc.conf"]  # no temp file left behind


def test_render_supervisor_conf_fails_closed_when_the_directory_is_missing(tmp_path, capsys):
    prepared(tmp_path, SUPERVISOR_CONF_DIR=str(tmp_path / "nope"))
    code, runner = run_boot(tmp_path, ["render-supervisor-conf", "--env-file", env_file(tmp_path)])
    assert code == boot.EXIT_FAILED and not (tmp_path / "nope").exists()
    assert states(tmp_path).get().reason == "boot_failed"
    assert any(c[0] == "vastai" for c in runner.cmds)  # the self-destroy ran
    assert "Traceback" not in capsys.readouterr().err


@pytest.mark.skipif(hasattr(__import__("os"), "geteuid") and __import__("os").geteuid() == 0, reason="root ignores modes")
def test_render_supervisor_conf_fails_closed_when_the_directory_is_unwritable(tmp_path):
    _, conf_dir = conf_environ(tmp_path)
    conf_dir.chmod(0o500)
    try:
        code, runner = run_boot(tmp_path, ["render-supervisor-conf", "--env-file", env_file(tmp_path)])
    finally:
        conf_dir.chmod(0o700)
    assert code == boot.EXIT_FAILED and not (conf_dir / "vc.conf").exists()
    assert any(c[0] == "vastai" for c in runner.cmds)


def test_render_supervisor_conf_keeps_the_keep_on_failure_exception(tmp_path):
    prepared(tmp_path, SUPERVISOR_CONF_DIR=str(tmp_path / "nope"), KEEP_ON_FAILURE="true")
    code, runner = run_boot(tmp_path, ["render-supervisor-conf", "--env-file", env_file(tmp_path)])
    assert code == boot.EXIT_FAILED and not any(c[0] == "vastai" for c in runner.cmds)


def test_render_supervisor_conf_rejects_a_value_with_whitespace_with_exit_13_and_a_destroy(tmp_path, capsys):
    _, conf_dir = conf_environ(tmp_path, AGENT_PYTHON="/opt/my venv/bin/python")
    code, runner = run_boot(tmp_path, ["render-supervisor-conf", "--env-file", env_file(tmp_path)])
    assert code == boot.EXIT_CONFIG and not (conf_dir / "vc.conf").exists()
    assert states(tmp_path).get().reason == "config_invalid" and any(c[0] == "vastai" for c in runner.cmds)
    assert "Traceback" not in capsys.readouterr().err


# --- install-nodes uses COMFY_PYTHON, verify-nodes checks ComfyUI registered the profile's node classes ---

def test_install_nodes_installs_requirements_with_the_configured_comfy_python(tmp_path):
    environ = prepared(tmp_path, COMFY_PYTHON="/venv/custom/bin/python")
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef], environ=environ)
    with_profile_nodes(tmp_path)

    class Cloning(Runner):
        def __call__(self, cmd, **kwargs):
            if "clone" in cmd:
                from pathlib import Path

                Path(cmd[-1]).mkdir(parents=True)
                (Path(cmd[-1]) / "requirements.txt").write_text("gguf\n")
            return super().__call__(cmd, **kwargs)

    code, runner = run_boot(tmp_path, ["install-nodes", "--env-file", ef], environ=environ, runner=Cloning())
    assert code == 0
    requirements = str(tmp_path / "comfy" / "custom_nodes" / "n" / "requirements.txt")
    assert ["/venv/custom/bin/python", "-m", "pip", "install", "-r", requirements] in runner.cmds
    assert not any(c[0] in ("pip", "pip3") for c in runner.cmds)


def with_node_classes(tmp_path, classes="[UnetLoaderGGUF]"):
    prof = tmp_path / "repo" / "instance" / "profiles"
    prof.mkdir(parents=True)
    (prof / "image.yaml").write_text(PROFILE + f"provides_node_classes: {classes}\n")


def fake_comfy(registered, seen):
    """A fake ComfyUI: /object_info/<class> answers {class: ...} for a registered class, {} otherwise."""
    def handler(request):
        seen.append(request.url.path)
        name = request.url.path.rsplit("/", 1)[-1]
        if request.url.path.startswith("/object_info/"):
            return httpx.Response(200, json={name: {"input": {}}} if name in registered else {})
        return httpx.Response(404)

    return httpx.Client(transport=httpx.MockTransport(handler))


def verify_prepared(tmp_path, classes="[UnetLoaderGGUF]", **extra):
    environ = prepared(tmp_path, **extra)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef], environ=environ)
    states(tmp_path).set(State.DOWNLOADING)
    with_node_classes(tmp_path, classes)
    return environ, ef


def test_verify_nodes_passes_when_every_declared_class_is_registered(tmp_path):
    environ, ef = verify_prepared(tmp_path, "[UnetLoaderGGUF, OtherNode]")
    seen = []
    code, runner = run_boot(tmp_path, ["verify-nodes", "--env-file", ef], environ=environ,
                            http_client=fake_comfy({"UnetLoaderGGUF", "OtherNode"}, seen))
    assert code == 0 and runner.cmds == []
    assert seen == ["/object_info/UnetLoaderGGUF", "/object_info/OtherNode"]
    assert states(tmp_path).get().state == State.DOWNLOADING


def test_verify_nodes_fails_and_self_destroys_when_a_class_is_missing(tmp_path, capsys):
    environ, ef = verify_prepared(tmp_path, "[UnetLoaderGGUF, OtherNode]")
    code, runner = run_boot(tmp_path, ["verify-nodes", "--env-file", ef], environ=environ,
                            http_client=fake_comfy({"OtherNode"}, []))
    assert code == 12
    record = states(tmp_path).get()
    assert record.state == State.STOPPING and record.reason == "node_import_failed"
    assert any(c[0] == "vastai" for c in runner.cmds)
    assert "UnetLoaderGGUF" in capsys.readouterr().err


def test_verify_nodes_fails_when_comfyui_is_unreachable(tmp_path):
    environ, ef = verify_prepared(tmp_path)

    def refuse(request):
        raise httpx.ConnectError("connection refused", request=request)

    code, runner = run_boot(tmp_path, ["verify-nodes", "--env-file", ef], environ=environ,
                            http_client=httpx.Client(transport=httpx.MockTransport(refuse)))
    assert code == 12 and states(tmp_path).get().reason == "node_import_failed"
    assert any(c[0] == "vastai" for c in runner.cmds)


@pytest.mark.parametrize("response", [httpx.Response(500), httpx.Response(200, content=b"not json"),
                                      httpx.Response(200, json=["UnetLoaderGGUF"])])
def test_verify_nodes_fails_on_an_error_or_nonsense_answer(tmp_path, response):
    environ, ef = verify_prepared(tmp_path)
    client = httpx.Client(transport=httpx.MockTransport(lambda r: response))
    code, _ = run_boot(tmp_path, ["verify-nodes", "--env-file", ef], environ=environ, http_client=client)
    assert code == 12 and states(tmp_path).get().reason == "node_import_failed"


def test_verify_nodes_honours_keep_on_failure(tmp_path):
    environ, ef = verify_prepared(tmp_path, KEEP_ON_FAILURE="true")
    code, runner = run_boot(tmp_path, ["verify-nodes", "--env-file", ef], environ=environ,
                            http_client=fake_comfy(set(), []))
    record = states(tmp_path).get()
    assert code == 12 and (record.state, record.reason) == (State.FAILED, "node_import_failed")
    assert runner.cmds == []


def test_verify_nodes_without_declared_classes_asks_nothing(tmp_path):
    environ = prepared(tmp_path)
    ef = env_file(tmp_path)
    with_profile(tmp_path)
    seen = []
    code, _ = run_boot(tmp_path, ["verify-nodes", "--env-file", ef], environ=environ, http_client=fake_comfy(set(), seen))
    assert code == 0 and seen == []


def test_node_import_failed_is_a_known_reason():
    from vastcomfy_agent.state import REASONS

    assert "node_import_failed" in REASONS


BIG = 16 * 1024 * 1024 + 7


def big_profile(tmp_path):
    with_profile(tmp_path)
    text = PROFILE.replace("size_bytes: 10", f"size_bytes: {BIG}")
    (tmp_path / "repo" / "instance" / "profiles" / "image.yaml").write_text(text)


def ranged_client(seen):
    body = bytes(range(256)) * (BIG // 256 + 1)
    body = body[:BIG]

    def handler(request):
        seen.append((request.method, request.headers.get("range")))
        if request.method == "HEAD":
            return httpx.Response(200, headers={"Accept-Ranges": "bytes", "Content-Length": str(BIG)})
        rng = request.headers.get("range")
        if rng is None:
            return httpx.Response(200, content=body)
        a, b = (int(x) for x in rng.split("=")[1].split("-"))
        return httpx.Response(206, content=body[a:b + 1], headers={"Content-Range": f"bytes {a}-{b}/{BIG}"})

    return httpx.Client(transport=httpx.MockTransport(handler)), body


@pytest.mark.parametrize("connections,ranged", [("2", 2), ("1", 0)])
def test_install_models_downloads_over_download_connections_ranges(tmp_path, connections, ranged):
    environ = prepared(tmp_path, DOWNLOAD_CONNECTIONS=connections)
    big_profile(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef], environ=environ)
    seen = []
    client, body = ranged_client(seen)
    code, _ = run_boot(tmp_path, ["install-models", "--env-file", ef], environ=environ, http_client=client,
                       free_bytes_fn=lambda p: 10**12)
    assert code == 0
    assert (tmp_path / "comfy" / "models" / "x" / "m.bin").read_bytes() == body
    assert len([s for s in seen if s[0] == "GET" and s[1] is not None]) == ranged


# --- INCLUDE_VIDEO_MODELS: an image-only boot skips the video files and node classes ---

VIDEO_PROFILE = """
name: image
requires: {vram_gb: 24, disk_gb: 40}
nodes: []
provides_node_classes: [UnetLoaderGGUF]
models:
  - {file: m.bin, repo: org/m, revision: r1, dest: models/x/, size_bytes: 10}
  - {file: sub/v.bin, repo: org/v, revision: r1, dest: models/v/, size_bytes: 10}
workflows: [flow.json, video.json]
video:
  enabled: true
  workflow: video.json
  models: [{file: v.bin, dest: models/v/}]
  node_classes: [SaveVideo]
"""


def with_video_profile(tmp_path):
    prof = tmp_path / "repo" / "instance" / "profiles"
    prof.mkdir(parents=True)
    (prof / "image.yaml").write_text(VIDEO_PROFILE)


def counting_client(seen):
    def handler(request):
        seen.append(request.url.path)
        return httpx.Response(200, content=b"x" * 10)

    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.mark.parametrize("include, files", [(None, ["m.bin"]), ("false", ["m.bin"]), ("true", ["m.bin", "v.bin"])])
def test_install_models_downloads_the_video_files_only_when_the_boot_includes_them(tmp_path, include, files):
    environ = prepared(tmp_path, **({} if include is None else {"INCLUDE_VIDEO_MODELS": include}))
    with_video_profile(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef], environ=environ)
    seen = []
    code, _ = run_boot(tmp_path, ["install-models", "--env-file", ef], environ=environ, http_client=counting_client(seen),
                       free_bytes_fn=lambda p: 10**12)
    assert code == 0
    assert [p.rsplit("/", 1)[-1] for p in seen] == files
    assert (tmp_path / "comfy" / "models" / "v" / "v.bin").exists() == (include == "true")


def test_an_image_only_boot_does_not_need_disk_for_the_video_files(tmp_path):
    environ = prepared(tmp_path, DISK_MARGIN_MB="0")
    with_video_profile(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef], environ=environ)
    code, _ = run_boot(tmp_path, ["install-models", "--env-file", ef], environ=environ, http_client=ok_client(),
                       free_bytes_fn=lambda p: 15)  # room for the image file, not for both
    assert code == 0
    environ = prepared(tmp_path, DISK_MARGIN_MB="0", INCLUDE_VIDEO_MODELS="true")
    code, _ = run_boot(tmp_path, ["install-models", "--env-file", ef], environ=environ, http_client=ok_client(),
                       free_bytes_fn=lambda p: 5)
    assert code == 12 and states(tmp_path).get().reason == "disk_insufficient"


@pytest.mark.parametrize("include, asked", [("false", ["UnetLoaderGGUF"]), ("true", ["UnetLoaderGGUF", "SaveVideo"])])
def test_verify_nodes_checks_the_video_classes_only_when_the_boot_includes_video(tmp_path, include, asked):
    environ = prepared(tmp_path, INCLUDE_VIDEO_MODELS=include)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef], environ=environ)
    states(tmp_path).set(State.DOWNLOADING)
    with_video_profile(tmp_path)
    seen = []
    code, _ = run_boot(tmp_path, ["verify-nodes", "--env-file", ef], environ=environ,
                       http_client=fake_comfy({"UnetLoaderGGUF"}, seen))
    assert seen == [f"/object_info/{c}" for c in asked]
    assert code == (0 if include == "false" else 12)
