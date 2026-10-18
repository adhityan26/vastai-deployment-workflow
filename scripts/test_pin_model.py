import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parent))
import pin_model  # noqa: E402

SHA = "a" * 40
INFO = {"sha": SHA, "siblings": [{"rfilename": "x.safetensors", "size": 320}, {"rfilename": "y.bin"}]}


def test_prints_the_profile_line_quoted():
    line = pin_model.entry_line(INFO, "o/r", "x.safetensors", "models/loras/")
    assert line == f'  - {{file: "x.safetensors", repo: "o/r", revision: "{SHA}", dest: "models/loras/", size_bytes: 320}}'
    assert yaml.safe_load(line) == [{"file": "x.safetensors", "repo": "o/r", "revision": SHA, "dest": "models/loras/", "size_bytes": 320}]


def test_a_file_name_with_yaml_syntax_stays_one_string():
    info = {"sha": SHA, "siblings": [{"rfilename": "a: b, {c}#d.safetensors", "size": 5}]}
    parsed = yaml.safe_load(pin_model.entry_line(info, "o/r", "a: b, {c}#d.safetensors", "models/loras/"))
    assert parsed[0]["file"] == "a: b, {c}#d.safetensors"


@pytest.mark.parametrize(
    "info,file",
    [({**INFO, "sha": "main"}, "x.safetensors"), (INFO, "missing.bin"), (INFO, "y.bin"), ({"sha": SHA}, "x.safetensors")],
)
def test_refuses_what_it_cannot_pin(info, file):
    with pytest.raises(ValueError):
        pin_model.entry_line(info, "o/r", file, "models/loras/")


def test_rejects_a_repo_that_is_not_owner_name(capsys):
    assert pin_model.main(["p", "../etc", "f"]) == 2


@pytest.mark.parametrize(
    "file,dest",
    [
        ("a.gguf", "models/diffusion_models/"),
        ("a.safetensors", "models/loras/"),
        ("a.pth", "models/upscale_models/"),
        ("a.bin", None),
    ],
)
def test_default_dest_by_extension(file, dest):
    assert pin_model.default_dest(file) == dest


@pytest.mark.parametrize("dest", ["models/", "/models/loras/", "models/../x/", "models/loras", "loras/", "models/a b/", "models/x/y/"])
def test_refuses_a_dest_that_is_not_one_models_folder(dest, capsys):
    assert pin_model.main(["p", "o/r", "x.safetensors", dest]) == 2
    assert "dest" in capsys.readouterr().err


def test_needs_a_dest_when_the_extension_has_no_default(capsys):
    assert pin_model.main(["p", "o/r", "x.bin"]) == 2
