/** Remembers delivery ids so a redelivered webhook is a no-op (spec §8.6 step 2). */
export interface DeliveryDedupe {
  /** Records `key` and returns true the first time it is seen; false for every repeat. Must be atomic. */
  claim(key: string): Promise<boolean>;
}

/**
 * The in-process default: a bounded map with a time-to-live. It covers Slack's retry window (minutes) in a
 * long-lived server. A deployment that runs several instances should pass a shared store; the ask CAS still
 * guarantees one answer, the shared dedupe only saves duplicate replies to the user.
 */
export function memoryDedupe(opts: { ttlMs?: number; max?: number; now?: () => number } = {}): DeliveryDedupe {
  const ttl = opts.ttlMs ?? 60 * 60_000;
  const max = opts.max ?? 10_000;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number>();
  return {
    async claim(key) {
      const at = now();
      const previous = seen.get(key);
      if (previous !== undefined && at - previous < ttl) return false;
      seen.delete(key);
      seen.set(key, at);
      // Map iteration is insertion order, so the first keys are the oldest.
      for (const [k, t] of seen) {
        if (seen.size <= max && at - t < ttl) break;
        seen.delete(k);
      }
      return true;
    },
  };
}
