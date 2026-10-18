# Boot Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live, verbose console in the web page for everything that happens while an instance boots and runs (image pull, installs, Tailscale, agent, node install, model downloads, ComfyUI), with a phase stepper, secrets masked, and the last lines kept after the instance ends.

**Architecture:** Three log sources are merged by the web service: (1) Vast `status_msg` (docker pull progress while the instance is `loading`), (2) Vast container logs (`vastai logs`: the REST log-request API) which carry everything the instance writes to PID 1 stdout, (3) once the agent answers, its `/status`. On the instance, bootstrap output and step markers are mirrored to `/proc/1/fd/1` (verified on 2026-10-18: a line written there appears in `vastai logs`). The lifecycle keeps a bounded, masked ring buffer (persisted on the data volume), exposed through an admin API with sequence numbers; the page renders a console panel and a stepper.

**Tech Stack:** Node 20+, TypeScript strict, Fastify, Vitest (fake Vast server), bash (instance side), pytest.

**Spec:** `docs/superpowers/specs/2026-10-17-web-interface-design.md`; facts: `docs/spikes/T13-boot-end-to-end.md`; live findings of 2026-10-18 (Vast `status_msg` carries `docker pull` lines during `loading`; container logs show only PID 1 stdout, onstart clone/checkout lines but NOT bootstrap output unless mirrored).

## Global Constraints

