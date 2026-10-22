import httpx
import pytest

from vastcomfy_agent.comfy import ComfyClient, ComfyUnavailable
from vastcomfy_agent.profile import Downloader, ProfileError, load_profile
from vastcomfy_agent.state import State, StateStore
from vastcomfy_agent.video_models import VideoModels, VideoModelsRefused

PROFILE = """
name: image
requires: {vram_gb: 24, disk_gb: 40}
nodes: []
models:
  - {file: m.bin, repo: org/m, revision: r1, dest: models/x/, size_bytes: 10}
  - {file: sub/v1.bin, repo: org/v, revision: r1, dest: models/v/, size_bytes: 20}
  - {file: sub/v2.bin, repo: org/v, revision: r1, dest: models/w/, size_bytes: 30}
workflows: [video.json]
video:
  enabled: ENABLED
  workflow: video.json
  models: [{file: v1.bin, dest: models/v/}, {file: v2.bin, dest: models/w/}]
  node_classes: [VideoLoader, SaveVideo]
"""


class FakeComfy:
    def __init__(self, registered=("VideoLoader", "SaveVideo"), listed=("v1.bin", "v2.bin"), down=False):
        self.registered, self.listed, self.down = set(registered), set(listed), down

    def node_class_registered(self, name):
        if self.down:
            raise ComfyUnavailable("down")
        return name in self.registered

    def unlisted_files(self, classes, names):
        if self.down:
            raise ComfyUnavailable("down")
        return [n for n in names if n not in self.listed]


class Clock:
    def __call__(self):
        return 1


def body_for(request):
    name = request.url.path.rsplit("/", 1)[-1]
    return {"m.bin": 10, "v1.bin": 20, "v2.bin": 30}[name]


def make(tmp_path, *, enabled=True, comfy=None, free=10**12, state=State.READY, include=False, handler=None, run_now=True,
         margin=0):
    profile_path = tmp_path / "image.yaml"
    profile_path.write_text(PROFILE.replace("ENABLED", "true" if enabled else "false"))
    states = StateStore(tmp_path / "state", Clock())
    if states.get().state is None:
        for s in (State.BOOTING, State.DOWNLOADING, State.READY):
            states.set(s)
    if state == State.STOPPING:
        states.set(State.STOPPING)
    seen = []

    def default_handler(request):
        seen.append(request.url.path)
        return httpx.Response(200, content=b"x" * body_for(request))

    client = httpx.Client(transport=httpx.MockTransport(handler or default_handler))
    jobs = []

    def make_downloader(on_progress):
        return Downloader(hf_base="https://hf.example", token="", client=client, retries=1, backoff_s=0, chunk_bytes=7,
                          sleep=lambda s: None, on_progress=on_progress)

    vm = VideoModels(
        load_profile=lambda: load_profile(profile_path), comfy=comfy or FakeComfy(), comfy_dir=tmp_path / "comfy",
        free_bytes_fn=lambda p: free, disk_margin_mb=margin, include_at_boot=include, make_downloader=make_downloader,
        states=states, spawn=(lambda job: job()) if run_now else jobs.append,
    )
    return vm, seen, jobs


def put(tmp_path, folder, name, size):
    target = tmp_path / "comfy" / "models" / folder / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"x" * size)


def test_not_installed_until_downloaded_then_ready(tmp_path):
    vm, seen, _ = make(tmp_path, include=False)
    assert vm.view().model_dump() == {"state": "not_installed", "boot": False, "bytes_done": 0, "bytes_total": 50, "reason": None}
    view = vm.start()
    assert view.state == "downloading" and view.bytes_total == 50
    # Only the video files, from their pinned revision, into their own folders.
    assert seen == ["/org/v/resolve/r1/sub/v1.bin", "/org/v/resolve/r1/sub/v2.bin"]
    assert (tmp_path / "comfy" / "models" / "w" / "v2.bin").stat().st_size == 30
    assert vm.view().model_dump() == {"state": "ready", "boot": False, "bytes_done": 50, "bytes_total": 50, "reason": None}
    assert not vm.busy()


def test_only_the_missing_files_are_fetched_and_ready_needs_no_download(tmp_path):
    vm, seen, _ = make(tmp_path)
    put(tmp_path, "v", "v1.bin", 20)
    assert vm.view().bytes_total == 30
    vm.start()
    assert seen == ["/org/v/resolve/r1/sub/v2.bin"]
    put(tmp_path, "w", "v2.bin", 30)
    seen.clear()
    assert vm.start().state == "ready" and seen == []


def test_a_running_download_is_single_flight_counts_as_busy_and_reports_progress(tmp_path):
    vm, seen, jobs = make(tmp_path, run_now=False)
    first = vm.start()
    assert first.state == "downloading" and vm.busy()
    assert vm.start().state == "downloading" and len(jobs) == 1  # a second start changes nothing
    jobs[0]()
    assert not vm.busy() and vm.view().state == "ready"


