"""A video diffusion model given as a link by an admin (Start dialog or the Video tool's download).

The link is untrusted input that makes the instance download from the network, so it is held to a narrow shape:
an https Hugging Face file URL (`https://<host>/<owner>/<repo>/resolve|blob/<revision>/<path>.safetensors`, an
optional `?download=true`), ASCII only, no user info, no port, no percent-encoding, a host from
VIDEO_MODEL_LINK_HOSTS. It is parsed into repo / revision / file, so the boot's own downloader fetches it from the
same `resolve` URL as a pinned model. Every request of that download, redirects included, goes through
`redirect_guard`: https, port 443, no user info, no IP literal, and a host that is a link host or inside one of
VIDEO_MODEL_LINK_REDIRECT_DOMAINS (Hugging Face's own CDN). The size comes from a HEAD on the instance and is capped
by VIDEO_MODEL_LINK_MAX_BYTES; the disk check runs before the download. A link is NOT integrity-pinned: the sha256 of
what arrived is computed afterwards and reported, never checked against anything.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

import httpx

from .files import atomic_write
from .profile import ModelSpec, Profile, video_model_specs

URL_MAX = 2048
# Protocol rules, not configuration: the shapes of a Hugging Face file URL.
_URL = re.compile(r"https://([a-z0-9.-]{1,253})(/[A-Za-z0-9._/-]{1,1500})(\?download=true)?")  # config-lint: ok (URL shape check, no URL)
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
_REVISION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}")
_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_IPV4 = re.compile(r"[0-9.]+")
_DEST = re.compile(r"models/[a-z0-9_]+/?")
DIFFUSION_FOLDER = "models/diffusion_models"
_PATH_SEGMENTS_MAX = 4
# The linkable model formats; neither is pickle. The extension also picks the loader node (see LOADER_CLASSES).
SUFFIXES = (".safetensors", ".gguf")
GGUF_MAGIC = b"GGUF"
# The loader a .gguf diffusion model needs (the ComfyUI-GGUF node pack the profile already installs).
GGUF_LOADER = "UnetLoaderGGUF"
SAFETENSORS_HEADER_MAX = 100 * 1024 * 1024
CHUNK = 8 * 1024 * 1024


class LinkError(Exception):
    """A refused link or a refused download step: a fixed code and a short message."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ModelLink:
    host: str
    repo: str
    revision: str
    # The file's path inside the repo (as the resolve URL names it) and the plain name it is stored under.
    file: str
    name: str

    @property
    def url(self) -> str:
        return f"https://{self.host}/{self.repo}/resolve/{self.revision}/{self.file}"  # config-lint: ok (protocol shape)


def _host_ok(host: str) -> bool:
    return (
        bool(host) and not host.startswith(".") and not host.endswith(".") and ".." not in host
        and not _IPV4.fullmatch(host) and host != "localhost"
    )


def parse_link(url: object, hosts: list[str]) -> ModelLink:
    """The link's parts, or LinkError(invalid_model_link | model_link_host_not_allowed | model_link_unsupported_type)."""
    if not isinstance(url, str) or not url or len(url) > URL_MAX or not url.isascii():
        raise LinkError("invalid_model_link", "the model link must be an https Hugging Face file link")
    m = _URL.fullmatch(url)
    if m is None:
        raise LinkError("invalid_model_link", "the model link must be a plain https Hugging Face link: <host>/<owner>/<repo>/resolve/<revision>/<file>")
    host, path = m.group(1), m.group(2)
    if not _host_ok(host):
        raise LinkError("invalid_model_link", "the model link has no usable host name")
    if host not in {h.strip().lower() for h in hosts if h.strip()}:
        raise LinkError("model_link_host_not_allowed", "links are only accepted from the allowed model hosts")
    parts = path.split("/")[1:]
    if len(parts) < 5 or parts[2] not in ("resolve", "blob") or len(parts) - 4 > _PATH_SEGMENTS_MAX:
        raise LinkError("invalid_model_link", "the model link must point to one file: <owner>/<repo>/resolve/<revision>/<file>")
    owner, repo, _kind, revision, *rest = parts
    if not (_NAME.fullmatch(owner) and _NAME.fullmatch(repo) and _REVISION.fullmatch(revision)):
        raise LinkError("invalid_model_link", "the model link has an invalid repo or revision")
    if not all(_SEGMENT.fullmatch(s) and s not in (".", "..") for s in rest) or any(".." in s for s in rest + [owner, repo, revision]):
        raise LinkError("invalid_model_link", "the model link has an invalid file path")
    name = rest[-1]
    if not any(name.endswith(s) and name != s for s in SUFFIXES):
        raise LinkError("model_link_unsupported_type", "only .safetensors or .gguf model files can be linked")
    return ModelLink(host=host, repo=f"{owner}/{repo}", revision=revision, file="/".join(rest), name=name)


