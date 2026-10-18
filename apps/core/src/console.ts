import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// Boot console: what an instance prints while it boots, merged from three sources (Vast
// status_msg, Vast container logs, the agent's /status), masked, bounded and persisted.
// Rules:
// - every line is normalised (last carriage-return segment, no ANSI/control characters), MASKED
//   (known secrets, then generic secret patterns) and only then cut to the line limit; lines are
//   masked again on the way out with the secrets known at that time;
// - the buffer is a ring of at most `maxLines` lines with ever-increasing sequence numbers;
// - nothing in this module performs I/O except ConsoleStore (one small JSON file, atomic writes).

export type ConsoleSource = "vast_status" | "vast_logs" | "agent";
const SOURCES: readonly ConsoleSource[] = ["vast_status", "vast_logs", "agent"];

export interface ConsoleLine {
  seq: number;
  /** Epoch UTC seconds when the web process first saw the line. */
  t: number;
  source: ConsoleSource;
  text: string;
}

export type PhaseStatus = "pending" | "running" | "done" | "failed";

export interface PhaseInfo {
  id: string;
  name: string;
  status: PhaseStatus;
}

/**
 * The boot steps the instance announces, in order. This is the ONE list the instance side
 * (instance/bootstrap.sh, Task 3) must follow: before step i (1-based) starts it prints exactly
 *   [boot] step <i>/<BOOT_STEPS.length>: <id>
 * and when the boot dies it prints exactly
 *   [boot] FAILED: <code>          (code: lowercase letters, digits, underscore; at most 64)
 * as a whole line on PID 1 stdout. Ids are fixed; display names are short English.
 */
export const BOOT_STEPS = [
  { id: "install_tools", name: "Install tools" },
  { id: "failsafe", name: "Start failsafe" },
  { id: "tailscale", name: "Join Tailscale" },
  { id: "agent", name: "Start agent" },
  { id: "nodes", name: "Install nodes" },
  { id: "models", name: "Download models" },
  { id: "comfyui", name: "Start ComfyUI" },
  { id: "ready", name: "Ready" },
] as const;

/** Every phase the console reports, in order: the image pull (from Vast `loading`) then the boot steps. */
export const BOOT_PHASES: readonly { id: string; name: string }[] = [
  { id: "image_pull", name: "Pull image" },
  ...BOOT_STEPS,
];

export const GAP_MARKER = "--- gap ---";
const STEP_MARKER = /^\[boot\] step ([1-9][0-9]{0,2})\/([1-9][0-9]{0,2}): ([a-z_]{1,32})$/;
const FAILED_MARKER = /^\[boot\] FAILED: ([a-z0-9_]{1,64})$/;
const VAST_LOADING = "loading";
const VAST_RUNNING = "running";

// ---------------------------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------------------------

const REDACTED = "[redacted]";
/** Known secrets shorter than this are not masked (they would mask ordinary words). */
const MIN_SECRET_LENGTH = 8;
/** A line that starts or ends with at least this many characters of a known secret has them masked. */
const MIN_FRAGMENT = 6;
const ELLIPSIS = "\u2026";
const PRE_CUT_FACTOR = 8;

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const ANSI_OTHER = /\x1b[@-_]?/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

const MIXED_CASE_DIGIT = (s: string) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);

