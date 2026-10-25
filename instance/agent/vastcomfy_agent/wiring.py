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
from .model_link import guarded_client
from .profile import Downloader, free_bytes_of, load_profile
from .extra_loras import ExtraLoras
from .video_models import VideoModels
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
        assume_yes=cfg.destroy_assume_yes,
        run=run,
    )
    flow = DestroyFlow(states, destroyer, make_stop_comfy(cfg, run))
    idle = IdleWatcher(states, deadlines, now, cfg.idle_minutes, cfg.idle_warn_minutes)
    video = VideoModels(
        load_profile=lambda: load_profile(Path(cfg.repo_dir) / "instance" / "profiles" / f"{cfg.profile}.yaml",
                                          video_enabled=cfg.video_enabled, video_families=tuple(cfg.video_families)),
        comfy=comfy,
        comfy_dir=Path(cfg.comfy_dir),
        free_bytes_fn=free_bytes_of,
        disk_margin_mb=cfg.disk_margin_mb,
        include_at_boot=cfg.include_video_models,
        boot_families=tuple(cfg.video_boot_families),
        # The boot's own downloader settings; its own HTTP client, as it runs beside the agent's requests.
        make_downloader=lambda on_progress: Downloader(
            hf_base=cfg.hf_base_url, token=cfg.hf_token, client=httpx.Client(timeout=cfg.http_timeout_s),
            retries=cfg.download_retries, backoff_s=cfg.download_backoff_s, chunk_bytes=cfg.download_chunk_bytes,
            on_progress=on_progress, connections=cfg.download_connections,
        ),
        states=states,
        state_dir=state_dir,
        link_hosts=cfg.video_model_link_hosts,
        link_max_bytes=cfg.video_model_link_max_bytes,
        make_link_client=lambda: guarded_client(
            cfg.video_model_link_hosts, cfg.video_model_link_redirect_domains, cfg.http_timeout_s,
        ),
        make_link_downloader=lambda client, link, on_progress: Downloader(
            hf_base=f"https://{link.host}", token="", client=client, retries=cfg.download_retries,  # config-lint: ok (checked link host)
            backoff_s=cfg.download_backoff_s, chunk_bytes=cfg.download_chunk_bytes, on_progress=on_progress,
            connections=cfg.download_connections,
        ),
    )
    # Extra LoRAs added by link in the web app (only with video on): synced by the web app, downloaded on demand.
    loras = ExtraLoras(
        slot=video,
        load_profile=video._load_profile,
        comfy=comfy,
        comfy_dir=Path(cfg.comfy_dir),
        free_bytes_fn=free_bytes_of,
        disk_margin_mb=cfg.disk_margin_mb,
        states=states,
        state_dir=state_dir,
        link_hosts=cfg.video_model_link_hosts,
        link_max_bytes=cfg.lora_link_max_bytes,
        total_max_bytes=cfg.lora_total_max_bytes,
        make_link_client=lambda: guarded_client(
            cfg.video_model_link_hosts, cfg.video_model_link_redirect_domains, cfg.http_timeout_s,
        ),
        make_link_downloader=lambda client, link, on_progress: Downloader(
            hf_base=f"https://{link.host}", token="", client=client, retries=cfg.download_retries,  # config-lint: ok (checked link host)
            backoff_s=cfg.download_backoff_s, chunk_bytes=cfg.download_chunk_bytes, on_progress=on_progress,
            connections=cfg.download_connections,
        ),
    ) if cfg.video_enabled else None
    runner = Runner(states=states, idle=idle, comfy=comfy, flow=flow, state_dir=state_dir, now=now,
                    destroy_failed_retry_s=cfg.destroy_failed_retry_s, busy=video.busy)
    status = StatusBuilder(
        state_dir=state_dir,
        states=states,
        deadlines=deadlines,
        comfy=comfy,
        gpu_reader=lambda: read_gpu(run, cfg.nvidia_smi_bin, cfg.http_timeout_s),
        profile=cfg.profile,
        commit=cfg.repo_commit,
        now=now,
        video=video.view,
        video_families=video.families_view,
        loras=(lambda: None) if loras is None else loras.view,
    )
    workflows = WorkflowStore(Path(cfg.workflows_dir), cfg.workflow_max_bytes)
    deps = Deps(cfg=cfg, states=states, deadlines=deadlines, status=status, flow=flow, workflows=workflows, video=video,
                loras=loras)
    return Wired(cfg, states, deadlines, comfy, destroyer, flow, idle, runner, status, workflows, deps)
