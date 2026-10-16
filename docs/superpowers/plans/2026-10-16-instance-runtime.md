# Instance Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build everything that runs inside a Vast.ai instance (bootstrap, failsafe, agent API, idle watcher, profile installer) so the instance can be created, used, and destroyed with no scenario that leaves a GPU billing unmonitored.

**Architecture:** A standalone shell `failsafe.sh` (last line of defence, started before anything that can fail) plus a Python/FastAPI `agent` (status, extend, destroy, workflows, idle watcher) supervised by supervisord next to `tailscaled` and ComfyUI. All state lives in small atomic files under one state directory; all configuration comes from one schema-validated `.env`. A pinned-commit `bootstrap.sh` sequences the boot with safety nets first. Real-world unknowns (Vast image internals, Tailscale userspace, destroy-from-inside, model stack) are resolved by spikes that gate the implementation.

**Tech Stack:** Python >= 3.10 (FastAPI, uvicorn, httpx, pydantic v2, PyYAML, pytest, jsonschema), bash, supervisord, Tailscale (userspace), `vastai` CLI, ComfyUI + ComfyUI-GGUF.

**Spec:** `docs/superpowers/specs/2026-10-16-instance-runtime-design.md` (read it alongside this plan; section numbers below refer to it).

## Global Constraints

Copied from the spec; every task includes these implicitly.

- **No hardcoded config (spec 14.7).** Ports, paths, URLs, timeouts, thresholds, binary names, IDs, hostnames and all credentials come from `contracts/config-schema.yaml` through the `config` module. In code only protocol constants may be literal (field names in contracts, HTTP status codes, state names, state-file names). The only code allowed to read `os.environ` is `config.py` and `boot.py`. A literal that must stay gets the marker comment `# config-lint: ok`.
- **Time is epoch UTC integer seconds** in every state file. Monotonic time is only a secondary guard in `failsafe.sh` (`$SECONDS`).
- **Every state-file write is atomic** (temp file in the same directory, then `rename`) and has one primary writer (spec 5.2 table).
- **`.env` format:** one `KEY=VALUE` per line, no quotes, no expansion, no newline inside a value. Shell code reads it with `grep` + `cut`, never `source`.
- **Instance `.env` contains only keys of component `instance` from the schema**, with defaults resolved and written out (the shell failsafe cannot know defaults). `TS_AUTHKEY` is blanked after use. The main `VAST_API_KEY` never appears on the instance.
- **States:** `booting, downloading, ready, idle-warning, stopping, failed, destroy_failed`. **Reasons:** `missing_container_credentials, config_invalid, hard_cap_missing, failsafe_failed, supervisor_failed, tailscale_failed, agent_start_failed, node_install_failed, download_failed, disk_insufficient, comfyui_start_failed, idle_timeout, failsafe_deadline, manual, watchdog`. Task 2 creates the enum with the first thirteen of these; Task 10 adds `agent_start_failed` and `supervisor_failed` (test first) and amends the spec.
- **Agent API:** every endpoint needs `Authorization: Bearer <AGENT_TOKEN>` except `GET /health`. State-changing calls are `POST`/`PUT`. `/extend` is capped by `hard_cap` and a per-call maximum; it never changes `hard_cap`.
- **State directory** (config key `STATE_DIR`) is on persistent container disk, not tmpfs. File names: `state.json, progress.json, first_boot_at, hard_cap, deadline, idle_destroy_at, failsafe.pid, destroy_failsafe.json, destroy_agent.json`.
- **Python compatibility:** target 3.10 (the stock Vast image may be older than the dev machine). Use `from __future__ import annotations`; no `StrEnum`, no `tomllib`.
- **Commits:** English messages, end with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. The pre-commit hook (`scripts/check-secrets.sh`) must pass; never use `--no-verify`.
- **Spending:** every task that rents a GPU (spikes S1-S5 and Task 13) needs the user's explicit go-ahead and a stated budget cap first. Never print or paste secrets (API keys, tokens, auth keys) into chat or commits.

## Review Focus

Failure modes the spec implies but a straightforward implementation would likely miss. Each has a test in the owning task.

1. **`/extend` with hostile numbers** (zero, negative, huge, non-integer, string, boolean). Expect HTTP 400 with a message naming the limit for out-of-range integers, HTTP 422 for wrong types, and in every case an unchanged deadline. (Task 3, Task 6)
2. **`.env` values containing `=`, spaces, `#`, or a trailing space** (tokens and URLs do). Expect the value round-trips exactly through the Python loader and the shell reader. (Task 1, Task 8, Task 10)
3. **Restart after the deadline already passed.** `first_boot_at` exists, `deadline` is in the past: failsafe destroys on its first loop; bootstrap must not rewrite the files. (Task 3, Task 8, Task 10)
4. **ComfyUI down while the instance is "ready".** Queue is unknown: idle must keep counting (cost-safe) and must not crash the runner loop. (Task 5, Task 7)
5. **A 200 response with the wrong size or an HTML error page, and a full disk mid-download.** Expect `.part` removed, retries exhausted, state `failed` with `download_failed`/`disk_insufficient`, never a "complete" model file. (Task 9)

## File Structure

```
contracts/
  config-schema.yaml               # all config keys (Task 1)
  status.schema.json               # generated from the Status model (Task 12)
  agent.openapi.json               # generated from the FastAPI app (Task 12)
  instance-registry.schema.json    # bot/watchdog registry record (Task 12)
instance/
  bootstrap.sh                     # boot sequencer (Task 10)
  failsafe.sh                      # standalone last-resort destroyer (Task 8)
  supervisord.conf                 # tailscaled, agent, comfyui programs (Task 10)
  allowed-keys.txt                 # generated from the schema (Task 1)
  profiles/image.yaml              # model/node profile (Task 9, filled by spike S3)
  workflows/                       # bundled workflows (spike S3)
  agent/
    pyproject.toml
    vastcomfy_agent/
      __init__.py
      clock.py            # utc_now()
      config.py           # schema, .env parsing, Config, CLI (list/init/gen-keys)
      files.py            # atomic write + typed readers
      paths.py            # StatePaths: single list of state file names
      state.py            # State enum, transitions, StateStore
      deadlines.py        # DeadlineStore, extend rules
      idle.py             # IdleWatcher
      destroyer.py        # Destroyer (vastai CLI, retries)
      destroy_flow.py     # DestroyFlow (stopping -> destroy -> destroy_failed)
      comfy.py            # ComfyClient, read_gpu
      models.py           # pydantic API models (Status, requests)
      status.py           # StatusBuilder
      workflows.py        # WorkflowStore
      app.py              # Deps, create_app
      runner.py           # Runner (periodic tick)
      wiring.py           # build everything from Config
      profile.py          # Profile loader, Downloader, install_nodes
      boot.py             # boot CLI used by bootstrap.sh
      __main__.py         # agent entrypoint
      contracts_export.py # writes contracts/*.json
    tests/                # one test module per source module
scripts/
  check-secrets.sh        # exists
  check_config_usage.py   # no-hardcode lint (Task 11)
docs/spikes/              # spike findings (S1-S5), integration log (Task 13)
```

**Shared interfaces (names every task must use exactly):**

- `clock.utc_now() -> int`
- `config.load_config(env_file: Path, component: str, schema_path: Path | None = None) -> Config`; `Config` exposes keys as lowercase attributes (`cfg.idle_minutes`), `cfg.get("IDLE_MINUTES")`, `cfg.redacted()`.
- `files.atomic_write(path, data: str)`, `read_int(path) -> int | None`, `write_int(path, value)`, `read_json(path, default=None)`, `write_json(path, value)`.
- `paths.StatePaths(root: Path)` with properties `state_json, progress_json, first_boot_at, hard_cap, deadline, idle_destroy_at, failsafe_pid, destroy_failsafe, destroy_agent`.
- `state.State`, `state.REASONS`, `state.InvalidTransition`, `state.StateStore(state_dir, now).get() -> StateRecord(state, reason, updated_at)`, `.set(new, reason=None) -> StateRecord`.
- `deadlines.DeadlineStore(state_dir, now)`: `first_boot_at()`, `hard_cap()`, `deadline()`, `idle_destroy_at()` (each `int | None`), `init_first_boot(failsafe_hours, hard_cap_hours) -> "fresh" | "restart" | "hard_cap_missing"`, `extend_failsafe(minutes, max_per_call) -> int`, `extend_idle(minutes, max_per_call) -> int`, `set_idle_destroy_at(value)`; `deadlines.ExtendError(code, message)`.
- `idle.IdleWatcher(states, deadlines, now, idle_minutes, warn_minutes)`: `start()`, `tick(queue_total: int | None) -> "none" | "warn" | "destroy"`.
- `destroyer.Destroyer(...).destroy() -> bool`; `destroy_flow.DestroyFlow(states, destroyer, stop_comfy).run(reason) -> bool`.
- `comfy.ComfyClient(base_url, client).queue_counts() -> tuple[int, int] | None`, `.ready() -> bool`; `comfy.read_gpu(run, nvidia_smi_bin, timeout_s) -> dict | None`.
- `status.StatusBuilder(...).build() -> models.Status`.
- `workflows.WorkflowStore(directory, max_bytes)`: `list()`, `read(name)`, `write(name, body: bytes)`; `workflows.WorkflowError(status, message)`.
- `app.Deps`, `app.create_app(deps) -> FastAPI`.
- `runner.Runner(...).tick()`, `.run_forever(stop_event)`.
- `profile.load_profile(path) -> Profile`, `profile.Downloader(...).fetch(model, root)`, `profile.install_nodes(...)`, `profile.check_disk(...)`.

**Test commands** run from `instance/agent` after Task 1 creates the virtualenv: `.venv/bin/python -m pytest -q`. A single test: `.venv/bin/python -m pytest tests/test_x.py::test_name -q`.

---

## Phase A: Prerequisites and spikes (gate the implementation)

The spec requires the spikes before implementation. Order: **S4 -> S1 -> S2 -> S3 -> S5**. Each spike writes a findings document under `docs/spikes/` using the template below and ends with a **decision gate**: if the finding contradicts the spec, stop, edit the spec (and this plan if needed), and ask the user before continuing. Spikes rent real GPUs and need the user's accounts, so they are performed with the user, not autonomously.

### Task A0: Spec amendments and spike prerequisites

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-instance-runtime-design.md`
- Create: `docs/spikes/TEMPLATE.md`

- [ ] **Step 1: Apply these spec amendments (needed by the implementation below)**

In section 5.6 (state machine) add two rows: `booting`/`downloading` -> `stopping` (trigger: destroy requested, reason `manual` or `watchdog`). In the reasons list add `config_invalid`, `failsafe_failed`, `supervisor_failed` and `agent_start_failed`. In section 6.1 make `queue` nullable (`null` when ComfyUI is unreachable). In section 15 change `agent.openapi.yaml` to `agent.openapi.json` (generated from the FastAPI app). In section 14 add the new keys used by this plan to the initial key table (the authoritative list is `contracts/config-schema.yaml`, created in Task 1).

- [ ] **Step 2: Create the findings template**

Create `docs/spikes/TEMPLATE.md`:

```markdown
# <Spike id>: <title>

- Date:
- Instance: <offer id, GPU, image> (destroyed: yes/no, final cost: $)
- Spec sections affected:

## Question
## Method (exact commands run)
## Raw results (secrets redacted)
## Verdict: PASS | FAIL | PARTIAL
## Decisions and config/spec changes
## Follow-ups
```

- [ ] **Step 3: Confirm prerequisites with the user (ask, do not assume)**

Ask the user to confirm all of the following before any spike:
1. `vastai` CLI installed and its API key set (`vastai set api-key <key>` run by the user; never echo the key).
2. A budget cap for spikes (suggest $3 total) and the maximum `$/hour` per instance (spec: ~$0.5).
3. Tailscale account access, an ACL with `tagOwners` for `tag:gpu`, and (for S5) permission to create an OAuth client.
4. A second tailnet device or a throwaway tag to test ACL denial (S2).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-16-instance-runtime-design.md docs/spikes/TEMPLATE.md
git commit -m "docs: amend spec for implementation plan and add spike template"
```

### Task A1: Spike S4 - destroy from inside an instance

**Files:**
- Create: `docs/spikes/S4-destroy-from-instance.md`

**Question (spec 4):** can `CONTAINER_API_KEY` destroy its own instance, can it touch another instance, is it present in processes started by `onstart` and in SSH sessions, and does it survive a container restart? Also record the exact output for "already destroyed" (used for `DESTROY_GONE_MARKERS`) and whether the key must be passed by flag or can come from an environment variable (a flag is visible in `ps`).

- [ ] **Step 1: Find a cheap offer** (user confirms the choice and price)

Run: `vastai search offers --help` to confirm the query syntax, then for example:
`vastai search offers 'num_gpus=1 gpu_ram>=8 reliability>0.98 inet_down>=200 rentable=true' -o 'dph' --limit 5`

- [ ] **Step 2: Create two throwaway instances (A = subject, B = victim)**

Run `vastai create instance --help`, then create each with a small image (e.g. `python:3.11-slim`), `--disk 10`, `--ssh --direct`, and an onstart command that records what the environment looks like:
`--onstart-cmd 'env | grep -E "^CONTAINER_(ID|API_KEY)=" | sed "s/=.*/=<set>/" > /tmp/onstart_env.txt; sleep infinity'`
Record both instance ids.

- [ ] **Step 3: Check variable availability**

SSH into A (`vastai ssh-url <A>`). Run `cat /tmp/onstart_env.txt` (onstart context) and `env | grep -E "^CONTAINER_(ID|API_KEY)=" | sed 's/=.*/=<set>/'` (SSH context). Record which contexts have the variables. Per Vast docs they may be missing in SSH sessions.

- [ ] **Step 4: Test the key's scope from inside A**

In A: `pip install vastai`, then using the container's own variables (do not print them):
1. `vastai show instances --api-key "$CONTAINER_API_KEY"` - record what is listed.
2. `vastai destroy instance <B> --api-key "$CONTAINER_API_KEY"` - expected: refused. Record the error text.
3. Check whether the CLI accepts the key from an environment variable or file instead of `--api-key` (read `vastai --help`; try `VAST_API_KEY=... vastai show instances`). Record the safest working form.

- [ ] **Step 5: Test restart persistence**

`vastai stop instance <A>`, wait, `vastai start instance <A>`, SSH back in. Record: are the two variables still available to an onstart-started process, does `/tmp/onstart_env.txt` still exist (disk persistence), was onstart re-run (add a timestamp append to the onstart command beforehand if needed).

- [ ] **Step 6: Destroy A from inside, then again**

In A: `vastai destroy instance "$CONTAINER_ID" --api-key "$CONTAINER_API_KEY"` and record the exact output and exit code. From the laptop, repeat the same destroy for the already-gone instance and record the exact output text (this becomes `DESTROY_GONE_MARKERS`). Destroy B from the laptop. Run `vastai show instances` to confirm nothing is left, and note the final cost.

- [ ] **Step 7: Write the findings document and run the gate**

Write `docs/spikes/S4-destroy-from-instance.md` from the template. **Gate:** if destroy-from-inside does not work (or the key can touch other instances), stop and redesign the failsafe with the user before any further task. Otherwise record in the document: the working CLI form, the strings for `DESTROY_GONE_MARKERS`, and how the variables reach `bootstrap.sh` (onstart env vs file).

- [ ] **Step 8: Commit**

```bash
git add docs/spikes/S4-destroy-from-instance.md
git commit -m "docs: record spike S4 findings (destroy from inside instance)"
```

### Task A2: Spike S1 - the stock Vast ComfyUI image

**Files:**
- Create: `docs/spikes/S1-stock-comfyui-image.md`

**Question (spec 4):** what does the stock ComfyUI template already run (supervisord, ports, public proxy/portal, ComfyUI-Manager), can all of it be disabled by env/config, does `onstart` re-run on restart, does disk persist, what does `/proc/uptime` show inside the container, what does Vast's `start_date` mean, which Python version is present, and where is ComfyUI installed (answers config keys `COMFY_DIR`, `WORKFLOWS_DIR`, `COMFY_PYTHON`)?

- [ ] **Step 1: Pick the template and create one instance** (user confirms cost)

Run `vastai search templates --help`, find the ComfyUI template, and note its image, env and onstart. Create one instance from it with `--disk 40`.

- [ ] **Step 2: Inventory processes and ports**

SSH in and run: `ps aux`, `supervisorctl status` (and the config under `/etc/supervisor/` if present), `ss -ltnp`, `env | grep -iE 'portal|caddy|tunnel|cloudflare' | sed 's/=.*/=<set>/'`, `ls <comfy dir>/custom_nodes` (is ComfyUI-Manager there), `python3 --version`, `pip --version`, `df -h`, `which git supervisord supervisorctl tailscale nvidia-smi curl`. Record installed paths of ComfyUI and its user workflow directory.

- [ ] **Step 3: Check public exposure**

From the laptop: `vastai show instance <id> --raw` (look at mapped ports) and probe each public port with `curl -sI`. Record whether ComfyUI is reachable without credentials and by which route (direct port, portal, tunnel). List every service and env var that must be disabled to meet "no public ports".

- [ ] **Step 4: Restart behaviour**

Add a marker file and an append-only log written by onstart, then `vastai stop instance <id>`, `vastai start instance <id>`. Record: marker persists, onstart ran again, supervisord and ComfyUI restarted by themselves, `/proc/uptime` vs `date +%s` and the instance's real uptime, and `vastai show instance <id> --raw` `start_date` before/after the restart.

- [ ] **Step 5: Write findings, decide, and run the gate**

Write `docs/spikes/S1-stock-comfyui-image.md`. Record decisions: (a) keep the stock image and which services get disabled and how, or switch to a bare CUDA image with our own supervisord (spec fallback); (b) the answers for `COMFY_DIR`, `WORKFLOWS_DIR`, `COMFY_PYTHON`, `SUPERVISOR_CONF` defaults; (c) the `onstart` strategy and whether `PROVISIONING_SCRIPT` is needed (spec open question). **Gate:** if the public exposure cannot be disabled, stop and ask the user to choose the bare-image fallback. Destroy the instance and record the cost.

- [ ] **Step 6: Commit**

```bash
git add docs/spikes/S1-stock-comfyui-image.md
git commit -m "docs: record spike S1 findings (stock ComfyUI image)"
```

### Task A3: Spike S2 - Tailscale userspace

**Files:**
- Create: `docs/spikes/S2-tailscale-userspace.md`

**Question (spec 4):** does Tailscale in userspace-networking mode let the laptop reach a service bound to `127.0.0.1` in the instance, is `tailscale serve` needed, does `--auth-key=file:...` work, are non-owner devices denied by the ACL, and does the node rejoin after a restart using state on disk?

- [ ] **Step 1: Create a small instance and install Tailscale** (use the S1 template or a plain image)

In the instance: install via the official installer (`curl -fsSL https://tailscale.com/install.sh | sh`), then start the daemon: `tailscaled --tun=userspace-networking --state=<state dir>/tailscale/tailscaled.state --socket=<socket path> &`. Run `tailscaled --help` to confirm the flags.

- [ ] **Step 2: Join with a single-use tagged key from a file**

The user creates a one-use ephemeral key tagged `tag:gpu` in the admin console and writes it to a 600 file inside the instance (never printed). Run `tailscale --socket=<socket> up --auth-key=file:<path> --hostname=<unique> --advertise-tags=tag:gpu`. If `file:` is not accepted by this version, record that and test the `--auth-key=<value>` flag, noting it is visible in `ps`.

- [ ] **Step 3: Reachability test**

In the instance run `python3 -m http.server <port> --bind 127.0.0.1`. From the laptop (Tailscale on) run `curl -m 5 http://<hostname>:<port>/`. Record the result **without** `tailscale serve`. Then run `tailscale --socket=<socket> serve --help`, set up the TCP/HTTP forward for that port, and test again. Record exactly which commands made it work.

- [ ] **Step 4: ACL denial and public exposure**

From a second, non-owner device or by temporarily removing the owner rule, confirm the connection is refused. Confirm `vastai show instance <id> --raw` shows no public mapping for that port and an external scan finds nothing.

- [ ] **Step 5: Rejoin after restart**

`vastai stop instance` / `start instance`; restart `tailscaled` with the same state dir and the auth key already consumed. Record whether the node returns without a new key and keeps the same hostname.

- [ ] **Step 6: Write findings and gate**

Write `docs/spikes/S2-tailscale-userspace.md`. Record the working command lines for `tailscaled`, `tailscale up`, and (if needed) `tailscale serve`, and decide `TS_SERVE_ENABLED`. **Gate:** if userspace mode cannot be made reachable, stop and ask the user to choose the fallback (SSH tunnel or Cloudflare Tunnel + Access); the plan's Tailscale steps in Task 10 then change accordingly. Destroy the instance.

- [ ] **Step 7: Commit**

```bash
git add docs/spikes/S2-tailscale-userspace.md
git commit -m "docs: record spike S2 findings (Tailscale userspace)"
```

### Task A4: Spike S3 - Qwen-Image 2.1 GGUF and its text encoder

**Files:**
- Create: `docs/spikes/S3-qwen-image-gguf.md`
- Create: `instance/profiles/image.yaml` (concrete values from this spike)
- Create: `instance/workflows/<name>.json` (API-format export of the working workflow)

**Question (spec 4):** does one correct image come out with GGUF Q4_K_M plus a text encoder, which repo actually serves the files (`abenzerps/Qwen-Image-2.1-Uncensored-GGUF` vs `0xSojalSec/Qwen-Image-2.1-Uncensored-HF`), what are the exact file names/sizes/revisions, does it fit 24 GB VRAM, how long does one image take, and how long does the download take relative to `BOOT_TIMEOUT_MIN`?

- [ ] **Step 1: List the candidate repos from the laptop (free)**

