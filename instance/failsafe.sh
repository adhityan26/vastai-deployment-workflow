#!/usr/bin/env bash
# Standalone failsafe: destroys this instance once min(deadline, hard_cap) has passed,
# regardless of running jobs. Deliberately small and independent of the agent.
# The instance .env is read with grep/cut only; it is never sourced (spec 14.3).
set -u

ENV_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    *) echo "failsafe: unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$ENV_FILE" ] || [ ! -r "$ENV_FILE" ]; then
  echo "failsafe: --env-file is required and must be readable" >&2
  exit 2
fi

env_get() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-; }

for key in STATE_DIR CONTAINER_ID CONTAINER_API_KEY HARD_CAP_HOURS FAILSAFE_POLL_S VASTAI_BIN \
           DESTROY_GONE_MARKERS DESTROY_TIMEOUT_S SUPERVISORCTL_BIN SUPERVISOR_CONF COMFY_PROGRAM; do
  if [ -z "$(env_get "$key")" ]; then
    echo "failsafe: missing $key in $ENV_FILE" >&2
    exit 2
  fi
done

STATE_DIR="$(env_get STATE_DIR)"
CONTAINER_ID="$(env_get CONTAINER_ID)"
API_KEY="$(env_get CONTAINER_API_KEY)"
HARD_CAP_HOURS="$(env_get HARD_CAP_HOURS)"
POLL_S="$(env_get FAILSAFE_POLL_S)"
VASTAI_BIN="$(env_get VASTAI_BIN)"
GONE_MARKERS="$(env_get DESTROY_GONE_MARKERS)"
TIMEOUT_S="$(env_get DESTROY_TIMEOUT_S)"
SUPERVISORCTL_BIN="$(env_get SUPERVISORCTL_BIN)"
SUPERVISOR_CONF="$(env_get SUPERVISOR_CONF)"
COMFY_PROGRAM="$(env_get COMFY_PROGRAM)"

is_int() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

write_atomic() {  # file content
  local tmp="$1.tmp.$$"
  printf '%s\n' "$2" > "$tmp" && mv "$tmp" "$1"
}

if ! command -v "$VASTAI_BIN" > /dev/null 2>&1; then
  echo "failsafe: VASTAI_BIN ($VASTAI_BIN) is not an executable command" >&2
  exit 2
fi
if ! mkdir -p "$STATE_DIR" 2> /dev/null || ! write_atomic "$STATE_DIR/failsafe.pid" "$$" 2> /dev/null; then
  echo "failsafe: STATE_DIR ($STATE_DIR) is not writable" >&2
  exit 2
fi

START="$(date +%s)"
HARD_CAP="$(cat "$STATE_DIR/hard_cap" 2>/dev/null)"
if ! is_int "$HARD_CAP"; then
  HARD_CAP=$((START + HARD_CAP_HOURS * 3600))
fi
ELAPSED_LIMIT=$((HARD_CAP_HOURS * 3600))

IFS=',' read -r -a MARKERS <<< "$(lower "$GONE_MARKERS")"
OUT_FILE="$STATE_DIR/.failsafe_out"

# Output goes to OUT_FILE; if that cannot be opened, fall back so the command ALWAYS runs.
# The path actually used is left in OUT_USED.
run_with_timeout() {  # seconds outfile command...
  local secs="$1" target="$2"; shift 2
  if ! : > "$target" 2> /dev/null; then
    target="$(mktemp 2> /dev/null)" || target=/dev/null
  fi
  OUT_USED="$target"
  "$@" > "$target" 2>&1 &
  local pid=$! waited=0
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

is_gone() {
  local lowered marker
  lowered="$(lower "$1")"
  for marker in "${MARKERS[@]}"; do
    case "$lowered" in *"$marker"*) [ -n "$marker" ] && return 0 ;; esac
  done
  return 1
}

attempts=0
destroy_once() {
  attempts=$((attempts + 1))
  write_atomic "$STATE_DIR/destroy_failsafe.json" "{\"attempts\": $attempts, \"last_error\": null, \"pending\": true}"
  if [ "$attempts" -eq 1 ]; then
    run_with_timeout "$TIMEOUT_S" /dev/null "$SUPERVISORCTL_BIN" -c "$SUPERVISOR_CONF" stop "$COMFY_PROGRAM" || true
  fi
  run_with_timeout "$TIMEOUT_S" "$OUT_FILE" "$VASTAI_BIN" destroy instance "$CONTAINER_ID" --api-key "$API_KEY"
  local rc=$? out
  out="$(cat "$OUT_USED" 2>/dev/null)"
  case "$OUT_USED" in "$OUT_FILE"|/dev/null) ;; *) rm -f "$OUT_USED" ;; esac
  # 126/127 = could not execute: never a success, whatever the output says
  if [ "$rc" -eq 0 ] || { [ "$rc" -ne 126 ] && [ "$rc" -ne 127 ] && is_gone "$out"; }; then
    write_atomic "$STATE_DIR/destroy_failsafe.json" "{\"attempts\": $attempts, \"last_error\": null, \"pending\": false}"
    exit 0
  fi
  if [ "$rc" -eq 124 ]; then out="vastai call timed out"; fi
  out="${out//"$API_KEY"/***}"
  out="$(printf '%s' "$out" | tr -d '"\\\r\n' | cut -c1-200)"
  write_atomic "$STATE_DIR/destroy_failsafe.json" "{\"attempts\": $attempts, \"last_error\": \"$out\", \"pending\": true}"
}

while true; do
  now="$(date +%s)"
  limit="$HARD_CAP"
  deadline="$(cat "$STATE_DIR/deadline" 2>/dev/null)"
  if is_int "$deadline" && [ "$deadline" -lt "$limit" ]; then
    limit="$deadline"
  fi
  if [ "$now" -ge "$limit" ] || [ "$SECONDS" -ge "$ELAPSED_LIMIT" ]; then
    destroy_once
  fi
  sleep "$POLL_S"
done
