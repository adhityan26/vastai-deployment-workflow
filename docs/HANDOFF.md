# Handoff (2026-10-20)

Written so a fresh session (for example a cloud session that only has this repo) can continue. It contains no secrets and no private addresses. Local-only things (`.env`, memory, `.superpowers/` ledgers, homelab access) are NOT available in a cloud session.

## What this project is

Private, cost-efficient image generation on rented Vast.ai GPUs: ComfyUI + Qwen-Image 2.1 GGUF (`qwen-image-2.1-UC-Q4_K_M`). A web service on the homelab (`apps/core` + `apps/web`, Node/TypeScript, Fastify) starts/extends/destroys one instance, shows status and generates images. The instance runtime lives in `instance/` (Python agent + bash bootstrap/failsafe). Login is in-app OIDC with Authentik (admins start/destroy/extend; members generate).

## State on 2026-10-21

**Deployed on the homelab and on `master` (commit 8396b78):** OIDC login; GPU choice with price, location and download speed
per offer; overall download progress; Vast credit for admins; Generate, Edit with up to 4 references (hardened), Upscale
(Real-ESRGAN x4plus); styles framework with the live presets `faceswap` and `anything2real` ("Anime / cartoon to real", LoRA
`Qwen2.1_Anything2RealCharacters`, strength 0 = prompt only); Advanced section (negative prompt, guidance) that styles can pre-fill;
"Use as reference" on results and on saved gallery images; MinIO gallery (Save, auto-save, quotas); usage history with stop reasons;
live step counter + rough preview over the ComfyUI websocket; "Generated in N s"; boot console (API, stepper, collapsible log);
stuck-start and slow-boot protection (below); Tailscale OAuth key minting (LIVE and verified: `tailscale auth key minted`).

**Branch `feat/tool-menu` (pushed, NOT merged, NOT deployed): the next task for a cloud session.** See "Task A".

**Sample presets:** six sample styles (`portrait_photo`, `family_photo`, `anime`, `outfit_swap`, `photo_restore`, `to_anime`) are
OFF on `master` and ON in `feat/tool-menu` (commit 035d4f2) so the owner can test them in one boot. Their wording is a first draft; the
three generate ones pre-fill cfg 3.0 + a negative prompt, UNVERIFIED on this model.

**Slow boots (what the guards do; details in `deploy/web/README.md`, "Slow boots"):** web releases a booting instance as `slow_boot`
(agent silent 10 min after the container ran) or `slow_download` (ETA over 20 min or past the boot timeout), plus the start-stuck rule
(container never started). Released machines go on a bad list for 60 min, but only for failures that are the machine's fault.
The instance runs a first-step network probe (`net_probe`, 48 MiB of the largest pinned file, timing the second half, below 6 MB/s twice
= exit 14 + self-destroy; skipped on restarts or when models exist) and downloads each model over 4 parallel byte ranges.
Measured on 2026-10-19: Lithuania A5000 pulled 2.8 MB/s from Hugging Face (15 GB = 1.5 h); California 3090 sat in apt for 20+ minutes;
Quebec 3090 pulled ~55 MB/s (boot ~7 min). Vast's `inet_down` does NOT predict the speed to Hugging Face. Prefer east North America.

**NOT verified live (a real boot has never run with the code on `master`):** the probe and its early self-destroy; byte ranges through
the Hugging Face CDN/xet redirect; whether `COMFYUI_ARGS` in `/workspace/.env` is picked up (check `ps aux | grep main.py` shows
`--preview-method latent2rgb`); websocket progress/preview through the userspace tailnet; preview quality; the six sample presets;
negative prompt / cfg above 1 with `QwenImage21Cache`; Upscale at 2x/4x; LoRA strength 0.6/0.7/0.8 versus 0; Face swap quality.

## Next work, in order

### Task A: finish the sidebar tool menu (branch `feat/tool-menu`)
The owner wants navigation like a photo-tool site he showed: a LEFT SIDEBAR listing every tool as a menu entry grouped by
category (search box on top, small-caps group headings, icon + title, active item highlighted), where each style/preset is its own
entry with its own panel and parameters, replacing the old mode tabs + style sub-menu. Borrow only the layout idea.
- DONE on the branch: 035d4f2 (six samples enabled, tests updated, golden fixtures for the untouched requests unchanged) and
  b3c5042 (data driven menu: profile `menu:` section with ordered categories; built-in tools Generate/Edit/Upscale are entries; styles
  get `category`/`description`/`icon`/`order`; `/api/state` exposes the resolved menu without templates or node ids; OpenAPI).
