#!/usr/bin/env bash
# Onstart for the stock vastai/comfy image (spec 5.3 and 7.2, S1 decisions 4 and 5). The bot's --onstart-cmd
# clones the repository, checks out the pinned commit and runs this file. A custom --onstart-cmd replaces the
# image's own entrypoint.sh, so we start it ourselves (it brings up the image supervisord and ComfyUI), but only
# after ComfyUI-Manager is disabled. Then bootstrap.sh takes over. No schema-backed configuration exists yet,
# so this file reads plain environment variables with fallbacks.
# Failures never pass silently: before the entrypoint runs, they destroy the instance with the stock CLI
# (emergency_destroy, sourced from bootstrap.sh without running its boot) and exit non-zero.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMFY_DIR="${COMFY_DIR:-/workspace/ComfyUI}"  # config-lint: ok (before the schema can be read; schema default of COMFY_DIR)
STOCK_ENTRYPOINT="${STOCK_ENTRYPOINT:-entrypoint.sh}"  # config-lint: ok (before the schema can be read; the image entrypoint on PATH)
ENTRYPOINT_LOG="${ENTRYPOINT_LOG:-/var/log/vastcomfy-entrypoint.log}"  # config-lint: ok (before the schema can be read)

fail_closed() {
  echo "onstart: $1" >&2
  . "$HERE/bootstrap.sh"
  emergency_destroy "onstart_failed"
  exit 1
}

# Step 1: disable ComfyUI-Manager before the image supervisord starts ComfyUI (S1 decision 5). A restart finds
# it already disabled; a stale disabled copy is replaced so the rename never nests into it.
MANAGER="$COMFY_DIR/custom_nodes/ComfyUI-Manager"
if [ -e "$MANAGER" ] || [ -L "$MANAGER" ]; then
  if [ -e "$MANAGER.disabled" ] || [ -L "$MANAGER.disabled" ]; then
    rm -rf "$MANAGER.disabled" || fail_closed "could not remove the stale $MANAGER.disabled"
  fi
  mv "$MANAGER" "$MANAGER.disabled" || fail_closed "could not disable $MANAGER"
  if [ -e "$MANAGER" ] || [ -L "$MANAGER" ]; then
    fail_closed "$MANAGER is still present"
  fi
fi

# Step 2: the image entrypoint in the background (detached), its output appended to a log.
command -v "$STOCK_ENTRYPOINT" > /dev/null 2>&1 || fail_closed "image entrypoint $STOCK_ENTRYPOINT not found"
: >> "$ENTRYPOINT_LOG" || fail_closed "cannot write $ENTRYPOINT_LOG"
(nohup "$STOCK_ENTRYPOINT" >> "$ENTRYPOINT_LOG" 2>&1 < /dev/null &)

# Step 3: the boot. If the entrypoint did not bring supervisord up, bootstrap fails closed at supervisorctl.
exec bash "$HERE/bootstrap.sh"
