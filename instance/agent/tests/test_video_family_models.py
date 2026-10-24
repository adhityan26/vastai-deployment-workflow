"""On-demand downloads of a video family (profile `video_families:`), with optional linked experts per mode."""
import hashlib

import httpx
import pytest

from vastcomfy_agent.model_link import GGUF_MAGIC, read_family_links, read_active
from vastcomfy_agent.profile import Downloader, load_profile
from vastcomfy_agent.state import State, StateStore
from vastcomfy_agent.video_models import VideoModels, VideoModelsRefused

PROFILE = """
name: image
requires: {vram_gb: 24, disk_gb: 40}
nodes: []
models:
  - {file: m.bin, repo: org/m, revision: r1, dest: models/x/, size_bytes: 10}
  - {file: sub/b.safetensors, repo: org/v, revision: r1, dest: models/diffusion_models/, size_bytes: 20}
  - {file: sub/enc.safetensors, repo: org/v, revision: r1, dest: models/text_encoders/, size_bytes: 30}
  - {file: sub/th.safetensors, repo: org/v, revision: r1, dest: models/diffusion_models/, size_bytes: 40}
  - {file: sub/tl.safetensors, repo: org/v, revision: r1, dest: models/diffusion_models/, size_bytes: 50}
  - {file: sub/ih.safetensors, repo: org/v, revision: r1, dest: models/diffusion_models/, size_bytes: 60}
  - {file: sub/il.safetensors, repo: org/v, revision: r1, dest: models/diffusion_models/, size_bytes: 70}
workflows: [video.json, t.json, i.json]
video:
  id: small
  workflow: video.json
  models: [{file: b.safetensors, dest: models/diffusion_models/}, {file: enc.safetensors, dest: models/text_encoders/}]
  node_classes: [SaveVideo]
video_families:
  - id: big
    title: Big
    models:
      - {file: th.safetensors, dest: models/diffusion_models/}
      - {file: tl.safetensors, dest: models/diffusion_models/}
      - {file: ih.safetensors, dest: models/diffusion_models/}
      - {file: il.safetensors, dest: models/diffusion_models/}
      - {file: enc.safetensors, dest: models/text_encoders/}
    node_classes: [SaveVideo, KSamplerAdvanced]
    text: {workflow: t.json, experts: [{slot: high, file: th.safetensors}, {slot: low, file: tl.safetensors}]}
    image: {workflow: i.json, experts: [{slot: high, file: ih.safetensors}, {slot: low, file: il.safetensors}]}
"""
SIZES = {"m.bin": 10, "b.safetensors": 20, "enc.safetensors": 30, "th.safetensors": 40, "tl.safetensors": 50,
         "ih.safetensors": 60, "il.safetensors": 70}
FAMILY_BYTES = 40 + 50 + 60 + 70 + 30
SAFE = (2).to_bytes(8, "little") + b"{}"
HIGH = "https://huggingface.co/someone/q/resolve/main/high-Q4.gguf"
LOW = "https://huggingface.co/someone/q/resolve/main/low-Q4.gguf"
GGUF = GGUF_MAGIC + b"\x03\x00\x00\x00rest"


class Clock:
    def __call__(self):
        return 1


class FakeComfy:
    def __init__(self, registered, listed=None):
        self.registered, self.listed = set(registered), listed

    def node_class_registered(self, name):
        return name in self.registered

    def unlisted_files(self, classes, names):
        return [] if self.listed is None else [n for n in names if n not in self.listed]


def make(tmp_path, *, families=("big",), run_now=True, free=10**12, registered=("SaveVideo", "KSamplerAdvanced", "UnetLoaderGGUF"),
         boot_families=(), include=False, size=str(len(GGUF)), body=GGUF, listed=None):
    from vastcomfy_agent.model_link import redirect_guard

    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / "image.yaml").write_text(PROFILE)
    states = StateStore(tmp_path / "state", Clock())
    if states.get().state is None:
        for s in (State.BOOTING, State.DOWNLOADING, State.READY):
            states.set(s)
    pinned, linked, jobs = [], [], []

    def pinned_handler(request):
        name = request.url.path.rsplit("/", 1)[-1]
        pinned.append(name)
        return httpx.Response(200, content=b"x" * SIZES[name])

    def link_handler(request):
        linked.append((request.method, str(request.url)))
        if request.method == "HEAD":
            return httpx.Response(200, headers={"content-length": size})
        return httpx.Response(200, content=body)

    plain = httpx.Client(transport=httpx.MockTransport(pinned_handler))
    guarded = httpx.Client(transport=httpx.MockTransport(link_handler),
                           event_hooks={"request": [redirect_guard(["huggingface.co"], ["huggingface.co", "hf.co"])]})
    vm = VideoModels(
        load_profile=lambda: load_profile(tmp_path / "image.yaml", video_enabled=True, video_families=families),
        comfy=FakeComfy(registered, listed), comfy_dir=tmp_path / "comfy", free_bytes_fn=lambda p: free, disk_margin_mb=0,
        include_at_boot=include, boot_families=boot_families,
        make_downloader=lambda on: Downloader(hf_base="https://hf.example", token="", client=plain, retries=1, backoff_s=0,
                                              chunk_bytes=7, sleep=lambda s: None, on_progress=on),
        states=states, state_dir=tmp_path / "state", link_hosts=["huggingface.co"], link_max_bytes=1000,
        make_link_client=lambda: guarded,
        make_link_downloader=lambda client, link, on: Downloader(hf_base=f"https://{link.host}", token="", client=client, retries=1,
                                                                 backoff_s=0, chunk_bytes=7, sleep=lambda s: None, on_progress=on),
        spawn=(lambda job: job()) if run_now else jobs.append,
    )
    return vm, pinned, linked, jobs