def redirect_allowed(host: str, link_hosts: list[str], domains: list[str]) -> bool:
    """A link host itself, or a host equal to or under (at a dot) one of the redirect domains."""
    host = host.lower()
    if not _host_ok(host) or ":" in host:
        return False
    if host in {h.strip().lower() for h in link_hosts}:
        return True
    return any(host == d or host.endswith("." + d) for d in (x.strip().lower() for x in domains) if d)


def redirect_guard(link_hosts: list[str], domains: list[str]) -> Callable[[httpx.Request], None]:
    """An httpx request hook: refuses every request of a linked download (redirect hops included) that is not
    https on port 443 to an allowed host, before it is sent."""

    def check(request: httpx.Request) -> None:
        url = request.url
        if url.scheme != "https" or url.port not in (None, 443) or url.userinfo or not redirect_allowed(url.host, link_hosts, domains):
            raise LinkError("model_link_redirect_not_allowed", "the model host redirected to a host that is not allowed")

    return check


def probe_size(client: httpx.Client, link: ModelLink, max_bytes: int) -> int:
    """The file size from a HEAD of its resolve URL (redirects followed through the guard), capped."""
    try:
        response = client.head(link.url, follow_redirects=True)
    except httpx.HTTPError:
        raise LinkError("model_link_unreachable", "the model link could not be reached") from None
    if response.status_code != 200:
        raise LinkError("model_link_unreachable", f"the model link answered HTTP {response.status_code}")
    text = response.headers.get("content-length", "")
    if not text.isdigit() or int(text) <= 0:
        raise LinkError("model_link_unreachable", "the model host did not say how large the file is")
    size = int(text)
    if size > max_bytes:
        raise LinkError("model_link_too_large", f"the linked file has {size} bytes, more than the allowed {max_bytes}")
    return size


def is_gguf(name: str) -> bool:
    return name.endswith(".gguf")


def required_loader(name: str) -> str | None:
    """The node class a linked model needs beyond the pinned workflow's: the GGUF loader for a .gguf file."""
    return GGUF_LOADER if is_gguf(name) else None


def check_model_file(path: Path) -> None:
    """The downloaded file must be what its extension says: a GGUF file starts with b"GGUF"; a safetensors file starts
    with the little-endian length of its JSON header, which opens with "{" and fits in the file. LinkError otherwise."""
    size = Path(path).stat().st_size
    with Path(path).open("rb") as handle:
        head = handle.read(9)
    if is_gguf(Path(path).name):
        ok = head[:4] == GGUF_MAGIC
    else:
        length = int.from_bytes(head[:8], "little") if len(head) >= 8 else 0
        ok = len(head) == 9 and 0 < length <= SAFETENSORS_HEADER_MAX and length + 8 <= size and head[8:9] == b"{"
    if not ok:
        raise LinkError("model_link_bad_file", f"the downloaded file is not a valid {Path(path).suffix} model file")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while chunk := handle.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class ActiveLink:
    """The linked diffusion model in use on this instance (state dir, video_link.json)."""

    url: str
    repo: str
    revision: str
    file: str
    name: str
    dest: str
    size_bytes: int
    sha256: str


def diffusion_slot(profile: Profile) -> ModelSpec | None:
    """The video section's diffusion model entry: the one slot a link may replace (text encoder and VAE stay pinned)."""
    return next((m for m in video_model_specs(profile) if m.dest.rstrip("/") == DIFFUSION_FOLDER), None)


def guarded_client(link_hosts: list[str], domains: list[str], timeout_s: float) -> httpx.Client:
    """The HTTP client of a linked download: every request, redirects included, passes redirect_guard first."""
    return httpx.Client(timeout=timeout_s, event_hooks={"request": [redirect_guard(link_hosts, domains)]})


