"""Extra LoRAs an admin added by link (web app LORA store): synced to the instance, downloaded on demand."""
import hashlib

import httpx
import pytest

from vastcomfy_agent.extra_loras import ExtraLoras, LorasRefused, loras_digest
from vastcomfy_agent.model_link import redirect_guard
from vastcomfy_agent.profile import Downloader, load_profile
from vastcomfy_agent.state import State, StateStore
from vastcomfy_agent.video_models import VideoModels, VideoModelsRefused

PROFILE = """
name: image
requires: {vram_gb: 24, disk_gb: 40}
nodes: []
models:
  - {file: m.bin, repo: org/m, revision: r1, dest: models/x/, size_bytes: 10}
  - {file: sub/v.safetensors, repo: org/v, revision: r1, dest: models/v/, size_bytes: 20}
workflows: [video.json]
video:
  workflow: video.json
  models: [{file: v.safetensors, dest: models/v/}]
  node_classes: [SaveVideo]
"""
SAFE = (2).to_bytes(8, "little") + b"{}"
A_URL = "https://huggingface.co/someone/moves/resolve/main/moves_high.safetensors"
B_URL = "https://huggingface.co/other/thing/resolve/abc/lora.safetensors"
A = "xl_lora_00000001_high.safetensors"
B = "xl_lora_00000002_low.safetensors"


class Clock:
    def __call__(self):
        return 1


class FakeComfy:
    def __init__(self, listed=None, queue=(0, 0)):
        self.listed, self.queue = listed, queue

    def node_class_registered(self, name):
        return True

    def unlisted_files(self, classes, names):
        assert classes == ("LoraLoaderModelOnly",)
        return [] if self.listed is None else [n for n in names if n not in self.listed]

    def queue_counts(self):
        return self.queue


def make(tmp_path, *, free=10**12, size=None, body=SAFE, comfy=None, run_now=True, max_bytes=1000, state=State.READY,
         total=10**6):
    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / "image.yaml").write_text(PROFILE)
    states = StateStore(tmp_path / "state", Clock())
    if states.get().state is None:
        for s in (State.BOOTING, State.DOWNLOADING, State.READY):
            states.set(s)
    if state == State.STOPPING:
        states.set(State.STOPPING)
    seen, jobs = [], []

    def handler(request):
        seen.append((request.method, str(request.url)))
        if request.method == "HEAD":
            return httpx.Response(200, headers={"content-length": str(len(body) if size is None else size)})
        return httpx.Response(200, content=body)

    guarded = httpx.Client(transport=httpx.MockTransport(handler),
                           event_hooks={"request": [redirect_guard(["huggingface.co"], ["huggingface.co", "hf.co"])]})
    spawn = (lambda job: job()) if run_now else jobs.append
    link_downloader = lambda client, link, on: Downloader(hf_base=f"https://{link.host}", token="", client=client, retries=1,  # noqa: E731
                                                          backoff_s=0, chunk_bytes=7, sleep=lambda s: None, on_progress=on)
    video = VideoModels(
        load_profile=lambda: load_profile(tmp_path / "image.yaml", video_enabled=True), comfy=comfy or FakeComfy(),
        comfy_dir=tmp_path / "comfy", free_bytes_fn=lambda p: free, disk_margin_mb=0, include_at_boot=False,
        make_downloader=lambda on: None, states=states, state_dir=tmp_path / "state", spawn=spawn,
    )
    loras = ExtraLoras(
        slot=video, load_profile=lambda: load_profile(tmp_path / "image.yaml", video_enabled=True), comfy=comfy or video._comfy,
        comfy_dir=tmp_path / "comfy", free_bytes_fn=lambda p: free, disk_margin_mb=0, states=states,
        state_dir=tmp_path / "state", link_hosts=["huggingface.co"], link_max_bytes=max_bytes, total_max_bytes=total,
        make_link_client=lambda: guarded, make_link_downloader=link_downloader, spawn=spawn,
    )
    return loras, video, seen, jobs


def item(view, name):
    return next(i for i in view.items if i.name == name)


def test_nothing_desired_until_the_web_app_syncs(tmp_path):
    loras, _, _, _ = make(tmp_path)
    assert loras.view().model_dump() == {"digest": None, "items": []}


