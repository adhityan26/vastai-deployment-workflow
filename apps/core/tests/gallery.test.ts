import { describe, expect, it } from "vitest";
import type { AppsConfig } from "../src/config.js";
import { Gallery, GalleryError, galleryLimits, type GalleryLimits, type SaveInput } from "../src/gallery.js";
import { MemoryObjectStore, ObjectStoreError, type ObjectStore } from "../src/object-store.js";

// A real-looking PNG header (inspectImage reads the size from it) plus a marker.
function png(marker = "A", width = 8, height = 8): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from(marker)]);
}

const limits: GalleryLimits = { maxImages: 5, maxBytes: 10_000, pageSize: 3, adminScanMax: 100, maxImageBytes: 5_000 };
const AYU = { subject: "ayu@example.test", admin: false };
const BUDI = { subject: "budi|odd subject/with:chars", admin: false };
const ROOT = { subject: "root", admin: true };
const T0 = 1_800_000_000_000;

function input(over: Partial<SaveInput> = {}): SaveInput {
  return {
    owner: AYU.subject, ownerName: "Ayu", jobId: "job-1", index: 0, createdMs: T0,
    bytes: png(), contentType: "image/png", kind: "generate", prompt: "a red fox", label: "preview, 1:1", ...over,
  };
}

function make(over: Partial<GalleryLimits> = {}, store: ObjectStore = new MemoryObjectStore()) {
  return { store, gallery: new Gallery(store, { ...limits, ...over }) };
}

describe("save", () => {
  it("stores the image under a hashed owner prefix with newest-first keys and encoded metadata", async () => {
    const { store, gallery } = make();
    const res = await gallery.save(input({ prompt: "ünïcode & spaces / ?", label: "x" }));
    expect(res.created).toBe(true);
    const keys = (store as MemoryObjectStore).keys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^u\/[0-9a-f]{32}\/\d{13}-job-1-0$/);
    expect(keys[0]).not.toContain("ayu");
    expect(res.id).toMatch(/^[0-9a-f]{32}\.\d{13}\.job-1\.0$/);
    const head = await store.head(keys[0]!);
    expect(head?.contentType).toBe("image/png");
    expect(head?.metadata["kind"]).toBe("generate");
    for (const v of Object.values(head!.metadata)) expect(v).toMatch(/^[\x20-\x7e]*$/); // ASCII only
    expect(decodeURIComponent(head!.metadata["prompt"]!)).toBe("ünïcode & spaces / ?");
  });

  it("a later image sorts before an earlier one", async () => {
    const { store, gallery } = make();
    await gallery.save(input({ jobId: "old", createdMs: T0 }));
    await gallery.save(input({ jobId: "new", createdMs: T0 + 5_000 }));
    expect((store as MemoryObjectStore).keys().map((k) => k.split("/")[2]!.split("-")[1])).toEqual(["new", "old"]);
  });

  it("saving the same job image twice is one object and says so", async () => {
    const { store, gallery } = make();
    const first = await gallery.save(input());
    const second = await gallery.save(input());
    expect(second).toEqual({ id: first.id, created: false });
    expect((store as MemoryObjectStore).keys()).toHaveLength(1);
  });

  it("keeps long metadata inside the S3 header limit, including multi-byte text", async () => {
    const { store, gallery } = make();
    await gallery.save(input({ prompt: "日本語のプロンプト".repeat(200), label: "ラベル".repeat(100), ownerName: "名前".repeat(100) }));
    const head = await store.head((store as MemoryObjectStore).keys()[0]!);
    const total = Object.entries(head!.metadata).reduce((n, [k, v]) => n + k.length + v.length, 0);
    expect(total).toBeLessThan(1800);
    expect(decodeURIComponent(head!.metadata["prompt"]!).startsWith("日本語のプロンプト")).toBe(true);
  });

  it("refuses the 6th image of a member and an image that would pass the byte quota, but not another member", async () => {
    const { gallery } = make({ maxImages: 2 });
    await gallery.save(input({ jobId: "a" }));
    await gallery.save(input({ jobId: "b" }));
    await expect(gallery.save(input({ jobId: "c" }))).rejects.toMatchObject({ name: "GalleryError", code: "quota_images" });
    await expect(gallery.save(input({ jobId: "c", owner: BUDI.subject }))).resolves.toMatchObject({ created: true });
    // re-saving an existing one is not a new image
    await expect(gallery.save(input({ jobId: "a" }))).resolves.toMatchObject({ created: false });

    const { gallery: bytes } = make({ maxBytes: 100 });
    await bytes.save(input({ jobId: "a", bytes: png("x".repeat(20)) }));
    await expect(bytes.save(input({ jobId: "b", bytes: png("y".repeat(60)) }))).rejects.toMatchObject({ code: "quota_bytes" });
  });

  const bad: Record<string, Partial<SaveInput>> = {
    not_an_image: { bytes: Buffer.from("plain text, not an image") },
    gif_type: { contentType: "image/gif" },
    type_mismatch: { contentType: "image/jpeg" },
    too_big: { bytes: png("z".repeat(6000)) },
    empty: { bytes: Buffer.alloc(0) },
    bad_job_id: { jobId: "../etc" },
    long_job_id: { jobId: "a".repeat(129) },
    bad_index: { index: -1 },
    big_index: { index: 1000 },
    fractional_index: { index: 1.5 },
    bad_time: { createdMs: 0 },
    huge_time: { createdMs: 10 ** 13 },
    no_owner: { owner: "" },
  };
  it.each(Object.keys(bad))("refuses %s and stores nothing", async (name) => {
    const { store, gallery } = make();
    await expect(gallery.save(input(bad[name]))).rejects.toBeInstanceOf(GalleryError);
    expect((store as MemoryObjectStore).keys()).toEqual([]);
  });

  it("a store failure surfaces as ObjectStoreError, not as a quota or validation error", async () => {
    const broken: ObjectStore = { ...new MemoryObjectStore(), head: async () => null, list: async () => { throw new ObjectStoreError("object store list failed"); }, put: async () => undefined, get: async () => null, delete: async () => undefined };
    await expect(new Gallery(broken, limits).save(input())).rejects.toBeInstanceOf(ObjectStoreError);
  });
});

