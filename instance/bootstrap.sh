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

# Run a command with its output in a file, killed after SECS seconds (no timeout binary; same pattern as
# failsafe.sh run_with_timeout). Returns 124 when killed.
bounded_run() {  # secs outfile command...
  local secs="$1" target="$2" pid waited=0
  shift 2
  "$@" < /dev/null > "$target" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

# Last resort when the configured destroy path cannot be trusted (no or broken configuration, or a dead
# failsafe): destroy with the image's own CLI (PATH, else STOCK_VASTAI_BIN) and the credentials Vast put in the
# environment. The stock CLI does not know -y (S1). Up to 3 bounded attempts, stopping early on a success text
# (a line starting with "destroying instance", or "failed with error 404: instance", after removing the id and
# the key). KEEP_ON_FAILURE is ignored on purpose: this path errs on the side of destroying. Always exits
# non-zero, whether or not the destroy worked; the CLI output is printed with the key removed.
emergency_destroy() {
  local cli out text rc attempt=1 tmp
  local secs="${DESTROY_TIMEOUT_S:-60}"  # config-lint: ok (also runs before the schema can be read; schema default of DESTROY_TIMEOUT_S)
  local pause="${DESTROY_BACKOFF_S:-5}"  # config-lint: ok (also runs before the schema can be read; short pre-config backoff)
  local stock="${STOCK_VASTAI_BIN:-/opt/instance-tools/bin/vastai}"  # config-lint: ok (before the schema can be read; schema default of STOCK_VASTAI_BIN)
  case "$secs" in ''|*[!0-9]*) secs=60 ;; esac
  case "$pause" in ''|*[!0-9]*) pause=5 ;; esac
  HANDLED=1
  echo "bootstrap: $1; emergency destroy with the image vastai CLI" >&2
  cli="$(command -v vastai)" || cli=""
  if [ -z "$cli" ] && [ -x "$stock" ]; then cli="$stock"; fi
  if [ -z "$cli" ] || [ -z "${CONTAINER_ID:-}" ] || [ -z "${CONTAINER_API_KEY:-}" ]; then
    echo "bootstrap: emergency destroy impossible: vastai CLI or container credentials missing" >&2
    exit 1
  fi
  tmp="$(mktemp 2>/dev/null)" || tmp=/dev/null
  while [ "$attempt" -le 3 ]; do
    bounded_run "$secs" "$tmp" "$cli" destroy instance "$CONTAINER_ID" --api-key "$CONTAINER_API_KEY"
    rc=$?
    out="$(cat "$tmp" 2>/dev/null)"
    printf 'bootstrap: vastai attempt %s (exit %s): %s\n' "$attempt" "$rc" "${out//"$CONTAINER_API_KEY"/<key>}" >&2
    text="${out//"$CONTAINER_API_KEY"/}"
    text="${text//"$CONTAINER_ID"/}"
    if [ "$rc" -ne 124 ] && printf '%s\n' "$text" | grep -Eiq '^[[:space:]]*destroying instance|failed with error 404: instance'; then
      echo "bootstrap: emergency destroy accepted" >&2
      break
    fi
    [ "$attempt" -lt 3 ] && sleep "$pause"
    attempt=$((attempt + 1))
  done
  [ "$tmp" = /dev/null ] || rm -f "$tmp"
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

