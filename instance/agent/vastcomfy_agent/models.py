from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .state import State


class Progress(BaseModel):
    phase: Literal["nodes", "models"]
    file: str
    bytes_done: int
    bytes_total: int


class QueueCounts(BaseModel):
    running: int
    pending: int


class Gpu(BaseModel):
    util_percent: int | None = None
    vram_used_mb: int | None = None
    vram_total_mb: int | None = None


class DestroyInfo(BaseModel):
    pending: bool
    attempts: int
    last_error: str | None = None


class VideoModelInfo(BaseModel):
    """The diffusion model the video workflow loads: the pinned one, or a linked one (not integrity-pinned)."""
    file: str
    linked: bool
    sha256: str | None = None


class VideoModelsRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    url: str | None = None
    # A video family other than the base section (its id); `mode` and `links` replace both experts of that mode.
    family: str | None = Field(default=None, max_length=32)
    mode: Literal["text", "image"] | None = None
    links: dict[str, str] | None = Field(default=None, max_length=4)


class VideoExpertInfo(BaseModel):
    """One diffusion expert of a video family mode: the pinned file, or a linked one (not integrity-pinned)."""
    mode: Literal["text", "image"]
    slot: str
    file: str
    linked: bool
    sha256: str | None = None


class VideoFamilyStatus(BaseModel):
    """The model files of one enabled video family on this instance (the base section's too, without experts)."""
    id: str
    state: Literal["unavailable", "not_installed", "downloading", "ready", "failed"]
    # Whether this boot downloads them itself (INCLUDE_VIDEO_MODELS and VIDEO_BOOT_FAMILIES).
    boot: bool
    bytes_done: int
    bytes_total: int
    reason: str | None = None
    experts: list[VideoExpertInfo] = []


class VideoModelsStatus(BaseModel):
    """The video model files on this instance (vastcomfy_agent.video_models)."""
    state: Literal["unavailable", "not_installed", "downloading", "ready", "failed"]
    # Whether this boot downloads them itself (INCLUDE_VIDEO_MODELS).
    boot: bool
    bytes_done: int
    bytes_total: int
    reason: str | None = None
    model: VideoModelInfo | None = None


class Status(BaseModel):
    schema_version: Literal[1] = 1
    state: State | None
    reason: str | None
    progress: Progress | None
    now: int
    boot_at: int | None
    uptime_s: int | None
    idle_destroy_at: int | None
    failsafe_at: int | None
    hard_cap_at: int | None
    queue: QueueCounts | None
    gpu: Gpu
    profile: str
    commit: str
    failsafe_alive: bool
    destroy: DestroyInfo
    video_models: VideoModelsStatus | None = None
    video_families: list[VideoFamilyStatus] | None = None


class ExtendRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    kind: Literal["idle", "failsafe"]
    minutes: int


class ExtendResponse(BaseModel):
    kind: Literal["idle", "failsafe"]
    deadline: int


class DestroyRequest(BaseModel):
    reason: Literal["manual", "watchdog"] = "manual"
