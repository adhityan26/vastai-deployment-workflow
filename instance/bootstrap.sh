#!/usr/bin/env bash
# Boot sequence for a fresh instance (spec 5.3). Safety nets come first.
# onstart runs: git clone "$REPO_URL" "$REPO_DIR" && git -C "$REPO_DIR" checkout "$REPO_COMMIT" && bash "$REPO_DIR/instance/bootstrap.sh"
# Adjust the supervisord and Tailscale steps to the findings of spikes S1 and S2.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${AGENT_PYTHON:-python3}"  # config-lint: ok (interpreter needed before any configuration exists)

# Editable install: the agent reads contracts/config-schema.yaml from this repository checkout.
"$PY" -m pip install -q -e "$HERE/agent" || { echo "bootstrap: installing the agent failed" >&2; exit 1; }
boot() { "$PY" -m vastcomfy_agent.boot "$@"; }

# Step 1: credentials. Writes the instance .env from the environment (schema keys only).
ENV_FILE="$(boot write-env)" || exit $?

# Fail closed: credentials exist from here on, so any non-zero exit before BOOT_DONE that no boot command or
# die_with already handled (a boot command returns 11, 12 or 13 after handling) self-destroys the instance.
BOOT_DONE=0
HANDLED=0
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
eval "$(boot env-export --env-file "$ENV_FILE")"  # non-secret keys for supervisord's %(ENV_...)s

die_with() { HANDLED=1; boot fail "$1" --env-file "$ENV_FILE"; exit $?; }
ctl() { "$SUPERVISORCTL_BIN" -c "$SUPERVISOR_CONF" "$@"; }

# Step 2: new boot, time files (written only on the very first boot).
boot begin --env-file "$ENV_FILE" || exit $?
boot init-times --env-file "$ENV_FILE" || exit $?

# Step 3: failsafe. From here on every failure self-destroys the instance.
nohup "$HERE/failsafe.sh" --env-file "$ENV_FILE" >> "$STATE_DIR/failsafe.log" 2>&1 &
FAILSAFE_PID=$!
sleep 1
kill -0 "$FAILSAFE_PID" 2>/dev/null || die_with failsafe_failed

# Step 4: supervisord.
"$SUPERVISORD_BIN" -c "$SUPERVISOR_CONF" || die_with supervisor_failed

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

# Step 9: bundled workflows (never overwrites), then ComfyUI.
boot copy-workflows --env-file "$ENV_FILE" || exit $?
ctl start "$COMFY_PROGRAM" || die_with comfyui_start_failed
boot wait --target comfy --env-file "$ENV_FILE" || exit $?

# Step 10: ready (starts the idle timer).
boot mark-ready --env-file "$ENV_FILE" || exit $?
BOOT_DONE=1
