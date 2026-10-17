# Web Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone-friendly web page on the homelab that starts, watches, extends and destroys one Vast GPU instance and generates images on it.

**Architecture:** `apps/core` (TypeScript library: config, Vast / agent / ComfyUI clients, registry, lifecycle, generate) and `apps/web` (Fastify API + one static HTML page). The browser only talks to `apps/web`; `apps/web` reaches the instance over the tailnet and Vast over HTTPS. Login is Authentik only; roles come from Authentik groups.

**Tech Stack:** Node 20+, TypeScript (strict), Fastify, `jose` (JWT/JWKS), `yaml`, Vitest, plain HTML/TS for the page. The Python side changes only in the profile loader.

**Spec:** `docs/superpowers/specs/2026-10-17-web-interface-design.md` (this feature) and `docs/superpowers/specs/2026-10-16-instance-runtime-design.md` (instance contracts: sections 5.6, 6, 6.1, 7.1, 7.2, 8, 14, 15). Spike findings in `docs/spikes/S1..S5*.md` are authoritative for measured behaviour.

## Global Constraints

- **No hardcoded config.** Every URL, port, timeout, limit, filter value, group name and path comes from `contracts/config-schema.yaml` (component `apps`) through `apps/core/src/config.ts`, the only module that reads `process.env`. The lint `scripts/check_config_usage.py apps` must pass (it scans `.ts`); a line with `config-lint: ok` is exempt only for protocol constants.
- **No secrets in the repo or the browser.** `VAST_API_KEY`, the Tailscale key, agent tokens and the Authentik JWKS never reach the browser, logs or error bodies. `.env*` stays git-ignored. The pre-commit hook (`.githooks/pre-commit`) must keep passing; never `--no-verify`.
- **Browser never reaches the instance.** Only `apps/web` endpoints; the workflow comes from the profile template, never from the request.
- **One active instance.** Registry holds at most one record whose status is not `gone`.
- **Default deny.** Start, Extend, Destroy: admin group only. Generate and status: member or admin. Anything else: 403; no identity: 401.
- **Instance contracts (verbatim):** agent on `AGENT_PORT` (8189) with `Authorization: Bearer <agent_token>`; ComfyUI on `COMFY_PORT` (18188); `GET /status` schema in `contracts/status.schema.json` (`schema_version: 1`); instance env keys per spec 7.2 (`AGENT_TOKEN`, `TS_AUTHKEY`, `TS_HOSTNAME`, `REPO_URL`, `REPO_COMMIT`, `PROFILE`, `IDLE_MINUTES`, `FAILSAFE_HOURS`, `HARD_CAP_HOURS`); the exact `--onstart-cmd` text in spec 7.2; image `vastai/comfy:v0.41.0-cuda-12.9-py312`, `--ssh --direct`, no `-p`, `PORTAL_CONFIG="localhost:8188:18188:/:ComfyUI"`, `COMFYUI_ARGS="--disable-auto-launch --port 18188"`, `WORKSPACE=/workspace`, `DATA_DIRECTORY=/workspace/`.
- **Destroy semantics (S4):** success is decided by the CLI/API output, never by an exit code; a 404 "Instance ... not found" means already gone. The REST client must classify the same way.
- **Generated artifacts stay in sync:** any schema change regenerates `instance/allowed-keys.txt` (`cd instance/agent && .venv/bin/python -m vastcomfy_agent.config gen-keys --out ../allowed-keys.txt`) and the contracts in the same commit.
- **Commits:** English messages, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Code comments in English.
- **Tests:** Vitest with fake HTTP servers (no network); Python tests `cd instance/agent && .venv/bin/python -m pytest -q -W error`.

## Review Focus

1. **Spoofed identity:** a request with forged `X-authentik-*` headers but no valid JWT must be 401 (Task 8).
2. **Crash between Vast create and registry write:** the `creating` record is written first, and reconcile finds an unknown running instance and shows it with a Destroy action, never adopting it silently (Tasks 3, 7).
3. **Double Start / race:** two simultaneous Start calls create exactly one instance (Task 7).
4. **Destroy that "succeeds" with exit-0-style failure text** (`Failed with error 401`): treated as failure and retried (Task 4).
5. **Generate with oversized prompt, unknown preset, size not in the profile, or while no instance is ready:** clean 4xx, nothing sent to ComfyUI (Tasks 6, 9).