def family(vm, fid="big"):
    return next(f for f in vm.families_view() if f.id == fid)


def test_each_enabled_family_reports_its_own_state_and_the_base_keeps_its_status(tmp_path):
    vm, _, _, _ = make(tmp_path)
    assert [f.id for f in vm.families_view()] == ["small", "big"]
    big = family(vm)
    assert big.model_dump() == {
        "id": "big", "state": "not_installed", "boot": False, "bytes_done": 0, "bytes_total": FAMILY_BYTES, "reason": None,
        "experts": [
            {"mode": "text", "slot": "high", "file": "th.safetensors", "linked": False, "sha256": None},
            {"mode": "text", "slot": "low", "file": "tl.safetensors", "linked": False, "sha256": None},
            {"mode": "image", "slot": "high", "file": "ih.safetensors", "linked": False, "sha256": None},
            {"mode": "image", "slot": "low", "file": "il.safetensors", "linked": False, "sha256": None},
        ],
    }
    assert family(vm, "small").bytes_total == 50 and family(vm, "small").experts == []
    assert vm.view().state == "not_installed" and vm.view().bytes_total == 50  # the base section, as before


def test_a_family_off_or_unknown_is_unavailable(tmp_path):
    vm, _, _, _ = make(tmp_path, families=())
    assert [f.id for f in vm.families_view()] == ["small"]
    for fid in ("big", "nope"):
        with pytest.raises(VideoModelsRefused) as err:
            vm.request(family=fid)
        assert err.value.status == 404 and err.value.code == "video_unavailable"


def test_a_family_download_fetches_only_its_missing_files_and_becomes_ready(tmp_path):
    vm, pinned, _, _ = make(tmp_path)
    view = vm.request(family="big")
    assert view.id == "big"
    assert pinned == ["enc.safetensors", "th.safetensors", "tl.safetensors", "ih.safetensors", "il.safetensors"]
    assert family(vm).state == "ready" and family(vm).bytes_done == FAMILY_BYTES
    # The shared text encoder is there now: the base section needs only its own diffusion model.
    assert vm.view().bytes_total == 20


def test_the_base_family_by_id_is_the_base_download(tmp_path):
    vm, pinned, _, _ = make(tmp_path)
    assert vm.request(family="small").state == "downloading"
    assert vm.view().state == "ready"
    assert pinned == ["b.safetensors", "enc.safetensors"]
    with pytest.raises(VideoModelsRefused) as err:
        vm.request(family="small", mode="text", links={"high": HIGH, "low": LOW})
    assert err.value.status == 400 and err.value.code == "invalid_model_link"


def test_one_download_at_a_time_across_families(tmp_path):
    vm, _, _, jobs = make(tmp_path, run_now=False)
    assert vm.request(family="big").state == "downloading" and vm.busy()
    assert family(vm).state == "downloading" and vm.view().state == "not_installed"
    assert vm.request(family="big").state == "downloading" and len(jobs) == 1  # the same family: nothing changes
    for call in (lambda: vm.start(), lambda: vm.request(family="small")):
        with pytest.raises(VideoModelsRefused) as err:
            call()
        assert err.value.status == 409 and err.value.code == "video_download_busy"
    jobs[0]()
    assert not vm.busy() and family(vm).state == "ready"


def test_the_disk_and_node_classes_are_checked_first(tmp_path):
    vm, pinned, _, _ = make(tmp_path, free=100)
    with pytest.raises(VideoModelsRefused) as err:
        vm.request(family="big")
    assert err.value.code == "disk_insufficient" and pinned == []
    vm, pinned, _, _ = make(tmp_path / "b", registered=("SaveVideo",))
    with pytest.raises(VideoModelsRefused) as err:
        vm.request(family="big")
    assert err.value.code == "video_nodes_missing" and "KSamplerAdvanced" in err.value.message and pinned == []


def test_linked_experts_replace_both_pinned_experts_of_the_mode(tmp_path):
    vm, pinned, linked, _ = make(tmp_path)
    vm.request(family="big", mode="text", links={"high": HIGH, "low": LOW})
    # The text experts come from the links; the image experts and the shared encoder stay pinned.
    assert pinned == ["enc.safetensors", "ih.safetensors", "il.safetensors"]
    assert [m for m, _u in linked] == ["HEAD", "HEAD", "GET", "GET"]
    big = family(vm)
    assert big.state == "ready"
    sha = hashlib.sha256(GGUF).hexdigest()
    assert [(e.mode, e.slot, e.file, e.linked, e.sha256) for e in big.experts] == [
        ("text", "high", "high-Q4.gguf", True, sha), ("text", "low", "low-Q4.gguf", True, sha),
        ("image", "high", "ih.safetensors", False, None), ("image", "low", "il.safetensors", False, None),
    ]
    assert set(read_family_links(tmp_path / "state", "big")) == {"text.high", "text.low"}
    assert read_active(tmp_path / "state") is None  # the base section's link is its own


