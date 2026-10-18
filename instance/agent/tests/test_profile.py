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


PY = "/venv/main/bin/python"  # COMFY_PYTHON: the ComfyUI venv interpreter


def node_profile():
    return Profile("p", 24, 40, (NodeSpec("city96/ComfyUI-GGUF", "abc123"),), (), ())


def test_install_nodes_clones_checks_out_the_pinned_commit_and_installs_requirements(tmp_path):
    run = FakeRun(tmp_path)
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", comfy_python=PY, run=run)
    dest = str(tmp_path / "custom_nodes" / "ComfyUI-GGUF")
    assert run.cmds[0] == ["git", "clone", "https://git.test/city96/ComfyUI-GGUF", dest]
    assert ["git", "-C", dest, "checkout", "--detach", "abc123"] in run.cmds
    assert [PY, "-m", "pip", "install", "-r", dest + "/requirements.txt"] in run.cmds


def test_install_nodes_skips_a_node_already_at_the_pinned_commit(tmp_path):
    (tmp_path / "custom_nodes" / "ComfyUI-GGUF").mkdir(parents=True)
    run = FakeRun(tmp_path, head="abc123")
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", comfy_python=PY, run=run)
    assert all("clone" not in c and "checkout" not in c for c in run.cmds)


def test_install_nodes_failure_raises_with_the_command_context(tmp_path):
    with pytest.raises(NodeInstallError, match="clone"):
        install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", comfy_python=PY,
                      run=FakeRun(tmp_path, fail_on="clone"))


def test_install_nodes_reruns_pip_when_a_previous_pip_install_failed(tmp_path):
    run = FakeRun(tmp_path, fail_on="pip")
    with pytest.raises(NodeInstallError, match="pip"):
        install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", comfy_python=PY, run=run)
    run.fail_on = None
    run.cmds.clear()
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", comfy_python=PY, run=run)
    dest = str(tmp_path / "custom_nodes" / "ComfyUI-GGUF")
    assert [PY, "-m", "pip", "install", "-r", dest + "/requirements.txt"] in run.cmds
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
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", comfy_python=PY, run=run)
    assert not (dest / "garbage").exists() and sibling.exists()
    assert any("clone" in c for c in run.cmds) and any("checkout" in c for c in run.cmds)


def test_the_shipped_image_profile_loads_and_its_workflow_exists():
    from pathlib import Path

    instance = Path(__file__).resolve().parents[2]
    profile = load_profile(instance / "profiles" / "image.yaml")
    assert profile.name == "image" and profile.requires_vram_gb == 24
    assert [m.dest for m in profile.models] == ["models/diffusion_models/", "models/text_encoders/", "models/vae/"]
    assert all(len(m.revision) == 40 for m in profile.models) and all(len(n.commit) == 40 for n in profile.nodes)
    for name in profile.workflows:
        assert (instance / "workflows" / name).is_file()


# --- generate section ---

import copy
import json
from pathlib import Path

import yaml

from vastcomfy_agent.profile import GenerateParams, GenerateSpec, ParamRef, QualityPreset, SizeSpec

REPO = Path(__file__).resolve().parents[3]
SHIPPED = REPO / "instance" / "profiles" / "image.yaml"

GENERATE = {
    "workflow": "flow.json",
    "params": {
        "prompt": {"node": "5", "input": "text"},
        "steps": {"node": "8", "input": "steps"},
        "width": {"node": "7", "input": "width"},
        "height": {"node": "7", "input": "height"},
        "seed": {"node": "8", "input": "seed"},
    },
    "quality_presets": {"fast": {"steps": 10}, "best": {"steps": 40}},
    "sizes": [{"name": "1:1", "width": 1024, "height": 1024}, {"name": "16:9", "width": 1344, "height": 768}],
}


def write_with_generate(tmp_path, generate):
    raw = yaml.safe_load(PROFILE_YAML)
    raw["generate"] = generate
    return write_profile(tmp_path, yaml.safe_dump(raw, sort_keys=False))


