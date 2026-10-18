# Handoff (2026-10-18)

Written so a fresh session (for example a cloud session that only has this repo) can continue. It contains no secrets and no private addresses. Local-only things (`.env`, memory, `.superpowers/` ledgers, homelab access) are NOT available in a cloud session.

## What this project is

Private, cost-efficient image generation on rented Vast.ai GPUs: ComfyUI + Qwen-Image 2.1 GGUF (`qwen-image-2.1-UC-Q4_K_M`). A web service on the homelab (`apps/core` + `apps/web`, Node/TypeScript, Fastify) starts/extends/destroys one instance, shows status and generates images. The instance runtime lives in `instance/` (Python agent + bash bootstrap/failsafe). Login is in-app OIDC with Authentik (admins start/destroy/extend; members generate).

## State on 2026-10-18 (evening)

Everything below is on `master` (pushed and DEPLOYED on the homelab, commit 318464a):
OIDC login, GPU choice, overall download progress, Vast credit for admins (`GET /api/credit`), image EDIT with multiple
references (`POST /api/edit`, hardened against multi-frame images), the boot console (API, stepper, collapsible log panel;
Tasks 1 and 2 only) and the Tailscale OAuth key minting code (inactive until `TS_OAUTH_CLIENT_ID/SECRET` are set; the
manual key file is used meanwhile). Branches other than `master` are merged and can be deleted.

Not verified live: a real edit through the web stack, the Cloudflare body size for edit requests, the Vast log-request
flow behind the boot console, Tailscale OAuth against the real API, RTX 5090 (Blackwell).
Edit notes: a 4 x 8 MiB request needs about 12 Mbit/s of upload within `WEB_REQUEST_TIMEOUT_S` (30 s); references stay in
ComfyUI `input/` until the instance is destroyed; animated/multi-frame references are refused (`reference_animated`);
`EDIT_REFERENCE_MAX_SIDE` bounds width/height. Edit design: `docs/superpowers/plans/2026-10-18-image-edit.md`.

## Next work, in order

1. **Usage history** (in progress locally on branch `feat/usage-history`; check origin for that branch first, if it is
   there continue from it, otherwise implement from the brief): a persistent log of when an instance started and stopped
   and why (Destroy button with who, idle timeout, failsafe deadline, hard cap, boot failed, gone), shown in an
   admin-only collapsible "History" card, plus `[watchdog] destroying instance: reason=...` from the agent.
   Brief: `docs/superpowers/plans/2026-10-18-usage-history-brief.md`.
2. **Styles with sub-menus, Anything to Real LoRA, chaining ("use this result as a reference") and later Upscale and
   Camera angle.** Agreed design: `docs/superpowers/plans/2026-10-18-styles-and-chaining-design.md` (read it fully).
   The live test of the LoRA on the GGUF base needs a real instance, which only the owner's laptop session can start.
   STATUS: the framework, the page (style sub-menu, parameter panels, "Use as reference" on results) and the first style
   are built on branch `feat/styles-and-chaining` (plan: `docs/superpowers/plans/2026-10-18-styles-and-chaining.md`).
   The style ships `enabled: false` until the owner pins the LoRA (`scripts/pin_model.py`, steps in
   `deploy/web/README.md`, "Styles") and live-tests it. Upscale mode is also built (same branch, disabled until a licensed model is pinned; README "Upscale"). Not built:
   chaining from the gallery (the gallery is in PR #4, not on master; add a "Use as reference" button there after it
   merges, reusing `chainResult` in `apps/web/public/ui.ts`) and Camera angle (AnyAngle): its mechanism is not
   documented in this repo (a LoRA plus extra 3D models, per the design), three licenses are unchecked and the
   Anything to Real live test comes first, so guessing a workflow would be fiction.
3. Boot console Task 3 (instance side): mirror bootstrap output and `[boot] step <n>/8: <id>` markers to
   `/proc/1/fd/1` so `vastai logs` shows them (plan: `docs/superpowers/plans/2026-10-18-boot-console.md`; needs a push and
   a real boot to verify). Deferred minors of the console are listed in that plan's review notes (not blocking).
4. Save + Gallery: optional Save per result (and auto-save option), cross-device gallery tab backed by an S3-compatible
   bucket (MinIO on the homelab, bucket `vast-gallery`, config keys `GALLERY_S3_*`). The bucket stays private, images are
   served through the web service; owners see their own images, admins see all; quotas from config. Local per-device
   history stays. Reuse later for a Discord `save` mode.
5. Tailscale OAuth: the owner creates an OAuth client (scope Auth Keys: Write only, tag `tag:gpu`) and sets
   `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET` in `.env`; then deploy and verify the minimum `expirySeconds` against
   the real API. The current reusable Tailscale key expires around 2026-10-19. Deferred minors: `TS_KEY_TTL_S` minimum
   about 900, mint after the offer is chosen, trim whitespace, cap the token cache at 1 hour.
