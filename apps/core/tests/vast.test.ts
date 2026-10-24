import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppsConfig } from "../src/config.js";
import {
  CreateRejected,
  DestroyError,
  VastClient,
  VastError,
  normalizeGpuName,
  offerFiltersFromConfig,
  type CreateRequest,
} from "../src/vast.js";

const KEY = "k".repeat(40) + "SECRET";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

let server: Server | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  server?.closeAllConnections?.();
  server?.close();
  server = undefined;
});

type Handler = (req: Seen, res: ServerResponse) => void;

async function fake(handler: Handler, timeoutS = 5): Promise<{ client: VastClient; seen: Seen[]; sleeps: number[] }> {
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = raw === "" ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const entry: Seen = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const cfg = {
    vastApiKey: KEY,
    vastApiUrl: `http://127.0.0.1:${port}/api/v0`,
    httpTimeoutSApps: timeoutS,
    secretNames: [],
  } as unknown as AppsConfig;
  // Waits (search retries) are recorded, not taken.
  return { client: new VastClient(cfg, { sleep: async (ms) => void sleeps.push(ms) }), seen, sleeps };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const filters = {
  minVramGb: 24,
  maxDph: 0.5,
  minDownloadMbps: 500,
  minReliability: 0.98,
  diskGb: 50,
  allowedGpus: ["RTX 4090"],
};

const request: CreateRequest = {
  image: "img:tag",
  disk: 50,
  env: { AGENT_TOKEN: "abc", PORTAL_CONFIG: "localhost:8188:18188:/:ComfyUI" },
  onstart: "echo hi",
  label: "vastcomfy",
};

describe("VastClient", () => {
  it("search sends the configured filters and sorts by price", async () => {
    const { client, seen } = await fake((_r, res) =>
      json(res, 200, { offers: [{ id: 2, dph_total: 0.4 }, { id: 1, dph_total: 0.2 }, { id: 3, dph_total: 0.3 }] }),
    );
    const offers = await client.searchOffers(filters);
    expect(offers.map((o) => o.id)).toEqual([1, 3, 2]);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("/api/v0/bundles/");
    expect(seen[0]?.auth).toBe(`Bearer ${KEY}`);
    const q = seen[0]?.body as Record<string, Record<string, unknown>>;
    expect(q["gpu_ram"]).toEqual({ gte: 24000 });
    expect(q["dph_total"]).toEqual({ lte: 0.5 });
    expect(q["inet_down"]).toEqual({ gte: 500 });
    expect(q["reliability"]).toEqual({ gte: 0.98 });
    expect(q["gpu_name"]).toEqual({ in: ["RTX 4090"] });
    expect(q["num_gpus"]).toEqual({ eq: 1 });
  });

  it("search normalises GPU names and refuses to run without an allow-list", async () => {
    const { client, seen } = await fake((_r, res) => json(res, 200, { offers: [] }));
    await client.searchOffers({ ...filters, allowedGpus: ["RTX_3090", "RTX A5000"] });
    expect((seen[0]?.body as Record<string, unknown>)["gpu_name"]).toEqual({ in: ["RTX 3090", "RTX A5000"] });
    // Empty used to mean "any GPU" (it rented a Tesla P40): now nothing is sent at all.
    await expect(client.searchOffers({ ...filters, allowedGpus: [] })).rejects.toThrow(/allow-list/);
    expect(seen).toHaveLength(1);
    expect(normalizeGpuName("RTX_4090")).toBe("RTX 4090");
    expect(normalizeGpuName("rtx 4090")).toBe("rtx 4090");
  });

  it("create sends env + onstart + label and never a port mapping", async () => {
    const { client, seen } = await fake((_r, res) => json(res, 200, { success: true, new_contract: 777 }));
    expect(await client.createInstance(55, request)).toEqual({ id: 777 });
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.url).toBe("/api/v0/asks/55/");
    const b = seen[0]?.body as Record<string, unknown>;
    expect(b["image"]).toBe("img:tag");
    expect(b["disk"]).toBe(50);
    expect(b["label"]).toBe("vastcomfy");
    expect(b["onstart"]).toBe("echo hi");
    expect(b["runtype"]).toBe("ssh_direc ssh_proxy");
    expect(b["env"]).toEqual(request.env);
    expect(Object.keys(b["env"] as object).some((k) => k.startsWith("-"))).toBe(false);
    expect(JSON.stringify(b)).not.toMatch(/-p |ports/);
  });

  it("create rejects port-mapping style env keys and failure bodies", async () => {
    const { client } = await fake((_r, res) => json(res, 200, { success: false, msg: "no longer available" }));
    await expect(client.createInstance(1, { ...request, env: { "-p 80:80": "1" } })).rejects.toThrow(VastError);
    await expect(client.createInstance(1, request)).rejects.toThrow(/no longer available/);
  });

  it("create classifies definite refusals apart from ambiguous failures", async () => {
    let status = 400;
    let body: unknown = { msg: "bad request" };
    const { client } = await fake((_r, res) => json(res, status, body));
    // Definite: nothing was created.
    await expect(client.createInstance(1, request)).rejects.toBeInstanceOf(CreateRejected);
    status = 200;
    body = { success: false, msg: "no longer available" };
    await expect(client.createInstance(1, request)).rejects.toBeInstanceOf(CreateRejected);
    await expect(client.createInstance(0, request)).rejects.toBeInstanceOf(CreateRejected);
    // Ambiguous: the instance may exist.
    for ([status, body] of [
      [500, { msg: "oops" }],
      [502, "bad gateway"],
      [200, { success: true }],
    ] as [number, unknown][]) {
      const err = (await client.createInstance(1, request).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(VastError);
      expect(err).not.toBeInstanceOf(CreateRejected);
    }
    vi.stubGlobal("fetch", () => Promise.reject(new Error("socket hang up")));
    const err = (await client.createInstance(1, request).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(VastError);
    expect(err).not.toBeInstanceOf(CreateRejected);
  });

  it("list returns instances across pages", async () => {
    const { client, seen } = await fake((r, res) => {
      if (r.url.includes("after_token=t1")) {
        json(res, 200, { instances: [{ id: 2, label: null, actual_status: "running", start_date: 5, dph_total: 0.3 }] });
      } else {
        json(res, 200, {
          instances: [{ id: 1, label: "vastcomfy", actual_status: "loading", start_date: 1.5, dph_total: 0.2 }],
          next_token: "t1",
        });
      }
    });
    const rows = await client.listInstances();
    expect(rows.map((r) => [r.id, r.label, r.actual_status])).toEqual([
      [1, "vastcomfy", "loading"],
      [2, null, "running"],
    ]);
    expect(seen[0]?.url.startsWith("/api/v1/instances/?")).toBe(true);
  });

  it("destroy reports destroyed on a success body", async () => {
    const { client, seen } = await fake((_r, res) => json(res, 200, { success: true }));
    expect(await client.destroyInstance(9)).toBe("destroyed");
    expect(seen[0]?.method).toBe("DELETE");
    expect(seen[0]?.url).toBe("/api/v0/instances/9/");
  });

  it('destroy treats a 404 "not found" body as gone', async () => {
    const { client } = await fake((_r, res) =>
      json(res, 404, { error: true, status_code: 404, msg: "Instance 9 not found." }),
    );
    expect(await client.destroyInstance(9)).toBe("gone");
  });

  it("destroy treats a 2xx body carrying status_code 404 or error plus not-found text as gone", async () => {
    for (const body of [
      { error: true, status_code: 404, msg: "Instance 9 not found." },
      { error: true, msg: "Failed with error 404: Instance 9 not found." },
    ]) {
      const { client } = await fake((_r, res) => json(res, 200, body));
      expect(await client.destroyInstance(9)).toBe("gone");
      server?.close();
    }
  });

  it("destroy keeps a bare success:false with not-found wording a failure", async () => {
    const { client } = await fake((_r, res) => json(res, 200, { success: false, msg: "Instance 9 not found" }));
    await expect(client.destroyInstance(9)).rejects.toThrow(DestroyError);
  });

  it("destroy never trusts an inner 404 on a non-2xx HTTP status", async () => {
    for (const status of [401, 403, 500, 502]) {
      const { client } = await fake((_r, res) =>
        json(res, status, { error: true, status_code: 404, msg: "Instance 9 not found" }),
      );
      await expect(client.destroyInstance(9)).rejects.toThrow(DestroyError);
      server?.close();
    }
  });

  it("destroy treats 401 and 5xx as failure even if the text mentions not found", async () => {
    for (const status of [401, 403, 500]) {
      const { client } = await fake((_r, res) => json(res, status, { msg: "Instance 9 not found" }));
      await expect(client.destroyInstance(9)).rejects.toThrow(DestroyError);
      server?.close();
    }
  });

  it("errors never contain the api key", async () => {
    const { client } = await fake((_r, res) => json(res, 500, { msg: `bad key ${KEY} and Bearer ${KEY}` }));
    for (const call of [
      () => client.searchOffers(filters),
      () => client.createInstance(1, request),
      () => client.listInstances(),
      () => client.destroyInstance(1),
    ]) {
      const err = (await call().catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(VastError);
      expect(err.message).not.toContain(KEY);
      expect(err.message).toContain("[redacted]");
    }
  });

  it("redacts the key from a 200 success:false body on search, create and destroy", async () => {
    const { client } = await fake((_r, res) =>
      json(res, 200, { success: false, msg: `nope ${KEY} and Bearer ${KEY}` }),
    );
    for (const call of [
      () => client.searchOffers(filters),
      () => client.createInstance(1, request),
      () => client.destroyInstance(1),
    ]) {
      const err = (await call().catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(VastError);
      expect(err.message).not.toContain(KEY);
      expect(err.message).toContain("[redacted]");
    }
  });

  it("redacts the key from network errors", async () => {
    const { client } = await fake((_r, res) => json(res, 200, {}));
    vi.stubGlobal("fetch", () => Promise.reject(new Error(`socket failed for Bearer ${KEY} / ${KEY}`)));
    for (const call of [
      () => client.searchOffers(filters),
      () => client.createInstance(1, request),
      () => client.listInstances(),
      () => client.destroyInstance(1),
    ]) {
      const err = (await call().catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(VastError);
      expect(err.message).not.toContain(KEY);
      expect(err.message).toContain("[redacted]");
    }
  });

  it("search retries a network error or 5xx (it only reads) and then succeeds", async () => {
    let n = 0;
    const { client, seen, sleeps } = await fake((_r, res) => {
      n++;
      if (n === 1) return void res.socket?.destroy();
      if (n === 2) return json(res, 503, { msg: "busy" });
      json(res, 200, { offers: [{ id: 7, dph_total: 0.3 }] });
    });
    expect((await client.searchOffers(filters)).map((o) => o.id)).toEqual([7]);
    expect(seen).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("search gives up after 3 attempts and never retries a 4xx", async () => {
    const down = await fake((_r, res) => json(res, 502, "bad gateway"));
    await expect(down.client.searchOffers(filters)).rejects.toThrow(/HTTP 502/);
    expect(down.seen).toHaveLength(3);
    server?.close();
    const refused = await fake((_r, res) => json(res, 401, { msg: "bad key" }));
    await expect(refused.client.searchOffers(filters)).rejects.toThrow(/HTTP 401/);
    expect(refused.seen).toHaveLength(1);
    expect(refused.sleeps).toHaveLength(0);
  });

  it("create is never retried, whatever the failure", async () => {
    const { client, seen, sleeps } = await fake((_r, res) => json(res, 503, { msg: "busy" }));
    await expect(client.createInstance(1, request)).rejects.toBeInstanceOf(VastError);
    expect(seen).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it("search returns [] for an empty offers list", async () => {
    const { client } = await fake((_r, res) => json(res, 200, { offers: [] }));
    expect(await client.searchOffers(filters)).toEqual([]);
  });

  it("list stops on a repeated next_token", async () => {
    const { client } = await fake((_r, res) => json(res, 200, { instances: [], next_token: "same" }));
    await expect(client.listInstances()).rejects.toThrow(/repeated page token/);
  });

  it("the constructor requires a versioned VAST_API_URL", () => {
    const cfg = { vastApiKey: KEY, vastApiUrl: "http://127.0.0.1:1/api", httpTimeoutSApps: 2 } as unknown as AppsConfig;
    expect(() => new VastClient(cfg)).toThrow(/versioned/);
  });

  it("timeouts surface as VastError", async () => {
    const { client } = await fake(() => undefined, 1);
    const err = (await client.listInstances().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(VastError);
    expect(err.message).toMatch(/timed out/);
    const gone = (await client.destroyInstance(3).catch((e: unknown) => e)) as Error;
    expect(gone).toBeInstanceOf(DestroyError);
  });

  it("offerFiltersFromConfig parses decimal text and rejects bad values", () => {
    const base = {
      vastMinVramGb: 24,
      vastMaxDph: "0.50",
      vastMinDownloadMbps: 500,
      vastMinReliability: "0.98",
      vastDiskGb: 50,
      vastAllowedGpus: [],
    };
    const f = offerFiltersFromConfig(base as unknown as AppsConfig);
    expect(f.maxDph).toBe(0.5);
    expect(f.minReliability).toBe(0.98);
    expect(() => offerFiltersFromConfig({ ...base, vastMaxDph: "abc" } as unknown as AppsConfig)).toThrow(/VAST_MAX_DPH/);
    expect(() => offerFiltersFromConfig({ ...base, vastMaxDph: "0.5abc" } as unknown as AppsConfig)).toThrow(/VAST_MAX_DPH/);
    expect(() => offerFiltersFromConfig({ ...base, vastMinReliability: "" } as unknown as AppsConfig)).toThrow(/VAST_MIN_RELIABILITY/);
    expect(() => offerFiltersFromConfig({ ...base, vastMaxDph: "-1" } as unknown as AppsConfig)).toThrow(VastError);
    expect(() => offerFiltersFromConfig({ ...base, vastMinReliability: "1.5" } as unknown as AppsConfig)).toThrow(/between 0 and 1/);
  });
});

describe("VastClient.accountCredit", () => {
  const user = (over: Record<string, unknown> = {}) => ({
    id: 7, email: "owner@example.test", username: "owner", credit: 4.5377, balance: 4.1, api_key: "leaked-api-key-value", ssh_key: "ssh-rsa AAAA", ...over,
  });
  const ok = (body: unknown) => (_s: Seen, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  it("reads GET users/current with the bearer key and returns only the credit number", async () => {
    const { client, seen } = await fake(ok(user()));
    expect(await client.accountCredit()).toBe(4.5377);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("/api/v0/users/current");
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
  });

  it("accepts a zero or negative credit", async () => {
    expect(await (await fake(ok(user({ credit: 0 })))).client.accountCredit()).toBe(0);
    expect(await (await fake(ok(user({ credit: -1.25 })))).client.accountCredit()).toBe(-1.25);
  });

  const bad: Record<string, unknown> = {
    missing: user({ credit: undefined }),
    text: user({ credit: "4.5" }),
    null_value: user({ credit: null }),
    nan: user({ credit: "NaN" }),
    not_an_object: ["credit"],
  };
  it.each(Object.keys(bad))("refuses a response whose credit is %s, without echoing the account", async (name) => {
    const { client } = await fake(ok(bad[name]));
    const err = await client.accountCredit().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VastError);
    expect(String((err as Error).message)).not.toContain("owner@example.test");
    expect(String((err as Error).message)).not.toContain("leaked-api-key-value");
  });

  it("turns an HTTP error into a VastError that hides the key and the account", async () => {
    const { client } = await fake((_s, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ msg: `bad key ${KEY} for owner@example.test` }));
    });
    const err = await client.accountCredit().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VastError);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain(KEY);
  });

  it("a hung Vast is a VastError after the timeout", async () => {
    const { client } = await fake(() => undefined, 1);
    await expect(client.accountCredit()).rejects.toBeInstanceOf(VastError);
  }, 10_000);
});
