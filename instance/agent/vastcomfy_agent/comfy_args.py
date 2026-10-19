from __future__ import annotations

import os
import re
import stat
from pathlib import Path

from .config import Config, ConfigError
from .files import atomic_write_bytes

# ComfyUI's command line on the Vast image (S1): its supervisor program runs /opt/supervisor-scripts/comfyui.sh,
# which sources /etc/environment and then ${WORKSPACE}/.env (with `set -a`) before
# `python main.py ${COMFYUI_ARGS}`. The web passes COMFYUI_ARGS in the instance environment for the first
# start; boot writes the full argument line, including the preview method, into ${WORKSPACE}/.env right
# before it restarts ComfyUI, so the restart that loads our nodes also gets the previews. WORKSPACE is the
# parent of COMFY_DIR in the image layout (COMFYUI_DIR=${WORKSPACE}/ComfyUI).

PREVIEW_METHODS = ("none", "latent2rgb", "taesd", "auto")
ARGS_NAME = "COMFYUI_ARGS"
_ARGS_LINE = re.compile(rf"\s*(export\s+)?{ARGS_NAME}=")
_SAFE_ARG = re.compile(r"[A-Za-z0-9-]+")
_NEW_FILE_MODE = 0o600


def render_args(cfg: Config) -> str:
    """The ComfyUI arguments: the image defaults the web also sends, plus --preview-method unless it is none."""
    method = str(cfg.comfy_preview_method)
    if method not in PREVIEW_METHODS:
        raise ConfigError(f"COMFY_PREVIEW_METHOD: must be one of {', '.join(PREVIEW_METHODS)}")
    args = ["--disable-auto-launch", "--port", str(int(cfg.comfy_port))]
    if method != "none":
        args += ["--preview-method", method]
    # The line is sourced by a shell: only plain words, so quoting can never be escaped.
    if not all(_SAFE_ARG.fullmatch(a) for a in args):
        raise ConfigError("ComfyUI arguments must be plain words")
    return " ".join(args)


def image_env_file(cfg: Config) -> Path:
    return Path(cfg.comfy_dir).parent / ".env"


def write_image_env(path: Path, args: str) -> None:
    """Set COMFYUI_ARGS in the image's ${WORKSPACE}/.env: other lines are kept, earlier COMFYUI_ARGS lines replaced."""
    path = Path(path)
    # The file belongs to the image and may hold any bytes: surrogateescape keeps other lines byte for byte.
    existing = path.read_bytes().decode("utf-8", "surrogateescape").splitlines() if path.exists() else []
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else _NEW_FILE_MODE
    kept = [line for line in existing if not _ARGS_LINE.match(line)]
    kept.append(f'{ARGS_NAME}="{args}"')
    atomic_write_bytes(path, ("\n".join(kept) + "\n").encode("utf-8", "surrogateescape"))
    os.chmod(path, mode)
