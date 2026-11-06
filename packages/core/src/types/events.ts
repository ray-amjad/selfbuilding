// The one event envelope (spec §9.7). Ingest is idempotent on (runId, callPath, launchId, seq).

export interface EventEnvelope {
  v: 1;
  runId: string;
  /** Stable across replay; "run" for run-level events. */
  callPath: string;
  /** spec §7.2 for agent events; `epoch-<processEpoch>` for run-level events. */
  launchId: string;
  attempt: number;
  /** Set by the runtime on harness events. */
  turnIndex?: number;
  /** Harness events: the harness session. */
  sessionId?: string;
  /** Harness events: subagent nesting inside the harness. */
  parentToolUseId?: string;
  /** Monotonic per (runId, callPath, launchId); never reused. */
  seq: number;
  /** ISO 8601. */
  ts: string;
  /** Equal to runId unless the caller passes one. */
  traceId: string;
  /** e.g. "sandbox.created", "harness.tool.started", "phase", "log", "skip". */
  type: string;
  level: "debug" | "info" | "warn" | "error";
}

/**
 * An event as delivered to sinks: the envelope plus a type-specific payload. Payloads are redacted and
 * capped at 16 KiB before they reach a sink. Harness events carry the `HarnessEvent` fields in `data`.
 */
export interface SelfbuildingEvent extends EventEnvelope {
  data?: Record<string, unknown>;
  /** true when emitted again during replay (phase and log events). */
  replayed?: boolean;
}

/** Synchronous and fail-soft. A throwing sink is counted in `telemetry.dropped`, never fails a run. */
export type EventSink = (event: SelfbuildingEvent) => void;
