import type { BudgetLedger } from "../budget/ledger.js";
import { CreateRateLimiter, effectiveCreatesPerMinute } from "../budget/rate.js";
import type { SandboxSlots } from "../budget/slots.js";
import { JournalConflictError, LeaseLostError } from "../errors/classes.js";
import type { EmitInput, EventBus } from "../events/bus.js";
import type { ArtifactStore, Usage } from "../types/artifacts.js";
import type { HitlOptions, NotifyOptions } from "../types/ask.js";
import type { SelfbuildingConfig } from "../types/config.js";
import type { SelfbuildingEvent } from "../types/events.js";
import type { InterruptedPolicy, JournalEntry, JournalStore, Lease, RunOptions } from "../types/orchestration.js";
import type { SandboxProvider } from "../types/sandbox.js";
import type { FactoryFrame } from "./scope.js";

export interface RunStateInit {
  runId: string;
  factory: FactoryFrame;
  epoch: number;
  processEpoch: string;
  resumeId: string;
  config: SelfbuildingConfig;
  options: RunOptions;
  journal: JournalStore;
  lease: Lease;
  artifacts: ArtifactStore;
  events: EventBus;
  budget: BudgetLedger;
  slots: SandboxSlots;
  concurrency: { sandboxes: number; createsPerMinute?: number };
  hitl: HitlOptions | undefined;
  notify: NotifyOptions | undefined;
  strict: boolean;
  entries: JournalEntry[];
  abort: AbortController;
}

/** A thrown marker, not an error: the run parks on a durable wait and `run()` resolves `waiting`. */
export class RunSuspension {
  readonly selfbuildingSuspension = true;
  constructor(readonly reason: string) {}
}

export function isSuspension(value: unknown): value is RunSuspension {
  return value instanceof RunSuspension;
}

/**
 * Everything one run shares across its scopes: identity, stores, the budget, the sandbox cap, the event
 * stream and the replay cache. Primitives reach it through the AsyncLocalStorage frame (see context.ts).
 */
export class RunState {
  readonly runId: string;
  readonly factory: FactoryFrame;
  /** 0 on plain Node; durable hosts bump it per resume after a terminal failure (spec §7.6). */
  readonly epoch: number;
  readonly processEpoch: string;
  /** Salts `refresh`ed step keys (spec §3.9). */
  readonly resumeId: string;
  readonly config: SelfbuildingConfig;
  readonly options: RunOptions;
  readonly journal: JournalStore;
  readonly artifacts: ArtifactStore;
  readonly events: EventBus;
  readonly budget: BudgetLedger;
  readonly slots: SandboxSlots;
  readonly concurrency: { sandboxes: number; createsPerMinute?: number };
  readonly hitl: HitlOptions | undefined;
  readonly notify: NotifyOptions | undefined;
  readonly strict: boolean;
  /** True when the journal already held entries for this run when it started. */
  readonly resumed: boolean;
  readonly signal: AbortSignal;

  lease: Lease;
  /** The replay cache: the latest entry per step key, preloaded and kept current by `write`. */
  readonly entries = new Map<string, JournalEntry>();
  readonly visited = new Set<string>();
  /** callPaths whose interrupted call is unresolved; the run ends `needs_attention` (spec §3.10). */
  readonly needsAttention = new Set<string>();
  /** parallel() children and pipeline() items that became null through an error. */
  dropped = 0;
  readonly usage: Usage = { usd: 0, inputTokens: 0, outputTokens: 0, turns: 0, wallClockMs: 0, sandboxMs: 0 };
  leaseLost: LeaseLostError | null = null;

  private readonly abortController: AbortController;
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private readonly finalizers: (() => Promise<void> | void)[] = [];
  private readonly limiters = new Map<string, CreateRateLimiter>();

  constructor(init: RunStateInit) {
    this.runId = init.runId;
    this.factory = init.factory;
    this.epoch = init.epoch;
    this.processEpoch = init.processEpoch;
    this.resumeId = init.resumeId;
    this.config = init.config;
    this.options = init.options;
    this.journal = init.journal;
    this.lease = init.lease;
    this.artifacts = init.artifacts;
    this.events = init.events;
    this.budget = init.budget;
    this.slots = init.slots;
    this.concurrency = init.concurrency;
    this.hitl = init.hitl;
    this.notify = init.notify;
    this.strict = init.strict;
    this.abortController = init.abort;
    this.signal = init.abort.signal;
    for (const entry of init.entries) this.entries.set(entry.stepKey, entry);
    this.resumed = init.entries.some((e) => e.kind !== "run");
  }

  emit(input: EmitInput): SelfbuildingEvent {
    return this.events.emit(input);
  }