```bash
for r in abenzerps/Qwen-Image-2.1-Uncensored-GGUF 0xSojalSec/Qwen-Image-2.1-Uncensored-HF; do
  echo "== $r"
  curl -s "https://huggingface.co/api/models/$r/tree/main?recursive=1" | python3 -c "import sys,json; [print(f['path'], f.get('size')) for f in json.load(sys.stdin)]"
done
curl -s "https://huggingface.co/api/models/abenzerps/Qwen-Image-2.1-Uncensored-GGUF" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sha'))"
```
(An earlier attempt returned a schema stub instead of data; if that happens again, open the repo's file tab in the browser pane instead.) Record file names, sizes and the commit sha (becomes `revision`).

- [ ] **Step 2: Create a 24 GB instance from the S1-approved template** (user confirms cost)

- [ ] **Step 3: Install ComfyUI-GGUF and download the three files, timing the download**

Clone the node into `<comfy dir>/custom_nodes`, install its requirements, then download the diffusion GGUF, the text encoder and the VAE into the folders named in the model README. Use `time` around the downloads and record GB/s and total seconds.

- [ ] **Step 4: Generate one image through the UI over an SSH tunnel**

Use the Qwen-Image template workflow, replace the model loader with the GGUF loader, set the CLIP loader type to `qwen_image`, and run one prompt. Record: success/fail, image quality (view it), seconds per image, `nvidia-smi` peak VRAM, and any loader error text.

- [ ] **Step 5: Export the working workflow in API format and write the profile**

Export via the UI's API-format export and save as `instance/workflows/<name>.json`. Write `instance/profiles/image.yaml` using the exact schema from spec section 8 with real values from Step 1 (`repo`, `revision` = pinned commit sha, `file`, `dest`, `size_bytes`), nodes pinned to the commit used, and `requires` from Step 4.

- [ ] **Step 6: Write findings and gate**

Write `docs/spikes/S3-qwen-image-gguf.md`. **Gate:** if the encoder/GGUF combination does not produce a correct image, stop and ask the user to choose another quantization/encoder/model before Task 9 (the profile file is the only thing that changes). Compare total download time with `BOOT_TIMEOUT_MIN` (25) and record a recommended value. Destroy the instance.

- [ ] **Step 7: Commit**

```bash
git add docs/spikes/S3-qwen-image-gguf.md instance/profiles/image.yaml instance/workflows
git commit -m "docs: record spike S3 findings and add image profile"
```

### Task A5: Spike S5 - automatic Tailscale keys and a Vast-side safety net

**Files:**
- Create: `docs/spikes/S5-keys-and-vast-safety-net.md`

**Question (spec 4):** can an OAuth client mint single-use, ephemeral, tagged, short-expiry auth keys (and what is the minimum expiry), and does Vast offer any server-side scheduled destroy or spending cap that would cover residual risk 1 (homelab and failsafe both dead)?

- [ ] **Step 1: Mint a key through an OAuth client (user creates the client; secrets stay in the user's shell)**

The user creates an OAuth client with the auth-keys write scope restricted to `tag:gpu`. With the client id/secret in environment variables, fetch a token and create a key. Use the Tailscale API docs for the current endpoints (search `tailscale api auth keys oauth`), then call the keys endpoint with `capabilities.devices.create` = `{reusable: false, ephemeral: true, preauthorized: true, tags: ["tag:gpu"]}` and a short `expirySeconds`. Try 3600, then the smallest value the API accepts. Record the accepted minimum and the response shape (do not print the key itself).

- [ ] **Step 2: Look for a server-side safety net at Vast**

Search the Vast docs and CLI help for scheduled destroy, instance time limits, or per-account spend caps: `vastai --help`, `vastai create instance --help`, and the docs site. Record anything usable and how to configure it. If nothing exists, record that and keep residual risk 1 as written.

- [ ] **Step 3: Write findings and commit**

Write `docs/spikes/S5-keys-and-vast-safety-net.md`; record the minimum key expiry (feeds the bot, sub-project 3) and any safety net found.

```bash
git add docs/spikes/S5-keys-and-vast-safety-net.md
git commit -m "docs: record spike S5 findings (ephemeral keys, Vast safety net)"
```

### Task A6: Fold spike results into the spec and config defaults

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-instance-runtime-design.md`

- [ ] **Step 1: Update the spec from the findings**

For each spike write the confirmed facts into the relevant spec sections (4 status column, 5.3 steps 4-5, 9, 10, 16, 17) and replace the "UNVERIFIED" wording. Record the chosen `onstart` strategy, `DESTROY_GONE_MARKERS`, `TS_SERVE_ENABLED`, `COMFY_DIR`, `WORKFLOWS_DIR`, `COMFY_PYTHON`, `SUPERVISOR_CONF`, and `BOOT_TIMEOUT_MIN` values; Task 1 uses them as schema defaults.

- [ ] **Step 2: Ask the user to confirm the updated spec before Phase B starts**

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-16-instance-runtime-design.md
git commit -m "docs: fold spike S1-S5 findings into the spec"
```

---

## Phase B: Implementation (after all spikes pass and the spec is confirmed)

### Task 1: Python scaffold, config schema, config loader and CLI

**Files:**
- Create: `instance/agent/pyproject.toml`, `instance/agent/vastcomfy_agent/__init__.py`, `instance/agent/vastcomfy_agent/clock.py`, `instance/agent/vastcomfy_agent/config.py`
- Create: `contracts/config-schema.yaml`, `instance/allowed-keys.txt`
- Test: `instance/agent/tests/test_clock.py`, `instance/agent/tests/test_config.py`

**Interfaces:**
- Produces: `clock.utc_now()`, `config.KeySpec`, `config.ConfigError`, `config.Config`, `config.load_schema`, `config.parse_env_file`, `config.default_text(spec) -> str`, `config.load_config`, `config.main(argv) -> int`, constant `config.SCHEMA_PATH`.

- [ ] **Step 1: Create the project files**

`instance/agent/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "vastcomfy-agent"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
  "fastapi>=0.110",
  "uvicorn>=0.29",
  "httpx>=0.27",
  "pydantic>=2.6",
  "pyyaml>=6.0",
]

[project.optional-dependencies]
dev = ["pytest>=8", "jsonschema>=4.21"]

[tool.setuptools.packages.find]
include = ["vastcomfy_agent*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

Create `instance/agent/vastcomfy_agent/__init__.py` (empty) and `instance/agent/vastcomfy_agent/clock.py`:

```python
from __future__ import annotations

import time


def utc_now() -> int:
    """Current time as epoch UTC seconds (the only time format used in state files)."""
    return int(time.time())
```

Set up the virtualenv:

```bash
cd instance/agent && python3 -m venv .venv && .venv/bin/pip install -q -e '.[dev]'
```

- [ ] **Step 2: Write the failing tests**

`instance/agent/tests/test_clock.py`:

```python
import time

from vastcomfy_agent.clock import utc_now


def test_utc_now_is_integer_epoch_seconds():
    value = utc_now()
    assert isinstance(value, int)
    assert abs(value - int(time.time())) <= 1
```

`instance/agent/tests/test_config.py`:

```python
import pytest

from vastcomfy_agent import config as cfgmod
from vastcomfy_agent.config import ConfigError, load_config, load_schema, parse_env_file

SCHEMA = """
version: 1
keys:
  - {name: TOKEN, components: [instance], type: str, secret: true, required: true, default: null, description: "a token"}
  - {name: PORT, components: [instance], type: int, secret: false, required: false, default: 8189, description: "a port"}
  - {name: FLAG, components: [instance], type: bool, secret: false, required: false, default: false, description: "a flag"}
  - {name: ITEMS, components: [instance], type: csv, secret: false, required: false, default: "a,b", description: "a list"}
  - {name: NOTE, components: [instance], type: str, secret: false, required: false, default: "", description: "free text"}
  - {name: ONLY_APPS, components: [apps], type: str, secret: false, required: false, default: x, description: "apps only"}
"""


@pytest.fixture
def schema(tmp_path):
    path = tmp_path / "schema.yaml"
    path.write_text(SCHEMA)
    return path


def write_env(tmp_path, text):
    path = tmp_path / ".env"
    path.write_text(text)
    return path


def test_defaults_and_coercion(tmp_path, schema):
    env = write_env(tmp_path, "TOKEN=abc\nPORT=9000\nFLAG=true\nITEMS=x, y ,z\n")
    cfg = load_config(env, "instance", schema)
    assert cfg.token == "abc"
    assert cfg.port == 9000
    assert cfg.flag is True
    assert cfg.items == ["x", "y", "z"]
    assert cfg.note == ""


def test_defaults_applied_when_key_absent(tmp_path, schema):
    cfg = load_config(write_env(tmp_path, "TOKEN=abc\n"), "instance", schema)
    assert cfg.port == 8189
    assert cfg.flag is False
    assert cfg.items == ["a", "b"]


def test_unknown_key_fails_and_names_it(tmp_path, schema):
    env = write_env(tmp_path, "TOKEN=abc\nSURPRISE=1\n")
    with pytest.raises(ConfigError, match="SURPRISE"):
        load_config(env, "instance", schema)


def test_key_of_another_component_is_unknown(tmp_path, schema):
    env = write_env(tmp_path, "TOKEN=abc\nONLY_APPS=1\n")
    with pytest.raises(ConfigError, match="ONLY_APPS"):
        load_config(env, "instance", schema)


def test_missing_required_key_fails_and_names_it(tmp_path, schema):
    with pytest.raises(ConfigError, match="TOKEN"):
        load_config(write_env(tmp_path, "PORT=1\n"), "instance", schema)


def test_empty_required_value_counts_as_missing(tmp_path, schema):
    with pytest.raises(ConfigError, match="TOKEN"):
        load_config(write_env(tmp_path, "TOKEN=\n"), "instance", schema)


def test_bad_int_and_bad_bool_fail(tmp_path, schema):
    with pytest.raises(ConfigError, match="PORT"):
        load_config(write_env(tmp_path, "TOKEN=a\nPORT=abc\n"), "instance", schema)
    with pytest.raises(ConfigError, match="FLAG"):
        load_config(write_env(tmp_path, "TOKEN=a\nFLAG=yes\n"), "instance", schema)


def test_secret_never_appears_in_repr_or_redacted(tmp_path, schema):
    cfg = load_config(write_env(tmp_path, "TOKEN=supersecret\n"), "instance", schema)
    assert "supersecret" not in repr(cfg)
    assert cfg.redacted()["TOKEN"] == "***"
    assert cfg.redacted()["PORT"] == 8189


def test_value_with_equals_hash_and_spaces_round_trips(tmp_path, schema):
    # Review focus 2: tokens and URLs contain '=', '#', and may end with a space.
    env = write_env(tmp_path, "TOKEN=a=b#c d \nNOTE=x=y\n")
    cfg = load_config(env, "instance", schema)
    assert cfg.token == "a=b#c d "
    assert cfg.note == "x=y"


def test_parse_env_file_skips_blanks_and_comments(tmp_path):
    env = write_env(tmp_path, "# comment\n\nA=1\n  # indented comment\nB=2\n")
    assert parse_env_file(env) == {"A": "1", "B": "2"}


def test_parse_env_file_rejects_line_without_equals(tmp_path):
    with pytest.raises(ConfigError, match=":2:"):
        parse_env_file(write_env(tmp_path, "A=1\nBROKEN\n"))


def test_duplicate_schema_keys_are_rejected(tmp_path):
    path = tmp_path / "schema.yaml"
    path.write_text(
        "version: 1\nkeys:\n"
        "  - {name: A, components: [instance], type: str, secret: false, required: false, default: '', description: d}\n"
        "  - {name: A, components: [instance], type: str, secret: false, required: false, default: '', description: d}\n"
    )
    with pytest.raises(ConfigError, match="duplicate"):
        load_schema(path)


def test_real_schema_is_valid_and_has_the_essential_keys():
    specs = load_schema()
    names = {s.name for s in specs}
    assert {"CONTAINER_ID", "CONTAINER_API_KEY", "AGENT_TOKEN", "STATE_DIR", "IDLE_MINUTES",
            "FAILSAFE_HOURS", "HARD_CAP_HOURS", "VASTAI_BIN", "VAST_API_KEY", "DISCORD_BOT_TOKEN"} <= names
    secrets = {s.name for s in specs if s.secret}
    assert {"CONTAINER_API_KEY", "AGENT_TOKEN", "TS_AUTHKEY", "HF_TOKEN", "VAST_API_KEY"} <= secrets
    for spec in specs:
        assert spec.type in {"str", "int", "bool", "csv"}, spec.name
        assert spec.components and set(spec.components) <= {"instance", "apps"}, spec.name
        assert spec.description, spec.name
        if not spec.required and spec.type != "str":
            assert spec.default is not None, f"{spec.name} needs a default"


def test_main_list_marks_secrets_and_hides_their_defaults(capsys):
    assert cfgmod.main(["list", "--component", "instance"]) == 0
    out = capsys.readouterr().out
    assert "CONTAINER_API_KEY" in out and "secret" in out


def test_main_init_writes_empty_env_and_refuses_to_overwrite(tmp_path):
    target = tmp_path / ".env"
    assert cfgmod.main(["init", "--component", "instance", "--out", str(target)]) == 0
    text = target.read_text()
    assert "CONTAINER_API_KEY=" in text
    assert cfgmod.main(["init", "--component", "instance", "--out", str(target)]) == 1


def test_gen_keys_matches_committed_allowed_keys_file(tmp_path):
    generated = tmp_path / "keys.txt"
    assert cfgmod.main(["gen-keys", "--out", str(generated)]) == 0
    committed = cfgmod.SCHEMA_PATH.parents[1] / "instance" / "allowed-keys.txt"
    assert committed.read_text() == generated.read_text()
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_clock.py tests/test_config.py -q`
Expected: FAIL (`ModuleNotFoundError: vastcomfy_agent.config`).

- [ ] **Step 4: Write the schema**

Create `contracts/config-schema.yaml` (paths marked "S1" are placeholders that Task A6 replaces with the spike findings):

```yaml
version: 1
keys:
  # --- credentials injected by Vast or by the bot (instance) ---
  - {name: CONTAINER_ID, components: [instance], type: str, secret: false, required: true, default: null, description: "Vast instance id (injected by Vast)"}
  - {name: CONTAINER_API_KEY, components: [instance], type: str, secret: true, required: true, default: null, description: "Per-instance Vast key, can only manage its own instance (injected by Vast)"}
  - {name: AGENT_TOKEN, components: [instance], type: str, secret: true, required: true, default: null, description: "Bearer token for the agent API, one per instance (created by the bot)"}
  - {name: TS_AUTHKEY, components: [instance], type: str, secret: true, required: false, default: "", description: "Single-use Tailscale auth key, blanked after use"}
  - {name: HF_TOKEN, components: [instance], type: str, secret: true, required: false, default: "", description: "Optional Hugging Face token for model downloads"}
  # --- identity and bootstrap inputs (instance) ---
  - {name: TS_HOSTNAME, components: [instance], type: str, secret: false, required: true, default: null, description: "Unique tailnet hostname for this instance"}
  - {name: TS_TAG, components: [instance], type: str, secret: false, required: false, default: "tag:gpu", description: "Tailscale tag advertised by the instance"}
  - {name: TS_SOCKET, components: [instance], type: str, secret: false, required: false, default: "/var/run/tailscale/tailscaled.sock", description: "tailscaled socket path"}
  - {name: TS_SERVE_ENABLED, components: [instance], type: bool, secret: false, required: false, default: false, description: "Run tailscale serve forwards (decided by spike S2)"}
  - {name: REPO_URL, components: [instance], type: str, secret: false, required: true, default: null, description: "Git URL of this repository"}
  - {name: REPO_COMMIT, components: [instance], type: str, secret: false, required: true, default: null, description: "Pinned commit that bootstrap checks out"}
  - {name: PROFILE, components: [instance], type: str, secret: false, required: true, default: null, description: "Profile name, e.g. image"}
  - {name: KEEP_ON_FAILURE, components: [instance], type: bool, secret: false, required: false, default: false, description: "Do not self-destroy on boot failure (debugging only)"}
  # --- paths ---
  - {name: STATE_DIR, components: [instance], type: str, secret: false, required: false, default: "/var/lib/vastcomfy", description: "Persistent state directory"}
  - {name: ENV_FILE_PATH, components: [instance], type: str, secret: false, required: false, default: "/etc/vastcomfy/.env", description: "Where bootstrap writes the instance .env"}
  - {name: REPO_DIR, components: [instance], type: str, secret: false, required: false, default: "/opt/vast-comfy", description: "Where the repo is cloned"}
  - {name: COMFY_DIR, components: [instance], type: str, secret: false, required: false, default: "/workspace/ComfyUI", description: "ComfyUI install directory (S1)"}
  - {name: WORKFLOWS_DIR, components: [instance], type: str, secret: false, required: false, default: "/workspace/ComfyUI/user/default/workflows", description: "ComfyUI user workflows directory (S1)"}
  - {name: SUPERVISOR_CONF, components: [instance], type: str, secret: false, required: false, default: "/opt/vast-comfy/instance/supervisord.conf", description: "supervisord config path"}
  # --- network ---
  - {name: COMFY_HOST, components: [instance], type: str, secret: false, required: false, default: "127.0.0.1", description: "ComfyUI bind/connect host"}
  - {name: COMFY_PORT, components: [instance], type: int, secret: false, required: false, default: 8188, description: "ComfyUI port"}
  - {name: AGENT_HOST, components: [instance], type: str, secret: false, required: false, default: "127.0.0.1", description: "Agent bind host"}
  - {name: AGENT_PORT, components: [instance], type: int, secret: false, required: false, default: 8189, description: "Agent port"}
  - {name: HTTP_TIMEOUT_S, components: [instance], type: int, secret: false, required: false, default: 5, description: "Timeout for local HTTP calls"}
  - {name: HF_BASE_URL, components: [instance], type: str, secret: false, required: false, default: "https://huggingface.co", description: "Model download host"}
  - {name: GIT_HOST_URL, components: [instance], type: str, secret: false, required: false, default: "https://github.com", description: "Host used to clone custom nodes"}
  # --- binaries ---
  - {name: VASTAI_BIN, components: [instance], type: str, secret: false, required: false, default: "vastai", description: "vastai CLI used for self-destroy"}
  - {name: SUPERVISORCTL_BIN, components: [instance], type: str, secret: false, required: false, default: "supervisorctl", description: "supervisorctl binary"}
  - {name: SUPERVISORD_BIN, components: [instance], type: str, secret: false, required: false, default: "supervisord", description: "supervisord binary"}
  - {name: TAILSCALE_BIN, components: [instance], type: str, secret: false, required: false, default: "tailscale", description: "tailscale CLI binary"}
  - {name: NVIDIA_SMI_BIN, components: [instance], type: str, secret: false, required: false, default: "nvidia-smi", description: "nvidia-smi binary"}
  - {name: GIT_BIN, components: [instance], type: str, secret: false, required: false, default: "git", description: "git binary"}
  - {name: PIP_BIN, components: [instance], type: str, secret: false, required: false, default: "pip", description: "pip binary for custom node requirements"}
  - {name: COMFY_PROGRAM, components: [instance], type: str, secret: false, required: false, default: "comfyui", description: "supervisord program name of ComfyUI"}
  # --- timing and limits ---
  - {name: IDLE_MINUTES, components: [instance], type: int, secret: false, required: false, default: 30, description: "Idle minutes before destroy"}
  - {name: IDLE_WARN_MINUTES, components: [instance], type: int, secret: false, required: false, default: 10, description: "Minutes before the idle destroy at which state becomes idle-warning"}
  - {name: FAILSAFE_HOURS, components: [instance], type: int, secret: false, required: false, default: 3, description: "Default failsafe lifetime"}
  - {name: HARD_CAP_HOURS, components: [instance], type: int, secret: false, required: false, default: 6, description: "Absolute lifetime cap, never extendable"}
  - {name: FAILSAFE_POLL_S, components: [instance], type: int, secret: false, required: false, default: 30, description: "failsafe.sh loop interval"}
  - {name: COMFY_POLL_S, components: [instance], type: int, secret: false, required: false, default: 5, description: "Agent runner tick interval"}
  - {name: EXTEND_MAX_IDLE_MIN, components: [instance], type: int, secret: false, required: false, default: 120, description: "Max minutes per /extend idle call"}
  - {name: EXTEND_MAX_FAILSAFE_MIN, components: [instance], type: int, secret: false, required: false, default: 180, description: "Max minutes per /extend failsafe call"}
  - {name: DESTROY_RETRIES, components: [instance], type: int, secret: false, required: false, default: 5, description: "Destroy attempts before destroy_failed"}
  - {name: DESTROY_BACKOFF_S, components: [instance], type: int, secret: false, required: false, default: 120, description: "Seconds between destroy attempts"}
  - {name: DESTROY_TIMEOUT_S, components: [instance], type: int, secret: false, required: false, default: 60, description: "Timeout of one vastai call"}
  - {name: DESTROY_GONE_MARKERS, components: [instance], type: csv, secret: false, required: false, default: "404,not found,no such instance", description: "Output fragments meaning the instance is already gone (S4)"}
  - {name: DOWNLOAD_RETRIES, components: [instance], type: int, secret: false, required: false, default: 3, description: "Download attempts per file"}
  - {name: DOWNLOAD_BACKOFF_S, components: [instance], type: int, secret: false, required: false, default: 5, description: "Seconds between download attempts"}
  - {name: DOWNLOAD_CHUNK_BYTES, components: [instance], type: int, secret: false, required: false, default: 1048576, description: "Download chunk size"}
  - {name: DISK_MARGIN_MB, components: [instance], type: int, secret: false, required: false, default: 2048, description: "Free disk to keep after downloads"}
  - {name: WORKFLOW_MAX_BYTES, components: [instance], type: int, secret: false, required: false, default: 1048576, description: "Max accepted workflow size"}
  - {name: COMFY_START_TIMEOUT_S, components: [instance], type: int, secret: false, required: false, default: 300, description: "Wait for ComfyUI to answer"}
  - {name: AGENT_START_TIMEOUT_S, components: [instance], type: int, secret: false, required: false, default: 60, description: "Wait for the agent to answer"}
  # --- apps (homelab, sub-projects 2-3; listed so the schema is the single registry) ---
  - {name: VAST_API_KEY, components: [apps], type: str, secret: true, required: true, default: null, description: "Main Vast API key, lives on the homelab only"}
  - {name: VAST_API_URL, components: [apps], type: str, secret: false, required: false, default: "https://console.vast.ai/api/v0", description: "Vast REST API base URL"}
  - {name: TS_API_CREDENTIAL, components: [apps], type: str, secret: true, required: true, default: null, description: "Tailscale OAuth credential used to mint auth keys"}
  - {name: DISCORD_BOT_TOKEN, components: [apps], type: str, secret: true, required: true, default: null, description: "Discord bot token"}
  - {name: DISCORD_ADMIN_USER_IDS, components: [apps], type: csv, secret: false, required: true, default: null, description: "Discord user ids allowed to start/destroy/extend"}
  - {name: DISCORD_ALERT_TARGET, components: [apps], type: str, secret: false, required: true, default: null, description: "Channel or user that receives alerts"}
  - {name: OUTPUT_DIR, components: [apps], type: str, secret: false, required: false, default: "output", description: "Where saved generations are written"}
  - {name: WATCHDOG_INTERVAL_S, components: [apps], type: int, secret: false, required: false, default: 180, description: "Watchdog polling interval"}
  - {name: BOOT_TIMEOUT_MIN, components: [apps], type: int, secret: false, required: false, default: 25, description: "Destroy an instance that is not ready after this long"}
  - {name: UNREACHABLE_WARN_MIN, components: [apps], type: int, secret: false, required: false, default: 10, description: "Warn when /status is unreachable this long"}
  - {name: UNREACHABLE_DESTROY_MIN, components: [apps], type: int, secret: false, required: false, default: 15, description: "Destroy when /status is unreachable this long"}
  - {name: ALERT_REPEAT_MIN, components: [apps], type: int, secret: false, required: false, default: 5, description: "Repeat urgent alerts at this interval"}
```

- [ ] **Step 5: Write `config.py`**

```python
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

# instance/agent/vastcomfy_agent/config.py -> repository root is parents[3]
SCHEMA_PATH = Path(__file__).resolve().parents[3] / "contracts" / "config-schema.yaml"

_TYPES = {"str", "int", "bool", "csv"}


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class KeySpec:
    name: str
    components: tuple[str, ...]
    type: str
    secret: bool
    required: bool
    default: Any
    description: str


def load_schema(path: Path | None = None) -> list[KeySpec]:
    raw = yaml.safe_load((path or SCHEMA_PATH).read_text())
    specs: list[KeySpec] = []
    for item in raw["keys"]:
        if item["type"] not in _TYPES:
            raise ConfigError(f"{item['name']}: unknown type {item['type']!r}")
        specs.append(
            KeySpec(
                name=item["name"],
                components=tuple(item["components"]),
                type=item["type"],
                secret=bool(item["secret"]),
                required=bool(item["required"]),
                default=item.get("default"),
                description=item["description"],
            )
        )
    names = [s.name for s in specs]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        raise ConfigError(f"duplicate keys in schema: {', '.join(dupes)}")
    return specs


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines. No quoting, no expansion; the value is everything after the first '='."""
    values: dict[str, str] = {}
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise ConfigError(f"{path}:{lineno}: expected KEY=VALUE")
        key, _, value = line.lstrip().partition("=")
        values[key.strip()] = value
    return values


def default_text(spec: KeySpec) -> str:
    default = spec.default
    if default is None:
        return ""
    if isinstance(default, bool):
        return "true" if default else "false"
    if isinstance(default, (list, tuple)):
        return ",".join(str(x) for x in default)
    return str(default)


def _coerce(spec: KeySpec, text: str) -> Any:
    if spec.type == "str":
        return text
    if spec.type == "int":
        try:
            return int(text)
        except ValueError:
            raise ConfigError(f"{spec.name}: expected an integer") from None
    if spec.type == "bool":
        if text in ("true", "false"):
            return text == "true"
        raise ConfigError(f"{spec.name}: expected true or false")
    return [part.strip() for part in text.split(",") if part.strip()]


class Config:
    """Typed, read-only view of one component's configuration."""

    def __init__(self, values: dict[str, Any], specs: dict[str, KeySpec]):
        self._values = values
        self._specs = specs

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        try:
            return self._values[name.upper()]
        except KeyError:
            raise AttributeError(name) from None

    def get(self, key: str) -> Any:
        return self._values[key]

    def redacted(self) -> dict[str, Any]:
        return {
            key: ("***" if self._specs[key].secret and value not in ("", None) else value)
            for key, value in self._values.items()
        }

    def __repr__(self) -> str:
        return f"Config({self.redacted()!r})"


def load_config(env_file: Path, component: str, schema_path: Path | None = None) -> Config:
    specs = [s for s in load_schema(schema_path) if component in s.components]
    by_name = {s.name: s for s in specs}
    raw = parse_env_file(env_file)

    unknown = sorted(set(raw) - set(by_name))
    if unknown:
        raise ConfigError(f"unknown keys for component {component!r}: {', '.join(unknown)}")

    values: dict[str, Any] = {}
    missing: list[str] = []
    for spec in specs:
        text = raw.get(spec.name, "")
        if text == "":
            if spec.required:
                missing.append(spec.name)
                continue
            text = default_text(spec)
        values[spec.name] = _coerce(spec, text)
    if missing:
        raise ConfigError(f"missing required keys for {component!r}: {', '.join(missing)}")
    return Config(values, by_name)


def _specs_for(component: str, schema_path: Path | None) -> list[KeySpec]:
    return [s for s in load_schema(schema_path) if component in s.components]


def cmd_list(component: str, schema_path: Path | None = None) -> int:
    for spec in _specs_for(component, schema_path):
        flags = ["secret" if spec.secret else "plain", "required" if spec.required else "optional"]
        default = "" if spec.secret else default_text(spec)
        print(f"{spec.name:28} {' '.join(flags):18} default={default!r:34} {spec.description}")
    return 0


def cmd_init(component: str, out: Path, schema_path: Path | None = None) -> int:
    if out.exists():
        print(f"refusing to overwrite {out}", file=sys.stderr)
        return 1
    lines: list[str] = []
    for spec in _specs_for(component, schema_path):
        lines.append(f"# {spec.description}")
        if spec.required or spec.secret:
            lines.append(f"{spec.name}=")
        else:
            lines.append(f"#{spec.name}={default_text(spec)}")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n")
    out.chmod(0o600)
    return 0


def cmd_gen_keys(out: Path, schema_path: Path | None = None) -> int:
    names = sorted(s.name for s in _specs_for("instance", schema_path))
    out.write_text("\n".join(names) + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vastcomfy_agent.config")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "init"):
        p = sub.add_parser(name)
        p.add_argument("--component", default="instance", choices=["instance", "apps"])
        if name == "init":
            p.add_argument("--out", type=Path, required=True)
    gen = sub.add_parser("gen-keys")
    gen.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "list":
        return cmd_list(args.component)
    if args.command == "init":
        return cmd_init(args.component, args.out)
    return cmd_gen_keys(args.out)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: Generate the committed key list**

Run: `cd instance/agent && .venv/bin/python -m vastcomfy_agent.config gen-keys --out ../allowed-keys.txt`
Expected: `instance/allowed-keys.txt` exists with one key name per line.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_clock.py tests/test_config.py -q`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add instance/agent contracts/config-schema.yaml instance/allowed-keys.txt
git commit -m "feat: add config schema, loader and CLI for the instance agent"
```

### Task 2: Atomic files, state paths and the state machine

**Files:**
- Create: `instance/agent/vastcomfy_agent/files.py`, `paths.py`, `state.py`
- Test: `instance/agent/tests/test_files.py`, `tests/test_state.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `files.atomic_write/read_int/write_int/read_json/write_json`, `paths.StatePaths`, `state.State`, `state.REASONS`, `state.InvalidTransition`, `state.StateRecord`, `state.StateStore`.

- [ ] **Step 1: Write the failing tests**

`instance/agent/tests/test_files.py`:

```python
import os

import pytest

from vastcomfy_agent import files
from vastcomfy_agent.paths import StatePaths


def test_atomic_write_creates_parents_and_replaces(tmp_path):
    target = tmp_path / "a" / "b.txt"
    files.atomic_write(target, "one")
    files.atomic_write(target, "two")
    assert target.read_text() == "two"
    assert [p.name for p in target.parent.iterdir()] == ["b.txt"]


def test_atomic_write_leaves_old_content_and_no_temp_on_failure(tmp_path, monkeypatch):
    target = tmp_path / "f"
    files.atomic_write(target, "old")

    def boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        files.atomic_write(target, "new")
    monkeypatch.undo()
    assert target.read_text() == "old"
    assert [p.name for p in tmp_path.iterdir()] == ["f"]


def test_read_int_handles_missing_and_corrupt(tmp_path):
    assert files.read_int(tmp_path / "missing") is None
    (tmp_path / "bad").write_text("12abc")
    assert files.read_int(tmp_path / "bad") is None
    files.write_int(tmp_path / "ok", 1700000000)
    assert files.read_int(tmp_path / "ok") == 1700000000


def test_read_json_default_on_missing_or_corrupt(tmp_path):
    assert files.read_json(tmp_path / "missing", {"x": 1}) == {"x": 1}
    (tmp_path / "bad.json").write_text("{not json")
    assert files.read_json(tmp_path / "bad.json") is None
    files.write_json(tmp_path / "ok.json", {"b": 1, "a": 2})
    assert files.read_json(tmp_path / "ok.json") == {"a": 2, "b": 1}


def test_state_paths_use_the_documented_file_names(tmp_path):
    p = StatePaths(tmp_path)
    assert p.state_json.name == "state.json"
    assert p.progress_json.name == "progress.json"
    assert p.first_boot_at.name == "first_boot_at"
    assert p.hard_cap.name == "hard_cap"
    assert p.deadline.name == "deadline"
    assert p.idle_destroy_at.name == "idle_destroy_at"
    assert p.failsafe_pid.name == "failsafe.pid"
    assert p.destroy_failsafe.name == "destroy_failsafe.json"
    assert p.destroy_agent.name == "destroy_agent.json"
    with pytest.raises(AttributeError):
        p.nope
```

`instance/agent/tests/test_state.py`:

```python
import pytest

from vastcomfy_agent.state import REASONS, InvalidTransition, State, StateStore

VALID = [
    (None, State.BOOTING), (None, State.FAILED),
    (State.BOOTING, State.DOWNLOADING), (State.BOOTING, State.FAILED), (State.BOOTING, State.STOPPING),
    (State.DOWNLOADING, State.READY), (State.DOWNLOADING, State.FAILED), (State.DOWNLOADING, State.STOPPING),
    (State.READY, State.IDLE_WARNING), (State.READY, State.STOPPING),
    (State.IDLE_WARNING, State.READY), (State.IDLE_WARNING, State.STOPPING),
    (State.FAILED, State.STOPPING),
    (State.STOPPING, State.DESTROY_FAILED),
    (State.DESTROY_FAILED, State.STOPPING),
]

INVALID = [
    (None, State.READY), (State.BOOTING, State.READY), (State.READY, State.FAILED),
    (State.READY, State.BOOTING), (State.STOPPING, State.READY), (State.FAILED, State.READY),
    (State.DESTROY_FAILED, State.READY), (State.IDLE_WARNING, State.FAILED),
]


def make(tmp_path, t=1000):
    return StateStore(tmp_path, lambda: t)


def force(store, state):
    # Walk the shortest legal path to reach `state`.
    paths = {
        None: [], State.BOOTING: [State.BOOTING], State.DOWNLOADING: [State.BOOTING, State.DOWNLOADING],
        State.READY: [State.BOOTING, State.DOWNLOADING, State.READY],
        State.IDLE_WARNING: [State.BOOTING, State.DOWNLOADING, State.READY, State.IDLE_WARNING],
        State.FAILED: [State.FAILED], State.STOPPING: [State.BOOTING, State.STOPPING],
        State.DESTROY_FAILED: [State.BOOTING, State.STOPPING, State.DESTROY_FAILED],
    }
    for step in paths[state]:
        store.set(step)


@pytest.mark.parametrize("src,dst", VALID)
def test_valid_transitions(tmp_path, src, dst):
    store = make(tmp_path)
    force(store, src)
    assert store.set(dst).state == dst


@pytest.mark.parametrize("src,dst", INVALID)
def test_invalid_transitions(tmp_path, src, dst):
    store = make(tmp_path)
    force(store, src)
    with pytest.raises(InvalidTransition):
        store.set(dst)
    assert store.get().state == src


def test_same_state_is_idempotent_and_keeps_original_reason(tmp_path):
    store = make(tmp_path)
    store.set(State.BOOTING)
    store.set(State.STOPPING, "manual")
    again = store.set(State.STOPPING, "watchdog")
    assert again.reason == "manual"


def test_reason_must_be_known(tmp_path):
    store = make(tmp_path)
    with pytest.raises(ValueError):
        store.set(State.FAILED, "because")
    assert "missing_container_credentials" in REASONS and "failsafe_failed" in REASONS


def test_state_persists_across_instances_and_records_time(tmp_path):
    make(tmp_path, 1234).set(State.FAILED, "hard_cap_missing")
    record = make(tmp_path, 9999).get()
    assert (record.state, record.reason, record.updated_at) == (State.FAILED, "hard_cap_missing", 1234)


def test_missing_or_unknown_state_file_reads_as_none(tmp_path):
    assert make(tmp_path).get().state is None
    (tmp_path / "state.json").write_text('{"state": "weird", "reason": null, "updated_at": 1}')
    assert make(tmp_path).get().state is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_files.py tests/test_state.py -q`
Expected: FAIL (`ModuleNotFoundError: vastcomfy_agent.files`).

- [ ] **Step 3: Implement `files.py`, `paths.py`, `state.py`**

`files.py`:

```python
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write(path: Path, data: str) -> None:
    """Write via a temp file in the same directory, then rename (readers never see a partial file)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def read_int(path: Path) -> int | None:
    try:
        return int(Path(path).read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


def write_int(path: Path, value: int) -> None:
    atomic_write(path, f"{value}\n")


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, value: Any) -> None:
    atomic_write(path, json.dumps(value, sort_keys=True) + "\n")
```

`paths.py`:

```python
from __future__ import annotations

from pathlib import Path

# File names are a protocol shared with failsafe.sh (spec 5.2).
_NAMES = {
    "state_json": "state.json",
    "progress_json": "progress.json",
    "first_boot_at": "first_boot_at",
    "hard_cap": "hard_cap",
    "deadline": "deadline",
    "idle_destroy_at": "idle_destroy_at",
    "failsafe_pid": "failsafe.pid",
    "destroy_failsafe": "destroy_failsafe.json",
    "destroy_agent": "destroy_agent.json",
}


class StatePaths:
    def __init__(self, root: Path):
        self.root = Path(root)

    def __getattr__(self, name: str) -> Path:
        if name in _NAMES:
            return self.root / _NAMES[name]
        raise AttributeError(name)
```

`state.py`:

```python
from __future__ import annotations

import threading
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable

from .files import read_json, write_json
from .paths import StatePaths


class State(str, Enum):
    BOOTING = "booting"
    DOWNLOADING = "downloading"
    READY = "ready"
    IDLE_WARNING = "idle-warning"
    STOPPING = "stopping"
    FAILED = "failed"
    DESTROY_FAILED = "destroy_failed"


REASONS = frozenset(
    {
        "missing_container_credentials", "config_invalid", "hard_cap_missing", "failsafe_failed",
        "tailscale_failed", "node_install_failed", "download_failed", "disk_insufficient",
        "comfyui_start_failed", "idle_timeout", "failsafe_deadline", "manual", "watchdog",
    }
)

TRANSITIONS: dict[State | None, frozenset[State]] = {
    None: frozenset({State.BOOTING, State.FAILED}),
    State.BOOTING: frozenset({State.DOWNLOADING, State.FAILED, State.STOPPING}),
    State.DOWNLOADING: frozenset({State.READY, State.FAILED, State.STOPPING}),
    State.READY: frozenset({State.IDLE_WARNING, State.STOPPING}),
    State.IDLE_WARNING: frozenset({State.READY, State.STOPPING}),
    State.FAILED: frozenset({State.STOPPING}),
    State.STOPPING: frozenset({State.DESTROY_FAILED}),
    State.DESTROY_FAILED: frozenset({State.STOPPING}),
}


class InvalidTransition(Exception):
    pass


@dataclass(frozen=True)
class StateRecord:
    state: State | None
    reason: str | None
    updated_at: int | None


class StateStore:
    def __init__(self, state_dir: Path, now: Callable[[], int]):
        self._path = StatePaths(state_dir).state_json
        self._now = now
        self._lock = threading.Lock()

    def get(self) -> StateRecord:
        data = read_json(self._path)
        if not isinstance(data, dict):
            return StateRecord(None, None, None)
        try:
            state = State(data.get("state"))
        except ValueError:
            return StateRecord(None, None, None)
        return StateRecord(state, data.get("reason"), data.get("updated_at"))

    def set(self, new: State, reason: str | None = None) -> StateRecord:
        if reason is not None and reason not in REASONS:
            raise ValueError(f"unknown reason {reason!r}")
        with self._lock:
            current = self.get()
            if current.state == new:
                return current
            if new not in TRANSITIONS.get(current.state, frozenset()):
                raise InvalidTransition(f"{current.state} -> {new}")
            record = StateRecord(new, reason, self._now())
            write_json(
                self._path,
                {"state": new.value, "reason": reason, "updated_at": record.updated_at},
            )
            return record
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_files.py tests/test_state.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add instance/agent
git commit -m "feat: add atomic file helpers, state paths and state machine"
```

### Task 3: Deadlines, extend rules and the idle watcher

**Files:**
- Create: `instance/agent/vastcomfy_agent/deadlines.py`, `idle.py`
- Test: `instance/agent/tests/test_deadlines.py`, `tests/test_idle.py`

**Interfaces:**
- Consumes: `files.read_int/write_int`, `paths.StatePaths`, `state.State/StateStore`.
- Produces: `deadlines.ExtendError(code, message)`, `deadlines.DeadlineStore`, `idle.IdleWatcher`.

- [ ] **Step 1: Write the failing tests**

`instance/agent/tests/test_deadlines.py`:

```python
import pytest

from vastcomfy_agent.deadlines import DeadlineStore, ExtendError

T0 = 1_000_000


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def make(tmp_path, clock=None):
    return DeadlineStore(tmp_path, clock or Clock())


def test_first_boot_writes_all_files(tmp_path):
    store = make(tmp_path)
    assert store.init_first_boot(failsafe_hours=3, hard_cap_hours=6) == "fresh"
    assert store.first_boot_at() == T0
    assert store.deadline() == T0 + 3 * 3600
    assert store.hard_cap() == T0 + 6 * 3600


def test_deadline_never_exceeds_hard_cap_at_creation(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(failsafe_hours=9, hard_cap_hours=6)
    assert store.deadline() == store.hard_cap()


def test_restart_does_not_rewrite_files_even_when_deadline_passed(tmp_path):
    # Review focus 3: restart after the deadline already passed.
    clock = Clock()
    make(tmp_path, clock).init_first_boot(3, 6)
    clock.t = T0 + 10 * 3600
    again = make(tmp_path, clock)
    assert again.init_first_boot(3, 6) == "restart"
    assert again.deadline() == T0 + 3 * 3600
    assert again.hard_cap() == T0 + 6 * 3600


def test_missing_hard_cap_after_first_boot_is_reported_not_recomputed(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    (tmp_path / "hard_cap").unlink()
    assert store.init_first_boot(3, 6) == "hard_cap_missing"
    assert store.hard_cap() is None


def test_crash_before_first_boot_marker_is_treated_as_fresh(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    (tmp_path / "first_boot_at").unlink()
    assert store.init_first_boot(3, 6) == "fresh"


def test_extend_failsafe_moves_deadline(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    new = store.extend_failsafe(60, max_per_call=180)
    assert new == T0 + 4 * 3600
    assert store.deadline() == new


def test_extend_failsafe_beyond_hard_cap_is_rejected_with_the_remaining_minutes(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    with pytest.raises(ExtendError) as err:
        store.extend_failsafe(181, max_per_call=999)
    assert err.value.code == "beyond_hard_cap"
    assert "180" in err.value.message
    assert store.deadline() == T0 + 3 * 3600


@pytest.mark.parametrize("bad", [0, -5, 10**9, "10", 1.5, True, None])
def test_extend_rejects_hostile_minutes_and_changes_nothing(tmp_path, bad):
    # Review focus 1.
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    store.set_idle_destroy_at(T0 + 1800)
    with pytest.raises(ExtendError):
        store.extend_failsafe(bad, max_per_call=180)
    with pytest.raises(ExtendError):
        store.extend_idle(bad, max_per_call=120)
    assert store.deadline() == T0 + 3 * 3600
    assert store.idle_destroy_at() == T0 + 1800


def test_extend_idle_moves_idle_destroy_at_and_respects_hard_cap(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    store.set_idle_destroy_at(T0 + 1800)
    assert store.extend_idle(30, max_per_call=120) == T0 + 3600
    store.set_idle_destroy_at(T0 + 6 * 3600 - 60)
    with pytest.raises(ExtendError) as err:
        store.extend_idle(5, max_per_call=120)
    assert err.value.code == "beyond_hard_cap"


def test_extend_idle_before_the_idle_timer_started_is_rejected(tmp_path):
    store = make(tmp_path)
    store.init_first_boot(3, 6)
    with pytest.raises(ExtendError) as err:
        store.extend_idle(10, max_per_call=120)
    assert err.value.code == "not_ready"


def test_extend_without_hard_cap_is_rejected(tmp_path):
    store = make(tmp_path)
    with pytest.raises(ExtendError) as err:
        store.extend_failsafe(10, max_per_call=180)
    assert err.value.code == "hard_cap_missing"
```

`instance/agent/tests/test_idle.py`:

```python
from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.idle import IdleWatcher
from vastcomfy_agent.state import State, StateStore

T0 = 5_000_000


class Clock:
    def __init__(self):
        self.t = T0

    def __call__(self):
        return self.t


def setup(tmp_path):
    clock = Clock()
    states = StateStore(tmp_path, clock)
    for s in (State.BOOTING, State.DOWNLOADING, State.READY):
        states.set(s)
    deadlines = DeadlineStore(tmp_path, clock)
    deadlines.init_first_boot(3, 6)
    watcher = IdleWatcher(states, deadlines, clock, idle_minutes=30, warn_minutes=10)
    watcher.start()
    return clock, states, deadlines, watcher


def test_start_sets_idle_destroy_at(tmp_path):
    clock, _, deadlines, _ = setup(tmp_path)
    assert deadlines.idle_destroy_at() == T0 + 1800


def test_empty_queue_warns_then_destroys_on_schedule(tmp_path):
    clock, states, _, watcher = setup(tmp_path)
    clock.t = T0 + 19 * 60
    assert watcher.tick(0) == "none" and states.get().state == State.READY
    clock.t = T0 + 20 * 60
    assert watcher.tick(0) == "warn" and states.get().state == State.IDLE_WARNING
    assert watcher.tick(0) == "none"
    clock.t = T0 + 30 * 60
    assert watcher.tick(0) == "destroy"


def test_busy_queue_resets_timer_and_leaves_warning(tmp_path):
    clock, states, deadlines, watcher = setup(tmp_path)
    clock.t = T0 + 25 * 60
    watcher.tick(0)
    assert states.get().state == State.IDLE_WARNING
    assert watcher.tick(2) == "none"
    assert states.get().state == State.READY
    assert deadlines.idle_destroy_at() == clock.t + 1800


def test_extend_while_warning_returns_to_ready(tmp_path):
    clock, states, deadlines, watcher = setup(tmp_path)
    clock.t = T0 + 22 * 60
    watcher.tick(0)
    deadlines.extend_idle(30, max_per_call=120)
    assert watcher.tick(0) == "none"
    assert states.get().state == State.READY


def test_unknown_queue_counts_as_idle_and_never_resets_the_timer(tmp_path):
    # Review focus 4: ComfyUI down while ready.
    clock, states, deadlines, watcher = setup(tmp_path)
    clock.t = T0 + 21 * 60
    assert watcher.tick(None) == "warn"
    clock.t = T0 + 31 * 60
    assert watcher.tick(None) == "destroy"
    assert deadlines.idle_destroy_at() == T0 + 1800


def test_idle_state_survives_a_new_watcher_instance(tmp_path):
    clock, states, deadlines, _ = setup(tmp_path)
    clock.t = T0 + 29 * 60
    fresh = IdleWatcher(states, deadlines, clock, idle_minutes=30, warn_minutes=10)
    assert fresh.tick(0) == "warn"
    clock.t = T0 + 30 * 60
    assert fresh.tick(0) == "destroy"


def test_only_ready_states_are_watched(tmp_path):
    clock = Clock()
    states = StateStore(tmp_path, clock)
    states.set(State.BOOTING)
    deadlines = DeadlineStore(tmp_path, clock)
    watcher = IdleWatcher(states, deadlines, clock, 30, 10)
    clock.t = T0 + 10**6
    assert watcher.tick(0) == "none"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_deadlines.py tests/test_idle.py -q`
Expected: FAIL (`ModuleNotFoundError: vastcomfy_agent.deadlines`).

- [ ] **Step 3: Implement `deadlines.py` and `idle.py`**

`deadlines.py`:

```python
from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

from .files import read_int, write_int
from .paths import StatePaths


class ExtendError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _validate_minutes(minutes: object, max_per_call: int) -> int:
    if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes <= 0:
        raise ExtendError("invalid_minutes", "minutes must be a positive integer")
    if minutes > max_per_call:
        raise ExtendError("too_large", f"at most {max_per_call} minutes per call")
    return minutes


class DeadlineStore:
    def __init__(self, state_dir: Path, now: Callable[[], int]):
        self._p = StatePaths(state_dir)
        self._now = now
        self._lock = threading.Lock()

    def first_boot_at(self) -> int | None:
        return read_int(self._p.first_boot_at)

    def hard_cap(self) -> int | None:
        return read_int(self._p.hard_cap)

    def deadline(self) -> int | None:
        return read_int(self._p.deadline)

    def idle_destroy_at(self) -> int | None:
        return read_int(self._p.idle_destroy_at)

    def set_idle_destroy_at(self, value: int) -> None:
        write_int(self._p.idle_destroy_at, value)

    def init_first_boot(self, failsafe_hours: int, hard_cap_hours: int) -> str:
        """Write the boot files once. Returns 'fresh', 'restart' or 'hard_cap_missing'."""
        with self._lock:
            if self.first_boot_at() is None:
                t = self._now()
                hard_cap = t + hard_cap_hours * 3600
                deadline = min(t + failsafe_hours * 3600, hard_cap)
                write_int(self._p.hard_cap, hard_cap)
                write_int(self._p.deadline, deadline)
                write_int(self._p.first_boot_at, t)  # written last: a crash before it means "still fresh"
                return "fresh"
            if self.hard_cap() is None:
                return "hard_cap_missing"
            return "restart"

    def _require_cap(self) -> int:
        cap = self.hard_cap()
        if cap is None:
            raise ExtendError("hard_cap_missing", "hard cap file is missing")
        return cap

    @staticmethod
    def _check_cap(cap: int, current: int, minutes: int) -> int:
        new = current + minutes * 60
        if new > cap:
            remaining = max(0, (cap - current) // 60)
            raise ExtendError("beyond_hard_cap", f"would pass the hard cap; at most {remaining} more minutes")
        return new

    def extend_failsafe(self, minutes: object, max_per_call: int) -> int:
        minutes = _validate_minutes(minutes, max_per_call)
        with self._lock:
            cap = self._require_cap()
            current = self.deadline()
            if current is None:
                current = cap
            new = self._check_cap(cap, current, minutes)
            write_int(self._p.deadline, new)
            return new

    def extend_idle(self, minutes: object, max_per_call: int) -> int:
        minutes = _validate_minutes(minutes, max_per_call)
        with self._lock:
            cap = self._require_cap()
            current = self.idle_destroy_at()
            if current is None:
                raise ExtendError("not_ready", "idle timer has not started")
            new = self._check_cap(cap, current, minutes)
            write_int(self._p.idle_destroy_at, new)
            return new
```

`idle.py`:

```python
from __future__ import annotations

from typing import Callable

from .deadlines import DeadlineStore
from .state import State, StateStore


class IdleWatcher:
    """Advances the idle timer and the ready <-> idle-warning states. The caller acts on 'destroy'."""

    def __init__(
        self,
        states: StateStore,
        deadlines: DeadlineStore,
        now: Callable[[], int],
        idle_minutes: int,
        warn_minutes: int,
    ):
        self._states = states
        self._deadlines = deadlines
        self._now = now
        self._idle = idle_minutes
        self._warn = warn_minutes

    def start(self) -> None:
        self._deadlines.set_idle_destroy_at(self._now() + self._idle * 60)

    def tick(self, queue_total: int | None) -> str:
        record = self._states.get()
        if record.state not in (State.READY, State.IDLE_WARNING):
            return "none"
        now = self._now()
        if queue_total is not None and queue_total > 0:
            self._deadlines.set_idle_destroy_at(now + self._idle * 60)
            if record.state == State.IDLE_WARNING:
                self._states.set(State.READY)
            return "none"
        destroy_at = self._deadlines.idle_destroy_at()
        if destroy_at is None:
            self.start()
            return "none"
        if now >= destroy_at:
            return "destroy"
        if now >= destroy_at - self._warn * 60:
            if record.state == State.READY:
                self._states.set(State.IDLE_WARNING)
                return "warn"
            return "none"
        if record.state == State.IDLE_WARNING:  # extended while warning
            self._states.set(State.READY)
        return "none"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_deadlines.py tests/test_idle.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add instance/agent
git commit -m "feat: add deadline store with capped extend and the idle watcher"
```

### Task 4: Destroyer and the destroy flow

**Files:**
- Create: `instance/agent/vastcomfy_agent/destroyer.py`, `destroy_flow.py`
- Test: `instance/agent/tests/test_destroyer.py`

**Interfaces:**
- Consumes: `files.write_json`, `paths.StatePaths`, `state.State/StateStore/InvalidTransition`.
- Produces: `destroyer.Destroyer(*, vastai_bin, container_id, api_key, retries, backoff_s, timeout_s, gone_markers, state_dir, run=subprocess.run, sleep=time.sleep)` with `.destroy() -> bool`; `destroy_flow.DestroyFlow(states, destroyer, stop_comfy)` with `.run(reason) -> bool`.

- [ ] **Step 1: Write the failing tests**

`instance/agent/tests/test_destroyer.py`:

```python
import subprocess

from vastcomfy_agent.destroy_flow import DestroyFlow
from vastcomfy_agent.destroyer import Destroyer
from vastcomfy_agent.files import read_json
from vastcomfy_agent.state import State, StateStore

KEY = "k-secret-123"


def proc(code=0, out="", err=""):
    return subprocess.CompletedProcess(args=[], returncode=code, stdout=out, stderr=err)


class FakeRun:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append((cmd, kwargs))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def make(tmp_path, results, retries=3, markers=("404", "not found")):
    run = FakeRun(results)
    sleeps = []
    destroyer = Destroyer(
        vastai_bin="vastai", container_id="42", api_key=KEY, retries=retries, backoff_s=7,
        timeout_s=9, gone_markers=list(markers), state_dir=tmp_path, run=run, sleep=sleeps.append,
    )
    return destroyer, run, sleeps


def test_success_on_first_attempt_builds_the_expected_command(tmp_path):
    destroyer, run, sleeps = make(tmp_path, [proc(0)])
    assert destroyer.destroy() is True
    cmd, kwargs = run.calls[0]
    assert cmd == ["vastai", "destroy", "instance", "42", "--api-key", KEY]
    assert kwargs["timeout"] == 9
    assert sleeps == []
    assert read_json(tmp_path / "destroy_agent.json") == {"attempts": 1, "last_error": None}


def test_retries_with_backoff_then_succeeds(tmp_path):
    destroyer, _, sleeps = make(tmp_path, [proc(1, err="boom"), proc(1, err="boom"), proc(0)])
    assert destroyer.destroy() is True
    assert sleeps == [7, 7]
    assert read_json(tmp_path / "destroy_agent.json")["attempts"] == 3


def test_gives_up_after_the_configured_attempts_and_records_the_error(tmp_path):
    destroyer, run, sleeps = make(tmp_path, [proc(1, err="api down")] * 3)
    assert destroyer.destroy() is False
    assert len(run.calls) == 3 and sleeps == [7, 7]
    record = read_json(tmp_path / "destroy_agent.json")
    assert record == {"attempts": 3, "last_error": "api down"}


def test_already_gone_counts_as_success(tmp_path):
    destroyer, run, _ = make(tmp_path, [proc(1, out="Error: Instance Not Found (404)")])
    assert destroyer.destroy() is True
    assert len(run.calls) == 1


def test_missing_binary_and_timeout_are_failed_attempts_not_crashes(tmp_path):
    destroyer, _, _ = make(
        tmp_path, [FileNotFoundError("vastai"), subprocess.TimeoutExpired("vastai", 9), proc(0)]
    )
    assert destroyer.destroy() is True


def test_error_text_never_contains_the_api_key(tmp_path):
    destroyer, _, _ = make(tmp_path, [proc(1, err=f"bad key {KEY}")] * 3)
    destroyer.destroy()
    assert KEY not in read_json(tmp_path / "destroy_agent.json")["last_error"]


class FakeDestroyer:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    def destroy(self):
        self.calls += 1
        return self.result


def flow_setup(tmp_path, result):
    states = StateStore(tmp_path, lambda: 1)
    for s in (State.BOOTING, State.DOWNLOADING, State.READY):
        states.set(s)
    stopped = []
    destroyer = FakeDestroyer(result)
    return states, destroyer, stopped, DestroyFlow(states, destroyer, lambda: stopped.append(1))


def test_flow_success_leaves_state_stopping_with_reason(tmp_path):
    states, destroyer, stopped, flow = flow_setup(tmp_path, True)
    assert flow.run("idle_timeout") is True
    record = states.get()
    assert (record.state, record.reason) == (State.STOPPING, "idle_timeout")
    assert stopped == []


def test_flow_failure_marks_destroy_failed_and_stops_comfy(tmp_path):
    states, destroyer, stopped, flow = flow_setup(tmp_path, False)
    assert flow.run("manual") is False
    assert states.get().state == State.DESTROY_FAILED
    assert stopped == [1]


def test_flow_can_be_retried_after_destroy_failed(tmp_path):
    states, destroyer, _, flow = flow_setup(tmp_path, False)
    flow.run("manual")
    destroyer.result = True
    assert flow.run("manual") is True
    assert states.get().state == State.STOPPING
    assert destroyer.calls == 2


def test_flow_survives_a_failing_stop_comfy(tmp_path):
    states = StateStore(tmp_path, lambda: 1)
    states.set(State.BOOTING)

    def boom():
        raise RuntimeError("supervisorctl missing")

    flow = DestroyFlow(states, FakeDestroyer(False), boom)
    assert flow.run("manual") is False
    assert states.get().state == State.DESTROY_FAILED
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_destroyer.py -q`
Expected: FAIL (`ModuleNotFoundError: vastcomfy_agent.destroyer`).

- [ ] **Step 3: Implement `destroyer.py` and `destroy_flow.py`**

`destroyer.py`:

```python
from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Callable, Sequence

from .files import write_json
from .paths import StatePaths


class Destroyer:
    """Destroys this instance through the vastai CLI with retries (spec 5.4, 10).

    The exact CLI form comes from spike S4; adjust `_command` if S4 found a safer way to pass the key.
    """

    def __init__(
        self,
        *,
        vastai_bin: str,
        container_id: str,
        api_key: str,
        retries: int,
        backoff_s: int,
        timeout_s: int,
        gone_markers: Sequence[str],
        state_dir: Path,
        run: Callable = subprocess.run,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._bin = vastai_bin
        self._id = container_id
        self._key = api_key
        self._retries = retries
        self._backoff = backoff_s
        self._timeout = timeout_s
        self._markers = [m.lower() for m in gone_markers]
        self._record_path = StatePaths(state_dir).destroy_agent
        self._run = run
        self._sleep = sleep

    def _command(self) -> list[str]:
        return [self._bin, "destroy", "instance", self._id, "--api-key", self._key]

    def _redact(self, text: str) -> str:
        return text.replace(self._key, "***") if self._key else text

    def attempt(self) -> tuple[bool, str | None]:
        try:
            proc = self._run(self._command(), capture_output=True, text=True, timeout=self._timeout)
        except FileNotFoundError:
            return False, "vastai binary not found"
        except subprocess.TimeoutExpired:
            return False, "vastai call timed out"
        output = ((proc.stdout or "") + (proc.stderr or "")).strip()
        if proc.returncode == 0:
            return True, None
        lowered = output.lower()
        if any(marker in lowered for marker in self._markers):
            return True, None
        return False, self._redact(output)[:500] or "vastai failed without output"

    def destroy(self) -> bool:
        error: str | None = None
        for attempt_no in range(1, self._retries + 1):
            ok, error = self.attempt()
            write_json(self._record_path, {"attempts": attempt_no, "last_error": error})
            if ok:
                return True
            if attempt_no < self._retries:
                self._sleep(self._backoff)
        return False
```

`destroy_flow.py`:

```python
from __future__ import annotations

import threading
from typing import Callable

from .destroyer import Destroyer
from .state import InvalidTransition, State, StateStore


class DestroyFlow:
    """stopping -> destroy (retries) -> destroy_failed (+ stop ComfyUI). Safe to call repeatedly."""

    def __init__(self, states: StateStore, destroyer: Destroyer, stop_comfy: Callable[[], None]):
        self._states = states
        self._destroyer = destroyer
        self._stop_comfy = stop_comfy
        self._lock = threading.Lock()
        self._running = False

    def run(self, reason: str) -> bool:
        with self._lock:
            if self._running:
                return True
            self._running = True
        try:
            try:
                self._states.set(State.STOPPING, reason)
            except InvalidTransition:
                pass
            if self._destroyer.destroy():
                return True
            try:
                self._states.set(State.DESTROY_FAILED)
            except InvalidTransition:
                pass
            try:
                self._stop_comfy()
            except Exception:
                pass
            return False
        finally:
            with self._lock:
                self._running = False
```

- [ ] **Step 4: Run the full suite to verify everything passes**

Run: `cd instance/agent && .venv/bin/python -m pytest -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add instance/agent
git commit -m "feat: add destroyer with retries and the destroy flow"
```

### Task 5: ComfyUI client, GPU reader, API models and the status builder

**Files:**
- Create: `instance/agent/vastcomfy_agent/comfy.py`, `models.py`, `status.py`
- Test: `instance/agent/tests/test_comfy.py`, `tests/test_status.py`

**Interfaces:**
- Consumes: `files.read_json/read_int`, `paths.StatePaths`, `state.State/StateStore`, `deadlines.DeadlineStore`.
- Produces: `comfy.ComfyClient(base_url, client)` (`.queue_counts() -> tuple[int, int] | None`, `.ready() -> bool`), `comfy.read_gpu(run, nvidia_smi_bin, timeout_s) -> dict | None`; `models.Progress, QueueCounts, Gpu, DestroyInfo, Status, ExtendRequest, ExtendResponse, DestroyRequest`; `status.StatusBuilder(*, state_dir, states, deadlines, comfy, gpu_reader, profile, commit, now)` with `.build() -> Status`.

- [ ] **Step 1: Write the failing tests**

`instance/agent/tests/test_comfy.py`:

```python
import subprocess

import httpx

from vastcomfy_agent.comfy import ComfyClient, read_gpu


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_queue_counts_reads_running_and_pending():
    def handler(request):
        assert request.url.path == "/queue"
        return httpx.Response(200, json={"queue_running": [[1]], "queue_pending": [[2], [3]]})

    comfy = ComfyClient("http://comfy.test:1", client_for(handler))
    assert comfy.queue_counts() == (1, 2)


def test_queue_counts_is_none_when_unreachable_or_malformed():
    def down(request):
        raise httpx.ConnectError("refused")

    def malformed(request):
        return httpx.Response(200, json={"nope": 1})

    def server_error(request):
        return httpx.Response(500, text="boom")

    assert ComfyClient("http://c.test:1", client_for(down)).queue_counts() is None
    assert ComfyClient("http://c.test:1", client_for(malformed)).queue_counts() is None
    assert ComfyClient("http://c.test:1", client_for(server_error)).queue_counts() is None


def test_ready_checks_system_stats():
    ok = ComfyClient("http://c.test:1", client_for(lambda r: httpx.Response(200, json={})))
    bad = ComfyClient("http://c.test:1", client_for(lambda r: httpx.Response(503)))

    def down(request):
        raise httpx.ConnectError("refused")

    assert ok.ready() is True
    assert bad.ready() is False
    assert ComfyClient("http://c.test:1", client_for(down)).ready() is False


def proc(out, code=0):
    return subprocess.CompletedProcess(args=[], returncode=code, stdout=out, stderr="")


def test_read_gpu_parses_nvidia_smi_csv():
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return proc("37, 20480, 24564\n")

    assert read_gpu(run, "nvidia-smi", 5) == {"util_percent": 37, "vram_used_mb": 20480, "vram_total_mb": 24564}
    assert calls[0][0] == "nvidia-smi"


def test_read_gpu_none_on_failure_or_garbage():
    assert read_gpu(lambda *a, **k: proc("", 9), "nvidia-smi", 5) is None
    assert read_gpu(lambda *a, **k: proc("[N/A], [N/A], [N/A]"), "nvidia-smi", 5) is None

    def missing(*a, **k):
        raise FileNotFoundError("nvidia-smi")

    assert read_gpu(missing, "nvidia-smi", 5) is None
```

`instance/agent/tests/test_status.py`:

```python
import os
import subprocess
import sys

from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.files import write_int, write_json
from vastcomfy_agent.models import Status
from vastcomfy_agent.state import State, StateStore
from vastcomfy_agent.status import StatusBuilder

T0 = 2_000_000


class FakeComfy:
    def __init__(self, counts=(0, 0)):
        self.counts = counts

    def queue_counts(self):
        return self.counts


class Clock:
    t = T0

    def __call__(self):
        return self.t


def setup(tmp_path, counts=(0, 0), gpu=None):
    clock = Clock()
    states = StateStore(tmp_path, clock)
    deadlines = DeadlineStore(tmp_path, clock)
    deadlines.init_first_boot(3, 6)
    comfy = FakeComfy(counts)
    builder = StatusBuilder(
        state_dir=tmp_path, states=states, deadlines=deadlines, comfy=comfy,
        gpu_reader=lambda: gpu, profile="image", commit="abc123", now=clock,
    )
    return clock, states, deadlines, builder


def test_build_returns_the_documented_fields(tmp_path):
    clock, states, deadlines, builder = setup(tmp_path, counts=(1, 2), gpu={"util_percent": 5, "vram_used_mb": 100, "vram_total_mb": 200})
    for s in (State.BOOTING, State.DOWNLOADING, State.READY):
        states.set(s)
    deadlines.set_idle_destroy_at(T0 + 1800)
    clock.t = T0 + 60
    status = builder.build()
    assert isinstance(status, Status)
    assert status.schema_version == 1
    assert status.state == State.READY
    assert status.now == T0 + 60 and status.boot_at == T0 and status.uptime_s == 60
    assert status.idle_destroy_at == T0 + 1800
    assert status.failsafe_at == T0 + 3 * 3600 and status.hard_cap_at == T0 + 6 * 3600
    assert status.queue.running == 1 and status.queue.pending == 2
    assert status.gpu.vram_total_mb == 200
    assert status.profile == "image" and status.commit == "abc123"


def test_queue_is_null_when_comfy_is_unreachable(tmp_path):
    _, _, _, builder = setup(tmp_path, counts=None)
    assert builder.build().queue is None


def test_gpu_fields_are_null_when_unavailable(tmp_path):
    _, _, _, builder = setup(tmp_path, gpu=None)
    gpu = builder.build().gpu
    assert gpu.util_percent is None and gpu.vram_used_mb is None and gpu.vram_total_mb is None


def test_progress_only_while_downloading(tmp_path):
    clock, states, _, builder = setup(tmp_path)
    states.set(State.BOOTING)
    states.set(State.DOWNLOADING)
    write_json(tmp_path / "progress.json", {"phase": "models", "file": "a.gguf", "bytes_done": 5, "bytes_total": 10})
    progress = builder.build().progress
    assert progress.file == "a.gguf" and progress.bytes_done == 5
    states.set(State.READY)
    assert builder.build().progress is None


def test_corrupt_progress_file_is_ignored(tmp_path):
    _, states, _, builder = setup(tmp_path)
    states.set(State.BOOTING)
    states.set(State.DOWNLOADING)
    (tmp_path / "progress.json").write_text("{broken")
    assert builder.build().progress is None


def test_failsafe_alive_reflects_the_pid_file(tmp_path):
    _, _, _, builder = setup(tmp_path)
    assert builder.build().failsafe_alive is False
    write_int(tmp_path / "failsafe.pid", os.getpid())
    assert builder.build().failsafe_alive is True
    done = subprocess.Popen([sys.executable, "-c", "pass"])
    done.wait()
    write_int(tmp_path / "failsafe.pid", done.pid)
    assert builder.build().failsafe_alive is False


def test_destroy_info_merges_failsafe_and_agent_records(tmp_path):
    _, _, _, builder = setup(tmp_path)
    assert builder.build().destroy.model_dump() == {"pending": False, "attempts": 0, "last_error": None}
    write_json(tmp_path / "destroy_failsafe.json", {"pending": True, "attempts": 4, "last_error": "api down"})
    write_json(tmp_path / "destroy_agent.json", {"attempts": 2, "last_error": None})
    info = builder.build().destroy
    assert info.pending is True and info.attempts == 4 and info.last_error == "api down"


def test_status_before_first_boot_has_null_state_and_times(tmp_path):
    clock = Clock()
    states = StateStore(tmp_path, clock)
    builder = StatusBuilder(
        state_dir=tmp_path, states=states, deadlines=DeadlineStore(tmp_path, clock), comfy=FakeComfy(),
        gpu_reader=lambda: None, profile="image", commit="c", now=clock,
    )
    status = builder.build()
    assert status.state is None and status.boot_at is None and status.uptime_s is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_comfy.py tests/test_status.py -q`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement `comfy.py`, `models.py`, `status.py`**

`comfy.py`:

```python
from __future__ import annotations

import subprocess
from typing import Callable

import httpx


class ComfyClient:
    def __init__(self, base_url: str, client: httpx.Client):
        self._base = base_url.rstrip("/")
        self._client = client

    def queue_counts(self) -> tuple[int, int] | None:
        """(running, pending), or None when ComfyUI is unreachable or answers nonsense."""
        try:
            response = self._client.get(f"{self._base}/queue")
            response.raise_for_status()
            data = response.json()
            return len(data["queue_running"]), len(data["queue_pending"])
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            return None

    def ready(self) -> bool:
        try:
            return self._client.get(f"{self._base}/system_stats").status_code == 200
        except httpx.HTTPError:
            return False


def read_gpu(run: Callable, nvidia_smi_bin: str, timeout_s: int) -> dict | None:
    cmd = [nvidia_smi_bin, "--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]
    try:
        proc = run(cmd, capture_output=True, text=True, timeout=timeout_s)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    lines = (proc.stdout or "").strip().splitlines()
    if not lines:
        return None
    try:
        util, used, total = (int(part.strip()) for part in lines[0].split(","))
    except ValueError:
        return None
    return {"util_percent": util, "vram_used_mb": used, "vram_total_mb": total}
```

`models.py` (no `from __future__ import annotations`; pydantic and FastAPI resolve the types at runtime):

```python
from typing import Literal

from pydantic import BaseModel, ConfigDict

from .state import State


class Progress(BaseModel):
    phase: Literal["nodes", "models"]
    file: str
    bytes_done: int
    bytes_total: int


class QueueCounts(BaseModel):
    running: int
    pending: int


class Gpu(BaseModel):
    util_percent: int | None = None
    vram_used_mb: int | None = None
    vram_total_mb: int | None = None


class DestroyInfo(BaseModel):
    pending: bool
    attempts: int
    last_error: str | None = None


class Status(BaseModel):
    schema_version: Literal[1] = 1
    state: State | None
    reason: str | None
    progress: Progress | None
    now: int
    boot_at: int | None
    uptime_s: int | None
    idle_destroy_at: int | None
    failsafe_at: int | None
    hard_cap_at: int | None
    queue: QueueCounts | None
    gpu: Gpu
    profile: str
    commit: str
    failsafe_alive: bool
    destroy: DestroyInfo


class ExtendRequest(BaseModel):
    model_config = ConfigDict(strict=True)
    kind: Literal["idle", "failsafe"]
    minutes: int


class ExtendResponse(BaseModel):
    kind: Literal["idle", "failsafe"]
    deadline: int


class DestroyRequest(BaseModel):
    reason: Literal["manual", "watchdog"] = "manual"
```

`status.py`:

```python
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from pydantic import ValidationError

from .comfy import ComfyClient
from .deadlines import DeadlineStore
from .files import read_int, read_json
from .models import DestroyInfo, Gpu, Progress, QueueCounts, Status
from .paths import StatePaths
from .state import State, StateStore


def _pid_alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, OverflowError):
        return False
    except PermissionError:
        return True
    return True


class StatusBuilder:
    def __init__(
        self,
        *,
        state_dir: Path,
        states: StateStore,
        deadlines: DeadlineStore,
        comfy: ComfyClient,
        gpu_reader: Callable[[], dict | None],
        profile: str,
        commit: str,
        now: Callable[[], int],
    ):
        self._p = StatePaths(state_dir)
        self._states = states
        self._deadlines = deadlines
        self._comfy = comfy
        self._gpu_reader = gpu_reader
        self._profile = profile
        self._commit = commit
        self._now = now

    def _progress(self, state: State | None) -> Progress | None:
        if state != State.DOWNLOADING:
            return None
        data = read_json(self._p.progress_json)
        try:
            return Progress(**data) if isinstance(data, dict) else None
        except (ValidationError, TypeError):
            return None

    def _destroy_info(self) -> DestroyInfo:
        failsafe = read_json(self._p.destroy_failsafe, {}) or {}
        agent = read_json(self._p.destroy_agent, {}) or {}
        return DestroyInfo(
            pending=bool(failsafe.get("pending", False)),
            attempts=max(int(failsafe.get("attempts", 0) or 0), int(agent.get("attempts", 0) or 0)),
            last_error=agent.get("last_error") or failsafe.get("last_error"),
        )

    def build(self) -> Status:
        record = self._states.get()
        now = self._now()
        boot_at = self._deadlines.first_boot_at()
        counts = self._comfy.queue_counts()
        gpu = self._gpu_reader() or {}
        return Status(
            state=record.state,
            reason=record.reason,
            progress=self._progress(record.state),
            now=now,
            boot_at=boot_at,
            uptime_s=None if boot_at is None else now - boot_at,
            idle_destroy_at=self._deadlines.idle_destroy_at(),
            failsafe_at=self._deadlines.deadline(),
            hard_cap_at=self._deadlines.hard_cap(),
            queue=None if counts is None else QueueCounts(running=counts[0], pending=counts[1]),
            gpu=Gpu(**gpu),
            profile=self._profile,
            commit=self._commit,
            failsafe_alive=_pid_alive(read_int(self._p.failsafe_pid)),
            destroy=self._destroy_info(),
        )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_comfy.py tests/test_status.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add instance/agent
git commit -m "feat: add ComfyUI client, GPU reader, API models and status builder"
```

### Task 6: Workflow store and the agent HTTP app

**Files:**
- Create: `instance/agent/vastcomfy_agent/workflows.py`, `app.py`
- Create: `instance/agent/tests/conftest.py`
- Test: `instance/agent/tests/test_workflows.py`, `tests/test_app.py`

**Interfaces:**
- Consumes: `config.load_config/Config`, `state.*`, `deadlines.*`, `status.StatusBuilder`, `destroy_flow.DestroyFlow`, `models.*`.
- Produces: `workflows.WorkflowStore(directory, max_bytes)` with `.list()`, `.read(name)`, `.write(name, body: bytes) -> int`; `workflows.WorkflowError(status, message)`; `app.Deps(cfg, states, deadlines, status, flow, workflows)`; `app.create_app(deps) -> FastAPI`.

- [ ] **Step 1: Write the shared fixture and the failing tests**

`instance/agent/tests/conftest.py`:

```python
import pytest

from vastcomfy_agent.config import load_config


@pytest.fixture
def make_cfg(tmp_path):
    def _make(**overrides):
        values = {
            "CONTAINER_ID": "42",
            "CONTAINER_API_KEY": "container-key",
            "AGENT_TOKEN": "tok-123",
            "TS_HOSTNAME": "vast-test",
            "REPO_URL": "https://example.invalid/repo.git",
            "REPO_COMMIT": "abc123",
            "PROFILE": "image",
            "STATE_DIR": str(tmp_path / "state"),
            "WORKFLOWS_DIR": str(tmp_path / "workflows"),
            "COMFY_DIR": str(tmp_path / "comfy"),
        }
        values.update(overrides)
        env = tmp_path / ".env"
        env.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        return load_config(env, "instance")

    return _make
```

`instance/agent/tests/test_workflows.py`:

```python
import pytest

from vastcomfy_agent.workflows import WorkflowError, WorkflowStore


def test_write_read_list_overwrite(tmp_path):
    store = WorkflowStore(tmp_path / "wf", max_bytes=100)
    assert store.list() == []
    assert store.write("a.json", b'{"x": 1}') == 8
    store.write("a.json", b'{"x": 2}')
    assert store.read("a.json") == {"x": 2}
    assert [item["name"] for item in store.list()] == ["a.json"]
    assert isinstance(store.list()[0]["modified_at"], int)


@pytest.mark.parametrize(
    "name",
    ["../evil.json", "a/b.json", "/abs.json", "noext", "x.txt", ".hidden.json", "", "nul\x00.json",
     "café.json", "a" * 200 + ".json", "..", "a\\b.json"],
)
def test_invalid_names_are_rejected_for_every_operation(tmp_path, name):
    store = WorkflowStore(tmp_path, max_bytes=100)
    for call in (lambda: store.read(name), lambda: store.write(name, b"{}")):
        with pytest.raises(WorkflowError) as err:
            call()
        assert err.value.status == 400
    assert list(tmp_path.iterdir()) == []


def test_oversize_and_invalid_json_are_rejected_without_touching_the_existing_file(tmp_path):
    store = WorkflowStore(tmp_path, max_bytes=20)
    store.write("a.json", b'{"ok": true}')
    with pytest.raises(WorkflowError) as err:
        store.write("a.json", b'{"padding": "' + b"x" * 50 + b'"}')
    assert err.value.status == 413
    with pytest.raises(WorkflowError) as err:
        store.write("a.json", b"{not json")
    assert err.value.status == 422
    with pytest.raises(WorkflowError) as err:
        store.write("a.json", b"\xff\xfe")
    assert err.value.status == 422
    assert store.read("a.json") == {"ok": True}


def test_read_missing_is_404(tmp_path):
    with pytest.raises(WorkflowError) as err:
        WorkflowStore(tmp_path, 100).read("nope.json")
    assert err.value.status == 404
```

`instance/agent/tests/test_app.py`:

```python
import pytest
from fastapi.testclient import TestClient

from vastcomfy_agent.app import Deps, create_app
from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.state import State, StateStore
from vastcomfy_agent.status import StatusBuilder
from vastcomfy_agent.workflows import WorkflowStore

T0 = 3_000_000
AUTH = {"Authorization": "Bearer tok-123"}


class Clock:
    t = T0

    def __call__(self):
        return self.t


class FakeComfy:
    def queue_counts(self):
        return (0, 0)


class FakeFlow:
    def __init__(self):
        self.reasons = []

    def run(self, reason):
        self.reasons.append(reason)
        return True


@pytest.fixture
def env(tmp_path, make_cfg):
    cfg = make_cfg()
    clock = Clock()
    states = StateStore(tmp_path / "state", clock)
    deadlines = DeadlineStore(tmp_path / "state", clock)
    deadlines.init_first_boot(3, 6)
    for s in (State.BOOTING, State.DOWNLOADING, State.READY):
        states.set(s)
    deadlines.set_idle_destroy_at(T0 + 1800)
    flow = FakeFlow()
    builder = StatusBuilder(
        state_dir=tmp_path / "state", states=states, deadlines=deadlines, comfy=FakeComfy(),
        gpu_reader=lambda: None, profile="image", commit="abc123", now=clock,
    )
    deps = Deps(cfg=cfg, states=states, deadlines=deadlines, status=builder, flow=flow,
                workflows=WorkflowStore(tmp_path / "workflows", cfg.workflow_max_bytes))
    return TestClient(create_app(deps)), deps, flow


def test_health_is_open_everything_else_needs_the_token(env):
    client, _, _ = env
    assert client.get("/health").json() == {"ok": True}
    for method, path in [("get", "/status"), ("post", "/extend"), ("post", "/destroy"),
                         ("get", "/workflows"), ("get", "/workflows/a.json"), ("put", "/workflows/a.json")]:
        assert getattr(client, method)(path).status_code == 401
        assert getattr(client, method)(path, headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert getattr(client, method)(path, headers={"Authorization": "tok-123"}).status_code == 401


def test_status_returns_the_contract_shape(env):
    client, _, _ = env
    body = client.get("/status", headers=AUTH).json()
    assert body["schema_version"] == 1 and body["state"] == "ready"
    assert body["queue"] == {"running": 0, "pending": 0}
    assert set(body) >= {"reason", "progress", "now", "boot_at", "uptime_s", "idle_destroy_at", "failsafe_at",
                         "hard_cap_at", "gpu", "profile", "commit", "failsafe_alive", "destroy"}


def test_extend_failsafe_and_idle(env):
    client, deps, _ = env
    res = client.post("/extend", headers=AUTH, json={"kind": "failsafe", "minutes": 30})
    assert res.status_code == 200 and res.json() == {"kind": "failsafe", "deadline": T0 + 3 * 3600 + 1800}
    res = client.post("/extend", headers=AUTH, json={"kind": "idle", "minutes": 15})
    assert res.json()["deadline"] == T0 + 1800 + 900
    assert deps.deadlines.idle_destroy_at() == T0 + 2700


def test_extend_beyond_hard_cap_names_the_limit_and_changes_nothing(env):
    client, deps, _ = env
    res = client.post("/extend", headers=AUTH, json={"kind": "failsafe", "minutes": 181})
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "beyond_hard_cap" or res.json()["detail"]["code"] == "too_large"
    assert deps.deadlines.deadline() == T0 + 3 * 3600


@pytest.mark.parametrize("minutes", [0, -5, 10**9])
def test_extend_out_of_range_integers_are_400(env, minutes):
    client, deps, _ = env
    res = client.post("/extend", headers=AUTH, json={"kind": "idle", "minutes": minutes})
    assert res.status_code == 400
    assert deps.deadlines.idle_destroy_at() == T0 + 1800


@pytest.mark.parametrize("minutes", ["10", 1.5, True, None])
def test_extend_wrong_types_are_rejected_and_change_nothing(env, minutes):
    client, deps, _ = env
    res = client.post("/extend", headers=AUTH, json={"kind": "idle", "minutes": minutes})
    assert res.status_code in (400, 422)
    assert deps.deadlines.idle_destroy_at() == T0 + 1800


def test_destroy_sets_stopping_and_runs_the_flow_in_the_background(env):
    client, deps, flow = env
    res = client.post("/destroy", headers=AUTH, json={"reason": "manual"})
    assert res.status_code == 202 and res.json() == {"accepted": True}
    assert deps.states.get().state == State.STOPPING and deps.states.get().reason == "manual"
    assert flow.reasons == ["manual"]
    again = client.post("/destroy", headers=AUTH, json={"reason": "watchdog"})
    assert again.status_code == 202


def test_destroy_rejects_unknown_reasons(env):
    client, _, flow = env
    assert client.post("/destroy", headers=AUTH, json={"reason": "idle_timeout"}).status_code == 422
    assert flow.reasons == []


def test_workflow_round_trip_and_errors(env):
    client, _, _ = env
    assert client.get("/workflows", headers=AUTH).json() == []
    assert client.put("/workflows/a.json", headers=AUTH, content=b'{"n": 1}').status_code == 200
    assert client.get("/workflows/a.json", headers=AUTH).json() == {"n": 1}
    assert [w["name"] for w in client.get("/workflows", headers=AUTH).json()] == ["a.json"]
    assert client.put("/workflows/a.json", headers=AUTH, content=b'{"n": 2}').status_code == 200
    assert client.get("/workflows/a.json", headers=AUTH).json() == {"n": 2}
    assert client.get("/workflows/missing.json", headers=AUTH).status_code == 404
    assert client.put("/workflows/bad.txt", headers=AUTH, content=b"{}").status_code == 400
    assert client.put("/workflows/b.json", headers=AUTH, content=b"{nope").status_code == 422
    too_big = b'{"x": "' + b"a" * 2_000_000 + b'"}'
    assert client.put("/workflows/c.json", headers=AUTH, content=too_big).status_code == 413
    assert client.put("/workflows/caf%C3%A9.json", headers=AUTH, content=b"{}").status_code == 400
    assert client.put("/workflows/..%2Fevil.json", headers=AUTH, content=b"{}").status_code in (400, 404)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_workflows.py tests/test_app.py -q`
Expected: FAIL (`ModuleNotFoundError: vastcomfy_agent.workflows`).

- [ ] **Step 3: Implement `workflows.py`**

```python
from __future__ import annotations

import json
import re
from pathlib import Path

from .files import atomic_write

# ASCII only, no path separators, must end in .json (protocol rule, not configuration).
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,100}\.json$")


class WorkflowError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class WorkflowStore:
    def __init__(self, directory: Path, max_bytes: int):
        self._dir = Path(directory)
        self._max = max_bytes

    def _path(self, name: str) -> Path:
        if not NAME_RE.fullmatch(name):
            raise WorkflowError(400, "invalid workflow name")
        return self._dir / name

    def list(self) -> list[dict]:
        if not self._dir.is_dir():
            return []
        return [
            {"name": p.name, "modified_at": int(p.stat().st_mtime)}
            for p in sorted(self._dir.iterdir())
            if p.is_file() and NAME_RE.fullmatch(p.name)
        ]

    def read(self, name: str):
        path = self._path(name)
        if not path.is_file():
            raise WorkflowError(404, "workflow not found")
        return json.loads(path.read_text())

    def write(self, name: str, body: bytes) -> int:
        path = self._path(name)
        if len(body) > self._max:
            raise WorkflowError(413, f"workflow larger than {self._max} bytes")
        try:
            json.loads(body.decode())
        except (ValueError, UnicodeDecodeError):
            raise WorkflowError(422, "workflow is not valid JSON") from None
        atomic_write(path, body.decode())
        return len(body)
```

- [ ] **Step 4: Implement `app.py`** (no `from __future__ import annotations`; FastAPI resolves annotations at runtime)

```python
import hmac
from dataclasses import dataclass

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request

from .config import Config
from .deadlines import DeadlineStore, ExtendError
from .destroy_flow import DestroyFlow
from .models import DestroyRequest, ExtendRequest, ExtendResponse, Status
from .state import InvalidTransition, State, StateStore
from .status import StatusBuilder
from .workflows import WorkflowError, WorkflowStore


@dataclass
class Deps:
    cfg: Config
    states: StateStore
    deadlines: DeadlineStore
    status: StatusBuilder
    flow: DestroyFlow
    workflows: WorkflowStore


def create_app(deps: Deps) -> FastAPI:
    app = FastAPI(title="vastcomfy-agent", version="1")

    def require_token(authorization: str | None = Header(default=None)) -> None:
        supplied = authorization[len("Bearer "):] if authorization and authorization.startswith("Bearer ") else ""
        if not hmac.compare_digest(supplied.encode(), deps.cfg.agent_token.encode()):
            raise HTTPException(status_code=401, detail="invalid token", headers={"WWW-Authenticate": "Bearer"})

    guarded = [Depends(require_token)]

    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    @app.get("/status", response_model=Status, dependencies=guarded)
    def get_status() -> Status:
        return deps.status.build()

    @app.post("/extend", response_model=ExtendResponse, dependencies=guarded)
    def extend(body: ExtendRequest) -> ExtendResponse:
        try:
            if body.kind == "failsafe":
                new = deps.deadlines.extend_failsafe(body.minutes, deps.cfg.extend_max_failsafe_min)
            else:
                new = deps.deadlines.extend_idle(body.minutes, deps.cfg.extend_max_idle_min)
        except ExtendError as err:
            raise HTTPException(status_code=400, detail={"code": err.code, "message": err.message}) from None
        return ExtendResponse(kind=body.kind, deadline=new)

    @app.post("/destroy", status_code=202, dependencies=guarded)
    def destroy(body: DestroyRequest, tasks: BackgroundTasks) -> dict:
        try:
            deps.states.set(State.STOPPING, body.reason)
        except InvalidTransition:
            pass
        tasks.add_task(deps.flow.run, body.reason)
        return {"accepted": True}

    @app.get("/workflows", dependencies=guarded)
    def list_workflows() -> list[dict]:
        return deps.workflows.list()

    @app.get("/workflows/{name}", dependencies=guarded)
    def get_workflow(name: str):
        try:
            return deps.workflows.read(name)
        except WorkflowError as err:
            raise HTTPException(status_code=err.status, detail=err.message) from None

    @app.put("/workflows/{name}", dependencies=guarded)
    async def put_workflow(name: str, request: Request) -> dict:
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > deps.cfg.workflow_max_bytes:
            raise HTTPException(status_code=413, detail=f"workflow larger than {deps.cfg.workflow_max_bytes} bytes")
        body = await request.body()
        try:
            size = deps.workflows.write(name, body)
        except WorkflowError as err:
            raise HTTPException(status_code=err.status, detail=err.message) from None
        return {"name": name, "bytes": size}

    return app
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd instance/agent && .venv/bin/python -m pytest -q`
Expected: all PASS. If a test in this task fails because of a FastAPI/Starlette version detail (for example how `%2F` is decoded), fix the *test expectation* to the framework's actual, safe behaviour (the name must never reach the filesystem) and note it in the commit message; do not weaken `NAME_RE`.

- [ ] **Step 6: Commit**

```bash
git add instance/agent
git commit -m "feat: add workflow store and the authenticated agent HTTP app"
```

### Task 7: Runner, wiring and the agent entrypoint

**Files:**
- Create: `instance/agent/vastcomfy_agent/runner.py`, `wiring.py`, `__main__.py`
- Test: `instance/agent/tests/test_runner.py`, `tests/test_wiring.py`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: `runner.Runner(*, states, idle, comfy, flow, state_dir)` with `.tick()` and `.run_forever(stop_event, interval_s)`; `wiring.build(cfg, now=utc_now, run=subprocess.run, http_client=None) -> Wired` (dataclass with `cfg, states, deadlines, comfy, destroyer, flow, idle, runner, status, workflows, deps`); `wiring.make_stop_comfy(cfg, run) -> Callable[[], None]`; `python -m vastcomfy_agent --env-file PATH`.

- [ ] **Step 1: Write the failing tests**

`instance/agent/tests/test_runner.py`:

```python
import threading

from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.files import write_json
from vastcomfy_agent.idle import IdleWatcher
from vastcomfy_agent.runner import Runner
from vastcomfy_agent.state import State, StateStore

T0 = 4_000_000


class Clock:
    t = T0

    def __call__(self):
        return self.t


class FakeComfy:
    def __init__(self, counts=(0, 0)):
        self.counts = counts

    def queue_counts(self):
        return self.counts


class FakeFlow:
    def __init__(self):
        self.reasons = []

    def run(self, reason):
        self.reasons.append(reason)
        return True


def make(tmp_path, counts=(0, 0), ready=True):
    clock = Clock()
    states = StateStore(tmp_path, clock)
    states.set(State.BOOTING)
    if ready:
        states.set(State.DOWNLOADING)
        states.set(State.READY)
    deadlines = DeadlineStore(tmp_path, clock)
    deadlines.init_first_boot(3, 6)
    idle = IdleWatcher(states, deadlines, clock, 30, 10)
    idle.start()
    flow = FakeFlow()
    runner = Runner(states=states, idle=idle, comfy=FakeComfy(counts), flow=flow, state_dir=tmp_path)
    return clock, states, flow, runner


def test_idle_timeout_triggers_the_destroy_flow(tmp_path):
    clock, states, flow, runner = make(tmp_path)
    runner.tick()
    assert flow.reasons == []
    clock.t = T0 + 31 * 60
    runner.tick()
    assert flow.reasons == ["idle_timeout"]


def test_busy_queue_keeps_the_instance_alive(tmp_path):
    clock, states, flow, runner = make(tmp_path, counts=(1, 0))
    clock.t = T0 + 60 * 60
    runner.tick()
    assert flow.reasons == []


def test_unreachable_comfy_is_counted_as_idle_and_does_not_crash(tmp_path):
    clock, states, flow, runner = make(tmp_path, counts=None)
    clock.t = T0 + 31 * 60
    runner.tick()
    assert flow.reasons == ["idle_timeout"]


def test_failsafe_marker_moves_the_state_to_stopping_without_a_second_destroy(tmp_path):
    clock, states, flow, runner = make(tmp_path)
    write_json(tmp_path / "destroy_failsafe.json", {"pending": True, "attempts": 1, "last_error": "x"})
    runner.tick()
    record = states.get()
    assert (record.state, record.reason) == (State.STOPPING, "failsafe_deadline")
    assert flow.reasons == []


def test_boot_states_are_left_alone(tmp_path):
    clock, states, flow, runner = make(tmp_path, ready=False)
    clock.t = T0 + 10**6
    runner.tick()
    assert flow.reasons == [] and states.get().state == State.BOOTING


def test_run_forever_survives_exceptions_and_stops_on_event(tmp_path):
    clock, states, flow, runner = make(tmp_path)
    stop = threading.Event()
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")
        stop.set()

    runner.tick = flaky
    runner.run_forever(stop, interval_s=0)
    assert len(calls) == 2
```

`instance/agent/tests/test_wiring.py`:

```python
import subprocess

import httpx

from vastcomfy_agent import wiring
from vastcomfy_agent.state import State


def test_stop_comfy_uses_configured_binary_conf_and_program(make_cfg):
    cfg = make_cfg(SUPERVISORCTL_BIN="sctl", SUPERVISOR_CONF="/x/sup.conf", COMFY_PROGRAM="comfy")
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    wiring.make_stop_comfy(cfg, run)()
    assert calls == [["sctl", "-c", "/x/sup.conf", "stop", "comfy"]]


def test_build_wires_a_working_status_and_destroy_flow(make_cfg, tmp_path):
    cfg = make_cfg(DESTROY_RETRIES="1", DESTROY_BACKOFF_S="0")
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 1 if cmd[0] == "vastai" else 0, "", "nope")

    http = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"queue_running": [], "queue_pending": []})))
    wired = wiring.build(cfg, now=lambda: 1000, run=run, http_client=http)
    wired.states.set(State.BOOTING)
    assert wired.status.build().state == State.BOOTING
    assert wired.status.build().queue.running == 0
    assert wired.flow.run("manual") is False
    assert wired.states.get().state == State.DESTROY_FAILED
    assert any(cmd[0] == "supervisorctl" for cmd in calls)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_runner.py tests/test_wiring.py -q`
Expected: FAIL (`ModuleNotFoundError: vastcomfy_agent.runner`).

- [ ] **Step 3: Implement `runner.py`**

```python
from __future__ import annotations

import logging
import threading
from pathlib import Path

from .destroy_flow import DestroyFlow
from .files import read_json
from .idle import IdleWatcher
from .paths import StatePaths
from .state import InvalidTransition, State, StateStore

log = logging.getLogger(__name__)


class Runner:
    """Periodic work of the agent: mirror the failsafe's destroy, advance idle, destroy on idle timeout."""

    def __init__(self, *, states: StateStore, idle: IdleWatcher, comfy, flow: DestroyFlow, state_dir: Path):
        self._states = states
        self._idle = idle
        self._comfy = comfy
        self._flow = flow
        self._paths = StatePaths(state_dir)

    def _failsafe_destroying(self) -> bool:
        record = read_json(self._paths.destroy_failsafe, {}) or {}
        return bool(record.get("pending"))

    def tick(self) -> None:
        if self._failsafe_destroying():
            try:
                self._states.set(State.STOPPING, "failsafe_deadline")
            except InvalidTransition:
                pass
            return
        if self._states.get().state not in (State.READY, State.IDLE_WARNING):
            return
        counts = self._comfy.queue_counts()
        total = None if counts is None else counts[0] + counts[1]
        if self._idle.tick(total) == "destroy":
            self._flow.run("idle_timeout")

    def run_forever(self, stop: threading.Event, interval_s: float) -> None:
        while not stop.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("runner tick failed")
            stop.wait(interval_s)
```

- [ ] **Step 4: Implement `wiring.py`**

```python
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import httpx

from .app import Deps
from .clock import utc_now
from .comfy import ComfyClient, read_gpu
from .config import Config
from .deadlines import DeadlineStore
from .destroy_flow import DestroyFlow
from .destroyer import Destroyer
from .idle import IdleWatcher
from .runner import Runner
from .state import StateStore
from .status import StatusBuilder
from .workflows import WorkflowStore


@dataclass
class Wired:
    cfg: Config
    states: StateStore
    deadlines: DeadlineStore
    comfy: ComfyClient
    destroyer: Destroyer
    flow: DestroyFlow
    idle: IdleWatcher
    runner: Runner
    status: StatusBuilder
    workflows: WorkflowStore
    deps: Deps


def make_stop_comfy(cfg: Config, run: Callable = subprocess.run) -> Callable[[], None]:
    command = [cfg.supervisorctl_bin, "-c", cfg.supervisor_conf, "stop", cfg.comfy_program]

    def stop() -> None:
        run(command, capture_output=True, text=True, timeout=cfg.destroy_timeout_s)

    return stop


def build(
    cfg: Config,
    now: Callable[[], int] = utc_now,
    run: Callable = subprocess.run,
    http_client: httpx.Client | None = None,
) -> Wired:
    state_dir = Path(cfg.state_dir)
    states = StateStore(state_dir, now)
    deadlines = DeadlineStore(state_dir, now)
    client = http_client or httpx.Client(timeout=cfg.http_timeout_s)
    comfy = ComfyClient(f"http://{cfg.comfy_host}:{cfg.comfy_port}", client)  # config-lint: ok (local scheme)
    destroyer = Destroyer(
        vastai_bin=cfg.vastai_bin,
        container_id=cfg.container_id,
        api_key=cfg.container_api_key,
        retries=cfg.destroy_retries,
        backoff_s=cfg.destroy_backoff_s,
        timeout_s=cfg.destroy_timeout_s,
        gone_markers=cfg.destroy_gone_markers,
        state_dir=state_dir,
        run=run,
    )
    flow = DestroyFlow(states, destroyer, make_stop_comfy(cfg, run))
    idle = IdleWatcher(states, deadlines, now, cfg.idle_minutes, cfg.idle_warn_minutes)
    runner = Runner(states=states, idle=idle, comfy=comfy, flow=flow, state_dir=state_dir)
    status = StatusBuilder(
        state_dir=state_dir,
        states=states,
        deadlines=deadlines,
        comfy=comfy,
        gpu_reader=lambda: read_gpu(run, cfg.nvidia_smi_bin, cfg.http_timeout_s),
        profile=cfg.profile,
        commit=cfg.repo_commit,
        now=now,
    )
    workflows = WorkflowStore(Path(cfg.workflows_dir), cfg.workflow_max_bytes)
    deps = Deps(cfg=cfg, states=states, deadlines=deadlines, status=status, flow=flow, workflows=workflows)
    return Wired(cfg, states, deadlines, comfy, destroyer, flow, idle, runner, status, workflows, deps)
```

- [ ] **Step 5: Implement `__main__.py`**

```python
from __future__ import annotations

import argparse
import logging
import threading
from pathlib import Path

import uvicorn

from .app import create_app
from .config import load_config
from .wiring import build


def main() -> None:
    parser = argparse.ArgumentParser(prog="vastcomfy_agent")
    parser.add_argument("--env-file", type=Path, required=True)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    cfg = load_config(args.env_file, "instance")
    wired = build(cfg)
    stop = threading.Event()
    threading.Thread(
        target=wired.runner.run_forever, args=(stop, cfg.comfy_poll_s), name="runner", daemon=True
    ).start()
    try:
        uvicorn.run(create_app(wired.deps), host=cfg.agent_host, port=cfg.agent_port, log_level="info")
    finally:
        stop.set()


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Run the full suite and the entrypoint smoke check**

Run: `cd instance/agent && .venv/bin/python -m pytest -q && .venv/bin/python -m vastcomfy_agent --help`
Expected: all tests PASS and the `--help` output mentions `--env-file`.

- [ ] **Step 7: Commit**

```bash
git add instance/agent
git commit -m "feat: add runner, wiring and the agent entrypoint"
```

### Task 8: `failsafe.sh`, the standalone last-resort destroyer

**Files:**
- Create: `instance/failsafe.sh` (executable)
- Test: `instance/agent/tests/test_failsafe.py`

**Interfaces:**
- Consumes: the `.env` format and state file names from Global Constraints; keys `STATE_DIR, CONTAINER_ID, CONTAINER_API_KEY, HARD_CAP_HOURS, FAILSAFE_POLL_S, VASTAI_BIN, DESTROY_GONE_MARKERS, DESTROY_TIMEOUT_S, SUPERVISORCTL_BIN, SUPERVISOR_CONF, COMFY_PROGRAM`.
- Produces: `failsafe.sh --env-file PATH` (writes `failsafe.pid`, `destroy_failsafe.json` with `{pending, attempts, last_error}`); exit 0 after a successful destroy, exit 2 on usage/config errors.

- [ ] **Step 1: Write the failing tests**

`instance/agent/tests/test_failsafe.py`:

```python
import json
import subprocess
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "failsafe.sh"
KEY = "ck=with spaces#and=equals"


@pytest.fixture
def procs():
    started = []
    yield started
    for proc in started:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def write_exec(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o755)


def setup(tmp_path, *, deadline=None, hard_cap=None, hard_cap_hours=6, fail_times=0, stub_out="boom",
          stub_sleep=0, timeout_s=5, key=KEY, markers="404,not found", drop_key=None):
    """deadline/hard_cap: int offset in seconds from now, a raw str, or None for 'file missing'."""
    state = tmp_path / "state"
    state.mkdir()
    now = int(time.time())
    for name, value in (("deadline", deadline), ("hard_cap", hard_cap)):
        if value is not None:
            (state / name).write_text(str(now + value) if isinstance(value, int) else value)
    log, count, sctl_log = tmp_path / "vast.log", tmp_path / "count", tmp_path / "sctl.log"
    write_exec(
        tmp_path / "vastai",
        f'#!/usr/bin/env bash\necho "$*" >> {log}\nn=$(cat {count} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {count}\n'
        f'sleep {stub_sleep}\nif [ "$n" -le {fail_times} ]; then echo "{stub_out}" >&2; exit 1; fi\nexit 0\n',
    )
    write_exec(tmp_path / "sctl", f'#!/usr/bin/env bash\necho "$*" >> {sctl_log}\nexit 0\n')
    values = {
        "STATE_DIR": str(state), "CONTAINER_ID": "42", "CONTAINER_API_KEY": key,
        "HARD_CAP_HOURS": str(hard_cap_hours), "FAILSAFE_POLL_S": "1", "VASTAI_BIN": str(tmp_path / "vastai"),
        "DESTROY_GONE_MARKERS": markers, "DESTROY_TIMEOUT_S": str(timeout_s),
        "SUPERVISORCTL_BIN": str(tmp_path / "sctl"), "SUPERVISOR_CONF": "/unused/sup.conf", "COMFY_PROGRAM": "comfy",
    }
    if drop_key:
        values.pop(drop_key)
    env = tmp_path / "instance.env"
    env.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    return env, state, log, sctl_log


def start(env, procs):
    proc = subprocess.Popen(["bash", str(SCRIPT), "--env-file", str(env)], stderr=subprocess.PIPE, text=True)
    procs.append(proc)
    return proc


def wait_until(predicate, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return False


def record(state):
    return json.loads((state / "destroy_failsafe.json").read_text())


def test_destroys_when_the_deadline_passes_and_exits(tmp_path, procs):
    env, state, log, sctl = setup(tmp_path, deadline=2, hard_cap=1000)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None)
    assert proc.returncode == 0
    assert log.read_text().strip() == f"destroy instance 42 --api-key {KEY}"
    assert record(state) == {"attempts": 1, "last_error": None, "pending": False}
    assert "stop comfy" in sctl.read_text()


def test_does_not_destroy_before_the_deadline_and_writes_its_pid(tmp_path, procs):
    env, state, log, _ = setup(tmp_path, deadline=1000, hard_cap=2000)
    proc = start(env, procs)
    assert wait_until(lambda: (state / "failsafe.pid").exists())
    time.sleep(2.5)
    assert proc.poll() is None and not log.exists()
    assert int((state / "failsafe.pid").read_text()) == proc.pid


def test_hard_cap_wins_over_a_later_deadline(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1000, hard_cap=2)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and log.exists()


def test_corrupt_deadline_falls_back_to_hard_cap(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline="garbage\n", hard_cap=2)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and log.exists()


def test_deadline_in_the_past_after_a_restart_destroys_on_the_first_loop(tmp_path, procs):
    # Review focus 3
    env, _, log, _ = setup(tmp_path, deadline=-100, hard_cap=1000)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5) and log.exists()


def test_missing_hard_cap_file_is_computed_from_the_configured_hours(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=None, hard_cap=None, hard_cap_hours=0)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5) and log.exists()


def test_elapsed_time_guard_fires_even_when_the_files_say_far_future(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=10**6, hard_cap=10**6, hard_cap_hours=0)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5) and log.exists()


def test_retries_until_the_api_works_and_counts_attempts(tmp_path, procs):
    env, state, log, sctl = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=2)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=30)
    assert len(log.read_text().strip().splitlines()) == 3
    assert record(state)["attempts"] == 3 and record(state)["pending"] is False
    assert len(sctl.read_text().strip().splitlines()) == 1


def test_already_gone_counts_as_success(tmp_path, procs):
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, stub_out="Instance Not Found (404)")
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None) and proc.returncode == 0
    assert len(log.read_text().strip().splitlines()) == 1


def test_persistent_failure_keeps_pending_and_never_leaks_the_key(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, fail_times=99, stub_out=f"bad key {KEY}")
    proc = start(env, procs)
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists() and record(state)["attempts"] >= 2)
    assert proc.poll() is None
    data = record(state)
    assert data["pending"] is True and KEY not in (data["last_error"] or "") and "bad key" in data["last_error"]


def test_a_hanging_vastai_call_is_killed_after_the_timeout(tmp_path, procs):
    env, state, _, _ = setup(tmp_path, deadline=1, hard_cap=1000, stub_sleep=30, timeout_s=2)
    start(env, procs)
    assert wait_until(lambda: (state / "destroy_failsafe.json").exists() and "timed out" in (record(state)["last_error"] or ""), timeout=15)


def test_env_value_with_equals_spaces_and_hash_reaches_the_command_intact(tmp_path, procs):
    # Review focus 2
    env, _, log, _ = setup(tmp_path, deadline=1, hard_cap=1000, key="a=b#c d")
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None)
    assert log.read_text().strip() == "destroy instance 42 --api-key a=b#c d"


@pytest.mark.parametrize("missing", ["STATE_DIR", "CONTAINER_API_KEY", "VASTAI_BIN", "FAILSAFE_POLL_S"])
def test_missing_required_key_exits_2_and_names_it(tmp_path, procs, missing):
    env, _, _, _ = setup(tmp_path, deadline=1000, hard_cap=2000, drop_key=missing)
    proc = start(env, procs)
    assert wait_until(lambda: proc.poll() is not None, timeout=5)
    assert proc.returncode == 2 and missing in proc.stderr.read()


def test_usage_errors_exit_2():
    assert subprocess.run(["bash", str(SCRIPT)], capture_output=True).returncode == 2
    assert subprocess.run(["bash", str(SCRIPT), "--env-file", "/no/such/file"], capture_output=True).returncode == 2
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_failsafe.py -q`
Expected: FAIL (the script does not exist yet).

- [ ] **Step 3: Write `instance/failsafe.sh` and make it executable**

```bash
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

mkdir -p "$STATE_DIR"
write_atomic "$STATE_DIR/failsafe.pid" "$$"

START="$(date +%s)"
HARD_CAP="$(cat "$STATE_DIR/hard_cap" 2>/dev/null)"
if ! is_int "$HARD_CAP"; then
  HARD_CAP=$((START + HARD_CAP_HOURS * 3600))
fi
ELAPSED_LIMIT=$((HARD_CAP_HOURS * 3600))

IFS=',' read -r -a MARKERS <<< "$(lower "$GONE_MARKERS")"
OUT_FILE="$STATE_DIR/.failsafe_out"

run_with_timeout() {  # seconds command...
  local secs="$1"; shift
  "$@" > "$OUT_FILE" 2>&1 &
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
    "$SUPERVISORCTL_BIN" -c "$SUPERVISOR_CONF" stop "$COMFY_PROGRAM" > /dev/null 2>&1 || true
  fi
  run_with_timeout "$TIMEOUT_S" "$VASTAI_BIN" destroy instance "$CONTAINER_ID" --api-key "$API_KEY"
  local rc=$? out
  out="$(cat "$OUT_FILE" 2>/dev/null)"
  if [ "$rc" -eq 0 ] || is_gone "$out"; then
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
```

Then: `chmod +x instance/failsafe.sh`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_failsafe.py -q`
Expected: all PASS (about 1 minute in total). If macOS ships bash 3.2 and a construct misbehaves there, fix the script to stay portable; do not require a newer bash because the target image is Linux but the tests run on the dev machine.

- [ ] **Step 5: Commit**

```bash
git add instance/failsafe.sh instance/agent/tests/test_failsafe.py
git commit -m "feat: add the standalone failsafe destroyer"
```

### Task 9: Profile loader, model downloader and node installer

**Files:**
- Create: `instance/agent/vastcomfy_agent/profile.py`
- Test: `instance/agent/tests/test_profile.py`

**Interfaces:**
- Consumes: `files.write_json`, `paths.StatePaths`.
- Produces: `profile.NodeSpec(repo, commit)`, `profile.ModelSpec(file, repo, revision, dest, size_bytes)`, `profile.Profile(name, requires_vram_gb, requires_disk_gb, nodes, models, workflows)`, `profile.load_profile(path)`, `profile.target_path(model, comfy_dir)`, `profile.missing_models(profile, comfy_dir)`, `profile.check_disk(profile, comfy_dir, free_bytes, margin_mb)`, `profile.free_bytes_of(path)`, `profile.ProgressWriter(state_dir, phase)`, `profile.Downloader(*, hf_base, token, client, retries, backoff_s, chunk_bytes, sleep, on_progress)` with `.fetch(model, comfy_dir) -> Path`, `profile.install_nodes(profile, comfy_dir, *, git_host, git_bin, pip_bin, run)`; exceptions `ProfileError, DiskInsufficient, DownloadError, NodeInstallError`.

- [ ] **Step 1: Write the failing tests**

`instance/agent/tests/test_profile.py`:

```python
import subprocess

import httpx
import pytest

from vastcomfy_agent.files import read_json
from vastcomfy_agent.profile import (
    Downloader, DiskInsufficient, DownloadError, ModelSpec, NodeInstallError, NodeSpec, Profile,
    ProfileError, ProgressWriter, check_disk, install_nodes, load_profile, missing_models, target_path,
)

PROFILE_YAML = """
name: image
requires: {vram_gb: 24, disk_gb: 40}
nodes:
  - {repo: city96/ComfyUI-GGUF, commit: abc123}
models:
  - {file: text_encoders/enc.safetensors, repo: org/model, revision: rev1, dest: models/text_encoders/, size_bytes: 100}
  - {file: unet.gguf, repo: org/model, revision: rev1, dest: models/diffusion_models/, size_bytes: 50}
workflows: [flow.json]
"""


def write_profile(tmp_path, text=PROFILE_YAML):
    path = tmp_path / "image.yaml"
    path.write_text(text)
    return path


def test_load_profile_reads_every_field(tmp_path):
    profile = load_profile(write_profile(tmp_path))
    assert profile.name == "image" and profile.requires_vram_gb == 24 and profile.requires_disk_gb == 40
    assert profile.nodes == (NodeSpec("city96/ComfyUI-GGUF", "abc123"),)
    assert profile.models[0] == ModelSpec("text_encoders/enc.safetensors", "org/model", "rev1", "models/text_encoders/", 100)
    assert profile.workflows == ("flow.json",)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda t: t.replace("name: image\n", ""),
        lambda t: t.replace("size_bytes: 100", "size_bytes: 0"),
        lambda t: t.replace("dest: models/text_encoders/", "dest: ../escape/"),
        lambda t: t.replace("dest: models/text_encoders/", "dest: /abs/"),
        lambda t: t.replace("file: unet.gguf", "file: ../unet.gguf"),
        lambda t: t.replace("revision: rev1", "revision: ''", 1),
    ],
)
def test_invalid_profiles_are_rejected(tmp_path, mutation):
    with pytest.raises(ProfileError):
        load_profile(write_profile(tmp_path, mutation(PROFILE_YAML)))


def model(**kw):
    base = dict(file="sub/m.bin", repo="org/m", revision="r1", dest="models/x/", size_bytes=100)
    base.update(kw)
    return ModelSpec(**base)


def make_downloader(handler, *, retries=3, token="", progress=None, sleeps=None, chunk=10):
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return Downloader(
        hf_base="https://hf.test", token=token, client=client, retries=retries, backoff_s=2, chunk_bytes=chunk,
        sleep=(sleeps if sleeps is not None else []).append, on_progress=progress or (lambda *a: None),
    )


def test_fetch_downloads_verifies_size_and_uses_the_resolve_url(tmp_path):
    seen = []

    def handler(request):
        seen.append((request.url.path, request.headers.get("authorization")))
        return httpx.Response(200, content=b"x" * 100)

    progress = []
    path = make_downloader(handler, token="tok", progress=lambda f, d, t: progress.append((f, d, t))).fetch(model(), tmp_path)
    assert path == tmp_path / "models/x/m.bin" and path.stat().st_size == 100
    assert seen == [("/org/m/resolve/r1/sub/m.bin", "Bearer tok")]
    assert progress[-1] == ("m.bin", 100, 100)
    assert not list(path.parent.glob("*.part"))


def test_no_authorization_header_without_a_token(tmp_path):
    seen = []
    make_downloader(lambda r: (seen.append(r.headers.get("authorization")), httpx.Response(200, content=b"x" * 100))[1]).fetch(model(), tmp_path)
    assert seen == [None]


def test_existing_file_with_the_right_size_is_not_downloaded_again(tmp_path):
    target = tmp_path / "models/x/m.bin"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"y" * 100)

    def handler(request):
        raise AssertionError("must not download")

    assert make_downloader(handler).fetch(model(), tmp_path) == target


