import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";

export type InstanceStatus = "creating" | "booting" | "ready" | "stopping" | "gone" | "anomaly";

export interface InstanceRecord {
  vast_instance_id: number | null; // null only while status is "creating"
  created_at: number;
  vast_start_date?: number | null;
  profile: string;
  agent_token: string;
  tailnet_hostname: string;
  status: InstanceStatus;
  unreachable_since?: number | null;
  /** When the web found the start stuck (the container never started) and released the instance. */
  start_stuck_at?: number | null;
  /** Vast machine of that stuck start; later Starts avoid it for VAST_BAD_MACHINE_TTL_MIN. */
  stuck_machine_id?: number | null;
}

export type NewRecord = Omit<InstanceRecord, "status" | "vast_instance_id"> &
  Partial<Pick<InstanceRecord, "vast_instance_id">>;

export class AlreadyActiveError extends Error {
  constructor(hostname: string) {
    super(`an instance is already active: ${hostname}`);
    this.name = "AlreadyActiveError";
  }
}

export class RegistryCorruptError extends Error {
  constructor(message: string) {
    super(`registry is corrupt: ${message}`);
    this.name = "RegistryCorruptError";
  }
}

export class RecordNotFoundError extends Error {
  constructor(hostname: string) {
    super(`no registry record for ${hostname}`);
    this.name = "RecordNotFoundError";
  }
}

export class RegistryValidationError extends Error {
  constructor(message: string) {
    super(`invalid registry record: ${message}`);
    this.name = "RegistryValidationError";
  }
}

export class Registry {
  private readonly validate: ValidateFunction;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    schemaPath: string,
  ) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    this.validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")) as object);
  }

  // Serialize every operation so concurrent callers cannot interleave read-modify-write.
  private serial<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private check(record: unknown): InstanceRecord {
    if (!this.validate(record)) {
      throw new RegistryValidationError(JSON.stringify(this.validate.errors));
    }
    return record as InstanceRecord;
  }

  // Cross-record rules, shared by load and save so we never write a file the loader refuses.
  private invariants(records: InstanceRecord[]): void {
    const seen = new Set<string>();
    for (const r of records) {
      if (seen.has(r.tailnet_hostname)) throw new Error(`duplicate hostname ${r.tailnet_hostname}`);
      seen.add(r.tailnet_hostname);
    }
    if (records.filter((r) => r.status !== "gone").length > 1) throw new Error("more than one non-gone record");
  }

  private load(): InstanceRecord[] {
    if (!existsSync(this.filePath)) return [];
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (err) {
      throw new RegistryCorruptError((err as Error).message);
    }
    if (!Array.isArray(data)) throw new RegistryCorruptError("top level is not a list");
    const records = data.map((item) => {
      try {
        return this.check(item);
      } catch (err) {
        throw new RegistryCorruptError((err as Error).message);
      }
    });
    try {
      this.invariants(records);
    } catch (err) {
      throw new RegistryCorruptError((err as Error).message);
    }
    return records;
  }

  private save(records: InstanceRecord[]): void {
    records.forEach((r) => this.check(r));
    try {
      this.invariants(records);
    } catch (err) {
      throw new RegistryValidationError((err as Error).message);
    }
    // Atomic against process crashes (temp file + rename). No fsync of the temp file or the
    // directory, so this is not durable across power loss.
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${basename(this.filePath)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // temp file may not exist
      }
      throw err;
    }
  }

  all(): Promise<InstanceRecord[]> {
    return this.serial(() => this.load());
  }

  active(): Promise<InstanceRecord | null> {
    return this.serial(() => this.load().find((r) => r.status !== "gone") ?? null);
  }

  findByVastId(id: number): Promise<InstanceRecord | null> {
    return this.serial(() => this.load().find((r) => r.vast_instance_id === id) ?? null);
  }

  begin(record: NewRecord): Promise<InstanceRecord> {
    return this.serial(() => {
      const records = this.load();
      const active = records.find((r) => r.status !== "gone");
      if (active) throw new AlreadyActiveError(active.tailnet_hostname);
      const created = this.check({ vast_instance_id: null, ...record, status: "creating" });
      if (records.some((r) => r.tailnet_hostname === created.tailnet_hostname)) {
        throw new RegistryValidationError(`duplicate hostname ${created.tailnet_hostname}`);
      }
      this.save([...records, created]);
      return created;
    });
  }

  update(hostname: string, patch: Partial<Omit<InstanceRecord, "tailnet_hostname">>): Promise<InstanceRecord> {
    return this.serial(() => {
      const records = this.load();
      const index = records.findIndex((r) => r.tailnet_hostname === hostname);
      const current = records[index];
      if (current === undefined) throw new RecordNotFoundError(hostname);
      if ("tailnet_hostname" in patch) throw new RegistryValidationError("tailnet_hostname cannot be changed");
      if (current.status === "gone" && patch.status !== undefined && patch.status !== "gone") {
        throw new RegistryValidationError("a gone record cannot be revived");
      }
      const next = this.check({ ...current, ...patch });
      records[index] = next;
      this.save(records);
      return next;
    });
  }

  markGone(hostname: string): Promise<InstanceRecord> {
    return this.serial(() => {
      const records = this.load();
      const index = records.findIndex((r) => r.tailnet_hostname === hostname);
      const current = records[index];
      if (current === undefined) throw new RecordNotFoundError(hostname);
      if (current.status === "gone") return current;
      const next = this.check({ ...current, status: "gone" });
      records[index] = next;
      this.save(records);
      return next;
    });
  }
}
