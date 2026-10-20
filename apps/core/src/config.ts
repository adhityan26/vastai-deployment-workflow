import { readFileSync } from "node:fs";
import { parse } from "yaml";

// The only module that reads process.env: callers pass the environment in.
const COMPONENT = "apps";
const INT_TEXT = /^[0-9]+$/; // ASCII digits only: no sign, underscore, spaces or other scripts

type KeyType = "str" | "int" | "bool" | "csv";

interface KeySpec {
  name: string;
  components: string[];
  type: KeyType;
  secret: boolean;
  required: boolean;
  default: unknown;
  min?: number;
  max?: number;
  /** The closed list of values a str key may take (`choices:` in the schema). */
  choices?: readonly string[];
}

export type ConfigValue = string | number | boolean | string[];

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface AppsConfig {
  readonly [key: string]: ConfigValue | readonly string[];
  readonly secretNames: readonly string[];
}

export function camelCase(name: string): string {
  const [first = "", ...rest] = name.toLowerCase().split("_");
  return first + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

function loadSchema(schemaPath: string): KeySpec[] {
  let raw: { keys?: Record<string, unknown>[] };
  try {
    raw = parse(readFileSync(schemaPath, "utf8")) as typeof raw;
  } catch {
    throw new ConfigError([`config schema not readable at ${schemaPath}`]);
  }
  const specs: KeySpec[] = [];
  for (const item of raw.keys ?? []) {
    const type = item["type"] as KeyType;
    if (!["str", "int", "bool", "csv"].includes(type)) {
      throw new ConfigError([`${String(item["name"])}: unknown type ${String(type)}`]);
    }
    const spec: KeySpec = {
      name: String(item["name"]),
      components: (item["components"] as string[]) ?? [],
      type,
      secret: Boolean(item["secret"]),
      required: Boolean(item["required"]),
      default: item["default"] ?? null,
    };
    for (const which of ["min", "max"] as const) {
      const bound = item[which];
      if (bound === undefined || bound === null) continue;
      if (type !== "int" || typeof bound !== "number" || !Number.isInteger(bound)) {
        throw new ConfigError([`${spec.name}: ${which} must be an integer on an int key`]);
      }
      spec[which] = bound;
    }
    const choices = item["choices"];
    if (choices !== undefined && choices !== null) {
      if (type !== "str" || !Array.isArray(choices) || choices.length === 0 || !choices.every((c) => typeof c === "string" && c !== "")) {
        throw new ConfigError([`${spec.name}: choices must be a non-empty list of strings on a str key`]);
      }
      if (new Set(choices).size !== choices.length) throw new ConfigError([`${spec.name}: choices must be distinct`]);
      const def = spec.default;
      if (def !== null && def !== "" && !choices.includes(def as string)) throw new ConfigError([`${spec.name}: the default is not one of the choices`]);
      spec.choices = choices as string[];
    }
    specs.push(spec);
  }
  return specs;
}

function defaultText(spec: KeySpec): string {
  const d = spec.default;
  if (d === null || d === undefined) return "";
  if (Array.isArray(d)) return d.map(String).join(",");
  return String(d);
}

function coerce(spec: KeySpec, text: string): ConfigValue {
  switch (spec.type) {
    case "str":
      if (spec.choices !== undefined && !spec.choices.includes(text)) throw new Error(`must be one of ${spec.choices.join(", ")}`);
      return text;
    case "int": {
      if (!INT_TEXT.test(text)) throw new Error("expected an integer (digits only)");
      const value = Number.parseInt(text, 10);
      if (spec.min !== undefined && value < spec.min) {
        throw new Error(`below the minimum ${spec.min}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new Error(`above the maximum ${spec.max}`);
      }
      return value;
    }
    case "bool":
      if (text === "true" || text === "false") return text === "true";
      throw new Error("expected true or false");
    case "csv":
      return text
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
  }
}

/** Load the typed `apps` configuration; reports every invalid key at once and never echoes values. */
export function loadConfig(env: Record<string, string | undefined>, schemaPath: string): AppsConfig {
  const specs = loadSchema(schemaPath).filter((s) => s.components.includes(COMPONENT));
  const values: Record<string, ConfigValue> = {};
  const problems: string[] = [];
  for (const spec of specs) {
    let text = env[spec.name] ?? "";
    if (text === "") {
      if (spec.required) {
        problems.push(`${spec.name}: missing required key`);
        continue;
      }
      text = defaultText(spec);
    }
    try {
      values[camelCase(spec.name)] = coerce(spec, text);
    } catch (e) {
      problems.push(`${spec.name}: ${(e as Error).message}`);
    }
  }
  // Cross-key rule (apps only): the failsafe deadline can never lie beyond the hard cap.
  const failsafe = values[camelCase("START_FAILSAFE_HOURS")];
  const hardCap = values[camelCase("START_HARD_CAP_HOURS")];
  if (typeof failsafe === "number" && typeof hardCap === "number" && failsafe > hardCap) {
    problems.push("START_FAILSAFE_HOURS: must not be greater than START_HARD_CAP_HOURS");
  }
  // A stuck start must be noticed before the boot timeout would release it anyway.
  const stuck = values[camelCase("VAST_START_STUCK_MIN")];
  const bootTimeout = values[camelCase("BOOT_TIMEOUT_MIN")];
  if (typeof stuck === "number" && typeof bootTimeout === "number" && stuck >= bootTimeout) {
    problems.push("VAST_START_STUCK_MIN: must be less than BOOT_TIMEOUT_MIN");
  }
  // A silent agent must be noticed before the boot timeout would release the instance anyway.
  const agentGrace = values[camelCase("BOOT_AGENT_GRACE_MIN")];
  if (typeof agentGrace === "number" && typeof bootTimeout === "number" && agentGrace >= bootTimeout) {
    problems.push("BOOT_AGENT_GRACE_MIN: must be less than BOOT_TIMEOUT_MIN");
  }
  if (problems.length > 0) throw new ConfigError(problems);
  const secretNames = specs.filter((s) => s.secret).map((s) => s.name);
  return Object.freeze({ ...values, secretNames }) as AppsConfig;
}

/** Load the `apps` configuration from this process's environment (entry points only). */
export function loadConfigFromProcess(schemaPath: string): AppsConfig {
  return loadConfig(process.env, schemaPath);
}
