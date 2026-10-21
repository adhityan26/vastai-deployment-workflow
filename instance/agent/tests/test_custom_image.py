"""The custom instance image: instance/image/Dockerfile and scripts/build-image.sh.

Nothing here builds or runs an image (no Docker daemon in the test environment). The Dockerfile is checked
against the schema defaults it must agree with (drift), its marker program is run against a fake venv and fed
to the boot-side check, and build-image.sh runs with a stub `docker` on PATH."""
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from vastcomfy_agent import image_marker as im

AGENT = Path(__file__).resolve().parents[1]
INSTANCE = AGENT.parent
REPO = INSTANCE.parent
DOCKERFILE = INSTANCE / "image" / "Dockerfile"
BUILD = REPO / "scripts" / "build-image.sh"
SCHEMA = REPO / "contracts" / "config-schema.yaml"
BOOTSTRAP = INSTANCE / "bootstrap.sh"
PYPROJECT = AGENT / "pyproject.toml"
PINNED = {"BASE_IMAGE": "VAST_IMAGE", "VENV_DIR": "VENV_DIR", "VASTAI_VERSION": "VASTAI_VERSION",
          "TAILSCALE_VERSION": "TAILSCALE_VERSION", "TAILSCALE_DIR": "TAILSCALE_DIR",
          "TAILSCALE_URL_BASE": "TAILSCALE_URL_BASE"}


def schema_defaults():
    return {item["name"]: item["default"] for item in yaml.safe_load(SCHEMA.read_text())["keys"]}


def instructions(text):
    """(INSTRUCTION, arguments) per Dockerfile instruction, comments dropped and continuations joined."""
    joined, out = "", []
    for line in text.splitlines():
        if line.lstrip().startswith("#") or not line.strip():
            continue
        joined += line.rstrip()
        if joined.endswith("\\"):
            joined = joined[:-1] + " "
            continue
        word, _, rest = joined.strip().partition(" ")
        out.append((word.upper(), rest.strip()))
        joined = ""
    return out


def arg_defaults(text):
    found = {}
    for word, rest in instructions(text):
        if word == "ARG" and "=" in rest:
            name, value = rest.split("=", 1)
            found[name] = value.strip().strip('"')
    return found


def bootstrap_marker_path():
    line = next(l for l in BOOTSTRAP.read_text().splitlines() if l.startswith("IMAGE_MARKER="))
    return line.split("=", 1)[1].split()[0]


def drift_problems(text):
    """Everything that makes the Dockerfile disagree with the schema or the phase 1 scope."""
    problems = []
    steps = instructions(text)
    defaults = schema_defaults()
    args = arg_defaults(text)
    froms = [rest for word, rest in steps if word == "FROM"]
    resolved = [re.sub(r"\$\{?(\w+)\}?", lambda m: args.get(m.group(1), m.group(0)), f) for f in froms]
    if resolved != [defaults["VAST_IMAGE"]]:
        problems.append(f"FROM {resolved} is not the VAST_IMAGE default {defaults['VAST_IMAGE']}")
    for arg, key in PINNED.items():
        if args.get(arg) != str(defaults[key]):
            problems.append(f"ARG {arg}={args.get(arg)} is not the {key} default {defaults[key]}")
    if args.get("IMAGE_MARKER") != bootstrap_marker_path():
        problems.append("the marker path differs from bootstrap.sh IMAGE_MARKER")
    for word, rest in steps:
        if "/workspace" in rest:
            problems.append(f"{word} touches /workspace")
        if word in ("COPY", "ADD"):
            problems.append(f"{word} copies files into the image (the code comes from the checkout at boot)")
        if word in ("ENTRYPOINT", "CMD", "USER", "WORKDIR", "VOLUME", "SHELL"):
            problems.append(f"{word} changes how the base image runs")
        if word == "RUN" and re.search(r"\bgit\s+clone\b|custom_nodes|vastcomfy[-_]agent|-e\s", rest):
            problems.append("RUN installs the agent package or ComfyUI nodes (phase 1 bakes neither)")
    return problems


# --- drift ---------------------------------------------------------------------------------------------------

def test_the_dockerfile_agrees_with_the_schema_and_the_phase_1_scope():
    assert drift_problems(DOCKERFILE.read_text()) == []


