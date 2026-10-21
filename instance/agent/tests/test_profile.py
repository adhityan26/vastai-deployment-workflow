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
    assert [m.dest for m in profile.models] == [
        "models/diffusion_models/", "models/text_encoders/", "models/vae/", "models/loras/", "models/upscale_models/",
    ]
    # The boot disk check counts these; the style LoRA and the upscale model add about 0.39 GB to the 14.6 GB base.
    assert sum(m.size_bytes for m in profile.models) == 4604558112 + 9350798360 + 675509688 + 318820200 + 66857836
    assert sum(m.size_bytes for m in profile.models) < profile.requires_disk_gb * 1024**3 // 2
    assert all(len(m.revision) == 40 for m in profile.models) and all(len(n.commit) == 40 for n in profile.nodes)
    for name in profile.workflows:
        assert (instance / "workflows" / name).is_file()


# --- generate section ---

import copy
import json
from pathlib import Path, PurePosixPath

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
    "unknown_param": lambda g: g["params"].update(scheduler={"node": "8", "input": "scheduler"}),
    "optional_param_without_node": lambda g: g["params"].update(cfg={"input": "cfg"}),
    "optional_param_not_a_mapping": lambda g: g["params"].update(negative_prompt="6"),
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
    assert profile.workflows == ("qwen-image-t2i.json", "qwen-image-edit.json", "image-upscale.json", "video-ti2v.json")


def test_the_styles_section_is_the_webs_business_and_a_style_lora_is_just_another_model(tmp_path):
    """The agent ignores `styles:`; a style's LoRA is downloaded because it is listed in `models`."""
    import yaml
    from pathlib import Path

    shipped = Path(__file__).resolve().parents[2] / "profiles" / "image.yaml"
    raw = yaml.safe_load(shipped.read_text())
    lora = raw["styles"][0]["lora"]["file"]
    assert raw["styles"][0]["enabled"] is True  # on for the live test, its LoRA pinned below
    shipped_profile = load_profile(shipped)
    entry = next(m for m in shipped_profile.models if m.file == lora)
    assert entry.dest == "models/loras/"
    assert entry.repo == "WarmBloodAban/Qwen-Image-2.1-LoRAs"
    assert len(entry.revision) == 40 and entry.size_bytes == 318820200

    # Dropping the style's model entry is all it takes for the agent to download nothing for it.
    raw["models"] = [m for m in raw["models"] if m["file"] != lora]
    raw["styles"][0]["enabled"] = False
    path = tmp_path / "image.yaml"
    path.write_text(yaml.safe_dump(raw))
    without = load_profile(path)
    assert all(m.dest != "models/loras/" for m in without.models)
    assert len(without.models) == len(shipped_profile.models) - 1


