# Handoff (2026-10-18)

Written so a fresh session (for example a cloud session that only has this repo) can continue. It contains no secrets and no private addresses. Local-only things (`.env`, memory, `.superpowers/` ledgers, homelab access) are NOT available in a cloud session.

## What this project is

Private, cost-efficient image generation on rented Vast.ai GPUs: ComfyUI + Qwen-Image 2.1 GGUF (`qwen-image-2.1-UC-Q4_K_M`). A web service on the homelab (`apps/core` + `apps/web`, Node/TypeScript, Fastify) starts/extends/destroys one instance, shows status and generates images. The instance runtime lives in `instance/` (Python agent + bash bootstrap/failsafe). Login is in-app OIDC with Authentik (admins start/destroy/extend; members generate).

## Branches

- `master` (pushed): everything up to GPU choice, including OIDC login, compose file, GPU dropdown with allow-list, overall download progress, cache busting. This is what is deployed on the homelab and tested by the owner.
- `feat/ts-oauth` (pushed, NOT deployed, NOT merged): mint single-use Tailscale auth keys per Start through an OAuth client. Needs the owner to create the OAuth client first.
- `feat/boot-console` (pushed, NOT merged, on top of ts-oauth): boot console. Only Task 1 (core/API) is done and it needs a fix round (below).

Start new work from `master` unless it depends on the above.

## Next task for a cloud session: image EDIT with multiple reference images

Goal: besides text-to-image, let a user attach several reference images and a prompt to edit/transform them (anime to realistic, clean up an image, combine references).

Read first: `docs/spikes/S6-image-edit-references.md`. It proves this works on stock ComfyUI 0.41.0 and contains the working API-format workflow (about 47-54 s on an RTX 3090).

Working graph (API format), summarised:
- `UnetLoaderGGUF` (`qwen-image-2.1-UC-Q4_K_M.gguf`) -> `QwenImage21Cache` (device auto, dtype default)
- `CLIPLoader` (`qwen3vl_8b_int8_convrot`, type `qwen_image`), `VAELoader`
- one `LoadImage` per reference
- `TextEncodeQwenImage21` with inputs `clip`, `prompt`, `negative_prompt` (""), `resolution` 1024, `vae`, and `images.image_1`, `images.image_2`, ... (each `[LoadImageNodeId, 0]`); outputs positive, negative, latent
- `KSampler` (model from the cache node, positive/negative/latent from the encode node, cfg 1, euler/simple), `VAEDecode`, `SaveImage`