@pytest.mark.parametrize("mutate", [
    lambda t: t.replace("v0.41.0-cuda-12.9-py312", "v0.42.0-cuda-12.9-py312"),
    lambda t: t.replace("ARG VASTAI_VERSION=1.8.3", "ARG VASTAI_VERSION=1.8.4"),
    lambda t: t.replace("ARG TAILSCALE_VERSION=", "ARG TAILSCALE_VERSION=0"),
    lambda t: t.replace("ARG VENV_DIR=/opt/vastcomfy-venv", "ARG VENV_DIR=/opt/other"),
    lambda t: t.replace("ARG TAILSCALE_DIR=/opt/tailscale", "ARG TAILSCALE_DIR=/usr/local/tailscale"),
    lambda t: t.replace("ARG IMAGE_MARKER=/opt/vastcomfy-image.json", "ARG IMAGE_MARKER=/opt/marker.json"),
    lambda t: t + "\nRUN mkdir -p /workspace/ComfyUI/custom_nodes\n",
    lambda t: t + "\nCOPY . /opt/vast-comfy\n",
    lambda t: t + "\nADD https://example.invalid/x.tgz /opt/x\n",
    lambda t: t + "\nENTRYPOINT [\"/bin/sh\"]\n",
    lambda t: t + "\nRUN git clone https://github.com/city96/ComfyUI-GGUF\n",
], ids=["from", "vastai", "tailscale", "venv", "tsdir", "marker", "workspace", "copy", "add", "entrypoint", "nodes"])
def test_the_drift_check_catches_each_kind_of_drift(mutate):
    text = DOCKERFILE.read_text()
    mutated = mutate(text)
    assert mutated != text
    assert drift_problems(mutated)


def test_the_dockerfile_bakes_the_dependencies_not_the_agent_and_verifies_the_tarball():
    runs = " ".join(rest for word, rest in instructions(DOCKERFILE.read_text()) if word == "RUN")
    assert '-m venv "$VENV_DIR"' in runs and "$AGENT_DEPS" in runs and '"vastai==$VASTAI_VERSION"' in runs
    assert "--no-cache-dir" in runs
    assert "sha256sum -c" in runs and "tailscale_${TAILSCALE_VERSION}_" in runs and "--strip-components=1" in runs
    assert "apt-get" not in runs  # the stock image already has what bootstrap uses (curl, tar, git, python3 venv)
    assert "rm -f" in runs  # the tarball does not stay in the layer
    # a plain `docker build` without the script fails instead of baking an empty dependency set
    assert '[ -n "$AGENT_DEPS" ]' in runs and '[ -n "$AGENT_DEPS_HASH" ]' in runs


def marker_program():
    run = next(rest for word, rest in instructions(DOCKERFILE.read_text()) if word == "RUN" and "$IMAGE_MARKER" in rest)
    words = shlex.split(run)
    start = words.index("-c")
    return words[start + 1], words[start + 2:]


def test_the_marker_the_image_writes_is_vouched_for_by_the_boot_check(tmp_path):
    """Run the Dockerfile's own marker program against a fake installed vastai, then ask the boot check."""
    program, argv = marker_program()
    site = tmp_path / "site"
    dist = site / "vastai-1.8.3.dist-info"
    dist.mkdir(parents=True)
    (dist / "METADATA").write_text("Metadata-Version: 2.1\nName: vastai\nVersion: 1.8.3\n")
    defaults = schema_defaults()
    deps = im.agent_deps(PYPROJECT.read_text())
    values = {"BASE_IMAGE": defaults["VAST_IMAGE"], "TAILSCALE_VERSION": defaults["TAILSCALE_VERSION"],
              "VENV_DIR": defaults["VENV_DIR"], "TAILSCALE_DIR": defaults["TAILSCALE_DIR"],
              "AGENT_DEPS_HASH": im.deps_hash(deps), "IMAGE_MARKER": str(tmp_path / "marker.json")}
    resolved = [re.sub(r"\$\{?(\w+)\}?", lambda m: values[m.group(1)], a) for a in argv]
    result = subprocess.run([sys.executable, "-c", program, *resolved], capture_output=True, text=True,
                            env={"PYTHONPATH": str(site)}, timeout=30)
    assert result.returncode == 0, result.stderr
    marker = tmp_path / "marker.json"
    data = json.loads(marker.read_text())
    assert data["schema"] == im.MARKER_SCHEMA and data["vastai_version"] == "1.8.3"
    assert data["base_image"] == defaults["VAST_IMAGE"]
    assert im.check_runtime(marker, vastai_version=defaults["VASTAI_VERSION"], venv_dir=defaults["VENV_DIR"],
                            pyproject=PYPROJECT)[0] == im.EXIT_MATCH
    assert im.check_tailscale(marker, tailscale_version=defaults["TAILSCALE_VERSION"],
                              tailscale_dir=defaults["TAILSCALE_DIR"])[0] == im.EXIT_MATCH


def test_the_schema_default_image_is_still_the_stock_image():
    assert schema_defaults()["VAST_IMAGE"] == "vastai/comfy:v0.41.0-cuda-12.9-py312"


# --- scripts/build-image.sh with a stub docker ----------------------------------------------------------------

SECRETS = {"VAST_API_KEY": "vast-secret-123", "GH_TOKEN": "ghp_secretsecretsecret", "CR_PAT": "cr-pat-secret",
           "GITHUB_TOKEN": "gh-token-secret", "TS_OAUTH_CLIENT_SECRET": "ts-secret"}