def test_existing_file_with_the_wrong_size_is_replaced(tmp_path):
    target = tmp_path / "models/x/m.bin"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"short")
    make_downloader(lambda r: httpx.Response(200, content=b"z" * 100)).fetch(model(), tmp_path)
    assert target.read_bytes() == b"z" * 100


def test_server_errors_are_retried_with_backoff(tmp_path):
    answers = [httpx.Response(500), httpx.Response(503), httpx.Response(200, content=b"x" * 100)]
    sleeps = []
    make_downloader(lambda r: answers.pop(0), sleeps=sleeps).fetch(model(), tmp_path)
    assert sleeps == [2, 2]


def test_html_error_page_with_status_200_never_becomes_a_model_file(tmp_path):
    # Review focus 5
    sleeps = []
    downloader = make_downloader(lambda r: httpx.Response(200, content=b"<html>rate limited</html>"), retries=2, sleeps=sleeps)
    with pytest.raises(DownloadError, match="m.bin"):
        downloader.fetch(model(), tmp_path)
    assert sleeps == [2]
    assert list((tmp_path / "models/x").iterdir()) == []


def test_disk_full_mid_download_cleans_up_and_fails(tmp_path):
    calls = []

    def progress(file, done, total):
        calls.append(done)
        if len(calls) == 2:
            raise OSError(28, "No space left on device")

    downloader = make_downloader(lambda r: httpx.Response(200, content=b"x" * 100), retries=1, progress=progress)
    with pytest.raises(DownloadError):
        downloader.fetch(model(), tmp_path)
    assert list((tmp_path / "models/x").iterdir()) == []


