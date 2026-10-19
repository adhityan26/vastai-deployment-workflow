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
class Profile:
    name: str
    requires_vram_gb: int
    requires_disk_gb: int
    nodes: tuple[NodeSpec, ...]
    models: tuple[ModelSpec, ...]
    workflows: tuple[str, ...]
    generate: GenerateSpec | None = None
    provides_node_classes: tuple[str, ...] = ()


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


def _parse_node_classes(raw: object) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise ProfileError("provides_node_classes must be a list")
    names: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not NODE_CLASS_RE.fullmatch(item):
            raise ProfileError(f"provides_node_classes has an invalid node class name: {item!r}")
        if item in names:
            raise ProfileError(f"provides_node_classes lists {item!r} twice")
        names.append(item)
    return tuple(names)


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


def load_profile(path: Path) -> Profile:
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
        return Profile(
            name=_required(raw["name"], "name"),
            requires_vram_gb=int(raw["requires"]["vram_gb"]),
            requires_disk_gb=int(raw["requires"]["disk_gb"]),
            nodes=nodes,
            models=tuple(models),
            workflows=tuple(_relative(w, "workflow") for w in raw.get("workflows", [])),
            generate=_parse_generate(raw["generate"]) if raw.get("generate") is not None else None,
            provides_node_classes=_parse_node_classes(raw.get("provides_node_classes")),
        )
    except ProfileError as exc:
        raise ProfileError(f"{path}: {exc}") from None
    except (KeyError, TypeError, ValueError, yaml.YAMLError) as exc:
        raise ProfileError(f"{path}: invalid profile ({exc!r})") from None


def target_path(model: ModelSpec, comfy_dir: Path) -> Path:
    return Path(comfy_dir) / model.dest / PurePosixPath(model.file).name


def missing_models(profile: Profile, comfy_dir: Path) -> list[ModelSpec]:
    missing = []
    for model in profile.models:
        target = target_path(model, comfy_dir)
        if not target.is_file() or target.stat().st_size != model.size_bytes:
            missing.append(model)
    return missing


def check_disk(profile: Profile, comfy_dir: Path, free_bytes: int, margin_mb: int) -> None:
    needed = sum(m.size_bytes for m in missing_models(profile, comfy_dir)) + margin_mb * 1024 * 1024
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


class Downloader:
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
    ):
        self._base = hf_base.rstrip("/")
        self._token = token
        self._client = client
        self._retries = retries
        self._backoff = backoff_s
        self._chunk = chunk_bytes
        self._sleep = sleep
        self._on_progress = on_progress

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
