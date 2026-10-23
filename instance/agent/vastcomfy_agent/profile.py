from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable

import httpx
import yaml

from .files import write_json
from .paths import StatePaths
from .ranged import RangedDownload, RangeUnsupported, SegmentError, ranges_supported
from .workflows import NAME_RE


class ProfileError(Exception):
    pass


class DiskInsufficient(Exception):
    pass


class DownloadError(Exception):
    pass


class NodeInstallError(Exception):
    pass


# Node class names a profile declares (provides_node_classes) are put into a ComfyUI URL path, so only plain
# identifiers are accepted.
NODE_CLASS_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,127}")


@dataclass(frozen=True)
class NodeSpec:
    repo: str
    commit: str


@dataclass(frozen=True)
class ModelSpec:
    file: str
    repo: str
    revision: str
    dest: str
    size_bytes: int


@dataclass(frozen=True)
class ParamRef:
    node: str
    input: str


@dataclass(frozen=True)
class GenerateParams:
    prompt: ParamRef
    steps: ParamRef
    width: ParamRef
    height: ParamRef
    seed: ParamRef


@dataclass(frozen=True)
class QualityPreset:
    name: str
    steps: int


@dataclass(frozen=True)
class SizeSpec:
    name: str
    width: int
    height: int


@dataclass(frozen=True)
class GenerateSpec:
    workflow: str
    params: GenerateParams
    quality_presets: tuple[QualityPreset, ...]
    sizes: tuple[SizeSpec, ...]


@dataclass(frozen=True)
class VideoFamilySpec:
    """One of the profile's `video_families:` (the web app owns the rest: apps/core/src/video.ts)."""
    id: str
    title: str
    # VIDEO_ENABLED and listed in VIDEO_FAMILIES (then every file is pinned).
    enabled: bool
    models: tuple[str, ...]
    node_classes: tuple[str, ...]
    # (mode, slot, file): the diffusion files of a mode an admin may replace with links (all of a mode together).
    experts: tuple[tuple[str, str, str], ...]


@dataclass(frozen=True)
class Profile:
    name: str
    requires_vram_gb: int
    requires_disk_gb: int
    nodes: tuple[NodeSpec, ...]
    models: tuple[ModelSpec, ...]
    workflows: tuple[str, ...]
    generate: GenerateSpec | None = None
    # Node classes boot always checks (the video section's are added only for a boot that includes video).
    provides_node_classes: tuple[str, ...] = ()
    video_enabled: bool = False
    # The video section's model file names (entries of `models` once pinned) and node classes, also while video is
    # off (VIDEO_ENABLED false): a boot leaves those files out unless video is on and the boot includes it.
    video_models: tuple[str, ...] = ()
    video_node_classes: tuple[str, ...] = ()
    # The base section's family id (`video: id:`), and every other family, on or off.
    video_base_id: str = "standard"
    video_families: tuple[VideoFamilySpec, ...] = ()


def _relative(value: str, what: str) -> str:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts:
        raise ProfileError(f"{what} must be a relative path without '..': {value!r}")
    return value