def profile_with(models):
    return Profile("p", 24, 40, (), tuple(models), ())


def test_missing_models_and_check_disk(tmp_path):
    a, b = model(file="a.bin", size_bytes=100), model(file="b.bin", size_bytes=50)
    present = target_path(a, tmp_path)
    present.parent.mkdir(parents=True)
    present.write_bytes(b"x" * 100)
    profile = profile_with([a, b])
    assert missing_models(profile, tmp_path) == [b]
    check_disk(profile, tmp_path, free_bytes=50 + 2 * 1024 * 1024, margin_mb=2)
    with pytest.raises(DiskInsufficient, match="free"):
        check_disk(profile, tmp_path, free_bytes=50 + 2 * 1024 * 1024 - 1, margin_mb=2)


def test_progress_writer_records_the_current_file(tmp_path):
    ProgressWriter(tmp_path, "models")("m.bin", 5, 10)
    assert read_json(tmp_path / "progress.json") == {"phase": "models", "file": "m.bin", "bytes_done": 5, "bytes_total": 10}


class FakeRun:
    def __init__(self, tmp_path, head="abc123", fail_on=None):
        self.cmds, self.head, self.fail_on, self.tmp = [], head, fail_on, tmp_path

    def __call__(self, cmd, **kwargs):
        self.cmds.append(cmd)
        if self.fail_on and self.fail_on in cmd:
            return subprocess.CompletedProcess(cmd, 1, "", "fatal: nope")
        if "clone" in cmd:
            dest = cmd[-1]
            import pathlib
            pathlib.Path(dest).mkdir(parents=True)
            (pathlib.Path(dest) / "requirements.txt").write_text("gguf\n")
        if "rev-parse" in cmd:
            return subprocess.CompletedProcess(cmd, 0, self.head + "\n", "")
        return subprocess.CompletedProcess(cmd, 0, "", "")


