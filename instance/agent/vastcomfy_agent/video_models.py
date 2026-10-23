from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

import logging

import httpx

from .comfy import ComfyUnavailable
from .model_link import (
    ActiveLink, LinkError, ModelLink, check_model_file, clear_active, diffusion_slot, expert_spec, linked_spec,
    parse_link, read_active, read_family_links, required_loader, sha256_of, write_active, write_family_links,
)
from .models import VideoExpertInfo, VideoFamilyStatus, VideoModelInfo, VideoModelsStatus
from .profile import (
    DiskInsufficient, DownloadError, Downloader, ModelSpec, Profile, ProfileError, VideoFamilySpec, check_disk,
    family_model_specs, missing_models, target_path, video_model_specs,
)
from .state import State, StateStore

log = logging.getLogger(__name__)
GIB = 1024**3
# A link the admin can correct is a bad request; one the host refused is a conflict with the outside world.
LINK_BAD_REQUEST = frozenset({"invalid_model_link", "model_link_host_not_allowed", "model_link_unsupported_type", "model_link_name_clash"})
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
        boot_families: tuple[str, ...] | list[str] = (),
        make_downloader: Callable[[Callable[[str, int, int], None]], Downloader],
        states: StateStore,
        state_dir: Path,
        link_hosts: list[str] | tuple[str, ...] = ("huggingface.co",),
        link_max_bytes: int = 0,
        make_link_client: Callable[[], httpx.Client] | None = None,
        make_link_downloader: Callable[[httpx.Client, ModelLink, Callable[[str, int, int], None]], Downloader] | None = None,
        spawn: Callable[[Callable[[], None]], None] = _thread,
    ):
        self._load_profile = load_profile
        self._comfy = comfy
        self._comfy_dir = Path(comfy_dir)
        self._free = free_bytes_fn
        self._margin_mb = disk_margin_mb
        self._boot = include_at_boot
        self._boot_families = tuple(boot_families)
        self._make_downloader = make_downloader
        self._states = states
        self._spawn = spawn
        self._state_dir = Path(state_dir)
        self._link_hosts = list(link_hosts)
        self._link_max = link_max_bytes
        self._make_link_client = make_link_client
        self._make_link_downloader = make_link_downloader
        self._lock = threading.Lock()
        self._profile: Profile | None = None
        self._profile_error = False
        self._running = False
        # The family a running download is for (None: the base section).
        self._running_family: str | None = None
        self._failure: str | None = None
        self._family_failure: dict[str, str] = {}
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

    def _required(self, profile: Profile, link_spec: ModelSpec | None = None, use_active: bool = True) -> tuple[tuple[ModelSpec, ...], ActiveLink | None]:
        """The video files this instance needs: the pinned ones, with the diffusion slot replaced by a link (the given
        one, else the active one unless `use_active` is false)."""
        specs = video_model_specs(profile)
        slot = diffusion_slot(profile)
        active = read_active(self._state_dir) if use_active and link_spec is None else None
        replacement = link_spec
        if replacement is None and active is not None:
            replacement = ModelSpec(file=active.file, repo=active.repo, revision=active.revision, dest=active.dest,
                                    size_bytes=active.size_bytes)
        if replacement is None or slot is None:
            return specs, None
        return tuple(replacement if m == slot else m for m in specs), active

    def _model_info(self, profile: Profile, active: ActiveLink | None) -> VideoModelInfo | None:
        if active is not None:
            return VideoModelInfo(file=active.name, linked=True, sha256=active.sha256)
        slot = diffusion_slot(profile)
        return None if slot is None else VideoModelInfo(file=slot.file.rsplit("/", 1)[-1], linked=False, sha256=None)

    def _boot_of_base(self) -> bool:
        return self._base_boot(self._profile)

    def busy(self) -> bool:
        with self._lock:
            return self._running

    def view(self) -> VideoModelsStatus:
        with self._lock:
            return self._view()

    def _base_boot(self, profile: Profile | None) -> bool:
        """Whether this boot downloads the base section's files: INCLUDE_VIDEO_MODELS, and VIDEO_BOOT_FAMILIES names it
        (or nothing)."""
        if not self._boot or profile is None or not self._boot_families:
            return self._boot
        return profile.video_base_id in self._boot_families

    def _view(self) -> VideoModelsStatus:
        if self._running and self._running_family is None:
            return VideoModelsStatus(state="downloading", boot=self._boot_of_base(), bytes_done=self._done, bytes_total=self._total)
        profile = self._video_profile()
        if profile is None:
            return VideoModelsStatus(state="unavailable", boot=self._boot, bytes_done=0, bytes_total=0)
        boot = self._base_boot(profile)
        specs, active = self._required(profile)
        model = self._model_info(profile, active)
        missing = missing_models(profile, self._comfy_dir, specs)
        total = sum(m.size_bytes for m in specs)
        if self._failure is not None:
            left = sum(m.size_bytes for m in missing)
            return VideoModelsStatus(state="failed", boot=boot, bytes_done=total - left, bytes_total=total,
                                     reason=self._failure, model=model)
        if not missing:
            return VideoModelsStatus(state="ready", boot=boot, bytes_done=total, bytes_total=total, model=model)
        return VideoModelsStatus(state="not_installed", boot=boot, bytes_done=0,
                                 bytes_total=sum(m.size_bytes for m in missing), model=model)

    def start(self, url: str | None = None) -> VideoModelsStatus:
        """Fetch the missing video files. With `url` its file replaces the diffusion model (validated, its size from a
        HEAD, before anything else); without one the pinned model is used again (an active link is dropped)."""
        link: ModelLink | None = None
        link_spec: ModelSpec | None = None
        link_client: httpx.Client | None = None
        if url:
            profile = self._video_profile()
            if profile is None:
                raise VideoModelsRefused(404, "video_unavailable", "the profile has no enabled video section")
            if self._make_link_client is None or self._make_link_downloader is None:
                raise VideoModelsRefused(400, "invalid_model_link", "model links are not set up on this instance")
            link_client = self._make_link_client()
            try:  # outside the lock: a HEAD to the model host must never hold up /status
                link_spec, link = linked_spec(url, profile, hosts=self._link_hosts, client=link_client, max_bytes=self._link_max)
            except LinkError as err:
                raise VideoModelsRefused(400 if err.code in LINK_BAD_REQUEST else 409, err.code, _clip(err.message)) from None
        with self._lock:
            self._refuse_other(None)
            if self._running:
                return self._view()
            profile = self._video_profile()
            if profile is None:
                raise VideoModelsRefused(404, "video_unavailable", "the profile has no enabled video section")
            if self._states.get().state not in SERVING:
                raise VideoModelsRefused(409, "not_ready", "the instance is not ready")
            required, _active = self._required(profile, link_spec, use_active=False)
            missing = missing_models(profile, self._comfy_dir, required)
            switching = link is not None or read_active(self._state_dir) is not None
            if not missing and not switching:
                self._failure = None
                return self._view()
            # Before a single byte: ComfyUI must have the native nodes, and the disk must hold the files.
            loader = None if link is None else required_loader(link.name)
            classes = profile.video_node_classes + ((loader,) if loader is not None and loader not in profile.video_node_classes else ())
            try:
                absent = [c for c in classes if not self._comfy.node_class_registered(c)]
            except ComfyUnavailable:
                raise VideoModelsRefused(503, "comfy_unavailable", "ComfyUI could not be asked for its node classes") from None
            if loader is not None and loader in absent:
                raise VideoModelsRefused(
                    409, "video_gguf_loader_missing",
                    f"a .gguf video model needs the ComfyUI node class {loader}, which this instance does not have",
                )
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
            self._running_family = None
            self._failure = None
            self._done = 0
            self._total = sum(m.size_bytes for m in missing)
            names = tuple(m.file.rsplit("/", 1)[-1] for m in required)
            view = self._view()
        self._spawn(lambda: self._run(missing, names, classes, link, link_spec, link_client))
        return view

    def _run(self, missing: list[ModelSpec], names: tuple[str, ...], classes: tuple[str, ...], link: ModelLink | None = None,
             link_spec: ModelSpec | None = None, link_client: httpx.Client | None = None) -> None:
        failure: str | None = None
        before = 0

        def on_progress(_file: str, done: int, _total: int) -> None:
            with self._lock:
                self._done = before + done

        try:
            downloader = self._make_downloader(on_progress)
            for model in missing:
                if link is not None and model == link_spec:
                    self._make_link_downloader(link_client, link, on_progress).fetch(model, self._comfy_dir)
                else:
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
            elif link is not None and link_spec is not None:
                target = target_path(link_spec, self._comfy_dir)
                try:
                    check_model_file(target)  # GGUF magic bytes, or a sane safetensors header
                except LinkError:
                    target.unlink(missing_ok=True)
                    raise
                # Not integrity-pinned: what arrived is hashed and reported, never checked against a pin.
                sha = sha256_of(target)
                write_active(self._state_dir, ActiveLink(url=link.url, repo=link.repo, revision=link.revision, file=link.file,
                                                         name=link.name, dest=link_spec.dest, size_bytes=link_spec.size_bytes,
                                                         sha256=sha))
                log.info("linked video model %s from %s@%s: sha256 %s (not pinned)", link.name, link.repo, link.revision, sha)
            else:
                clear_active(self._state_dir)
        except LinkError as exc:
            failure = f"{exc.code}: {exc.message}"
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

    # ---- the families of `video_families:` (the base section keeps the methods above, unchanged) ----

    def _refuse_other(self, family: str | None) -> None:
        """Single-flight across families: one video download at a time (call with the lock held)."""
        if self._running and self._running_family != family:
            raise VideoModelsRefused(409, "video_download_busy",
                                     "another video model download is running on this instance; try again when it is done")

    def _enabled_family(self, profile: Profile, family: str) -> VideoFamilySpec | None:
        return next((f for f in profile.video_families if f.id == family and f.enabled), None)

    def _family_required(self, profile: Profile, fam: VideoFamilySpec, replace: dict[str, ModelSpec] | None = None,
                         ) -> tuple[ModelSpec, ...]:
        """The family's files, each linked expert in place of its pinned file (`replace` by "<mode>.<slot>", else the
        active links)."""
        if replace is None:
            replace = {key: ModelSpec(file=a.file, repo=a.repo, revision=a.revision, dest=a.dest, size_bytes=a.size_bytes)
                       for key, a in read_family_links(self._state_dir, fam.id).items()}
        by_file = {file: f"{mode}.{slot}" for mode, slot, file in fam.experts}
        out = []
        for m in family_model_specs(profile, fam.id):
            key = by_file.get(m.file.rsplit("/", 1)[-1])
            out.append(replace.get(key, m) if key is not None else m)
        return tuple(out)

    def _family_view(self, profile: Profile, fam: VideoFamilySpec) -> VideoFamilyStatus:
        active = read_family_links(self._state_dir, fam.id)
        experts = [
            VideoExpertInfo(mode=mode, slot=slot, file=active[f"{mode}.{slot}"].name if f"{mode}.{slot}" in active else file,
                            linked=f"{mode}.{slot}" in active,
                            sha256=active[f"{mode}.{slot}"].sha256 if f"{mode}.{slot}" in active else None)
            for mode, slot, file in fam.experts
        ]
        boot = self._boot and fam.id in self._boot_families
        if self._running and self._running_family == fam.id:
            return VideoFamilyStatus(id=fam.id, state="downloading", boot=boot, bytes_done=self._done, bytes_total=self._total,
                                     experts=experts)
        specs = self._family_required(profile, fam)
        missing = missing_models(profile, self._comfy_dir, specs)
        total = sum(m.size_bytes for m in specs)
        left = sum(m.size_bytes for m in missing)
        failure = self._family_failure.get(fam.id)
        if failure is not None:
            return VideoFamilyStatus(id=fam.id, state="failed", boot=boot, bytes_done=total - left, bytes_total=total,
                                     reason=failure, experts=experts)
        if not missing:
            return VideoFamilyStatus(id=fam.id, state="ready", boot=boot, bytes_done=total, bytes_total=total, experts=experts)
        return VideoFamilyStatus(id=fam.id, state="not_installed", boot=boot, bytes_done=0, bytes_total=left, experts=experts)

    def _base_family_view(self, profile: Profile) -> VideoFamilyStatus:
        base = self._view()
        return VideoFamilyStatus(id=profile.video_base_id, state=base.state, boot=base.boot, bytes_done=base.bytes_done,
                                 bytes_total=base.bytes_total, reason=base.reason)

    def families_view(self) -> list[VideoFamilyStatus]:
        """Every enabled family: the base section first, then each one VIDEO_FAMILIES lists (empty with video off)."""
        with self._lock:
            profile = self._video_profile()
            if profile is None:
                return []
            return [self._base_family_view(profile)] + [self._family_view(profile, f) for f in profile.video_families if f.enabled]

    def request(self, *, family: str | None = None, url: str | None = None, mode: str | None = None,
                links: dict[str, str] | None = None) -> VideoModelsStatus | VideoFamilyStatus:
        """POST /video-models: the base section (no family, or its id) with an optional `url`; another family with
        optional `links` for both experts of `mode`."""
        profile = self._video_profile()
        if family is None or (profile is not None and family == profile.video_base_id):
            if mode is not None or links:
                raise VideoModelsRefused(400, "invalid_model_link", "the base video model takes one link (url), not expert links")
            return self.start(url)
        if url:
            raise VideoModelsRefused(400, "invalid_model_link", "a video family takes expert links (mode, links), not a url")
        return self.start_family(family, mode, links)

    def start_family(self, family: str, mode: str | None = None, links: dict[str, str] | None = None) -> VideoFamilyStatus:
        """Fetch the family's missing files. With `links` (every expert slot of `mode`, all together) those files
        replace the mode's pinned experts (each validated, its size from a HEAD, before anything else); the other
        mode's links are kept. Without links the pinned experts are used again (all of the family's links dropped)."""
        profile = self._video_profile()
        fam = None if profile is None else self._enabled_family(profile, family)
        if fam is None:
            raise VideoModelsRefused(404, "video_unavailable", "this video family is not switched on here")
        new: dict[str, tuple[ModelSpec, ModelLink]] = {}
        link_client: httpx.Client | None = None
        if links:
            if mode not in ("text", "image"):
                raise VideoModelsRefused(400, "invalid_model_link", "expert links need the mode they are for (text or image)")
            slots = {slot: file for m, slot, file in fam.experts if m == mode}
            if set(links) != set(slots):
                raise VideoModelsRefused(400, "invalid_model_link",
                                         f"link every expert of the mode together: {', '.join(sorted(slots))}")
            if self._make_link_client is None or self._make_link_downloader is None:
                raise VideoModelsRefused(400, "invalid_model_link", "model links are not set up on this instance")
            try:
                # Every link is parsed before any request leaves; two links to one file name are refused.
                parsed = {slot: parse_link(url, self._link_hosts) for slot, url in links.items()}
                if len({p.name for p in parsed.values()}) != len(parsed):
                    raise LinkError("model_link_name_clash", "the expert links name the same file")
                kept = {k: a for k, a in read_family_links(self._state_dir, fam.id).items() if not k.startswith(f"{mode}.")}
                taken = tuple(a.name for a in kept.values())
                base_active = read_active(self._state_dir)
                taken += (base_active.name,) if base_active is not None else ()
                link_client = self._make_link_client()
                for slot, url in sorted(links.items()):  # outside the lock: a HEAD must never hold up /status
                    dest = next(m.dest for m in profile.models if m.file.rsplit("/", 1)[-1] == slots[slot])
                    new[f"{mode}.{slot}"] = expert_spec(url, profile, dest, hosts=self._link_hosts, client=link_client,
                                                        max_bytes=self._link_max, taken=taken)
            except LinkError as err:
                raise VideoModelsRefused(400 if err.code in LINK_BAD_REQUEST else 409, err.code, _clip(err.message)) from None
        elif mode is not None and mode not in ("text", "image"):
            raise VideoModelsRefused(400, "invalid_model_link", "the mode must be text or image")
        with self._lock:
            self._refuse_other(fam.id)
            if self._running:
                return self._family_view(profile, fam)
            if self._states.get().state not in SERVING:
                raise VideoModelsRefused(409, "not_ready", "the instance is not ready")
            kept = {k: a for k, a in read_family_links(self._state_dir, fam.id).items()
                    if new and not k.startswith(f"{mode}.")}
            replace = {k: ModelSpec(file=a.file, repo=a.repo, revision=a.revision, dest=a.dest, size_bytes=a.size_bytes)
                       for k, a in kept.items()}
            replace.update({k: spec for k, (spec, _link) in new.items()})
            required = self._family_required(profile, fam, replace)
            missing = missing_models(profile, self._comfy_dir, required)
            switching = bool(new) or bool(read_family_links(self._state_dir, fam.id))
            if not missing and not switching:
                self._family_failure.pop(fam.id, None)
                return self._family_view(profile, fam)
            loaders = {required_loader(link.name) for _spec, link in new.values()} | {
                required_loader(a.name) for a in kept.values()}
            loaders.discard(None)
            classes = fam.node_classes + tuple(sorted(c for c in loaders if c not in fam.node_classes))
            try:
                absent = [c for c in classes if not self._comfy.node_class_registered(c)]
            except ComfyUnavailable:
                raise VideoModelsRefused(503, "comfy_unavailable", "ComfyUI could not be asked for its node classes") from None
            gguf = [c for c in absent if c in loaders]
            if gguf:
                raise VideoModelsRefused(409, "video_gguf_loader_missing",
                                         f"a .gguf video model needs the ComfyUI node class {gguf[0]}, which this instance does not have")
            if absent:
                raise VideoModelsRefused(409, "video_nodes_missing", _clip(
                    f"ComfyUI on this instance lacks the node classes {', '.join(absent)}; a newer instance image is needed"))
            free = self._free(self._comfy_dir)
            try:
                check_disk(profile, self._comfy_dir, free, self._margin_mb, tuple(missing))
            except DiskInsufficient:
                need = sum(m.size_bytes for m in missing) + self._margin_mb * 1024 * 1024
                raise VideoModelsRefused(
                    409, "disk_insufficient",
                    f"the instance disk is too small for this video family: {need / GIB:.1f} GB needed, {free / GIB:.1f} GB "
                    "free; start the next instance with this family included (it rents a larger disk)",
                ) from None
            self._running = True
            self._running_family = fam.id
            self._family_failure.pop(fam.id, None)
            self._done = 0
            self._total = sum(m.size_bytes for m in missing)
            names = tuple(m.file.rsplit("/", 1)[-1] for m in required)
            view = self._family_view(profile, fam)
        self._spawn(lambda: self._run_family(fam.id, missing, names, classes, new, kept, link_client))
        return view

    def _run_family(self, family: str, missing: list[ModelSpec], names: tuple[str, ...], classes: tuple[str, ...],
                    new: dict[str, tuple[ModelSpec, ModelLink]], kept: dict[str, ActiveLink],
                    link_client: httpx.Client | None) -> None:
        failure: str | None = None
        before = 0
        by_spec = {spec: link for spec, link in new.values()}

        def on_progress(_file: str, done: int, _total: int) -> None:
            with self._lock:
                self._done = before + done

        try:
            downloader = self._make_downloader(on_progress)
            for model in missing:
                link = by_spec.get(model)
                if link is not None:
                    self._make_link_downloader(link_client, link, on_progress).fetch(model, self._comfy_dir)
                else:
                    downloader.fetch(model, self._comfy_dir)
                before += model.size_bytes
                with self._lock:
                    self._done = before
            unlisted = self._comfy.unlisted_files(classes, names)
            if unlisted:
                failure = (f"ComfyUI does not list {', '.join(unlisted)} yet; it needs a restart (or start the next "
                           "instance with this family included)")
            else:
                active = dict(kept)
                for key, (spec, link) in sorted(new.items()):
                    target = target_path(spec, self._comfy_dir)
                    try:
                        check_model_file(target)  # GGUF magic bytes, or a sane safetensors header
                    except LinkError:
                        for other, _l in new.values():
                            target_path(other, self._comfy_dir).unlink(missing_ok=True)
                        raise
                    # Not integrity-pinned: what arrived is hashed and reported, never checked against a pin.
                    sha = sha256_of(target)
                    active[key] = ActiveLink(url=link.url, repo=link.repo, revision=link.revision, file=link.file,
                                             name=link.name, dest=spec.dest, size_bytes=spec.size_bytes, sha256=sha)
                    log.info("linked video expert %s of %s: %s from %s@%s: sha256 %s (not pinned)", key, family, link.name,
                             link.repo, link.revision, sha)
                write_family_links(self._state_dir, family, active)
        except LinkError as exc:
            failure = f"{exc.code}: {exc.message}"
        except DownloadError as exc:
            failure = f"download failed: {exc}"
        except ComfyUnavailable:
            failure = "ComfyUI could not be asked whether it lists the new files"
        except Exception as exc:  # the state must never stay "downloading"
            failure = f"unexpected error ({type(exc).__name__})"
        finally:
            with self._lock:
                self._running = False
                self._running_family = None
                if failure is None:
                    self._family_failure.pop(family, None)
                else:
                    self._family_failure[family] = _clip(failure)
