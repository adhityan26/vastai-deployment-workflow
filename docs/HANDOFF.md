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
live step counter + rough preview over the ComfyUI websocket; "Generated in N s"; boot console (API, stepper, collapsible log;
on `feat/server-panel` the log is a dialog opened from the server panel);
stuck-start and slow-boot protection (below); Tailscale OAuth key minting (LIVE and verified: `tailscale auth key minted`).

**Start failures (2026-10-24, on `master`):** dependency failures answer HTTP 424 (not 502: Cloudflare swallowed the JSON body,
so the owner saw only "The request failed (HTTP 502)"); every Start failure has a specific plain-English text, Tailscale mint failures
carry `error.detail`; Tailscale token/key requests and the Vast offer search retry network errors and 5xx (`TS_RETRY_TOTAL_S`, default 15).
Table of messages: `deploy/web/README.md`, "Start failed: what the messages mean". NOT deployed yet.

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

## Tool menu (2026-10-20, branch `feat/tool-menu`, local commits, not pushed or deployed)

Task A (sidebar tool menu) is DONE: the six sample presets are on, the profile's `menu:` section and `/api/state`
`menu` drive a left sidebar (search, small-caps category headings, icon + title, `aria-current`, arrow keys,
remembered choice) that replaces the mode tabs and the style sub-menu; below 900 px it is a drawer behind a "Menu"
button. Each entry is its own panel; request bodies are unchanged (golden and page tests). Runbook:
`deploy/web/README.md` "Menu". Checked in jsdom and in headless Chromium at 1280 and 375 px against a fake state;
never on a phone or against a real instance. Next: Task B (Start dialog advanced server choice).

## Server panel (2026-10-21, branch `feat/server-panel`, local commits, not pushed or deployed)

The approved design `docs/superpowers/plans/2026-10-21-server-panel-design.md` is implemented: the status and the
admin controls moved into a right server panel (a 288 px column from 1280 px, a right drawer below), the Vast credit
and a status pill are in the header, a floating widget shows uptime/cost/idle while the panel is off screen, and the
boot log is a dialog opened from the panel's boot summary. One overlay at a time (`setOverlay`). Request bodies and
API contracts are unchanged; every element id stayed (`#console-toggle` and `vast-comfy.console-collapsed` were
removed by design). Runbook: `deploy/web/README.md` "Menu" (Server panel), "Boot console", "Vast credit". Checked in
jsdom and in headless Chromium at 1280, 1000 and 375 px (light and dark) against a fake state; never on a real phone,
with iOS safe areas or the on-screen keyboard, with a screen reader, or against a real instance.

## Custom instance image (2026-10-21, branch `feat/custom-image`, local commits, not pushed or deployed)

Phase 1 is ready to build. `instance/image/Dockerfile` (base = the `VAST_IMAGE` schema default) bakes the agent
venv (dependencies plus pinned `vastai`, not the agent) and the pinned Tailscale tarball outside `/workspace`,
plus a marker `/opt/vastcomfy-image.json`. `bootstrap.sh` skips those installs only when the marker matches the
configuration and the binaries are executable; otherwise it installs at boot as before. The owner builds and
pushes with `scripts/build-image.sh --owner <user> [--push]` and switches with the printed `VAST_IMAGE=` line.
The schema default `VAST_IMAGE` is unchanged. Runbook: `deploy/web/README.md` "Custom instance image".
NOTHING was built or booted: the Dockerfile, the GHCR pull from Vast and the boot-time saving are unverified.
**Phase 2:** bake the ComfyUI-GGUF node and its requirements, after a real instance shows where ComfyUI lives
inside the image and whether `/workspace` is overlaid at runtime. Model files stay out of the image.

## History dialog (2026-10-21, branch `feat/history-dialog`, merged to master)

The admin usage history ("History": start, duration, GPU, stop reason, estimated cost) is no longer a card at the
bottom of every tool page. It is a full-screen dialog like the boot log (`#usage-card`, `role="dialog"`, overlay kind
`history` in `setOverlay`), opened by the admin-only `#history-open` button in the server panel (after the boot
summary, above the Danger zone, also shown without an instance). `GET /api/history` is read when the dialog opens and,
while open, again when the state turns none or ready; never while closed. `#usage-toggle` and
`vast-comfy.history-collapsed` were removed. No server, API or config change. Runbook: `deploy/web/README.md`
"Usage history" and "Menu". Checked in jsdom and in headless Chromium at 1280 and 375 px against a fake state; never on
a real phone, with a screen reader, or against a real instance.