def expected_tag():
    defaults = schema_defaults()
    digest = im.deps_hash(im.agent_deps(PYPROJECT.read_text()))
    return (f"{defaults['VAST_IMAGE'].split(':', 1)[1]}-vastai{defaults['VASTAI_VERSION']}"
            f"-ts{defaults['TAILSCALE_VERSION']}-deps{digest}")


def build(tmp_path, *args, docker_rc=0, with_docker=True):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    log = tmp_path / "docker.log"
    if with_docker:
        stub = bindir / "docker"
        stub.write_text('#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done >> "$DOCKER_LOG"\n'
                        'echo "--" >> "$DOCKER_LOG"\n'
                        f'[ "$1" = build ] && exit {docker_rc}\nexit 0\n')
        stub.chmod(0o755)
    env = {"PATH": f"{bindir}:/usr/bin:/bin", "HOME": str(tmp_path), "DOCKER_LOG": str(log), **SECRETS}
    result = subprocess.run(["bash", str(BUILD), *args], capture_output=True, text=True, env=env, timeout=60,
                            cwd=tmp_path)
    calls = []
    if log.exists():
        current = []
        for line in log.read_text().splitlines():
            if line == "--":
                calls.append(current)
                current = []
            else:
                current.append(line)
    return result, calls


def test_build_script_has_valid_syntax_and_strict_mode():
    assert subprocess.run(["bash", "-n", str(BUILD)], capture_output=True).returncode == 0
    assert "set -euo pipefail" in BUILD.read_text()


def test_build_reads_every_pin_from_the_schema_and_tags_by_the_pins(tmp_path):
    result, calls = build(tmp_path, "--owner", "Some-Owner")
    assert result.returncode == 0, result.stderr
    assert len(calls) == 1 and calls[0][0] == "build"
    call = calls[0]
    defaults = schema_defaults()
    build_args = dict(call[i + 1].split("=", 1) for i, a in enumerate(call) if a == "--build-arg")
    for arg, key in PINNED.items():
        assert build_args[arg] == str(defaults[key])
    deps = im.agent_deps(PYPROJECT.read_text())
    assert build_args["AGENT_DEPS"].split() == deps and build_args["AGENT_DEPS_HASH"] == im.deps_hash(deps)
    image = f"ghcr.io/some-owner/vast-comfy:{expected_tag()}"
    assert call[call.index("-t") + 1] == image
    assert call[call.index("--platform") + 1] == "linux/amd64"
    assert call[call.index("-f") + 1] == str(DOCKERFILE) and call[-1] == str(DOCKERFILE.parent)
    assert f"VAST_IMAGE={image}" in result.stdout.splitlines()
    assert "docker login ghcr.io" in result.stdout and "public" in result.stdout
    assert re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", expected_tag())


def test_build_never_pushes_unless_asked(tmp_path):
    result, calls = build(tmp_path, "--owner", "me")
    assert result.returncode == 0 and [c[0] for c in calls] == ["build"]
    assert "not pushed" in result.stdout.lower()


def test_push_only_with_push(tmp_path):
    result, calls = build(tmp_path, "--owner", "me", "--push")
    assert result.returncode == 0, result.stderr
    assert [c[0] for c in calls] == ["build", "push"]
    assert calls[1] == ["push", f"ghcr.io/me/vast-comfy:{expected_tag()}"]


def test_a_failed_build_is_never_pushed(tmp_path):
    result, calls = build(tmp_path, "--owner", "me", "--push", docker_rc=1)
    assert result.returncode != 0 and [c[0] for c in calls] == ["build"]
    assert "VAST_IMAGE=" not in result.stdout


@pytest.mark.parametrize("args", [[], ["--push"], ["--owner"], ["--owner", ""], ["--owner", "bad/owner"],
                                  ["--owner", "-x"], ["--owner", "me", "--frobnicate"]])
def test_build_refuses_without_a_valid_owner_or_with_unknown_arguments(tmp_path, args):
    result, calls = build(tmp_path, *args)
    assert result.returncode != 0 and calls == []
    assert result.stderr.strip()


def test_build_without_docker_says_so(tmp_path):
    result, calls = build(tmp_path, "--owner", "me", with_docker=False)
    assert result.returncode != 0 and "docker" in result.stderr


@pytest.mark.parametrize("args", [["--owner", "me"], ["--owner", "me", "--push"]])
def test_build_never_reads_or_prints_a_secret(tmp_path, args):
    result, calls = build(tmp_path, *args)
    seen = result.stdout + result.stderr + json.dumps(calls)
    for value in SECRETS.values():
        assert value not in seen
    text = BUILD.read_text()
    assert not re.search(r"(?:cat|<|source|\.)\s+\S*\.env\b", text)  # never reads .env
    assert not re.search(r"^\s*(\.|source)\s", text, re.M)  # sources nothing
    assert "--password" not in text and "login" not in [w for c in calls for w in c]
