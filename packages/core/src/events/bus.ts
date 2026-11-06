import { internalNow } from "../engine/hash.js";
import type { EventSink, SelfbuildingEvent } from "../types/events.js";

/** Strings are capped at 8 KiB and events at 16 KiB, after redaction (spec §9.7 rule 3). */
export const MAX_STRING_BYTES = 8 * 1024;
export const MAX_EVENT_BYTES = 16 * 1024;

export interface EmitInput {
  type: string;
  level?: SelfbuildingEvent["level"];
  /** Defaults to "run". */
  callPath?: string;
  /** Defaults to the run-level `epoch-<processEpoch>`. */
  launchId?: string;
  attempt?: number;
  data?: Record<string, unknown>;
  replayed?: boolean;
  turnIndex?: number;
  sessionId?: string;
  parentToolUseId?: string;
}

// Token shapes worth catching even when the value was never registered with the bus.
const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

const REDACTED = "[REDACTED]";

export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return capString(redactString(value, secrets));
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (value !== null && typeof value === "object") {
    if (value instanceof Error) {
      return { name: value.name, message: capString(redactString(value.message, secrets)) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, secrets);
    return out;
  }
  return value;
}

function redactString(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

const encoder = new TextEncoder();

function capString(s: string): string {
  if (s.length * 3 <= MAX_STRING_BYTES) return s;
  const bytes = encoder.encode(s);
  if (bytes.length <= MAX_STRING_BYTES) return s;
  const marker = `…[truncated ${bytes.length - MAX_STRING_BYTES} bytes]`;
  return new TextDecoder().decode(bytes.subarray(0, MAX_STRING_BYTES - marker.length - 4)).replace(/�$/, "") + marker;
}

/**
 * The one event stream of a run (spec §9.7). Assigns `seq` per (callPath, launchId), redacts and caps every
 * payload, and delivers to sinks synchronously and fail-soft.
 */
export class EventBus {
  readonly events: SelfbuildingEvent[] = [];
  /** Events a sink threw on; reported as `telemetry.dropped`. */
  dropped = 0;
  private readonly seqs = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly secrets: string[] = [];
  private readonly sinks: EventSink[];

  constructor(
    private readonly opts: { runId: string; processEpoch: string; traceId?: string; sinks: readonly EventSink[] },
  ) {
    this.sinks = [...opts.sinks];
  }

  get runLaunchId(): string {
    return `epoch-${this.opts.processEpoch}`;
  }

  /** Registers a secret value so it never reaches a sink. Short values are ignored to avoid shredding text. */
  addSecret(value: string): void {
    if (value.length >= 6 && !this.secrets.includes(value)) this.secrets.push(value);
  }

  /** Redacts registered secrets from outbound text (channel cards, notifications); does not cap length. */
  redact(text: string): string {
    return redactString(text, this.secrets);
  }

  addSink(sink: EventSink): void {
    this.sinks.push(sink);
  }

  emit(input: EmitInput): SelfbuildingEvent {
    const callPath = input.callPath || "run";
    const launchId = input.launchId ?? this.runLaunchId;
    const counter = `${callPath}\u0000${launchId}`;
    const seq = this.seqs.get(counter) ?? 0;
    this.seqs.set(counter, seq + 1);
    return this.deliver(this.envelope(input, callPath, launchId, seq));
  }

  /**
   * Forwards an event that already carries its own `seq` (runtime and harness events). Idempotent on
   * (callPath, launchId, seq), so re-reading a spool never duplicates an event.
   */
  ingest(event: Omit<SelfbuildingEvent, "v" | "runId" | "traceId" | "ts"> & { ts?: string }): SelfbuildingEvent | null {
    const id = `${event.callPath}\u0000${event.launchId}\u0000${event.seq}`;
    if (this.seen.has(id)) return null;
    this.seen.add(id);
    const counter = `${event.callPath}\u0000${event.launchId}`;
    this.seqs.set(counter, Math.max(this.seqs.get(counter) ?? 0, event.seq + 1));
    const full: SelfbuildingEvent = {
      ...event,
      v: 1,
      runId: this.opts.runId,
      traceId: this.opts.traceId ?? this.opts.runId,
      ts: event.ts ?? new Date(internalNow()).toISOString(),
    };
    return this.deliver(full);
  }

  private envelope(input: EmitInput, callPath: string, launchId: string, seq: number): SelfbuildingEvent {
    const event: SelfbuildingEvent = {
      v: 1,
      runId: this.opts.runId,
      callPath,
      launchId,
      attempt: input.attempt ?? 0,
      seq,
      ts: new Date(internalNow()).toISOString(),
      traceId: this.opts.traceId ?? this.opts.runId,
      type: input.type,
      level: input.level ?? "info",
    };
    if (input.turnIndex !== undefined) event.turnIndex = input.turnIndex;
    if (input.sessionId !== undefined) event.sessionId = input.sessionId;
    if (input.parentToolUseId !== undefined) event.parentToolUseId = input.parentToolUseId;
    if (input.data !== undefined) event.data = input.data;
    if (input.replayed !== undefined) event.replayed = input.replayed;
    return event;
  }

  private deliver(raw: SelfbuildingEvent): SelfbuildingEvent {
    const event = this.limit(raw);
    this.events.push(event);
    for (const sink of this.sinks) {
      try {
        sink(event);
      } catch {
        this.dropped++;
      }
    }
    return event;
  }

  private limit(event: SelfbuildingEvent): SelfbuildingEvent {
    if (event.data === undefined) return event;
    const data = redactValue(event.data, this.secrets) as Record<string, unknown>;
    const bytes = encoder.encode(JSON.stringify(data)).length;
    if (bytes <= MAX_EVENT_BYTES - 1024) return { ...event, data };
    return { ...event, data: { truncated: true, bytes, keys: Object.keys(data) } };
  }
}