/** Generic secret patterns, applied in this order after the known secrets. */
const PATTERNS: readonly [RegExp, string | ((match: string, ...groups: string[]) => string)][] = [
  // Credentials in a URL: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, `$1${REDACTED}@`],
  // Tailscale keys.
  [/\btskey-[A-Za-z0-9-]+/g, `tskey-${REDACTED}`],
  // Authorization header values: everything after the name.
  [/\b(authorization)(\s*[:=]\s*).*$/gi, `$1$2${REDACTED}`],
  [/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`],
  // Command-line flags carrying a secret: --api-key VALUE, --token=VALUE.
  [/(--(?:api[_-]?key|access[_-]?key|token|password|passwd|secret|auth[_-]?key)(?:=|\s+))(\S+)/gi, `$1${REDACTED}`],
  // name=value / name: value for secret-looking names (API_KEY=, AGENT_TOKEN=, X-Amz-Signature=, "password": ...).
  [
    /\b([\w.-]*?(?:api[_-]?key|access[_-]?key|auth[_-]?key|authkey|token|secret|password|passwd|pwd|signature|credential))(["']?\s*[=:]\s*["']?)([^\s"'&,;]+)/gi,
    `$1$2${REDACTED}`,
  ],
  // Long hex strings (tokens, keys; also full commit and image digests, an accepted loss).
  [/\b[0-9a-fA-F]{32,}\b/g, "[hex]"],
  // Long base64/base64url strings that mix upper case, lower case and digits.
  [/(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{40,}={0,2}/g, (m: string) => (MIXED_CASE_DIGIT(m) ? REDACTED : m)],
  [/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={1,2}/g, (m: string) => (MIXED_CASE_DIGIT(m) ? REDACTED : m)],
];

/** One raw log line made safe to display: last \r segment, no escape sequences or control characters. */
export function normalizeLine(raw: string): string {
  const segments = raw.split("\r");
  let text = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]!.trim() !== "") {
      text = segments[i]!;
      break;
    }
  }
  return text
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OTHER, "")
    .replace(/\t/g, " ")
    .replace(CONTROL, "")
    .trimEnd();
}

/**
 * Mask one line: every known secret (longest first), a known secret's head at the end of the
 * line or its tail at the start (a secret split across two lines or cut by a partial read), then
 * the generic patterns. Never throws.
 */
export function maskLine(line: string, secrets: readonly string[]): string {
  let out = line;
  const known = [...new Set(secrets)].filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LENGTH);
  known.sort((a, b) => b.length - a.length);
  for (const s of known) if (out.includes(s)) out = out.split(s).join(REDACTED);
  for (const s of known) {
    for (let k = Math.min(s.length - 1, out.length); k >= MIN_FRAGMENT; k--) {
      if (out.endsWith(s.slice(0, k))) {
        out = out.slice(0, out.length - k) + REDACTED;
        break;
      }
    }
    for (let k = Math.min(s.length - 1, out.length); k >= MIN_FRAGMENT; k--) {
      if (out.startsWith(s.slice(s.length - k))) {
        out = REDACTED + out.slice(k);
        break;
      }
    }
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out;
}

/** Cut a (masked) line to `max` characters, marking the cut; never splits a surrogate pair. */
export function truncateLine(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + ELLIPSIS;
}

/**
 * The complete lines of a log download. A last line without its newline is dropped: it is still
 * being written or was cut by the size cap, and comes back whole on the next read.
 */
export function logLines(text: string): string[] {
  const parts = text.split("\n");
  parts.pop(); // the text after the last newline (empty when the text ends with one)
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------------------------

export interface ConsoleLimits {
  maxLines: number;
  maxLineChars: number;
  /** Lines one vast_logs tail may have (BOOT_LOG_TAIL_LINES); the previous tail is kept whole. */
  tailLines: number;
}

export interface ConsoleSince {
  lines: ConsoleLine[];
  last_seq: number;
  /** Lines between `after` and the first returned one were dropped by the ring. */
  truncated: boolean;
}

/** The persisted form (version 1). Every text in it is already masked. */
interface ConsoleState {
  version: 1;
  generation: number;
  owner: string | null;
  ended: boolean;
  ended_reason: string | null;
  last_seq: number;
  dropped: boolean;
  lines: ConsoleLine[];
  /** Per source: the previous vast_logs tail, the recent vast_status lines, the last agent line. */
  recent: Record<ConsoleSource, string[]>;
  /** Index into BOOT_STEPS of the latest step marker (-1: none) and the FAILED code after it. */
  step: number;
  failed: string | null;
  vast_status: string | null;
}

export class ConsoleCorruptError extends Error {
  constructor(message: string) {
    super(`boot console state is invalid: ${message}`);
    this.name = "ConsoleCorruptError";
  }
}

function emptyRecent(): Record<ConsoleSource, string[]> {
  return { vast_status: [], vast_logs: [], agent: [] };
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** True when `inner` occurs as one contiguous block inside `outer`. */
function containsBlock(outer: readonly string[], inner: readonly string[]): boolean {
  if (inner.length === 0) return true;
  for (let start = 0; start + inner.length <= outer.length; start++) {
    let ok = true;
    for (let i = 0; i < inner.length; i++) {
      if (outer[start + i] !== inner[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** The longest k such that the last k lines of `prev` equal the first k lines of `next`. */
function overlap(prev: readonly string[], next: readonly string[]): number {
  for (let k = Math.min(prev.length, next.length); k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== next[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return 0;
}

export class ConsoleBuffer {
  private state: ConsoleState;
  private dirty = false;

  /**
   * `secrets` returns the known secret values at the time of the call; `clock` is epoch seconds.
   * Pass `state` (from toJSON) to restore; it is validated and clamped to the limits.
   */
  constructor(
    private readonly limits: ConsoleLimits,
    private readonly secrets: () => readonly string[],
    private readonly clock: () => number,
    state?: unknown,
  ) {
    if (!isCount(limits.maxLines) || limits.maxLines < 1) throw new Error("maxLines must be a positive integer");
    if (!isCount(limits.maxLineChars) || limits.maxLineChars < 2) throw new Error("maxLineChars must be an integer >= 2");
    if (!isCount(limits.tailLines) || limits.tailLines < 1) throw new Error("tailLines must be a positive integer");
    this.state = state === undefined ? ConsoleBuffer.empty() : this.restore(state);
  }

  static fromJSON(
    data: unknown,
    limits: ConsoleLimits,
    secrets: () => readonly string[],
    clock: () => number,
  ): ConsoleBuffer {
    return new ConsoleBuffer(limits, secrets, clock, data);
  }

  private static empty(): ConsoleState {
    return {
      version: 1,
      generation: 0,
      owner: null,
      ended: false,
      ended_reason: null,
      last_seq: 0,
      dropped: false,
      lines: [],
      recent: emptyRecent(),
      step: -1,
      failed: null,
      vast_status: null,
    };
  }

  /** Validate a persisted state strictly and clamp it to the current limits. Throws ConsoleCorruptError. */
  private restore(data: unknown): ConsoleState {
    const fail = (why: string): never => {
      throw new ConsoleCorruptError(why);
    };
    if (data === null || typeof data !== "object" || Array.isArray(data)) fail("not an object");
    const d = data as Record<string, unknown>;
    if (d["version"] !== 1) fail("unknown version");
    if (!isCount(d["generation"]) || !isCount(d["last_seq"])) fail("bad counters");
    if (d["owner"] !== null && !isStr(d["owner"])) fail("bad owner");
    if (typeof d["ended"] !== "boolean" || typeof d["dropped"] !== "boolean") fail("bad flags");
    if (d["ended_reason"] !== null && !isStr(d["ended_reason"])) fail("bad ended_reason");
    if (d["failed"] !== null && !isStr(d["failed"])) fail("bad failed");
    if (d["vast_status"] !== null && !isStr(d["vast_status"])) fail("bad vast_status");
    const step = d["step"];
    if (typeof step !== "number" || !Number.isInteger(step) || step < -1 || step >= BOOT_STEPS.length) fail("bad step");
    if (!Array.isArray(d["lines"])) fail("bad lines");
    const lastSeq = d["last_seq"] as number;
    let prevSeq = 0;
    const lines: ConsoleLine[] = [];
    for (const raw of d["lines"] as unknown[]) {
      const l = raw as Record<string, unknown>;
      if (l === null || typeof l !== "object") fail("bad line");
      if (!isCount(l["seq"]) || (l["seq"] as number) <= prevSeq || (l["seq"] as number) > lastSeq) fail("bad seq");
      if (typeof l["t"] !== "number" || !Number.isFinite(l["t"])) fail("bad time");
      if (!SOURCES.includes(l["source"] as ConsoleSource) || !isStr(l["text"])) fail("bad line fields");
      prevSeq = l["seq"] as number;
      lines.push({
        seq: prevSeq,
        t: l["t"] as number,
        source: l["source"] as ConsoleSource,
        text: this.prepare(l["text"] as string),
      });
    }
    const recentRaw = d["recent"] as Record<string, unknown> | null;
    if (recentRaw === null || typeof recentRaw !== "object") fail("bad recent");
    const recent = emptyRecent();
    for (const s of SOURCES) {
      const list = recentRaw![s];
      if (!Array.isArray(list) || !list.every(isStr)) fail("bad recent list");
      recent[s] = (list as string[]).slice(-this.recentCap(s)).map((t) => this.prepare(t));
    }
    const kept = lines.slice(-this.limits.maxLines);
    return {
      version: 1,
      generation: d["generation"] as number,
      owner: d["owner"] as string | null,
      ended: d["ended"] as boolean,
      ended_reason: d["ended_reason"] as string | null,
      last_seq: lastSeq,
      dropped: (d["dropped"] as boolean) || kept.length < lines.length,
      lines: kept,
      recent,
      step: step as number,
      failed: d["failed"] as string | null,
      vast_status: d["vast_status"] as string | null,
    };
  }

  /** How many recent texts are remembered per source (all bounded by config). */
  private recentCap(source: ConsoleSource): number {
    if (source === "agent") return 1;
    // A vast_logs tail is kept whole for the overlap search; status lines up to the ring size.
    return source === "vast_logs" ? this.limits.tailLines : this.limits.maxLines;
  }

  /**
   * normalise -> mask -> cut. A very long raw line is first cut to PRE_CUT_FACTOR times the
   * limit (bounded masking work); the visible cut happens only after masking.
   */
  private prepare(raw: string): string {
    let text = normalizeLine(raw.length > this.preCut * 4 ? raw.slice(-this.preCut * 4) : raw);
    if (text.length > this.preCut) text = text.slice(0, this.preCut);
    return truncateLine(maskLine(text, this.secrets()), this.limits.maxLineChars);
  }

  private get preCut(): number {
    return this.limits.maxLineChars * PRE_CUT_FACTOR;
  }

  get generation(): number {
    return this.state.generation;
  }
  get owner(): string | null {
    return this.state.owner;
  }
  get ended(): boolean {
    return this.state.ended;
  }
  get endedReason(): string | null {
    return this.state.ended_reason;
  }
  get lastSeq(): number {
    return this.state.last_seq;
  }
  get vastStatus(): string | null {
    return this.state.vast_status;
  }

  /** Vast's actual_status of the owner instance (drives the image_pull phase). */
  setVastStatus(status: string | null): void {
    if (this.state.vast_status !== status) {
      this.state.vast_status = status;
      this.dirty = true;
    }
  }

  /** Start over for a new instance: no lines, no ended flag; sequence numbers keep counting. */
  reset(owner: string): void {
    const s = this.state;
    this.state = {
      ...ConsoleBuffer.empty(),
      generation: s.generation + 1,
      last_seq: s.last_seq,
      owner,
    };
    this.dirty = true;
  }

  /** The owner instance is gone; lines are kept so the page can show why. The first reason wins. */
  markEnded(reason: string): void {
    if (this.state.ended) return;
    this.state.ended = true;
    this.state.ended_reason = reason;
    this.dirty = true;
  }

  /**
   * Add lines from one source. vast_logs: `lines` is the whole tail just read; only lines after
   * its longest overlap with the previous tail are added, and a tail without any overlap is added
   * after a GAP_MARKER line. vast_status: a status snapshot; lines already seen recently are
   * skipped. agent: one summary line, skipped when equal to the previous one.
   */
  append(source: ConsoleSource, lines: readonly string[]): void {
    if (!SOURCES.includes(source)) throw new Error("unknown console source");
    const prepared = lines.map((l) => this.prepare(l)).filter((l) => l.trim() !== "");
    const recent = this.state.recent;
    let add: string[];
    if (source === "vast_logs") {
      const prev = recent.vast_logs;
      if (prepared.length === 0) return;
      if (prev.length === 0) add = prepared;
      // A shorter tail found inside the previous one is a stale read: nothing new.
      else if (prepared.length < prev.length && containsBlock(prev, prepared)) add = [];
      else {
        const k = overlap(prev, prepared);
        add = k === 0 ? [GAP_MARKER, ...prepared] : prepared.slice(k);
      }
      recent.vast_logs = prepared.slice(-this.recentCap("vast_logs"));
      this.dirty = true;
    } else if (source === "vast_status") {
      add = [];
      for (const text of prepared) {
        if (recent.vast_status.includes(text) || add.includes(text)) continue;
        add.push(text);
      }
      recent.vast_status = [...recent.vast_status, ...add].slice(-this.recentCap("vast_status"));
    } else {
      add = [];
      for (const text of prepared) {
        if (recent.agent[recent.agent.length - 1] === text) continue;
        add.push(text);
        recent.agent = [text];
      }
    }
    if (add.length === 0) return;
    const t = this.clock();
    for (const text of add) {
      this.state.last_seq += 1;
      this.state.lines.push({ seq: this.state.last_seq, t, source, text });
      if (source === "vast_logs") this.observeMarker(text);
    }
    const over = this.state.lines.length - this.limits.maxLines;
    if (over > 0) {
      this.state.lines.splice(0, over);
      this.state.dropped = true;
    }
    this.dirty = true;
  }

  /** Track the boot step markers (the only text the phases are derived from). */
  private observeMarker(text: string): void {
    const step = STEP_MARKER.exec(text);
    if (step) {
      const index = BOOT_STEPS.findIndex((s) => s.id === step[3]);
      if (index >= 0) {
        this.state.step = index;
        this.state.failed = null;
      }
      return;
    }
    const failed = FAILED_MARKER.exec(text);
    if (failed) this.state.failed = failed[1]!;
  }

  /** Lines with seq > after (re-masked with the secrets known now). */
  since(after: number): ConsoleSince {
    const secrets = this.secrets();
    const lines = this.state.lines
      .filter((l) => l.seq > after)
      .map((l) => ({ ...l, text: maskLine(l.text, secrets) }));
    const first = this.state.lines[0];
    const truncated = this.state.dropped && first !== undefined && after < first.seq - 1;
    return { lines, last_seq: this.state.last_seq, truncated };
  }

  /** The fixed phase list with a status each, from the step markers and Vast's status only. */
  phases(): PhaseInfo[] {
    const { step, failed, vast_status: vast } = this.state;
    const lastStep = BOOT_STEPS.length - 1;
    const pull: PhaseStatus =
      step >= 0 || vast === VAST_RUNNING ? "done" : vast === VAST_LOADING ? "running" : "pending";
    const statuses: PhaseStatus[] = [pull];
    BOOT_STEPS.forEach((_s, i) => {
      if (step < 0 || i > step) statuses.push("pending");
      else if (i < step || step === lastStep) statuses.push("done");
      else statuses.push("running");
    });
    if (failed !== null) {
      // The phase in progress failed; with none in progress, the first one not done.
      let at = statuses.indexOf("running");
      if (at < 0) at = statuses.indexOf("pending");
      if (at >= 0) statuses[at] = "failed";
    }
    return BOOT_PHASES.map((p, i) => ({ id: p.id, name: p.name, status: statuses[i]! }));
  }

  /** True once since the last call when something changed (the caller persists then). */
  takeDirty(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  toJSON(): ConsoleState {
    return structuredClone(this.state);
  }
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

export interface ConsoleStoreLike {
  /** The saved state, or null when there is none or it cannot be used. Never throws. */
  load(): unknown;
  /** Save atomically. May throw; callers treat persistence as best effort. */
  save(state: unknown): void;
}

/** One JSON file (BOOT_LOG_PATH), written atomically (temp file + rename, mode 600). */
export class ConsoleStore implements ConsoleStoreLike {
  constructor(
    private readonly filePath: string,
    /** A larger file is ignored on load (it cannot have been written by this code with these limits). */
    private readonly maxFileBytes: number,
  ) {
    if (filePath === "") throw new Error("BOOT_LOG_PATH is not configured");
  }

  load(): unknown {
    try {
      if (!existsSync(this.filePath)) return null;
      if (statSync(this.filePath).size > this.maxFileBytes) return null;
      return JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      return null;
    }
  }

  save(state: unknown): void {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text, "utf8") > this.maxFileBytes) throw new Error("boot console state is larger than allowed");
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${basename(this.filePath)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, text + "\n", { mode: 0o600 });
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
}

/** Upper bound of the persisted file for these limits (each character may take 6 bytes as JSON). */
export function consoleFileCap(limits: ConsoleLimits): number {
  const texts = 2 * limits.maxLines + limits.tailLines + 1;
  const perLine = limits.maxLineChars * 6 + 128;
  return texts * perLine + 4096;
}