---

## File Structure

```
package.json, tsconfig.base.json, vitest.workspace.ts        # workspace root (apps/*)
apps/core/src/{config,registry,vast,agent,comfy,profile,lifecycle,generate}.ts + tests/
apps/web/src/{auth,server,routes}.ts, apps/web/public/{index.html,app.ts}
apps/web/Dockerfile, deploy/web/{README.md,compose.snippet.yml}
contracts/web.openapi.json, contracts/config-schema.yaml (apps keys)
instance/agent/vastcomfy_agent/profile.py (+ profiles/image.yaml generate section)
```

---

### Task 1: Workspace and `apps` config module

**Files:** Create root `package.json` (npm workspaces `apps/core`, `apps/web`), `tsconfig.base.json`, `apps/core/{package.json,tsconfig.json,src/config.ts}`, `apps/core/tests/config.test.ts`; Modify `contracts/config-schema.yaml`, `.gitignore` (`node_modules/`, `dist/`).

**Interfaces:**
- Produces: `loadConfig(env: Record<string,string|undefined>, schemaPath: string): AppsConfig` (typed object, camelCase of schema names); `ConfigError` listing every invalid key; secrets listed in `config.secretNames`. Semantics mirror `instance/agent/vastcomfy_agent/config.py` (types `str|int|bool|csv`, `min`, `max`, `required`, `default`, `secret`).
- New schema keys (component `apps`, with the defaults in the spec): `WEB_PORT`, `WEB_ADMIN_GROUP` (default `authentik Admins`), `WEB_MEMBER_GROUP` (default `member`), `AUTHENTIK_JWKS_URL`, `AUTHENTIK_ISSUER`, `AUTHENTIK_AUDIENCE`, `REGISTRY_PATH`, `REPO_URL`, `REPO_COMMIT`, `PROFILE`, `VAST_IMAGE`, `VAST_DISK_GB` (50), `VAST_MIN_VRAM_GB` (24), `VAST_MAX_DPH` (0.50), `VAST_MIN_DOWNLOAD_MBPS` (500), `VAST_MIN_RELIABILITY` (0.98), `VAST_ALLOWED_GPUS` (csv, empty = any), `TS_AUTHKEY_FILE` (manual key, Task 13), `START_IDLE_MINUTES`, `START_FAILSAFE_HOURS`, `START_HARD_CAP_HOURS`, `STATUS_POLL_S`, `RECONCILE_INTERVAL_S`, `GENERATE_MAX_PROMPT_CHARS`, `GENERATE_TIMEOUT_S`, `HTTP_TIMEOUT_S_APPS`, `START_RATE_LIMIT_PER_HOUR`. Reuse existing `VAST_API_KEY`, `VAST_API_URL`, `BOOT_TIMEOUT_MIN`, `UNREACHABLE_DESTROY_MIN`, `WATCHDOG_INTERVAL_S`; make `DISCORD_*`/`TS_API_CREDENTIAL` not required for the web (`required: false`, they belong to later sub-projects).

- [ ] **Step 1: Write failing tests** in `config.test.ts`: `loads defaults`, `reports every invalid key at once` (int below `min`, bad bool, missing required `VAST_API_KEY`), `parses csv` (`"a, b"` -> `["a","b"]`, empty -> `[]`), `never includes secret values in error messages`.
- [ ] **Step 2: Run** `npx vitest run apps/core/tests/config.test.ts` -> FAIL (module missing).
- [ ] **Step 3: Implement** `loadConfig`, `ConfigError`; add the schema keys; regenerate `allowed-keys.txt` and run the Python config tests (`tests/test_config.py`, `tests/test_contracts.py`) to prove the Python side still passes.
- [ ] **Step 4: Run** the vitest file, `python3 scripts/check_config_usage.py apps`, and the Python tests -> PASS.
- [ ] **Step 5: Commit** `feat: apps workspace and typed config from the schema`.

### Task 2: Profile `generate` section (Python + TypeScript)

**Files:** Modify `instance/agent/vastcomfy_agent/profile.py`, `instance/profiles/image.yaml`, `instance/agent/tests/test_profile.py`; Create `apps/core/src/profile.ts`, `apps/core/tests/profile.test.ts`.

