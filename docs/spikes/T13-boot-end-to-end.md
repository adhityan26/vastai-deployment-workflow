# T13: first real end-to-end boot from the web service

- Date: 2026-10-17/18
- Setup: web service run locally (`vite-node apps/web/src/main.ts`, WEB_HOST 127.0.0.1) with a local JWKS server and self-signed admin/member JWTs standing in for Authentik; real Vast API, real Tailscale (single-use `tag:gpu` key from a file), image `vastai/comfy:v0.41.0-cuda-12.9-py312` on an RTX A5000 24 GB (Lithuania, $0.2406/h). `START_FAILSAFE_HOURS=1`, `START_IDLE_MINUTES=5`, `START_HARD_CAP_HOURS=2`. Two boots, both destroyed. Total cost **$0.227** (credit $4.7644 -> $4.5377).
- Commits under test: 065c858 (boot 1), 45b5ea8 on branch `fix/real-boot-1` (boot 2).

## What was verified on real infrastructure
- Vast REST: offer search (`POST /bundles/`), create (`PUT /asks/{offer}/`, runtype `ssh_direc ssh_proxy`, `cancel_unavail`), list, destroy all work as implemented. **The label `vastcomfy:<hostname>` (with a colon) is accepted and read back unchanged.**
- Boot timeline from the web (`booting` -> `downloading` -> ready): boot 1: start 01:14:09, downloading at 01:15:49 (1m40s), ready 01:20:07 (**~6 min**); boot 2: start 02:22:00, downloading 02:24:48 (2m48s), ready 02:28:34 (**~6.5 min**). Model download ~4.3 min (14.6 GB). `BOOT_TIMEOUT_MIN` (25) has ample margin.
- Tailscale: single-use key, userspace mode, node `tag:gpu`; the laptop reached the instance by its **bare MagicDNS name** (`vast-xxxxxxxx`) on 18188 and 8189 with a direct connection (229 ms RTT). The agent `/status` was readable by the web.
- Web security checks against the live service: no JWT -> 401, forged `x-authentik-*` headers without JWT -> 401, member on admin endpoints -> 403, admin ok.
- Extend idle via the web works; **idle auto-destroy fired by itself** (instance gone from Vast at the deadline) and the web marked the record `gone` about 2 minutes later (reconcile with the two-miss rule); the page showed `ready` for ~1.5 min in between.
- Destroy from the web: `{"outcome":"destroyed","agent_reached":true}`, Vast empty within 7 s, web state `none` in 2 s.
- Generation from the web (1:1, A5000): preview (10 steps) 16-23 s, standard (25) 35-45 s, high (40) 55-56 s from submit to done. The preview image is usable. Images are ~1.7-2.1 MB PNG.

## Bugs found and fixed (branch `fix/real-boot-1`)
1. Custom-node requirements were installed with a bare `pip` into the wrong environment, so `gguf` was missing, `UnetLoaderGGUF` never registered and every generate failed although the instance said ready. Fix: `COMFY_PYTHON -m pip install -r ...`, plus a `verify-nodes` boot step (profile `provides_node_classes`) that fails the boot closed (`node_import_failed`) when a declared class is not registered. Verified on boot 2: `UnetLoaderGGUF registered: True`.
2. `/view` shared the 10 s API timeout; a 1.8 MB image over the tailnet took 7.5 s. Fix: `WEB_IMAGE_TIMEOUT_S` (default 60).

## Findings that need follow-up
- Image download over the tailnet is slow and variable: ~230-330 KB/s, 6-24 s for ~2 MB, and two requests stalled until the 60 s timeout (the connection then closed with no HTTP reply). The 60 s `WEB_IMAGE_TIMEOUT_S` equals `WEB_CONNECTION_TIMEOUT_S`; raise the image timeout (e.g. 120 s) and make sure the connection timeout is larger, and consider saving WEBP/JPEG instead of PNG to cut the size 3-5x.
- The page keeps showing `ready` for ~1.5 min after the instance destroyed itself (reconcile needs two misses); show Vast status/agent-unreachable more prominently.
- With `START_IDLE_MINUTES` (5) below `IDLE_WARN_MINUTES` (10) the state is `idle-warning` right after ready; only a test-config artifact.
- First image generation after boot is slower (model load): 45 s vs 35 s for 25 steps.

## Not verified here
- Authentik (JWT from the real outpost, groups claim, JWKS/issuer/audience values), Cloudflare tunnel, and the container-to-tailnet path from the homelab Docker host: all of that still needs the real homelab deployment (deploy/web/README.md).
- Failure paths on a real instance (wrong TS_AUTHKEY, `node_import_failed`) were not forced.