  /** Writes a journal entry with compare-and-set, fenced by the lease, and keeps the replay cache current. */
  write(entry: JournalEntry, expectStatus?: JournalEntry["status"] | null): Promise<boolean> {
    const promise = (async () => {
      if (this.leaseLost) throw this.leaseLost;
      try {
        const ok = await this.journal.put(entry, { lease: this.lease, expectStatus });
        if (ok) this.entries.set(entry.stepKey, entry);
        return ok;
      } catch (error) {
        if (error instanceof LeaseLostError) this.loseLease(error);
        throw error;
      }
    })();
    this.track(promise);
    return promise;
  }

  /** Like `write`, but a lost compare-and-set is a JournalConflictError: someone else wrote this step. */
  async writeOrConflict(entry: JournalEntry, expectStatus: JournalEntry["status"] | null): Promise<void> {
    if (!(await this.write(entry, expectStatus))) {
      throw new JournalConflictError(
        `Another writer recorded step ${entry.callPath} (${entry.stepKey}) first. Only one process may run ${this.runId}.`,
        { runId: this.runId, callPath: entry.callPath },
      );
    }
  }

  /** Call right before every sandbox create and harness launch (spec §7.5.4). */
  async assertLease(): Promise<void> {
    if (this.leaseLost) throw this.leaseLost;
    try {
      await this.journal.assertLease(this.lease);
    } catch (error) {
      if (error instanceof LeaseLostError) this.loseLease(error);
      throw error;
    }
  }

  loseLease(error: LeaseLostError): void {
    if (this.leaseLost) return;
    this.leaseLost = error;
    this.emit({ type: "error", level: "error", data: { code: error.code, retryable: false, message: error.message } });
    this.abortController.abort(error);
  }

  /** Keeps a background promise (clock writes, charges) from being lost; `run()` awaits them at the end. */
  track(promise: Promise<unknown>): void {
    this.pendingWrites.add(promise);
    promise.then(
      () => this.pendingWrites.delete(promise),
      () => this.pendingWrites.delete(promise),
    );
  }

  /** Waits for every tracked write; the first failure is rethrown. */
  async settleWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      const results = await Promise.allSettled([...this.pendingWrites]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    }
  }

  /** Runs when the run ends, last registered first. Core-agent disposes owned handles here. */
  defer(fn: () => Promise<void> | void): void {
    this.finalizers.push(fn);
  }

  async runFinalizers(): Promise<unknown[]> {
    const errors: unknown[] = [];
    while (this.finalizers.length > 0) {
      const fn = this.finalizers.pop() as () => Promise<void> | void;
      try {
        await fn();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  /** After the run ends, work still in flight (an abandoned body) can no longer write to the journal. */
  close(): void {
    this.leaseLost ??= new LeaseLostError(
      `Run ${this.runId} has ended in this process; late journal writes are refused. Resume the run to continue.`,
      { runId: this.runId },
    );
  }

  abort(reason: unknown): void {
    this.abortController.abort(reason);
  }

  /** `refresh` entries are exact callPaths or prefixes ending in "/" (spec §3.9). */
  isRefreshed(callPath: string): boolean {
    return (this.options.refresh ?? []).some((r) => (r.endsWith("/") ? callPath.startsWith(r) : callPath === r));
  }

  /**
   * The interrupted-call policy for a callPath: a run-level per-path override wins, then the call's own
   * option, then a run-level string, then "fail" (spec §3.10).
   */
  interruptedPolicy(callPath: string, perCall?: "fail" | "resume-session"): InterruptedPolicy {
    const o = this.options.onInterrupted;
    if (o !== undefined && typeof o === "object" && o[callPath] !== undefined) return o[callPath] as InterruptedPolicy;
    if (perCall !== undefined) return perCall;
    if (typeof o === "string") return o;
    return "fail";
  }

  /** One create-rate limiter per provider id (spec §9.6 rule 8). */
  createLimiter(provider: SandboxProvider): CreateRateLimiter {
    let limiter = this.limiters.get(provider.id);
    if (!limiter) {
      limiter = new CreateRateLimiter(
        effectiveCreatesPerMinute(this.concurrency.createsPerMinute, provider.limits.createsPerMinute),
      );
      this.limiters.set(provider.id, limiter);
    }
    return limiter;
  }

  /** Adds a live call's usage to the run total. Replayed calls report through `budget.noteReplayed`. */
  addUsage(u: Partial<Usage>): void {
    if (u.usd != null) this.usage.usd = (this.usage.usd ?? 0) + u.usd;
    this.usage.inputTokens += u.inputTokens ?? 0;
    this.usage.outputTokens += u.outputTokens ?? 0;
    this.usage.turns += u.turns ?? 0;
    this.usage.sandboxMs += u.sandboxMs ?? 0;
    if (u.sandboxVcpuMs !== undefined) this.usage.sandboxVcpuMs = (this.usage.sandboxVcpuMs ?? 0) + u.sandboxVcpuMs;
  }
}