What to build (follow the project's superpowers flow: plan in `docs/superpowers/plans/`, TDD, review):
1. Profile: an `edit` section in `instance/profiles/image.yaml` next to `generate`, plus the node classes in `provides_node_classes`; limits (max references, max bytes per image, allowed types) come from `contracts/config-schema.yaml` and `.env.example`, never hardcoded.
2. Workflow: `instance/workflows/qwen-image-edit.json`, parameterised for N references (build the `LoadImage` and `images.image_k` entries in code, `apps/core/src/generate.ts` is the place to look at how the t2i workflow is parameterised).
3. Upload path: the web service receives the reference files (multipart, strict size/type/count validation, magic-byte check), uploads each to ComfyUI `/upload/image` through the existing tailnet client (`apps/core/src/comfy.ts`), then submits the edit workflow. References are not stored after the job.
4. API + OpenAPI (`contracts/web.openapi.json`) + page UI (`apps/web/public/`): a mode switch (Generate / Edit), reference picker with thumbnails, remove button, mobile friendly, textContent only.
5. Keep the existing rules: default-deny `/api/*`, Origin/Sec-Fetch-Site CSRF checks, no-store, strict CSP, no secrets in logs, config only through the schema and `apps/core/src/config.ts`.

Verification limits: a cloud session cannot reach the homelab or start a real instance. Use the fake ComfyUI/Vast servers in the test suites. A real end-to-end check (start an instance, edit with 2 references) must be done later by the owner from the laptop.

## Other pending work, in order

1. Boot console, Task 1 fix round on `feat/boot-console`:
   - Important: `view()`/`console()` races with Start. Capture the buffer generation synchronously before the first await and skip syncing/feeding if it changed (otherwise a view in flight can mark the new boot's console as ended, or wipe it). Add tests for a view in flight across `start()` and a refresh across destroy+Start.
   - Important: the masking regexes in `apps/core/src/console.ts` (URL credentials and name=value rules) have quadratic cost on long lines like `a-a-a-...` (about 13 ms per 3200-char line, x300 lines per poll). Anchor with a lookbehind, bound the name prefix, and only prepare lines past the overlap or cache prepared text.
   - Minors: base64 containing `/` without padding, `?key=` values, multi-word passwords, case-insensitive `tskey-`; the pre-cut keeps the tail not the head; the byte cap should keep the last N bytes; a secret split over 3+ lines; document the overlap ambiguity; phases are display-only (readiness comes from `view().state`); validate a restored `ended_reason`; cap the persisted file read size.
   - Unverified live: the Vast log-request REST flow (first GET happens immediately, `redirect: "error"` may break if the file host redirects).
   - Then Task 2 (page: stepper and console panel, admin only) and Task 3 (instance side: mirror bootstrap output and `[boot] step <n>/8: <id>` markers to `/proc/1/fd/1`). Plan: `docs/superpowers/plans/2026-10-18-boot-console.md` (on that branch).
2. Save + Gallery: optional Save per result (and auto-save option), cross-device gallery tab backed by an S3-compatible bucket (MinIO on the homelab, bucket `vast-gallery`, config keys `GALLERY_S3_*`). Bucket stays private, images are served through the web service; owners see their own images, admins see all; quotas from config. Local per-device history stays as is. Reuse later for a Discord `save` mode.
3. Show remaining Vast credit (admin only) in the status card.
4. Tailscale OAuth: owner creates an OAuth client (scope Auth Keys: Write only, tag `tag:gpu`) and sets `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET` in `.env`; then deploy `feat/ts-oauth` and verify the minimum `expirySeconds` against the real API. Deferred minors are listed in the review notes: `TS_KEY_TTL_S` minimum about 900, mint after the offer is chosen, trim whitespace, cap the token cache at 1 hour.
5. Merge `feat/ts-oauth` and `feat/boot-console` into `master` when done and reviewed (the owner approves merges and pushes explicitly), then deploy.
6. Later: Discord bot, watchdog, video/3D, and `docs/superpowers/plans/2026-10-17-web-interface-followups.md`.

## Facts that matter

- GPU allow-list: only Ampere or newer (RTX A5000, 3090, 4090, 5090). Pascal (P40) does not work (no CUDA kernel image). 5090 (Blackwell) is unverified.
- Vast: per-second billing, `loading` is not billed, destroy needs `-y` and success is decided from the output text, `gpu_ram` is in MB (use 1000 MB per GB), never run `vastai --explain` (prints the API key).
- Instance reachability: Tailscale userspace networking, tag `tag:gpu`, only ports 18188 (ComfyUI) and 8189 (agent) allowed. Single-use auth keys are spent after one boot, which is why OAuth minting exists.
- Typical timings: boot about 6-7 min, generate 1024x1024: preview 10 steps about 16-23 s, standard 25 steps about 35-45 s, high 40 steps about 55 s.
- Deploy is done from the owner's laptop against the homelab Docker host with the compose project name `vast-comfy` (`docker-compose -p vast-comfy -f docker-compose.yml up -d --build`). See `deploy/web/README.md`.

## Commands

```bash
npx vitest run apps --exclude '.worktrees/**'
npm run typecheck
python3 scripts/check_config_usage.py apps instance
cd instance/agent && arch -arm64 .venv/bin/python -m pytest -q -W error   # about 4.5 min
```

## House rules

Code comments and commit messages in English; no secrets in the repo, logs or chat; configuration only through `contracts/config-schema.yaml` and `.env.example`; never use `--no-verify`; do not push or merge without the owner's approval.