describe("list", () => {
  // limits.maxImages is 5, so build with a roomier gallery
  async function roomy() {
    const ctx = make({ maxImages: 50 });
    for (let i = 0; i < 7; i++) await ctx.gallery.save(input({ jobId: `ayu${i}`, createdMs: T0 + i * 1000, prompt: `ayu prompt ${i}`, label: `l${i}` }));
    for (let i = 0; i < 2; i++) await ctx.gallery.save(input({ owner: BUDI.subject, ownerName: "Budi", jobId: `budi${i}`, createdMs: T0 + 500 + i * 1000, prompt: `budi ${i}` }));
    return ctx;
  }

  it("a member sees only their own images, newest first, with decoded metadata, in pages", async () => {
    const { gallery } = await roomy();
    const p1 = await gallery.list(AYU, { scope: "mine" });
    expect(p1.items.map((i) => i.prompt)).toEqual(["ayu prompt 6", "ayu prompt 5", "ayu prompt 4"]);
    expect(p1.items[0]).toMatchObject({ kind: "generate", label: "l6", ownerName: "Ayu", mine: true, contentType: "image/png", createdMs: T0 + 6000 });
    expect(p1.items[0]!.size).toBeGreaterThan(0);
    expect(p1.next).toBe(p1.items[2]!.id);
    const p2 = await gallery.list(AYU, { scope: "mine", cursor: p1.next! });
    expect(p2.items.map((i) => i.prompt)).toEqual(["ayu prompt 3", "ayu prompt 2", "ayu prompt 1"]);
    const p3 = await gallery.list(AYU, { scope: "mine", cursor: p2.next! });
    expect(p3.items.map((i) => i.prompt)).toEqual(["ayu prompt 0"]);
    expect(p3.next).toBeNull();
    expect((await gallery.list(BUDI, { scope: "mine" })).items.map((i) => i.prompt)).toEqual(["budi 1", "budi 0"]);
    expect((await gallery.list({ subject: "nobody", admin: false }, { scope: "mine" })).items).toEqual([]);
  });

  it("an admin can list everyone, merged newest first, with owner names and the mine flag", async () => {
    const { gallery } = await roomy();
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await gallery.list(ROOT, { scope: "all", ...(cursor ? { cursor } : {}) });
      all.push(...page.items.map((i) => `${i.ownerName}:${i.prompt}`));
      cursor = page.next ?? undefined;
    } while (cursor);
    expect(all).toEqual([
      "Ayu:ayu prompt 6", "Ayu:ayu prompt 5", "Ayu:ayu prompt 4", "Ayu:ayu prompt 3", "Ayu:ayu prompt 2",
      "Budi:budi 1", "Ayu:ayu prompt 1", "Budi:budi 0", "Ayu:ayu prompt 0",
    ]);
    expect((await gallery.list(ROOT, { scope: "all" })).items.every((i) => i.mine === false)).toBe(true);
  });

  it("a member cannot list everyone, and a cursor from another owner is refused", async () => {
    const { gallery } = await roomy();
    await expect(gallery.list(AYU, { scope: "all" })).rejects.toMatchObject({ code: "forbidden" });
    const budi = await gallery.list(BUDI, { scope: "mine" });
    await expect(gallery.list(AYU, { scope: "mine", cursor: budi.items[0]!.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(gallery.list(AYU, { scope: "mine", cursor: "nonsense" })).rejects.toMatchObject({ code: "invalid_id" });
  });

  it("the admin scan reads at most GALLERY_ADMIN_SCAN_MAX keys", async () => {
    const { gallery } = make({ maxImages: 50, adminScanMax: 3, pageSize: 10 });
    for (let i = 0; i < 5; i++) await gallery.save(input({ jobId: `j${i}`, createdMs: T0 + i }));
    expect((await gallery.list(ROOT, { scope: "all" })).items).toHaveLength(3);
  });

  it("skips an object that vanished between the listing and its metadata read", async () => {
    const mem = new MemoryObjectStore();
    const flaky: ObjectStore = {
      put: (...a) => mem.put(...a),
      get: (...a) => mem.get(...a),
      delete: (k) => mem.delete(k),
      list: (...a) => mem.list(...a),
      head: async (k) => (k.endsWith("-gone-0") ? null : mem.head(k)),
    };
    const gallery = new Gallery(flaky, { ...limits, maxImages: 50 });
    await gallery.save(input({ jobId: "gone", createdMs: T0 + 2 }));
    await gallery.save(input({ jobId: "kept", createdMs: T0 + 1 }));
    // "gone" exists in the listing but its HEAD says missing (save itself used head before put, so write directly)
    await mem.put(`u/${await ownerOf(gallery)}/${String(10 ** 13 - (T0 + 3)).padStart(13, "0")}-gone-0`, png(), "image/png", {});
    expect((await gallery.list(AYU, { scope: "mine" })).items.map((i) => i.id.split(".")[2])).toEqual(["kept"]);
  });
});

async function ownerOf(gallery: Gallery): Promise<string> {
  return gallery.ownerKey(AYU.subject);
}

describe("read and remove", () => {
  async function one() {
    const ctx = make({ maxImages: 50 });
    const { id } = await ctx.gallery.save(input({ bytes: png("MARKER") }));
    return { ...ctx, id };
  }

  it("the owner and an admin can read it; another member sees 'not found', as for a missing id", async () => {
    const { gallery, id } = await one();
    const bytes = png("MARKER");
    expect((await gallery.read(AYU, id)).bytes.equals(bytes)).toBe(true);
    expect((await gallery.read(AYU, id)).contentType).toBe("image/png");
    expect((await gallery.read(ROOT, id)).bytes.equals(bytes)).toBe(true);
    await expect(gallery.read(BUDI, id)).rejects.toMatchObject({ code: "not_found" });
    const missing = id.replace(/\.\d+$/, ".9");
    await expect(gallery.read(AYU, missing)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses ids that are not exactly ours, before touching the store", async () => {
    const { gallery, id } = await one();
    for (const bad of ["", "x", `${id}/..`, `../${id}`, id.replace(".", "/"), id.toUpperCase(), `${id}.png`, id + "\n", "a".repeat(300)]) {
      await expect(gallery.read(AYU, bad), bad).rejects.toMatchObject({ code: "invalid_id" });
      await expect(gallery.remove(AYU, bad), bad).rejects.toMatchObject({ code: "invalid_id" });
    }
  });

  it("only the owner or an admin can remove; removing twice is fine", async () => {
    const { store, gallery, id } = await one();
    await expect(gallery.remove(BUDI, id)).rejects.toMatchObject({ code: "not_found" });
    expect((store as MemoryObjectStore).keys()).toHaveLength(1);
    await gallery.remove(AYU, id);
    expect((store as MemoryObjectStore).keys()).toHaveLength(0);
    await gallery.remove(AYU, id);
    const again = await gallery.save(input());
    await gallery.remove(ROOT, again.id);
    expect((store as MemoryObjectStore).keys()).toHaveLength(0);
  });

  it("refuses to serve an object whose stored type is not an allowed image type", async () => {
    const { store, gallery, id } = await one();
    const key = (store as MemoryObjectStore).keys()[0]!;
    await store.put(key, Buffer.from("<html>"), "text/html", {});
    await expect(gallery.read(AYU, id)).rejects.toMatchObject({ code: "invalid_image" });
  });
});

describe("galleryLimits and ownerKey", () => {
  const cfg = (over: Record<string, unknown> = {}) =>
    ({ galleryMaxImagesPerUser: 300, galleryMaxBytesPerUser: 2_147_483_648, galleryPageSize: 12, galleryAdminScanMax: 5000, webImageMaxBytes: 33_554_432, ...over }) as unknown as AppsConfig;

  it("reads the limits from the configuration and refuses unusable values by key name", () => {
    expect(galleryLimits(cfg())).toEqual({ maxImages: 300, maxBytes: 2_147_483_648, pageSize: 12, adminScanMax: 5000, maxImageBytes: 33_554_432 });
    expect(() => galleryLimits(cfg({ galleryPageSize: 0 }))).toThrow("GALLERY_PAGE_SIZE");
    expect(() => galleryLimits(cfg({ galleryMaxImagesPerUser: "3" }))).toThrow("GALLERY_MAX_IMAGES_PER_USER");
  });

  it("derives a stable 32-hex owner key that does not reveal the subject", () => {
    const g = new Gallery(new MemoryObjectStore(), limits);
    expect(g.ownerKey("ayu@example.test")).toMatch(/^[0-9a-f]{32}$/);
    expect(g.ownerKey("ayu@example.test")).toBe(g.ownerKey("ayu@example.test"));
    expect(g.ownerKey("ayu@example.test")).not.toBe(g.ownerKey("ayu@example.tesT"));
    expect(g.ownerKey("ayu@example.test")).not.toContain("ayu");
  });
});
