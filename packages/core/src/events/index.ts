import type { EventSink, SelfbuildingEvent } from "../types/events.js";

export { type EmitInput, EventBus, MAX_EVENT_BYTES, MAX_STRING_BYTES, redactValue } from "./bus.js";

/** Writes each event as one NDJSON line to stdout (the CLI's `--json` mode). */
export function stdoutSink(): EventSink {
  return (event: SelfbuildingEvent) => {
    const line = `${JSON.stringify(event)}\n`;
    const stdout = (globalThis as { process?: { stdout?: { write(s: string): unknown } } }).process?.stdout;
    if (stdout) stdout.write(line);
    else console.log(line.slice(0, -1));
  };
}
