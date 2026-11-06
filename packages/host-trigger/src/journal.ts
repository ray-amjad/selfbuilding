import {
  type AskRecord,
  type AskResolution,
  type AskStore,
  ConfigError,
  type Duration,
  type JournalEntry,
  type JournalStore,
  type Json,
  type Lease,
  LeaseLostError,
  type ResultStore,
  type StepOpts,
  type ThreadKey,
} from "@selfbuilding/core";
import { durationMs, storeKeys, unsafeSegment } from "./keys.js";
import { updateCas } from "./store.js";

// The Trigger host's one durability system: the host step memo and the journal are the same records in the
// result store (spec §7.1, §7.10). Inside an epoch, a step reads its epoch record; a new epoch reads only the
// success cache, so a failure is never served across a resume (spec §7.6).

export type RunRecord = {
  epoch: number;
  /** Every Trigger parent run that drove this run, oldest first. */
  hostRunIds: string[];
  status: "running" | "ok" | "partial" | "failed" | "cancelled" | (string & {});
  factory: string;
  updatedAt: string;
};

function asJson(value: unknown): Json {
  return value as Json;
}

/** Agent outcomes are values: `{ ok: false }` is a failure even though the step itself returned. */
export function isSuccessEntry(entry: Pick<JournalEntry, "status" | "kind" | "value">): boolean {
  if (entry.status !== "ok") return false;
  if (entry.kind !== "agent") return true;
  const value = entry.value as { ok?: unknown } | null | undefined;
  return !(typeof value === "object" && value !== null && value.ok === false);
}

const STEP_KINDS = new Set<JournalEntry["kind"]>(["agent", "step", "exec", "sandbox", "clock", "charge", "run"]);

function kindOf(opts?: StepOpts): JournalEntry["kind"] {
  const kind = opts?.kind as JournalEntry["kind"] | undefined;
  return kind && STEP_KINDS.has(kind) ? kind : "step";
}

/** Reads and writes one run's step records for one epoch. */
export class StepMemo {
  constructor(
    private readonly store: ResultStore,
    readonly runId: string,
    readonly epoch: number,
    private readonly now: () => number,
  ) {}

  async read(key: string): Promise<{ value: Json } | null> {
    const own = await this.store.get<JournalEntry & { [k: string]: Json }>(
      storeKeys.accepted(this.runId, this.epoch, key),
    );
    if (own && own.status === "ok") return { value: (own.value ?? null) as Json };
    const cached = await this.store.get<JournalEntry & { [k: string]: Json }>(storeKeys.cache(this.runId, key));
    if (cached && isSuccessEntry(cached)) return { value: (cached.value ?? null) as Json };
    return null;
  }

  /** Create-if-absent: when two attempts race, the first write wins and both use its value. */
  async write(key: string, value: Json, opts?: StepOpts): Promise<Json> {
    const at = new Date(this.now()).toISOString();
    const entry: JournalEntry = {
      runId: this.runId,
      stepKey: key,
      callPath: opts?.callPath ?? key,
      kind: kindOf(opts),
      status: "ok",
      launchId: "",
      value,
      attempt: 0,
      startedAt: at,
      finishedAt: at,
    };
    const won = await this.store.createIfAbsent(storeKeys.accepted(this.runId, this.epoch, key), asJson(entry));
    const stored = won
      ? entry
      : await this.store.get<JournalEntry & { [k: string]: Json }>(storeKeys.accepted(this.runId, this.epoch, key));
    const final = (stored ?? entry) as JournalEntry;
    if (isSuccessEntry(final)) await this.store.createIfAbsent(storeKeys.cache(this.runId, key), asJson(final));
    return (final.value ?? null) as Json;
  }
}

export async function readRunRecord(store: ResultStore, runId: string): Promise<RunRecord | null> {
  return store.get<RunRecord>(storeKeys.run(runId));
}

/**
 * A `JournalStore` over the result store: the host memo reader that `reap()` and `run()` see on Trigger.dev.
 * Entries live where the host step memo writes them, so there is no second journal.
 */