def node_profile():
    return Profile("p", 24, 40, (NodeSpec("city96/ComfyUI-GGUF", "abc123"),), (), ())


def test_install_nodes_clones_checks_out_the_pinned_commit_and_installs_requirements(tmp_path):
    run = FakeRun(tmp_path)
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", pip_bin="pip", run=run)
    dest = str(tmp_path / "custom_nodes" / "ComfyUI-GGUF")
    assert run.cmds[0] == ["git", "clone", "https://git.test/city96/ComfyUI-GGUF", dest]
    assert ["git", "-C", dest, "checkout", "--detach", "abc123"] in run.cmds
    assert ["pip", "install", "-r", dest + "/requirements.txt"] in run.cmds


def test_install_nodes_skips_a_node_already_at_the_pinned_commit(tmp_path):
    (tmp_path / "custom_nodes" / "ComfyUI-GGUF").mkdir(parents=True)
    run = FakeRun(tmp_path, head="abc123")
    install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", pip_bin="pip", run=run)
    assert all("clone" not in c and "checkout" not in c for c in run.cmds)


def test_install_nodes_failure_raises_with_the_command_context(tmp_path):
    with pytest.raises(NodeInstallError, match="clone"):
        install_nodes(node_profile(), tmp_path, git_host="https://git.test", git_bin="git", pip_bin="pip",
                      run=FakeRun(tmp_path, fail_on="clone"))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_profile.py -q`
Expected: FAIL (`ModuleNotFoundError: vastcomfy_agent.profile`).

- [ ] **Step 3: Implement `profile.py`**

```python
from __future__ import annotations