**Interfaces:**
- `image.yaml` gains `generate: {workflow: qwen-image-t2i.json, params: {prompt: {node: "5", input: text}, steps: {node: "8", input: steps}, width: {node: "7", input: width}, height: {node: "7", input: height}, seed: {node: "8", input: seed}}, quality_presets: {preview: {steps: 10}, standard: {steps: 25}, high: {steps: 40}}, sizes: [{name: "1:1", width: 1024, height: 1024}, {name: "3:4", width: 896, height: 1152}, {name: "4:3", width: 1152, height: 896}, {name: "16:9", width: 1280, height: 720}, {name: "9:16", width: 720, height: 1280}]}` (values may be tuned after a quality check; sizes multiples of 32).
- Python: `Profile.generate: GenerateSpec | None` (frozen dataclasses), `ProfileError` on unknown param key, missing node/input, preset without `steps`, empty presets, size not multiple of 32, workflow name failing the `NAME_RE` rule of `workflows.py`.
- TS: `loadProfile(path): Profile` (same validation), `buildPrompt(profile, workflowJson, {prompt, preset, size, seed}): ComfyPrompt` returning a deep copy with only the mapped inputs changed; throws `GenerateInputError` (with `code`) for unknown preset/size.

- [ ] **Step 1: Failing tests.** Python: `test_generate_section_loads`, `test_generate_rejects_bad_sizes_and_presets` (parametrized), `test_shipped_profile_generate_matches_workflow_nodes` (every mapped node id/input exists in `instance/workflows/qwen-image-t2i.json`). TS: `buildPrompt changes only mapped inputs`, `does not mutate the template`, `rejects unknown preset`, `rejects size not in profile`.
- [ ] **Step 2: Run** both suites -> FAIL.
- [ ] **Step 3: Implement** the Python dataclasses + validation and the TS twin; update `image.yaml`.
- [ ] **Step 4: Run** `cd instance/agent && .venv/bin/python -m pytest -q -W error tests/test_profile.py` and the vitest file -> PASS.
- [ ] **Step 5: Commit** `feat: generate section in profiles (quality presets, sizes, node mapping)`.

### Task 3: Registry store

**Files:** Create `apps/core/src/registry.ts`, `apps/core/tests/registry.test.ts`; Modify `contracts/instance-registry.schema.json` only if a field is added (none expected).

**Interfaces:** `class Registry(path)`: `active(): InstanceRecord | null` (the single non-`gone` record), `begin(record: NewRecord): InstanceRecord` (writes `status: "creating"` and throws `AlreadyActiveError` if one is active), `update(id|"pending", patch): InstanceRecord`, `markGone(id)`, `all()`. Record fields exactly as `contracts/instance-registry.schema.json`; validated on read and write. Writes are atomic (temp file + rename) and serialized (in-process mutex).

- [ ] **Step 1: Failing tests:** `begin writes a creating record before anything else`, `second begin while one is active throws AlreadyActiveError`, `concurrent begin calls yield exactly one record` (Promise.all of 5), `corrupt file is reported, not silently reset`, `update validates against the contract schema`, `file is written atomically` (no partial file visible).
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement.** **Step 4: Run** -> PASS. **Step 5: Commit** `feat: instance registry with write-ahead creating record`.

### Task 4: Vast client

**Files:** Create `apps/core/src/vast.ts`, `apps/core/tests/vast.test.ts` (with a fake Vast HTTP server).

**Interfaces:** `class VastClient(cfg)`: `searchOffers(filters: OfferFilters): Promise<Offer[]>` sorted by `dph_total` ascending; `createInstance(offerId: number, req: CreateRequest): Promise<{id: number}>`; `listInstances(): Promise<VastInstance[]>` (each with `id`, `label`, `actual_status`, `start_date`, `dph_total`); `destroyInstance(id: number): Promise<"destroyed" | "gone">`, throwing `DestroyError` otherwise. REST endpoints are taken from `vastai ... --explain` for `search offers`, `create instance`, `show instances`, `destroy instance` (S4: destroy needs the confirmation equivalent; classification below). `CreateRequest` carries image, disk, env map, the exact onstart text from spec 7.2, `label: "vastcomfy"`, ssh+direct. The API key goes only in the `Authorization` header and is redacted from every thrown error.