export function resultStoreJournal(
  store: ResultStore,
  opts: { now?: () => number; asks?: AskStore } = {},
): JournalStore {
  const now = opts.now ?? Date.now;
  const epochOf = async (runId: string) => (await readRunRecord(store, runId))?.epoch ?? 0;

  const journal: JournalStore = {
    async get(runId, stepKey) {
      const epoch = await epochOf(runId);
      const own = await store.get<JournalEntry & { [k: string]: Json }>(storeKeys.accepted(runId, epoch, stepKey));
      if (own) return own;
      const cached = await store.get<JournalEntry & { [k: string]: Json }>(storeKeys.cache(runId, stepKey));
      return cached && isSuccessEntry(cached) ? cached : null;
    },
    async *list(runId) {
      const epoch = await epochOf(runId);
      const seen = new Set<string>();
      for await (const key of store.list(storeKeys.acceptedPrefix(runId, epoch))) {
        const entry = await store.get<JournalEntry & { [k: string]: Json }>(key);
        if (!entry) continue;
        seen.add(entry.stepKey);
        yield entry;
      }
      for await (const key of store.list(storeKeys.cachePrefix(runId))) {
        const name = unsafeSegment(key.slice(storeKeys.cachePrefix(runId).length, -".json".length));
        if (seen.has(name)) continue;
        const entry = await store.get<JournalEntry & { [k: string]: Json }>(key);
        if (entry && isSuccessEntry(entry)) yield entry;
      }
    },
    async lease(runId, owner, ttl: Duration) {
      const key = storeKeys.lease(runId);
      const ttlMs = durationMs(ttl);
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = await store.getVersioned<LeaseRow>(key);
        if (current && current.value.owner !== owner && Date.parse(current.value.expiresAt) > now()) return null;
        const next: LeaseRow = {
          runId,
          owner,
          leaseEpoch: (current?.value.leaseEpoch ?? 0) + 1,
          expiresAt: new Date(now() + ttlMs).toISOString(),
          ttlMs,
        };
        if (await store.replace(key, next, current?.version ?? null)) return next;
      }
      return null;
    },
    async renew(lease) {
      const runId = leaseRunId(lease);
      if (runId === null) return null;
      const next = await updateCas<LeaseRow>(store, storeKeys.lease(runId), (current) => {
        if (!current || current.leaseEpoch !== lease.leaseEpoch || current.owner !== lease.owner) return undefined;
        return { ...current, expiresAt: new Date(now() + current.ttlMs).toISOString() };
      });
      return next && next.leaseEpoch === lease.leaseEpoch && next.owner === lease.owner ? next : null;
    },
    // A finished run hands its lease back at once, so resuming the run id (the next epoch) need not wait out the TTL.
    async release(lease) {
      const runId = leaseRunId(lease);
      if (runId === null) return;
      await updateCas<LeaseRow>(store, storeKeys.lease(runId), (current) => {
        if (!current || current.leaseEpoch !== lease.leaseEpoch || current.owner !== lease.owner) return undefined;
        return { ...current, expiresAt: new Date(0).toISOString() };
      });
    },
    async assertLease(lease) {
      const runId = leaseRunId(lease);
      const current = runId === null ? null : await store.get<LeaseRow>(storeKeys.lease(runId));
      if (!current || current.leaseEpoch !== lease.leaseEpoch || current.owner !== lease.owner) {
        throw new LeaseLostError();
      }
    },
    async put(entry, { lease, expectStatus }) {
      await journal.assertLease(lease);
      const epoch = await epochOf(entry.runId);
      const key = storeKeys.accepted(entry.runId, epoch, entry.stepKey);
      const current = await store.getVersioned<JournalEntry & { [k: string]: Json }>(key);
      if (expectStatus === null && current) return false;
      if (expectStatus !== undefined && expectStatus !== null) {
        // The status the caller saw may come from an earlier epoch's cached success, as get() and list() show it.
        const seen = current?.value ?? (await journal.get(entry.runId, entry.stepKey));
        if (seen?.status !== expectStatus) return false;
      }
      if (!(await store.replace(key, asJson(entry), current?.version ?? null))) return false;
      if (isSuccessEntry(entry)) await store.createIfAbsent(storeKeys.cache(entry.runId, entry.stepKey), asJson(entry));
      return true;
    },
    ...(opts.asks ? { asks: opts.asks } : {}),
  };
  return journal;
}

type LeaseRow = { runId: string; owner: string; leaseEpoch: number; expiresAt: string; ttlMs: number };

/** Leases from this journal carry their run id, so `renew` and `assertLease` find the record. */
function leaseRunId(lease: Lease): string | null {
  const runId = (lease as Lease & { runId?: unknown }).runId;
  return typeof runId === "string" ? runId : null;
}