## Video (2026-10-21, branch `feat/video`, pushed, NOT merged or deployed)

Text to video and image to video (exactly one optional start image) with one model through native ComfyUI nodes,
on the same instance and profile as images. Runbook: `deploy/web/README.md` "Video". Built: the profile's `video:`
section and `instance/workflows/video-ti2v.json`; both profile loaders validate the section (also while it is off);
`POST /api/video`, `GET /api/video/{id}/{index}` (mp4/WebM by magic bytes, `VIDEO_MAX_BYTES`), `video` in
`/api/state`, the `video` menu mode and `film` icon; the page's Video entry (prompt, start image by picker, paste or
"Make a video", size, length, seed; `<video controls playsinline>` from a blob URL, Download, a long-wait note);
config keys `VIDEO_TIMEOUT_S`, `VIDEO_MAX_BYTES`, `VIDEO_VIEW_TIMEOUT_S`. Saving videos to the gallery is out of
scope for phase 1 (`video_not_saveable`); the image gallery is unchanged.

**Switched by `VIDEO_ENABLED` (branch `feat/video-env-switch`, 2026-10-22), not by the profile.** The config key
(apps and instance, default false) turns video on; the profile's `video:` section has no `enabled:` any more and both
loaders refuse one that does (pointing to `VIDEO_ENABLED`). The three video files are pinned in `models:` (owner,
2026-10-22, licences checked). With video off they are never downloaded (boot, network probe and its "all present"
check leave them out), and the web app sends nothing about video to the instance; with `VIDEO_ENABLED=true` it
passes `VIDEO_ENABLED=true` and the link rules. A video file missing from `models:` while video is on still stops the
web app and the boot with "video model ... is not listed in models".

**The video files are not downloaded at every boot (owner decision 2026-10-22).** The Start dialog has "Include video
models" (admin, unticked by default, remembered per browser): unticked, the boot is exactly the image-only boot of
before (disk, offer search, price, instance env, downloads, node check, progress/ETA); ticked, the web app rents
`VAST_VIDEO_DISK_GB` (80) and sets `INCLUDE_VIDEO_MODELS=true`, and the boot downloads the video files and checks the
video node classes. Later, an admin can press "Download video models" in the Video tool (`POST /api/video-models` ->
agent `POST /video-models`): node classes and disk checked first, then a single-flight background download with the
boot's code; progress in `/api/state` `video.models`; image jobs keep running; the download counts as idle
activity. Members only see "ask an admin". Video jobs are refused (`video_models_not_ready`) until the files are
there. Decision: the trigger is admin-only (disk, network and minutes of the paid instance). After the download the
agent checks that ComfyUI's loaders list the new files rather than restarting ComfyUI; ComfyUI is expected to re-read
its model folders by modification time (from memory of its code, UNVERIFIED); if it does not, the state is `failed`
with "needs a restart". Runbook: README "Video", "Video models at Start, or later on demand".

UNVERIFIED, nothing ran against ComfyUI: the workflow graph and node/input names (the video latent node, `CreateVideo`,
`SaveVideo` and their inputs were written from memory of the native nodes, not exported from a running ComfyUI); whether the instance image's ComfyUI is new enough to have these nodes (boot checks them via
`/object_info` once video is on and fails loudly if not); that `SaveVideo` (mp4, h264) lists its file under `images`
in the history and the file plays in browsers; whether the repo paths in the pin commands are right; model sizes
(about 18 GB assumed), VRAM at 1280x704 x 121 frames on 24 GB, time per clip (assumed 5-20 min), phone playback
(iOS/Android), result file sizes, disk use on the instance and the longer boot (more download, slow-download guard).
Known limit: image jobs queued behind a running video keep their own 600 s timeout and may fail on the page while
ComfyUI still runs them later.
**Model links (owner request 2026-10-22):** an admin may give a Hugging Face link (`.safetensors` or `.gguf`) that
replaces the video diffusion model, in the Start dialog (`video_model_url`, only with Include video models) or with
"Download video models" (`url`). Checked on the web (shape, host allow-list `VIDEO_MODEL_LINK_HOSTS`, type) and
again on the instance (every redirect hop: https, 443, allowed domains; HEAD size cap `VIDEO_MODEL_LINK_MAX_BYTES`;
disk; magic bytes after download). Not integrity-pinned or licence-checked: the sha256 of what arrived is reported
(admins see it). Text encoder and VAE stay pinned; a link does not lift the pin requirement of `VIDEO_ENABLED`. A
`.gguf` link swaps the workflow's `UNETLoader` for `UnetLoaderGGUF` and requires that class
(`video_gguf_loader_missing`); whether the pinned `leejet/ComfyUI-GGUF` fork loads this video model's GGUF files is
UNVERIFIED (the usual loader for it is `city96/ComfyUI-GGUF`, which failed for the image model); if not, the first job fails with
"UnetLoaderGGUF: ...". Runbook: README "A model link instead of the pinned diffusion model". Not merged: the owner
decides after review.
Also UNVERIFIED: the on-demand download on a real instance (speed beside running jobs, room on a default 50 GB disk:
it may well be refused as `disk_insufficient`), ComfyUI listing the new files without a restart, the price of the
larger disk, and the slow-download guard on a boot with the video files (about 18 GB more).