- [ ] **Step 1: Failing tests:** `search sends the configured filters and sorts by price`, `create sends env + onstart + label and never a port mapping`, `destroy treats a 404 "not found" body as gone`, `destroy treats an error body with exit-like success status as failure` (HTTP 200 with `{"success": false}` / error text), `errors never contain the api key`, `timeouts surface as VastError`.
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement.** **Step 4: Run** -> PASS. **Step 5: Commit** `feat: Vast REST client (search, create, list, destroy)`.

### Task 5: Agent and ComfyUI clients

**Files:** Create `apps/core/src/agent.ts`, `apps/core/src/comfy.ts`, tests with fake servers.

**Interfaces:** `class AgentClient(host, cfg, token)`: `status(): Promise<AgentStatus>` (validated against `contracts/status.schema.json`, `schema_version` must be 1), `extend(kind: "idle"|"failsafe", minutes: number)`, `destroy(reason: string)`. `class ComfyClient(host, cfg)`: `submit(prompt): Promise<{promptId: string}>`, `history(promptId): Promise<HistoryEntry | null>`, `view(filename, subfolder, type): Promise<{bytes: Buffer, contentType: string}>`, `queue()`. Hosts are tailnet MagicDNS names built from `tailnet_hostname`; all calls use `HTTP_TIMEOUT_S_APPS` and map network failures to `Unreachable` (distinct from HTTP errors).

- [ ] **Step 1: Failing tests:** `status rejects schema_version 2`, `sends the bearer token`, `unreachable host -> Unreachable`, `extend over the hard cap surfaces the agent's message`, `view streams bytes with content type`, `history null until finished`.
- [ ] **Step 2-4:** run FAIL, implement, run PASS. **Step 5: Commit** `feat: agent and ComfyUI clients`.

### Task 6: Generate service

**Files:** Create `apps/core/src/generate.ts`, `apps/core/tests/generate.test.ts`.

**Interfaces:** `generate(deps: {comfy, profile, template, cfg}, input: {prompt: string, preset: string, size: string, seed?: number}): Promise<{promptId: string}>` validates (non-empty, <= `GENERATE_MAX_PROMPT_CHARS`, known preset and size, integer seed in 0..2^53-1; random seed when absent) then submits `buildPrompt(...)`. `awaitResult(deps, promptId): Promise<{images: {filename, subfolder, type}[]}>` polls `history` every `STATUS_POLL_S` until done or `GENERATE_TIMEOUT_S`, throwing `GenerateFailed(message)` when ComfyUI reports an error.

- [ ] **Step 1: Failing tests (Review Focus 5):** `oversized prompt -> GenerateInputError, comfy.submit not called`, `unknown preset`, `size outside profile`, `random seed when none given`, `timeout -> GenerateTimeout`, `comfy error -> GenerateFailed with the node message`.
- [ ] **Step 2-4:** FAIL, implement, PASS. **Step 5: Commit** `feat: generate service with validated inputs`.

### Task 7: Lifecycle (start, status, extend, destroy, reconcile)

**Files:** Create `apps/core/src/lifecycle.ts`, `apps/core/tests/lifecycle.test.ts`.

**Interfaces:** `class Lifecycle(deps: {cfg, vast, registry, agentFor(record), clock, tsAuthKey(): Promise<string>, newToken(): string})`:
- `start(): Promise<InstanceRecord>`: `registry.begin` (status `creating`) **before** any Vast call; searches offers, creates the instance with env keys from spec 7.2 (`TS_AUTHKEY` from `tsAuthKey()`, `TS_HOSTNAME = vast-<random>`, `AGENT_TOKEN = newToken()`, durations from `START_*`), updates the record to `booting` with the Vast id; on any failure after `begin` marks the record `gone` (and destroys a created instance); no offers -> `NoOffersError`. Returns the record; also returns the estimated cost data (`dph`, horizon = `START_FAILSAFE_HOURS`).
- `view(): Promise<StatusView>`: merges registry + Vast `actual_status` + agent `/status` (agent `Unreachable` -> `agent: null`), including `cost_so_far` (dph x uptime), `state`, progress and the remaining times.
- `extend(kind, minutes)`, `destroy()` (agent `/destroy` first if reachable, always followed by Vast destroy; retries per `DestroyError`; record `gone` only after Vast says destroyed/gone).
- `reconcile(): Promise<ReconcileReport>` (run every `RECONCILE_INTERVAL_S` by the web process): lists Vast instances with label `vastcomfy`; any instance not in the registry -> report `unknown` (never adopted); a registry record whose instance vanished -> `gone`; an instance older than `BOOT_TIMEOUT_MIN` without `ready`, or unreachable longer than `UNREACHABLE_DESTROY_MIN`, or older than `START_HARD_CAP_HOURS` by Vast `start_date` -> destroy.

