# S1 Stock-Image Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt the instance runtime (schema defaults, boot CLI, `bootstrap.sh`, supervisor programs, destroy success rule) to the real Vast `vastai/comfy` image, using the facts measured in spikes S1 and S4.

**Architecture:** The stock image already runs its own `supervisord`, ComfyUI (supervisor program `comfyui`, port 18188, venv `/venv/main`) and a deprecated `vastai` CLI. Our bootstrap therefore (1) builds its own venv with the agent and a pinned new `vastai`, (2) never starts a second supervisord but registers `tailscaled` and `agent` through a rendered file in `/etc/supervisor/conf.d`, (3) restarts the stock `comfyui` program after installing nodes, and (4) falls back to the stock CLI (no `-y`) when the new CLI cannot be installed, so a self-destroy is always possible.

**Tech Stack:** Python 3.10+ (existing `vastcomfy_agent` package, pytest), bash (3.2-portable), the config schema `contracts/config-schema.yaml`.

**Spec:** `docs/superpowers/specs/2026-10-16-instance-runtime-design.md`; **authority for the facts:** `docs/spikes/S1-stock-comfyui-image.md` (decisions 1-12 and Follow-ups) and `docs/spikes/S4-destroy-from-instance.md`. Read both first.

## Global Constraints

- **No hardcoded config in code.** Every path, port, binary, version and flag below is a schema key with the stated default in `contracts/config-schema.yaml`; `instance/allowed-keys.txt` and the generated contracts are regenerated (`cd instance/agent && .venv/bin/python -m vastcomfy_agent.config gen-keys --out ../allowed-keys.txt`; `.venv/bin/python -m vastcomfy_agent.contracts_export --out ../../contracts`). The lint (`scripts/check_config_usage.py`) runs in the pre-commit hook; a literal that must stay in shell/Python gets `# config-lint: ok (reason)`.
- **Measured defaults (S1/S4):** `COMFY_PORT=18188`; `COMFY_DIR=/workspace/ComfyUI` and `WORKFLOWS_DIR=/workspace/ComfyUI/user/default/workflows` (unchanged); `COMFY_PYTHON=/venv/main/bin/python`; `VENV_DIR=/opt/vastcomfy-venv` (new); `AGENT_PYTHON=/opt/vastcomfy-venv/bin/python`; `VASTAI_BIN=/opt/vastcomfy-venv/bin/vastai`; `VASTAI_VERSION=1.8.3` (new, pinned); `STOCK_VASTAI_BIN=/opt/instance-tools/bin/vastai` (new, the deprecated CLI shipped in the image); `SUPERVISOR_CONF=/etc/supervisor/supervisord.conf`; `SUPERVISOR_CONF_DIR=/etc/supervisor/conf.d` (new); `SUPERVISOR_PROGRAMS_FILE=vastcomfy.conf` (new, name of the rendered file inside the conf dir); `DESTROY_ASSUME_YES=true` (new bool; adds `-y` to the destroy command; the stock CLI does not know `-y`); `COMFY_PROGRAM=comfyui` (unchanged).
- **Destroy output rule (supersedes the earlier "starts with" rule):** after stripping the instance id and the key and trimming/lowercasing, the output is split into lines; ignore blank lines; (a) any line containing `failed with error` that does not match a gone marker -> FAILURE (even if another line is an OK marker); (b) a gone marker anywhere -> success; (c) otherwise success only if at least one line STARTS with an OK marker (so the stock CLI's leading `WARNING: ...` deprecation lines are tolerated); anything else is a failure. The exit status 0 carries no information; 124/126/127 are never success. Same decision in Python (`destroyer.py`) and bash (`failsafe.sh`) for the same output.
- **Fail-closed boot:** nothing in the new bootstrap may leave the instance running without a way to self-destroy: if the venv/agent install fails, bootstrap destroys with the stock CLI found in PATH (`command -v vastai`) using the shell-level environment (`CONTAINER_ID`, `CONTAINER_API_KEY`) and exits non-zero; if only the pinned new `vastai` fails to install, bootstrap sets `VASTAI_BIN=<STOCK_VASTAI_BIN>` and `DESTROY_ASSUME_YES=false` in the instance `.env` and continues (fallback A).
- **Interfaces that stay:** state file names, exit codes 10/11/12/13 of the boot CLI, the EXIT-trap design, `Destroyer(...)` constructor keywords (a new keyword `assume_yes: bool = True` is added), `failsafe.sh --env-file`.
- **Tests:** every task is TDD; the whole suite (`cd instance/agent && .venv/bin/python -m pytest -q -W error`, ~3 minutes) and the lint must be green before each commit; stubs must mimic the real CLI (exit 0 with realistic text, including the stock CLI's 3-line deprecation preamble).
- **Commits:** English messages ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never `--no-verify`. Work happens on the current branch `spikes/s1-s5`; never switch branches.

## Review Focus

1. **Stock CLI preamble:** output `WARNING: ... deprecated ...\n         Please run ...\n\ndestroying instance 42.` (exit 0) is a SUCCESS, while `WARNING...\nFailed with error 500: error destroying instance 42` is a FAILURE, in both Python and bash.
2. **No second supervisord, no env expansion surprises:** the rendered supervisor file contains literal values (supervisord is already running and does not see our exported environment), is written atomically, and a bad/missing key fails the boot closed.
3. **Fallback paths:** agent-venv install failure -> emergency destroy with the stock CLI and non-zero exit; new-`vastai` install failure -> `.env` switched to the stock CLI without `-y`, and the failsafe/Destroyer then really use that form.
4. **Port/path defaults:** the agent talks to ComfyUI on 18188 and the failsafe/agent/boot read the same keys.

---

### Task 1: Per-line destroy success rule and `DESTROY_ASSUME_YES`

**Files:**
- Modify: `instance/agent/vastcomfy_agent/destroyer.py`, `instance/agent/vastcomfy_agent/wiring.py`, `instance/failsafe.sh`, `contracts/config-schema.yaml`, `instance/allowed-keys.txt` (regenerate), `docs/superpowers/specs/2026-10-16-instance-runtime-design.md`
- Modify (tests): `instance/agent/tests/test_destroyer.py`, `instance/agent/tests/test_failsafe.py`, `instance/agent/tests/test_wiring.py`, `instance/agent/tests/test_boot.py`, `instance/agent/tests/test_config.py` (if key lists are asserted)

**Interfaces:**
- Produces: schema key `DESTROY_ASSUME_YES` (bool, instance, default true); `Destroyer(..., assume_yes: bool = True)` so the command is `[bin, "destroy", "instance", id, "-y", "--api-key", key]` when true and `[bin, "destroy", "instance", id, "--api-key", key]` when false; `wiring.build` passes `assume_yes=cfg.destroy_assume_yes`; `failsafe.sh` reads `DESTROY_ASSUME_YES` (required in `.env`, exit 2 naming it when missing or not `true`/`false`) and builds the same two command forms; the per-line success rule from Global Constraints in both implementations.

- [ ] **Step 1: Write the failing tests**
  Python (`test_destroyer.py`) and bash (`test_failsafe.py`): exact command with `assume_yes` true and false; output with the stock 3-line preamble then `destroying instance 42.` -> success; preamble then `Failed with error 500: error destroying instance 42, retry later` -> failure; a preamble then a plain 404 -> gone/success; `destroying instance 42.` alone, a failure-only text, empty output, `Aborted.` and the existing marker-trimming/case/id-echo cases keep their results; invalid `DESTROY_ASSUME_YES` (`yes`) -> failsafe exit 2 naming the key. Update the stubs/fakes in `test_wiring.py` and `test_boot.py` to include the new key where an env file is written.
- [ ] **Step 2: Run them to verify they fail** (`.venv/bin/python -m pytest -q tests/test_destroyer.py tests/test_failsafe.py -x`).
- [ ] **Step 3: Implement** the rule and the flag in `destroyer.py`, `wiring.py`, `failsafe.sh` (bash 3.2 portable, reuse the existing `trim`/`split_markers` helpers), add the schema key with a description, regenerate `instance/allowed-keys.txt` and the contracts.
- [ ] **Step 4: Update the spec** sections 5.4/10/14 (per-line rule, `-y` configurable via `DESTROY_ASSUME_YES`, stock CLI preamble) and the S1 doc follow-up.
- [ ] **Step 5: Run the whole suite and the lint, then commit** (`fix: accept the stock CLI preamble and make -y configurable`).

---

### Task 2: S1 schema defaults, new keys and boot CLI helpers

**Files:**
- Modify: `contracts/config-schema.yaml`, `instance/allowed-keys.txt` (regenerate), `instance/agent/vastcomfy_agent/boot.py`, `instance/agent/vastcomfy_agent/wiring.py` (only if a default is referenced), `instance/agent/vastcomfy_agent/supervisor_conf.py` (new)
- Test: `instance/agent/tests/test_config.py`, `instance/agent/tests/test_boot.py`, `instance/agent/tests/test_supervisor_conf.py` (new)

**Interfaces:**
- Produces: the new schema keys and changed defaults listed in Global Constraints (each with `min`/`max`/types as appropriate: bools, strings; descriptions mention the S1 source); `supervisor_conf.render(cfg) -> str` returning the text of the supervisor programs file for `tailscaled` and `agent` with LITERAL values (no `%(ENV_...)s`): `[program:tailscaled]` runs `<TAILSCALED_BIN> --tun=userspace-networking --state=<STATE_DIR>/tailscale/tailscaled.state --socket=<TS_SOCKET>`, `[program:agent]` runs `<AGENT_PYTHON> -m vastcomfy_agent --env-file <ENV_FILE_PATH>` with `directory=<REPO_DIR>/instance/agent`; both `autostart=false`, `autorestart=true`, the agent with `startsecs=1` and `startretries=10`; values containing whitespace or `%` must be rejected with a `ConfigError` (supervisor parses them); boot CLI subcommands `set-key KEY VALUE --env-file` (rewrites one existing key of the instance `.env` atomically, keeping mode 0600, rejecting unknown keys, line breaks, and secrets echoed) and `render-supervisor-conf --env-file` (writes `render(cfg)` atomically to `<SUPERVISOR_CONF_DIR>/<SUPERVISOR_PROGRAMS_FILE>`; fails closed with the usual `boot fail` handling when the directory is missing/unwritable).

- [ ] **Step 1: Write the failing tests** for each new/changed default (the real schema loads; every default inside its bounds), `set-key` (updates only that key, rejects unknown keys/newlines, mode 0600, other keys untouched, round-trips through `load_config`), `render` (literal values, both programs, `autostart=false`, rejects values with spaces/`%`), and `render-supervisor-conf` (writes the file in a temp conf dir, atomic, exit code and `boot fail` path when the dir is unwritable).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** the schema changes (regenerate allowed-keys and contracts), `supervisor_conf.py`, and the two boot subcommands (reuse `atomic_write`, `parse_env_file`, the existing `fail` handling and the broad-exception wrapper).
- [ ] **Step 4: Run the whole suite and the lint, then commit** (`feat: S1 defaults, supervisor program rendering and set-key`).

---

### Task 3: Rework `bootstrap.sh`, add `onstart.sh`, update specs

**Files:**
- Create: `instance/onstart.sh`
- Modify: `instance/bootstrap.sh`, `instance/supervisord.conf` (delete it; the programs are now rendered by Task 2's code), `docs/superpowers/specs/2026-10-16-instance-runtime-design.md`, `docs/spikes/S1-stock-comfyui-image.md` (tick the follow-ups that this plan completes)
- Test: `instance/agent/tests/test_bootstrap_script.py` (rewrite the static checks), new static checks for `onstart.sh`

**Interfaces:**
- Consumes: Task 1/2 keys and the boot subcommands `set-key`, `render-supervisor-conf`, existing `write-env`, `begin`, `init-times`, `fail`, `wipe-key`, `get`, `install-nodes`, `install-models`, `copy-workflows`, `wait`, `mark-ready`, `env-export`.
- Produces: `instance/onstart.sh` (run by the bot's `--onstart-cmd` after cloning the repo): (1) disables ComfyUI-Manager by renaming `<COMFY_DIR>/custom_nodes/ComfyUI-Manager` to `ComfyUI-Manager.disabled` if it exists (before the stock entrypoint starts ComfyUI), (2) starts the image's stock `entrypoint.sh` in the background with its output appended to a log file, (3) `exec`s `bootstrap.sh`; it uses only environment variables with `${VAR:-default}` fallbacks marked `# config-lint: ok` (the schema file is not yet readable) for `COMFY_DIR` and a new env var `STOCK_ENTRYPOINT` (default `entrypoint.sh`), and it must never fail silently (a failing rename of an existing Manager directory aborts with a non-zero exit before the entrypoint is started).
  New `bootstrap.sh` order (keep the EXIT-trap/`HANDLED`/`BOOT_DONE`/`die_with` design, bash 3.2 portable, `# config-lint: ok` only where already used):
  0. Build the agent venv: `python3 -m venv "$VENV_DIR"` (with `VENV_DIR="${VENV_DIR:-/opt/vastcomfy-venv}"  # config-lint: ok`), `pip install -q -e "$HERE/agent"` inside it; on failure run `emergency_destroy` and exit non-zero: `emergency_destroy` uses the stock CLI found with `command -v vastai` (from PATH, since the schema is not available yet) and the shell-level `CONTAINER_ID`/`CONTAINER_API_KEY` (without `-y`), never prints the key, and exits non-zero even if the destroy fails. Then `PY="$VENV_DIR/bin/python"`.
  0b. Install the pinned CLI: `pip install -q "vastai==${VASTAI_VERSION:-1.8.3}"` in the same venv (`# config-lint: ok`); on failure remember `VASTAI_FALLBACK=1`.
  1. `write-env` (unchanged), then if `VASTAI_FALLBACK=1`: `boot set-key VASTAI_BIN <value of STOCK_VASTAI_BIN from the .env via boot get> ` and `boot set-key DESTROY_ASSUME_YES false`, each followed by the usual `|| exit $?` handling.
  2-3. unchanged (EXIT trap, `begin`, `init-times`, failsafe start with the liveness check).
  4. **Remove the `supervisord` start.** Instead: `boot render-supervisor-conf`, then `supervisorctl reread` and `supervisorctl update` (using `SUPERVISORCTL_BIN` and `SUPERVISOR_CONF` as today; failures `die_with supervisor_failed`).
  5. Tailscale: unchanged for now (S2 will adapt it), but it must start the `tailscaled` program registered in step 4.
  6-8. agent start/wait, install-nodes, then `supervisorctl restart <COMFY_PROGRAM>` (instead of `start`) AFTER install-nodes and BEFORE the model download is NOT needed: keep the order nodes -> models -> workflows, and restart ComfyUI once after the workflows are copied; then `wait --target comfy`, `mark-ready`.
  Keep every existing fail-closed property.

- [ ] **Step 1: Write the failing static tests** in `test_bootstrap_script.py` (and for `onstart.sh`): bash syntax; ordering (venv/agent install < emergency path < write-env < begin < init-times < failsafe < render-supervisor-conf < reread/update < tailscale < agent start < install-nodes < install-models < copy-workflows < restart comfy < wait comfy < mark-ready); no `supervisord` start and no `%(ENV_` expansion remaining; `emergency_destroy` exists, uses `command -v vastai`, does not print the key, and is reached on agent-install failure; the pinned `vastai` install sets the fallback and the two `set-key` calls exist; the auth key still never appears on a command line; the EXIT trap placement test still pins `trap on_exit EXIT` after `write-env`; `onstart.sh` order: Manager rename before the entrypoint launch before `exec bootstrap`; `instance/supervisord.conf` is gone. Where a behaviour can be exercised without real services (for example `emergency_destroy` with a fake `vastai` on PATH and fake `CONTAINER_*`, and `onstart.sh` with a temp `COMFY_DIR` and a fake entrypoint script), add a real bash test that runs the function/script in a temp directory (never run the real `bootstrap.sh`).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement** `onstart.sh` and the new `bootstrap.sh`; delete `instance/supervisord.conf`; make sure no code or test still references it.
- [ ] **Step 4: Update the spec** (5.1 process layout: image supervisord, program file; 5.3 boot order; 9 exposure and the create-instance contract: image tag pinned, `--ssh --direct`, no `-p`, `PORTAL_CONFIG` ComfyUI-only, no `PROVISIONING_SCRIPT`, ComfyUI-Manager renamed; 14 key table; 17 open questions answered) and tick the follow-ups of the S1 doc that are now done.
- [ ] **Step 5: Run the whole suite and the lint, then commit** (`feat: adapt bootstrap to the stock Vast ComfyUI image`).
