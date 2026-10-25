"""Extra LoRAs an admin added by link in the web app (its LORA store). The web app sends the whole wanted set
(POST /loras: server-chosen file names and their Hugging Face links); this downloads the missing files in the
background through the same single download slot as the video models (one download at a time), and deletes the ones
no longer wanted while ComfyUI is idle. The files are NOT part of the pinned boot set: an instance gets them after it
is ready, from the web app's sync. Every link is checked again here exactly like a video model link (host allow-list,
https, every redirect hop, size cap from a HEAD), .safetensors only; the file is fetched into a staging folder ComfyUI
does not read, its header is checked, it is hashed (NOT integrity-pinned: the sha256 of what arrived is reported) and
then moved to models/loras/ under its server-chosen name."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
from pathlib import Path, PurePosixPath
from typing import Callable

import httpx

from .comfy import ComfyUnavailable
from .files import atomic_write
from .model_link import LinkError, ModelLink, check_model_file, parse_link, probe_size, sha256_of
from .models import LorasStatus, LoraStatus
from .profile import DownloadError, Downloader, ModelSpec, Profile, ProfileError, target_path
from .state import State, StateStore

log = logging.getLogger(__name__)
NAME_RE = re.compile(r"xl_[a-z0-9_]{3,32}_(high|low)\.safetensors")
LORA_DIR = "models/loras"
STAGING_DEST = "models/xl_staging/"
LORA_LOADER = "LoraLoaderModelOnly"
STATE_FILE = "extra_loras.json"
OWNER = "extra_loras"
MESSAGE_MAX = 240
SERVING = frozenset({State.READY, State.IDLE_WARNING})
LINK_BAD_REQUEST = frozenset({"invalid_model_link", "model_link_host_not_allowed", "model_link_unsupported_type"})


class LorasRefused(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def loras_digest(items: list[tuple[str, str]]) -> str:
    """sha256 of the sorted "<name> <url>" lines: the web app computes the same to know whether to sync again."""
    return hashlib.sha256("\n".join(sorted(f"{n} {u}" for n, u in items)).encode()).hexdigest()


def _clip(text: str) -> str:
    return text if len(text) <= MESSAGE_MAX else text[:MESSAGE_MAX] + "..."


def _thread(target: Callable[[], None]) -> None:
    threading.Thread(target=target, name="extra-loras", daemon=True).start()


class ExtraLoras:
    def __init__(
        self,
        *,
        slot,
        load_profile: Callable[[], Profile],
        comfy,
        comfy_dir: Path,
        free_bytes_fn: Callable[[Path], int],
        disk_margin_mb: int,
        states: StateStore,
        state_dir: Path,
        link_hosts: list[str] | tuple[str, ...],
        link_max_bytes: int,
        total_max_bytes: int,
        make_link_client: Callable[[], httpx.Client],
        make_link_downloader: Callable[[httpx.Client, ModelLink, Callable[[str, int, int], None]], Downloader],
        spawn: Callable[[Callable[[], None]], None] = _thread,
    ):
        self._slot = slot
        self._load_profile = load_profile
        self._comfy = comfy
        self._comfy_dir = Path(comfy_dir)
        self._free = free_bytes_fn
        self._margin_mb = disk_margin_mb
        self._states = states
        self._path = Path(state_dir) / STATE_FILE
        self._hosts = list(link_hosts)
        self._link_max = link_max_bytes
        self._total_max = total_max_bytes
        self._make_link_client = make_link_client
        self._make_link_downloader = make_link_downloader
        self._spawn = spawn
        self._lock = threading.Lock()
        self._desired: list[tuple[str, str]] | None = None
        self._files: dict[str, dict] = {}
        self._failures: dict[str, str] = {}
        self._current: str | None = None
        self._done = 0
        self._total = 0
        self._load()
        slot.add_idle_hook(self._kick)

    # ---- persisted state: the wanted set and what arrived (survives an agent restart) ----

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text())
            items = [(str(i["name"]), str(i["url"])) for i in raw["items"]]
            files = {str(k): {"size_bytes": int(v["size_bytes"]), "sha256": str(v["sha256"])} for k, v in raw["files"].items()}
        except (OSError, ValueError, KeyError, TypeError):
            return
        if all(NAME_RE.fullmatch(n) for n, _u in items) and all(NAME_RE.fullmatch(n) for n in files):
            self._desired, self._files = items, files

    def _save(self) -> None:
        atomic_write(self._path, json.dumps({"items": [{"name": n, "url": u} for n, u in self._desired or []],
                                             "files": self._files}))

    def _pinned_names(self) -> set[str]:
        try:
            return {PurePosixPath(m.file).name for m in self._load_profile().models}
        except ProfileError:
            return set()

    def _target(self, name: str) -> Path:
        return self._comfy_dir / LORA_DIR / name

    def _present(self, name: str) -> bool:
        record = self._files.get(name)
        target = self._target(name)
        return record is not None and target.is_file() and target.stat().st_size == record["size_bytes"]

    # ---- the API ----

    def sync(self, items: list[tuple[str, str]]) -> LorasStatus:
        """Replace the wanted set (validated completely first: a refused set changes nothing), retry failed files,
        delete files no longer wanted while ComfyUI is idle, and start downloading the missing ones."""
        pinned = self._pinned_names()
        names = [n for n, _u in items]
        if len(set(names)) != len(names) or any(not NAME_RE.fullmatch(n) or n in pinned for n in names):
            raise LorasRefused(400, "invalid_lora_name", "a LoRA file name is not one the web app chooses")
        for _name, url in items:
            try:
                link = parse_link(url, self._hosts)
            except LinkError as err:
                raise LorasRefused(400, err.code, _clip(err.message)) from None
            if not link.name.endswith(".safetensors"):
                raise LorasRefused(400, "model_link_unsupported_type", "only .safetensors LoRA files can be linked")
        with self._lock:
            self._desired = list(items)
            self._failures = {}
            self._remove_unwanted()
            self._save()
        self._kick()
        return self.view()

    def view(self) -> LorasStatus:
        with self._lock:
            if self._desired is None:
                return LorasStatus(digest=None, items=[])
            out = []
            for name, _url in self._desired:
                record = self._files.get(name)
                size = None if record is None else record["size_bytes"]
                if name == self._current:
                    out.append(LoraStatus(name=name, state="downloading", bytes_done=self._done, bytes_total=self._total,
                                          size_bytes=self._total or None))
                elif name in self._failures:
                    out.append(LoraStatus(name=name, state="failed", bytes_done=0, bytes_total=0, reason=self._failures[name]))
                elif self._present(name):
                    out.append(LoraStatus(name=name, state="ready", bytes_done=size, bytes_total=size, size_bytes=size,
                                          sha256=record["sha256"]))
                else:
                    out.append(LoraStatus(name=name, state="not_installed", bytes_done=0, bytes_total=0))
            return LorasStatus(digest=loras_digest(self._desired), items=out)

    # ---- downloads ----

    def _remove_unwanted(self) -> None:
        """Delete our files (by name shape only) that are no longer wanted, but never while ComfyUI runs a job (it
        may be using one); they are tried again at the next sync or download pass. Call with the lock held."""
        wanted = {n for n, _u in self._desired or []}
        folder = self._comfy_dir / LORA_DIR
        stale = [p for p in folder.glob("xl_*.safetensors") if NAME_RE.fullmatch(p.name) and p.name not in wanted] \
            if folder.is_dir() else []
        for name in [n for n in self._files if n not in wanted]:
            if not self._target(name).exists():
                self._files.pop(name, None)
        if not stale:
            return
        try:
            idle = self._comfy.queue_counts() == (0, 0)
        except Exception:
            idle = False
        if not idle:
            return
        for path in stale:
            path.unlink(missing_ok=True)
            self._files.pop(path.name, None)

    def _missing(self) -> list[tuple[str, str]]:
        return [(n, u) for n, u in self._desired or [] if not self._present(n) and n not in self._failures]

    def _kick(self) -> None:
        """Start a download pass when something is missing, the instance serves and the download slot is free."""
        with self._lock:
            if not self._missing() or self._states.get().state not in SERVING:
                return
        if not self._slot.try_claim(OWNER):
            return  # the slot's idle hook calls this again when the running download ends
        with self._lock:
            missing = self._missing()
            self._current, self._done, self._total = (missing[0][0], 0, 0) if missing else (None, 0, 0)
        if not missing:
            self._slot.release(OWNER)
            return
        self._spawn(lambda: self._pass(missing))

    def _pass(self, missing: list[tuple[str, str]]) -> None:
        placed: list[str] = []
        try:
            client = self._make_link_client()
            for name, url in missing:
                failure = self._fetch(client, name, url)
                with self._lock:
                    self._current = None
                    if failure is None:
                        placed.append(name)
                    else:
                        self._failures[name] = _clip(failure)
                        log.warning("extra LoRA %s failed: %s", name, failure)
            if placed:
                try:
                    unlisted = self._comfy.unlisted_files((LORA_LOADER,), tuple(placed))
                except ComfyUnavailable:
                    unlisted = []
                with self._lock:
                    for name in unlisted:
                        self._failures[name] = f"ComfyUI does not list {name} yet; it needs a restart"
            with self._lock:
                self._remove_unwanted()
                self._save()
        except Exception as exc:  # never leave a LoRA "downloading"
            with self._lock:
                for name, _url in missing:
                    if name not in placed:
                        self._failures.setdefault(name, f"unexpected error ({type(exc).__name__})")
        finally:
            with self._lock:
                self._current = None
            self._slot.release(OWNER)

    def _fetch(self, client: httpx.Client, name: str, url: str) -> str | None:
        """Download one file; the reason it failed, or None."""
        try:
            link = parse_link(url, self._hosts)
            size = probe_size(client, link, self._link_max)
            with self._lock:
                wanted = {n for n, _u in self._desired or []}
                have = sum(r["size_bytes"] for n, r in self._files.items() if n in wanted and self._present(n))
            if have + size > self._total_max:
                return (f"lora_total_too_large: {have + size} bytes of extra LoRAs on this instance would pass "
                        f"LORA_TOTAL_MAX_BYTES ({self._total_max})")
            free = self._free(self._comfy_dir)
            need = size + self._margin_mb * 1024 * 1024
            if free < need:
                return f"disk_insufficient: {need} bytes needed, {free} free"
            spec = ModelSpec(file=link.file, repo=link.repo, revision=link.revision, dest=STAGING_DEST, size_bytes=size)
            staged = target_path(spec, self._comfy_dir)
            with self._lock:
                self._current, self._done, self._total = name, 0, size

            def on_progress(_file: str, done: int, _total: int) -> None:
                with self._lock:
                    self._done = done

            try:
                self._make_link_downloader(client, link, on_progress).fetch(spec, self._comfy_dir)
                check_model_file(staged)  # a sane safetensors header
                sha = sha256_of(staged)
                target = self._target(name)
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged, target)
            finally:
                staged.unlink(missing_ok=True)
            with self._lock:
                self._files[name] = {"size_bytes": size, "sha256": sha}
                self._done = size
            log.info("extra LoRA %s from %s@%s: sha256 %s (not pinned)", name, link.repo, link.revision, sha)
            return None
        except LinkError as exc:
            return f"{exc.code}: {exc.message}"
        except DownloadError as exc:
            return f"download failed: {exc}"
