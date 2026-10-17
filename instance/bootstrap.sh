#!/usr/bin/env bash
# Boot sequence for a fresh instance (spec 5.3). Safety nets come first.
# Started by instance/onstart.sh (exec), after it disabled ComfyUI-Manager and launched the image entrypoint,
# whose supervisord (the image's own, S1) already runs ComfyUI; we never start a second supervisord.
# Testing: sourcing this file only defines the functions above the guard and returns, so tests can run
# emergency_destroy and install_runtime with fake binaries on PATH; executing it runs the boot.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${VENV_DIR:-/opt/vastcomfy-venv}"  # config-lint: ok (needed before the schema can be read; schema default of VENV_DIR)
PY="$VENV_DIR/bin/python"
VASTAI_FALLBACK=0
BOOT_DONE=0
HANDLED=0

# Last resort while no configuration exists (or it cannot be repaired): destroy with the image's own CLI
# found on PATH and the credentials Vast put in the environment. The stock CLI does not know -y (S1).
# Always exits non-zero, whether or not the destroy worked; the CLI output is printed with the key removed.
emergency_destroy() {
  local cli out
  HANDLED=1
  echo "bootstrap: $1; emergency destroy with the image vastai CLI" >&2
  cli="$(command -v vastai)" || cli=""
  if [ -z "$cli" ] || [ -z "${CONTAINER_ID:-}" ] || [ -z "${CONTAINER_API_KEY:-}" ]; then
    echo "bootstrap: emergency destroy impossible: vastai CLI or container credentials missing" >&2
    exit 1
  fi
  out="$("$cli" destroy instance "$CONTAINER_ID" --api-key "$CONTAINER_API_KEY" < /dev/null 2>&1)"
  printf 'bootstrap: vastai: %s\n' "${out//"$CONTAINER_API_KEY"/<key>}" >&2
  exit 1
}

# Our own venv (the image venv /venv/main belongs to ComfyUI). Editable install: the agent reads
# contracts/config-schema.yaml from this repository checkout.
install_agent() {
  python3 -m venv "$VENV_DIR" && "$PY" -m pip install -q -e "$HERE/agent"
}

# The new CLI destroys with -y; the stock one cannot (S1 decision 7).
install_pinned_vastai() {
  "$PY" -m pip install -q "vastai==${VASTAI_VERSION:-1.8.3}"  # config-lint: ok (needed before the schema can be read; schema default of VASTAI_VERSION)
}

install_runtime() {
  install_agent || emergency_destroy agent_install_failed
  install_pinned_vastai || { echo "bootstrap: installing the pinned vastai failed; falling back to the stock CLI" >&2; VASTAI_FALLBACK=1; }
}

boot() { "$PY" -m vastcomfy_agent.boot "$@"; }

# Until failsafe.sh runs, a boot step that failed without destroying leaves the GPU running, and the configured
# destroy path may not work yet; only the stock CLI (emergency_destroy) is left. Boot CLI exit codes:
# 10 = CONTAINER_ID/CONTAINER_API_KEY missing (nothing to destroy with: plain exit; the watchdog covers it),
# 11/12 = already handled (boot fail ran its own destroy), 13 = config invalid (no valid config object, so no
# self-destroy happened), anything else = a crash that nothing handled.
write_env_failed() {
  [ "$1" -eq 10 ] && exit 10
  emergency_destroy "write_env_failed (exit $1)"
}

pre_failsafe_failed() {
  case "$1" in
    11|12) exit "$1" ;;
    *) emergency_destroy "$2 (exit $1)" ;;
  esac
}

[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

# Step 0: agent venv and the pinned vastai CLI. No configuration exists yet.
install_runtime

# Step 1: credentials. Writes the instance .env from the environment (schema keys only).
ENV_FILE="$(boot write-env)" || write_env_failed $?

# Fail closed: credentials exist from here on, so any non-zero exit before BOOT_DONE that no boot command or
# die_with already handled (a boot command returns 11, 12 or 13 after handling) self-destroys the instance.
on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ] && [ "${BOOT_DONE:-0}" != 1 ] && [ "${HANDLED:-0}" != 1 ]; then
    case "$rc" in
      11|12|13) ;;
      *) "$PY" -m vastcomfy_agent.boot fail boot_failed --env-file "$ENV_FILE" ;;
    esac
  fi
  exit "$rc"
}
trap on_exit EXIT

