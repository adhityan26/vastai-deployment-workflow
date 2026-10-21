"""The custom-image marker helper (instance/agent/vastcomfy_agent/image_marker.py).

The helper decides, at boot and before the agent venv exists, whether the image baked exactly what the
configuration asks for; build-image.sh uses the same helper for the schema defaults and the dependency set,
so the image, its tag and the boot check agree by construction."""
import json
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from vastcomfy_agent import image_marker as im

AGENT = Path(__file__).resolve().parents[1]
REPO = AGENT.parents[1]
SCHEMA = REPO / "contracts" / "config-schema.yaml"
PYPROJECT = AGENT / "pyproject.toml"
MODULE = Path(im.__file__)


def schema_defaults():
    return {item["name"]: item["default"] for item in yaml.safe_load(SCHEMA.read_text())["keys"]}


# --- schema defaults and the dependency set ---------------------------------------------------------------

@pytest.mark.parametrize("name", ["VAST_IMAGE", "VENV_DIR", "VASTAI_VERSION", "TAILSCALE_VERSION", "TAILSCALE_DIR",
                                  "TAILSCALE_URL_BASE", "AGENT_PORT", "TS_TAG"])
def test_schema_default_reads_the_schema_like_yaml(name):
    assert im.schema_default(SCHEMA.read_text(), name) == str(schema_defaults()[name])


def test_schema_default_of_an_unknown_or_null_key_is_an_error():
    with pytest.raises(im.MarkerError):
        im.schema_default(SCHEMA.read_text(), "NO_SUCH_KEY")
    with pytest.raises(im.MarkerError):
        im.schema_default(SCHEMA.read_text(), "CONTAINER_ID")  # default: null


def test_agent_deps_are_the_build_requirements_and_the_project_dependencies_like_tomllib():
    tomllib = pytest.importorskip("tomllib")  # Python 3.11+; the helper itself never needs it
    data = tomllib.loads(PYPROJECT.read_text())
    expected = sorted(set(data["build-system"]["requires"]) | set(data["project"]["dependencies"]))
    assert im.agent_deps(PYPROJECT.read_text()) == expected
    assert "vastcomfy-agent" not in " ".join(expected)  # never the agent package itself


def test_agent_deps_ignore_the_optional_dev_dependencies():
    assert not any(dep.startswith("pytest") for dep in im.agent_deps(PYPROJECT.read_text()))


@pytest.mark.parametrize("text", ["", "[project]\nname = 'x'\n", "[project]\ndependencies = [\n  \"ok>=1\",\n  \"bad;rm -rf /\",\n]\n"])
def test_an_unreadable_dependency_list_is_an_error(text):
    with pytest.raises(im.MarkerError):
        im.agent_deps(text)


def test_the_deps_hash_is_short_stable_and_order_independent():
    first = im.deps_hash(["b>=1", "a>=2"])
    assert first == im.deps_hash(["a>=2", "b>=1"]) and len(first) == 12 and int(first, 16) >= 0
    assert first != im.deps_hash(["a>=2", "b>=1", "c"])


# --- the marker -------------------------------------------------------------------------------------------

def marker(**overrides):
    deps = im.agent_deps(PYPROJECT.read_text())
    values = {"schema": 1, "base_image": "vastai/comfy:tag", "vastai_version": "1.8.3", "tailscale_version": "1.104.1",
              "venv_dir": "/opt/vastcomfy-venv", "tailscale_dir": "/opt/tailscale", "agent_deps_hash": im.deps_hash(deps)}
    values.update(overrides)
    return {k: v for k, v in values.items() if v is not None}


def write_marker(tmp_path, data):
    path = tmp_path / "image.json"
    path.write_text(data if isinstance(data, str) else json.dumps(data))
    return path


def runtime(tmp_path, data, version="1.8.3", venv="/opt/vastcomfy-venv"):
    path = tmp_path / "missing.json" if data is None else write_marker(tmp_path, data)
    return im.check_runtime(path, vastai_version=version, venv_dir=venv, pyproject=PYPROJECT)


def tailscale(tmp_path, data, version="1.104.1", directory="/opt/tailscale"):
    path = tmp_path / "missing.json" if data is None else write_marker(tmp_path, data)
    return im.check_tailscale(path, tailscale_version=version, tailscale_dir=directory)


def test_a_matching_marker_vouches_for_the_runtime_and_tailscale(tmp_path):
    code, reason = runtime(tmp_path, marker())
    assert code == im.EXIT_MATCH and "1.8.3" in reason
    code, reason = tailscale(tmp_path, marker())
    assert code == im.EXIT_MATCH and "1.104.1" in reason


