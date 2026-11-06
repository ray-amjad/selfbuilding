import type { AskRecord, AskResolution, AskSpec, AskStore, ThreadKey } from "@selfbuilding/core";

// The spec may hold a schema with functions, which structuredClone refuses; everything else is copied.
const clone = (r: AskRecord): AskRecord => ({
  ...structuredClone({ ...r, spec: undefined }),
  spec: r.spec,
});

/** An in-memory AskStore with the CAS the spec requires. Counts resolve calls for assertions. */
export function memoryAskStore(): AskStore & { records: Map<string, AskRecord>; resolveCalls: number } {
  const records = new Map<string, AskRecord>();
  const store = {
    records,
    resolveCalls: 0,
    async create(r: AskRecord) {
      const existing = records.get(r.askId);
      if (existing) return { status: "exists" as const, record: clone(existing) };
      records.set(r.askId, clone(r));
      return { status: "created" as const };
    },
    async get(askId: string) {
      const r = records.get(askId);
      return r ? clone(r) : null;
    },
    async resolve(askId: string, res: AskResolution) {
      store.resolveCalls += 1;
      const r = records.get(askId);
      if (!r) throw new Error(`no ask ${askId}`);
      if (r.status !== "open") return { won: false as const, current: clone(r) };
      r.status = "answered";
      r.resolution = structuredClone(res);
      return { won: true as const };
    },
    async openForThread(thread: ThreadKey) {
      return [...records.values()]
        .filter(
          (r) =>
            r.status === "open" &&
            r.messages.some((m) => m.thread.channel === thread.channel && m.thread.id === thread.id),
        )
        .map((r) => clone(r));
    },
    async *open(filter: { channel?: string; runId?: string }) {
      for (const r of records.values()) {
        if (r.status !== "open") continue;
        if (filter.runId && r.runId !== filter.runId) continue;
        if (filter.channel && !r.messages.some((m) => m.channel === filter.channel)) continue;
        yield clone(r);
      }
    },
    async setStatus(askId: string, s: "expired" | "cancelled") {
      const r = records.get(askId);
      if (r) r.status = s;
    },
  };
  return store;
}

let seq = 0;

export function askRecord(spec: AskSpec, over: Partial<AskRecord> = {}): AskRecord {
  seq += 1;
  const askId = over.askId ?? `ask_${String(seq).padStart(20, "0")}`;
  return {
    askId,
    runId: "run_test",
    ordinal: seq,
    callPath: "factory#0",
    origin: { kind: "factory", askSeq: seq },
    specHash: `hash${seq}`,
    spec,
    status: "open",
    waitpoint: { host: "node", ref: askId },
    messages: [],
    createdAt: "2026-11-01T10:00:00.000Z",
    expiresAt: "2026-11-01T14:00:00.000Z",
    ...over,
  };
}
