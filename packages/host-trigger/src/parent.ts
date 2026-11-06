import {
  type AgentCallback,
  type AskRecord,
  type AskStore,
  type CallbackTarget,
  ConfigError,
  type DurableHost,
  type FactoryRef,
  type HostAgentCall,
  type HostLimits,
  type Json,
  type LaunchId,
  launchDepthOf,
  type RawOutcome,
  type ResultStore,
  type StepOpts,
} from "@selfbuilding/core";
import { type AgentTaskPayload, childFailureOutcome } from "./child.js";
import { cancelChildren, deliverCallback, hostRunStatus } from "./control.js";
import { StepMemo } from "./journal.js";
import {
  AGENT_TASK_ID,
  agentChildKey,
  agentRegistryName,
  FACTORY_TASK_ID,
  hostKeyOf,
  MAX_STEP_OUTPUT_BYTES,
  nestedChildKey,
  nestedRunId,
  storeKeys,
} from "./keys.js";
import type { ParentScheduler } from "./scheduler.js";
import type { TriggerRunView, TriggerSdk } from "./sdk.js";

// The DurableHost the factory body sees inside `selfbuilding.factory` (spec §7.5.1).

export interface FactoryTaskPayload {
  /** A key of `createTriggerHost({ factories })`. */
  factory: string;
  input: Json;
  /** Default: derived from the Trigger run id. Pass the same id again to resume after a terminal failure. */
  runId?: string;
  /** Set when this run is a nested factory of another run. */
  parent?: { hostRunId: string; hostKey: string; resultKey: string };
  /** Tightens the run's sandbox slots and budget (start_workflow launches). Never loosens the deployment's. */
  limits?: FactoryRunLimits;
  /**
   * No humans: every ask resolves by its AFK policy, as `selfbuilding run --afk` does on plain Node. Set by
   * `triggerWorkflowLauncher` for a start_workflow request with `afk: true`.
   */
  afk?: boolean;
}

export interface FactoryRunLimits {
  sandboxes?: number;
  budgetUsd?: number;
}

export type FactoryTaskOutput = {
  runId: string;
  epoch: number;
  hostRunId: string;
  status: string;
  output: Json;
  /** Children this run cancelled because its replay never visited them (spec §7.3 orphan sweep). */
  orphans: string[];
  error?: Json;
};

/** Never more than N children in flight; the parent is the only code that starts them (spec §7.5.1). */
class Semaphore {
  private free: number;
  private readonly queue: (() => void)[] = [];
  constructor(slots: number) {
    this.free = Math.max(1, slots);
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.free += 1;
  }
}

export interface ParentHostOptions {
  sdk: TriggerSdk;
  store: ResultStore;
  asks?: AskStore;
  scheduler: ParentScheduler;
  runId: string;
  epoch: number;
  hostRunId: string;
  maxChildren: number;
  /** The run is AFK; its agent children open asks under the AFK policy too. */
  afk?: boolean;
}

export class TriggerParentHost implements DurableHost {
  readonly id = "trigger" as const;
  readonly limits: HostLimits = { maxStepOutputBytes: MAX_STEP_OUTPUT_BYTES, parallelWaits: false };
  readonly epoch: number;
  readonly runId: string;
  /** Registry names this replay dispatched; everything else in the registry is an orphan. */
  readonly visited = new Set<string>();
  private readonly memo: StepMemo;
  private readonly slots: Semaphore;

  constructor(private readonly o: ParentHostOptions) {
    this.epoch = o.epoch;
    this.runId = o.runId;
    this.memo = new StepMemo(o.store, o.runId, o.epoch, () => o.sdk.now());
    this.slots = new Semaphore(o.maxChildren);
  }

  /**
   * Reads the record before running `fn`; a throw writes nothing, so the step runs again. Only the store calls are
   * tracked as busy: `fn` may itself wait on children, and the parent must be free to suspend then.
   */
  async step<T extends Json>(key: string, fn: () => Promise<T>, opts?: StepOpts): Promise<T> {
    const hit = await this.o.scheduler.track(() => this.memo.read(key));
    if (hit) return hit.value as T;
    const value = await fn();
    return (await this.o.scheduler.track(() => this.memo.write(key, value ?? null, opts))) as T;
  }

  async waitForCallback<T extends Json>(
    launchId: LaunchId,
    _opts: { timeoutMs: number; rearm: number; register: (target: CallbackTarget) => Promise<void> },
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" }> {
    throw new ConfigError(
      `On Trigger.dev the per-launch wait for ${launchId} runs in the selfbuilding.agent child task. Dispatch the call with host.dispatchAgent(), which returns its raw outcome.`,
    );
  }

