import os

import pytest

from vastcomfy_agent import files
from vastcomfy_agent.paths import StatePaths


def test_atomic_write_creates_parents_and_replaces(tmp_path):
    target = tmp_path / "a" / "b.txt"
    files.atomic_write(target, "one")
    files.atomic_write(target, "two")
    assert target.read_text() == "two"
    assert [p.name for p in target.parent.iterdir()] == ["b.txt"]


def test_atomic_write_leaves_old_content_and_no_temp_on_failure(tmp_path, monkeypatch):
    target = tmp_path / "f"
    files.atomic_write(target, "old")

    def boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        files.atomic_write(target, "new")
    monkeypatch.undo()
    assert target.read_text() == "old"
    assert [p.name for p in tmp_path.iterdir()] == ["f"]


def test_read_int_handles_missing_and_corrupt(tmp_path):
    assert files.read_int(tmp_path / "missing") is None
    (tmp_path / "bad").write_text("12abc")
    assert files.read_int(tmp_path / "bad") is None
    files.write_int(tmp_path / "ok", 1700000000)
    assert files.read_int(tmp_path / "ok") == 1700000000


def test_read_json_default_on_missing_or_corrupt(tmp_path):
    assert files.read_json(tmp_path / "missing", {"x": 1}) == {"x": 1}
    (tmp_path / "bad.json").write_text("{not json")
    assert files.read_json(tmp_path / "bad.json") is None
    files.write_json(tmp_path / "ok.json", {"b": 1, "a": 2})
    assert files.read_json(tmp_path / "ok.json") == {"a": 2, "b": 1}


def test_state_paths_use_the_documented_file_names(tmp_path):
    p = StatePaths(tmp_path)
    assert p.state_json.name == "state.json"
    assert p.progress_json.name == "progress.json"
    assert p.first_boot_at.name == "first_boot_at"
    assert p.hard_cap.name == "hard_cap"
    assert p.deadline.name == "deadline"
    assert p.idle_destroy_at.name == "idle_destroy_at"
    assert p.failsafe_pid.name == "failsafe.pid"
    assert p.destroy_failsafe.name == "destroy_failsafe.json"
    assert p.destroy_agent.name == "destroy_agent.json"
    with pytest.raises(AttributeError):
        p.nope


def test_read_int_and_read_json_return_the_default_on_undecodable_or_unreadable_files(tmp_path):
    (tmp_path / "binary").write_bytes(b"\xff\xfe\x00garbage")
    (tmp_path / "a_dir").mkdir()
    for path in (tmp_path / "binary", tmp_path / "a_dir"):
        assert files.read_int(path) is None
        assert files.read_json(path, {"d": 1}) == {"d": 1}


@pytest.mark.skipif(os.geteuid() == 0, reason="chmod does not restrict root")
def test_read_helpers_return_the_default_on_permission_errors(tmp_path):
    target = tmp_path / "locked"
    target.write_text("12")
    target.chmod(0)
    try:
        assert files.read_int(target) is None
        assert files.read_json(target, "dflt") == "dflt"
    finally:
        target.chmod(0o644)
