from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Mapping

import httpx

from .clock import utc_now
from .comfy import ComfyClient
from .config import ConfigError, KeySpec, default_text, load_config, load_schema, parse_env_file
from .deadlines import DeadlineStore
from .files import atomic_write
from .profile import (
    DiskInsufficient, DownloadError, Downloader, NodeInstallError, ProfileError, ProgressWriter, check_disk,
    free_bytes_of, install_nodes, load_profile, missing_models,
)
from .state import InvalidTransition, State, StateStore
from .wiring import build

EXIT_OK = 0
EXIT_MISSING_CREDS = 10
EXIT_HARD_CAP = 11
EXIT_FAILED = 12
EXIT_CONFIG = 13

CREDENTIAL_KEYS = ("CONTAINER_ID", "CONTAINER_API_KEY")


def instance_specs(schema_path: Path | None = None) -> list[KeySpec]:
    return [s for s in load_schema(schema_path) if "instance" in s.components]


def resolve_env(environ: Mapping[str, str], specs: list[KeySpec]) -> dict[str, str]:
    values = {}
    for spec in specs:
        raw = environ.get(spec.name, "")
        values[spec.name] = raw if raw != "" else default_text(spec)
    return values


def write_env(environ: Mapping[str, str], schema_path: Path | None = None) -> tuple[Path, dict[str, str], list[str]]:
    """Write the instance .env from the process environment: schema keys only, defaults resolved."""
    specs = instance_specs(schema_path)
    values = resolve_env(environ, specs)
    for name, value in values.items():
        if "\n" in value or "\r" in value:
            raise ConfigError(f"{name}: value contains a line break")
    path = Path(values["ENV_FILE_PATH"])
    atomic_write(path, "".join(f"{name}={value}\n" for name, value in values.items()))
    path.chmod(0o600)
    missing = [s.name for s in specs if s.required and values[s.name] == ""]
    return path, values, missing


def _safe_set(states: StateStore, state: State, reason: str | None = None) -> None:
    try:
        states.set(state, reason)
    except InvalidTransition:
        pass


class Boot:
    def __init__(self, env_file: Path, *, now, run, http_client, free_bytes_fn, sleep):
        self.cfg = load_config(env_file, "instance")
        self.env_file = env_file
        self.now, self.run, self.sleep, self.free_bytes_fn = now, run, sleep, free_bytes_fn
        self.http = http_client or httpx.Client(timeout=self.cfg.http_timeout_s)
        self.wired = build(self.cfg, now=now, run=run, http_client=self.http)

    def fail(self, reason: str, destroy: bool = True) -> int:
        _safe_set(self.wired.states, State.FAILED, reason)
        if destroy and not self.cfg.keep_on_failure:
            self.wired.flow.run(reason)
        return EXIT_FAILED

    def profile(self):
        return load_profile(Path(self.cfg.repo_dir) / "instance" / "profiles" / f"{self.cfg.profile}.yaml")


