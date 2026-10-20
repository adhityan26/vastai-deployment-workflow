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
    from_yaml = [{k: str(v) for k, v in m.items()} for m in yaml.safe_load(text)["models"]]
    assert net_probe._flow_models(text) == from_yaml
    assert len(from_yaml) == 5


def test_the_smallest_file_at_least_the_probe_range_is_chosen(tmp_path):
    url = net_probe.probe_url(PROFILES / "image.yaml", "https://huggingface.co/", 24 * MIB)
    assert url == ("https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged/resolve/"
                   "5fd49b7b278836f48af63ecd314d0f98ab336105/RealESRGAN_x4plus.safetensors")
    # Above the upscale model's 66.9 MB the LoRA (318.8 MB) is the smallest large enough.
    assert "Qwen2.1_Anything2RealCharacters.safetensors" in net_probe.probe_url(PROFILES / "image.yaml", "https://h.test", 100 * MIB)


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


def test_without_a_file_large_enough_the_largest_is_used_and_bad_entries_are_skipped(tmp_path):
    path = tmp_path / "p.yaml"
    path.write_text(PROFILE)
    assert net_probe.probe_url(path, "https://h.test", 100) == "https://h.test/org/two/resolve/r2/big.bin"
    assert net_probe.probe_url(path, "https://h.test", 5) == "https://h.test/org/one/resolve/r1/dir/a%20b.bin"


def test_the_flow_parser_is_the_fallback_without_pyyaml(tmp_path, monkeypatch):
    path = tmp_path / "p.yaml"
    path.write_text(PROFILE)
    monkeypatch.setitem(sys.modules, "yaml", None)  # import yaml now raises ImportError
    assert net_probe.probe_url(path, "https://h.test", 100) == "https://h.test/org/two/resolve/r2/big.bin"


def run(*args):
    return subprocess.run([sys.executable, "-I", str(MODULE), *args], capture_output=True, text=True, timeout=30)


def test_the_script_runs_standalone_in_isolated_mode():
    result = run("url", "--profile", str(PROFILES / "image.yaml"), "--base", "https://huggingface.co", "--min-bytes", str(24 * MIB))
    assert result.returncode == 0 and result.stdout.strip().endswith("/RealESRGAN_x4plus.safetensors")


@pytest.mark.parametrize("profile,base", [("missing.yaml", "https://huggingface.co"), ("image.yaml", "ftp://x"),
                                          ("image.yaml", "https://h.test/path?q")])
def test_any_doubt_exits_non_zero_without_output(profile, base):
    result = run("url", "--profile", str(PROFILES / profile), "--base", base, "--min-bytes", "1")
    assert result.returncode == 1 and result.stdout == ""


def test_a_profile_without_models_gives_no_url(tmp_path):
    path = tmp_path / "p.yaml"
    path.write_text("name: p\nmodels: []\n")
    assert net_probe.probe_url(path, "https://h.test", 1) is None
