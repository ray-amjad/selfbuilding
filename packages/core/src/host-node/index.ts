import type { Json } from "../types/common.js";
import type { CallbackTarget, DurableHost, FactoryRef, LaunchId, StepOpts } from "../types/host.js";
import type { JournalEntry, JournalStore, Lease } from "../types/orchestration.js";

export { fileArtifactStore, fileResultStore, memoryArtifactStore, memoryResultStore } from "./stores.js";

/**
 * How the plain Node host waits on a launch: a poll loop over `selfbuilding-runtime wait` (spec §6.6), registered by
 * the agent call that owns the launch. There is no inbound port and no callback target on this host.
 */
export type LaunchPoller = (signal: AbortSignal) => Promise<Json>;

const pollers = new Map<string, LaunchPoller>();

/** Registers the poller `waitForCallback(launchId)` runs. Returns a function that removes it. */
export function registerLaunchPoller(launchId: string, poll: LaunchPoller): () => void {
  pollers.set(launchId, poll);
  return () => {
    if (pollers.get(launchId) === poll) pollers.delete(launchId);
  };
}

export interface NodeHostOptions {
  /** The local journal. Without one, steps are memoised for this process only. */
  journal?: JournalStore;
  runId?: string;
  /** Required with `journal`: every write is fenced by it (spec §7.5.4). */
  lease?: Lease;
  epoch?: number;
}

/** The built-in plain Node host (spec §7.5.4). Internal: `run()` uses it when no other host is driving. */
export function nodeHost(opts: NodeHostOptions = {}): DurableHost {
  const memo = new Map<string, Json>();
  const runId = opts.runId ?? "standalone";

  const journaled = async <T extends Json>(key: string, fn: () => Promise<T>, o?: StepOpts): Promise<T> => {
    const journal = opts.journal as JournalStore;
    const lease = opts.lease as Lease;
    const existing = await journal.get(runId, key);
    if (existing?.status === "ok") return existing.value as T;
    const base: JournalEntry = {
      runId,
      stepKey: key,
      callPath: o?.callPath ?? key,
      kind: (o?.kind as JournalEntry["kind"] | undefined) ?? "step",
      status: "started",
      launchId: `${key}_e${opts.epoch ?? 0}_l0`,
      attempt: (existing?.attempt ?? 0) + 1,
      startedAt: new Date().toISOString(),
    };
    await journal.put(base, { lease, expectStatus: existing ? existing.status : null });
    try {
      const value = await fn();
      await journal.put(
        { ...base, status: "ok", value, finishedAt: new Date().toISOString() },
        { lease, expectStatus: "started" },
      );
      return value;
    } catch (error) {
      await journal.put(
        { ...base, status: "failed", finishedAt: new Date().toISOString() },
        { lease, expectStatus: "started" },
      );
      throw error;
    }
  };

  return {
    id: "node",
    limits: { maxStepOutputBytes: 262_144, parallelWaits: true },
    epoch: opts.epoch ?? 0,

    async step<T extends Json>(key: string, fn: () => Promise<T>, o?: StepOpts): Promise<T> {
      if (opts.journal && opts.lease) return journaled(key, fn, o);
      if (memo.has(key)) return memo.get(key) as T;
      const value = await fn();
      memo.set(key, value);
      return value;
    },

    async waitForCallback<T extends Json>(
      launchId: LaunchId,
      o: { timeoutMs: number; rearm: number; register: (target: CallbackTarget) => Promise<void> },
    ): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" }> {
      const poll = pollers.get(launchId);
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<{ ok: false; reason: "timeout" }>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ ok: false, reason: "timeout" });
        }, o.timeoutMs);
      });
      try {
        if (!poll) return await timeout;
        return await Promise.race([
          poll(controller.signal).then((value) => ({ ok: true as const, value: value as T })),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },

    async sleep(_key, ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },

    all: (branches) => Promise.all(branches.map((b) => b())),

    async child<I, O>(_key: string, factory: FactoryRef<I, O>, input: I): Promise<O> {
      return factory.factory(input);
    },
  };
}