import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable

import httpx
import yaml

from .files import write_json
from .paths import StatePaths


class ProfileError(Exception):
    pass


class DiskInsufficient(Exception):
    pass


class DownloadError(Exception):
    pass


class NodeInstallError(Exception):
    pass


@dataclass(frozen=True)
class NodeSpec:
    repo: str
    commit: str


@dataclass(frozen=True)
class ModelSpec:
    file: str
    repo: str
    revision: str
    dest: str
    size_bytes: int


@dataclass(frozen=True)
class Profile:
    name: str
    requires_vram_gb: int
    requires_disk_gb: int
    nodes: tuple[NodeSpec, ...]
    models: tuple[ModelSpec, ...]
    workflows: tuple[str, ...]


def _relative(value: str, what: str) -> str:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts:
        raise ProfileError(f"{what} must be a relative path without '..': {value!r}")
    return value


def _required(value: str, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProfileError(f"{what} must be a non-empty string")
    return value


def load_profile(path: Path) -> Profile:
    try:
        raw = yaml.safe_load(Path(path).read_text())
        models = []
        for item in raw["models"]:
            size = int(item["size_bytes"])
            if size <= 0:
                raise ProfileError("size_bytes must be positive")
            models.append(
                ModelSpec(
                    file=_relative(item["file"], "model file"),
                    repo=_required(item["repo"], "model repo"),
                    revision=_required(item["revision"], "model revision"),
                    dest=_relative(item["dest"], "model dest"),
                    size_bytes=size,
                )
            )
        nodes = tuple(
            NodeSpec(_required(n["repo"], "node repo"), _required(n["commit"], "node commit")) for n in raw["nodes"]
        )
        return Profile(
            name=_required(raw["name"], "name"),
            requires_vram_gb=int(raw["requires"]["vram_gb"]),
            requires_disk_gb=int(raw["requires"]["disk_gb"]),
            nodes=nodes,
            models=tuple(models),
            workflows=tuple(_relative(w, "workflow") for w in raw.get("workflows", [])),
        )
    except ProfileError as exc:
        raise ProfileError(f"{path}: {exc}") from None
    except (KeyError, TypeError, ValueError, yaml.YAMLError) as exc:
        raise ProfileError(f"{path}: invalid profile ({exc!r})") from None


def target_path(model: ModelSpec, comfy_dir: Path) -> Path:
    return Path(comfy_dir) / model.dest / PurePosixPath(model.file).name


def missing_models(profile: Profile, comfy_dir: Path) -> list[ModelSpec]:
    missing = []
    for model in profile.models:
        target = target_path(model, comfy_dir)
        if not target.is_file() or target.stat().st_size != model.size_bytes:
            missing.append(model)
    return missing


def check_disk(profile: Profile, comfy_dir: Path, free_bytes: int, margin_mb: int) -> None:
    needed = sum(m.size_bytes for m in missing_models(profile, comfy_dir)) + margin_mb * 1024 * 1024
    if free_bytes < needed:
        raise DiskInsufficient(f"need {needed} bytes, only {free_bytes} free")


def free_bytes_of(path: Path) -> int:
    probe = Path(path)
    while not probe.exists():
        probe = probe.parent
    return shutil.disk_usage(probe).free


class ProgressWriter:
    def __init__(self, state_dir: Path, phase: str):
        self._path = StatePaths(state_dir).progress_json
        self._phase = phase

    def __call__(self, file: str, done: int, total: int) -> None:
        write_json(self._path, {"phase": self._phase, "file": file, "bytes_done": done, "bytes_total": total})


class Downloader:
    def __init__(
        self,
        *,
        hf_base: str,
        token: str,
        client: httpx.Client,
        retries: int,
        backoff_s: int,
        chunk_bytes: int,
        sleep: Callable[[float], None] = time.sleep,
        on_progress: Callable[[str, int, int], None] = lambda *a: None,
    ):
        self._base = hf_base.rstrip("/")
        self._token = token
        self._client = client
        self._retries = retries
        self._backoff = backoff_s
        self._chunk = chunk_bytes
        self._sleep = sleep
        self._on_progress = on_progress

    def fetch(self, model: ModelSpec, comfy_dir: Path) -> Path:
        target = target_path(model, comfy_dir)
        if target.is_file() and target.stat().st_size == model.size_bytes:
            return target
        url = f"{self._base}/{model.repo}/resolve/{model.revision}/{model.file}"
        last: Exception | None = None
        for attempt in range(1, self._retries + 1):
            try:
                self._download(url, target, model)
                return target
            except (httpx.HTTPError, DownloadError, OSError) as exc:
                last = exc
                if attempt < self._retries:
                    self._sleep(self._backoff)
        raise DownloadError(f"{target.name}: {last}")

    def _download(self, url: str, target: Path, model: ModelSpec) -> None:
        part = target.with_name(target.name + ".part")
        target.parent.mkdir(parents=True, exist_ok=True)
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            with self._client.stream("GET", url, headers=headers, follow_redirects=True) as response:
                response.raise_for_status()
                done = 0
                with part.open("wb") as handle:
                    for chunk in response.iter_bytes(self._chunk):
                        handle.write(chunk)
                        done += len(chunk)
                        self._on_progress(target.name, done, model.size_bytes)
            if part.stat().st_size != model.size_bytes:
                raise DownloadError(f"size mismatch: got {part.stat().st_size}, expected {model.size_bytes}")
            os.replace(part, target)
        finally:
            if part.exists():
                part.unlink()


def _run_checked(run: Callable, cmd: list[str], what: str) -> subprocess.CompletedProcess:
    proc = run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise NodeInstallError(f"{what} failed: {(proc.stderr or proc.stdout or '').strip()[:300]}")
    return proc


def install_nodes(
    profile: Profile, comfy_dir: Path, *, git_host: str, git_bin: str, pip_bin: str, run: Callable = subprocess.run
) -> None:
    for node in profile.nodes:
        name = node.repo.rsplit("/", 1)[-1]
        dest = Path(comfy_dir) / "custom_nodes" / name
        if dest.exists():
            head = _run_checked(run, [git_bin, "-C", str(dest), "rev-parse", "HEAD"], f"rev-parse {name}")
            if head.stdout.strip() == node.commit:
                continue
            _run_checked(run, [git_bin, "-C", str(dest), "fetch", "--all", "--tags"], f"fetch {name}")
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            _run_checked(run, [git_bin, "clone", f"{git_host.rstrip('/')}/{node.repo}", str(dest)], f"clone {name}")
        _run_checked(run, [git_bin, "-C", str(dest), "checkout", "--detach", node.commit], f"checkout {name}")
        requirements = dest / "requirements.txt"
        if requirements.exists():
            _run_checked(run, [pip_bin, "install", "-r", str(requirements)], f"pip install {name}")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_profile.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add instance/agent
git commit -m "feat: add profile loader, model downloader and node installer"
```

### Task 10: Boot CLI, `bootstrap.sh` and `supervisord.conf`

**Files:**
- Create: `instance/agent/vastcomfy_agent/boot.py`, `instance/bootstrap.sh` (executable), `instance/supervisord.conf`
- Modify: `instance/agent/vastcomfy_agent/state.py` (add `reset_for_boot`, new reasons), `contracts/config-schema.yaml` (add `TAILSCALED_BIN`, `COMFY_PYTHON`), `instance/allowed-keys.txt` (regenerate)
- Test: `instance/agent/tests/test_boot.py`, `tests/test_bootstrap_script.py`, extend `tests/test_state.py`

**Interfaces:**
- Consumes: everything from Tasks 1-9 (`wiring.build`, `profile.*`, `config.*`, `state.*`, `deadlines.*`).
- Produces: `boot.main(argv=None, environ=os.environ, now=utc_now, run=subprocess.run, http_client=None, free_bytes_fn=free_bytes_of, sleep=time.sleep) -> int` with subcommands `write-env`, `begin`, `init-times`, `fail`, `install-nodes`, `install-models`, `copy-workflows`, `wait --target comfy|agent`, `mark-ready`, `wipe-key`, `env-export`, `get`; exit codes `10` (missing container credentials), `11` (hard cap missing), `12` (boot failed), `13` (config invalid), `0` ok. `StateStore.reset_for_boot()`.

- [ ] **Step 1: Extend the state module (tests first)**

Append to `instance/agent/tests/test_state.py`:

```python
def test_reset_for_boot_forces_booting_from_any_state(tmp_path):
    store = make(tmp_path, 7)
    force(store, State.READY)
    record = store.reset_for_boot()
    assert (record.state, record.reason, record.updated_at) == (State.BOOTING, None, 7)
    assert store.get().state == State.BOOTING


def test_boot_reasons_added_for_supervisor_and_agent_failures():
    assert {"agent_start_failed", "supervisor_failed"} <= REASONS
```

In `state.py` add `"agent_start_failed", "supervisor_failed"` to `REASONS` and this method to `StateStore`:

```python
    def reset_for_boot(self) -> StateRecord:
        """A container (re)start begins a new boot: force `booting` regardless of the previous state."""
        with self._lock:
            record = StateRecord(State.BOOTING, None, self._now())
            write_json(self._path, {"state": State.BOOTING.value, "reason": None, "updated_at": record.updated_at})
            return record
```

Also update the spec's reason list (amendment A0) with `agent_start_failed` and `supervisor_failed`.

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_state.py -q` -> PASS.

- [ ] **Step 2: Add the two schema keys and regenerate the key list**

Add to `contracts/config-schema.yaml` in the binaries block:

```yaml
  - {name: TAILSCALED_BIN, components: [instance], type: str, secret: false, required: false, default: "tailscaled", description: "tailscaled daemon binary"}
  - {name: COMFY_PYTHON, components: [instance], type: str, secret: false, required: false, default: "python3", description: "Python interpreter used to run ComfyUI and the agent"}
```

Run: `cd instance/agent && .venv/bin/python -m vastcomfy_agent.config gen-keys --out ../allowed-keys.txt && .venv/bin/python -m pytest tests/test_config.py -q` -> PASS.

- [ ] **Step 3: Write the failing boot tests**

`instance/agent/tests/test_boot.py`:

```python
import json
import stat
import subprocess
import time

import httpx
import pytest

from vastcomfy_agent import boot
from vastcomfy_agent.config import load_config, parse_env_file
from vastcomfy_agent.deadlines import DeadlineStore
from vastcomfy_agent.state import State, StateStore

T0 = 9_000_000


class Clock:
    def __init__(self):
        self.t = T0

    def __call__(self):
        return self.t


def base_environ(tmp_path, **extra):
    env = {
        "CONTAINER_ID": "42", "CONTAINER_API_KEY": "ck", "AGENT_TOKEN": "tok", "TS_HOSTNAME": "vast-x",
        "REPO_URL": "https://example.invalid/r.git", "REPO_COMMIT": "abc", "PROFILE": "image",
        "STATE_DIR": str(tmp_path / "state"), "ENV_FILE_PATH": str(tmp_path / "etc" / ".env"),
        "REPO_DIR": str(tmp_path / "repo"), "COMFY_DIR": str(tmp_path / "comfy"),
        "WORKFLOWS_DIR": str(tmp_path / "workflows"), "DESTROY_RETRIES": "1", "DESTROY_BACKOFF_S": "0",
        "PATH": "/usr/bin", "PUBLIC_IPADDR": "1.2.3.4", "VAST_CONTAINERLABEL": "C.42",
    }
    env.update(extra)
    return env


class Runner:
    def __init__(self, vast_code=0):
        self.cmds, self.vast_code = [], vast_code

    def __call__(self, cmd, **kwargs):
        self.cmds.append(cmd)
        code = self.vast_code if cmd[0] == "vastai" else 0
        return subprocess.CompletedProcess(cmd, code, "", "err")


def run_boot(tmp_path, argv, environ=None, clock=None, runner=None, **kw):
    environ = environ if environ is not None else base_environ(tmp_path)
    runner = runner or Runner()
    clock = clock or Clock()
    code = boot.main(argv, environ=environ, now=clock, run=runner, **kw)
    return code, runner


def env_file(tmp_path):
    return str(tmp_path / "etc" / ".env")


def states(tmp_path):
    return StateStore(tmp_path / "state", Clock())


def test_write_env_keeps_only_schema_keys_with_defaults_resolved_and_mode_600(tmp_path, capsys):
    code, _ = run_boot(tmp_path, ["write-env"])
    assert code == 0 and capsys.readouterr().out.strip() == env_file(tmp_path)
    written = parse_env_file(tmp_path / "etc" / ".env")
    assert "PATH" not in written and "PUBLIC_IPADDR" not in written and "VAST_CONTAINERLABEL" not in written
    assert written["IDLE_MINUTES"] == "30" and written["COMFY_PORT"] == "8188"
    assert written["KEEP_ON_FAILURE"] == "false" and written["DESTROY_GONE_MARKERS"] == "404,not found,no such instance"
    assert stat.S_IMODE((tmp_path / "etc" / ".env").stat().st_mode) == 0o600
    assert "VAST_API_KEY" not in written


def test_written_env_loads_back_through_the_config_module_with_awkward_values(tmp_path):
    # Review focus 2
    environ = base_environ(tmp_path, TS_AUTHKEY="tskey=abc#def ghi ", HF_TOKEN="hf_a=b")
    assert run_boot(tmp_path, ["write-env"], environ)[0] == 0
    cfg = load_config(tmp_path / "etc" / ".env", "instance")
    assert cfg.ts_authkey == "tskey=abc#def ghi " and cfg.hf_token == "hf_a=b" and cfg.idle_minutes == 30


def test_missing_container_credentials_fails_with_exit_10_and_records_the_reason(tmp_path):
    environ = base_environ(tmp_path)
    del environ["CONTAINER_API_KEY"]
    code, runner = run_boot(tmp_path, ["write-env"], environ)
    assert code == 10
    record = states(tmp_path).get()
    assert (record.state, record.reason) == (State.FAILED, "missing_container_credentials")
    assert runner.cmds == []  # no credentials, so no destroy attempt


def test_other_missing_required_keys_fail_with_exit_13(tmp_path):
    environ = base_environ(tmp_path)
    del environ["AGENT_TOKEN"]
    code, _ = run_boot(tmp_path, ["write-env"], environ)
    assert code == 13 and states(tmp_path).get().reason == "config_invalid"


def test_newline_in_a_value_is_rejected(tmp_path):
    environ = base_environ(tmp_path, TS_HOSTNAME="a\nb")
    assert run_boot(tmp_path, ["write-env"], environ)[0] == 13


def prepared(tmp_path, **extra):
    environ = base_environ(tmp_path, **extra)
    assert run_boot(tmp_path, ["write-env"], environ)[0] == 0
    return environ


def test_begin_resets_the_state_even_after_a_previous_run(tmp_path):
    prepared(tmp_path)
    store = states(tmp_path)
    for s in (State.BOOTING, State.DOWNLOADING, State.READY):
        store.set(s)
    assert run_boot(tmp_path, ["begin", "--env-file", env_file(tmp_path)])[0] == 0
    assert store.get().state == State.BOOTING


def test_init_times_fresh_then_restart_does_not_rewrite(tmp_path, capsys):
    prepared(tmp_path)
    clock = Clock()
    assert run_boot(tmp_path, ["init-times", "--env-file", env_file(tmp_path)], clock=clock)[0] == 0
    assert capsys.readouterr().out.strip().endswith("fresh")
    deadlines = DeadlineStore(tmp_path / "state", clock)
    assert deadlines.deadline() == T0 + 3 * 3600 and deadlines.hard_cap() == T0 + 6 * 3600
    clock.t = T0 + 10 * 3600
    assert run_boot(tmp_path, ["init-times", "--env-file", env_file(tmp_path)], clock=clock)[0] == 0
    assert capsys.readouterr().out.strip().endswith("restart")
    assert deadlines.deadline() == T0 + 3 * 3600


def test_hard_cap_missing_after_first_boot_fails_and_self_destroys(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    run_boot(tmp_path, ["init-times", "--env-file", ef])
    (tmp_path / "state" / "hard_cap").unlink()
    code, runner = run_boot(tmp_path, ["init-times", "--env-file", ef])
    assert code == 11
    assert states(tmp_path).get().state == State.STOPPING and states(tmp_path).get().reason == "hard_cap_missing"
    assert [c[:3] for c in runner.cmds if c[0] == "vastai"] == [["vastai", "destroy", "instance"]]


def test_fail_self_destroys_unless_disabled(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    code, runner = run_boot(tmp_path, ["fail", "tailscale_failed", "--env-file", ef])
    assert code == 12 and states(tmp_path).get().state == State.STOPPING
    assert any(c[0] == "vastai" for c in runner.cmds)


def test_fail_with_no_destroy_flag_or_keep_on_failure_keeps_the_instance(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    code, runner = run_boot(tmp_path, ["fail", "tailscale_failed", "--env-file", ef, "--no-destroy"])
    assert code == 12 and states(tmp_path).get().state == State.FAILED and runner.cmds == []

    other = tmp_path / "second"
    other.mkdir()
    prepared(other, KEEP_ON_FAILURE="true")
    run_boot(other, ["begin", "--env-file", env_file(other)], environ=base_environ(other, KEEP_ON_FAILURE="true"))
    code, runner = run_boot(other, ["fail", "download_failed", "--env-file", env_file(other)],
                            environ=base_environ(other, KEEP_ON_FAILURE="true"))
    assert code == 12 and StateStore(other / "state", Clock()).get().state == State.FAILED and runner.cmds == []


def test_wipe_key_blanks_only_that_key(tmp_path):
    prepared(tmp_path, TS_AUTHKEY="secret-key")
    assert run_boot(tmp_path, ["wipe-key", "TS_AUTHKEY", "--env-file", env_file(tmp_path)])[0] == 0
    written = parse_env_file(tmp_path / "etc" / ".env")
    assert written["TS_AUTHKEY"] == "" and written["AGENT_TOKEN"] == "tok"
    assert "secret-key" not in (tmp_path / "etc" / ".env").read_text()


def test_get_prints_a_single_value(tmp_path, capsys):
    prepared(tmp_path)
    capsys.readouterr()
    run_boot(tmp_path, ["get", "COMFY_PORT", "--env-file", env_file(tmp_path)])
    assert capsys.readouterr().out.strip() == "8188"


def test_env_export_is_shell_safe_and_leaves_secrets_out(tmp_path, capsys):
    prepared(tmp_path, TS_HOSTNAME="a b'c$d", TS_AUTHKEY="tskey-secret")
    capsys.readouterr()
    run_boot(tmp_path, ["env-export", "--env-file", env_file(tmp_path)])
    exported = capsys.readouterr().out
    assert "tskey-secret" not in exported and "CONTAINER_API_KEY" not in exported and "AGENT_TOKEN" not in exported
    out = subprocess.run(["bash", "-c", f'{exported}\nprintf %s "$TS_HOSTNAME"'], capture_output=True, text=True).stdout
    assert out == "a b'c$d"


PROFILE = """
name: image
requires: {vram_gb: 24, disk_gb: 40}
nodes: []
models:
  - {file: m.bin, repo: org/m, revision: r1, dest: models/x/, size_bytes: 10}
workflows: [flow.json]
"""


def with_profile(tmp_path):
    prof = tmp_path / "repo" / "instance" / "profiles"
    prof.mkdir(parents=True)
    (prof / "image.yaml").write_text(PROFILE)
    wf = tmp_path / "repo" / "instance" / "workflows"
    wf.mkdir(parents=True)
    (wf / "flow.json").write_text('{"a": 1}')


def ok_client():
    return httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * 10)))


def test_install_models_downloads_and_moves_to_downloading(tmp_path):
    prepared(tmp_path)
    with_profile(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    code, _ = run_boot(tmp_path, ["install-models", "--env-file", ef], http_client=ok_client(), free_bytes_fn=lambda p: 10**12)
    assert code == 0
    assert (tmp_path / "comfy" / "models" / "x" / "m.bin").stat().st_size == 10
    assert states(tmp_path).get().state == State.DOWNLOADING


def test_install_models_fails_on_insufficient_disk(tmp_path):
    prepared(tmp_path)
    with_profile(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef])
    code, runner = run_boot(tmp_path, ["install-models", "--env-file", ef], http_client=ok_client(), free_bytes_fn=lambda p: 5)
    assert code == 12
    record = states(tmp_path).get()
    assert record.state == State.STOPPING and record.reason == "disk_insufficient"


def test_install_models_fails_when_the_download_keeps_failing(tmp_path):
    environ = prepared(tmp_path, DOWNLOAD_RETRIES="2", DOWNLOAD_BACKOFF_S="0")
    with_profile(tmp_path)
    ef = env_file(tmp_path)
    run_boot(tmp_path, ["begin", "--env-file", ef], environ=environ)
    bad = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    code, _ = run_boot(tmp_path, ["install-models", "--env-file", ef], environ=environ, http_client=bad,
                       free_bytes_fn=lambda p: 10**12)
    assert code == 12 and states(tmp_path).get().reason == "download_failed"
    assert not list((tmp_path / "comfy" / "models" / "x").glob("*"))


def test_copy_workflows_copies_missing_files_and_never_overwrites(tmp_path):
    prepared(tmp_path)
    with_profile(tmp_path)
    ef = env_file(tmp_path)
    assert run_boot(tmp_path, ["copy-workflows", "--env-file", ef])[0] == 0
    target = tmp_path / "workflows" / "flow.json"
    assert json.loads(target.read_text()) == {"a": 1}
    target.write_text('{"user": "edited"}')
    run_boot(tmp_path, ["copy-workflows", "--env-file", ef])
    assert json.loads(target.read_text()) == {"user": "edited"}


def test_mark_ready_moves_to_ready_and_starts_the_idle_timer(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    clock = Clock()
    for argv in (["begin"], ["init-times"]):
        run_boot(tmp_path, argv + ["--env-file", ef], clock=clock)
    store = StateStore(tmp_path / "state", clock)
    store.set(State.DOWNLOADING)
    assert run_boot(tmp_path, ["mark-ready", "--env-file", ef], clock=clock)[0] == 0
    assert store.get().state == State.READY
    assert DeadlineStore(tmp_path / "state", clock).idle_destroy_at() == T0 + 1800


def test_wait_for_comfy_times_out_and_self_destroys(tmp_path):
    environ = prepared(tmp_path, COMFY_START_TIMEOUT_S="30")
    ef = env_file(tmp_path)
    clock = Clock()
    run_boot(tmp_path, ["begin", "--env-file", ef], environ=environ, clock=clock)
    down = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    code, runner = run_boot(
        tmp_path, ["wait", "--target", "comfy", "--env-file", ef], environ=environ, clock=clock,
        http_client=down, sleep=lambda s: setattr(clock, "t", clock.t + s),
    )
    assert code == 12 and states(tmp_path).get().reason == "comfyui_start_failed"
    assert any(c[0] == "vastai" for c in runner.cmds)


def test_wait_for_comfy_returns_when_it_answers(tmp_path):
    prepared(tmp_path)
    ef = env_file(tmp_path)
    up = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    code, _ = run_boot(tmp_path, ["wait", "--target", "comfy", "--env-file", ef], http_client=up, sleep=lambda s: None)
    assert code == 0
```

`instance/agent/tests/test_bootstrap_script.py`:

```python
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "bootstrap.sh"
CONF = Path(__file__).resolve().parents[2] / "supervisord.conf"


def lines():
    return SCRIPT.read_text().splitlines()


def index_of(fragment):
    for number, line in enumerate(lines()):
        if fragment in line and not line.lstrip().startswith("#"):
            return number
    raise AssertionError(f"{fragment!r} not found in bootstrap.sh")


def test_script_has_valid_bash_syntax():
    assert subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True).returncode == 0


def test_safety_nets_come_before_anything_that_can_fail():
    order = [index_of("write-env"), index_of("init-times"), index_of("failsafe.sh"), index_of('"$SUPERVISORD_BIN"'),
             index_of("start tailscaled"), index_of("wipe-key TS_AUTHKEY"), index_of("start agent"),
             index_of("install-nodes"), index_of("install-models"), index_of("copy-workflows"),
             index_of('start "$COMFY_PROGRAM"'), index_of("mark-ready")]
    assert order == sorted(order) and len(set(order)) == len(order)


def test_authkey_is_never_placed_on_a_command_line():
    text = SCRIPT.read_text()
    assert '--auth-key="file:$AUTH_FILE"' in text
    assert '--auth-key="$TS_AUTHKEY"' not in text and "--auth-key=$TS_AUTHKEY" not in text


def test_supervisord_programs_do_not_autostart_and_use_env_expansion_only():
    text = CONF.read_text()
    assert text.count("autostart=false") == 3
    for program in ("tailscaled", "agent", "comfyui"):
        assert f"[program:{program}]" in text
    assert "%(ENV_STATE_DIR)s" in text and "%(ENV_COMFY_PORT)s" in text
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_boot.py tests/test_bootstrap_script.py -q`
Expected: FAIL (`ModuleNotFoundError: vastcomfy_agent.boot`, missing script files).

- [ ] **Step 5: Implement `boot.py`**

```python
from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Mapping

import httpx

from .clock import utc_now
from .comfy import ComfyClient
from .config import ConfigError, KeySpec, default_text, load_config, load_schema, parse_env_file
from .deadlines import DeadlineStore
from .files import atomic_write
from .profile import (
    DiskInsufficient, DownloadError, Downloader, NodeInstallError, ProfileError, ProgressWriter, check_disk,
    free_bytes_of, install_nodes, load_profile, missing_models,
)
from .state import InvalidTransition, State, StateStore
from .wiring import build

EXIT_OK = 0
EXIT_MISSING_CREDS = 10
EXIT_HARD_CAP = 11
EXIT_FAILED = 12
EXIT_CONFIG = 13

CREDENTIAL_KEYS = ("CONTAINER_ID", "CONTAINER_API_KEY")


def instance_specs(schema_path: Path | None = None) -> list[KeySpec]:
    return [s for s in load_schema(schema_path) if "instance" in s.components]


def resolve_env(environ: Mapping[str, str], specs: list[KeySpec]) -> dict[str, str]:
    values = {}
    for spec in specs:
        raw = environ.get(spec.name, "")
        values[spec.name] = raw if raw != "" else default_text(spec)
    return values


def write_env(environ: Mapping[str, str], schema_path: Path | None = None) -> tuple[Path, dict[str, str], list[str]]:
    """Write the instance .env from the process environment: schema keys only, defaults resolved."""
    specs = instance_specs(schema_path)
    values = resolve_env(environ, specs)
    for name, value in values.items():
        if "\n" in value or "\r" in value:
            raise ConfigError(f"{name}: value contains a line break")
    path = Path(values["ENV_FILE_PATH"])
    atomic_write(path, "".join(f"{name}={value}\n" for name, value in values.items()))
    path.chmod(0o600)
    missing = [s.name for s in specs if s.required and values[s.name] == ""]
    return path, values, missing


def _safe_set(states: StateStore, state: State, reason: str | None = None) -> None:
    try:
        states.set(state, reason)
    except InvalidTransition:
        pass


class Boot:
    def __init__(self, env_file: Path, *, now, run, http_client, free_bytes_fn, sleep):
        self.cfg = load_config(env_file, "instance")
        self.env_file = env_file
        self.now, self.run, self.sleep, self.free_bytes_fn = now, run, sleep, free_bytes_fn
        self.http = http_client or httpx.Client(timeout=self.cfg.http_timeout_s)
        self.wired = build(self.cfg, now=now, run=run, http_client=self.http)

    def fail(self, reason: str, destroy: bool = True) -> int:
        _safe_set(self.wired.states, State.FAILED, reason)
        if destroy and not self.cfg.keep_on_failure:
            self.wired.flow.run(reason)
        return EXIT_FAILED

    def profile(self):
        return load_profile(Path(self.cfg.repo_dir) / "instance" / "profiles" / f"{self.cfg.profile}.yaml")


def cmd_write_env(environ, now, schema_path=None) -> int:
    try:
        path, values, missing = write_env(environ, schema_path)
    except ConfigError as exc:
        print(f"boot: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    states = StateStore(Path(values["STATE_DIR"]), now)
    if set(CREDENTIAL_KEYS) & set(missing):
        _safe_set(states, State.FAILED, "missing_container_credentials")
        print(f"boot: missing {', '.join(k for k in CREDENTIAL_KEYS if k in missing)}", file=sys.stderr)
        return EXIT_MISSING_CREDS
    if missing:
        _safe_set(states, State.FAILED, "config_invalid")
        print(f"boot: missing required keys: {', '.join(missing)}", file=sys.stderr)
        return EXIT_CONFIG
    print(path)
    return EXIT_OK


def cmd_init_times(b: Boot) -> int:
    result = DeadlineStore(Path(b.cfg.state_dir), b.now).init_first_boot(b.cfg.failsafe_hours, b.cfg.hard_cap_hours)
    if result == "hard_cap_missing":
        b.fail("hard_cap_missing")
        return EXIT_HARD_CAP
    print(result)
    return EXIT_OK


def cmd_install_nodes(b: Boot) -> int:
    try:
        profile = b.profile()
        install_nodes(profile, Path(b.cfg.comfy_dir), git_host=b.cfg.git_host_url, git_bin=b.cfg.git_bin,
                      pip_bin=b.cfg.pip_bin, run=b.run)
    except (ProfileError, NodeInstallError) as exc:
        print(f"boot: {exc}", file=sys.stderr)
        return b.fail("node_install_failed")
    return EXIT_OK


def cmd_install_models(b: Boot) -> int:
    _safe_set(b.wired.states, State.DOWNLOADING)
    comfy_dir = Path(b.cfg.comfy_dir)
    try:
        profile = b.profile()
        check_disk(profile, comfy_dir, b.free_bytes_fn(comfy_dir), b.cfg.disk_margin_mb)
    except DiskInsufficient as exc:
        print(f"boot: {exc}", file=sys.stderr)
        return b.fail("disk_insufficient")
    except ProfileError as exc:
        print(f"boot: {exc}", file=sys.stderr)
        return b.fail("download_failed")
    downloader = Downloader(
        hf_base=b.cfg.hf_base_url, token=b.cfg.hf_token, client=b.http, retries=b.cfg.download_retries,
        backoff_s=b.cfg.download_backoff_s, chunk_bytes=b.cfg.download_chunk_bytes, sleep=b.sleep,
        on_progress=ProgressWriter(Path(b.cfg.state_dir), "models"),
    )
    try:
        for model in missing_models(profile, comfy_dir):
            downloader.fetch(model, comfy_dir)
    except DownloadError as exc:
        print(f"boot: {exc}", file=sys.stderr)
        return b.fail("download_failed")
    return EXIT_OK


def cmd_copy_workflows(b: Boot) -> int:
    source = Path(b.cfg.repo_dir) / "instance" / "workflows"
    target = Path(b.cfg.workflows_dir)
    target.mkdir(parents=True, exist_ok=True)
    for name in b.profile().workflows:
        destination = target / name
        if not destination.exists():
            shutil.copyfile(source / name, destination)
    return EXIT_OK


def cmd_wait(b: Boot, target: str) -> int:
    if target == "comfy":
        timeout, reason = b.cfg.comfy_start_timeout_s, "comfyui_start_failed"
        check = b.wired.comfy.ready
    else:
        timeout, reason = b.cfg.agent_start_timeout_s, "agent_start_failed"
        base = f"http://{b.cfg.agent_host}:{b.cfg.agent_port}"  # config-lint: ok (local scheme)

        def check() -> bool:
            try:
                return b.http.get(f"{base}/health").status_code == 200
            except httpx.HTTPError:
                return False

    deadline = b.now() + timeout
    while True:
        if check():
            return EXIT_OK
        if b.now() >= deadline:
            return b.fail(reason)
        b.sleep(1)


def cmd_mark_ready(b: Boot) -> int:
    b.wired.idle.start()
    _safe_set(b.wired.states, State.READY)
    return EXIT_OK


def cmd_wipe_key(env_file: Path, key: str) -> int:
    values = parse_env_file(env_file)
    if key not in values:
        print(f"boot: unknown key {key}", file=sys.stderr)
        return EXIT_CONFIG
    values[key] = ""
    atomic_write(env_file, "".join(f"{k}={v}\n" for k, v in values.items()))
    env_file.chmod(0o600)
    return EXIT_OK


def cmd_env_export(env_file: Path) -> int:
    secret = {s.name for s in instance_specs() if s.secret}
    for key, value in parse_env_file(env_file).items():
        if key not in secret:
            print(f"export {key}={shlex.quote(value)}")
    return EXIT_OK


def main(
    argv: list[str] | None = None,
    *,
    environ: Mapping[str, str] = os.environ,
    now: Callable[[], int] = utc_now,
    run: Callable = subprocess.run,
    http_client: httpx.Client | None = None,
    free_bytes_fn: Callable[[Path], int] = free_bytes_of,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    parser = argparse.ArgumentParser(prog="vastcomfy_agent.boot")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("write-env")
    for name in ("begin", "init-times", "install-nodes", "install-models", "copy-workflows", "mark-ready", "env-export"):
        sub.add_parser(name).add_argument("--env-file", type=Path, required=True)
    p = sub.add_parser("fail")
    p.add_argument("reason")
    p.add_argument("--env-file", type=Path, required=True)
    p.add_argument("--no-destroy", action="store_true")
    p = sub.add_parser("wait")
    p.add_argument("--target", choices=["comfy", "agent"], required=True)
    p.add_argument("--env-file", type=Path, required=True)
    p = sub.add_parser("wipe-key")
    p.add_argument("key")
    p.add_argument("--env-file", type=Path, required=True)
    p = sub.add_parser("get")
    p.add_argument("key")
    p.add_argument("--env-file", type=Path, required=True)
    args = parser.parse_args(argv)

    if args.command == "write-env":
        return cmd_write_env(environ, now)
    if args.command == "wipe-key":
        return cmd_wipe_key(args.env_file, args.key)
    if args.command == "env-export":
        return cmd_env_export(args.env_file)
    if args.command == "get":
        print(load_config(args.env_file, "instance").get(args.key))
        return EXIT_OK

    b = Boot(args.env_file, now=now, run=run, http_client=http_client, free_bytes_fn=free_bytes_fn, sleep=sleep)
    if args.command == "begin":
        b.wired.states.reset_for_boot()
        return EXIT_OK
    if args.command == "init-times":
        return cmd_init_times(b)
    if args.command == "fail":
        return b.fail(args.reason, destroy=not args.no_destroy)
    if args.command == "install-nodes":
        return cmd_install_nodes(b)
    if args.command == "install-models":
        return cmd_install_models(b)
    if args.command == "copy-workflows":
        return cmd_copy_workflows(b)
    if args.command == "wait":
        return cmd_wait(b, args.target)
    return cmd_mark_ready(b)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: Write `instance/supervisord.conf`**

```ini
; Every value comes from the instance .env through %(ENV_...)s (exported by bootstrap.sh, non-secret keys only).
; All programs start stopped; bootstrap.sh starts them in order with supervisorctl.
[unix_http_server]
file=%(ENV_STATE_DIR)s/supervisor.sock
chmod=0700

[supervisord]
logfile=%(ENV_STATE_DIR)s/supervisord.log
pidfile=%(ENV_STATE_DIR)s/supervisord.pid

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix://%(ENV_STATE_DIR)s/supervisor.sock

[program:tailscaled]
command=%(ENV_TAILSCALED_BIN)s --tun=userspace-networking --state=%(ENV_STATE_DIR)s/tailscale/tailscaled.state --socket=%(ENV_TS_SOCKET)s
autostart=false
autorestart=true

[program:agent]
command=%(ENV_COMFY_PYTHON)s -m vastcomfy_agent --env-file %(ENV_ENV_FILE_PATH)s
directory=%(ENV_REPO_DIR)s/instance/agent
autostart=false
autorestart=true

[program:comfyui]
command=%(ENV_COMFY_PYTHON)s main.py --listen %(ENV_COMFY_HOST)s --port %(ENV_COMFY_PORT)s
directory=%(ENV_COMFY_DIR)s
autostart=false
autorestart=true
```

If spike S1 found that the stock image already runs supervisord or ComfyUI, adapt this file and the `bootstrap.sh` supervisord step to the S1 decision (for example, use `supervisorctl reread/update` against the existing daemon, or disable the stock services); record the change in the commit message.

- [ ] **Step 7: Write `instance/bootstrap.sh` and make it executable**

```bash
#!/usr/bin/env bash
# Boot sequence for a fresh instance (spec 5.3). Safety nets come first.
# onstart runs: git clone "$REPO_URL" "$REPO_DIR" && git -C "$REPO_DIR" checkout "$REPO_COMMIT" && bash "$REPO_DIR/instance/bootstrap.sh"
# Adjust the supervisord and Tailscale steps to the findings of spikes S1 and S2.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY=python3  # config-lint: ok (interpreter needed before any configuration exists)

"$PY" -m pip install -q "$HERE/agent" || { echo "bootstrap: installing the agent failed" >&2; exit 1; }
boot() { "$PY" -m vastcomfy_agent.boot "$@"; }

# Step 1: credentials. Writes the instance .env from the environment (schema keys only).
ENV_FILE="$(boot write-env)" || exit $?
eval "$(boot env-export --env-file "$ENV_FILE")"  # non-secret keys for supervisord's %(ENV_...)s

die_with() { boot fail "$1" --env-file "$ENV_FILE"; exit $?; }
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
```

Then: `chmod +x instance/bootstrap.sh`.

- [ ] **Step 8: Run the full suite**

Run: `cd instance/agent && .venv/bin/python -m pytest -q`
Expected: all PASS. (The bootstrap order test and the supervisord test run without a GPU; the real boot is verified in Task 13.)

- [ ] **Step 9: Commit**

```bash
git add instance contracts
git commit -m "feat: add boot CLI, bootstrap.sh and supervisord.conf"
```

### Task 11: The no-hardcode lint and the pre-commit hook

**Files:**
- Create: `scripts/check_config_usage.py`
- Modify: `.githooks/pre-commit`
- Test: `instance/agent/tests/test_config_lint.py`

**Interfaces:**
- Consumes: nothing at runtime.
- Produces: `scripts/check_config_usage.py` with functions `scan_text(name, suffix, text) -> list[tuple[int, str, str]]` (line, rule, text) and `scan_paths(paths) -> list[tuple[Path, int, str, str]]`, and a CLI `check_config_usage.py [PATH ...] [--staged]` that exits 1 when anything is found. Rules: `env-read` (reading the environment outside `config.py`/`boot.py`/`config.ts`/`config.js`), `ipv4`, `url`, `port`, `abs-path`. A line containing `config-lint: ok` is exempt; comment lines are ignored; `tests`, `.venv`, `node_modules`, `dist`, `__pycache__` are skipped.

- [ ] **Step 1: Write the failing tests**

`instance/agent/tests/test_config_lint.py`:

```python
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("check_config_usage", ROOT / "scripts" / "check_config_usage.py")
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)


