import { parseDuration } from "../config/duration.js";
import { internalNow } from "../engine/hash.js";
import { ConfigError, LeaseLostError } from "../errors/classes.js";
import type { JournalEntry, JournalStore, Lease } from "../types/orchestration.js";

interface MemoryRun {
  lease: Lease | null;
  ttlMs: number;
  entries: Map<string, JournalEntry>;
}

/**
 * An in-process journal. `run()` uses it when no journal is configured, so primitives behave the same way,
 * but nothing survives the process and the run cannot be resumed.
 */
export function memoryJournal(): JournalStore {
  const runs = new Map<string, MemoryRun>();
  const runOf = (runId: string): MemoryRun => {
    let run = runs.get(runId);
    if (!run) {
      run = { lease: null, ttlMs: 60_000, entries: new Map() };
      runs.set(runId, run);
    }
    return run;
  };
  const holds = (lease: Lease): MemoryRun | null => {
    if (lease.runId === undefined) throw new ConfigError("This lease was not issued by this journal (no runId).");
    const run = runs.get(lease.runId);
    const current = run?.lease;
    return run && current && current.leaseEpoch === lease.leaseEpoch && current.owner === lease.owner ? run : null;
  };

  return {
    async get(runId, stepKey) {
      const entry = runs.get(runId)?.entries.get(stepKey);
      return entry ? structuredClone(entry) : null;
    },
    async *list(runId) {
      for (const entry of [...(runs.get(runId)?.entries.values() ?? [])]) yield structuredClone(entry);
    },
    async lease(runId, owner, ttl) {
      const run = runOf(runId);
      const now = internalNow();
      const current = run.lease;
      const live = current !== null && Date.parse(current.expiresAt) > now;
      if (live && current.owner !== owner) return null;
      run.ttlMs = parseDuration(ttl, "lease ttl");
      run.lease = {
        owner,
        leaseEpoch: live ? current.leaseEpoch : (current?.leaseEpoch ?? 0) + 1,
        expiresAt: new Date(now + run.ttlMs).toISOString(),
        runId,
      };
      return { ...run.lease };
    },
    async renew(lease) {
      const run = holds(lease);
      if (!run) return null;
      run.lease = { ...lease, expiresAt: new Date(internalNow() + run.ttlMs).toISOString() };
      return { ...run.lease };
    },
    async assertLease(lease) {
      if (!holds(lease)) throw new LeaseLostError(undefined, { runId: lease.runId });
    },
    async put(entry, opts) {
      if (!holds(opts.lease)) throw new LeaseLostError(undefined, { runId: entry.runId });
      const run = runOf(entry.runId);
      const existing = run.entries.get(entry.stepKey);
      if (!statusMatches(existing, opts.expectStatus)) return false;
      run.entries.set(entry.stepKey, structuredClone(entry));
      return true;
    },
    async release(lease) {
      const run = holds(lease);
      if (run?.lease) run.lease = { ...run.lease, expiresAt: new Date(0).toISOString() };
    },
  };
}

export function statusMatches(
  existing: JournalEntry | null | undefined,
  expect: JournalEntry["status"] | null | undefined,
): boolean {
  if (expect === undefined) return true;
  if (expect === null) return !existing;
  return existing?.status === expect;
}
