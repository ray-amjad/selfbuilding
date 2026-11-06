import { internalNow, randomBytes } from "../engine/hash.js";

const WINDOW_MS = 60_000;

/**
 * At most `perMinute` sandbox creates in any 60 s window, per provider (spec §9.6 rule 8). Exec is never
 * limited or retried here; only creates are.
 */
export class CreateRateLimiter {
  private readonly stamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly perMinute: number,
    private readonly clock: { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> } = {
      now: internalNow,
      sleep: abortableSleep,
    },
  ) {}

  /** Waits for a create token. Calls are served in order. */
  take(signal?: AbortSignal): Promise<void> {
    const turn = this.queue.then(() => this.waitForToken(signal));
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async waitForToken(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const now = this.clock.now();
      while (this.stamps.length > 0 && (this.stamps[0] as number) <= now - WINDOW_MS) this.stamps.shift();
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        return;
      }
      await this.clock.sleep((this.stamps[0] as number) + WINDOW_MS - now, signal);
    }
  }
}

/** The create limit: `concurrency.createsPerMinute` may only lower the provider's limit; otherwise 10. */
export function effectiveCreatesPerMinute(explicit: number | undefined, providerLimit: number | undefined): number {
  if (explicit !== undefined && providerLimit !== undefined) return Math.min(explicit, providerLimit);
  return explicit ?? providerLimit ?? 10;
}

/** Full-jitter backoff for rate-limited creates: uniform in [0, min(cap, base * 2^attempt)). */
export function createBackoffMs(attempt: number, opts: { baseMs?: number; capMs?: number } = {}): number {
  const ceiling = Math.min(opts.capMs ?? 30_000, (opts.baseMs ?? 500) * 2 ** Math.max(0, attempt));
  const bytes = randomBytes(4);
  const fraction = new DataView(bytes.buffer).getUint32(0) / 0x100000000;
  return Math.floor(fraction * ceiling);
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
