import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlreadyActiveError,
  Registry,
  RegistryCorruptError,
  RegistryValidationError,
  type NewRecord,
} from "../src/registry.js";

const schema = fileURLToPath(new URL("../../../contracts/instance-registry.schema.json", import.meta.url));

function fresh(): { reg: Registry; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  const file = join(dir, "registry.json");
  return { reg: new Registry(file, schema), file, dir };
}

function rec(host = "vast-ab12"): NewRecord {
  return { created_at: 1_700_000_000, profile: "image", agent_token: "t".repeat(32), tailnet_hostname: host };
}

describe("Registry", () => {
  it("begin writes a creating record before anything else", async () => {
    const { reg, file } = fresh();
    const out = await reg.begin(rec());
    expect(out.status).toBe("creating");
    expect(out.vast_instance_id).toBeNull();
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].status).toBe("creating");
    expect(await reg.active()).toEqual(out);
  });

  it("second begin while one is active throws AlreadyActiveError", async () => {
    const { reg } = fresh();
    await reg.begin(rec("a"));
    await expect(reg.begin(rec("b"))).rejects.toBeInstanceOf(AlreadyActiveError);
  });

  it("concurrent begin calls yield exactly one record", async () => {
    const { reg } = fresh();
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => reg.begin(rec(`h${i}`))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyActiveError);
    expect(await reg.all()).toHaveLength(1);
  });

  it("corrupt file is reported, not silently reset", async () => {
    const { reg, file } = fresh();
    writeFileSync(file, "{not json");
    await expect(reg.all()).rejects.toBeInstanceOf(RegistryCorruptError);
    await expect(reg.begin(rec())).rejects.toBeInstanceOf(RegistryCorruptError);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("schema-invalid file is reported as corrupt", async () => {
    const { reg, file } = fresh();
    writeFileSync(file, JSON.stringify([{ status: "weird" }]));
    await expect(reg.active()).rejects.toBeInstanceOf(RegistryCorruptError);
  });

  it("update validates against the contract schema", async () => {
    const { reg } = fresh();
    await reg.begin(rec());
    await expect(reg.update("vast-ab12", { status: "weird" as never })).rejects.toBeInstanceOf(RegistryValidationError);
    await expect(reg.update("vast-ab12", { status: "booting" })).rejects.toBeInstanceOf(RegistryValidationError); // null id
    const ok = await reg.update("vast-ab12", { vast_instance_id: 42, status: "booting" });
    expect(ok.vast_instance_id).toBe(42);
    expect((await reg.active())?.status).toBe("booting");
    expect(await reg.findByVastId(42)).toEqual(ok);
    expect(await reg.findByVastId(7)).toBeNull();
  });

  it("a null vast id is accepted only while creating", async () => {
    const { reg } = fresh();
    await reg.begin(rec());
    await expect(reg.update("vast-ab12", { status: "ready" })).rejects.toBeInstanceOf(RegistryValidationError);
    expect((await reg.all())[0]?.status).toBe("creating");
  });

  it("file is written atomically", async () => {
    const { reg, file, dir } = fresh();
    await reg.begin(rec());
    await Promise.all([
      reg.update("vast-ab12", { vast_instance_id: 1, status: "booting" }),
      reg.update("vast-ab12", { status: "ready" }).catch(() => undefined),
    ]);
    expect(readdirSync(dir)).toEqual(["registry.json"]); // no temp leftovers
    expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
  });

  it("markGone frees the slot and is idempotent", async () => {
    const { reg } = fresh();
    await reg.begin(rec("a"));
    const gone = await reg.markGone("a");
    expect(gone.status).toBe("gone");
    expect(await reg.markGone("a")).toEqual(gone);
    expect(await reg.active()).toBeNull();
    await reg.begin(rec("b"));
    expect(await reg.all()).toHaveLength(2);
  });

  it("update of an unknown hostname fails", async () => {
    const { reg } = fresh();
    await expect(reg.update("nope", { status: "ready" })).rejects.toThrow(/no registry record/);
  });

  it("rejects reviving a gone record and a hostname change, leaving the file untouched", async () => {
    const { reg, file } = fresh();
    await reg.begin(rec("old"));
    await reg.markGone("old");
    await reg.begin(rec("cur"));
    const before = readFileSync(file, "utf8");
    await expect(reg.update("old", { status: "booting", vast_instance_id: 5 })).rejects.toBeInstanceOf(RegistryValidationError);
    await expect(reg.update("cur", { tailnet_hostname: "old" } as never)).rejects.toBeInstanceOf(RegistryValidationError);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(await reg.all()).toHaveLength(2);
  });

  it("a failed write leaves no temp file and the original untouched", async () => {
    const { reg, file, dir } = fresh();
    await reg.begin(rec("a"));
    const before = readFileSync(file, "utf8");
    chmodSync(dir, 0o500);
    try {
      await expect(reg.update("a", { vast_instance_id: 1, status: "booting" })).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readdirSync(dir)).toEqual(["registry.json"]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