def _required(value: str, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProfileError(f"{what} must be a non-empty string")
    return value


def _mapping(value: object, what: str) -> dict:
    if not isinstance(value, dict):
        raise ProfileError(f"{what} must be a mapping")
    return value


def _positive_int(value: object, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ProfileError(f"{what} must be a positive integer")
    return value


def _parse_generate(raw: object) -> GenerateSpec:
    gen = _mapping(raw, "generate")
    workflow = _required(gen.get("workflow"), "generate workflow")
    if not NAME_RE.fullmatch(workflow):
        raise ProfileError(f"generate workflow is not a valid workflow name: {workflow!r}")
    params_raw = _mapping(gen.get("params"), "generate params")
    keys = GenerateParams.__dataclass_fields__.keys()
    # `negative_prompt` and `cfg` are the web app's optional knobs: checked for shape here, not stored.
    optional = ("negative_prompt", "cfg")
    unknown = sorted(str(k) for k in params_raw if k not in keys and k not in optional)
    if unknown:
        raise ProfileError(f"generate params has unknown keys: {', '.join(unknown)}")
    refs = {}
    for key in keys:
        if key not in params_raw:
            raise ProfileError(f"generate params is missing {key}")
        ref = _mapping(params_raw[key], f"generate param {key}")
        refs[key] = ParamRef(
            _required(ref.get("node"), f"generate param {key} node"),
            _required(ref.get("input"), f"generate param {key} input"),
        )
    for key in optional:
        if key in params_raw:
            ref = _mapping(params_raw[key], f"generate param {key}")
            _required(ref.get("node"), f"generate param {key} node")
            _required(ref.get("input"), f"generate param {key} input")
    presets_raw = _mapping(gen.get("quality_presets"), "generate quality_presets")
    if not presets_raw:
        raise ProfileError("generate quality_presets must not be empty")
    presets = []
    for name, preset in presets_raw.items():
        presets.append(
            QualityPreset(
                _required(name, "preset name"),
                _positive_int(_mapping(preset, f"preset {name}").get("steps"), f"preset {name} steps"),
            )
        )
    sizes_raw = gen.get("sizes")
    if not isinstance(sizes_raw, list) or not sizes_raw:
        raise ProfileError("generate sizes must be a non-empty list")
    sizes = []
    for item in sizes_raw:
        item = _mapping(item, "size")
        name = _required(item.get("name"), "size name")
        width = _positive_int(item.get("width"), f"size {name} width")
        height = _positive_int(item.get("height"), f"size {name} height")
        if width % 32 or height % 32:
            raise ProfileError(f"size {name} must be a multiple of 32: {width}x{height}")
        if any(s.name == name for s in sizes):
            raise ProfileError(f"duplicate size name {name!r}")
        sizes.append(SizeSpec(name, width, height))
    return GenerateSpec(workflow, GenerateParams(**refs), tuple(presets), tuple(sizes))


def _parse_node_classes(raw: object, what: str = "provides_node_classes") -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise ProfileError(f"{what} must be a list")
    names: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not NODE_CLASS_RE.fullmatch(item):
            raise ProfileError(f"{what} has an invalid node class name: {item!r}")
        if item in names:
            raise ProfileError(f"{what} lists {item!r} twice")
        names.append(item)
    return tuple(names)


_VIDEO_MODELS_MAX = 8
_FAMILY_MODELS_MAX = 16
_FAMILIES_MAX = 8
_FAMILY_ID_RE = re.compile(r"[a-z][a-z0-9_]{0,31}")
_SLOT_RE = re.compile(r"[a-z][a-z0-9]{0,15}")
_EXPERTS_MIN, _EXPERTS_MAX = 2, 4
_DEFAULT_BASE_ID = "standard"
_DIFFUSION_FOLDER = "models/diffusion_models"
_MODES = ("text", "image")


def _dest_folder(dest: str) -> str:
    return dest.rstrip("/")


def _parse_files(raw: object, what: str, max_items: int) -> list[tuple[str, str]]:
    if not isinstance(raw, list) or not raw or len(raw) > max_items:
        raise ProfileError(f"{what} models must be a non-empty list of at most {max_items} entries")
    wanted: list[tuple[str, str]] = []
    for item in raw:
        item = _mapping(item, f"{what} model")
        name = _relative(_required(item.get("file"), f"{what} model file"), f"{what} model file")
        if "/" in name:
            raise ProfileError(f"{what} model file must be a plain file name: {name!r}")
        dest = _relative(_required(item.get("dest"), f"{what} model dest"), f"{what} model dest")
        wanted.append((name, dest))
    return wanted


def _check_pinned(wanted: list[tuple[str, str]], models: list[ModelSpec], what: str) -> None:
    for name, dest in wanted:
        entry = next((m for m in models if PurePosixPath(m.file).name == name), None)
        if entry is None:
            raise ProfileError(f"{what} model {name} is not listed in models (pin it with scripts/pin_model.py)")
        if _dest_folder(entry.dest) != _dest_folder(dest):
            raise ProfileError(f"{what} model {name} must have dest {_dest_folder(dest)}/")


def _family_id(value: object, what: str) -> str:
    if not isinstance(value, str) or not _FAMILY_ID_RE.fullmatch(value):
        raise ProfileError(f"{what} id must be lower case letters, digits and _ (at most 32): {value!r}")
    return value


def _base_id(raw: object) -> str:
    if raw is None:
        return _DEFAULT_BASE_ID
    video = _mapping(raw, "video")
    return _DEFAULT_BASE_ID if video.get("id") is None else _family_id(video.get("id"), "video")


def _parse_families(
    raw: object, models: list[ModelSpec], workflows: tuple[str, ...], video_enabled: bool, wanted_ids: tuple[str, ...],
    base_id: str,
) -> tuple[VideoFamilySpec, ...]:
    """Every family of `video_families:`, validated also while off; on when VIDEO_ENABLED and VIDEO_FAMILIES lists it
    (then every file must be pinned). An id in VIDEO_FAMILIES that names no family is refused (the base id is fine)."""
    items = [] if raw is None else raw
    if not isinstance(items, list) or len(items) > _FAMILIES_MAX:
        raise ProfileError(f"video_families must be a list of at most {_FAMILIES_MAX} families")
    families: list[VideoFamilySpec] = []
    for item in items:
        fam = _mapping(item, "video family")
        fid = _family_id(fam.get("id"), "video family")
        what = f"video family {fid}"
        if "enabled" in fam:
            raise ProfileError(f"{what}: `enabled:` is not read from the profile: list the id in VIDEO_FAMILIES in .env")
        if fid == base_id or any(f.id == fid for f in families):
            raise ProfileError(f"video family ids must be unique (also against the video section's id): {fid}")
        title = fam.get("title")
        if not isinstance(title, str) or not title.strip() or len(title) > 40:
            raise ProfileError(f"{what} title must be a short non-empty name")
        files = _parse_files(fam.get("models"), what, _FAMILY_MODELS_MAX)
        classes = _parse_node_classes(fam.get("node_classes"), f"{what} node_classes")
        experts: list[tuple[str, str, str]] = []
        for mode in _MODES:
            spec = _mapping(fam.get(mode), f"{what} {mode}")
            workflow = spec.get("workflow")
            if not isinstance(workflow, str) or not NAME_RE.fullmatch(workflow):
                raise ProfileError(f"{what} {mode} workflow is not a valid workflow name: {workflow!r}")
            if workflow not in workflows:
                raise ProfileError(f"{what} {mode} workflow {workflow} is not listed in workflows")
            raw_experts = spec.get("experts")
            if not isinstance(raw_experts, list) or not _EXPERTS_MIN <= len(raw_experts) <= _EXPERTS_MAX:
                raise ProfileError(f"{what} {mode} experts must list {_EXPERTS_MIN} to {_EXPERTS_MAX} diffusion models")
            slots: list[str] = []
            for e in raw_experts:
                e = _mapping(e, f"{what} {mode} expert")
                slot, file = e.get("slot"), e.get("file")
                if not isinstance(slot, str) or not _SLOT_RE.fullmatch(slot):
                    raise ProfileError(f"{what} {mode} expert slot must be a short lower case name")
                if slot in slots:
                    raise ProfileError(f"{what} {mode} expert slots must be unique")
                slots.append(slot)
                dest = next((d for n, d in files if n == file), None)
                if dest is None:
                    raise ProfileError(f"{what} {mode} expert {slot} must name one of the family's models")
                if _dest_folder(dest) != _DIFFUSION_FOLDER:
                    raise ProfileError(f"{what} {mode} expert {slot} must be a diffusion model ({_DIFFUSION_FOLDER}/)")
                experts.append((mode, slot, file))
        enabled = video_enabled and fid in wanted_ids
        if enabled:
            _check_pinned(files, models, what)
        families.append(VideoFamilySpec(id=fid, title=title, enabled=enabled, models=tuple(n for n, _ in files),
                                        node_classes=classes, experts=tuple(experts)))
    unknown = [i for i in wanted_ids if i != base_id and not any(f.id == i for f in families)]
    if unknown:
        raise ProfileError(f"VIDEO_FAMILIES names an unknown video family: {', '.join(unknown)}")
    return tuple(families)


def _parse_video(
    raw: object, models: list[ModelSpec], workflows: tuple[str, ...], enabled: bool,
) -> tuple[bool, tuple[str, ...], tuple[str, ...]]:
    """(enabled, its model file names, its node classes). Video is switched by VIDEO_ENABLED (`enabled`), never by the
    profile. The web app owns the rest of `video:` (apps/core/src/video.ts); this checks what decides downloads and
    the boot check, also while video is off, so a broken section fails at boot and never mid-job. Enabled video
    needs each of its model files pinned in `models:` with its dest."""
    if raw is None:
        return False, (), ()
    video = _mapping(raw, "video")
    if "enabled" in video:
        # Refused rather than ignored: a profile line that looks like a switch but does nothing misleads.
        raise ProfileError("video `enabled:` is not read from the profile any more: remove it and set VIDEO_ENABLED=true in .env")
    workflow = video.get("workflow")
    if not isinstance(workflow, str) or not NAME_RE.fullmatch(workflow):
        raise ProfileError(f"video workflow is not a valid workflow name: {workflow!r}")
    if workflow not in workflows:
        raise ProfileError(f"video workflow {workflow} is not listed in workflows")
    _base_id(video)
    wanted = _parse_files(video.get("models"), "video", _VIDEO_MODELS_MAX)
    classes = _parse_node_classes(video.get("node_classes"), "video node_classes")
    names = tuple(name for name, _ in wanted)
    if not enabled:
        # Still named: a boot never downloads the video files while video is off, even once they are pinned.
        return False, names, classes
    _check_pinned(wanted, models, "video")
    return True, names, classes


_STYLE_KINDS = ("lora", "preset")
_STYLE_REFERENCES_MAX = 16


def _check_styles(raw) -> None:
    """The web app owns `styles:` (apps/core/src/styles.ts validates it fully); the agent only downloads what
    `models:` lists. This checks the part that decides downloads: a `preset` style uses no LoRA (so nothing is
    downloaded for it) and its reference rule is well formed, so a broken profile fails at boot, not mid-job."""
    if raw is None:
        return
    if not isinstance(raw, list):
        raise ProfileError("styles must be a list")
    for item in raw:
        if not isinstance(item, dict):
            raise ProfileError("a style must be a mapping")
        name = item.get("id", "?")
        kind = item.get("kind", "lora")
        if kind not in _STYLE_KINDS:
            raise ProfileError(f"style {name}: kind must be one of {', '.join(_STYLE_KINDS)}")
        if kind == "preset" and "lora" in item:
            raise ProfileError(f"style {name}: a preset has no lora")
        if kind == "lora" and not isinstance(item.get("lora"), dict):
            raise ProfileError(f"style {name}: a lora style needs a lora section")
        refs = item.get("references")
        if refs is not None:
            if not isinstance(refs, dict):
                raise ProfileError(f"style {name}: references must be a mapping")
            low, high = refs.get("min"), refs.get("max")
            if not all(isinstance(v, int) and not isinstance(v, bool) for v in (low, high)) or not (
                    1 <= low <= high <= _STYLE_REFERENCES_MAX):
                raise ProfileError(f"style {name}: references need whole min and max with 1 <= min <= max <= "
                                   f"{_STYLE_REFERENCES_MAX}")
            labels = refs.get("labels", [])
            if not isinstance(labels, list) or len(labels) > high or not all(isinstance(x, str) and x for x in labels):
                raise ProfileError(f"style {name}: references labels must be at most max non-empty strings")


def load_profile(path: Path, video_enabled: bool = False, video_families: tuple[str, ...] | list[str] = ()) -> Profile:
    """The profile; `video_enabled` is VIDEO_ENABLED and `video_families` VIDEO_FAMILIES (every video section is
    validated either way)."""
    try:
        raw = yaml.safe_load(Path(path).read_text())
        models = []
        for item in raw["models"]:
            size = int(item["size_bytes"])
            if size <= 0:
                raise ProfileError("size_bytes must be positive")
            models.append(
                ModelSpec(
                    file=_relative(item["file"], "model file"),
                    repo=_required(item["repo"], "model repo"),
                    revision=_required(item["revision"], "model revision"),
                    dest=_relative(item["dest"], "model dest"),
                    size_bytes=size,
                )
            )
        nodes = tuple(
            NodeSpec(_required(n["repo"], "node repo"), _required(n["commit"], "node commit")) for n in raw["nodes"]
        )
        _check_styles(raw.get("styles"))
        workflows = tuple(_relative(w, "workflow") for w in raw.get("workflows", []))
        declared = _parse_node_classes(raw.get("provides_node_classes"))
        wanted_families = tuple(video_families)
        video_enabled, video_files, video_classes = _parse_video(raw.get("video"), models, workflows, video_enabled)
        base_id = _base_id(raw.get("video"))
        families = _parse_families(raw.get("video_families"), models, workflows, video_enabled, wanted_families, base_id)
        return Profile(
            name=_required(raw["name"], "name"),
            requires_vram_gb=int(raw["requires"]["vram_gb"]),
            requires_disk_gb=int(raw["requires"]["disk_gb"]),
            nodes=nodes,
            models=tuple(models),
            workflows=workflows,
            generate=_parse_generate(raw["generate"]) if raw.get("generate") is not None else None,
            provides_node_classes=declared,
            video_enabled=video_enabled,
            video_models=video_files,
            video_node_classes=video_classes,
            video_base_id=base_id,
            video_families=families,
        )
    except ProfileError as exc:
        raise ProfileError(f"{path}: {exc}") from None
    except (KeyError, TypeError, ValueError, yaml.YAMLError) as exc:
        raise ProfileError(f"{path}: invalid profile ({exc!r})") from None


def target_path(model: ModelSpec, comfy_dir: Path) -> Path:
    return Path(comfy_dir) / model.dest / PurePosixPath(model.file).name


def video_model_specs(profile: Profile) -> tuple[ModelSpec, ...]:
    """The `models` entries of the video section (empty when video is not enabled)."""
    return tuple(m for m in profile.models if PurePosixPath(m.file).name in profile.video_models)


def video_family_ids(profile: Profile) -> tuple[str, ...]:
    """The video families that are on: the base section first (VIDEO_ENABLED), then those VIDEO_FAMILIES lists."""
    if not profile.video_enabled:
        return ()
    return (profile.video_base_id,) + tuple(f.id for f in profile.video_families if f.enabled)


def _family_files(profile: Profile, family_id: str) -> tuple[str, ...]:
    if family_id == profile.video_base_id:
        return profile.video_models
    fam = next((f for f in profile.video_families if f.id == family_id), None)
    if fam is None:
        raise ProfileError(f"no video family {family_id}")
    return fam.models


def family_model_specs(profile: Profile, family_id: str) -> tuple[ModelSpec, ...]:
    """The `models` entries of one video family (pinned files only), in profile order."""
    names = _family_files(profile, family_id)
    return tuple(m for m in profile.models if PurePosixPath(m.file).name in names)


def _boot_families(profile: Profile, include_video: bool, families: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    """The families a boot includes: none without INCLUDE_VIDEO_MODELS or video; VIDEO_BOOT_FAMILIES, else the base."""
    on = video_family_ids(profile)
    wanted = tuple(families)
    bad = [f for f in wanted if f not in on]
    if include_video and bad:
        raise ProfileError(f"VIDEO_BOOT_FAMILIES names a video family that is not on: {', '.join(bad)}")
    if not include_video or not on:
        return ()
    return wanted or (profile.video_base_id,)


def boot_models(profile: Profile, include_video: bool, families: tuple[str, ...] | list[str] = ()) -> tuple[ModelSpec, ...]:
    """What a boot downloads: every model, minus the video files unless video is on (VIDEO_ENABLED) and the boot
    includes it (INCLUDE_VIDEO_MODELS); then only the files of the chosen families (VIDEO_BOOT_FAMILIES, default the
    base section). A file two families share is kept when one of them is chosen. Profile order is kept."""
    chosen = _boot_families(profile, include_video, families)
    every = set(profile.video_models).union(*(f.models for f in profile.video_families))
    keep = set().union(*(_family_files(profile, f) for f in chosen)) if chosen else set()
    return tuple(m for m in profile.models if PurePosixPath(m.file).name not in every - keep)


def boot_node_classes(profile: Profile, include_video: bool, families: tuple[str, ...] | list[str] = ()) -> tuple[str, ...]:
    """What a boot requires from ComfyUI: the declared classes, plus those of the video families it includes."""
    extra: list[str] = []
    for fid in _boot_families(profile, include_video, families):
        classes = profile.video_node_classes if fid == profile.video_base_id else next(
            f.node_classes for f in profile.video_families if f.id == fid)
        extra += [c for c in classes if c not in extra]
    return profile.provides_node_classes + tuple(c for c in extra if c not in profile.provides_node_classes)


def missing_models(profile: Profile, comfy_dir: Path, models: tuple[ModelSpec, ...] | None = None) -> list[ModelSpec]:
    """The given models (default: all of the profile) that are not on disk with their pinned size."""
    missing = []
    for model in profile.models if models is None else models:
        target = target_path(model, comfy_dir)
        if not target.is_file() or target.stat().st_size != model.size_bytes:
            missing.append(model)
    return missing


def check_disk(
    profile: Profile, comfy_dir: Path, free_bytes: int, margin_mb: int, models: tuple[ModelSpec, ...] | None = None,
) -> None:
    needed = sum(m.size_bytes for m in missing_models(profile, comfy_dir, models)) + margin_mb * 1024 * 1024
    if free_bytes < needed:
        raise DiskInsufficient(f"need {needed} bytes, only {free_bytes} free")


def free_bytes_of(path: Path) -> int:
    probe = Path(path)
    while not probe.exists():
        probe = probe.parent
    return shutil.disk_usage(probe).free


class ProgressWriter:
    def __init__(self, state_dir: Path, phase: str):
        self._path = StatePaths(state_dir).progress_json
        self._phase = phase

    def __call__(self, file: str, done: int, total: int) -> None:
        write_json(self._path, {"phase": self._phase, "file": file, "bytes_done": done, "bytes_total": total})


# Smallest segment of a parallel download: smaller files use fewer connections (one below twice this).
MIN_SEGMENT_BYTES = 8 * 1024 * 1024


class Downloader:
    """Downloads pinned model files. With connections > 1 a file whose server answers HEAD with
    `Accept-Ranges: bytes` and the pinned Content-Length is fetched in parallel byte ranges (ranged.py);
    otherwise, or when a ranged request is answered with a plain 200, in one stream as before."""

    def __init__(
        self,
        *,
        hf_base: str,
        token: str,
        client: httpx.Client,
        retries: int,
        backoff_s: int,
        chunk_bytes: int,
        sleep: Callable[[float], None] = time.sleep,
        on_progress: Callable[[str, int, int], None] = lambda *a: None,
        connections: int = 1,
        min_segment_bytes: int = MIN_SEGMENT_BYTES,
    ):
        self._base = hf_base.rstrip("/")
        self._token = token
        self._client = client
        self._retries = retries
        self._backoff = backoff_s
        self._chunk = chunk_bytes
        self._sleep = sleep
        self._on_progress = on_progress
        self._connections = max(1, connections)
        self._min_segment = max(1, min_segment_bytes)

    def fetch(self, model: ModelSpec, comfy_dir: Path) -> Path:
        target = target_path(model, comfy_dir)
        if target.is_file() and target.stat().st_size == model.size_bytes:
            return target
        url = f"{self._base}/{model.repo}/resolve/{model.revision}/{model.file}"
        last: Exception | None = None
        for attempt in range(1, self._retries + 1):
            try:
                self._download(url, target, model)
                return target
            except (httpx.HTTPError, DownloadError, OSError) as exc:
                last = exc
                if attempt < self._retries:
                    self._sleep(self._backoff)
        raise DownloadError(f"{target.name}: {last}")

    def _download(self, url: str, target: Path, model: ModelSpec) -> None:
        part = target.with_name(target.name + ".part")
        target.parent.mkdir(parents=True, exist_ok=True)
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            if self._connections > 1 and model.size_bytes >= 2 * self._min_segment:
                try:
                    if ranges_supported(self._client, url, headers, model.size_bytes):
                        self._download_ranged(url, headers, part, target, model)
                        return
                except RangeUnsupported:
                    pass  # this server ignores Range: one plain stream below, in the same attempt
            with self._client.stream("GET", url, headers=headers, follow_redirects=True) as response:
                response.raise_for_status()
                done = 0
                with part.open("wb") as handle:
                    for chunk in response.iter_bytes(self._chunk):
                        handle.write(chunk)
                        done += len(chunk)
                        self._on_progress(target.name, done, model.size_bytes)
            if part.stat().st_size != model.size_bytes:
                raise DownloadError(f"size mismatch: got {part.stat().st_size}, expected {model.size_bytes}")
            os.replace(part, target)
        finally:
            if part.exists():
                part.unlink()

    def _download_ranged(self, url: str, headers: dict, part: Path, target: Path, model: ModelSpec) -> None:
        done = 0

        def on_bytes(n: int) -> None:  # called under the download's lock
            nonlocal done
            done += n
            self._on_progress(target.name, done, model.size_bytes)

        job = RangedDownload(
            client=self._client, url=url, headers=headers, size=model.size_bytes, connections=self._connections,
            min_segment=self._min_segment, retries=self._retries, backoff_s=self._backoff, chunk_bytes=self._chunk,
            sleep=self._sleep, on_bytes=on_bytes,
        )
        try:
            job.run(part)
        except SegmentError as exc:
            raise DownloadError(str(exc)) from exc
        if done != model.size_bytes or part.stat().st_size != model.size_bytes:
            raise DownloadError(f"size mismatch: got {done} bytes, expected {model.size_bytes}")
        os.replace(part, target)


def _run_checked(run: Callable, cmd: list[str], what: str) -> subprocess.CompletedProcess:
    proc = run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise NodeInstallError(f"{what} failed: {(proc.stderr or proc.stdout or '').strip()[:300]}")
    return proc


def _clone(run: Callable, git_bin: str, git_host: str, node: NodeSpec, name: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    _run_checked(run, [git_bin, "clone", f"{git_host.rstrip('/')}/{node.repo}", str(dest)], f"clone {name}")


def _install_requirements(run: Callable, comfy_python: str, dest: Path, name: str) -> None:
    # Always `<ComfyUI venv python> -m pip`: a bare `pip` resolves to another environment, and ComfyUI then
    # fails to import the node (seen on the first real boot: ModuleNotFoundError for gguf).
    requirements = dest / "requirements.txt"
    if requirements.exists():
        _run_checked(run, [comfy_python, "-m", "pip", "install", "-r", str(requirements)], f"pip install {name}")


def install_nodes(
    profile: Profile, comfy_dir: Path, *, git_host: str, git_bin: str, comfy_python: str,
    run: Callable = subprocess.run,
) -> None:
    for node in profile.nodes:
        name = node.repo.rsplit("/", 1)[-1]
        dest = Path(comfy_dir) / "custom_nodes" / name
        if dest.exists():
            head = run([git_bin, "-C", str(dest), "rev-parse", "HEAD"], capture_output=True, text=True)
            if head.returncode != 0:
                # Broken checkout (e.g. a partial clone from a killed process): wipe it and clone afresh.
                shutil.rmtree(dest)
                _clone(run, git_bin, git_host, node, name, dest)
            elif head.stdout.strip() == node.commit:
                _install_requirements(run, comfy_python, dest, name)
                continue
            else:
                _run_checked(run, [git_bin, "-C", str(dest), "fetch", "--all", "--tags"], f"fetch {name}")
        else:
            _clone(run, git_bin, git_host, node, name, dest)
        _run_checked(run, [git_bin, "-C", str(dest), "checkout", "--detach", node.commit], f"checkout {name}")
        _install_requirements(run, comfy_python, dest, name)
