# Custom instance image, phase 1: the stock image plus what bootstrap.sh would otherwise install at every boot.
# Build it with scripts/build-image.sh (it passes every pin below from contracts/config-schema.yaml and tags the
# image by them); a plain `docker build` without AGENT_DEPS fails on purpose. Public image, no secrets inside.
#
# Bakes ONLY things outside /workspace (the base image may overlay /workspace at runtime):
#   - the agent venv at VENV_DIR with the agent's third-party dependencies and build requirements and the pinned
#     vastai CLI, but NOT the agent package: its code comes from the repository checkout at REPO_COMMIT at boot;
#   - the pinned Tailscale static tarball, extracted into TAILSCALE_DIR (checksum verified);
#   - a marker (IMAGE_MARKER) recording what was baked; bootstrap.sh skips an install only when the marker
#     names exactly the configured versions and the files are there.
# Not baked: ComfyUI custom nodes (phase 2, once ComfyUI's place inside the image is verified), model files,
# the repository, any apt package (bootstrap needs nothing the stock image lacks). Entrypoint, command, user
# and working directory stay the base image's.
#
# The ARG defaults equal the schema defaults (a test keeps them equal; the build script overrides them all).
# BASE_IMAGE is the schema default VAST_IMAGE, so a host that already caches the stock image pulls only these
# few small layers.
ARG BASE_IMAGE=vastai/comfy:v0.41.0-cuda-12.9-py312
FROM ${BASE_IMAGE}

ARG BASE_IMAGE
ARG VENV_DIR=/opt/vastcomfy-venv
ARG VASTAI_VERSION=1.8.3
ARG TAILSCALE_VERSION=1.104.1
ARG TAILSCALE_DIR=/opt/tailscale
ARG TAILSCALE_URL_BASE=https://pkgs.tailscale.com/stable
ARG IMAGE_MARKER=/opt/vastcomfy-image.json
ARG AGENT_DEPS
ARG AGENT_DEPS_HASH

# Layer 1: the agent venv (the same `python3 -m venv` bootstrap runs), dependencies only. AGENT_DEPS is a
# space-separated list of requirement specifiers (no shell metacharacters; image_marker.py validates them).
RUN set -eu; \
    [ -n "$AGENT_DEPS" ] || { echo "AGENT_DEPS is empty: build with scripts/build-image.sh" >&2; exit 1; }; \
    [ -n "$AGENT_DEPS_HASH" ] || { echo "AGENT_DEPS_HASH is empty: build with scripts/build-image.sh" >&2; exit 1; }; \
    python3 -m venv "$VENV_DIR"; \
    "$VENV_DIR/bin/python" -m pip install --no-cache-dir -q $AGENT_DEPS "vastai==$VASTAI_VERSION"; \
    test -x "$VENV_DIR/bin/vastai"

# Layer 2: Tailscale, the pinned static tarball (the same file bootstrap downloads), checksum verified.
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) arch=amd64 ;; \
      aarch64|arm64) arch=arm64 ;; \
      *) echo "unsupported architecture for Tailscale: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    url="$TAILSCALE_URL_BASE/tailscale_${TAILSCALE_VERSION}_${arch}.tgz"; \
    curl -fsSL -o /tmp/tailscale.tgz "$url"; \
    curl -fsSL -o /tmp/tailscale.tgz.sha256 "$url.sha256"; \
    echo "$(awk '{print $1}' /tmp/tailscale.tgz.sha256)  /tmp/tailscale.tgz" | sha256sum -c -; \
    mkdir -p "$TAILSCALE_DIR"; \
    tar -xzf /tmp/tailscale.tgz -C "$TAILSCALE_DIR" --strip-components=1; \
    rm -f /tmp/tailscale.tgz /tmp/tailscale.tgz.sha256; \
    test -x "$TAILSCALE_DIR/tailscale"; \
    test -x "$TAILSCALE_DIR/tailscaled"

# Layer 3: the marker. The vastai version is read from what pip really installed.
RUN "$VENV_DIR/bin/python" -c 'import json, sys; from importlib.metadata import version; path, base, ts_version, venv, ts_dir, deps = sys.argv[1:]; data = {"schema": 1, "base_image": base, "vastai_version": version("vastai"), "tailscale_version": ts_version, "venv_dir": venv, "tailscale_dir": ts_dir, "agent_deps_hash": deps}; open(path, "w").write(json.dumps(data, sort_keys=True) + "\n")' "$IMAGE_MARKER" "$BASE_IMAGE" "$TAILSCALE_VERSION" "$VENV_DIR" "$TAILSCALE_DIR" "$AGENT_DEPS_HASH"
