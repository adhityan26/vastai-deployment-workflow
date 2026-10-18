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
           DESTROY_GONE_MARKERS DESTROY_OK_MARKERS DESTROY_ASSUME_YES DESTROY_TIMEOUT_S SUPERVISORCTL_BIN SUPERVISOR_CONF COMFY_PROGRAM; do
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
OK_MARKERS="$(env_get DESTROY_OK_MARKERS)"
TIMEOUT_S="$(env_get DESTROY_TIMEOUT_S)"
ASSUME_YES="$(env_get DESTROY_ASSUME_YES)"
SUPERVISORCTL_BIN="$(env_get SUPERVISORCTL_BIN)"
SUPERVISOR_CONF="$(env_get SUPERVISOR_CONF)"
COMFY_PROGRAM="$(env_get COMFY_PROGRAM)"

is_int() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Numeric keys: digits only and >= 1, or the timeout/cap arithmetic below silently breaks.
# 10# reads a value such as 08 as decimal instead of an invalid octal number.
for key in HARD_CAP_HOURS FAILSAFE_POLL_S DESTROY_TIMEOUT_S; do
  value="$(env_get "$key")"
  if ! is_int "$value" || [ "$((10#$value))" -lt 1 ]; then
    echo "failsafe: $key must be a whole number >= 1 (got '$value')" >&2
    exit 2
  fi
done
case "$ASSUME_YES" in
  true|false) ;;
  *) echo "failsafe: DESTROY_ASSUME_YES must be true or false (got '$ASSUME_YES')" >&2; exit 2 ;;
esac
HARD_CAP_HOURS=$((10#$HARD_CAP_HOURS))
POLL_S=$((10#$POLL_S))
TIMEOUT_S=$((10#$TIMEOUT_S))

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

trim() {  # strip leading and trailing whitespace (portable, no ${var,,})
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  printf '%s' "${v%"${v##*[![:space:]]}"}"
}

# csv -> lowercase, trimmed, non-empty entries; a blank entry must never become a marker that matches everything.
# Sets the array named by $1.
split_markers() {  # arrayname csv
  local item trimmed raw
  eval "$1=()"
  IFS=',' read -r -a raw <<< "$(lower "$2")"
  for item in "${raw[@]}"; do
    trimmed="$(trim "$item")"
    if [ -n "$trimmed" ]; then eval "$1+=(\"\$trimmed\")"; fi
  done
}
split_markers OK_LIST "$OK_MARKERS"
split_markers GONE_LIST "$GONE_MARKERS"
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

# Success rule (the CLI always exits 0, so only the text decides), applied per line to the trimmed,
# lowercased text with blank lines ignored:
#  (a) a line containing "failed with error" that matches no gone marker -> failure, even if another
#      line is an OK marker; (b) a gone marker anywhere -> success; (c) otherwise success only if some
#      line STARTS with an OK marker (tolerates the stock CLI's leading WARNING lines); else failure.
is_success_text() {
  local text line marker found_gone=0 found_ok=0 matched
  text="$(lower "$1")"
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    [ -z "$line" ] && continue
    matched=0
    for marker in ${GONE_LIST[@]+"${GONE_LIST[@]}"}; do
      case "$line" in *"$marker"*) matched=1 ;; esac
    done
    if [ "$matched" -eq 1 ]; then
      found_gone=1
    else
      case "$line" in *"failed with error"*) return 1 ;; esac
    fi
    for marker in ${OK_LIST[@]+"${OK_LIST[@]}"}; do
      case "$line" in "$marker"*) found_ok=1 ;; esac
    done
  done <<< "$text"
  [ "$found_gone" -eq 1 ] || [ "$found_ok" -eq 1 ]
}

attempts=0
# Why this failsafe destroys (fixed ids, mirrored into the agent state and its /status by the runner):
# hard_cap when the hard cap (or the elapsed-time guard) was reached, else failsafe_deadline.
REASON=failsafe_deadline
destroy_once() {
  attempts=$((attempts + 1))
  write_atomic "$STATE_DIR/destroy_failsafe.json" "{\"attempts\": $attempts, \"last_error\": null, \"pending\": true, \"reason\": \"$REASON\"}"
  if [ "$attempts" -eq 1 ]; then
    # One line for the logs, before anything is destroyed; it carries only the fixed reason id.
    echo "[watchdog] destroying instance: reason=$REASON"
    run_with_timeout "$TIMEOUT_S" /dev/null "$SUPERVISORCTL_BIN" -c "$SUPERVISOR_CONF" stop "$COMFY_PROGRAM" || true
  fi
  local yes_flag=()
  if [ "$ASSUME_YES" = "true" ]; then yes_flag=(-y); fi
  run_with_timeout "$TIMEOUT_S" "$OUT_FILE" "$VASTAI_BIN" destroy instance "$CONTAINER_ID" ${yes_flag[@]+"${yes_flag[@]}"} --api-key "$API_KEY"
  local rc=$? out
  out="$(cat "$OUT_USED" 2>/dev/null)"
  case "$OUT_USED" in "$OUT_FILE"|/dev/null) ;; *) rm -f "$OUT_USED" ;; esac
  # The id and key are stripped before matching so a bare marker such as "404" cannot match them.
  local scrubbed="${out//"$CONTAINER_ID"/}"
  scrubbed="${scrubbed//"$API_KEY"/}"
  # The vastai CLI always exits 0 (also on failure), so the exit status is ignored and only the text
  # decides: an OK or gone marker. 124 = killed by the timeout, 126/127 = could not execute: never a
  # success, whatever the output says.
  if [ "$rc" -ne 124 ] && [ "$rc" -ne 126 ] && [ "$rc" -ne 127 ] && is_success_text "$scrubbed"; then
    write_atomic "$STATE_DIR/destroy_failsafe.json" "{\"attempts\": $attempts, \"last_error\": null, \"pending\": false, \"reason\": \"$REASON\"}"
    exit 0
  fi
  if [ "$rc" -eq 124 ]; then out="vastai call timed out"; fi
  out="${out//"$API_KEY"/***}"
  # Keep printable ASCII only (drops control bytes 0-31, DEL and multi-byte text), then quotes and
  # backslashes, so last_error is always valid JSON; LC_ALL=C makes tr and cut work on plain bytes.
  out="$(printf '%s' "$out" | LC_ALL=C tr -cd ' -~' | LC_ALL=C tr -d '"\\' | LC_ALL=C cut -c1-200)"
  write_atomic "$STATE_DIR/destroy_failsafe.json" "{\"attempts\": $attempts, \"last_error\": \"$out\", \"pending\": true, \"reason\": \"$REASON\"}"
}

while true; do
  now="$(date +%s)"
  limit="$HARD_CAP"
  deadline="$(cat "$STATE_DIR/deadline" 2>/dev/null)"
  if is_int "$deadline" && [ "$deadline" -lt "$limit" ]; then
    limit="$deadline"
  fi
  if [ "$now" -ge "$limit" ] || [ "$SECONDS" -ge "$ELAPSED_LIMIT" ]; then
    # The reason is fixed by the first attempt: a later deadline change must not rename it.
    if [ "$attempts" -eq 0 ]; then
      if [ "$SECONDS" -ge "$ELAPSED_LIMIT" ] || [ "$now" -ge "$HARD_CAP" ]; then REASON=hard_cap; fi
    fi
    destroy_once
  fi
  sleep "$POLL_S"
done