def rules(name, suffix, text):
    return [rule for _, rule, _ in lint.scan_text(name, suffix, text)]


def test_environment_reads_are_only_allowed_in_config_and_boot_modules():
    code = "import os\nvalue = os.environ['X']\nother = os.getenv('Y')\n"
    assert rules("agent.py", ".py", code) == ["env-read", "env-read"]
    assert rules("config.py", ".py", code) == []
    assert rules("boot.py", ".py", code) == []
    assert rules("server.ts", ".ts", "const a = process.env.X;\n") == ["env-read"]
    assert rules("config.ts", ".ts", "export default { a: process.env.X };\n") == []


@pytest.mark.parametrize(
    "line,rule",
    [
        ('host = "10.0.0.5"\n', "ipv4"),
        ('url = "https://example.com/x"\n', "url"),
        ('url = f"http://{host}:{port}"\n', "url"),
        ('addr = "localhost:8188"\n', "port"),
        ("port = 8189\n", "port"),
        ('path = "/var/lib/vastcomfy"\n', "abs-path"),
        ("path = '/opt/thing'\n", "abs-path"),
    ],
)
def test_python_hardcoded_values_are_flagged(line, rule):
    assert rule in rules("mod.py", ".py", line)


def test_marker_comments_docstrings_and_plain_code_are_not_flagged():
    clean = (
        '"""Talks to https://example.com on 10.0.0.1 and /var/lib/x."""\n'
        "# a comment mentioning http://example.com\n"
        'url = f"http://{h}"  # config-lint: ok (local scheme)\n'
        'doc = """\nmultiline mentions /etc/hosts and 127.0.0.1\n"""\n'
        "timeout = 30\n"
        'name = "/queue"\n'
    )
    assert rules("mod.py", ".py", clean) == []