@pytest.mark.parametrize("data,code", [
    (None, im.EXIT_MISSING),
    ("{not json", im.EXIT_CORRUPT),
    ("[1, 2]", im.EXIT_CORRUPT),
    (json.dumps(marker(schema=2)), im.EXIT_CORRUPT),
    (json.dumps(marker(schema="1")), im.EXIT_CORRUPT),
    (json.dumps(marker(vastai_version=None)), im.EXIT_CORRUPT),
    (json.dumps(marker(vastai_version="1.8.3; rm -rf /")), im.EXIT_CORRUPT),
    (json.dumps(marker(vastai_version="1.8.2")), im.EXIT_STALE),
    (json.dumps(marker(agent_deps_hash="0123456789ab")), im.EXIT_STALE),
    (json.dumps(marker(venv_dir="/elsewhere")), im.EXIT_ELSEWHERE),
])
def test_the_runtime_decision_matrix(tmp_path, data, code):
    got, reason = runtime(tmp_path, data)
    assert got == code and reason


@pytest.mark.parametrize("data,code", [
    (None, im.EXIT_MISSING),
    ("", im.EXIT_CORRUPT),
    (json.dumps(marker(tailscale_dir=None)), im.EXIT_CORRUPT),
    (json.dumps(marker(tailscale_version="1.100.0")), im.EXIT_STALE),
    (json.dumps(marker(tailscale_dir="/elsewhere")), im.EXIT_ELSEWHERE),
])
def test_the_tailscale_decision_matrix(tmp_path, data, code):
    got, reason = tailscale(tmp_path, data)
    assert got == code and reason


def test_a_configured_version_other_than_the_baked_one_is_stale(tmp_path):
    assert runtime(tmp_path, marker(), version="1.9.0")[0] == im.EXIT_STALE
    assert tailscale(tmp_path, marker(), version="1.106.0")[0] == im.EXIT_STALE


def test_changed_agent_dependencies_are_stale_and_named(tmp_path):
    code, reason = runtime(tmp_path, marker(agent_deps_hash="0123456789ab"))
    assert code == im.EXIT_STALE and "dependencies" in reason


def test_an_unreadable_pyproject_never_vouches(tmp_path):
    path = write_marker(tmp_path, marker())
    bad = tmp_path / "pyproject.toml"
    bad.write_text("garbage")
    code, _ = im.check_runtime(path, vastai_version="1.8.3", venv_dir="/opt/vastcomfy-venv", pyproject=bad)
    assert code != im.EXIT_MATCH


def test_a_marker_that_is_a_directory_is_corrupt_not_a_crash(tmp_path):
    (tmp_path / "image.json").mkdir()
    code, _ = im.check_runtime(tmp_path / "image.json", vastai_version="1.8.3", venv_dir="/opt/vastcomfy-venv",
                               pyproject=PYPROJECT)
    assert code == im.EXIT_CORRUPT


# --- the command line (run as bootstrap runs it: python3 -I, standard library only) ------------------------

def cli(*args):
    return subprocess.run([sys.executable, "-I", str(MODULE), *map(str, args)], capture_output=True, text=True,
                          timeout=30)


def test_cli_check_prints_the_reason_and_exits_with_the_decision(tmp_path):
    path = write_marker(tmp_path, marker())
    ok = cli("check", "runtime", "--marker", path, "--vastai-version", "1.8.3", "--venv-dir", "/opt/vastcomfy-venv",
             "--pyproject", PYPROJECT)
    assert ok.returncode == 0 and ok.stdout.strip() and "\n" not in ok.stdout.strip()
    stale = cli("check", "tailscale", "--marker", path, "--tailscale-version", "1.0.0", "--tailscale-dir",
                "/opt/tailscale")
    assert stale.returncode == im.EXIT_STALE and "1.0.0" in stale.stdout
    missing = cli("check", "tailscale", "--marker", tmp_path / "nope", "--tailscale-version", "1", "--tailscale-dir", "/x")
    assert missing.returncode == im.EXIT_MISSING


def test_cli_deps_hash_and_schema_default(tmp_path):
    deps = cli("deps", "--pyproject", PYPROJECT)
    assert deps.returncode == 0 and deps.stdout.split() == im.agent_deps(PYPROJECT.read_text())
    digest = cli("deps-hash", "--pyproject", PYPROJECT)
    assert digest.stdout.strip() == im.deps_hash(im.agent_deps(PYPROJECT.read_text()))
    default = cli("schema-default", "--schema", SCHEMA, "VAST_IMAGE")
    assert default.returncode == 0 and default.stdout.strip() == schema_defaults()["VAST_IMAGE"]
    assert cli("schema-default", "--schema", SCHEMA, "NOPE").returncode != 0


def test_the_helper_uses_the_standard_library_only():
    text = MODULE.read_text()
    for banned in ("import yaml", "from vastcomfy_agent", "import pydantic", "import tomllib"):
        assert banned not in text