# Fallback A (S1): without the pinned CLI the .env points the failsafe and the agent at the stock CLI, without -y.
# A set-key failure exits 13 (treated as handled) and the configured CLI is missing, so only the stock CLI can
# still destroy here.
if [ "$VASTAI_FALLBACK" = 1 ]; then
  STOCK_VASTAI="$(boot get STOCK_VASTAI_BIN --env-file "$ENV_FILE")" || emergency_destroy vastai_fallback_failed
  [ -x "$STOCK_VASTAI" ] || emergency_destroy vastai_fallback_failed
  boot set-key VASTAI_BIN "$STOCK_VASTAI" --env-file "$ENV_FILE" || emergency_destroy vastai_fallback_failed
  boot set-key DESTROY_ASSUME_YES false --env-file "$ENV_FILE" || emergency_destroy vastai_fallback_failed
fi

eval "$(boot env-export --env-file "$ENV_FILE")"  # non-secret keys for the shell steps below

die_with() { HANDLED=1; boot fail "$1" --env-file "$ENV_FILE"; exit $?; }
ctl() { "$SUPERVISORCTL_BIN" -c "$SUPERVISOR_CONF" "$@"; }

# Step 2: new boot, time files (written only on the very first boot).
boot begin --env-file "$ENV_FILE" || pre_failsafe_failed $? begin_failed
boot init-times --env-file "$ENV_FILE" || pre_failsafe_failed $? init_times_failed

# Step 3: failsafe. From here on every failure self-destroys the instance.
nohup "$HERE/failsafe.sh" --env-file "$ENV_FILE" >> "$STATE_DIR/failsafe.log" 2>&1 &
FAILSAFE_PID=$!
sleep 1
kill -0 "$FAILSAFE_PID" 2>/dev/null || die_with failsafe_failed

# Step 4: register tailscaled and agent (rendered with literal values) with the image's running supervisord.
boot render-supervisor-conf --env-file "$ENV_FILE" || exit $?
ctl reread || die_with supervisor_failed
ctl update || die_with supervisor_failed

# Step 5: Tailscale (userspace). The single-use key goes through a 600 file, never a command line.
ctl start tailscaled || die_with tailscale_failed
AUTH_FILE="$(mktemp)"
printf '%s' "$(boot get TS_AUTHKEY --env-file "$ENV_FILE")" > "$AUTH_FILE"
"$TAILSCALE_BIN" --socket="$TS_SOCKET" up --auth-key="file:$AUTH_FILE" --hostname="$TS_HOSTNAME" --advertise-tags="$TS_TAG"
TS_RC=$?
rm -f "$AUTH_FILE"
[ "$TS_RC" -eq 0 ] || die_with tailscale_failed
boot wipe-key TS_AUTHKEY --env-file "$ENV_FILE" || exit $?
if [ "$TS_SERVE_ENABLED" = "true" ]; then
  serve_port() { "$TAILSCALE_BIN" --socket="$TS_SOCKET" serve --bg --tcp="$1" "tcp://$2:$1"; }
  serve_port "$COMFY_PORT" "$COMFY_HOST" || die_with tailscale_failed
  serve_port "$AGENT_PORT" "$AGENT_HOST" || die_with tailscale_failed
fi

# Step 6: agent (reachable over Tailscale from here on).
ctl start agent || die_with agent_start_failed
boot wait --target agent --env-file "$ENV_FILE" || exit $?

# Steps 7-8: nodes, then models (state moves to downloading).
boot install-nodes --env-file "$ENV_FILE" || exit $?
boot install-models --env-file "$ENV_FILE" || exit $?

# Step 9: bundled workflows (never overwrites), then restart the image's ComfyUI (already running since the
# entrypoint) once so it loads the new nodes.
boot copy-workflows --env-file "$ENV_FILE" || exit $?
ctl restart "$COMFY_PROGRAM" || die_with comfyui_start_failed
boot wait --target comfy --env-file "$ENV_FILE" || exit $?

# Step 10: ready (starts the idle timer).
boot mark-ready --env-file "$ENV_FILE" || exit $?
BOOT_DONE=1