def test_shell_and_conf_rules():
    assert "abs-path" in rules("x.sh", ".sh", "cp a /opt/vast-comfy/b\n")
    assert "url" in rules("x.sh", ".sh", "curl https://example.com\n")
    assert rules("x.sh", ".sh", 'PY=python3  # config-lint: ok (bootstrap)\nexec 2>/dev/null\n') == []
    assert rules("x.sh", ".sh", "# cp a /opt/x\n") == []
    assert "abs-path" in rules("s.conf", ".conf", "file=/var/lib/x.sock\n")
    assert rules("s.conf", ".conf", "file=%(ENV_STATE_DIR)s/supervisor.sock\n; /var/lib comment\n") == []


def test_scan_paths_skips_tests_and_virtualenvs(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "a.py").write_text('x = "10.1.1.1"\n')
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "t.py").write_text('x = "10.1.1.1"\n')
    (tmp_path / ".venv").mkdir()
    (tmp_path / ".venv" / "v.py").write_text('x = "10.1.1.1"\n')
    found = lint.scan_paths([tmp_path])
    assert [(p.name, rule) for p, _, rule, _ in found] == [("a.py", "ipv4")]


def test_the_instance_tree_is_currently_clean():
    findings = lint.scan_paths([ROOT / "instance"])
    assert findings == [], "\n".join(f"{p}:{n}: [{r}] {t}" for p, n, r, t in findings)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_config_lint.py -q`
Expected: FAIL (the script does not exist).

- [ ] **Step 3: Write `scripts/check_config_usage.py`**

```python
#!/usr/bin/env python3
"""No-hardcode lint (spec 14.7): environment reads outside the config modules, and literal
IPs, URLs, ports and absolute system paths in code. A line with `config-lint: ok` is exempt."""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

MARKER = "config-lint: ok"
ENV_MODULES = {"config.py", "boot.py", "config.ts", "config.js", "config.mjs"}
SKIP_DIRS = {"tests", ".venv", "node_modules", "dist", "__pycache__", ".git"}
COMMENT_PREFIX = {".py": "#", ".sh": "#", ".conf": ";", ".ts": "//", ".js": "//", ".mjs": "//"}

IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
URL = re.compile(r"https?://")
PORT = re.compile(r"(?:\bport\s*[=:]\s*\d{2,5}\b)|(?:(?<=[A-Za-z0-9.\]]):\d{4,5}\b)", re.IGNORECASE)
SYSTEM_DIRS = r"(?:etc|var|opt|usr|workspace|tmp|home|root|srv|mnt|run)"
ABS_QUOTED = re.compile(rf"""["'`]/{SYSTEM_DIRS}(?:/|\b)""")
ABS_BARE = re.compile(rf"""(?<![\w$%){{}}"'])/{SYSTEM_DIRS}/""")
ENV_READ = re.compile(r"os\.environ|os\.getenv|process\.env")


def scan_text(name: str, suffix: str, text: str) -> list[tuple[int, str, str]]:
    comment = COMMENT_PREFIX[suffix]
    shell_like = suffix in {".sh", ".conf"}
    findings: list[tuple[int, str, str]] = []
    in_docstring = False
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if suffix == ".py":
            if stripped.startswith('"""') and stripped.endswith('"""') and len(stripped) > 3:
                continue
            if stripped.count('"""') % 2 == 1:
                in_docstring = not in_docstring
                continue
            if in_docstring:
                continue
        if not stripped or stripped.startswith(comment) or MARKER in line:
            continue
        if not shell_like and name not in ENV_MODULES and ENV_READ.search(line):
            findings.append((number, "env-read", stripped))
        if URL.search(line):
            findings.append((number, "url", stripped))
        if IPV4.search(line):
            findings.append((number, "ipv4", stripped))
        if PORT.search(line):
            findings.append((number, "port", stripped))
        if (ABS_BARE.search(line) if shell_like else ABS_QUOTED.search(line)) or (shell_like and ABS_QUOTED.search(line)):
            findings.append((number, "abs-path", stripped))
    return findings


def _files(path: Path):
    """Yield lintable files under `path`; skip directories are judged relative to `path`."""
    if path.is_file():
        yield path
        return
    for item in sorted(path.rglob("*")):
        if item.is_file() and item.suffix in COMMENT_PREFIX and not (set(item.relative_to(path).parts) & SKIP_DIRS):
            yield item


def scan_paths(paths: list[Path]) -> list[tuple[Path, int, str, str]]:
    found = []
    for path in paths:
        for file in _files(Path(path)):
            for number, rule, text in scan_text(file.name, file.suffix, file.read_text()):
                found.append((file, number, rule, text))
    return found


def _staged() -> list[Path]:
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"], capture_output=True, text=True, check=True
    ).stdout
    return [
        Path(line)
        for line in out.splitlines()
        if Path(line).suffix in COMMENT_PREFIX and not (set(Path(line).parts) & SKIP_DIRS)
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path)
    parser.add_argument("--staged", action="store_true", help="lint only staged files")
    args = parser.parse_args(argv)
    targets = _staged() if args.staged else (args.paths or [Path("instance"), Path("apps")])
    findings = scan_paths([t for t in targets if t.exists()])
    for path, number, rule, text in findings:
        print(f"{path}:{number}: [{rule}] {text}", file=sys.stderr)
    if findings:
        print(f"{len(findings)} hardcoded-config finding(s); move them to contracts/config-schema.yaml "
              f"or mark the line with '{MARKER}'", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the lint tests; fix real findings in the tree if any**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_config_lint.py -q`
Expected: PASS. If `test_the_instance_tree_is_currently_clean` reports findings, treat each as real: move the value into the config schema (preferred) or, for a protocol literal that must stay, add `# config-lint: ok (reason)` on that line. Do not loosen the lint rules to make the test pass.

- [ ] **Step 5: Wire the lint into the pre-commit hook**

Replace `.githooks/pre-commit` with:

```bash
#!/usr/bin/env bash
set -e
root="$(git rev-parse --show-toplevel)"
"$root/scripts/check-secrets.sh"
python3 "$root/scripts/check_config_usage.py" --staged
```

Run: `chmod +x scripts/check_config_usage.py .githooks/pre-commit`. Verify the hook blocks: stage a scratch file `instance/agent/vastcomfy_agent/tmp_probe.py` containing `HOST = "10.0.0.5"`, run `git commit -m probe` (expect a refusal naming the line), then `git reset -q && rm instance/agent/vastcomfy_agent/tmp_probe.py`.

- [ ] **Step 6: Commit**

```bash
git add scripts .githooks instance
git commit -m "feat: add the no-hardcode lint and run it in the pre-commit hook"
```

### Task 12: Generated contracts (OpenAPI, status schema) and the registry schema

**Files:**
- Create: `instance/agent/vastcomfy_agent/contracts_export.py`, `contracts/agent.openapi.json`, `contracts/status.schema.json`, `contracts/instance-registry.schema.json`
- Test: `instance/agent/tests/test_contracts.py`

**Interfaces:**
- Consumes: `app.create_app/Deps`, `models.Status`.
- Produces: `contracts_export.build_contracts() -> dict[str, str]` (file name -> text), CLI `python -m vastcomfy_agent.contracts_export --out DIR`; the three committed contract files; the TypeScript side (sub-projects 2-3) generates its types from `agent.openapi.json`.

- [ ] **Step 1: Write the failing tests**

`instance/agent/tests/test_contracts.py`:

```python
import json
from pathlib import Path

import jsonschema

from vastcomfy_agent.contracts_export import build_contracts

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def test_committed_generated_contracts_are_current():
    for name, text in build_contracts().items():
        assert (CONTRACTS / name).read_text() == text, f"{name} is stale; run contracts_export"


def test_openapi_lists_every_endpoint_of_the_spec():
    paths = json.loads((CONTRACTS / "agent.openapi.json").read_text())["paths"]
    assert set(paths) == {"/health", "/status", "/extend", "/destroy", "/workflows", "/workflows/{name}"}
    assert set(paths["/workflows/{name}"]) == {"get", "put"}
    assert json.loads((CONTRACTS / "agent.openapi.json").read_text())["openapi"].startswith("3.1")


def test_status_schema_requires_the_fields_the_watchdog_reads():
    schema = json.loads((CONTRACTS / "status.schema.json").read_text())
    required = set(schema["required"])
    assert {"state", "now", "boot_at", "queue", "failsafe_alive", "destroy", "hard_cap_at", "failsafe_at"} <= required
    assert schema["properties"]["schema_version"]["const"] == 1


def test_registry_schema_is_valid_and_accepts_a_sample_record():
    schema = json.loads((CONTRACTS / "instance-registry.schema.json").read_text())
    jsonschema.Draft202012Validator.check_schema(schema)
    record = {
        "vast_instance_id": 123, "created_at": 1_700_000_000, "vast_start_date": 1_700_000_005.5,
        "profile": "image", "agent_token": "x" * 32, "tailnet_hostname": "vast-ab12",
        "status": "booting", "unreachable_since": None,
    }
    jsonschema.validate(record, schema)
    for broken in ({**record, "status": "weird"}, {**record, "extra": 1}, {k: v for k, v in record.items() if k != "profile"}):
        try:
            jsonschema.validate(broken, schema)
        except jsonschema.ValidationError:
            continue
        raise AssertionError("schema accepted a broken record")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest tests/test_contracts.py -q`
Expected: FAIL (`ModuleNotFoundError: vastcomfy_agent.contracts_export`).

- [ ] **Step 3: Implement `contracts_export.py`**

```python
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .app import Deps, create_app
from .models import Status


def _dump(value) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def build_contracts() -> dict[str, str]:
    """Contracts generated from the code, so they cannot drift (the registry schema is hand-written)."""
    app = create_app(Deps(cfg=None, states=None, deadlines=None, status=None, flow=None, workflows=None))
    return {
        "agent.openapi.json": _dump(app.openapi()),
        "status.schema.json": _dump(Status.model_json_schema()),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vastcomfy_agent.contracts_export")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    for name, text in build_contracts().items():
        (args.out / name).write_text(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Write the registry schema and generate the other contracts**

Create `contracts/instance-registry.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "InstanceRegistryRecord",
  "description": "One record per Vast instance, kept on the homelab by the bot and the watchdog (spec 7.1). Never committed with real data.",
  "type": "object",
  "required": ["vast_instance_id", "created_at", "profile", "agent_token", "tailnet_hostname", "status"],
  "additionalProperties": false,
  "properties": {
    "vast_instance_id": {"type": "integer"},
    "created_at": {"type": "integer", "description": "epoch UTC seconds on the homelab clock"},
    "vast_start_date": {"type": ["number", "null"], "description": "Vast's own start timestamp, the independent source for the hard cap"},
    "profile": {"type": "string"},
    "agent_token": {"type": "string", "minLength": 16},
    "tailnet_hostname": {"type": "string"},
    "status": {"enum": ["creating", "booting", "ready", "stopping", "gone", "anomaly"]},
    "unreachable_since": {"type": ["integer", "null"]}
  }
}
```

Run: `cd instance/agent && .venv/bin/python -m vastcomfy_agent.contracts_export --out ../../contracts`
Expected: `contracts/agent.openapi.json` and `contracts/status.schema.json` exist.

- [ ] **Step 5: Run the full suite**

Run: `cd instance/agent && .venv/bin/python -m pytest -q`
Expected: all PASS. If a FastAPI upgrade changes the OpenAPI output, regenerate with the command above and re-run; never edit the generated files by hand.

- [ ] **Step 6: Commit**

```bash
git add contracts instance/agent
git commit -m "feat: generate agent OpenAPI and status schema, add registry schema"
```

---

## Phase C: Real-world verification

### Task 13: Full boot and safety verification on a real Vast instance

**Files:**
- Create: `docs/verification/instance-runtime.md`

**Interfaces:**
- Consumes: the repository pushed (publicly) to GitHub, spike findings, all of Phase B.
- Produces: a verification log proving the done criteria of spec section 12.

This task rents GPUs and spends money: get the user's go-ahead and a budget cap first (suggest $3), and let the user run every command that handles keys. Do not paste secrets anywhere.

- [ ] **Step 1: Prepare** (user actions, confirm each)

1. The user pushes the repo to a public GitHub repository and tells you the URL and the commit sha to test. (No GitHub secret scanning is used; the local hook is the guard, so run `git log -p | gitleaks stdin --no-banner` once before publishing.)
2. The user creates a single-use, ephemeral, `tag:gpu` Tailscale key per instance (S5 findings) and a random agent token (`python3 -c "import secrets; print(secrets.token_urlsafe(32))"`), keeping both in their shell.
3. Decide the test shortenings: `IDLE_MINUTES=3`, `IDLE_WARN_MINUTES=1`, `FAILSAFE_HOURS=1`, `HARD_CAP_HOURS=2`.

- [ ] **Step 2: Create the instance with the bot's future env contract**

Use the template/image and offer chosen in spikes S1/S3, and `vastai create instance --help` for the exact flags. Pass the environment as in spec 7.2: `AGENT_TOKEN, TS_AUTHKEY, TS_HOSTNAME, REPO_URL, REPO_COMMIT, PROFILE=image, IDLE_MINUTES, IDLE_WARN_MINUTES, FAILSAFE_HOURS, HARD_CAP_HOURS` (and `HF_TOKEN` if S3 needed one), with the onstart command from the S1 decision:
`git clone "$REPO_URL" "$REPO_DIR" && git -C "$REPO_DIR" checkout "$REPO_COMMIT" && bash "$REPO_DIR/instance/bootstrap.sh"`
(`REPO_DIR` is a schema key with a default; if the default path is not writable on this image, set it here and record it in the S1 notes.) Record the creation time, instance id and price.

- [ ] **Step 3: Boot verification**

From the laptop (Tailscale on), poll the agent without printing the token:
`while true; do curl -s -m 5 -H "Authorization: Bearer $AGENT_TOKEN" http://<ts-hostname>:<agent-port>/status | python3 -m json.tool | grep -E '"(state|reason|uptime_s)"'; sleep 15; done`
Record: time to `ready` (from `first_boot_at` / `uptime_s`), the sequence of states, download progress behaviour, and any `failed` reason. Open ComfyUI at `http://<ts-hostname>:<comfy-port>`, load the bundled workflow, generate one image. Record the generation time.

- [ ] **Step 4: Safety verification (each on its own short-lived instance; record the result and the cost)**

1. **Idle destroy:** after the image, do nothing. Expect `idle-warning` at about 2 minutes (`IDLE_MINUTES - IDLE_WARN_MINUTES`) and the instance gone (`vastai show instances`) at 3 minutes. Confirm in the Vast console that the instance is gone and billing stopped.
2. **Extend:** while in `idle-warning`, `POST /extend {"kind":"idle","minutes":5}`; expect state back to `ready` and the new `idle_destroy_at`. Try `minutes: 0`, `-1` and `99999`: expect HTTP 400 and unchanged deadlines.
3. **Failsafe with a dead agent:** SSH in, `echo $(( $(date +%s) + 300 )) > <STATE_DIR>/deadline` (atomic write not needed for a manual test), `supervisorctl stop agent`, and keep the instance busy or idle. Expect the instance destroyed at the new deadline even though the agent is down.
4. **Dead failsafe is visible:** on a fresh instance `kill $(cat <STATE_DIR>/failsafe.pid)` and check `/status` shows `failsafe_alive: false` (the watchdog action comes in sub-project 2). Destroy the instance manually afterwards.
5. **Container restart:** `vastai stop instance` then `start instance`. Record whether `onstart` re-ran, that `first_boot_at`, `deadline` and `hard_cap` are unchanged, and that bootstrap reaches `ready` again (state reset to `booting` first).
6. **Missing hard cap:** delete `<STATE_DIR>/hard_cap`, restart the container, expect `failed` with `hard_cap_missing` and a self-destroy.
7. **Boot failure self-destroys:** create an instance with a wrong `REPO_COMMIT`-independent failure (for example `PROFILE=does-not-exist`); expect `failed` then the instance gone without any manual step. Repeat once with `KEEP_ON_FAILURE=true` and confirm it stays up (then destroy it manually).
8. **No public exposure:** `vastai show instance <id> --raw` shows no public mapping for the ComfyUI/agent ports; probe the public IP from outside; confirm a non-owner device is refused by the ACL.

- [ ] **Step 5: Write the verification log**

Write `docs/verification/instance-runtime.md`: for each item above the date, instance id, result (PASS/FAIL), measurements (time to ready, seconds per image, total cost), and the exact deviations. Map every row of spec section 10 to the test or the real-world item that covers it, and list anything not covered.

- [ ] **Step 6: Gate and commit**

**Gate:** if any item in Step 4 fails, fix it (new task or amend the owning task with a failing test first), then repeat that item. When all pass:

```bash
git add docs/verification/instance-runtime.md
git commit -m "docs: record real-world verification of the instance runtime"
```

---

## Spec Coverage

| Spec requirement | Task |
|---|---|
| 4: spikes S4, S1, S2, S3, S5 and their pass criteria | A1-A5, A6 |
| 5.1 process layout, supervisord programs `autostart=false` | 10 |
| 5.2 state directory, file ownership, atomic epoch files | 2, 3, 6, 8, 10 |
| 5.3 boot order, fail-closed credentials, self-destroy on failure, `first_boot_at` | 10 (+ 3 for time files) |
| 5.4 failsafe (hard cap in memory/computed, corrupt deadline, retries, idempotent, `$SECONDS` guard, pid) | 8 |
| 5.5 idle watcher, extend semantics, persistence | 3, 7 |
| 5.6 state machine and reasons | 2, 10 (+ A0 spec amendment) |
| 6 agent API (auth, `/status`, `/extend`, `/destroy`, workflows) | 5, 6 |
| 6.1 `/status` schema | 5, 12 |
| 7 / 7.1 / 7.2 watchdog contract, registry, env injection | 12 (registry schema), 10 (env keys); watchdog logic itself is sub-project 2 |
| 8 profiles, download rules, disk check, nodes | 9, 10 |
| 9 security (token, ACL, key wipe, workflow validation, no ComfyUI-Manager) | 6, 8, 10, A3, 13 |
| 10 error handling rows | 8, 9, 10, 13 |
| 11 tests (local and real) | every task, 13 |
| 12 done criteria | 13 |
| 14 config schema, single loader, fail fast, no example file, secret scan, no hardcoded config | 1, 10, 11 |
| 15 contracts | 12 |

Not in this plan on purpose: the watchdog (sub-project 2), the bot and the web page (sub-project 3), video/3D profiles (sub-project 4), GitHub-side secret scanning (declined by the user).