def test_progress_is_the_bytes_of_all_files_so_far(tmp_path):
    snapshots = []
    holder = {}

    def handler(request):
        snapshots.append(holder["vm"].view().bytes_done)
        return httpx.Response(200, content=b"x" * body_for(request))

    vm, _, jobs = make(tmp_path, run_now=False, handler=handler)
    holder["vm"] = vm
    vm.start()
    jobs[0]()
    assert snapshots == [0, 20]


def test_the_disk_is_checked_before_anything_is_fetched(tmp_path):
    vm, seen, _ = make(tmp_path, free=40, margin=0)
    with pytest.raises(VideoModelsRefused) as err:
        vm.start()
    assert err.value.status == 409 and err.value.code == "disk_insufficient"
    assert "GB needed" in err.value.message and "Include video models" in err.value.message
    assert seen == [] and vm.view().state == "not_installed"


def test_missing_node_classes_refuse_before_the_download(tmp_path):
    vm, seen, _ = make(tmp_path, comfy=FakeComfy(registered=("SaveVideo",)))
    with pytest.raises(VideoModelsRefused) as err:
        vm.start()
    assert err.value.code == "video_nodes_missing" and "VideoLoader" in err.value.message and seen == []
    vm, _, _ = make(tmp_path, comfy=FakeComfy(down=True))
    with pytest.raises(VideoModelsRefused) as err:
        vm.start()
    assert err.value.status == 503 and err.value.code == "comfy_unavailable"


@pytest.mark.parametrize("state", [State.STOPPING])
def test_only_while_the_instance_serves(tmp_path, state):
    vm, seen, _ = make(tmp_path, state=state)
    with pytest.raises(VideoModelsRefused) as err:
        vm.start()
    assert err.value.code == "not_ready" and seen == []


def test_unavailable_without_an_enabled_video_section_or_with_a_broken_profile(tmp_path):
    vm, _, _ = make(tmp_path, enabled=False)
    assert vm.view().state == "unavailable"
    with pytest.raises(VideoModelsRefused) as err:
        vm.start()
    assert err.value.status == 404 and err.value.code == "video_unavailable"

    def broken():
        raise ProfileError("bad")

    vm, _, _ = make(tmp_path)
    vm._load_profile = broken
    assert vm.view().state == "unavailable"


def test_a_failed_download_is_reported_leaves_no_partial_file_and_can_be_retried(tmp_path):
    vm, _, _ = make(tmp_path, handler=lambda r: httpx.Response(500))
    vm.start()
    view = vm.view()
    assert view.state == "failed" and view.reason.startswith("download failed: v1.bin") and not vm.busy()
    assert not list((tmp_path / "comfy").rglob("*.part"))
    vm2, _, _ = make(tmp_path)
    assert vm2.start().state == "downloading" and vm2.view().state == "ready"


def test_files_comfyui_does_not_list_fail_with_a_clear_reason(tmp_path):
    vm, _, _ = make(tmp_path, comfy=FakeComfy(listed=("v1.bin",)))
    vm.start()
    view = vm.view()
    assert view.state == "failed" and "v2.bin" in view.reason and "restart" in view.reason


def test_an_unexpected_error_never_leaves_it_downloading(tmp_path):
    vm, _, _ = make(tmp_path)

    def boom(_progress):
        raise RuntimeError("x")

    vm._make_downloader = boom
    vm.start()
    assert vm.view().state == "failed" and vm.view().reason == "unexpected error (RuntimeError)" and not vm.busy()


def test_a_boot_that_included_video_says_so(tmp_path):
    vm, _, _ = make(tmp_path, include=True)
    put(tmp_path, "v", "v1.bin", 20)
    put(tmp_path, "w", "v2.bin", 30)
    assert vm.view().model_dump() == {"state": "ready", "boot": True, "bytes_done": 50, "bytes_total": 50, "reason": None}


def test_comfy_client_lists_the_files_its_loaders_offer():
    def handler(request):
        name = request.url.path.rsplit("/", 1)[-1]
        if name == "VideoLoader":
            return httpx.Response(200, json={name: {"input": {"required": {"unet_name": [["v1.bin", "other.bin"], {}]}}}})
        return httpx.Response(200, json={name: {"input": {"required": {"video": ["VIDEO"]}}}})

    comfy = ComfyClient("http://comfy", httpx.Client(transport=httpx.MockTransport(handler)))  # config-lint: ok (test fixture)
    assert comfy.unlisted_files(("VideoLoader", "SaveVideo"), ("v1.bin", "v2.bin")) == ["v2.bin"]
    down = ComfyClient("http://comfy", httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))))  # config-lint: ok (test fixture)
    with pytest.raises(ComfyUnavailable):
        down.unlisted_files(("VideoLoader",), ("v1.bin",))
