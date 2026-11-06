import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import type { EventSink, SelfbuildingEvent } from "@selfbuilding/core";
import type { Writable } from "./context.js";

/** The plain Node default sink: one JSONL file per run (spec §9.7). Appends, so a resume continues the file. */
export function jsonlFileSink(file: string): { sink: EventSink; close(): void } {
  mkdirSync(path.dirname(file), { recursive: true });
  let fd: number | null = openSync(file, "a");
  return {
    sink: (event) => {
      if (fd !== null) writeSync(fd, `${JSON.stringify(event)}\n`);
    },
    close: () => {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

/** `--json`: NDJSON on stdout, one event per line. */
export function ndjsonSink(out: Writable): EventSink {
  return (event) => {
    out.write(`${JSON.stringify(event)}\n`);
  };
}

/** Human-readable progress on stderr. Harness chatter below `info` is left to `watch --json`. */
export function humanSink(err: Writable): EventSink {
  return (event) => {
    const line = formatEvent(event);
    if (line !== null) err.write(`${line}\n`);
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function usd(value: unknown): string | undefined {
  return typeof value === "number" ? `$${value.toFixed(value < 1 ? 4 : 2)}` : undefined;
}

/** One line per event that a person watching a run cares about; null for the rest. */
export function formatEvent(event: SelfbuildingEvent): string | null {
  const d = event.data ?? {};
  const where = event.callPath === "run" ? "" : ` ${event.callPath}`;
  const time = event.ts.length >= 19 ? event.ts.slice(11, 19) : event.ts;
  const prefix = `${time}${where}`;
  const replayed = event.replayed ? " (replayed)" : "";
  switch (event.type) {
    case "phase":
      return `${prefix} ▸ phase ${str(d.name) ?? ""}${replayed}`;
    case "log":
      return `${prefix} ${oneLine(str(d.message) ?? "")}${replayed}`;
    // Core emits agent.started / agent.finished; the short names are kept for older event files.
    case "agent.start":
    case "agent.started":
      return `${prefix} ● agent started${str(d.agent) ? ` ${str(d.agent)}` : ""}${str(d.harness) ? ` on ${str(d.harness)}` : ""}`;
    case "agent.end":
    case "agent.finished": {
      const cost = usd((d.usage as { usd?: unknown } | undefined)?.usd ?? d.usd);
      return `${prefix} ● agent ${str(d.status) ?? "finished"}${cost ? ` ${cost}` : ""}${d.replayed ? " (replayed)" : ""}`;
    }
    case "harness.tool.started":
      return `${prefix}   tool ${str(d.name) ?? str(d.tool) ?? "?"}`;
    case "harness.text":
    case "harness.message": {
      const text = str(d.text);
      return text ? `${prefix}   ${oneLine(text)}` : null;
    }
    case "ask.created":
    case "ask.posted": {
      const ordinal = str(d.ordinal);
      const question = str(d.question);
      return `${prefix} ? ask${ordinal ? ` #${ordinal}` : ""}${question ? `: ${oneLine(question)}` : ""}`;
    }
    case "ask.answered":
      return `${prefix} ✓ ask${str(d.ordinal) ? ` #${str(d.ordinal)}` : ""} answered${str(d.choiceId) ? `: ${str(d.choiceId)}` : ""}`;
    case "ask.expired":
    case "ask.cancelled":
      return `${prefix} ✗ ${event.type}`;
    case "budget.charged":
    case "budget.charge": {
      const total = usd(d.cumulative ?? d.usd);
      return total ? `${prefix}   spent ${total}` : null;
    }
    case "run.end":
      return `${prefix} ■ run ${str(d.status) ?? "ended"}${usd(d.usd) ? ` ${usd(d.usd)}` : ""}`;
    default:
      if (event.level === "warn" || event.level === "error") {
        const message = str(d.message) ?? str(d.reason) ?? str(d.code) ?? "";
        return `${prefix} ${event.level === "error" ? "ERROR" : "warn"} ${event.type}${message ? ` ${oneLine(message)}` : ""}`;
      }
      if (event.type.startsWith("sandbox.")) return `${prefix}   ${event.type}`;
      return null;
  }
}
