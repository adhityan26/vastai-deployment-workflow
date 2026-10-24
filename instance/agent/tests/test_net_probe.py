import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from vastcomfy_agent import net_probe

PROFILES = Path(__file__).resolve().parents[2] / "profiles"
MODULE = Path(net_probe.__file__)
MIB = 1024 * 1024


def test_the_flow_parser_reads_the_shipped_profile_like_yaml():
    text = (PROFILES / "image.yaml").read_text()
    raw = yaml.safe_load(text)
    from_yaml = [{k: str(v) for k, v in m.items()} for m in raw["models"]]
    assert net_probe._flow_models(text) == from_yaml
    assert len(from_yaml) == 17  # five image files, three 5B video files, nine 14B video files
    families = {m["file"] for f in raw["video_families"] for m in f["models"]}
    assert net_probe._flow_video_files(text) == {m["file"] for m in raw["video"]["models"]} | families


def test_a_pinned_video_familys_files_are_left_out_with_and_without_pyyaml(tmp_path, monkeypatch):
    import builtins

    # The shipped profile pins the 14B family (2026-10-24); a re-dumped copy checks the parser on other formatting.
    raw = yaml.safe_load((PROFILES / "image.yaml").read_text())
    assert any("14B" in m["file"] for m in raw["models"])
    path = tmp_path / "image.yaml"
    path.write_text(yaml.safe_dump(raw, default_flow_style=None, width=1000))
    with_yaml = net_probe.read_models(path)
    real_import = builtins.__import__

    def no_yaml(name, *args, **kwargs):
        if name == "yaml":
            raise ImportError("no yaml")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_yaml)
    without_yaml = net_probe.read_models(path)
    for found in (with_yaml, without_yaml):
        assert len(found) == 5 and not any("14B" in m["file"] or "wan" in m["file"] for m in found)


def test_the_video_files_are_left_out_with_and_without_pyyaml(monkeypatch):
    """Optional downloads: the probe and the 'all present' check see only what every boot downloads."""
    import builtins

    with_yaml = net_probe.read_models(PROFILES / "image.yaml")
    real_import = builtins.__import__

    def no_yaml(name, *args, **kwargs):
        if name == "yaml":
            raise ImportError("no yaml")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_yaml)
    without_yaml = net_probe.read_models(PROFILES / "image.yaml")
    for found in (with_yaml, without_yaml):
        assert [m["file"].rsplit("/", 1)[-1] for m in found] == [
            "qwen-image-2.1-UC-Q4_K_M.gguf", "qwen3vl_8b_int8_convrot.safetensors", "qwen_image_2.1_vae_bf16.safetensors",
            "Qwen2.1_Anything2RealCharacters.safetensors", "RealESRGAN_x4plus.safetensors",
        ]


def test_all_present_ignores_the_video_files(tmp_path):
    for m in net_probe.read_models(PROFILES / "image.yaml"):
        target = tmp_path / m["dest"] / m["file"].rsplit("/", 1)[-1]
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as f:
            f.truncate(int(m["size_bytes"]))
    assert net_probe.all_present(PROFILES / "image.yaml", tmp_path)


def test_the_largest_pinned_file_is_probed_the_repo_and_cdn_path_of_the_big_downloads():
    url = net_probe.probe_url(PROFILES / "image.yaml", "https://huggingface.co/")
    assert url == ("https://huggingface.co/0xSojalSec/Qwen-Image-2.1-Uncensored-HF/resolve/"
                   "d94be5d7a09b47b0211b03d0f23d20bc18203358/text_encoders/qwen3vl_8b_int8_convrot.safetensors")


PROFILE = """
name: p
models:
  - {file: "dir/a b.bin", repo: org/one, revision: r1, dest: models/x/, size_bytes: 10}
  - {file: big.bin, repo: org/two, revision: r2, dest: models/x/, size_bytes: 30}
  - {file: ../escape.bin, repo: org/bad, revision: r3, dest: models/x/, size_bytes: 1000}
  - {file: c.bin, repo: "not a repo", revision: r4, dest: models/x/, size_bytes: 2000}
  - {file: d.bin, repo: org/three, revision: r5, dest: models/x/, size_bytes: 12x}
workflows: [x.json]
"""


def test_bad_entries_are_skipped(tmp_path):
    path = tmp_path / "p.yaml"
    path.write_text(PROFILE)
    assert net_probe.probe_url(path, "https://h.test") == "https://h.test/org/two/resolve/r2/big.bin"
    path.write_text(PROFILE.replace("size_bytes: 30", "size_bytes: 3"))
    assert net_probe.probe_url(path, "https://h.test") == "https://h.test/org/one/resolve/r1/dir/a%20b.bin"


def test_the_flow_parser_is_the_fallback_without_pyyaml(tmp_path, monkeypatch):
    path = tmp_path / "p.yaml"
    path.write_text(PROFILE)
    monkeypatch.setitem(sys.modules, "yaml", None)  # import yaml now raises ImportError
    assert net_probe.probe_url(path, "https://h.test") == "https://h.test/org/two/resolve/r2/big.bin"


def run(*args):
    return subprocess.run([sys.executable, "-I", str(MODULE), *args], capture_output=True, text=True, timeout=30)


def test_the_script_runs_standalone_in_isolated_mode():
    result = run("url", "--profile", str(PROFILES / "image.yaml"), "--base", "https://huggingface.co")
    assert result.returncode == 0 and result.stdout.strip().endswith("/qwen3vl_8b_int8_convrot.safetensors")


@pytest.mark.parametrize("profile,base", [("missing.yaml", "https://huggingface.co"), ("image.yaml", "ftp://x"),
                                          ("image.yaml", "https://h.test/path?q")])
def test_any_doubt_exits_non_zero_without_output(profile, base):
    result = run("url", "--profile", str(PROFILES / profile), "--base", base)
    assert result.returncode == 1 and result.stdout == ""


def test_a_profile_without_models_gives_no_url(tmp_path):
    path = tmp_path / "p.yaml"
    path.write_text("name: p\nmodels: []\n")
    assert net_probe.probe_url(path, "https://h.test") is None


def place(comfy, entries):
    for dest, name, size in entries:
        target = comfy / dest / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "wb") as handle:
            handle.truncate(size)


def test_present_says_yes_only_when_every_valid_pinned_file_has_its_size(tmp_path):
    path = tmp_path / "p.yaml"
    path.write_text(PROFILE)
    comfy = tmp_path / "comfy"
    args = ["present", "--profile", str(path), "--comfy-dir", str(comfy)]
    assert run(*args).returncode == 1
    place(comfy, [("models/x/", "a b.bin", 10)])
    assert run(*args).returncode == 1
    place(comfy, [("models/x/", "big.bin", 29)])
    assert run(*args).returncode == 1  # wrong size
    place(comfy, [("models/x/", "big.bin", 30)])
    assert run(*args).returncode == 0
    assert run("present", "--profile", str(tmp_path / "missing.yaml"), "--comfy-dir", str(comfy)).returncode == 1