def test_a_sync_downloads_the_missing_files_under_the_server_chosen_names_with_their_sha256(tmp_path):
    loras, _, seen, _ = make(tmp_path)
    view = loras.sync([(A, A_URL), (B, B_URL)])
    assert view.digest == loras_digest([(A, A_URL), (B, B_URL)])
    assert [m for m, _u in seen] == ["HEAD", "GET", "HEAD", "GET"]
    sha = hashlib.sha256(SAFE).hexdigest()
    for name in (A, B):
        assert item(loras.view(), name).model_dump() == {
            "name": name, "state": "ready", "bytes_done": len(SAFE), "bytes_total": len(SAFE), "size_bytes": len(SAFE),
            "sha256": sha, "reason": None,
        }
        assert (tmp_path / "comfy" / "models" / "loras" / name).read_bytes() == SAFE
    # The link's own file name is never used on the instance, and the staging folder is left empty.
    assert not (tmp_path / "comfy" / "models" / "loras" / "moves_high.safetensors").exists()
    assert list((tmp_path / "comfy" / "models" / "xl_staging").iterdir()) == []
    seen.clear()
    loras.sync([(A, A_URL), (B, B_URL)])
    assert seen == []  # nothing missing


def test_the_digest_is_order_independent_and_matches_the_web_app():
    assert loras_digest([(A, A_URL), (B, B_URL)]) == loras_digest([(B, B_URL), (A, A_URL)])
    assert loras_digest([(A, A_URL), (B, B_URL)]) == hashlib.sha256(f"{A} {A_URL}\n{B} {B_URL}".encode()).hexdigest()
    assert loras_digest([]) == hashlib.sha256(b"").hexdigest()


def test_the_desired_set_and_the_hashes_survive_an_agent_restart(tmp_path):
    loras, _, _, _ = make(tmp_path)
    loras.sync([(A, A_URL)])
    again, _, seen, _ = make(tmp_path)
    assert again.view().digest == loras_digest([(A, A_URL)])
    assert item(again.view(), A).state == "ready" and item(again.view(), A).sha256 == hashlib.sha256(SAFE).hexdigest()
    assert seen == []


@pytest.mark.parametrize("items, code", [
    ([("evil.safetensors", A_URL)], "invalid_lora_name"),
    ([("../xl_lora_00000001_high.safetensors", A_URL)], "invalid_lora_name"),
    ([("xl_lora_00000001_mid.safetensors", A_URL)], "invalid_lora_name"),
    ([(A, A_URL), (A, B_URL)], "invalid_lora_name"),
    ([(A, A_URL.replace(".safetensors", ".gguf"))], "model_link_unsupported_type"),
    ([(A, "https://evil.example/o/r/resolve/main/x.safetensors")], "model_link_host_not_allowed"),
    ([(A, "http://huggingface.co/o/r/resolve/main/x.safetensors")], "invalid_model_link"),
    ([(A, "https://user@huggingface.co/o/r/resolve/main/x.safetensors")], "invalid_model_link"),
])
def test_a_refused_sync_changes_nothing_and_downloads_nothing(tmp_path, items, code):
    loras, _, seen, _ = make(tmp_path)
    loras.sync([(A, A_URL)])
    seen.clear()
    with pytest.raises(LorasRefused) as err:
        loras.sync(items)
    assert err.value.status == 400 and err.value.code == code
    assert seen == [] and loras.view().digest == loras_digest([(A, A_URL)])


def test_too_large_a_file_fails_that_lora_only(tmp_path):
    loras, _, seen, _ = make(tmp_path, size=5000)
    loras.sync([(A, A_URL)])
    failed = item(loras.view(), A)
    assert failed.state == "failed" and "model_link_too_large" in failed.reason
    assert [m for m, _u in seen] == ["HEAD"]


def test_the_disk_is_checked_before_a_byte(tmp_path):
    loras, _, seen, _ = make(tmp_path, free=5)
    loras.sync([(A, A_URL)])
    failed = item(loras.view(), A)
    assert failed.state == "failed" and "disk_insufficient" in failed.reason
    assert [m for m, _u in seen] == ["HEAD"]


def test_a_file_that_is_not_safetensors_is_deleted_and_fails(tmp_path):
    loras, _, _, _ = make(tmp_path, body=b"<html>not a model</html>")
    loras.sync([(A, A_URL)])
    failed = item(loras.view(), A)
    assert failed.state == "failed" and "model_link_bad_file" in failed.reason
    assert not (tmp_path / "comfy" / "models" / "loras" / A).exists()
    assert list((tmp_path / "comfy" / "models" / "xl_staging").iterdir()) == []


def test_a_file_comfyui_does_not_list_fails_with_a_clear_reason(tmp_path):
    loras, _, _, _ = make(tmp_path, comfy=FakeComfy(listed=()))
    loras.sync([(A, A_URL)])
    assert "does not list" in item(loras.view(), A).reason


def test_a_failed_lora_is_retried_by_the_next_sync(tmp_path):
    loras, _, seen, _ = make(tmp_path, size=5000)
    loras.sync([(A, A_URL)])
    assert item(loras.view(), A).state == "failed"
    seen.clear()
    loras.sync([(A, A_URL)])
    assert [m for m, _u in seen] == ["HEAD"]  # tried again (the fake still answers 5000 bytes, so it fails again)
    seen.clear()
    loras.view()
    assert seen == []  # a status read never retries