/**
 * An `AskStore` in the same result store, so the hooks handler, the parent scheduler and the agent child all read
 * one record per ask. `resolve` is a compare-and-set on `status: "open"`.
 */
export function resultStoreAsks(store: ResultStore): AskStore {
  async function* all(): AsyncIterable<AskRecord> {
    for await (const key of store.list(storeKeys.askPrefix())) {
      const record = await store.get<AskRecord & { [k: string]: Json }>(key);
      if (record) yield record;
    }
  }
  return {
    async create(record) {
      if (await store.createIfAbsent(storeKeys.ask(record.askId), asJson(record))) return { status: "created" };
      const existing = await store.get<AskRecord & { [k: string]: Json }>(storeKeys.ask(record.askId));
      return { status: "exists", record: existing ?? record };
    },
    async get(askId) {
      return store.get<AskRecord & { [k: string]: Json }>(storeKeys.ask(askId));
    },
    async resolve(askId, res: AskResolution) {
      let current: AskRecord | null = null;
      let won = false;
      await updateCas<AskRecord & { [k: string]: Json }>(store, storeKeys.ask(askId), (record) => {
        current = record;
        if (record?.status !== "open") {
          won = false;
          return undefined;
        }
        won = true;
        return { ...record, status: "answered", resolution: res } as AskRecord & { [k: string]: Json };
      });
      if (won) return { won: true };
      if (!current) throw new ConfigError(`Ask ${askId} does not exist in the ask store; it cannot be answered.`);
      return { won: false, current };
    },
    async openForThread(thread: ThreadKey) {
      const out: AskRecord[] = [];
      for await (const record of all()) {
        if (record.status !== "open") continue;
        if (record.messages.some((m) => m.thread.channel === thread.channel && m.thread.id === thread.id)) {
          out.push(record);
        }
      }
      return out;
    },
    async *open(filter) {
      for await (const record of all()) {
        if (record.status !== "open") continue;
        if (filter.runId !== undefined && record.runId !== filter.runId) continue;
        if (filter.channel !== undefined && !record.messages.some((m) => m.channel === filter.channel)) continue;
        yield record;
      }
    },
    async setStatus(askId, status) {
      await updateCas<AskRecord & { [k: string]: Json }>(store, storeKeys.ask(askId), (record) => {
        if (record?.status !== "open") return undefined;
        return { ...record, status } as AskRecord & { [k: string]: Json };
      });
    },
    async patch(askId, p) {
      await updateCas<AskRecord & { [k: string]: Json }>(store, storeKeys.ask(askId), (record) => {
        if (!record) return undefined;
        const next = { ...record } as AskRecord & { [k: string]: Json };
        if (p.messages) {
          const id = (m: { channel: string; id: string }) => `${m.channel}|${m.id}`;
          const seen = new Set(record.messages.map(id));
          next.messages = [...record.messages, ...p.messages.filter((m) => !seen.has(id(m)))];
        }
        if (p.reconciledAt !== undefined) next.reconciledAt = p.reconciledAt;
        return next;
      });
    },
    async *list(filter) {
      for await (const record of all()) if (record.runId === filter.runId) yield record;
    },
    // Compare-and-set on status "open", as the file ask store does, so a Trigger restart reads `cold` exactly as
    // plain Node does (demo-path §6). An ask that already settled comes back unchanged.
    async markCold(askId, cold) {
      let after: AskRecord | null = null;
      await updateCas<AskRecord & { [k: string]: Json }>(store, storeKeys.ask(askId), (record) => {
        after = record;
        if (record?.status !== "open") return undefined;
        const next = { ...record, cold } as AskRecord & { [k: string]: Json };
        after = next;
        return next;
      });
      return after;
    },
  };
}

/**
 * Points an open ask's waitpoint at the token its waiter holds now, so the next answer completes that token. False
 * when the ask is not open in this store (settled, or kept in another ask store).
 */
export async function rotateAskWaitpoint(store: ResultStore, askId: string, ref: string): Promise<boolean> {
  let moved = false;
  await updateCas<AskRecord & { [k: string]: Json }>(store, storeKeys.ask(askId), (record) => {
    moved = record?.status === "open" && record.waitpoint.host === "trigger";
    if (!moved || record?.waitpoint.ref === ref) return undefined;
    return { ...record, waitpoint: { ...record?.waitpoint, ref } } as AskRecord & { [k: string]: Json };
  });
  return moved;
}
