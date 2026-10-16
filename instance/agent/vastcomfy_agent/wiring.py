from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import httpx

from .app import Deps
from .clock import utc_now
from .comfy import ComfyClient, read_gpu
from .config import Config
from .deadlines import DeadlineStore
from .destroy_flow import DestroyFlow
from .destroyer import Destroyer
from .idle import IdleWatcher
from .runner import Runner
from .state import StateStore
from .status import StatusBuilder
from .workflows import WorkflowStore


@dataclass
class Wired:
    cfg: Config
    states: StateStore
    deadlines: DeadlineStore
    comfy: ComfyClient
    destroyer: Destroyer
    flow: DestroyFlow
    idle: IdleWatcher
    runner: Runner
    status: StatusBuilder
    workflows: WorkflowStore
    deps: Deps


def make_stop_comfy(cfg: Config, run: Callable = subprocess.run) -> Callable[[], None]:
    command = [cfg.supervisorctl_bin, "-c", cfg.supervisor_conf, "stop", cfg.comfy_program]

    def stop() -> None:
        run(command, capture_output=True, text=True, timeout=cfg.destroy_timeout_s)

    return stop


def build(
    cfg: Config,
    now: Callable[[], int] = utc_now,
    run: Callable = subprocess.run,
    http_client: httpx.Client | None = None,
) -> Wired:
    state_dir = Path(cfg.state_dir)
    states = StateStore(state_dir, now)
    deadlines = DeadlineStore(state_dir, now)
    client = http_client or httpx.Client(timeout=cfg.http_timeout_s)
    comfy = ComfyClient(f"http://{cfg.comfy_host}:{cfg.comfy_port}", client)  # config-lint: ok (local scheme)
    destroyer = Destroyer(
        vastai_bin=cfg.vastai_bin,
        container_id=cfg.container_id,
        api_key=cfg.container_api_key,
        retries=cfg.destroy_retries,
        backoff_s=cfg.destroy_backoff_s,
        timeout_s=cfg.destroy_timeout_s,
        gone_markers=cfg.destroy_gone_markers,
        ok_markers=cfg.destroy_ok_markers,
        state_dir=state_dir,
        run=run,
    )
    flow = DestroyFlow(states, destroyer, make_stop_comfy(cfg, run))
    idle = IdleWatcher(states, deadlines, now, cfg.idle_minutes, cfg.idle_warn_minutes)
    runner = Runner(states=states, idle=idle, comfy=comfy, flow=flow, state_dir=state_dir, now=now,
                    destroy_failed_retry_s=cfg.destroy_failed_retry_s)
    status = StatusBuilder(
        state_dir=state_dir,
        states=states,
        deadlines=deadlines,
        comfy=comfy,
        gpu_reader=lambda: read_gpu(run, cfg.nvidia_smi_bin, cfg.http_timeout_s),
        profile=cfg.profile,
        commit=cfg.repo_commit,
        now=now,
    )
    workflows = WorkflowStore(Path(cfg.workflows_dir), cfg.workflow_max_bytes)
    deps = Deps(cfg=cfg, states=states, deadlines=deadlines, status=status, flow=flow, workflows=workflows)
    return Wired(cfg, states, deadlines, comfy, destroyer, flow, idle, runner, status, workflows, deps)
