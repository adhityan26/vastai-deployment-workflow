# GPU Choice on Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin choose the GPU model when pressing Start (dropdown with live prices), remember the choice per browser, show the GPU name in the status card and the Start dialog, and make a failed Start visible and diagnosable.

**Architecture:** `VAST_ALLOWED_GPUS` becomes the allow-list of selectable GPU models (default `RTX A5000,RTX 3090,RTX 4090`: Ampere or newer, never Pascal/Volta, which the image's CUDA 12.9 PyTorch does not support). A new admin endpoint lists the allowed models with the cheapest current offer each; `POST /api/start` accepts an optional `gpu` that must be in the allow-list; the page shows a dropdown in the Start dialog and remembers the last choice in `localStorage`.

**Tech Stack:** Node 20+, TypeScript strict, Fastify, Vitest; the existing page (vanilla TS + esbuild).

**Spec:** `docs/superpowers/specs/2026-10-17-web-interface-design.md` (sections 3 and 4b: offer filters from config). Facts: on 2026-10-18 the first deployed Start picked a Tesla P40 (cheapest offer) because the allow-list was empty; the proven GPU is RTX A5000 (docs/spikes/T13-boot-end-to-end.md).

## Global Constraints

- Everything in `docs/superpowers/plans/2026-10-17-web-interface.md` and `2026-10-18-oidc-login.md` "Global Constraints" still applies (no hardcoded config: all values from `contracts/config-schema.yaml` component `apps`; env read only in `apps/core/src/config.ts`; lint `python3 scripts/check_config_usage.py apps instance`; no secrets in logs/errors/browser; English comments and commits; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (an opus implementer uses its own model name); never `--no-verify`; never `git add -f` anything under `.superpowers`).
- **Server decides:** the browser only sends a GPU model NAME; the server validates it against `VAST_ALLOWED_GPUS` (exact match after the same normalisation the offer query uses) and rejects anything else with 400 `gpu_not_allowed`. No offer id, price or filter ever comes from the browser.
- **Fail safe:** an empty `VAST_ALLOWED_GPUS` must NOT mean "any GPU" any more for the web service: when empty, Start and the GPU list fail closed with 409/503 `no_gpu_configured` (and a clear startup warning). The schema default is `RTX A5000,RTX 3090,RTX 4090`.
- The status/estimate/list responses must never leak internals (offer ids are allowed only inside the server).

## File Structure

```
contracts/config-schema.yaml     VAST_ALLOWED_GPUS default + description
apps/core/src/vast.ts            offer search helpers (per-GPU cheapest)
apps/core/src/lifecycle.ts       estimate(gpu?), start(gpu?), gpu list, gpu_name in the status view
apps/web/src/routes.ts           GET /api/gpus (admin), GET /api/estimate?gpu=, POST /api/start {confirm, gpu?}
contracts/web.openapi.json
apps/web/public/{ui.ts,model.ts,index.html,style.css}   dropdown, memory, GPU name, error visibility
```

---

### Task 1: Server side (config, lifecycle, routes)

**Files:** Modify the files above (config, vast.ts, lifecycle.ts, routes.ts, web.openapi.json) and their tests in `apps/core/tests` and `apps/web/tests`; main.ts only if wiring is needed.

**Interfaces:**
- `Lifecycle.gpuOptions(): Promise<GpuOption[]>` where `GpuOption = {name: string, dph: number | null, vram_gb: number | null, available: boolean}` — one entry per allowed model (config order), `dph` = cheapest matching offer price under the other filters (max price, reliability, download, disk, VRAM), `available: false` and `dph: null` when no offer matches. One Vast search is enough (query all allowed names, group by `gpu_name`).
- `Lifecycle.estimate(gpu?: string)` and `Lifecycle.start(gpu?: string)`: when `gpu` is given it must be in the allow-list (else `RefusedError`-style error mapped to 400 `gpu_not_allowed`) and the offer search is restricted to that model; when omitted the cheapest offer among ALL allowed models is used (as before, but never outside the allow-list). Empty allow-list -> `NoGpuConfiguredError`.
- `StatusView` gains `gpu_name: string | null` (from the Vast instance row for the active record, or from the estimate recorded at start; the record schema stays unchanged unless you decide a `gpu_name` field is needed — if you add it to `contracts/instance-registry.schema.json` make it optional and keep the Python contract tests green).
- Routes: `GET /api/gpus` (admin) -> `{gpus: GpuOption[]}`; `GET /api/estimate?gpu=NAME` (admin); `POST /api/start` body `{confirm: true, gpu?: string}` (schema `additionalProperties: false`, `gpu` string max 64); errors: 400 `gpu_not_allowed`, 409/503 `no_gpu_configured`, 409 `no_offers` for the chosen model. `GET /api/state` includes `gpu_name` and, for admins only, nothing else new.
- Failed Start diagnosability: log `start failed: <ErrorName> (internal: <fixed reason>)` where reason is a fixed identifier such as `ts_key_missing`, `no_offers`, `offer_gone`, `vast_rejected`, `registry_busy`, `unexpected` (never provider text or secrets); add a typed reason to `StartError` for the cases the code already distinguishes (an empty/unreadable Tailscale key file must give `ts_key_missing`). The HTTP error body for a failed Start carries a stable `code` (e.g. `start_failed` plus `reason` from the fixed set) and a short English message the page can show.

- [ ] **Step 1: Failing tests:** gpuOptions groups one search by model, keeps config order, marks unavailable models, ignores GPUs outside the allow-list even if Vast returns them; `start("RTX 4090")` searches only that model; `start("Tesla P40")` -> `gpu_not_allowed` and NO Vast call; start with omitted gpu never selects a model outside the allow-list; empty allow-list -> `no_gpu_configured` for start/estimate/gpus; routes: 401/403/400/409 matrix for the three endpoints (member gets 403 on `/api/gpus`), body with extra fields rejected, `gpu` not a string rejected, OpenAPI matches the registered routes; `view()` exposes `gpu_name`; a failed start with an empty key file logs `ts_key_missing` and the response `reason`; logs contain no secrets; name normalisation (`RTX_3090` vs `RTX 3090` vs lowercase) behaves exactly like the offer query's.
- [ ] **Step 2:** run `npx vitest run apps` -> FAIL. **Step 3: Implement.** **Step 4:** `npx vitest run apps` (twice), `npm run typecheck`, `python3 scripts/check_config_usage.py apps instance`, `cd instance/agent && arch -arm64 .venv/bin/python -m pytest -q -W error tests/test_config.py tests/test_contracts.py` -> PASS. **Step 5: Commit** `feat: selectable GPU models for Start, fail closed without an allow-list`.

### Task 2: Page (dropdown, memory, GPU name, visible errors)

**Files:** Modify `apps/web/public/{ui.ts,model.ts,index.html,style.css}` and `apps/web/tests/page/*`.

**Behaviour:** the Start dialog (admin only) loads `GET /api/gpus` and shows a labelled `<select>` listing each model with its current price ("RTX A5000 — $0.24/h", unavailable ones disabled with "no offers now"); the default selection is the last choice remembered in `localStorage` (key from a constant; guarded with try/catch because storage can be unavailable) if it is still listed and available, else the cheapest available; the cost estimate in the dialog is fetched with `GET /api/estimate?gpu=<selected>` and refreshes when the selection changes; confirm sends `POST /api/start {confirm:true, gpu}` and then stores the choice. The status card shows the GPU name (from `state.gpu_name`) next to the price. A failed Start/estimate shows its error INSIDE the dialog (`role="alert"`, the dialog stays open, the confirm button is re-enabled) using the API's `message`, plus the generic banner as before. All text via `textContent`; the select options built with `textContent`/`value` (a hostile GPU name from a mocked API stays inert); CSP unchanged.
- [ ] **Step 1: Failing tests (jsdom):** select populated from `/api/gpus` with prices, unavailable disabled; default = remembered choice when valid, else cheapest available; remembered value invalid/unlisted ignored; localStorage throwing does not break the dialog; changing the selection refetches the estimate with the encoded name; confirm posts `{confirm:true, gpu}` and remembers it; failed start shows the message in the dialog and keeps it open; a hostile GPU name renders inert; GPU name shown in the status card; member never sees the dialog/controls.
- [ ] **Steps 2-5:** fail, implement, `npx vitest run apps` + typecheck + `npm run build:page -w @vast-comfy/web`, commit `feat: GPU dropdown with remembered choice and visible start errors`.

## Self-Review

- Coverage: allow-list default (T1), validation and fail-closed (T1), live prices (T1/T2), remember choice (T2), GPU name in UI (T1/T2), visible errors + diagnosable log (T1/T2). Deployment of the result is done by the controller afterwards.