- Everything in the earlier plans' Global Constraints applies (no hardcoded config: values from `contracts/config-schema.yaml` component `apps`/`instance`; env only in `apps/core/src/config.ts`; lint `python3 scripts/check_config_usage.py apps instance`; English comments and commits with the Co-Authored-By trailer; never `--no-verify`; never `git add -f` anything under `.superpowers`; no secrets in logs/errors/responses).
- **Secrets never reach the console:** the instance never prints secrets (no `set -x`, no env dumps, no key values; the Tailscale auth key is passed by file); the web ALSO masks every line before storing or sending it: known secrets (the lifecycle's scrub set: Tailscale keys, agent tokens, Vast key, OAuth secret), generic patterns (`tskey-[A-Za-z0-9-]+`, `Bearer <token>`, `Authorization:` values, `api[_-]?key=`/`token=`/`secret=`/`password=` values, long hex/base64 strings of 32+/40+ chars) and URLs with credentials. Masking is applied to lines from ALL sources.
- **Access:** console endpoints are admin only (the logs can reveal infrastructure details); members see only the stepper phase names.
- **Bounded:** the line buffer, the per-line length, the response size, the persisted file and the Vast log-request rate are all bounded by config (`BOOT_LOG_MAX_LINES` default 500, `BOOT_LOG_MAX_LINE_CHARS` default 400, `BOOT_LOG_POLL_MIN_S` default 5). A Vast log request is made only when an admin is watching (the console endpoint was called within the last `BOOT_LOG_WATCH_S` seconds, default 60) and at most once per `BOOT_LOG_POLL_MIN_S`, so an idle page costs nothing.
- Default-deny, CSRF/Origin and `no-store` rules of the web service stay unchanged for the new routes.

## File Structure

```
instance/bootstrap.sh, instance/onstart.sh      mirror output to /proc/1/fd/1, step markers (instance side)
instance/agent/...                              agent boot/download log lines to stdout (instance side)
apps/core/src/vast.ts                           statusMsg in VastInstance; instanceLogs(id, tail) via the REST log-request API
apps/core/src/console.ts                        masking, line merge/dedupe, ring buffer with seq numbers, persistence
apps/core/src/lifecycle.ts                      consoleFor(since), watching/polling, keep last lines after the instance ends
apps/web/src/routes.ts, contracts/web.openapi.json   GET /api/console?after=<seq> (admin)
apps/web/public/{ui.ts,model.ts,index.html,style.css}    console panel + stepper
contracts/config-schema.yaml, .env.example, deploy/web/README.md
```

---

### Task 1: Core and API (Vast sources, masking, buffer, endpoint)

**Interfaces:**
- `VastInstance` gains `status_msg: string | null`. `VastClient.instanceLogs(id: number, tail: number): Promise<string>` using the REST log-request flow the CLI uses (derive it from the vastai SDK source installed on this machine, e.g. find `vast.py` in site-packages and read the `logs` command; do NOT run `vastai --explain` or print its output: it prints the API key; do not call the real Vast API from tests). Errors are `VastError` with fixed text; the key never appears; response size capped (`WEB_JSON_MAX_BYTES` or a dedicated cap `BOOT_LOG_MAX_BYTES` default 1 MiB), the log file URL returned by Vast must be https and fetched without the Authorization header.
- `console.ts`: `maskLine(line: string, secrets: readonly string[]): string`; `class ConsoleBuffer {append(source: "vast_status" | "vast_logs" | "agent", lines: string[]): void; since(seq: number): {lines: {seq: number, t: number, source: string, text: string}[], last_seq: number, truncated: boolean}; markEnded(reason): void; toJSON/fromJSON}` with dedupe (Vast logs are re-fetched as a tail: only lines not already seen are appended; use a robust overlap strategy: find the longest overlap between the previous tail and the new tail, fall back to appending all with a `--- gap ---` marker when no overlap), ring capacity from config, per-line truncation, persistence to a file under the registry directory (`BOOT_LOG_PATH`, default next to the registry) written atomically and loaded at startup.
- `Lifecycle.console(since: number): Promise<ConsolePayload>` returns `{instance: {state, ended: boolean, ended_reason: string | null}, phases: PhaseInfo[], lines, last_seq, truncated}`; polling Vast logs/`status_msg` happens inside this call under the rate and watch rules above; when the active record disappears (instance gone) the buffer is kept and `ended: true` with the last lines (so the page can show why a boot failed); a NEW Start clears the buffer. `phases` is derived from the lines by the markers `[boot] step <n>/<m>: <name>` (and the Vast pull phase while `loading`), as `{id, name, status: "pending"|"running"|"done"|"failed"}` in a FIXED order defined in code from the markers the instance prints (see Task 3), never from line text beyond the marker grammar.
- Route `GET /api/console?after=<int>` (admin, `no-store`): query validated (integer 0..2^53-1, default 0); response as above; OpenAPI updated; members get 403.

- [ ] **Step 1: Failing tests** (fake Vast server for `status_msg` and the log-request flow): masking (each pattern and known secrets; a secret split across the tail overlap boundary is still masked; masking applied to ALL sources); dedupe overlap (identical tail twice -> no duplicates; sliding tail; no overlap -> gap marker); ring capacity and truncation flag; per-line truncation; persistence round trip and corrupt file ignored (starts empty, does not crash); rate limiting (two console calls within `BOOT_LOG_POLL_MIN_S` -> one Vast request) and watch rule (no Vast log request when nobody called console recently); instance ended -> `ended: true` and lines kept; new Start clears; phases derived from markers incl. failed phase on a `[boot] FAILED` marker; route auth matrix (401/403/200), `after` validation, no secrets in the response, OpenAPI route test; Vast logs URL not https -> refused; oversized log -> capped without throwing; Vast errors degrade (console still returns the buffer with a `source_error: "vast_logs_unavailable"` flag, never an exception).
- [ ] **Steps 2-5:** FAIL, implement, run `npx vitest run apps --exclude '.worktrees/**'` (twice), `npm run typecheck`, `python3 scripts/check_config_usage.py apps instance`, `cd instance/agent && arch -arm64 .venv/bin/python -m pytest -q -W error tests/test_config.py tests/test_contracts.py`; commit `feat: boot console API with masked, bounded log merge from Vast`.

### Task 2: Page (console panel and stepper)

**Behaviour:** an admin-only "Boot console" card under the status card, visible while an instance exists (and for the last ended instance until a new Start): a stepper (phase names with pending/running/done/failed marks; members see the stepper only if the state API exposes phases without lines — keep it admin-only for simplicity and show the existing state to members), a monospace scrolling log (textContent only, lines with a short time and a source tag), auto-scroll that pauses when the user scrolls up, "Pause", "Copy" (clipboard in try/catch) and "Clear view" buttons, a "Download .txt" link made with a Blob; polls `/api/console?after=<last_seq>` every few seconds only while the card is visible and the tab is visible (back off on errors; stop on 401/403); shows `ended` state with the reason and keeps the lines. The old "agent cannot be reached" warning is replaced while `phases` says boot is in progress by a plain sentence derived from the current phase ("Installing tools and joining Tailscale, usually 2-4 minutes"). Mobile 375 px, a11y labels, no inline script/style; CSP unchanged; hostile line content inert (always textContent).
- [ ] **Step 1: Failing tests (jsdom + model unit tests):** stepper rendering for each status; appending lines by seq without duplicates; auto-scroll pause/resume logic in model; copy/download use the visible lines; hostile line inert; polling stops on 401/403 and when hidden; ended state shows reason and keeps lines; member never sees the card; sentence for the boot phases.
- [ ] **Steps 2-5:** FAIL, implement, suite + typecheck + `npm run build:page -w @vast-comfy/web`; commit `feat: boot console panel and stepper in the page`.

### Task 3: Instance side (mirror output, step markers) — needs a real boot to verify

**Behaviour:** `instance/onstart.sh` and `instance/bootstrap.sh` duplicate their stdout/stderr to the container's PID 1 stdout (`/proc/1/fd/1`; best effort, never fatal: if the file cannot be opened, continue silently) using a small helper function; every boot step prints one marker line `[boot] step <n>/<m>: <name>` BEFORE it starts and `[boot] FAILED: <reason code>` when it dies (the fixed names, in order: `install_tools`, `failsafe`, `tailscale`, `agent`, `nodes`, `models`, `comfyui`, `ready` — keep the list in ONE place and document it; the web phase order must match); no secrets are printed (verify there is no `set -x`, no env dump, the Tailscale key stays in a file); the agent prints a progress line to stdout while downloading (about every 5 % or 30 s per file, never more often) via the existing logging, and ComfyUI start lines are mirrored (use `tail -n0 -F` of the comfyui log in the background mirrored to PID 1, bounded). Python/shell tests in the existing style (`instance/agent/tests/test_bootstrap_script.py`, `test_onstart_script.py`, agent progress tests): the mirror helper never fails the script when `/proc/1/fd/1` is unwritable; markers appear in order in a fake run; no marker/line contains the key; the step list in bootstrap matches the documented list; the full Python suite stays green.
- [ ] Steps: failing tests, implement, `cd instance/agent && arch -arm64 .venv/bin/python -m pytest -q -W error` (about 4.5 minutes: run in the background and wait), commit `feat: mirror boot output and step markers to the container log`.

## Self-Review

- Coverage: pull progress (status_msg), container logs, phases, masking, bounded buffer, persistence, ended-instance logs, admin-only access, instance-side mirroring. Real verification (marker grammar through `vastai logs` on a live boot) is done by the controller after a push and a real boot.