def test_linking_the_other_mode_keeps_the_first_and_no_links_returns_to_the_pins(tmp_path):
    vm, _, _, _ = make(tmp_path)
    vm.request(family="big", mode="text", links={"high": HIGH, "low": LOW})
    vm.request(family="big", mode="image", links={"high": HIGH.replace("high-", "ihigh-"), "low": LOW.replace("low-", "ilow-")})
    assert set(read_family_links(tmp_path / "state", "big")) == {"text.high", "text.low", "image.high", "image.low"}
    vm.request(family="big")
    assert read_family_links(tmp_path / "state", "big") == {}
    assert all(not e.linked for e in family(vm).experts) and family(vm).state == "ready"


@pytest.mark.parametrize("mode, links, code", [
    ("text", {"high": HIGH}, "invalid_model_link"),  # one-sided
    ("text", {"low": LOW}, "invalid_model_link"),
    ("text", {"high": HIGH, "low": LOW, "mid": LOW}, "invalid_model_link"),
    (None, {"high": HIGH, "low": LOW}, "invalid_model_link"),  # links need a mode
    ("video", {"high": HIGH, "low": LOW}, "invalid_model_link"),
    ("text", {"high": HIGH, "low": HIGH}, "model_link_name_clash"),  # both would be one file
    ("text", {"high": "https://evil.example/a/b/resolve/main/x.gguf", "low": LOW}, "model_link_host_not_allowed"),
    ("text", {"high": HIGH.replace("high-Q4.gguf", "th.safetensors"), "low": LOW}, "model_link_name_clash"),
    ("text", {"high": HIGH.replace(".gguf", ".ckpt"), "low": LOW}, "model_link_unsupported_type"),
])
def test_refused_links_download_nothing(tmp_path, mode, links, code):
    vm, pinned, linked, _ = make(tmp_path)
    with pytest.raises(VideoModelsRefused) as err:
        vm.request(family="big", mode=mode, links=links)
    assert err.value.code == code and err.value.status == 400
    assert pinned == [] and not any(m == "GET" for m, _u in linked)


def test_a_too_large_link_is_a_conflict_and_downloads_nothing(tmp_path):
    vm, pinned, linked, _ = make(tmp_path, size="5000")
    with pytest.raises(VideoModelsRefused) as err:
        vm.request(family="big", mode="text", links={"high": HIGH, "low": LOW})
    assert err.value.status == 409 and err.value.code == "model_link_too_large" and pinned == []


def test_a_gguf_link_needs_the_gguf_loader(tmp_path):
    vm, pinned, linked, _ = make(tmp_path, registered=("SaveVideo", "KSamplerAdvanced"))
    with pytest.raises(VideoModelsRefused) as err:
        vm.request(family="big", mode="text", links={"high": HIGH, "low": LOW})
    assert err.value.code == "video_gguf_loader_missing" and pinned == [] and not any(m == "GET" for m, _u in linked)


def test_a_linked_file_that_is_not_what_it_says_is_deleted_and_the_family_fails(tmp_path):
    vm, _, _, _ = make(tmp_path, body=SAFE, size=str(len(SAFE)))
    vm.request(family="big", mode="text", links={"high": HIGH, "low": LOW})
    big = family(vm)
    assert big.state == "failed" and "model_link_bad_file" in big.reason
    assert not (tmp_path / "comfy" / "models" / "diffusion_models" / "high-Q4.gguf").exists()
    assert read_family_links(tmp_path / "state", "big") == {}
    assert vm.view().state != "failed"  # the base section is not touched


def test_a_family_chosen_for_the_boot_says_so_and_the_base_does_not(tmp_path):
    vm, _, _, _ = make(tmp_path, include=True, boot_families=("big",))
    assert family(vm).boot is True and family(vm, "small").boot is False and vm.view().boot is False
    vm, _, _, _ = make(tmp_path / "b", include=True)
    assert family(vm).boot is False and vm.view().boot is True


def test_a_link_may_not_name_a_file_the_other_mode_already_links(tmp_path):
    vm, pinned, linked, _ = make(tmp_path)
    vm.request(family="big", mode="text", links={"high": HIGH, "low": LOW})
    pinned.clear()
    linked.clear()
    with pytest.raises(VideoModelsRefused) as err:
        vm.request(family="big", mode="image", links={"high": HIGH, "low": LOW.replace("low-", "ilow-")})
    assert err.value.status == 400 and err.value.code == "model_link_name_clash"
    assert pinned == [] and not any(m == "GET" for m, _u in linked)
    assert set(read_family_links(tmp_path / "state", "big")) == {"text.high", "text.low"}
