// Golden event streams (spec §10.3 L2): values that change between runs become placeholders. Ids keep their
// references (the first sandbox id seen is `<sandbox:1>` everywhere it appears); times, durations and USD amounts
// become plain markers, because numbering them would depend on timing.

/** Kinds of identifier that get numbered placeholders. */
export type GoldenIdKind = "run" | "sandbox" | "session" | "launch" | "ask" | "uuid" | "port";

export interface GoldenOptions {
  /** Extra keys whose values are identifiers, e.g. `{ boxId: "sandbox" }`. Merged over the defaults. */
  idKeys?: Record<string, GoldenIdKind>;
  /** Host paths that vary per run (a temp root); each becomes `<root>` wherever it appears. */
  roots?: string[];
  /** Keys dropped entirely, e.g. a sequence number you do not want in the file. */
  dropKeys?: string[];
}

const DEFAULT_ID_KEYS: Record<string, GoldenIdKind> = {
  runId: "run",
  run_id: "run",
  sandboxId: "sandbox",
  sandbox_id: "sandbox",
  sessionId: "session",
  session_id: "session",
  resumeSessionId: "session",
  thread_id: "session",
  threadId: "session",
  launchId: "launch",
  askId: "ask",
  port: "port",
};

const TIME_KEY = /^(at|ts|time|timestamp|date)$|At$|_at$/;
const DURATION_KEY = /duration|elapsed/i;
const USD_KEY = /^(costUsd|total_cost_usd|usd|spentUsd|budgetUsd|cost_usd)$|Usd$/;

const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LOCAL_PORT = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g;

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

class Registry {
  readonly #byValue = new Map<string, string>();
  readonly #counts = new Map<GoldenIdKind, number>();

  placeholder(kind: GoldenIdKind, value: string): string {
    const known = this.#byValue.get(value);
    if (known) return known;
    const n = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, n);
    const placeholder = `<${kind}:${n}>`;
    this.#byValue.set(value, placeholder);
    return placeholder;
  }

  /** Known values, longest first, so a value that contains another is replaced whole. */
  known(): [string, string][] {
    return [...this.#byValue.entries()]
      .filter(([value]) => value.length >= 4)
      .sort((a, b) => b[0].length - a[0].length);
  }
}

function parseInput(input: unknown[] | string): unknown[] {
  if (typeof input !== "string") return input;
  return input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** Normalises an event stream (an array, or JSONL text) into stable, reference-preserving values. */
export function normalizeEvents(input: unknown[] | string, opts: GoldenOptions = {}): unknown[] {
  const events = parseInput(input);
  const idKeys = { ...DEFAULT_ID_KEYS, ...opts.idKeys };
  const drop = new Set(opts.dropKeys ?? []);
  const registry = new Registry();

  // Pass 1, in document order: number every identifier found under an id key.
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const kind = idKeys[key];
        if (kind && (typeof child === "string" || typeof child === "number") && child !== "") {
          registry.placeholder(kind, String(child));
        } else {
          collect(child);
        }
      }
    }
  };
  collect(events);

  const roots = [...(opts.roots ?? [])].filter((r) => r.length > 0).sort((a, b) => b.length - a.length);
  const rewrite = (text: string): string => {
    let out = text;
    for (const root of roots) out = out.split(root).join("<root>");
    for (const [value, placeholder] of registry.known()) out = out.split(value).join(placeholder);
    out = out.replace(ISO_TIME, "<time>");
    out = out.replace(UUID, (uuid) => registry.placeholder("uuid", uuid.toLowerCase()));
    out = out.replace(LOCAL_PORT, (_m, host: string, port: string) => `${host}:${registry.placeholder("port", port)}`);
    return out;
  };

  const transform = (value: unknown, key?: string): Plain => {
    if (key !== undefined) {
      const kind = idKeys[key];
      if (kind && (typeof value === "string" || typeof value === "number") && value !== "") {
        return registry.placeholder(kind, String(value));
      }
      if (TIME_KEY.test(key) && (typeof value === "string" || typeof value === "number")) return "<time>";
      if (USD_KEY.test(key) && typeof value === "number") return "<usd>";
      if (DURATION_KEY.test(key) && typeof value === "number") return "<duration>";
    }
    if (typeof value === "string") return rewrite(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    if (value === undefined) return null;
    if (Array.isArray(value)) return value.map((item) => transform(item));
    if (typeof value === "object") {
      const out: { [key: string]: Plain } = {};
      // Sorted keys keep the file stable when an emitter reorders fields.
      for (const k of Object.keys(value).sort()) {
        if (drop.has(k)) continue;
        out[k] = transform((value as Record<string, unknown>)[k], k);
      }
      return out;
    }
    return String(value);
  };
  return events.map((event) => transform(event));
}

/**
 * A golden JSONL file body: one normalised event per line. Compare it with vitest, e.g.
 * `await expect(toGoldenJsonl(events)).toMatchFileSnapshot("__golden__/review.jsonl")`; update with `vitest -u`.
 */
export function toGoldenJsonl(input: unknown[] | string, opts?: GoldenOptions): string {
  return `${normalizeEvents(input, opts)
    .map((event) => JSON.stringify(event))
    .join("\n")}\n`;
}