def cmd_write_env(environ, now, schema_path=None) -> int:
    try:
        path, values, missing = write_env(environ, schema_path)
    except ConfigError as exc:
        print(f"boot: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    states = StateStore(Path(values["STATE_DIR"]), now)
    if set(CREDENTIAL_KEYS) & set(missing):
        _safe_set(states, State.FAILED, "missing_container_credentials")
        print(f"boot: missing {', '.join(k for k in CREDENTIAL_KEYS if k in missing)}", file=sys.stderr)
        return EXIT_MISSING_CREDS
    if missing:
        _safe_set(states, State.FAILED, "config_invalid")
        print(f"boot: missing required keys: {', '.join(missing)}", file=sys.stderr)
        return EXIT_CONFIG
    print(path)
    return EXIT_OK


def cmd_init_times(b: Boot) -> int:
    result = DeadlineStore(Path(b.cfg.state_dir), b.now).init_first_boot(b.cfg.failsafe_hours, b.cfg.hard_cap_hours)
    if result == "hard_cap_missing":
        b.fail("hard_cap_missing")
        return EXIT_HARD_CAP
    print(result)
    return EXIT_OK


def cmd_install_nodes(b: Boot) -> int:
    try:
        profile = b.profile()
        install_nodes(profile, Path(b.cfg.comfy_dir), git_host=b.cfg.git_host_url, git_bin=b.cfg.git_bin,
                      pip_bin=b.cfg.pip_bin, run=b.run)
    except (ProfileError, NodeInstallError) as exc:
        print(f"boot: {exc}", file=sys.stderr)
        return b.fail("node_install_failed")
    return EXIT_OK


def cmd_install_models(b: Boot) -> int:
    _safe_set(b.wired.states, State.DOWNLOADING)
    comfy_dir = Path(b.cfg.comfy_dir)
    try:
        profile = b.profile()
        check_disk(profile, comfy_dir, b.free_bytes_fn(comfy_dir), b.cfg.disk_margin_mb)
    except DiskInsufficient as exc:
        print(f"boot: {exc}", file=sys.stderr)
        return b.fail("disk_insufficient")
    except ProfileError as exc:
        print(f"boot: {exc}", file=sys.stderr)
        return b.fail("download_failed")
    downloader = Downloader(
        hf_base=b.cfg.hf_base_url, token=b.cfg.hf_token, client=b.http, retries=b.cfg.download_retries,
        backoff_s=b.cfg.download_backoff_s, chunk_bytes=b.cfg.download_chunk_bytes, sleep=b.sleep,
        on_progress=ProgressWriter(Path(b.cfg.state_dir), "models"),
    )
    try:
        for model in missing_models(profile, comfy_dir):
            downloader.fetch(model, comfy_dir)
    except DownloadError as exc:
        print(f"boot: {exc}", file=sys.stderr)
        return b.fail("download_failed")
    return EXIT_OK


def cmd_copy_workflows(b: Boot) -> int:
    source = Path(b.cfg.repo_dir) / "instance" / "workflows"
    target = Path(b.cfg.workflows_dir)
    target.mkdir(parents=True, exist_ok=True)
    for name in b.profile().workflows:
        destination = target / name
        if not destination.exists():
            shutil.copyfile(source / name, destination)
    return EXIT_OK


def cmd_wait(b: Boot, target: str) -> int:
    if target == "comfy":
        timeout, reason = b.cfg.comfy_start_timeout_s, "comfyui_start_failed"
        check = b.wired.comfy.ready
    else:
        timeout, reason = b.cfg.agent_start_timeout_s, "agent_start_failed"
        base = f"http://{b.cfg.agent_host}:{b.cfg.agent_port}"  # config-lint: ok (local scheme)

        def check() -> bool:
            try:
                return b.http.get(f"{base}/health").status_code == 200
            except httpx.HTTPError:
                return False

    deadline = b.now() + timeout
    while True:
        if check():
            return EXIT_OK
        if b.now() >= deadline:
            return b.fail(reason)
        b.sleep(1)


def cmd_mark_ready(b: Boot) -> int:
    b.wired.idle.start()
    _safe_set(b.wired.states, State.READY)
    return EXIT_OK


def cmd_wipe_key(env_file: Path, key: str) -> int:
    values = parse_env_file(env_file)
    if key not in values:
        print(f"boot: unknown key {key}", file=sys.stderr)
        return EXIT_CONFIG
    values[key] = ""
    atomic_write(env_file, "".join(f"{k}={v}\n" for k, v in values.items()))
    env_file.chmod(0o600)
    return EXIT_OK


def cmd_env_export(env_file: Path) -> int:
    secret = {s.name for s in instance_specs() if s.secret}
    for key, value in parse_env_file(env_file).items():
        if key not in secret:
            print(f"export {key}={shlex.quote(value)}")
    return EXIT_OK


def main(
    argv: list[str] | None = None,
    *,
    environ: Mapping[str, str] = os.environ,
    now: Callable[[], int] = utc_now,
    run: Callable = subprocess.run,
    http_client: httpx.Client | None = None,
    free_bytes_fn: Callable[[Path], int] = free_bytes_of,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    parser = argparse.ArgumentParser(prog="vastcomfy_agent.boot")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("write-env")
    for name in ("begin", "init-times", "install-nodes", "install-models", "copy-workflows", "mark-ready", "env-export"):
        sub.add_parser(name).add_argument("--env-file", type=Path, required=True)
    p = sub.add_parser("fail")
    p.add_argument("reason")
    p.add_argument("--env-file", type=Path, required=True)
    p.add_argument("--no-destroy", action="store_true")
    p = sub.add_parser("wait")
    p.add_argument("--target", choices=["comfy", "agent"], required=True)
    p.add_argument("--env-file", type=Path, required=True)
    p = sub.add_parser("wipe-key")
    p.add_argument("key")
    p.add_argument("--env-file", type=Path, required=True)
    p = sub.add_parser("get")
    p.add_argument("key")
    p.add_argument("--env-file", type=Path, required=True)
    args = parser.parse_args(argv)

    if args.command == "write-env":
        return cmd_write_env(environ, now)
    if args.command == "wipe-key":
        return cmd_wipe_key(args.env_file, args.key)
    if args.command == "env-export":
        return cmd_env_export(args.env_file)
    if args.command == "get":
        print(load_config(args.env_file, "instance").get(args.key))
        return EXIT_OK

    b = Boot(args.env_file, now=now, run=run, http_client=http_client, free_bytes_fn=free_bytes_fn, sleep=sleep)
    if args.command == "begin":
        b.wired.states.reset_for_boot()
        return EXIT_OK
    if args.command == "init-times":
        return cmd_init_times(b)
    if args.command == "fail":
        return b.fail(args.reason, destroy=not args.no_destroy)
    if args.command == "install-nodes":
        return cmd_install_nodes(b)
    if args.command == "install-models":
        return cmd_install_models(b)
    if args.command == "copy-workflows":
        return cmd_copy_workflows(b)
    if args.command == "wait":
        return cmd_wait(b, args.target)
    return cmd_mark_ready(b)


if __name__ == "__main__":
    sys.exit(main())