# S2: the image has no Tailscale. Download the pinned static tarball (about 2 s) into TAILSCALE_DIR; the two
# binaries sit at its top level. Reuses an existing install of the same binaries (restart of the container).
install_tailscale() {
  local arch tmp url
  [ -x "$TAILSCALED_BIN" ] && [ -x "$TAILSCALE_BIN" ] && return 0
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "bootstrap: unsupported architecture for Tailscale: $(uname -m)" >&2; return 1 ;;
  esac
  url="$TAILSCALE_URL_BASE/tailscale_${TAILSCALE_VERSION}_${arch}.tgz"
  tmp="$(mktemp)" || return 1
  if ! bounded_run "$TAILSCALE_INSTALL_TIMEOUT_S" "$tmp" curl -fsSL -o "$tmp.tgz" "$url"; then
    echo "bootstrap: downloading $url failed: $(cat "$tmp" 2>/dev/null)" >&2
    rm -f "$tmp" "$tmp.tgz"
    return 1
  fi
  mkdir -p "$TAILSCALE_DIR" && tar -xzf "$tmp.tgz" -C "$TAILSCALE_DIR" --strip-components=1
  local rc=$?
  rm -f "$tmp" "$tmp.tgz"
  [ "$rc" -eq 0 ] && [ -x "$TAILSCALED_BIN" ] && [ -x "$TAILSCALE_BIN" ]
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

die_with() { HANDLED=1; boot fail "$1" --env-file "$ENV_FILE"; exit $?; }
ctl() { "$SUPERVISORCTL_BIN" -c "$SUPERVISOR_CONF" "$@"; }

# The failsafe exits at startup for the same faults that break the configured Destroyer (for example a
# VASTAI_BIN that does not run), so after boot fail also destroy with the stock CLI; a second destroy of a
# gone instance only hits the 404 gone marker.
failsafe_failed_closed() {
  HANDLED=1
  boot fail failsafe_failed --env-file "$ENV_FILE"
  emergency_destroy failsafe_failed
}

# The binaries the failsafe and the supervisor programs will run (names on PATH or paths).
check_runtime_binaries() {
  command -v "$VASTAI_BIN" > /dev/null 2>&1 && command -v "$AGENT_PYTHON" > /dev/null 2>&1
}

# onstart.sh starts the image entrypoint in the background, so its supervisord may not answer yet. Only a
# numeric pid counts (supervisorctl 3.x exits 0 even when it cannot connect).
wait_for_supervisor() {
  local waited=0 pid
  while :; do
    pid="$(ctl pid 2>/dev/null)"
    case "$pid" in ''|*[!0-9]*) ;; *) return 0 ;; esac
    [ "$waited" -ge "$SUPERVISOR_WAIT_S" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
}

# S1 decision 5 (unverified timing): onstart.sh disabled ComfyUI-Manager before the entrypoint; check again right
# before the restart in case it came back, replacing a stale disabled copy like onstart.sh does.
disable_comfy_manager() {
  local manager="$COMFY_DIR/custom_nodes/ComfyUI-Manager"
  if [ ! -e "$manager" ] && [ ! -L "$manager" ]; then
    echo "bootstrap: ComfyUI-Manager absent before the ComfyUI restart" >&2
    return 0
  fi
  echo "bootstrap: ComfyUI-Manager found before the ComfyUI restart; disabling it" >&2
  if [ -e "$manager.disabled" ] || [ -L "$manager.disabled" ]; then
    rm -rf "$manager.disabled" || return 1
  fi
  mv "$manager" "$manager.disabled" || return 1
  [ ! -e "$manager" ] && [ ! -L "$manager" ]
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

EXPORTS="$(boot env-export --env-file "$ENV_FILE")" || emergency_destroy env_export_failed
eval "$EXPORTS"  # non-secret keys for the shell steps below
check_runtime_binaries || emergency_destroy runtime_binaries_missing

# Step 2: new boot, time files (written only on the very first boot).
boot begin --env-file "$ENV_FILE" || pre_failsafe_failed $? begin_failed
boot init-times --env-file "$ENV_FILE" || pre_failsafe_failed $? init_times_failed

# Step 3: failsafe. From here on every failure self-destroys the instance.
nohup "$HERE/failsafe.sh" --env-file "$ENV_FILE" >> "$STATE_DIR/failsafe.log" 2>&1 &
FAILSAFE_PID=$!
sleep 1
kill -0 "$FAILSAFE_PID" 2>/dev/null || failsafe_failed_closed

# Step 4: install Tailscale (S2), then register tailscaled and agent (rendered with literal values) with the image's running supervisord.
install_tailscale || die_with tailscale_failed
wait_for_supervisor || die_with supervisor_failed
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
# No "tailscale serve" (S2): userspace mode forwards inbound tailnet connections to localhost; the ACL decides
# which ports (COMFY_PORT, AGENT_PORT) are reachable.

# Step 6: agent (reachable over Tailscale from here on).
ctl start agent || die_with agent_start_failed
boot wait --target agent --env-file "$ENV_FILE" || exit $?

# Steps 7-8: nodes, then models (state moves to downloading).
boot install-nodes --env-file "$ENV_FILE" || exit $?
boot install-models --env-file "$ENV_FILE" || exit $?

# Step 9: bundled workflows (never overwrites), then restart the image's ComfyUI (already running since the
# entrypoint) once so it loads the new nodes.
boot copy-workflows --env-file "$ENV_FILE" || exit $?
disable_comfy_manager || die_with comfyui_start_failed
ctl restart "$COMFY_PROGRAM" || die_with comfyui_start_failed
boot wait --target comfy --env-file "$ENV_FILE" || exit $?
# The node classes the profile provides must be registered (a node whose import failed must not look ready).
boot verify-nodes --env-file "$ENV_FILE" || exit $?

# Step 10: ready (starts the idle timer).
boot mark-ready --env-file "$ENV_FILE" || exit $?
BOOT_DONE=1
