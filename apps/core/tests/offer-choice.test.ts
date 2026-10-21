import { describe, expect, it } from "vitest";
import {
  StartFilterError,
  filterAndSortOffers,
  parseStartFilters,
  publicOffer,
  regionOfLocation,
} from "../src/offer-choice.js";
import type { Offer } from "../src/vast.js";

const LIMITS = { maxDph: 1.0 };

describe("regionOfLocation", () => {
  it("reads the country code after the last comma", () => {
    expect(regionOfLocation("Quebec, CA")).toBe("north_america");
    expect(regionOfLocation("Texas, US")).toBe("north_america");
    expect(regionOfLocation("Lithuania, LT")).toBe("europe");
    expect(regionOfLocation("Tokyo, JP")).toBe("asia");
    expect(regionOfLocation("Sao Paulo, BR")).toBe("south_america");
    expect(regionOfLocation("Sydney, AU")).toBe("oceania");
    expect(regionOfLocation("Johannesburg, ZA")).toBe("africa");
    expect(regionOfLocation("ca")).toBe("north_america"); // a bare code
  });

  it("is null for anything it cannot place", () => {
    for (const bad of [null, "", "Somewhere", "Quebec, XX", "Quebec, CAN", "1, 2"]) expect(regionOfLocation(bad), String(bad)).toBeNull();
  });
});

describe("parseStartFilters", () => {
  it("reads every member and treats absent, null and 'any' as no filter", () => {
    expect(parseStartFilters(undefined, LIMITS)).toEqual({});
    expect(parseStartFilters({}, LIMITS)).toEqual({});
    expect(parseStartFilters({ region: "any", max_dph: null, min_down_mbps: null, sort: null, offer_id: null }, LIMITS)).toEqual({});
    expect(parseStartFilters({ region: "europe", max_dph: 0.5, min_down_mbps: 300, sort: "speed", offer_id: 42 }, LIMITS)).toEqual({
      region: "europe",
      maxDph: 0.5,
      minDownMbps: 300,
      sort: "speed",
      offerId: 42,
    });
  });

  it.each<[string, unknown]>([
    ["not an object", "europe"],
    ["an array", []],
    ["an unknown key", { host: "1.2.3.4" }],
    ["an unknown region", { region: "mars" }],
    ["a region that is not text", { region: 5 }],
    ["a price of zero", { max_dph: 0 }],
    ["a negative price", { max_dph: -1 }],
    ["a price above the configured cap", { max_dph: 1.01 }],
    ["a price that is text", { max_dph: "0.5" }],
    ["a price that is not finite", { max_dph: Infinity }],
    ["a negative speed", { min_down_mbps: -1 }],
    ["a fractional speed", { min_down_mbps: 10.5 }],
    ["a speed above the sane bound", { min_down_mbps: 2_000_000 }],
    ["an unknown sort", { sort: "random" }],
    ["an offer id of zero", { offer_id: 0 }],
    ["a fractional offer id", { offer_id: 1.5 }],
    ["an offer id that is text", { offer_id: "12" }],
    ["an unsafe offer id", { offer_id: 2 ** 60 }],
  ])("refuses %s", (_n, raw) => {
    expect(() => parseStartFilters(raw, LIMITS)).toThrow(StartFilterError);
    expect(() => parseStartFilters(raw, LIMITS)).toThrow(expect.objectContaining({ code: "invalid_filter" }));
  });

  it("accepts a price exactly at the configured cap", () => {
    expect(parseStartFilters({ max_dph: 1.0 }, LIMITS)).toEqual({ maxDph: 1.0 });
  });
});

describe("filterAndSortOffers", () => {
  const offer = (id: number, dph: number, geo: string | null, down: number | null, rel: number | null): Offer => ({
    id,
    dph_total: dph,
    gpu_name: "RTX 3090",
    gpu_ram: 24576,
    ...(geo === null ? {} : { geolocation: geo }),
    ...(down === null ? {} : { inet_down: down }),
    ...(rel === null ? {} : { reliability2: rel }),
    machine_id: id * 10,
  });
  const offers = [
    offer(1, 0.4, "Quebec, CA", 800, 0.99),
    offer(2, 0.3, "Lithuania, LT", 90, 0.97),
    offer(3, 0.5, "Tokyo, JP", 400, 0.999),
    offer(4, 0.2, null, null, null),
    offer(5, 0.35, "Texas, US", 300, 0.95),
  ];
  const ids = (f: Parameters<typeof filterAndSortOffers>[1]) => filterAndSortOffers(offers, f).map((o) => o.id);

  it("sorts by price by default, cheapest first, whatever order Vast sent", () => {
    expect(ids({})).toEqual([4, 2, 5, 1, 3]);
    expect(ids({ sort: "price" })).toEqual([4, 2, 5, 1, 3]);
  });

  it("sorts by speed and by reliability, best first, unknown last, price breaking ties", () => {
    expect(ids({ sort: "speed" })).toEqual([1, 3, 5, 2, 4]);
    expect(ids({ sort: "reliability" })).toEqual([3, 1, 2, 5, 4]);
  });

  it("filters by region; an offer whose place is unknown never matches a region", () => {
    expect(ids({ region: "north_america" })).toEqual([5, 1]);
    expect(ids({ region: "europe" })).toEqual([2]);
    expect(ids({ region: "asia" })).toEqual([3]);
    expect(ids({ region: "oceania" })).toEqual([]);
  });

  it("filters by price, inclusive", () => {
    expect(ids({ maxDph: 0.35 })).toEqual([4, 2, 5]);
  });

  it("filters by speed, inclusive; an offer with no reported speed is dropped when a minimum is asked", () => {
    expect(ids({ minDownMbps: 300 })).toEqual([5, 1, 3]);
    expect(ids({ minDownMbps: 0 })).toEqual([4, 2, 5, 1, 3].filter((i) => i !== 4)); // a minimum of 0 still needs a reported speed
  });

  it("combines filters and does not change its input", () => {
    const copy = structuredClone(offers);
    expect(ids({ region: "north_america", minDownMbps: 500, sort: "speed" })).toEqual([1]);
    expect(offers).toEqual(copy);
  });
});

describe("publicOffer", () => {
  it("shows what the dialog needs and nothing that names a machine or host", () => {
    const o: Offer = {
      id: 7,
      dph_total: 0.31,
      gpu_name: "RTX 3090",
      gpu_ram: 24576,
      geolocation: "Quebec, CA",
      inet_down: 812.4,
      reliability2: 0.9912,
      machine_id: 98765,
      host_id: 5,
      public_ipaddr: "1.2.3.4",
    };
    const view = publicOffer(o);
    expect(view).toEqual({ id: 7, gpu_name: "RTX 3090", dph: 0.31, vram_gb: 24, location: "Quebec, CA", region: "north_america", down_mbps: 812, reliability: 0.9912 });
    const text = JSON.stringify(view);
    for (const secret of ["machine", "host", "1.2.3.4", "98765"]) expect(text).not.toContain(secret);
  });

  it("is null in the fields Vast did not report", () => {
    expect(publicOffer({ id: 8, dph_total: 0.2 })).toEqual({ id: 8, gpu_name: null, dph: 0.2, vram_gb: null, location: null, region: null, down_mbps: null, reliability: null });
  });
});
