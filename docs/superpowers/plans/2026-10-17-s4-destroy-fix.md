# S4 Destroy Command Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the self-destroy path (`Destroyer` in the agent and `failsafe.sh`) actually destroy a real Vast.ai instance, using the facts measured in spike S4.

**Architecture:** No new components. Change the destroy command line, replace the "exit code 0 means success" rule by output-text rules (the `vastai` CLI always exits 0), add one config key for the success marker, and make every test stub behave like the real CLI.

**Tech Stack:** Python 3.10+ (pytest), bash, the existing `vastcomfy_agent` package, contracts/config-schema.yaml.

**Spec:** `docs/superpowers/specs/2026-10-16-instance-runtime-design.md` (sections 5.4, 9, 10, 14, 16) and the findings document `docs/spikes/S4-destroy-from-instance.md` (read it first: it is the authority for the CLI behaviour).

## Global Constraints

- **Measured CLI behaviour (S4):** (1) `vastai destroy instance <id>` asks for an interactive confirmation and prints `Aborted.` without a TTY; it destroys nothing unless `-y` is given. (2) The exit code is **always 0**, also on failure. (3) Success prints `destroying instance <id>.`. (4) A missing/already gone instance prints `Failed with error 404: Instance <id> not found.`. (5) Any other failure prints `Failed with error <code>: <message>` (for example `Failed with error 401: Authorization Error ...`) or `Aborted.`. (6) `destroy ... --raw` succeeds with EMPTY output, so `--raw` must not be used.
- **The one correct command:** `vastai destroy instance <id> -y --api-key <key>` (plain output, no `--raw`).
- **Success rule (both implementations):** take the combined stdout+stderr, remove the instance id and the API key from it (so an id like 14040404 can never match), compare case-insensitively. **Success** if it contains any marker of `DESTROY_OK_MARKERS` (default `destroying instance`) OR any marker of `DESTROY_GONE_MARKERS` (default `Failed with error 404`). **Everything else is a failure**, including empty output, `Aborted.`, `Failed with error 401/500`, and any output when the exit status is 124 (timeout), 126 or 127. The exit status 0 carries NO information and must never make an attempt succeed by itself.
- **No hardcoded config:** markers and binary names come from config (`contracts/config-schema.yaml`); the lint (`scripts/check_config_usage.py`) runs in the pre-commit hook.
- **Tests must mimic the real CLI:** stubs return exit status 0 with the realistic texts above; at least one test per implementation proves that exit status 0 with a failure text or with empty output is a FAILED attempt.
- **Commits:** English messages ending with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never `--no-verify`; keep generated files (`instance/allowed-keys.txt`, `contracts/*.json`) current.

## Review Focus

1. **Exit status 0 with a failure text** (`Failed with error 401: ...`) must be a failure in the Python Destroyer and in failsafe.sh; and empty output (what `--raw` prints on success, or a CLI that crashes silently) must be a failure.
2. **An instance id or key echoed in an error** must not match a marker (id/key stripping happens before matching), including ids containing `404`.
3. **`Aborted.`** (command run without `-y`) must be a failure, not success.

---

### Task 1: Use `-y` and decide destroy success from the output text

**Files:**
- Modify: `instance/agent/vastcomfy_agent/destroyer.py`, `instance/agent/vastcomfy_agent/wiring.py`, `instance/failsafe.sh`, `contracts/config-schema.yaml`, `instance/allowed-keys.txt` (regenerate), `docs/superpowers/specs/2026-10-16-instance-runtime-design.md`, `docs/spikes/S4-destroy-from-instance.md`
- Modify (tests): `instance/agent/tests/test_destroyer.py`, `instance/agent/tests/test_failsafe.py`, `instance/agent/tests/test_wiring.py`, `instance/agent/tests/test_boot.py`, plus any other test whose fake `vastai` still relies on "rc 0 means success" (search the tests for `vastai` and for `returncode`/`CompletedProcess` fakes).

**Interfaces:**
- Consumes: `Destroyer(*, vastai_bin, container_id, api_key, retries, backoff_s, timeout_s, gone_markers, state_dir, run, sleep)` today.
- Produces: the same constructor plus a new keyword `ok_markers: Sequence[str]`; `wiring.build` passes `cfg.destroy_ok_markers`; schema key `DESTROY_OK_MARKERS` (type csv, instance, non-secret, default `destroying instance`); `DESTROY_GONE_MARKERS` default becomes `Failed with error 404`; failsafe.sh reads `DESTROY_OK_MARKERS` from the instance `.env` (and the startup check lists it as required).

- [ ] **Step 1: Write the failing tests (Python Destroyer)**

