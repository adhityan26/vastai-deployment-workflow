# Styles, sub-menus and "use this result as a reference" (design for the next sessions)

Status: agreed with the owner in chat on 2026-10-18, not implemented yet. Build it in the order at the end.
Follow the project flow: write a short implementation plan from this design (docs/superpowers/plans/), TDD, task review, then ask the owner before pushing or deploying.

## 1. Goal

Today the page has two modes (Generate, Edit). The owner wants:

1. **Styles with their own sub-menu and parameters.** Each style (a LoRA or a special workflow) is a sub-menu of its mode with its own panel of parameters. No shared dropdown of unrelated knobs.
2. **Chaining.** Take a result image (for example a plain Generate result) and send it as the reference image to the next workflow or style (Edit, Anything to Real, AnyAngle, Upscale, ...), without downloading and re-uploading it by hand.

## 2. Page structure

- Top tabs = modes: `Generate`, `Edit`, later `Upscale`.
- Inside `Edit`: a style sub-menu: `Standard` (today's edit) and `Anything to Real`; later `Camera angle` (AnyAngle). `Generate` has only `Standard` for now (the Anything to Real LoRA is trained for edit, so it is marked edit-only; a style lists the modes it supports, so Generate can be enabled later without code if a live test shows it works).
- One style per job at first (combining two LoRAs in one job is out of scope; the user chains instead: run style A, then use the result as the reference for style B).
- Each style panel shows only its own parameters. The panel is built from the profile, not hard-coded in the page.

## 3. Profile schema (declarative, validated server side)

In `instance/profiles/image.yaml` add a `styles:` section (also reflected in the Python profile loader and tests, and in contracts). Per style:

```yaml
styles:
  - id: anything2real
    title: Anything to Real
    modes: [edit]                # where it may be used
    lora:
      file: Qwen2.1_Anything2RealCharacters.safetensors
      # download on demand like the other models: url + sha256 + size in the same shape as `models`
    params:
      - {id: strength, title: LoRA strength, type: float, min: 0.4, max: 1.0, step: 0.05, default: 0.7}
```

Rules: `modes` and `params` types are a closed set (`float`, `int`, `choice`, `bool`); every value sent by the browser is validated against the profile (type, range, step, choice list) before it reaches a workflow; unknown params are refused; node class and input names inside workflows are never taken from the request. The LoRA file is downloaded only when a job uses that style (the agent already downloads models on demand per profile; extend that to styles, with the same checksum and size checks), then loaded with `LoraLoaderModelOnly` between the UNet loader (or the cache node) and the sampler. WHERE exactly the loader sits relative to `QwenImage21Cache` is unverified: test it live.

`/api/state` exposes the styles (id, title, modes, params with limits) so the page can render the sub-menu and panels; OpenAPI and the page parser are updated.

## 4. First style: Anything to Real (LoRA)

- Source: Hugging Face `WarmBloodAban/Qwen-Image-2.1-LoRAs`, file `Qwen2.1_Anything2RealCharacters.safetensors` (about 0.32 GB), license Apache-2.0, for Qwen-Image 2.1 edit. The file already uses the `diffusion_model` key prefix that ComfyUI loads directly. Pin the revision and record the sha256 after the first download.
- Model card advice: LoRA weight 0.6 to 0.8, sampler Euler, otherwise the base-model settings. It is trained for characters and people (anime, 3D, any style to a realistic person with the same pose/identity); for non-human edits the style stays off.
- Unverified: that it works on the quantized GGUF base `qwen-image-2.1-UC-Q4_K_M`. A live test on a real instance is required: compare an anime/comic edit with and without the LoRA at strengths 0.6/0.7/0.8, and one text-to-image run to decide whether Generate may list it.
- The other LoRA of that repo (`Qwen2.1_Anime_consistency`) is experimental and needs key remapping for ComfyUI: out of scope.
- A different LoRA the owner remembered, `RunningHubAI/rh-qwen-image-anime2real-lora` (`Qwen Image2.1_Anime2Real.safetensors`, 152 MiB), has an unclear license: not used.

## 5. Chaining ("use as reference")

- Every result in the page gets a button `Use as reference` (and a style-aware variant: choose the target mode/style from a small menu). It switches to the target mode and adds the result as a reference.
- How: the result image already lives on the instance (ComfyUI `output/`) and the page has it as a blob. Preferred: the page re-reads the blob it already has and goes through the existing reference path (base64 in the JSON body, all existing validation: magic bytes, size, animated refusal). That needs no new server surface. Alternative (only if the result is no longer in the page, for example after a reload): the server copies the result from `output/` to `input/` inside the instance and returns a reference token; do this only if a clear need appears, as it adds a new server-side reference type.
- Local history keeps working as today (device-local); a history entry can also be sent to a reference.
- Limits and validation are the same as for uploads (count, bytes, pixels, side).

## 6. Later styles/modes (not part of the first iteration)

- **Upscale** mode: its own tab with a single reference image and the model upscaler (`ImageUpscaleWithModel`, models such as Real-ESRGAN or 4x-UltraSharp, check licenses first); params: scale 2x/4x; output size bounded by config.
- **Camera angle (AnyAngle)**: LoRA `lilylilith/QI_2.1_AnyAngle` plus, per the video that introduced it, extra 3D models (`VAST-AI/TripoSplat`, `Comfy-Org/Pixal3D`) for accurate angles; params would be azimuth/elevation. It adds downloads, VRAM and boot time: do it after Anything to Real is live-tested; check the three licenses first.
- **DLSS**: not applicable. It is a game-engine technology (needs motion vectors and depth buffers) and is not a ComfyUI model for still images; "Upscale" above is the realistic equivalent.

## 7. Suggested order

1. Finish and review `feat/usage-history` (see the brief next to this file) if it is not on origin yet.
2. Styles framework: profile schema + Python loader + tests, `/api/state`, validation, workflow builder with an optional LoRA loader, page sub-menu with generated panels. Include the first style (Anything to Real) behind the framework.
3. Chaining button (`Use as reference`).
4. Live test on a real instance (owner runs it from the laptop: the cloud session cannot start instances): Anything to Real comparisons; fix defaults.
5. Upscale; then Camera angle.
