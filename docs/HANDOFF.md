# Handoff (2026-10-20)

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

## Slow boots (2026-10-20, branch `fix/slow-boot`, local commits, not pushed or deployed)

Two paid boots were lost on 2026-10-19 (Lithuania A5000: models at ~2.8 MB/s from Hugging Face despite
888 Mbps on Vast; California 3090: 20+ min in `install_tools`, released only at `BOOT_TIMEOUT_MIN`). Built:
an early network probe as the first boot step (`net_probe`; `NET_PROBE_BYTES` 48 MiB of the largest model, second
half timed, `NET_PROBE_MIN_MBPS` 6 MB/s, skipped on restarts and when the models are present, `[boot] FAILED: slow_network`, exit 14, stock-CLI destroy), boot step markers printed by
bootstrap (9 steps now), web-side releases `slow_boot` (`BOOT_AGENT_GRACE_MIN` 10) and `slow_download`
(`MODEL_ETA_MIN_OBSERVE_S` 120, `BOOT_MAX_DOWNLOAD_ETA_MIN` 20), a generic rule for a boot that vanished by
itself (`boot_failed`, blaming the machine only for its own failures: see the README table), the machine going on the bad-machine list, and parallel ranged model
downloads (`DOWNLOAD_CONNECTIONS` 4). Runbook: `deploy/web/README.md` "Slow boots". Unverified live: the
early destroy path, markers in `vastai logs`, ranges through the HF CDN/xet redirect, the thresholds.

## Next work, in order

1. ~~Usage history~~ Done and on `master`: persistent log of instance sessions with start, stop and the stop reason
   (Destroy button with who, idle timeout, failsafe deadline, hard cap, boot failed, agent unreachable, gone), an admin-only
   collapsible "History" card, `GET /api/history`, and `[watchdog] destroying instance: reason=...` from the agent (it
   reaches the supervisor log and `failsafe.log`, not yet the Vast container log: see item 3). Brief and runbook:
   `docs/superpowers/plans/2026-10-18-usage-history-brief.md`, `deploy/web/README.md` "Usage history". Not verified live.
2. ~~Styles, chaining and Upscale~~ Built and merged with the master line on branch `feat/styles` (PR #5 merged into
   master eb8759d plus review fixes; local commits, not pushed or deployed yet). Design:
   `docs/superpowers/plans/2026-10-18-styles-and-chaining-design.md`, plan `docs/superpowers/plans/2026-10-18-styles-and-chaining.md`,
   runbook `deploy/web/README.md` "Styles and Use as reference" and "Upscale". Done: the style framework (sub-menu per
   mode, parameter panels from the API), "Use as reference" and "Upscale" on results (redrawn when the server's offer
   changes), Upscale mode with both the model's intermediate image and the result bounded
   (`UPSCALE_MAX_INTERMEDIATE_PIXELS`, `UPSCALE_MAX_OUTPUT_PIXELS`), job labels with the style title, and saved upscale
   images (gallery kind `upscale`). ENABLED for one live test: Upscale with Real-ESRGAN x4plus (safetensors from
   Comfy-Org, BSD-3-Clause, 2x/4x) and two presets (they add about 0.39 GB to the boot download, about 15.0 GB in total):
   - `anything2real` "Anime / cartoon to real": the Anything to Real LoRA (pinned, Apache-2.0) plus its own instruction
     (`prompt_template`), exactly one image ("Image to convert"), the prompt optional notes, strength 0.0-1.0
     (default 0.7; 0 leaves the LoRA loader out: prompt only).
   - `faceswap` "Face swap": `kind: preset` (no LoRA), the owner's tested instruction, exactly two images ("Scene to
     keep", "Face to use") with a Swap order button and a consent hint.
   Also built on branch `feat/progress-previews` (local commits, not pushed or deployed): each result says how long it
   took (ComfyUI execution time, kept in saved gallery images), a live step counter and a rough step-by-step preview
   while a job runs (ComfyUI websocket per job, `COMFY_PREVIEW_METHOD` default latent2rgb written into ComfyUI's
   arguments at boot, `WEB_PROGRESS_*`/`WEB_PREVIEW_MAX_BYTES`), and, from `fix/stuck-start`, the stuck-start release
   (`VAST_START_STUCK_MIN`, bad-machine avoidance) and where the rented server is (location, speeds). Runbook:
   `deploy/web/README.md` "Live progress and preview", "Face swap", "Cartoon to real". Unverified live: the websocket over
   the tailnet, preview quality, and the image sourcing `/workspace/.env` (check `ps aux | grep main.py`).
   Still open: (a) the live test on a real instance: an anime/comic edit with the style at strength 0 and 0.6/0.7/0.8 (the
   LoRA placement relative to `QwenImage21Cache` on the GGUF base is UNVERIFIED; change `lora.model_from`/`model_to` if
   wrong), one upscale at 2x and 4x (the workflow has never run; VRAM use of a large upscale is unknown), and a Save of
   each result; (b) DONE: saved gallery images also have "Use as reference" and Upscale buttons; 
    (c) Camera angle (AnyAngle): its mechanism is not documented in this repo
   (a LoRA plus extra 3D models, per the design), three licenses are unchecked and the Anything to Real live test comes
   first, so guessing a workflow would be fiction.
   Also on branch `feat/recipes-merge` (local commits, not pushed or deployed): branch `feat/recipes-negative-prompt`
   merged and reworked. One preset mechanism (styles; recipes folded in as style `defaults`, samples ported as disabled
   preset styles), an "Advanced" section with negative prompt and guidance (cfg) for generate and edit, validated
   against the profile mapping and `GENERATE_MAX_NEGATIVE_PROMPT_CHARS`; untouched it sends exactly the old body.
   Their effect on this model is UNVERIFIED (README "Negative prompt, guidance and style defaults").
3. Boot console Task 3 (instance side): the `[boot] step <n>/9: <id>` and `[boot] FAILED:` markers are
   printed now (branch `fix/slow-boot`); still open: mirror the rest of the bootstrap output to
   `/proc/1/fd/1` so `vastai logs` shows it (plan: `docs/superpowers/plans/2026-10-18-boot-console.md`; needs a push and
   a real boot to verify). Deferred minors of the console are listed in that plan's review notes (not blocking).
4. ~~Save + Gallery~~ Done and on `master` (PR #4): Save per result, auto-save (this device), a gallery card
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
