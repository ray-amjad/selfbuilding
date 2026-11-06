import fs from "node:fs";
import type { RuntimeEvent } from "@selfbuilding/core";
import { tailFile } from "./fsutil.js";
import { capBytes, type Redactor } from "./redact.js";

/** Event lines are capped at 16 KiB (spec §6.12). */
export const MAX_EVENT_BYTES = 16 * 1024;

export interface EventContext {
  runId: string;
  callPath: string;
  launchId: string;
  attempt: number;
}

export type EventLevel = RuntimeEvent["level"];

export interface EmitOptions {
  level?: EventLevel;
  turnIndex?: number;
  sessionId?: string;
}

/** Reads the highest `seq` already in a spool, so a restarted bridge never reuses one. */
export function lastSeqIn(file: string): number {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const seq = (JSON.parse(line) as { seq?: unknown }).seq;
      if (typeof seq === "number") return seq;
    } catch {
      // A torn final line from a kill: keep looking upwards.
    }
  }
  return 0;
}

/** Shrinks every long string in a value until its JSON fits `maxBytes`. */
function shrink(data: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  let limit = 4096;
  let current = data;
  while (Buffer.byteLength(JSON.stringify(current)) > maxBytes && limit >= 16) {
    const cap = limit;
    const walk = (value: unknown): unknown => {
      if (typeof value === "string") {
        const { text, truncatedBytes } = capBytes(value, cap);
        return truncatedBytes > 0 ? `${text}…[${truncatedBytes} bytes truncated]` : text;
      }
      if (Array.isArray(value)) return value.slice(0, 50).map(walk);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      }
      return value;
    };
    current = { ...(walk(data) as Record<string, unknown>), truncated: true };
    limit = Math.floor(limit / 2);
  }
  return current;
}

/** The append-only, `seq`-numbered, redacted event spool (`events.jsonl`). */
export class EventSpool {
  #seq: number;
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(
    readonly file: string,
    private readonly ctx: EventContext,
    private readonly redactor: Redactor,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.#seq = lastSeqIn(file);
    // A kill mid-append leaves a torn last line; the next event must start on a line of its own.
    if (tailFile(file, 1) !== "" && tailFile(file, 1) !== "\n") fs.appendFileSync(file, "\n");
  }

  get lastSeq(): number {
    return this.#seq;
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(type: string, data?: Record<string, unknown>, opts: EmitOptions = {}): RuntimeEvent {
    const event: RuntimeEvent = {
      v: 1,
      runId: this.ctx.runId,
      callPath: this.ctx.callPath,
      launchId: this.ctx.launchId,
      attempt: this.ctx.attempt,
      ...(opts.turnIndex === undefined ? {} : { turnIndex: opts.turnIndex }),
      ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
      seq: ++this.#seq,
      ts: this.clock().toISOString(),
      traceId: this.ctx.runId,
      type,
      level: opts.level ?? "info",
      ...(data === undefined ? {} : { data: this.redactor.value(data) }),
    };
    let line = JSON.stringify(event);
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES && event.data) {
      event.data = shrink(
        event.data,
        MAX_EVENT_BYTES - (Buffer.byteLength(line) - Buffer.byteLength(JSON.stringify(event.data))),
      );
      line = JSON.stringify(event);
      if (Buffer.byteLength(line) > MAX_EVENT_BYTES) {
        event.data = { truncated: true };
        line = JSON.stringify(event);
      }
    }
    fs.appendFileSync(this.file, `${line}\n`);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Listeners are observers; they never break the spool.
      }
    }
    return event;
  }
}

/** Events with `seq > after`, at most `maxBytes` of them serialised, in order. */
export function readEventsAfter(
  file: string,
  after: number,
  maxBytes: number,
): { events: RuntimeEvent[]; lastSeq: number; more: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { events: [], lastSeq: after, more: false };
  }
  const events: RuntimeEvent[] = [];
  let bytes = 0;
  let lastSeq = after;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event: RuntimeEvent;
    try {
      event = JSON.parse(line) as RuntimeEvent;
    } catch {
      continue;
    }
    if (typeof event.seq !== "number" || event.seq <= after) continue;
    const size = Buffer.byteLength(line) + 1;
    if (events.length > 0 && bytes + size > maxBytes) return { events, lastSeq, more: true };
    events.push(event);
    bytes += size;
    lastSeq = event.seq;
  }
  return { events, lastSeq, more: false };
}
