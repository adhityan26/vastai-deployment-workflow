import pytest

from vastcomfy_agent.workflows import WorkflowError, WorkflowStore


def test_write_read_list_overwrite(tmp_path):
    store = WorkflowStore(tmp_path / "wf", max_bytes=100)
    assert store.list() == []
    assert store.write("a.json", b'{"x": 1}') == 8
    store.write("a.json", b'{"x": 2}')
    assert store.read("a.json") == {"x": 2}
    assert [item["name"] for item in store.list()] == ["a.json"]
    assert isinstance(store.list()[0]["modified_at"], int)


@pytest.mark.parametrize(
    "name",
    ["../evil.json", "a/b.json", "/abs.json", "noext", "x.txt", ".hidden.json", "", "nul\x00.json",
     "café.json", "a" * 200 + ".json", "..", "a\\b.json"],
)
def test_invalid_names_are_rejected_for_every_operation(tmp_path, name):
    store = WorkflowStore(tmp_path, max_bytes=100)
    for call in (lambda: store.read(name), lambda: store.write(name, b"{}")):
        with pytest.raises(WorkflowError) as err:
            call()
        assert err.value.status == 400
    assert list(tmp_path.iterdir()) == []


def test_oversize_and_invalid_json_are_rejected_without_touching_the_existing_file(tmp_path):
    store = WorkflowStore(tmp_path, max_bytes=20)
    store.write("a.json", b'{"ok": true}')
    with pytest.raises(WorkflowError) as err:
        store.write("a.json", b'{"padding": "' + b"x" * 50 + b'"}')
    assert err.value.status == 413
    with pytest.raises(WorkflowError) as err:
        store.write("a.json", b"{not json")
    assert err.value.status == 422
    with pytest.raises(WorkflowError) as err:
        store.write("a.json", b"\xff\xfe")
    assert err.value.status == 422
    assert store.read("a.json") == {"ok": True}


def test_read_missing_is_404(tmp_path):
    with pytest.raises(WorkflowError) as err:
        WorkflowStore(tmp_path, 100).read("nope.json")
    assert err.value.status == 404