def test_generate_section_loads(tmp_path):
    profile = load_profile(write_with_generate(tmp_path, GENERATE))
    assert profile.generate == GenerateSpec(
        workflow="flow.json",
        params=GenerateParams(
            prompt=ParamRef("5", "text"), steps=ParamRef("8", "steps"), width=ParamRef("7", "width"),
            height=ParamRef("7", "height"), seed=ParamRef("8", "seed"),
        ),
        quality_presets=(QualityPreset("fast", 10), QualityPreset("best", 40)),
        sizes=(SizeSpec("1:1", 1024, 1024), SizeSpec("16:9", 1344, 768)),
    )


def test_profile_without_generate_has_none(tmp_path):
    assert load_profile(write_profile(tmp_path)).generate is None


def _mutate(fn):
    def apply(gen):
        fn(gen)
        return gen
    return apply


BAD_GENERATE = {
    "unknown_param": lambda g: g["params"].update(cfg={"node": "8", "input": "cfg"}),
    "missing_param": lambda g: g["params"].pop("seed"),
    "missing_node": lambda g: g["params"]["prompt"].pop("node"),
    "missing_input": lambda g: g["params"]["prompt"].pop("input"),
    "preset_without_steps": lambda g: g["quality_presets"].update(bad={}),
    "preset_zero_steps": lambda g: g["quality_presets"].update(bad={"steps": 0}),
    "empty_presets": lambda g: g.update(quality_presets={}),
    "empty_sizes": lambda g: g.update(sizes=[]),
    "width_not_32": lambda g: g["sizes"].append({"name": "x", "width": 1000, "height": 1024}),
    "height_not_32": lambda g: g["sizes"].append({"name": "x", "width": 1024, "height": 1000}),
    "duplicate_size": lambda g: g["sizes"].append({"name": "1:1", "width": 512, "height": 512}),
    "workflow_path": lambda g: g.update(workflow="../x.json"),
    "workflow_no_json": lambda g: g.update(workflow="flow.txt"),
}


@pytest.mark.parametrize("case", sorted(BAD_GENERATE))
def test_generate_rejects_bad_sizes_and_presets(tmp_path, case):
    generate = copy.deepcopy(GENERATE)
    BAD_GENERATE[case](generate)
    with pytest.raises(ProfileError):
        load_profile(write_with_generate(tmp_path, generate))


def test_shipped_profile_generate_matches_workflow_nodes():
    profile = load_profile(SHIPPED)
    assert profile.generate is not None
    assert profile.generate.workflow in profile.workflows
    workflow = json.loads((REPO / "instance" / "workflows" / profile.generate.workflow).read_text())
    for key in GenerateParams.__dataclass_fields__:
        ref = getattr(profile.generate.params, key)
        assert ref.node in workflow, f"{key}: node {ref.node} missing"
        assert ref.input in workflow[ref.node]["inputs"], f"{key}: input {ref.input} missing"


# --- node requirements go into the ComfyUI venv (first real boot: bare pip hit another environment) ---

def test_every_requirements_install_runs_the_comfyui_venv_python_never_a_bare_pip(tmp_path):
    run = FakeRun(tmp_path)
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", comfy_python=PY, run=run)
    run.cmds.clear()  # second boot: node already at the pinned commit, requirements are installed again
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", comfy_python=PY, run=run)
    dest = str(tmp_path / "custom_nodes" / "ComfyUI-GGUF")
    installs = [c for c in run.cmds if "install" in c]
    assert installs == [[PY, "-m", "pip", "install", "-r", dest + "/requirements.txt"]]
    assert not any(c[0] in ("pip", "pip3") for c in run.cmds)


def test_install_nodes_no_longer_accepts_a_pip_binary(tmp_path):
    with pytest.raises(TypeError):
        install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", pip_bin="pip",
                      run=FakeRun(tmp_path))