def test_one_download_at_a_time_with_the_video_models(tmp_path):
    loras, video, _, jobs = make(tmp_path, run_now=False)
    loras.sync([(A, A_URL)])
    assert item(loras.view(), A).state == "downloading" and video.busy()
    with pytest.raises(VideoModelsRefused) as err:
        video.start()
    assert err.value.code == "video_download_busy"
    jobs.pop(0)()
    assert item(loras.view(), A).state == "ready" and not video.busy()


def test_a_sync_while_a_video_download_runs_waits_and_starts_when_it_ends(tmp_path):
    loras, video, seen, jobs = make(tmp_path, run_now=False)
    assert video.try_claim("other")
    loras.sync([(A, A_URL)])
    assert item(loras.view(), A).state == "not_installed" and jobs == []
    video.release("other")
    assert len(jobs) == 1
    jobs.pop(0)()
    assert item(loras.view(), A).state == "ready"


def test_nothing_downloads_while_the_instance_does_not_serve(tmp_path):
    loras, _, seen, jobs = make(tmp_path, state=State.STOPPING, run_now=False)
    loras.sync([(A, A_URL)])
    assert jobs == [] and seen == [] and item(loras.view(), A).state == "not_installed"


def test_a_lora_no_longer_wanted_is_deleted_when_comfyui_is_idle_and_kept_while_it_runs(tmp_path):
    busy = FakeComfy(queue=(1, 0))
    loras, _, _, _ = make(tmp_path, comfy=busy)
    loras.sync([(A, A_URL), (B, B_URL)])
    loras.sync([(A, A_URL)])
    lora_dir = tmp_path / "comfy" / "models" / "loras"
    assert (lora_dir / B).exists()  # a job may be using it
    busy.queue = (0, 0)
    loras.sync([(A, A_URL)])
    assert not (lora_dir / B).exists() and (lora_dir / A).exists()
    assert [i.name for i in loras.view().items] == [A]
    # Files that are not ours are never touched.
    (lora_dir / "pinned_style.safetensors").write_bytes(b"x")
    loras.sync([])
    assert (lora_dir / "pinned_style.safetensors").exists() and not (lora_dir / A).exists()


def test_a_name_of_a_pinned_model_is_refused(tmp_path):
    loras, _, _, _ = make(tmp_path)
    with pytest.raises(LorasRefused) as err:
        loras.sync([("xl_lora_00000001_high.safetensors", A_URL), ("v.safetensors", B_URL)])
    assert err.value.code == "invalid_lora_name"


def test_the_total_of_extra_lora_files_is_capped(tmp_path):
    loras, _, seen, _ = make(tmp_path, total=len(SAFE) + 1)
    loras.sync([(A, A_URL), (B, B_URL)])
    assert item(loras.view(), A).state == "ready"
    failed = item(loras.view(), B)
    assert failed.state == "failed" and "lora_total_too_large" in failed.reason
    assert [m for m, _u in seen] == ["HEAD", "GET", "HEAD"]


def test_a_pinned_model_with_a_lora_like_name_is_never_replaced(tmp_path):
    loras, _, _, _ = make(tmp_path)
    (tmp_path / "image.yaml").write_text(PROFILE.replace("workflows:", "  - {file: xl_lora_00000009_high.safetensors, repo: o/r, revision: r1, dest: models/loras/, size_bytes: 5}\nworkflows:"))
    with pytest.raises(LorasRefused) as err:
        loras.sync([("xl_lora_00000009_high.safetensors", A_URL)])
    assert err.value.code == "invalid_lora_name"


def test_only_files_of_the_lora_name_shape_are_ever_deleted(tmp_path):
    loras, _, _, _ = make(tmp_path)
    lora_dir = tmp_path / "comfy" / "models" / "loras"
    lora_dir.mkdir(parents=True)
    (lora_dir / "xl_style.safetensors").write_bytes(b"x")  # starts like ours, but is not a name the web app chooses
    loras.sync([])
    assert (lora_dir / "xl_style.safetensors").exists()


def test_a_sync_during_a_video_model_download_starts_when_that_download_ends(tmp_path):
    loras, video, _, jobs = make(tmp_path, run_now=False)
    video.start()  # the base section's download (its downloader fails here, which also ends it)
    assert video.busy() and len(jobs) == 1
    loras.sync([(A, A_URL)])
    assert len(jobs) == 1 and item(loras.view(), A).state == "not_installed"
    jobs.pop(0)()
    assert len(jobs) == 1  # the LoRA pass, started by the end of the video download
    jobs.pop(0)()
    assert item(loras.view(), A).state == "ready"