- WIP commit df623a9 (an interrupted implementer; the tests may FAIL, review it critically, keep or discard): `index.html`,
  `model.ts`, `style.css`, `ui.ts`, new `icons.ts` (closed set of inline SVG icons), `page.test.ts`, `progress.test.ts`.
- TO DO: finish and test the page: desktop >= 900 px fixed sidebar (~250 px) with search (case-insensitive, textContent only), arrow-key
  and Tab navigation, `aria-current`, remembered selection in localStorage (try/catch, validated against the menu, unknown id -> first
  entry); main area = the selected tool's panel (title, description, labelled reference slots, notes, quality/size/resolution, Advanced,
  action button) then the existing cards (Status, Results, Gallery, History, Boot console). Mobile < 900 px: off-canvas drawer opened by a
  "Menu" button in a sticky top bar (focus trap, Esc, backdrop, 44 px targets, no horizontal scroll at 375 px). Selecting an entry must do
  what the mode switch + style selector did (mode, style id/params, references, defaults pre-fill, live preview/progress, Use-as-reference
  and Upscale chain buttons now SELECT the right entry, gallery Save, history). Request bodies for Generate/Edit/Upscale and presets must
  stay byte-identical (golden test `apps/core/tests/golden`, and the page tests that pin `{prompt, preset, size}`).
- Add a README "Menu" section (profile `menu:` schema, how to add a tool, categories, icon list), mark this done here.
- Note: a cloud session cannot render the page in the owner's browser; say plainly what was not visually verified.

### Task B: advanced server choice in the Start dialog
The owner wants better control over WHERE the instance runs, because location decides boot speed. Today the dialog lists GPU models with
price, location and download speed per offer (see `apps/core/src/lifecycle.ts` gpuOptions/estimate, `apps/web/src/routes.ts`).
Build an "Advanced" part: filter by region/country (for example North America, Europe, Asia; derive from Vast `geolocation`, plain text
like "Quebec, CA"), max price per hour, minimum reported download speed (`VAST_MIN_DOWNLOAD_MBPS` exists), optional explicit choice of
one specific offer from a short list (price, location, reliability, speed) instead of the cheapest, and a sort order (price, speed,
reliability). The bad-machine list (stuck/slow) must still be respected, an offer can vanish between listing and renting (clear error, no
instance created, nothing billed), members never see machine/host ids or IPs (admins start instances anyway), strict request validation,
config keys through the schema, tests with the fake Vast server, page tests. Prefer remembering the last filter choice per device.
Do this AFTER Task A (both touch `apps/web/public/ui.ts`).

### Task C: boot console Task 3 and small follow-ups
- The instance now prints `[boot] step <n>/9: <id>` markers (including `net_probe`) and `[boot] FAILED:` lines, but the rest of the bootstrap
  output is still not mirrored to the container log (`/proc/1/fd/1`), so `vastai logs` and the boot console only show markers and Vast
  `status_msg`. Mirror it (bounded, never secrets, never blocking the boot: `console_line` already uses a timed subshell). The agent
  should also print `[watchdog] destroying instance: reason=...` where the boot console can see it (today it goes to the supervisor log).
- Pin sha256 for model files in the profile (the Hugging Face `X-Linked-Etag`) and verify after download: today integrity is size only.
- TAESD preview decoder `taeqi2_1_decoder` (better live previews than `latent2rgb`): find its official source before adding it, never guess a URL.
- Deferred minors listed in the review notes of the plans under `docs/superpowers/plans/`.

### Later
Discord bot (reuse the gallery `save` idea), video/3D, `docs/superpowers/plans/2026-10-17-web-interface-followups.md`,
Camera angle (AnyAngle LoRA + extra 3D models; licences unchecked, see the styles design doc).

## What a cloud session can and cannot do
It can read, build and test everything with the fake servers in the test suites, and push branches. It CANNOT: reach the homelab or the
Vast API, start or inspect instances, read the owner's `.env`, or deploy. Live checks and the deploy are done by the owner's laptop session:
`docker-compose -p vast-comfy -f docker-compose.yml up -d --build` against the homelab Docker host, after bumping `REPO_COMMIT` in `.env`
to the pushed master commit (the instance checks out exactly that commit; forgetting this once made an instance run old code).
Do not merge or push to `master` without the owner's approval; open the work as a branch or PR and say what to test live.

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