def test_the_upscale_section_is_the_webs_business_and_its_workflow_ships_with_the_profile(tmp_path):
    """The agent ignores `upscale:`; the model is downloaded because it is listed in `models`."""
    import json
    import yaml
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    raw = yaml.safe_load((root / "profiles" / "image.yaml").read_text())
    assert raw["upscale"]["enabled"] is True  # on for the live test with a pinned, BSD-3-Clause model
    assert "image-upscale.json" in raw["workflows"]
    model = next(m for m in load_profile(root / "profiles" / "image.yaml").models if m.file == raw["upscale"]["model"])
    assert model.dest == "models/upscale_models/"
    assert model.repo == "Comfy-Org/Real-ESRGAN_repackaged" and model.size_bytes == 66857836
    graph = json.loads((root / "workflows" / "image-upscale.json").read_text())
    assert {n["class_type"] for n in graph.values()} >= {"LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "SaveImage"}


def _shipped_raw():
    import yaml
    from pathlib import Path

    shipped = Path(__file__).resolve().parents[2] / "profiles" / "image.yaml"
    return shipped, yaml.safe_load(shipped.read_text())


def test_the_face_swap_preset_ships_enabled_and_needs_no_model():
    shipped, raw = _shipped_raw()
    swap = next(s for s in raw["styles"] if s["id"] == "faceswap")
    assert swap["kind"] == "preset" and swap["enabled"] is True and swap["modes"] == ["edit"]
    assert "lora" not in swap
    assert swap["references"] == {"min": 2, "max": 2, "labels": ["Scene to keep", "Face to use"]}
    assert swap["prompt_template"].count("{prompt}") == 1
    profile = load_profile(shipped)
    # Nothing in models belongs to the preset: every models/loras entry is a lora style's file.
    lora_files = {s["lora"]["file"] for s in raw["styles"] if s.get("kind", "lora") == "lora"}
    assert {m.file for m in profile.models if m.dest == "models/loras/"} == lora_files


@pytest.mark.parametrize("change, message", [
    (lambda s: s.update(kind="magic"), "kind must be one of lora, preset"),
    (lambda s: s.update(lora={"file": "x.safetensors"}), "a preset has no lora"),
    (lambda s: s.update(references={"min": 3, "max": 2}), "1 <= min <= max <= 16"),
    (lambda s: s.update(references={"min": True, "max": 2}), "1 <= min <= max <= 16"),
    (lambda s: s.update(references={"min": 2, "max": 2, "labels": ["a", "b", "c"]}), "labels must be at most max"),
    (lambda s: s.update(references="two"), "references must be a mapping"),
])
def test_a_malformed_style_fails_the_profile(tmp_path, change, message):
    import yaml

    _, raw = _shipped_raw()
    change(next(s for s in raw["styles"] if s["id"] == "faceswap"))
    path = tmp_path / "image.yaml"
    path.write_text(yaml.safe_dump(raw))
    with pytest.raises(ProfileError, match=message):
        load_profile(path)


def test_a_lora_style_without_its_lora_section_fails_the_profile(tmp_path):
    import yaml

    _, raw = _shipped_raw()
    del raw["styles"][0]["lora"]
    path = tmp_path / "image.yaml"
    path.write_text(yaml.safe_dump(raw))
    with pytest.raises(ProfileError, match="a lora style needs a lora section"):
        load_profile(path)


def test_anime_to_real_is_a_lora_style_with_its_own_prompt_and_one_reference():
    shipped, raw = _shipped_raw()
    style = next(s for s in raw["styles"] if s["id"] == "anything2real")
    assert style["title"] == "Anime / cartoon to real" and style["modes"] == ["edit"] and style["enabled"] is True
    assert style.get("kind", "lora") == "lora" and style["lora"]["file"] == "Qwen2.1_Anything2RealCharacters.safetensors"
    assert style["references"] == {"min": 1, "max": 1, "labels": ["Image to convert"]}
    assert style["prompt_template"].count("{prompt}") == 1 and style["prompt_template"].endswith("realistic lighting. {prompt}")
    assert style["params"][0]["min"] == 0.0 and style["params"][0]["max"] == 1.0
    # Its LoRA is still pinned and downloaded at boot (strength 0 only leaves the loader out of the workflow).
    assert any(m.file == style["lora"]["file"] and m.dest == "models/loras/" for m in load_profile(shipped).models)


def test_the_optional_negative_prompt_and_cfg_params_are_accepted(tmp_path):
    """The web app maps them; the agent only checks their shape, so a profile that has them must still load."""
    generate = copy.deepcopy(GENERATE)
    generate["params"].update(negative_prompt={"node": "6", "input": "text"}, cfg={"node": "8", "input": "cfg"})
    profile = load_profile(write_with_generate(tmp_path, generate))
    assert profile.generate is not None
    assert not hasattr(profile.generate.params, "cfg")


def test_the_shipped_profile_has_one_preset_mechanism_and_its_samples_download_nothing():
    """Recipes were folded into styles: the samples are presets (on for the live test), so they add no model to
    the boot."""
    shipped, raw = _shipped_raw()
    assert "recipes" not in raw
    assert raw["guidance"] == {"min": 1.0, "max": 6.0, "step": 0.5, "default": 1.0}
    sample_ids = ["portrait_photo", "family_photo", "anime", "outfit_swap", "photo_restore", "to_anime"]
    samples = [s for s in raw["styles"] if s["id"] in sample_ids]
    assert [s["id"] for s in samples] == sample_ids
    assert all(s["enabled"] is True for s in samples)
    assert all(s["kind"] == "preset" and "lora" not in s for s in samples)
    profile = load_profile(shipped)
    assert profile.generate is not None
    # Nothing in models belongs to a sample: the boot downloads exactly the base model, the one LoRA and the
    # upscale model.
    assert [PurePosixPath(m.file).name for m in profile.models] == [
        "qwen-image-2.1-UC-Q4_K_M.gguf", "qwen3vl_8b_int8_convrot.safetensors", "qwen_image_2.1_vae_bf16.safetensors",
        "Qwen2.1_Anything2RealCharacters.safetensors", "RealESRGAN_x4plus.safetensors"]
    # Both workflows keep their own cfg 1.0, the guidance default (the web app checks this at startup too).
    root = shipped.parents[1]
    for name, node in (("qwen-image-t2i.json", "8"), ("qwen-image-edit.json", "7")):
        graph = json.loads((root / "workflows" / name).read_text())
        assert graph[node]["inputs"]["cfg"] == raw["guidance"]["default"]


# --- video section (the web app fills the workflow; the agent checks what decides downloads and the boot check) ---

def _video_raw():
    shipped, raw = _shipped_raw()
    return raw


VIDEO_PINS = [
    {"file": "split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors", "repo": "org/video", "revision": "a" * 40,
     "dest": "models/diffusion_models/", "size_bytes": 10},
    {"file": "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", "repo": "org/video", "revision": "a" * 40,
     "dest": "models/text_encoders/", "size_bytes": 10},
    {"file": "split_files/vae/wan2.2_vae.safetensors", "repo": "org/video", "revision": "a" * 40,
     "dest": "models/vae/", "size_bytes": 10},
]


def _write_raw(tmp_path, raw):
    import yaml

    path = tmp_path / "image.yaml"
    path.write_text(yaml.safe_dump(raw))
    return path


def test_the_shipped_video_section_is_off_and_adds_no_boot_requirement():
    """Off until the owner pins the model files: nothing is downloaded for it and boot checks no video node."""
    import json
    from pathlib import Path

    instance = Path(__file__).resolve().parents[2]
    raw = _video_raw()
    video = raw["video"]
    assert video["enabled"] is False
    assert video["workflow"] in raw["workflows"] and (instance / "workflows" / video["workflow"]).is_file()
    profile = load_profile(instance / "profiles" / "image.yaml")
    assert profile.video_enabled is False
    assert profile.provides_node_classes == ("UnetLoaderGGUF", "TextEncodeQwenImage21", "QwenImage21Cache")
    # Every node class of the shipped graph is one boot will require once video is on (native nodes only).
    graph = json.loads((instance / "workflows" / video["workflow"]).read_text())
    assert {n["class_type"] for n in graph.values()} | {"LoadImage"} == set(video["node_classes"])
    # The graph names exactly the model files the section lists.
    used = {v for n in graph.values() for v in n["inputs"].values() if isinstance(v, str)}
    assert {m["file"] for m in video["models"]} <= used


def test_enabled_video_requires_its_node_classes_at_boot(tmp_path):
    raw = _video_raw()
    raw["models"] += VIDEO_PINS
    raw["video"]["enabled"] = True
    profile = load_profile(_write_raw(tmp_path, raw))
    assert profile.video_enabled is True
    assert profile.provides_node_classes[:3] == ("UnetLoaderGGUF", "TextEncodeQwenImage21", "QwenImage21Cache")
    assert set(profile.provides_node_classes[3:]) == set(raw["video"]["node_classes"])
    assert "Wan22ImageToVideoLatent" in profile.provides_node_classes and "SaveVideo" in profile.provides_node_classes
    assert len(set(profile.provides_node_classes)) == len(profile.provides_node_classes)


def test_enabled_video_without_its_pinned_models_fails_loudly(tmp_path):
    raw = _video_raw()
    raw["video"]["enabled"] = True
    with pytest.raises(ProfileError, match="video model wan2.2_ti2v_5B_fp16.safetensors is not listed in models"):
        load_profile(_write_raw(tmp_path, raw))


def test_enabled_video_with_a_model_in_the_wrong_folder_fails(tmp_path):
    raw = _video_raw()
    pins = [dict(p) for p in VIDEO_PINS]
    pins[2]["dest"] = "models/loras/"
    raw["models"] += pins
    raw["video"]["enabled"] = True
    with pytest.raises(ProfileError, match="wan2.2_vae.safetensors must have dest models/vae/"):
        load_profile(_write_raw(tmp_path, raw))


@pytest.mark.parametrize("change, message", [
    (lambda v, r: v.update(enabled="yes"), "video enabled must be true or false"),
    (lambda v, r: v.update(workflow="../x.json"), "video workflow"),
    (lambda v, r: r.update(workflows=[w for w in r["workflows"] if w != v["workflow"]]), "video workflow .* is not listed in workflows"),
    (lambda v, r: v.update(models="x"), "video models must be a non-empty list"),
    (lambda v, r: v.update(models=[]), "video models must be a non-empty list"),
    (lambda v, r: v.update(models=[{"file": "../x.safetensors", "dest": "models/vae/"}]), "video model file"),
    (lambda v, r: v.update(models=[{"file": "x.safetensors", "dest": "/abs/"}]), "video model dest"),
    (lambda v, r: v.update(node_classes=["a/b"]), "invalid node class name"),
    (lambda v, r: v.update(node_classes="SaveVideo"), "video node_classes must be a list"),
])
def test_a_malformed_video_section_fails_the_profile_even_while_off(tmp_path, change, message):
    raw = _video_raw()
    change(raw["video"], raw)
    with pytest.raises(ProfileError, match=message):
        load_profile(_write_raw(tmp_path, raw))


def test_a_profile_without_a_video_section_still_loads(tmp_path):
    raw = _video_raw()
    del raw["video"]
    assert load_profile(_write_raw(tmp_path, raw)).video_enabled is False
