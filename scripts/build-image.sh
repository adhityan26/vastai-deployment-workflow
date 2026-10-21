#!/usr/bin/env bash
# Build (and, only with --push, push) the custom instance image instance/image/Dockerfile for the owner.
#
#   scripts/build-image.sh --owner <github-user-or-org> [--push]
#
# Every pin comes from the defaults in contracts/config-schema.yaml (VAST_IMAGE as the base, VENV_DIR,
# VASTAI_VERSION, TAILSCALE_VERSION, TAILSCALE_DIR, TAILSCALE_URL_BASE) and the agent dependency set from
# instance/agent/pyproject.toml, read with the same helper bootstrap.sh uses at boot. The tag is derived from
# those pins: <base image tag>-vastai<VASTAI_VERSION>-ts<TAILSCALE_VERSION>-deps<dependency hash>.
# The build context is instance/image only (nothing of the repository is copied into the image).
# Reads no secret and prints none: `docker login ghcr.io` is yours to run beforehand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$ROOT/contracts/config-schema.yaml"
PYPROJECT="$ROOT/instance/agent/pyproject.toml"
HELPER="$ROOT/instance/agent/vastcomfy_agent/image_marker.py"
CONTEXT="$ROOT/instance/image"
DOCKERFILE="$CONTEXT/Dockerfile"
REGISTRY=ghcr.io
NAME=vast-comfy

die() { echo "build-image: $*" >&2; exit 2; }
usage() { echo "usage: scripts/build-image.sh --owner <github-user-or-org> [--push]" >&2; }

owner=""
push=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --owner)
      [ "$#" -ge 2 ] || { usage; die "--owner needs a value"; }
      owner="$2"
      shift 2
      ;;
    --push) push=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
done

[ -n "$owner" ] || { usage; die "an owner is required (the GitHub user or organisation that owns the package)"; }
owner="$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')"
[[ "$owner" =~ ^[a-z0-9]([a-z0-9-]{0,38})$ ]] || die "not a GitHub user or organisation name: $owner"
command -v docker > /dev/null 2>&1 || die "docker not found on PATH"
command -v python3 > /dev/null 2>&1 || die "python3 not found on PATH"

default() { python3 -I "$HELPER" schema-default --schema "$SCHEMA" "$1"; }

base_image="$(default VAST_IMAGE)"
venv_dir="$(default VENV_DIR)"
vastai_version="$(default VASTAI_VERSION)"
tailscale_version="$(default TAILSCALE_VERSION)"
tailscale_dir="$(default TAILSCALE_DIR)"
tailscale_url_base="$(default TAILSCALE_URL_BASE)"
agent_deps="$(python3 -I "$HELPER" deps --pyproject "$PYPROJECT" | tr '\n' ' ')"
agent_deps="${agent_deps% }"
deps_hash="$(python3 -I "$HELPER" deps-hash --pyproject "$PYPROJECT")"

case "$base_image" in
  *@*) die "VAST_IMAGE default $base_image is pinned by digest; the tag rule needs a tag" ;;
  */*:*) base_tag="${base_image##*:}" ;;
  *) die "VAST_IMAGE default $base_image has no tag" ;;
esac

tag="${base_tag}-vastai${vastai_version}-ts${tailscale_version}-deps${deps_hash}"
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "derived tag is not a valid image tag: $tag"
image="$REGISTRY/$owner/$NAME:$tag"

echo "Building $image"
echo "  base $base_image, vastai $vastai_version, Tailscale $tailscale_version, agent dependencies $deps_hash"
# linux/amd64: Vast hosts are x86_64 (an Apple Silicon laptop would otherwise build arm64).
docker build --platform linux/amd64 -f "$DOCKERFILE" \
  --build-arg "BASE_IMAGE=$base_image" \
  --build-arg "VENV_DIR=$venv_dir" \
  --build-arg "VASTAI_VERSION=$vastai_version" \
  --build-arg "TAILSCALE_VERSION=$tailscale_version" \
  --build-arg "TAILSCALE_DIR=$tailscale_dir" \
  --build-arg "TAILSCALE_URL_BASE=$tailscale_url_base" \
  --build-arg "AGENT_DEPS=$agent_deps" \
  --build-arg "AGENT_DEPS_HASH=$deps_hash" \
  -t "$image" "$CONTEXT"

if [ "$push" = 1 ]; then
  docker push "$image"
  echo "Pushed $image"
else
  echo "Built $image; not pushed (run again with --push to push it)."
  echo "Before pushing: docker login $REGISTRY -u $owner  (paste a personal access token with write:packages at the prompt; never store it in this repository)"
fi
echo
echo "After the first push, make the package public on GitHub (Your profile > Packages > $NAME > Package settings >"
echo "Change visibility > Public) so Vast can pull it without credentials."
echo "Then put this line in .env and restart the web service (roll back by removing it):"
echo "VAST_IMAGE=$image"
