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

1. ~~Usage history~~ Done and on `master`: persistent log of instance sessions with start, stop and the stop reason
   (Destroy button with who, idle timeout, failsafe deadline, hard cap, boot failed, agent unreachable, gone), an admin-only
   collapsible "History" card, `GET /api/history`, and `[watchdog] destroying instance: reason=...` from the agent (it
   reaches the supervisor log and `failsafe.log`, not yet the Vast container log: see item 3). Brief and runbook:
   `docs/superpowers/plans/2026-10-18-usage-history-brief.md`, `deploy/web/README.md` "Usage history". Not verified live.
2. **Styles with sub-menus, Anything to Real LoRA, chaining ("use this result as a reference") and later Upscale and
   Camera angle.** Agreed design: `docs/superpowers/plans/2026-10-18-styles-and-chaining-design.md` (read it fully).
   The live test of the LoRA on the GGUF base needs a real instance, which only the owner's laptop session can start.
   STATUS: the framework, the page (style sub-menu, parameter panels, "Use as reference" on results) and the first style
   are built on branch `feat/styles-and-chaining` (plan: `docs/superpowers/plans/2026-10-18-styles-and-chaining.md`).
   The style ships `enabled: false` until the owner pins the LoRA (`scripts/pin_model.py`, steps in
   `deploy/web/README.md`, "Styles") and live-tests it. Upscale mode is also built (same branch, disabled until a
   licensed model is pinned; README "Upscale"). Chaining from saved gallery images ("Use as reference" / "Upscale"
   on gallery items) is on branch `feat/gallery-chaining`; it needs PR #5 merged first. Not built: Camera angle
   (AnyAngle): its mechanism is not documented in this repo (a LoRA plus extra 3D models, per the design), three
   licenses are unchecked and the Anything to Real live test comes first, so guessing a workflow would be fiction.
3. Boot console Task 3 (instance side): mirror bootstrap output and `[boot] step <n>/8: <id>` markers to
   `/proc/1/fd/1` so `vastai logs` shows them (plan: `docs/superpowers/plans/2026-10-18-boot-console.md`; needs a push and
   a real boot to verify). Deferred minors of the console are listed in that plan's review notes (not blocking).
4. ~~Save + Gallery~~ Done (PR #4, merged on `feat/gallery`): Save per result, auto-save (this device), a gallery card
   (own images; admins can list everyone's), delete, quotas, MinIO via `GALLERY_S3_*` (empty endpoint = off). Plan:
   `docs/superpowers/plans/2026-10-18-gallery-minio.md`, runbook: `deploy/web/README.md` "Gallery in MinIO". Not
   verified live: a real MinIO. Left for later: thumbnails, a Discord `save` mode.
5. Tailscale OAuth: the owner creates an OAuth client (scope Auth Keys: Write only, tag `tag:gpu`) and sets
   `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET` in `.env`; then deploy and verify the minimum `expirySeconds` against
   the real API. The current reusable Tailscale key expires around 2026-10-19. Deferred minors: `TS_KEY_TTL_S` minimum
   about 900, mint after the offer is chosen, trim whitespace, cap the token cache at 1 hour.
6. Later: Discord bot, video/3D, and `docs/superpowers/plans/2026-10-17-web-interface-followups.md`.

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