6. Later: Discord bot, video/3D, and `docs/superpowers/plans/2026-10-17-web-interface-followups.md`.

- Profile `edit:` section + `instance/workflows/qwen-image-edit.json`; `provides_node_classes` also lists
  `TextEncodeQwenImage21` and `QwenImage21Cache` (boot fails closed without them).
- `apps/core`: `references.ts` (magic-byte sniffing, header dimensions, limits from `EDIT_*` config),
  `ComfyClient.uploadImage`, `buildEditPrompt`, `edit()`.
- `apps/web`: `POST /api/edit` (member, own body limit, shares the generate rate limit), `edit` block in
  `/api/state`, edit jobs polled through `GET /api/generate/:id` with the edit template, OpenAPI updated.
- Page: Generate/Edit switch, reference picker with previews, base64 via FileReader.
- Not verified live: a real edit through the web stack (owner to run: start an instance, edit with 2
  references), the Cloudflare request body size, quality at 10 steps, `resolution` values other than 1024.
- Edit limits: a 4 x 8 MiB request needs about 12 Mbit/s of upload to arrive within
  `WEB_REQUEST_TIMEOUT_S` (30 s default); Cloudflare body size limits are unverified; references stay in
  ComfyUI `input/` until the instance is destroyed. Animated/multi-frame references (APNG, animated WebP,
  MPO, JPEG with two frame headers) are refused (`reference_animated`), and `EDIT_REFERENCE_MAX_SIDE`
  (default 8192) bounds width and height (`reference_side_too_long`).
- Ideas left out: client-side downscaling of big photos, prompt enhancer, saving results.

## Other pending work, in order

1. Boot console, Task 1 fix round on `feat/boot-console`:
   - Important: `view()`/`console()` races with Start. Capture the buffer generation synchronously before the first await and skip syncing/feeding if it changed (otherwise a view in flight can mark the new boot's console as ended, or wipe it). Add tests for a view in flight across `start()` and a refresh across destroy+Start.
   - Important: the masking regexes in `apps/core/src/console.ts` (URL credentials and name=value rules) have quadratic cost on long lines like `a-a-a-...` (about 13 ms per 3200-char line, x300 lines per poll). Anchor with a lookbehind, bound the name prefix, and only prepare lines past the overlap or cache prepared text.
   - Minors: base64 containing `/` without padding, `?key=` values, multi-word passwords, case-insensitive `tskey-`; the pre-cut keeps the tail not the head; the byte cap should keep the last N bytes; a secret split over 3+ lines; document the overlap ambiguity; phases are display-only (readiness comes from `view().state`); validate a restored `ended_reason`; cap the persisted file read size.
   - Unverified live: the Vast log-request REST flow (first GET happens immediately, `redirect: "error"` may break if the file host redirects).
   - Then Task 2 (page: stepper and console panel, admin only) and Task 3 (instance side: mirror bootstrap output and `[boot] step <n>/8: <id>` markers to `/proc/1/fd/1`). Plan: `docs/superpowers/plans/2026-10-18-boot-console.md` (on that branch).
2. ~~Save + Gallery~~ Done on `feat/gallery-minio`: Save per result, auto-save (this device), a gallery card (own images; admins can list everyone's), delete, quotas, MinIO via `GALLERY_S3_*` (empty endpoint = off). Plan: `docs/superpowers/plans/2026-10-18-gallery-minio.md`, runbook: `deploy/web/README.md` "Gallery in MinIO". Not verified live: a real MinIO. Left for later: thumbnails, a Discord `save` mode.
3. ~~Show remaining Vast credit (admin only) in the status card.~~ Done: `GET /api/credit` (cached, admin only) and a "Vast credit" fact in the status card. Not verified live: the Vast `users/current` call.
4. Tailscale OAuth: owner creates an OAuth client (scope Auth Keys: Write only, tag `tag:gpu`) and sets `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET` in `.env`; then deploy `feat/ts-oauth` and verify the minimum `expirySeconds` against the real API. Deferred minors are listed in the review notes: `TS_KEY_TTL_S` minimum about 900, mint after the offer is chosen, trim whitespace, cap the token cache at 1 hour.
5. Merge `feat/ts-oauth` and `feat/boot-console` into `master` when done and reviewed (the owner approves merges and pushes explicitly), then deploy.
6. Later: Discord bot, watchdog, video/3D, and `docs/superpowers/plans/2026-10-17-web-interface-followups.md`.
What a cloud session cannot do: reach the homelab or start Vast instances, read the owner's `.env`, or deploy. Use the
fake servers in the test suites, and leave live checks and the deploy to the owner's laptop session.

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