def linked_spec(url: object, profile: Profile, *, hosts: list[str], client: httpx.Client, max_bytes: int) -> tuple[ModelSpec, ModelLink]:
    """The `models` entry a link stands for: the diffusion slot's dest, the link's repo / revision / file and the size
    its host reports (capped). LinkError when the link, the profile or the host refuses."""
    slot = diffusion_slot(profile)
    if slot is None:
        parse_link(url, hosts)
        raise LinkError("invalid_model_link", "the profile's video section has no diffusion model to replace")
    return expert_spec(url, profile, slot.dest, hosts=hosts, client=client, max_bytes=max_bytes)


def expert_spec(url: object, profile: Profile, dest: str, *, hosts: list[str], client: httpx.Client, max_bytes: int,
                taken: tuple[str, ...] = ()) -> tuple[ModelSpec, ModelLink]:
    """The `models` entry a link to a diffusion model stands for, stored in `dest`: refused when its name is that of
    a pinned model or one of `taken` (other linked files it would overwrite); the size from a HEAD, capped."""
    link = parse_link(url, hosts)
    if any(m.file.rsplit("/", 1)[-1] == link.name for m in profile.models) or link.name in taken:
        raise LinkError("model_link_name_clash", "the linked file has the name of a pinned or another linked model; it would overwrite it")
    size = probe_size(client, link, max_bytes)
    return ModelSpec(file=link.file, repo=link.repo, revision=link.revision, dest=dest, size_bytes=size), link


def link_path(state_dir: Path) -> Path:
    return Path(state_dir) / "video_link.json"


def read_active(state_dir: Path) -> ActiveLink | None:
    try:
        raw = json.loads(link_path(state_dir).read_text())
        link = ActiveLink(**raw)
    except (OSError, ValueError, TypeError):
        return None
    ok = (
        _SEGMENT.fullmatch(link.name) is not None and any(link.name.endswith(s) for s in SUFFIXES) and isinstance(link.dest, str)
        and _DEST.fullmatch(link.dest) is not None and isinstance(link.file, str) and link.file.rsplit("/", 1)[-1] == link.name
        and isinstance(link.size_bytes, int) and link.size_bytes > 0 and re.fullmatch(r"[0-9a-f]{64}", link.sha256 or "")
    )
    return link if ok else None


def write_active(state_dir: Path, link: ActiveLink) -> None:
    atomic_write(link_path(state_dir), json.dumps(asdict(link)))


def clear_active(state_dir: Path) -> None:
    try:
        link_path(state_dir).unlink()
    except FileNotFoundError:
        pass


# ---- linked experts of a video family (state dir, video_links_<family>.json: {"<mode>.<slot>": ActiveLink}) ----

_FAMILY_FILE_ID = re.compile(r"[a-z][a-z0-9_]{0,31}")
_LINK_KEY = re.compile(r"(text|image)\.[a-z][a-z0-9]{0,15}")


def family_links_path(state_dir: Path, family: str) -> Path:
    if not _FAMILY_FILE_ID.fullmatch(family):
        raise ValueError("not a family id")
    return Path(state_dir) / f"video_links_{family}.json"


def _valid_active(link: ActiveLink) -> bool:
    return bool(
        isinstance(link.name, str) and _SEGMENT.fullmatch(link.name) is not None and any(link.name.endswith(s) for s in SUFFIXES)
        and isinstance(link.dest, str) and _DEST.fullmatch(link.dest) is not None and isinstance(link.file, str)
        and link.file.rsplit("/", 1)[-1] == link.name and isinstance(link.size_bytes, int) and link.size_bytes > 0
        and re.fullmatch(r"[0-9a-f]{64}", link.sha256 or "")
    )


def read_family_links(state_dir: Path, family: str) -> dict[str, ActiveLink]:
    """The family's linked experts by "<mode>.<slot>"; empty when there are none or the file is unusable."""
    try:
        raw = json.loads(family_links_path(state_dir, family).read_text())
        links = {key: ActiveLink(**value) for key, value in raw.items()}
    except (OSError, ValueError, TypeError, AttributeError):
        return {}
    if not all(_LINK_KEY.fullmatch(k) and _valid_active(v) for k, v in links.items()):
        return {}
    return links


def write_family_links(state_dir: Path, family: str, links: dict[str, ActiveLink]) -> None:
    if not links:
        clear_family_links(state_dir, family)
        return
    atomic_write(family_links_path(state_dir, family), json.dumps({k: asdict(v) for k, v in sorted(links.items())}))


def clear_family_links(state_dir: Path, family: str) -> None:
    try:
        family_links_path(state_dir, family).unlink()
    except FileNotFoundError:
        pass