def test_pip_bin_is_gone_from_the_schema_and_comfy_python_is_the_image_venv():
    from vastcomfy_agent.config import load_schema

    specs = {s.name: s for s in load_schema()}
    assert "PIP_BIN" not in specs
    assert specs["COMFY_PYTHON"].default == "/venv/main/bin/python"


# --- provides_node_classes ---

def test_provides_node_classes_defaults_to_empty(tmp_path):
    assert load_profile(write_profile(tmp_path)).provides_node_classes == ()


def test_provides_node_classes_is_read_in_order(tmp_path):
    text = PROFILE_YAML + "provides_node_classes: [UnetLoaderGGUF, CLIPLoaderGGUF]\n"
    assert load_profile(write_profile(tmp_path, text)).provides_node_classes == ("UnetLoaderGGUF", "CLIPLoaderGGUF")


@pytest.mark.parametrize(
    "value",
    ["UnetLoaderGGUF", "{a: 1}", "['']", "[1]", "[null]", "['a/b']", "['../x']", "['x y']", "['1Abc']",
     "['_x']", "['a?b']", "['a%2Fb']", "[" + "A" * 129 + "]", "[A, A]"],
)
def test_invalid_provides_node_classes_are_rejected(tmp_path, value):
    with pytest.raises(ProfileError, match="provides_node_classes"):
        load_profile(write_profile(tmp_path, PROFILE_YAML + f"provides_node_classes: {value}\n"))


def test_the_shipped_image_profile_declares_the_gguf_loader_and_edit_classes():
    from pathlib import Path

    instance = Path(__file__).resolve().parents[2]
    profile = load_profile(instance / "profiles" / "image.yaml")
    # Boot fails closed unless these are registered: the edit workflow needs the two Qwen-Image 2.1 nodes (S6).
    assert profile.provides_node_classes == ("UnetLoaderGGUF", "TextEncodeQwenImage21", "QwenImage21Cache")
    assert profile.workflows == ("qwen-image-t2i.json", "qwen-image-edit.json", "image-upscale.json")


def test_the_styles_section_is_the_webs_business_and_a_style_lora_is_just_another_model(tmp_path):
    """The agent ignores `styles:`; a style's LoRA is downloaded because it is listed in `models`."""
    import yaml
    from pathlib import Path

    shipped = Path(__file__).resolve().parents[2] / "profiles" / "image.yaml"
    raw = yaml.safe_load(shipped.read_text())
    assert raw["styles"][0]["enabled"] is False  # off until the LoRA is pinned
    before = load_profile(shipped)
    assert all(m.dest != "models/loras/" for m in before.models)  # nothing to download for a disabled style

    raw["models"].append(
        {
            "file": raw["styles"][0]["lora"]["file"],
            "repo": "org/loras",
            "revision": "a" * 40,
            "dest": "models/loras/",
            "size_bytes": 1234,
        }
    )
    raw["styles"][0]["enabled"] = True
    path = tmp_path / "image.yaml"
    path.write_text(yaml.safe_dump(raw))
    after = load_profile(path)
    assert [m.file for m in after.models][-1] == "Qwen2.1_Anything2RealCharacters.safetensors"
    assert after.models[-1].dest == "models/loras/"
    assert len(after.models) == len(before.models) + 1


def test_the_upscale_section_is_the_webs_business_and_its_workflow_ships_with_the_profile(tmp_path):
    """The agent ignores `upscale:`; the model is downloaded because it is listed in `models`."""
    import json
    import yaml
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    raw = yaml.safe_load((root / "profiles" / "image.yaml").read_text())
    assert raw["upscale"]["enabled"] is False  # off until a licensed model is pinned
    assert "image-upscale.json" in raw["workflows"]
    graph = json.loads((root / "workflows" / "image-upscale.json").read_text())
    assert {n["class_type"] for n in graph.values()} >= {"LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "SaveImage"}
