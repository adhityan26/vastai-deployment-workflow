import subprocess

import httpx
import pytest

from vastcomfy_agent.files import read_json
from vastcomfy_agent.profile import (
    Downloader, DiskInsufficient, DownloadError, ModelSpec, NodeInstallError, NodeSpec, Profile,
    ProfileError, ProgressWriter, check_disk, install_nodes, load_profile, missing_models, target_path,
)

PROFILE_YAML = """
name: image
requires: {vram_gb: 24, disk_gb: 40}
nodes:
  - {repo: city96/ComfyUI-GGUF, commit: abc123}
models:
  - {file: text_encoders/enc.safetensors, repo: org/model, revision: rev1, dest: models/text_encoders/, size_bytes: 100}
  - {file: unet.gguf, repo: org/model, revision: rev1, dest: models/diffusion_models/, size_bytes: 50}
workflows: [flow.json]
"""


def write_profile(tmp_path, text=PROFILE_YAML):
    path = tmp_path / "image.yaml"
    path.write_text(text)
    return path


def test_load_profile_reads_every_field(tmp_path):
    profile = load_profile(write_profile(tmp_path))
    assert profile.name == "image" and profile.requires_vram_gb == 24 and profile.requires_disk_gb == 40
    assert profile.nodes == (NodeSpec("city96/ComfyUI-GGUF", "abc123"),)
    assert profile.models[0] == ModelSpec("text_encoders/enc.safetensors", "org/model", "rev1", "models/text_encoders/", 100)
    assert profile.workflows == ("flow.json",)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda t: t.replace("name: image\n", ""),
        lambda t: t.replace("size_bytes: 100", "size_bytes: 0"),
        lambda t: t.replace("dest: models/text_encoders/", "dest: ../escape/"),
        lambda t: t.replace("dest: models/text_encoders/", "dest: /abs/"),
        lambda t: t.replace("file: unet.gguf", "file: ../unet.gguf"),
        lambda t: t.replace("revision: rev1", "revision: ''", 1),
    ],
)
def test_invalid_profiles_are_rejected(tmp_path, mutation):
    with pytest.raises(ProfileError):
        load_profile(write_profile(tmp_path, mutation(PROFILE_YAML)))


def model(**kw):
    base = dict(file="sub/m.bin", repo="org/m", revision="r1", dest="models/x/", size_bytes=100)
    base.update(kw)
    return ModelSpec(**base)


def make_downloader(handler, *, retries=3, token="", progress=None, sleeps=None, chunk=10):
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return Downloader(
        hf_base="https://hf.test", token=token, client=client, retries=retries, backoff_s=2, chunk_bytes=chunk,
        sleep=(sleeps if sleeps is not None else []).append, on_progress=progress or (lambda *a: None),
    )


def test_fetch_downloads_verifies_size_and_uses_the_resolve_url(tmp_path):
    seen = []

    def handler(request):
        seen.append((request.url.path, request.headers.get("authorization")))
        return httpx.Response(200, content=b"x" * 100)

    progress = []
    path = make_downloader(handler, token="tok", progress=lambda f, d, t: progress.append((f, d, t))).fetch(model(), tmp_path)
    assert path == tmp_path / "models/x/m.bin" and path.stat().st_size == 100
    assert seen == [("/org/m/resolve/r1/sub/m.bin", "Bearer tok")]
    assert progress[-1] == ("m.bin", 100, 100)
    assert not list(path.parent.glob("*.part"))


def test_no_authorization_header_without_a_token(tmp_path):
    seen = []
    make_downloader(lambda r: (seen.append(r.headers.get("authorization")), httpx.Response(200, content=b"x" * 100))[1]).fetch(model(), tmp_path)
    assert seen == [None]


def test_existing_file_with_the_right_size_is_not_downloaded_again(tmp_path):
    target = tmp_path / "models/x/m.bin"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"y" * 100)

    def handler(request):
        raise AssertionError("must not download")

    assert make_downloader(handler).fetch(model(), tmp_path) == target


def test_existing_file_with_the_wrong_size_is_replaced(tmp_path):
    target = tmp_path / "models/x/m.bin"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"short")
    make_downloader(lambda r: httpx.Response(200, content=b"z" * 100)).fetch(model(), tmp_path)
    assert target.read_bytes() == b"z" * 100


def test_server_errors_are_retried_with_backoff(tmp_path):
    answers = [httpx.Response(500), httpx.Response(503), httpx.Response(200, content=b"x" * 100)]
    sleeps = []
    make_downloader(lambda r: answers.pop(0), sleeps=sleeps).fetch(model(), tmp_path)
    assert sleeps == [2, 2]


def test_html_error_page_with_status_200_never_becomes_a_model_file(tmp_path):
    # Review focus 5
    sleeps = []
    downloader = make_downloader(lambda r: httpx.Response(200, content=b"<html>rate limited</html>"), retries=2, sleeps=sleeps)
    with pytest.raises(DownloadError, match="m.bin"):
        downloader.fetch(model(), tmp_path)
    assert sleeps == [2]
    assert list((tmp_path / "models/x").iterdir()) == []


