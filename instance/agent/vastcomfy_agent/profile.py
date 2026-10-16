from __future__ import annotations

import os
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


class ProfileError(Exception):
    pass


class DiskInsufficient(Exception):
    pass


class DownloadError(Exception):
    pass


class NodeInstallError(Exception):
    pass


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
class Profile:
    name: str
    requires_vram_gb: int
    requires_disk_gb: int
    nodes: tuple[NodeSpec, ...]
    models: tuple[ModelSpec, ...]
    workflows: tuple[str, ...]


def _relative(value: str, what: str) -> str:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts:
        raise ProfileError(f"{what} must be a relative path without '..': {value!r}")
    return value


def _required(value: str, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProfileError(f"{what} must be a non-empty string")
    return value


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
        return Profile(
            name=_required(raw["name"], "name"),
            requires_vram_gb=int(raw["requires"]["vram_gb"]),
            requires_disk_gb=int(raw["requires"]["disk_gb"]),
            nodes=nodes,
            models=tuple(models),
            workflows=tuple(_relative(w, "workflow") for w in raw.get("workflows", [])),
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


def install_nodes(
    profile: Profile, comfy_dir: Path, *, git_host: str, git_bin: str, pip_bin: str, run: Callable = subprocess.run
) -> None:
    for node in profile.nodes:
        name = node.repo.rsplit("/", 1)[-1]
        dest = Path(comfy_dir) / "custom_nodes" / name
        if dest.exists():
            head = _run_checked(run, [git_bin, "-C", str(dest), "rev-parse", "HEAD"], f"rev-parse {name}")
            if head.stdout.strip() == node.commit:
                continue
            _run_checked(run, [git_bin, "-C", str(dest), "fetch", "--all", "--tags"], f"fetch {name}")
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            _run_checked(run, [git_bin, "clone", f"{git_host.rstrip('/')}/{node.repo}", str(dest)], f"clone {name}")
        _run_checked(run, [git_bin, "-C", str(dest), "checkout", "--detach", node.commit], f"checkout {name}")
        requirements = dest / "requirements.txt"
        if requirements.exists():
            _run_checked(run, [pip_bin, "install", "-r", str(requirements)], f"pip install {name}")
