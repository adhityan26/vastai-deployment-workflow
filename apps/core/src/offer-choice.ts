import { MAX_MBPS, serverInfo, type Offer } from "./vast.js";

// The advanced part of the Start dialog: filter the Vast offers by region, price and reported download
// speed, sort them, and let an admin pick one specific offer. Everything here is pure; the lifecycle applies it
// to the offers it already filtered for the allow-list, the VAST_* limits and the bad-machine list.

export type Region = "north_america" | "south_america" | "europe" | "asia" | "oceania" | "africa";
export const REGIONS: readonly Region[] = ["north_america", "south_america", "europe", "asia", "oceania", "africa"];
export type SortKey = "price" | "speed" | "reliability";
export const SORT_KEYS: readonly SortKey[] = ["price", "speed", "reliability"];

/** What an admin may ask for on top of the configured limits; a filter can only narrow them, never widen. */
export interface StartFilters {
  region?: Region;
  maxDph?: number;
  minDownMbps?: number;
  sort?: SortKey;
  /** A specific offer from the listing instead of the first of the sort order. */
  offerId?: number;
}

export class StartFilterError extends Error {
  readonly code = "invalid_filter";
  constructor(message: string) {
    super(message);
    this.name = "StartFilterError";
  }
}

// ISO 3166-1 alpha-2 codes by region (Vast's geolocation ends with the code: "Quebec, CA"). Middle East counts as Asia.
const COUNTRIES: Record<Region, string> = {
  north_america: "US CA MX GT BZ HN SV NI CR PA CU JM HT DO PR BS BB TT",
  south_america: "BR AR CL CO PE VE EC BO PY UY GY SR",
  europe:
    "AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK TR",
  asia:
    "AE AF AM AZ BD BH BN BT CN GE HK ID IL IN IQ IR JO JP KG KH KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TW UZ VN YE",
  oceania: "AU NZ FJ PG NC PF WS TO VU SB",
  africa: "ZA EG NG KE MA DZ TN GH ET TZ UG SN CI CM AO MZ ZW ZM BW NA MU RW",
};
const REGION_OF = new Map<string, Region>(
  (Object.keys(COUNTRIES) as Region[]).flatMap((r) => COUNTRIES[r].split(" ").map((c): [string, Region] => [c, r])),
);
const COUNTRY_CODE = /(?:^|,)\s*([A-Za-z]{2})\s*$/;

/** The region of a Vast location text such as "Quebec, CA"; null when it has no usable country code. */
export function regionOfLocation(location: string | null): Region | null {
  if (location === null) return null;
  const m = COUNTRY_CODE.exec(location.trim());
  return m === null ? null : (REGION_OF.get(m[1]!.toUpperCase()) ?? null);
}

const KEYS = new Set(["region", "max_dph", "min_down_mbps", "sort", "offer_id"]);

/** Strictly check the filter members of a request. `limits.maxDph` is VAST_MAX_DPH: a request may only lower it. */
export function parseStartFilters(raw: unknown, limits: { maxDph: number }): StartFilters {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new StartFilterError("filters must be an object");
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) throw new StartFilterError("filters has an unknown member");
  const out: StartFilters = {};
  const set = (v: unknown): boolean => v !== undefined && v !== null;

  if (set(r["region"]) && r["region"] !== "any") {
    if (typeof r["region"] !== "string" || !(REGIONS as readonly string[]).includes(r["region"])) throw new StartFilterError("unknown region");
    out.region = r["region"] as Region;
  }
  if (set(r["max_dph"])) {
    const v = r["max_dph"];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > limits.maxDph) throw new StartFilterError("max_dph is outside the allowed price range");
    out.maxDph = v;
  }
  if (set(r["min_down_mbps"])) {
    const v = r["min_down_mbps"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_MBPS) throw new StartFilterError("min_down_mbps must be a whole number of Mbps");
    out.minDownMbps = v;
  }
  if (set(r["sort"])) {
    if (typeof r["sort"] !== "string" || !(SORT_KEYS as readonly string[]).includes(r["sort"])) throw new StartFilterError("unknown sort");
    out.sort = r["sort"] as SortKey;
  }
  if (set(r["offer_id"])) {
    const v = r["offer_id"];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new StartFilterError("offer_id must be a positive whole number");
    out.offerId = v;
  }
  return out;
}

const worstLast = (v: number | null): number => (v === null ? Number.NEGATIVE_INFINITY : v);

/** The offers that pass the filters, in the asked order (price by default); the input is not changed. */
export function filterAndSortOffers(offers: readonly Offer[], f: StartFilters): Offer[] {
  const kept = offers.filter((o) => {
    const server = serverInfo(o);
    if (f.region !== undefined && regionOfLocation(server.location) !== f.region) return false;
    if (f.maxDph !== undefined && !(o.dph_total <= f.maxDph)) return false;
    // A minimum speed needs a reported speed: an offer that does not say how fast it is does not qualify.
    if (f.minDownMbps !== undefined && (server.down_mbps === null || server.down_mbps < f.minDownMbps)) return false;
    return true;
  });
  const key = (o: Offer): number => {
    const server = serverInfo(o);
    return f.sort === "speed" ? worstLast(server.down_mbps) : f.sort === "reliability" ? worstLast(server.reliability) : 0;
  };
  return kept.sort((a, b) => {
    if (f.sort === "speed" || f.sort === "reliability") {
      const d = key(b) - key(a);
      if (d !== 0 && Number.isFinite(d)) return d;
      if (key(a) !== key(b)) return key(a) === Number.NEGATIVE_INFINITY ? 1 : -1;
    }
    return a.dph_total - b.dph_total;
  });
}

const MB_PER_GIB = 1024;

/** One offer as the dialog lists it. Never the machine id, host id or any address. */
export interface PublicOffer {
  id: number;
  gpu_name: string | null;
  dph: number;
  vram_gb: number | null;
  location: string | null;
  region: Region | null;
  down_mbps: number | null;
  reliability: number | null;
}

export function publicOffer(o: Offer): PublicOffer {
  const server = serverInfo(o);
  const ram = o.gpu_ram;
  return {
    id: o.id,
    gpu_name: typeof o.gpu_name === "string" ? o.gpu_name : null,
    dph: o.dph_total,
    vram_gb: typeof ram === "number" && Number.isFinite(ram) && ram > 0 ? Math.round(ram / MB_PER_GIB) : null,
    location: server.location,
    region: regionOfLocation(server.location),
    down_mbps: server.down_mbps,
    reliability: server.reliability,
  };
}