In `instance/agent/tests/test_destroyer.py` update the fakes so they mimic the real CLI and add regression tests, all with exit status 0:
- command is exactly `["vastai","destroy","instance","42","-y","--api-key",KEY]`;
- stdout `destroying instance 42.` -> success (first attempt, one call);
- stdout `Failed with error 404: Instance 42 not found.` -> success (gone);
- stdout `Failed with error 401: Authorization Error. Your key lacks proper privileges to perform this action, due to a constraint on id` -> FAILED attempt, retried, `last_error` recorded without the key;
- empty output -> FAILED attempt; `Aborted.` -> FAILED attempt;
- exit status 124/126/127 with output containing an OK marker -> FAILED attempt;
- an instance id containing `404` echoed in a non-404 error (for example id `14040404`, text `Failed with error 500: backend 14040404 timeout`) -> FAILED attempt;
- markers match case-insensitively.
Update every other test that fakes a successful `vastai` call (`test_wiring.py`, `test_boot.py`, any other) to print `destroying instance <id>.` and to expect the new command.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest -q tests/test_destroyer.py tests/test_wiring.py tests/test_boot.py -x`
Expected: FAIL (old command, rc-based success).

- [ ] **Step 3: Implement the Python side**

`destroyer.py`: add `-y` to the command; add the `ok_markers` argument; rewrite `attempt()` so that success is decided only by the text rule in Global Constraints (strip id and key first; exit status 124/126/127 and `TimeoutExpired`/`FileNotFoundError`/`OSError` are failures; exit status 0 is NOT success by itself). Keep the existing redaction, bounded `last_error` and retry/backoff behaviour. `wiring.py`: pass `ok_markers=cfg.destroy_ok_markers`. `contracts/config-schema.yaml`: add `DESTROY_OK_MARKERS`, change the `DESTROY_GONE_MARKERS` default and descriptions; regenerate `instance/allowed-keys.txt` with `cd instance/agent && .venv/bin/python -m vastcomfy_agent.config gen-keys --out ../allowed-keys.txt`; regenerate the contracts if they change (`.venv/bin/python -m vastcomfy_agent.contracts_export --out ../../contracts`).

- [ ] **Step 4: Run the Python tests to verify they pass**

Run: `cd instance/agent && .venv/bin/python -m pytest -q tests/test_destroyer.py tests/test_wiring.py tests/test_boot.py tests/test_config.py tests/test_contracts.py`
Expected: PASS.

- [ ] **Step 5: Write the failing tests (failsafe.sh)**

In `instance/agent/tests/test_failsafe.py` the `vastai` stub (written by the `setup` helper) must behave like the real CLI: exit status 0 always, printing `destroying instance <id>.` on success, `Failed with error 401: Authorization Error ...` for the failing calls (replace the old `exit 1` + stderr text), `Failed with error 404: Instance <id> not found.` for gone, and a way to print nothing. Add `DESTROY_OK_MARKERS=destroying instance` (and the new default for `DESTROY_GONE_MARKERS`) to the env file the tests write, and make the log assertion expect `destroy instance 42 -y --api-key <KEY>`. Add regression tests: exit status 0 + `Failed with error 401...` is a failure (pending:true, still running, retried); empty output with exit status 0 is a failure; `Aborted.` is a failure; the existing tests for exit 127/124 with marker text, id/key echoing and the hung call still hold; a missing `DESTROY_OK_MARKERS` key exits 2 and names it.

- [ ] **Step 6: Run them to verify they fail**

Run: `cd instance/agent && .venv/bin/python -m pytest -q tests/test_failsafe.py -x`
Expected: FAIL.

- [ ] **Step 7: Implement failsafe.sh**

Add `-y` to the destroy call; read `DESTROY_OK_MARKERS` (add it to the required-keys startup list and error message); decide success exactly as in Global Constraints (after the existing id/key scrubbing, case-insensitive: OK markers OR gone markers; never trust the exit status 0; 124/126/127 are never success). Keep bash 3.2 portability, the timeout wrapper, atomic writes and every behaviour already reviewed. Update the key-validation and tests accordingly.

- [ ] **Step 8: Run the whole suite and the lint**

Run: `cd instance/agent && .venv/bin/python -m pytest -q -W error` (about 2 minutes) and `python3 ../../scripts/check_config_usage.py ../../instance`
Expected: all PASS, lint exit 0.

- [ ] **Step 9: Update the spec and the findings document**

In the spec: section 5.4 and 10 (destroy command with `-y`, success decided from the output text, the CLI always exits 0), section 14 (new key `DESTROY_OK_MARKERS`, new default for `DESTROY_GONE_MARKERS`), section 16 (the container key can list every instance of the account but can only write to its own id). In `docs/spikes/S4-destroy-from-instance.md` tick the first Follow-up as done (add a line pointing to this plan).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "fix: destroy with -y and decide success from the vastai output text

The CLI needs -y without a TTY and always exits 0, so the exit status is
ignored: success is 'destroying instance' or a 404, anything else fails.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