**Second video family: 14B, 4 steps (branch `feat/video-14b`, 2026-10-23, pushed, NOT merged).** The profile's
`video_families:` lists `wan22_a14b` (two experts, fp8, the official lightx2v 4-step LoRAs, 4 steps, cfg 1) with a
workflow per mode (`video-14b-t2v.json`, `video-14b-i2v.json`). Switched on by `VIDEO_FAMILIES=wan22_a14b` (apps and
instance, besides `VIDEO_ENABLED=true`); its nine own files were pinned by the owner on 2026-10-24 (the text
encoder is shared with the 5B). The Start dialog chooses which families a boot downloads
(`video_families`, `VIDEO_BOOT_FAMILIES`; the disk follows the pins: 120 GB for 14B alone, 131 GB with both, at
`VAST_DISK_GB=50`), the Video tool has a
model choice, per-family download and per-expert links (both of a mode together; GGUF swaps that expert's loader).
An optional extra LoRA per job (profile `extra_loras:`) is inserted after the 4-step LoRA of
each branch it has a file for, strength 0 to 1. Shipped (corrected from the model card on 2026-10-26): "Calisthenic
moves" (high-noise only) and "Calisthenic moves + low-noise LoRA" (plus a third-party low-noise LoRA, pinned
2026-10-26, 307 MB), both image to video only, strength 1.0, no trigger words (the card gives none); both files are
downloaded with the family; neither repo states a licence. The 5B behaviour, its API fields and its tests are unchanged. UNVERIFIED (also): how the extra LoRAs
stack with the 4-step LoRAs at strength 1.0; the 14B graphs, recipe values,
16 fps, VRAM, time per clip, GGUF support of the pinned fork for these experts. Runbook: README "Video families".

**Experimental 12 s clips (branch `feat/video-12s`, 2026-10-24, pushed, NOT merged).** Both video families offer
"About 12 s (experimental)" (5B: 289 frames at 24 fps; 14B: 193 frames at 16 fps; profile `experimental: true`; the
frame cap is now 289). The page labels it and warns while it is chosen. Defaults unchanged: `VIDEO_TIMEOUT_S` 2400
may be too short for 12 s; README "Longer clips" says what to raise (e.g. 5400 with `WEB_JOB_TTL_S` 7200; the
timeout must stay shorter). UNVERIFIED: quality beyond about 5 s, VRAM for 289/193 frames (try 832x480 first on
24 GB), time per clip, result size (estimated well under `VIDEO_MAX_BYTES`).

**Extra LoRAs added from the page (branch `feat/lora-management`, 2026-10-26, pushed, NOT merged).** Admins add, edit,
hide and delete extra LoRAs of a video family by Hugging Face link (Video tool -> Manage LoRAs; `GET/POST /api/loras`,
`PATCH/DELETE /api/loras/{id}`), stored in `LORA_STORE_PATH` (`/data/extra-loras.json`). Server-chosen ids and file
names; the model-link rules, .safetensors only; checked on the web and again on the instance; not integrity-pinned
(sha256 of what arrived reported). The web app syncs the wanted set to a serving instance (agent `POST /loras`), which
downloads in the background through the video download slot; a job with a LoRA not on the instance is refused
(`extra_lora_not_ready`). Hidden LoRAs: server-enforced admin only; an admin's state lists them only with
`x-reveal-hidden: 1` (sent after three quick taps on the Video tool's title); a member's job naming one gets
`unknown_extra_lora`. Hidden is not secret from anyone with server or instance access. UNVERIFIED: a real download on
an instance, ComfyUI listing new LoRAs without a restart, stacking with the 4-step LoRAs. Runbook: README "Extra LoRAs
added from the page".

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
Discord bot (reuse the gallery `save` idea), 3D, video phase 2 (gallery save, after the live test of "Video"), `docs/superpowers/plans/2026-10-17-web-interface-followups.md`,
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
