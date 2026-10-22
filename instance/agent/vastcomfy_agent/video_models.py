from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

from .comfy import ComfyUnavailable
from .models import VideoModelsStatus
from .profile import (
    DiskInsufficient, DownloadError, Downloader, ModelSpec, Profile, ProfileError, check_disk, missing_models,
    video_model_specs,
)
from .state import State, StateStore

GIB = 1024**3
MESSAGE_MAX = 240
# The instance must be serving images: never during the boot (which downloads on its own) or while stopping.
SERVING = frozenset({State.READY, State.IDLE_WARNING})


class VideoModelsRefused(Exception):
    """A download that cannot start: an HTTP status, a fixed code and a short message for the web app."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _clip(text: str) -> str:
    return text if len(text) <= MESSAGE_MAX else text[:MESSAGE_MAX] + "..."


def _thread(target: Callable[[], None]) -> None:
    threading.Thread(target=target, name="video-models", daemon=True).start()


class VideoModels:
    """The video section's model files on a running instance. A boot with INCLUDE_VIDEO_MODELS downloads them like
    every other model; an image-only boot leaves them out, and `start()` fetches them later in the background with
    the boot's own code path (pinned size, ranged download into a .part file, then an atomic rename; the disk check
    first). Single-flight: a second start while one runs changes nothing. Only the missing files are fetched, so a
    download cut off by a crash or a restart simply starts over for the files that are not complete. The state is
    in memory; after an agent restart it is read back from the disk (all files present: ready)."""

    def __init__(
        self,
        *,
        load_profile: Callable[[], Profile],
        comfy,
        comfy_dir: Path,
        free_bytes_fn: Callable[[Path], int],
        disk_margin_mb: int,
        include_at_boot: bool,
        make_downloader: Callable[[Callable[[str, int, int], None]], Downloader],
        states: StateStore,
        spawn: Callable[[Callable[[], None]], None] = _thread,
    ):
        self._load_profile = load_profile
        self._comfy = comfy
        self._comfy_dir = Path(comfy_dir)
        self._free = free_bytes_fn
        self._margin_mb = disk_margin_mb
        self._boot = include_at_boot
        self._make_downloader = make_downloader
        self._states = states
        self._spawn = spawn
        self._lock = threading.Lock()
        self._profile: Profile | None = None
        self._profile_error = False
        self._running = False
        self._failure: str | None = None
        self._done = 0
        self._total = 0

    def _video_profile(self) -> Profile | None:
        """The profile when it enables video, else None (read once; a broken profile counts as no video)."""
        if self._profile is None and not self._profile_error:
            try:
                self._profile = self._load_profile()
            except ProfileError:
                self._profile_error = True
        return self._profile if self._profile is not None and self._profile.video_enabled else None

    def busy(self) -> bool:
        with self._lock:
            return self._running

    def view(self) -> VideoModelsStatus:
        with self._lock:
            return self._view()

    def _view(self) -> VideoModelsStatus:
        if self._running:
            return VideoModelsStatus(state="downloading", boot=self._boot, bytes_done=self._done, bytes_total=self._total)
        profile = self._video_profile()
        if profile is None:
            return VideoModelsStatus(state="unavailable", boot=self._boot, bytes_done=0, bytes_total=0)
        specs = video_model_specs(profile)
        missing = missing_models(profile, self._comfy_dir, specs)
        total = sum(m.size_bytes for m in specs)
        if self._failure is not None:
            left = sum(m.size_bytes for m in missing)
            return VideoModelsStatus(state="failed", boot=self._boot, bytes_done=total - left, bytes_total=total,
                                     reason=self._failure)
        if not missing:
            return VideoModelsStatus(state="ready", boot=self._boot, bytes_done=total, bytes_total=total)
        return VideoModelsStatus(state="not_installed", boot=self._boot, bytes_done=0,
                                 bytes_total=sum(m.size_bytes for m in missing))

    def start(self) -> VideoModelsStatus:
        with self._lock:
            if self._running:
                return self._view()
            profile = self._video_profile()
            if profile is None:
                raise VideoModelsRefused(404, "video_unavailable", "the profile has no enabled video section")
            if self._states.get().state not in SERVING:
                raise VideoModelsRefused(409, "not_ready", "the instance is not ready")
            missing = missing_models(profile, self._comfy_dir, video_model_specs(profile))
            if not missing:
                self._failure = None
                return self._view()
            # Before a single byte: ComfyUI must have the native nodes, and the disk must hold the files.
            try:
                absent = [c for c in profile.video_node_classes if not self._comfy.node_class_registered(c)]
            except ComfyUnavailable:
                raise VideoModelsRefused(503, "comfy_unavailable", "ComfyUI could not be asked for its node classes") from None
            if absent:
                raise VideoModelsRefused(
                    409, "video_nodes_missing",
                    _clip(f"ComfyUI on this instance lacks the node classes {', '.join(absent)}; a newer instance image is needed"),
                )
            free = self._free(self._comfy_dir)
            try:
                check_disk(profile, self._comfy_dir, free, self._margin_mb, tuple(missing))
            except DiskInsufficient:
                need = sum(m.size_bytes for m in missing) + self._margin_mb * 1024 * 1024
                raise VideoModelsRefused(
                    409, "disk_insufficient",
                    f"the instance disk is too small for the video models: {need / GIB:.1f} GB needed, {free / GIB:.1f} GB "
                    "free; start the next instance with Include video models (it rents a larger disk)",
                ) from None
            self._running = True
            self._failure = None
            self._done = 0
            self._total = sum(m.size_bytes for m in missing)
            names = tuple(m.file.rsplit("/", 1)[-1] for m in missing)
            classes = profile.video_node_classes
            view = self._view()
        self._spawn(lambda: self._run(missing, names, classes))
        return view

    def _run(self, missing: list[ModelSpec], names: tuple[str, ...], classes: tuple[str, ...]) -> None:
        failure: str | None = None
        before = 0

        def on_progress(_file: str, done: int, _total: int) -> None:
            with self._lock:
                self._done = before + done

        try:
            downloader = self._make_downloader(on_progress)
            for model in missing:
                downloader.fetch(model, self._comfy_dir)
                before += model.size_bytes
                with self._lock:
                    self._done = before
            # ComfyUI re-reads its model folders when they change, so a running ComfyUI should list the new files
            # without a restart. Checked rather than assumed: a restart would cut off running image jobs.
            unlisted = self._comfy.unlisted_files(classes, names)
            if unlisted:
                failure = (f"ComfyUI does not list {', '.join(unlisted)} yet; it needs a restart (or start the next "
                           "instance with Include video models)")
        except DownloadError as exc:
            failure = f"download failed: {exc}"
        except ComfyUnavailable:
            failure = "ComfyUI could not be asked whether it lists the new files"
        except Exception as exc:  # the state must never stay "downloading"
            failure = f"unexpected error ({type(exc).__name__})"
        finally:
            with self._lock:
                self._running = False
                self._failure = None if failure is None else _clip(failure)
