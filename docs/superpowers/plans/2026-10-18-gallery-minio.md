# Save to MinIO and Gallery Implementation Plan

**Goal:** A member can save a result image to the homelab MinIO (one click per image, or automatically), and open a cross-device gallery of the images they saved. Admins can also see everyone's images. The bucket stays private: the browser only ever talks to the web service.

**Handoff item:** `docs/HANDOFF.md` "Save + Gallery". Local per-device history stays as is.

## Architecture

- **No database.** The bucket is the source of truth, and the web process stays stateless. An image lives at
  `u/<owner>/<rts>-<jobId>-<index>` where `<owner>` is the first 32 hex characters of the SHA-256 of the identity subject (the raw subject, usually an email-like string, never appears in a key) and `<rts>` is `10^13 - createdMs` zero-padded to 13 digits, so a plain prefix listing is newest first. The content type is the object's own `Content-Type`. Prompt, label, owner name, kind and creation time are stored as URL-encoded user metadata (ASCII-safe, truncated).
- **Public id** of an image (what the browser sees): `<owner>.<rts>.<jobId>.<index>`. The key is rebuilt from it; nothing else is accepted. A member may touch an id only when its owner part equals their own; an admin may touch any.
- **Save** takes `{job, index}` of one of the caller's finished jobs (the server fetches the bytes from ComfyUI itself, so the browser cannot upload arbitrary data). The same job image saved twice is one object (idempotent: `HEAD` first). Quotas (`GALLERY_MAX_IMAGES_PER_USER`, `GALLERY_MAX_BYTES_PER_USER`) are checked against a listing of the owner's prefix before a new object is written.
- **List** is one `ListObjectsV2` page per request (`StartAfter` = the cursor's key, which must lie inside the caller's prefix), then one `HEAD` per item for its metadata. Admin "everyone" lists the whole `u/` prefix up to `GALLERY_ADMIN_SCAN_MAX` keys, sorts by time and pages in memory.
- **S3 client:** `@aws-sdk/client-s3`, path-style addressing, fixed region, checksums only `WHEN_REQUIRED` (MinIO and other S3-compatible servers reject the SDK's newer default checksum headers in some versions), explicit request timeouts. Credentials come from `GALLERY_S3_ACCESS_KEY` / `GALLERY_S3_SECRET_KEY` (both secrets: they join the redaction set).
- **Off by default:** an empty `GALLERY_S3_ENDPOINT` turns the feature off (`/api/state` says so, the routes answer 503 `gallery_unavailable`, the page shows nothing new).

## Global constraints

Everything in the earlier plans applies: config only via the schema and `config.ts`; `python3 scripts/check_config_usage.py apps instance` stays green; default-deny `/api/*`; no secrets, S3 error bodies, keys or bucket names in responses or logs; English comments and commits; textContent only in the page; do not merge without the owner.

## Tasks

1. Config keys, plan, `ObjectStore` interface, `S3ObjectStore`, `MemoryObjectStore`; tests incl. a fake S3 HTTP server (PUT/HEAD/GET/DELETE/ListObjectsV2).
2. `Gallery` service: key/id scheme, save (idempotent, quota), list (own, everyone), read, delete.
3. Web: `POST /api/gallery`, `GET /api/gallery`, `GET /api/gallery/:id/image`, `POST /api/gallery/delete`, `gallery` flag in `/api/state`, jobs remember prompt/label/kind, OpenAPI, wiring in `main.ts`.
4. Page: Save button per result, auto-save toggle (this device), gallery card (open on demand, load more, admin "everyone", delete with confirmation).
5. Runbook (create bucket and a bucket-only MinIO user), `.env.example`, handoff; full verification; PR.

## Not in scope / unverified

- Thumbnails: the gallery shows the stored image itself (lazy loaded, small pages). Server-side resizing needs an image library; a later optimisation.
- A real MinIO: nothing here has run against one (fake S3 server only). The first real save is the owner's check.
- Discord `save` mode (sub-project 3).