  async sleep(key: string, ms: number): Promise<void> {
    const until = await this.step<number>(`sleep:${key}`, async () => this.o.sdk.now() + ms, { kind: "clock" });
    if (this.o.sdk.now() >= until) return;
    await this.o.scheduler.sleepUntil(until);
  }

  all<T>(branches: Array<() => Promise<T>>): Promise<T[]> {
    return Promise.all(branches.map((branch) => branch()));
  }

  async child<I, O>(key: string, factory: FactoryRef<I, O>, input: I): Promise<O> {
    const name = `factory:${key}`;
    this.visited.add(name);
    const payload: FactoryTaskPayload = {
      factory: factory.name,
      input: (input ?? null) as Json,
      runId: nestedRunId(this.runId, key),
      parent: {
        hostRunId: this.o.hostRunId,
        hostKey: name,
        resultKey: storeKeys.childResult(this.runId, this.epoch, name),
      },
    };
    const childRunId = await this.o.scheduler.track(async () => {
      const idempotencyKey = await this.o.sdk.idempotencyKey(nestedChildKey(this.runId, key, this.epoch));
      const handle = await this.o.sdk.trigger(FACTORY_TASK_ID, payload as unknown as Json, {
        idempotencyKey,
        tags: [this.runId],
      });
      await this.o.store.createIfAbsent(storeKeys.child(this.runId, this.epoch, name), {
        childRunId: handle.id,
        hostKey: name,
        kind: "factory",
      });
      return handle.id;
    });
    const view = await this.o.scheduler.waitChild(childRunId, storeKeys.childResult(this.runId, this.epoch, name));
    const output = view.output as FactoryTaskOutput | undefined;
    if (view.status !== "COMPLETED" || !output) {
      throw new ConfigError(
        `Nested factory "${factory.name}" (${key}) ended ${view.status}${view.error ? `: ${view.error.message}` : ""}.`,
      );
    }
    return output.output as O;
  }

  /** Triggers the call's child task and resolves with its raw outcome; never a wait in the parent. */
  async dispatchAgent(call: HostAgentCall): Promise<RawOutcome> {
    if (call.runId !== this.runId || call.epoch !== this.epoch) {
      throw new ConfigError(
        `Agent call ${call.callPath} is for run ${call.runId} epoch ${call.epoch}, but this host drives ${this.runId} epoch ${this.epoch}.`,
      );
    }
    const name = agentRegistryName(call);
    this.visited.add(name);
    const depth = launchDepthOf(this.runId);
    await this.slots.acquire();
    try {
      const childRunId = await this.o.scheduler.track(async () => {
        const idempotencyKey = await this.o.sdk.idempotencyKey(agentChildKey(call));
        const handle = await this.o.sdk.trigger(
          AGENT_TASK_ID,
          {
            call,
            parentRunId: this.o.hostRunId,
            resultKey: storeKeys.childResult(this.runId, this.epoch, name),
            ...(depth > 0 ? { launchDepth: depth } : {}),
            ...(this.o.afk ? { afk: true } : {}),
          } satisfies AgentTaskPayload as unknown as Json,
          { idempotencyKey, tags: [this.runId] },
        );
        // A crash before this write is harmless: the same key returns the same child run.
        await this.o.store.createIfAbsent(storeKeys.child(this.runId, this.epoch, name), {
          childRunId: handle.id,
          hostKey: hostKeyOf(call),
          launch: call.launch,
          kind: "agent",
        });
        return handle.id;
      });
      const resultKey = storeKeys.childResult(this.runId, this.epoch, name);
      return rawOutcomeOf(call, await this.o.scheduler.waitChild(childRunId, resultKey));
    } finally {
      this.slots.release();
    }
  }

  async waitForAsk(askId: string, opts: { timeoutMs: number }): Promise<AskRecord | null> {
    return this.o.scheduler.waitAsk(askId, opts.timeoutMs);
  }

  runStatus(hostRunId: string) {
    return hostRunStatus(this.o.sdk, hostRunId);
  }

  deliverCallback(cb: AgentCallback): Promise<void> {
    return deliverCallback(this.o.sdk, this.o.store, cb);
  }

  /** Cancels registered children this replay never visited (spec §7.3). */
  async sweepOrphans(): Promise<string[]> {
    const cancelled = await cancelChildren(
      this.o.sdk,
      this.o.store,
      storeKeys.childPrefix(this.runId, this.epoch),
      (name) => this.visited.has(name),
    );
    return cancelled.map((c) => c.name);
  }
}

function rawOutcomeOf(call: HostAgentCall, view: TriggerRunView): RawOutcome {
  const output = view.output as RawOutcome | undefined;
  if (view.status === "COMPLETED" && output && typeof output === "object" && typeof output.ok === "boolean") {
    return output;
  }
  return childFailureOutcome(call, view.id, view.status, view.error?.message);
}