def test_disk_full_mid_download_cleans_up_and_fails(tmp_path):
    calls = []

    def progress(file, done, total):
        calls.append(done)
        if len(calls) == 2:
            raise OSError(28, "No space left on device")

    downloader = make_downloader(lambda r: httpx.Response(200, content=b"x" * 100), retries=1, progress=progress)
    with pytest.raises(DownloadError):
        downloader.fetch(model(), tmp_path)
    assert list((tmp_path / "models/x").iterdir()) == []


def profile_with(models):
    return Profile("p", 24, 40, (), tuple(models), ())


def test_missing_models_and_check_disk(tmp_path):
    a, b = model(file="a.bin", size_bytes=100), model(file="b.bin", size_bytes=50)
    present = target_path(a, tmp_path)
    present.parent.mkdir(parents=True)
    present.write_bytes(b"x" * 100)
    profile = profile_with([a, b])
    assert missing_models(profile, tmp_path) == [b]
    check_disk(profile, tmp_path, free_bytes=50 + 2 * 1024 * 1024, margin_mb=2)
    with pytest.raises(DiskInsufficient, match="free"):
        check_disk(profile, tmp_path, free_bytes=50 + 2 * 1024 * 1024 - 1, margin_mb=2)


def test_progress_writer_records_the_current_file(tmp_path):
    ProgressWriter(tmp_path, "models")("m.bin", 5, 10)
    assert read_json(tmp_path / "progress.json") == {"phase": "models", "file": "m.bin", "bytes_done": 5, "bytes_total": 10}


class FakeRun:
    def __init__(self, tmp_path, head="abc123", fail_on=None):
        self.cmds, self.head, self.fail_on, self.tmp = [], head, fail_on, tmp_path

    def __call__(self, cmd, **kwargs):
        self.cmds.append(cmd)
        if self.fail_on and self.fail_on in cmd:
            return subprocess.CompletedProcess(cmd, 1, "", "fatal: nope")
        if "clone" in cmd:
            dest = cmd[-1]
            import pathlib
            pathlib.Path(dest).mkdir(parents=True)
            (pathlib.Path(dest) / "requirements.txt").write_text("gguf\n")
        if "rev-parse" in cmd:
            return subprocess.CompletedProcess(cmd, 0, self.head + "\n", "")
        return subprocess.CompletedProcess(cmd, 0, "", "")


def node_profile():
    return Profile("p", 24, 40, (NodeSpec("city96/ComfyUI-GGUF", "abc123"),), (), ())


def test_install_nodes_clones_checks_out_the_pinned_commit_and_installs_requirements(tmp_path):
    run = FakeRun(tmp_path)
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", pip_bin="pip", run=run)
    dest = str(tmp_path / "custom_nodes" / "ComfyUI-GGUF")
    assert run.cmds[0] == ["git", "clone", "https://git.test/city96/ComfyUI-GGUF", dest]
    assert ["git", "-C", dest, "checkout", "--detach", "abc123"] in run.cmds
    assert ["pip", "install", "-r", dest + "/requirements.txt"] in run.cmds


def test_install_nodes_skips_a_node_already_at_the_pinned_commit(tmp_path):
    (tmp_path / "custom_nodes" / "ComfyUI-GGUF").mkdir(parents=True)
    run = FakeRun(tmp_path, head="abc123")
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", pip_bin="pip", run=run)
    assert all("clone" not in c and "checkout" not in c for c in run.cmds)


def test_install_nodes_failure_raises_with_the_command_context(tmp_path):
    with pytest.raises(NodeInstallError, match="clone"):
        install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", pip_bin="pip",
                      run=FakeRun(tmp_path, fail_on="clone"))


def test_install_nodes_reruns_pip_when_a_previous_pip_install_failed(tmp_path):
    run = FakeRun(tmp_path, fail_on="pip")
    with pytest.raises(NodeInstallError, match="pip"):
        install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", pip_bin="pip", run=run)
    run.fail_on = None
    run.cmds.clear()
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", pip_bin="pip", run=run)
    dest = str(tmp_path / "custom_nodes" / "ComfyUI-GGUF")
    assert ["pip", "install", "-r", dest + "/requirements.txt"] in run.cmds
    assert all("clone" not in c and "checkout" not in c for c in run.cmds)


def test_install_nodes_recovers_from_a_broken_checkout(tmp_path):
    dest = tmp_path / "custom_nodes" / "ComfyUI-GGUF"
    dest.mkdir(parents=True)
    (dest / "garbage").write_text("partial")
    sibling = tmp_path / "custom_nodes" / "keep"
    sibling.mkdir()

    class BrokenRun(FakeRun):
        def __call__(self, cmd, **kwargs):
            if "rev-parse" in cmd and (dest / "garbage").exists():
                self.cmds.append(cmd)
                return subprocess.CompletedProcess(cmd, 128, "", "fatal: not a git repository")
            return super().__call__(cmd, **kwargs)

    run = BrokenRun(tmp_path)
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", pip_bin="pip", run=run)
    assert not (dest / "garbage").exists() and sibling.exists()
    assert any("clone" in c for c in run.cmds) and any("checkout" in c for c in run.cmds)
