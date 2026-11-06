import type { AskRecord, AskStore, Json, ResultStore } from "@selfbuilding/core";
import { RECONCILE_MS } from "./keys.js";
import { isTerminalStatus, type TriggerRunView, type TriggerSdk } from "./sdk.js";

// The parent's in-process scheduler (spec §7.5.1). No agent() call is a wait in the parent: each one registers a
// waiter here. Once the factory body can make no progress, the scheduler takes the parent's single wait on the
// wake stream, then reconciles every waiter from the truth (child run status, ask record, clock). The wake only
// says "look now"; a lost wake costs one reconcile timeout.

type Waiter =
  | {
      kind: "child";
      childRunId: string;
      resultKey: string;
      resolve: (run: TriggerRunView) => void;
      reject: (e: unknown) => void;
    }
  | {
      kind: "ask";
      askId: string;
      deadline: number;
      resolve: (record: AskRecord | null) => void;
      reject: (e: unknown) => void;
    }
  | { kind: "sleep"; until: number; resolve: () => void; reject: (e: unknown) => void };

export interface SchedulerOptions {
  sdk: TriggerSdk;
  store: ResultStore;
  asks?: AskStore;
  /** How long the body must stay idle before the parent suspends. 0 suspends after one macrotask. */
  settleMs?: number;
  reconcileMs?: number;
}

export class ParentScheduler {
  private readonly waiters = new Set<Waiter>();
  private busy = 0;
  private looping = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly sdk: TriggerSdk;
  private readonly store: ResultStore;
  private readonly asks: AskStore | undefined;
  private readonly settleMs: number;
  private readonly reconcileMs: number;
  /** For tests and diagnostics. */
  waits = 0;
  reconciles = 0;

  constructor(opts: SchedulerOptions) {
    this.sdk = opts.sdk;
    this.store = opts.store;
    this.asks = opts.asks;
    this.settleMs = opts.settleMs ?? 0;
    this.reconcileMs = opts.reconcileMs ?? RECONCILE_MS;
  }

  /** Host work in flight (a trigger call, a store write). The parent never suspends while any is running. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.busy += 1;
    try {
      return await work();
    } finally {
      this.busy -= 1;
      this.poke();
    }
  }

  /**
   * Resolves once the child's result record exists (the child writes it before it wakes the parent) or the child
   * run is terminal without one (failed, cancelled, crashed).
   */
  waitChild(childRunId: string, resultKey: string): Promise<TriggerRunView> {
    return this.register<TriggerRunView>((resolve, reject) => ({
      kind: "child",
      childRunId,
      resultKey,
      resolve,
      reject,
    }));
  }

  waitAsk(askId: string, timeoutMs: number): Promise<AskRecord | null> {
    if (!this.asks) {
      return Promise.reject(new Error("The Trigger host has no ask store, so a factory-side ask cannot wait."));
    }
    const deadline = this.sdk.now() + timeoutMs;
    return this.register<AskRecord | null>((resolve, reject) => ({ kind: "ask", askId, deadline, resolve, reject }));
  }

  sleepUntil(until: number): Promise<void> {
    return this.register<void>((resolve, reject) => ({ kind: "sleep", until, resolve, reject }));
  }

  /** Called when the factory body settles: nothing more will be awaited. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.waiters.clear();
  }

  private register<T>(make: (resolve: (v: T) => void, reject: (e: unknown) => void) => Waiter): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiters.add(make(resolve as never, reject));
      this.poke();
    });
  }

  private poke(): void {
    if (this.stopped || this.looping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.busy === 0 && this.waiters.size > 0 && !this.looping && !this.stopped) void this.loop();
    }, this.settleMs);
  }

  private async loop(): Promise<void> {
    this.looping = true;
    try {
      while (!this.stopped) {
        if (await this.reconcile()) break;
        if (this.waiters.size === 0 || this.busy > 0) break;
        this.waits += 1;
        await this.sdk.waitWake({ timeoutMs: this.nextTimeout() });
      }
    } catch (error) {
      for (const waiter of this.waiters) waiter.reject(error);
      this.waiters.clear();
    } finally {
      this.looping = false;
      this.poke();
    }
  }

  private nextTimeout(): number {
    let timeout = this.reconcileMs;
    const now = this.sdk.now();
    for (const waiter of this.waiters) {
      if (waiter.kind === "sleep") timeout = Math.min(timeout, waiter.until - now);
      if (waiter.kind === "ask") timeout = Math.min(timeout, waiter.deadline - now);
    }
    return Math.max(1, timeout);
  }

  /** Returns true when at least one waiter was released, so the body can run again. */
  private async reconcile(): Promise<boolean> {
    this.reconciles += 1;
    let released = false;
    const now = this.sdk.now();
    for (const waiter of [...this.waiters]) {
      if (waiter.kind === "sleep") {
        if (now >= waiter.until) {
          this.waiters.delete(waiter);
          waiter.resolve();
          released = true;
        }
        continue;
      }
      if (waiter.kind === "child") {
        const result = await this.store.get<{ value: Json }>(waiter.resultKey);
        const run: TriggerRunView = result
          ? { id: waiter.childRunId, status: "COMPLETED", output: result.value }
          : await this.sdk.retrieveRun(waiter.childRunId);
        if (isTerminalStatus(run.status)) {
          this.waiters.delete(waiter);
          waiter.resolve(run);
          released = true;
        }
        continue;
      }
      const record = await (this.asks as AskStore).get(waiter.askId);
      if (record && record.status !== "open") {
        this.waiters.delete(waiter);
        waiter.resolve(record);
        released = true;
      } else if (now >= waiter.deadline) {
        this.waiters.delete(waiter);
        waiter.resolve(null);
        released = true;
      }
    }
    return released;
  }
}
