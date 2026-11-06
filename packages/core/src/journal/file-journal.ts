import { fileAskStore } from "../ask/store.js";
import { parseDuration } from "../config/duration.js";
import { internalNow } from "../engine/hash.js";
import { ConfigError, JournalVersionError, LeaseLostError } from "../errors/classes.js";
import { fileResultStore } from "../host-node/stores.js";
import type { JournalEntry, JournalStore, Lease } from "../types/orchestration.js";
import { nodeFs, readJson, safeName, withLock, writeAtomic } from "./fs-util.js";
import { statusMatches } from "./memory.js";

/** The on-disk format this version reads and writes. */
export const JOURNAL_FORMAT = 1;

interface StoredLease extends Lease {
  ttlMs: number;
}

/**
 * Layout, one directory per run:
 *   runs/<runId>/format.json        {format}
 *   runs/<runId>/lease.json         the current lease, fenced by leaseEpoch
 *   runs/<runId>/entries/<key>.json the latest entry per step key
 *   asks/<askId>.json               the ask store (spec §8.3)
 *   results/                        outcome, fence and accept records (spec §7.10)
 * Every mutation happens under the run's mkdir lock, so `put` is a real compare-and-set across processes.
 */
export function createFileJournal(dir: string): JournalStore {
  if (typeof dir !== "string" || dir === "") throw new ConfigError("fileJournal(dir) needs a directory path.");
  let root: string | undefined;
  const resolveRoot = async () => {
    if (root === undefined) {
      const { path } = await nodeFs();
      root = path.resolve(dir);
    }
    return root;
  };
  const runDir = async (runId: string) => {
    const { path } = await nodeFs();
    return path.join(await resolveRoot(), "runs", safeName(runId));
  };
  const lockOf = async (runId: string) => {
    const { path } = await nodeFs();
    return path.join(await runDir(runId), ".lock");
  };
  const leaseFile = async (runId: string) => {
    const { path } = await nodeFs();
    return path.join(await runDir(runId), "lease.json");
  };
  const entryFile = async (runId: string, stepKey: string) => {
    const { path } = await nodeFs();
    return path.join(await runDir(runId), "entries", `${safeName(stepKey)}.json`);
  };

  const checkFormat = async (runId: string, create: boolean) => {
    const { path } = await nodeFs();
    const file = path.join(await runDir(runId), "format.json");
    const stored = await readJson<{ format: number }>(file);
    if (stored === null) {
      if (create) await writeAtomic(file, JSON.stringify({ format: JOURNAL_FORMAT }));
      return;
    }
    if (stored.format !== JOURNAL_FORMAT) {
      throw new JournalVersionError({ found: stored.format, supported: JOURNAL_FORMAT }, { runId });
    }
  };

  const holds = async (lease: Lease): Promise<StoredLease | null> => {
    if (lease.runId === undefined) throw new ConfigError("This lease was not issued by a journal (no runId).");
    const current = await readJson<StoredLease>(await leaseFile(lease.runId));
    return current && current.leaseEpoch === lease.leaseEpoch && current.owner === lease.owner ? current : null;
  };

  const publicLease = (stored: StoredLease): Lease => ({
    owner: stored.owner,
    leaseEpoch: stored.leaseEpoch,
    expiresAt: stored.expiresAt,
    ...(stored.runId === undefined ? {} : { runId: stored.runId }),
  });

  const store: JournalStore = {
    async get(runId, stepKey) {
      await checkFormat(runId, false);
      return readJson<JournalEntry>(await entryFile(runId, stepKey));
    },

    async *list(runId) {
      await checkFormat(runId, false);
      const { fs, path } = await nodeFs();
      const entriesDir = path.join(await runDir(runId), "entries");
      let names: string[];
      try {
        names = await fs.readdir(entriesDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const entries: JournalEntry[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const entry = await readJson<JournalEntry>(path.join(entriesDir, name));
        if (entry) entries.push(entry);
      }
      entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.stepKey.localeCompare(b.stepKey));
      yield* entries;
    },

    async lease(runId, owner, ttl) {
      const ttlMs = parseDuration(ttl, "lease ttl");
      await checkFormat(runId, true);
      return withLock(await lockOf(runId), async () => {
        const file = await leaseFile(runId);
        const current = await readJson<StoredLease>(file);
        const now = internalNow();
        const live = current !== null && Date.parse(current.expiresAt) > now;
        if (live && current.owner !== owner) return null;
        const next: StoredLease = {
          owner,
          leaseEpoch: live ? current.leaseEpoch : (current?.leaseEpoch ?? 0) + 1,
          expiresAt: new Date(now + ttlMs).toISOString(),
          runId,
          ttlMs,
        };
        await writeAtomic(file, JSON.stringify(next));
        return publicLease(next);
      });
    },

    async renew(lease) {
      if (lease.runId === undefined) return null;
      return withLock(await lockOf(lease.runId), async () => {
        const current = await holds(lease);
        if (!current) return null;
        const next: StoredLease = { ...current, expiresAt: new Date(internalNow() + current.ttlMs).toISOString() };
        await writeAtomic(await leaseFile(lease.runId as string), JSON.stringify(next));
        return publicLease(next);
      });
    },

    async assertLease(lease) {
      if (!(await holds(lease))) throw new LeaseLostError(undefined, { runId: lease.runId });
    },

    async put(entry, opts) {
      return withLock(await lockOf(entry.runId), async () => {
        if (opts.lease.runId !== entry.runId || !(await holds(opts.lease))) {
          throw new LeaseLostError(undefined, { runId: entry.runId, callPath: entry.callPath });
        }
        const file = await entryFile(entry.runId, entry.stepKey);
        const existing = await readJson<JournalEntry>(file);
        if (!statusMatches(existing, opts.expectStatus)) return false;
        await writeAtomic(file, JSON.stringify(entry));
        return true;
      });
    },

    async release(lease) {
      if (lease.runId === undefined) return;
      await withLock(await lockOf(lease.runId), async () => {
        const current = await holds(lease);
        if (!current) return;
        await writeAtomic(
          await leaseFile(lease.runId as string),
          JSON.stringify({ ...current, expiresAt: new Date(0).toISOString() }),
        );
      });
    },
  };

  const base = dir.replace(/[\\/]+$/, "");
  Object.defineProperty(store, "asks", { value: fileAskStore(`${base}/asks`), enumerable: true });
  Object.defineProperty(store, "results", { value: fileResultStore(`${base}/results`), enumerable: true });
  return store;
}
