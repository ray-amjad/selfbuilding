import type { Duration } from "@selfbuilding/core";

/** Single-quotes a value for `/bin/sh`. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Resolves after `ms`, or rejects early with the signal's reason. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Full-jitter backoff, `rand × min(cap, base × 2^attempt)` (spec §5.4 invariant 13). */
export function backoff(attempt: number, baseMs: number, capMs: number): number {
  return Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
}

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function durationMs(value: Duration): number {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value);
  if (!match) throw new TypeError(`Invalid duration "${value}". Use a number of milliseconds or e.g. "45m", "2h".`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

// Variable names that carry credentials. Secrets reach a box only as 0600 files (invariant 18).
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|AUTH)($|_)/i;

export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Keeps the last `limit` bytes of a stream without ever joining the whole stream (invariant 10). */
export class Tail {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(text: string): void {
    const chunk = Buffer.from(text, "utf8");
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#limit && this.#chunks.length > 0) {
      const first = this.#chunks[0] as Buffer;
      const excess = this.#size - this.#limit;
      this.truncated = true;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#size -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#size -= excess;
      }
    }
  }

  toString(): string {
    const text = Buffer.concat(this.#chunks).toString("utf8");
    // A cut can land inside a multi-byte character; drop the replacement characters it leaves at the front.
    return this.truncated ? text.replace(/^�+/, "") : text;
  }
}

/** Splits decoded text on "\n" only (never U+2028/U+2029) and reports each complete line as soon as it arrives. */
export class LineSplitter {
  readonly #onLine: (line: string) => void;
  #partial = "";

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  push(text: string): void {
    const parts = (this.#partial + text).split("\n");
    this.#partial = parts.pop() ?? "";
    for (const line of parts) this.#onLine(line);
  }

  end(): void {
    const rest = this.#partial;
    this.#partial = "";
    if (rest.length > 0) this.#onLine(rest);
  }
}
