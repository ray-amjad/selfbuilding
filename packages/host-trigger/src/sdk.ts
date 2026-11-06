import type { Json } from "@selfbuilding/core";

// The slice of the Trigger.dev v4 SDK this host uses. Both the real SDK adapter and the local fake implement
// it, so the same task code runs offline and on Trigger.dev.

export interface TriggerRunContext {
  run: { id: string };
  attempt?: { number: number };
  /**
   * The Trigger.dev environment the run executes in. `trigger.dev dev` runs are "DEVELOPMENT"; deployed ones are
   * "STAGING", "PREVIEW" or "PRODUCTION". Absent: treated as development.
   */
  environment?: { type: string };
}

/** True when the run executes on deployed machines, where tasks of one run may land on different hosts. */
export function isDeployedRun(ctx: TriggerRunContext | undefined): boolean {
  const type = ctx?.environment?.type;
  return type !== undefined && type !== "DEVELOPMENT";
}

export interface TriggerTaskDefinition<P, O> {
  id: string;
  machine?: string;
  /** Seconds of CPU; waits do not count. */
  maxDuration?: number;
  retry?: { maxAttempts: number };
  run(payload: P, params: { ctx: TriggerRunContext }): Promise<O>;
  onCancel?(params: { ctx: TriggerRunContext; payload: P }): Promise<void>;
}

export interface TriggerScheduleDefinition {
  id: string;
  cron: string;
  machine?: string;
  maxDuration?: number;
  run(payload: { timestamp: Date }, params: { ctx: TriggerRunContext }): Promise<Json>;
}

export type WaitResult<T> = { ok: true; output: T } | { ok: false; error: Error };

/** The parent's single wake stream (spec §7.5.1). The wake is only a hint; reconcile reads the truth. */
export type Wake =
  | { kind: "child"; hostKey: string; childRunId: string }
  | { kind: "ask"; askId: string }
  | { kind: "tick" };

export const WAKE_STREAM_ID = "selfbuilding.wake";

/** Trigger.dev run statuses this host reads. Anything else counts as still in flight. */
export type TriggerRunStatus =
  | "QUEUED"
  | "EXECUTING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "CRASHED"
  | "SYSTEM_FAILURE"
  | "TIMED_OUT"
  | "EXPIRED"
  | (string & {});

export interface TriggerRunView {
  id: string;
  status: TriggerRunStatus;
  output?: unknown;
  error?: { message: string; name?: string } | undefined;
}

export interface TriggerSdk {
  /** "trigger.dev" for the real SDK, "local" for the fake. */
  readonly kind: string;
  task<P, O>(def: TriggerTaskDefinition<P, O>): unknown;
  scheduleTask(def: TriggerScheduleDefinition): unknown;
  trigger(taskId: string, payload: Json, opts: { idempotencyKey: string; tags?: string[] }): Promise<{ id: string }>;
  /** A global-scope idempotency key, so a retried or replacement parent reattaches to existing children. */
  idempotencyKey(key: string): Promise<string>;
  createToken(opts: {
    idempotencyKey: string;
    timeoutMs: number;
    tags?: string[];
  }): Promise<{ id: string; url: string }>;
  /** Only inside a run; it is the run's one wait. A completed token returns at once. */
  forToken<T>(tokenId: string): Promise<WaitResult<T>>;
  completeToken(tokenId: string, data: Json): Promise<void>;
  /** Only inside a run; it is the run's one wait. */
  waitWake(opts: { timeoutMs: number }): Promise<WaitResult<Wake>>;
  sendWake(runId: string, wake: Wake): Promise<void>;
  retrieveRun(runId: string): Promise<TriggerRunView>;
  cancelRun(runId: string): Promise<void>;
  /** Wall-clock milliseconds; the fake supplies a virtual clock. */
  now(): number;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/** Trigger.dev periods are strings; whole seconds keep every timeout legal. */
export function toPeriod(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}
