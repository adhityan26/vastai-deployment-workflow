import stat

import pytest

from vastcomfy_agent import comfy_args
from vastcomfy_agent.config import ConfigError, load_schema

from test_boot import env_file, prepared, run_boot, states


def test_the_preview_method_is_a_schema_key_with_a_closed_list_defaulting_to_latent2rgb():
    spec = next(s for s in load_schema() if s.name == "COMFY_PREVIEW_METHOD")
    assert spec.components == ("instance", "apps")
    assert spec.default == "latent2rgb"
    assert spec.choices == comfy_args.PREVIEW_METHODS == ("none", "latent2rgb", "taesd", "auto")


@pytest.mark.parametrize("method", ["latent2rgb", "taesd", "auto"])
def test_render_adds_the_preview_method_to_the_image_defaults(make_cfg, method):
    cfg = make_cfg(COMFY_PREVIEW_METHOD=method, COMFY_PORT="18188")
    assert comfy_args.render_args(cfg) == f"--disable-auto-launch --port 18188 --preview-method {method}"


def test_render_without_previews_is_exactly_what_the_web_sends(make_cfg):
    assert comfy_args.render_args(make_cfg(COMFY_PREVIEW_METHOD="none", COMFY_PORT="18190")) == "--disable-auto-launch --port 18190"


def test_the_default_is_latent2rgb(make_cfg):
    assert comfy_args.render_args(make_cfg()).endswith("--preview-method latent2rgb")


@pytest.mark.parametrize("bad", ["fast", "latent2rgb; rm -rf /", "TAESD", "none "])
def test_an_unknown_preview_method_is_refused_by_the_config(make_cfg, bad):
    with pytest.raises(ConfigError, match="COMFY_PREVIEW_METHOD: must be one of none, latent2rgb, taesd, auto"):
        make_cfg(COMFY_PREVIEW_METHOD=bad)


def test_the_image_env_file_is_next_to_the_comfy_dir(make_cfg, tmp_path):
    assert comfy_args.image_env_file(make_cfg(COMFY_DIR=str(tmp_path / "ws" / "ComfyUI"))) == tmp_path / "ws" / ".env"


def test_write_creates_a_private_file_and_replaces_only_earlier_args_lines(tmp_path):
    path = tmp_path / ".env"
    comfy_args.write_image_env(path, "--port 1")
    assert path.read_text() == 'COMFYUI_ARGS="--port 1"\n'
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    path.write_text('FOO=bar\nexport COMFYUI_ARGS="--old"\n# keep me\n  COMFYUI_ARGS=--older\nCOMFYUI_ARGS_EXTRA=1\n')
    path.chmod(0o640)
    comfy_args.write_image_env(path, "--port 2 --preview-method latent2rgb")
    assert path.read_text() == 'FOO=bar\n# keep me\nCOMFYUI_ARGS_EXTRA=1\nCOMFYUI_ARGS="--port 2 --preview-method latent2rgb"\n'
    assert stat.S_IMODE(path.stat().st_mode) == 0o640


def test_the_written_line_is_what_a_shell_reads_back(tmp_path):
    import subprocess

    path = tmp_path / ".env"
    comfy_args.write_image_env(path, "--disable-auto-launch --port 18188 --preview-method latent2rgb")
    out = subprocess.run(["bash", "-c", f'set -a; . "{path}"; set +a; printf "%s" "$COMFYUI_ARGS"'],
                         capture_output=True, text=True, check=True).stdout
    assert out == "--disable-auto-launch --port 18188 --preview-method latent2rgb"


def test_boot_comfy_args_writes_the_workspace_env(tmp_path):
    prepared(tmp_path)
    code, _ = run_boot(tmp_path, ["comfy-args", "--env-file", env_file(tmp_path)])
    assert code == 0
    assert (tmp_path / ".env").read_text() == 'COMFYUI_ARGS="--disable-auto-launch --port 18188 --preview-method latent2rgb"\n'


def test_boot_comfy_args_write_failure_only_warns_and_keeps_the_instance(tmp_path, monkeypatch, capsys):
    """A failed write (read-only, full disk) must not destroy a paid instance: ComfyUI restarts with its old
    arguments, so only the previews are missing."""
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])

    def broken(path, args):
        raise PermissionError("read-only")

    monkeypatch.setattr("vastcomfy_agent.boot.write_image_env", broken)
    code, runner = run_boot(tmp_path, ["comfy-args", "--env-file", ef])
    assert code == 0
    assert not any(c[0] == "vastai" for c in runner.cmds)
    assert states(tmp_path).get().reason is None
    err = capsys.readouterr().err
    assert "warning" in err and "without previews" in err
    assert "ck" not in err.replace("check", "")  # no container key


def test_boot_comfy_args_config_error_self_destroys_as_a_comfyui_start_failure(tmp_path, monkeypatch):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])

    def bad(cfg):
        raise comfy_args.ConfigError("COMFY_PREVIEW_METHOD: must be one of none, latent2rgb, taesd, auto")

    monkeypatch.setattr("vastcomfy_agent.boot.render_args", bad)
    code, runner = run_boot(tmp_path, ["comfy-args", "--env-file", ef])
    assert code == 12 and states(tmp_path).get().reason == "comfyui_start_failed"
    assert any(c[0] == "vastai" for c in runner.cmds)


def test_the_web_and_the_instance_send_the_same_base_arguments(make_cfg):
    """apps/core/src/lifecycle.ts sets COMFYUI_ARGS for the first start; boot rewrites it before the restart.
    Both must agree on everything except the preview method, or the restart would change ComfyUI's behaviour."""
    import re
    from pathlib import Path

    source = (Path(__file__).resolve().parents[3] / "apps" / "core" / "src" / "lifecycle.ts").read_text()
    match = re.search(r"COMFYUI_ARGS: `([^`]*)`", source)
    assert match, "lifecycle.ts no longer sets COMFYUI_ARGS as a template string"
    web = match.group(1).replace("${comfyPort}", "18190")
    assert comfy_args.render_args(make_cfg(COMFY_PREVIEW_METHOD="none", COMFY_PORT="18190")) == web
