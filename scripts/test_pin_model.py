import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import pin_model  # noqa: E402

SHA = "a" * 40
INFO = {"sha": SHA, "siblings": [{"rfilename": "x.safetensors", "size": 320}, {"rfilename": "y.bin"}]}


def test_prints_the_profile_line():
    assert pin_model.entry_line(INFO, "o/r", "x.safetensors", "models/loras/") == (
        f"  - {{file: x.safetensors, repo: o/r, revision: {SHA}, dest: models/loras/, size_bytes: 320}}"
    )


@pytest.mark.parametrize(
    "info,file",
    [({**INFO, "sha": "main"}, "x.safetensors"), (INFO, "missing.bin"), (INFO, "y.bin"), ({"sha": SHA}, "x.safetensors")],
)
def test_refuses_what_it_cannot_pin(info, file):
    with pytest.raises(ValueError):
        pin_model.entry_line(info, "o/r", file, "models/")


def test_rejects_a_repo_that_is_not_owner_name(capsys):
    assert pin_model.main(["p", "../etc", "f"]) == 2