- [ ] **Step 1: Failing tests (Review Focus 2, 3):** `begin happens before the first vast call` (fake records call order), `crash after vast create leaves a creating record that reconcile reports`, `two concurrent starts create one instance`, `no offers marks the record gone`, `unknown instance is reported and not adopted`, `boot timeout destroys`, `unreachable beyond the limit destroys`, `hard cap by start_date destroys`, `destroy retries until vast confirms and only then marks gone`, `view degrades to agent null when unreachable`.
- [ ] **Step 2-4:** FAIL, implement, PASS. **Step 5: Commit** `feat: lifecycle orchestration with write-ahead record and reconcile`.

### Task 8: Authentik identity and roles

**Files:** Create `apps/web/{package.json,tsconfig.json}`, `apps/web/src/auth.ts`, `apps/web/tests/auth.test.ts`.

**Interfaces:** `createAuth(cfg, jwksResolver): { identify(headers): Promise<Identity | null>; role(identity): "admin" | "member" | "none" }`. The Authentik proxy outpost forwards a signed `X-authentik-jwt`; it is verified (signature via `AUTHENTIK_JWKS_URL`, `iss` = `AUTHENTIK_ISSUER`, `aud` = `AUTHENTIK_AUDIENCE`, not expired) with `jose`. Plain `X-authentik-*` headers are never trusted. Groups come from the verified claims; `WEB_ADMIN_GROUP` -> admin, `WEB_MEMBER_GROUP` -> member, anything else -> none.

- [ ] **Step 1: Failing tests (Review Focus 1):** `forged x-authentik headers without jwt -> null`, `jwt signed by another key -> null`, `expired / wrong issuer / wrong audience -> null`, `admin group -> admin`, `member group -> member`, `other group -> none`, `admin wins when both groups present`.
- [ ] **Step 2-4:** FAIL, implement, PASS. **Step 5: Commit** `feat: Authentik JWT identity and group roles`.

### Task 9: Web API

**Files:** Create `apps/web/src/{server,routes}.ts`, `apps/web/tests/routes.test.ts`, `contracts/web.openapi.json` (generated or hand-kept in sync with a test).

**Interfaces:** Fastify app `buildServer(deps)`; routes (JSON; errors as `{error: {code, message}}`): `GET /api/state` (member+: view, presets, sizes, role), `POST /api/start` (admin; returns cost estimate; rate-limited by `START_RATE_LIMIT_PER_HOUR`), `POST /api/destroy`, `POST /api/extend {kind, minutes}` (admin), `POST /api/generate {prompt, preset, size, seed?}` (member+; 409 when no instance is `ready`; returns `{id}`), `GET /api/generate/:id` (member+: pending | done with image URLs | failed), `GET /api/image/:id/:index` (member+, streams the image from ComfyUI; nothing stored). Security headers and a request body limit; no route returns tokens or hostnames of the agent.

- [ ] **Step 1: Failing tests (Review Focus 5):** `401 without identity`, `403 member on start/destroy/extend`, `generate rejects bad input with 400 and does not call comfy`, `generate 409 when not ready`, `state never contains agent_token or auth key`, `image route streams bytes and writes nothing to disk`, `start rate limit returns 429`, `openapi file matches the registered routes`.
- [ ] **Step 2-4:** FAIL, implement, PASS. **Step 5: Commit** `feat: web API with role checks and OpenAPI contract`.

### Task 10: The page

**Files:** Create `apps/web/public/index.html`, `apps/web/public/app.ts` (bundled to `public/app.js` by the build), `apps/web/tests/page.test.ts` (jsdom).

