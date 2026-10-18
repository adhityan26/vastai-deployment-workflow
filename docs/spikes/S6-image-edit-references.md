# S6: Image edit with reference images (Qwen-Image 2.1 GGUF)

- Date: 2026-10-18
- Instance: RTX 3090 24 GB (California, $0.188/h), image `vastai/comfy:v0.41.0-cuda-12.9-py312` (ComfyUI 0.41.0), the same three model files as the image profile (GGUF Q4_K_M, int8 text encoder, bf16 VAE). Run on the owner's already-running instance over the tailnet (no extra boot); cost ~ $0.01.

## Question
Can the existing model do reference-image editing (e.g. anime -> realistic) and multi-reference editing, with stock ComfyUI nodes, and how fast?

## Findings
- The image's ComfyUI 0.41.0 ALREADY has every node of the official Qwen-Image 2.1 edit template: `TextEncodeQwenImage21` (inputs `clip`, `prompt`, `negative_prompt`, `resolution`, optional `vae`, autogrow `images` -> API inputs `images.image_1`, `images.image_2`, ...; outputs positive, negative, latent), `QwenImage21Cache` (wraps the model: `model`, `device`, `dtype`), `LoadImage`, `UnetLoaderGGUF`. No ComfyUI update needed.
- API-format workflow that worked (the official template wraps these nodes in a subgraph; this is the flattened equivalent, no prompt enhancer, no switch nodes):

```json
{
 "1": {
  "class_type": "UnetLoaderGGUF",
  "inputs": {
   "unet_name": "qwen-image-2.1-UC-Q4_K_M.gguf"
  }
 },
 "2": {
  "class_type": "CLIPLoader",
  "inputs": {
   "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
   "type": "qwen_image",
   "device": "default"
  }
 },
 "3": {
  "class_type": "VAELoader",
  "inputs": {
   "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
  }
 },
 "4": {
  "class_type": "QwenImage21Cache",
  "inputs": {
   "model": [
    "1",
    0
   ],
   "device": "auto",
   "dtype": "default"
  }
 },
 "L1": {
  "class_type": "LoadImage",
  "inputs": {
   "image": "<uploaded file 1>"
  }
 },
 "L2": {
  "class_type": "LoadImage",
  "inputs": {
   "image": "<uploaded file 2, optional>"
  }
 },
 "6": {
  "class_type": "TextEncodeQwenImage21",
  "inputs": {
   "clip": [
    "2",
    0
   ],
   "prompt": "<instruction, may mention <image1>, <image2>>",
   "negative_prompt": "",
   "resolution": 1024,
   "vae": [
    "3",
    0
   ],
   "images.image_1": [
    "L1",
    0
   ],
   "images.image_2": [
    "L2",
    0
   ]
  }
 },
 "7": {
  "class_type": "KSampler",
  "inputs": {
   "model": [
    "4",
    0
   ],
   "positive": [
    "6",
    0
   ],
   "negative": [
    "6",
    1
   ],
   "latent_image": [
    "6",
    2
   ],
   "seed": 1,
   "steps": 25,
   "cfg": 1.0,
   "sampler_name": "euler",
   "scheduler": "simple",
   "denoise": 1.0
  }
 },
 "8": {
  "class_type": "VAEDecode",
  "inputs": {
   "samples": [
    "7",
    0
   ],
   "vae": [
    "3",
    0
   ]
  }
 },
 "9": {
  "class_type": "SaveImage",
  "inputs": {
   "images": [
    "8",
    0
   ],
   "filename_prefix": "edit"
  }
 }
}
```
- Reference images are uploaded to ComfyUI with `POST /upload/image` (multipart, field `image`, `overwrite=true`) and referenced by the returned `name` in `LoadImage.inputs.image`; the latent comes from the encoder (image_1 sets the canvas); output follows image_1.
- **Single reference (anime -> realistic photo)**, 1024x1024, 25 steps, prompt "Convert this anime illustration into a realistic photograph of a real girl. Keep the same pose, hair color, outfit and composition.": success in **46.7 s** (cold model load included); pose, pink hair, uniform and framing preserved; the result is a convincing photo.
- **Two references** ("Make the girl in <image1> wear the light blue denim jacket from <image2>. Keep her face, hair and pose from <image1>."): success in **53.9 s**; the jacket from image 2 appears on the girl of image 1, face/hair/pose preserved, anime style kept.
- Source images were generated on the same instance with the t2i workflow (71.6 s cold, 24.9 s warm at 15-20 steps).

## Verdict: PASS
Edit and multi-reference edit work with the GGUF Q4_K_M on stock ComfyUI 0.41.0; about 50 s per edit on a 3090 at 1024x1024.

## Decisions for the feature
1. New workflow `instance/workflows/qwen-image-edit.json` (API format above) and a profile section (`edit`) next to `generate`: node mapping for `prompt`, `steps`, `seed`, `resolution`, the `LoadImage` nodes (image_1..image_N) and the max number of references (config; the official template supports 10; start with 4).
2. The web service uploads references to ComfyUI server-side (browser -> web -> `/upload/image`), validates type/size/dimensions, never forwards a filename chosen by the browser, and builds the prompt from the profile template (like generate).
3. Not verified: prompt enhancer (extra 9B model, not used), >2 references, transparent outputs, very large images (2K), quality at 10 steps.

## Follow-ups
- Implement the feature (upload endpoint, edit mode in the page, up to N references, tests).
- `resolution` is a total pixel budget (not width/height); expose it as the size choice.