**Behavior:** one responsive column (works at 375 px): status card (state, download progress, uptime, remaining idle/failsafe/hard cap, queue, VRAM, cost so far), admin-only Start (shows the cost estimate and asks to confirm), Extend and Destroy (confirm), generate form (prompt, preset buttons labelled with their step counts, size select, seed), result grid with download links, history kept only in memory. Polls `/api/state` every `STATUS_POLL_S`-derived interval from the API response. Shows `failed`/`destroy_failed` and an unreachable-agent warning prominently. Add-to-Home-Screen metadata (manifest, theme color). No third-party scripts; strict CSP.

- [ ] **Step 1: Failing tests:** `member does not see start/destroy/extend buttons`, `generate button disabled until ready`, `preset buttons come from the api, not constants in the page`, `destroy asks for confirmation`, `shows destroy_failed prominently`.
- [ ] **Step 2-4:** FAIL, implement, PASS. **Step 5: Commit** `feat: phone-friendly control and generate page`.

### Task 11: Packaging and deployment runbook

**Files:** Create `apps/web/Dockerfile`, `deploy/web/compose.snippet.yml`, `deploy/web/README.md`.

**Content:** Dockerfile (multi-stage, non-root, only built output); compose snippet (network shared with Authentik's proxy outpost, `.env` via `env_file`, registry volume, no published host port); README with the Cloudflare route for `gen.3dprintingbandung.my.id` -> Authentik proxy provider -> `apps/web`, the Authentik provider/application settings (JWT forwarding, groups `authentik Admins` and `member`), required Tailscale ACL (homelab node `docker-apps` may reach `tag:gpu:18188,8189` - already true via `autogroup:member`), and the `.env` keys needed (names only).

- [ ] **Step 1: Failing check:** a test `deploy files reference only schema keys` (parses `compose.snippet.yml`/README env names and asserts each exists in `config-schema.yaml`).
- [ ] **Step 2-4:** FAIL, write files, PASS; build the image locally (`docker build apps/web`) and run `docker run --rm <image> node -e "require('./dist/server.js')"` import smoke. **Step 5: Commit** `feat: web Dockerfile and deployment runbook`.

### Task 12: Real end-to-end boot (manual checklist, not subagent work)

Run by the controller with the owner present (needs a fresh single-use `tag:gpu` auth key at `TS_AUTHKEY_FILE`, `VAST_API_KEY` in the homelab `.env`, and the commit pushed). Pre-conditions: Tasks 1-11 merged and pushed; credit balance known; spend cap $0.40.

- [ ] Start from the page (or `POST /api/start`) with `START_FAILSAFE_HOURS=1`, `START_IDLE_MINUTES=5`; record the time at each state (booting, downloading, ready) and compare with `BOOT_TIMEOUT_MIN`.
- [ ] Verify from the tailnet: agent `/status` (state, progress), ComfyUI answers, `failsafe_alive: true`, and that port 22 and any other port are refused.
- [ ] Generate with each preset (10 / 25 / 40) at 1:1; record seconds and judge the 10-step quality; adjust `quality_presets` in the profile if needed.
- [ ] Let idle auto-destroy fire once (5 minutes) and confirm `vastai show instances` is empty and the registry record is `gone`.
- [ ] Force one failure path (a wrong `TS_AUTHKEY`): the instance must reach `failed` and destroy itself.
- [ ] Write `docs/spikes/T13-boot-end-to-end.md` with timings, cost, and every deviation; commit.

## Self-Review

- **Spec coverage:** status card, Start/Generate/Extend/Destroy, presets in the profile, single instance, Authentik + roles, proxy-only access, registry/reconcile, web-side boot/unreachable/hard-cap enforcement, cost estimate, deployment on Cloudflare/Authentik, Task 13 run: Tasks 1-12. Non-goals (bot, watchdog, storage, video) have no tasks.
- **Type consistency:** `InstanceRecord` (Task 3) is what `Lifecycle` (Task 7) and the routes (Task 9) pass around; `AgentStatus` (Task 5) feeds `StatusView` (Task 7); `buildPrompt`/`Profile` (Task 2) feed `generate` (Task 6). `GenerateInputError` is defined in Task 2 and reused in Task 6.
- **Open choices left to the builder:** exact Vast REST payload shapes (derive from `vastai --explain`), Fastify plugins, page styling, bundler for `app.ts`.
