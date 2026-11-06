import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelfbuildingEvent } from "../types/events.js";
import { EventBus, MAX_EVENT_BYTES, MAX_STRING_BYTES, redactValue } from "./bus.js";
import { stdoutSink } from "./index.js";

// Token-shaped test values are assembled at run time so no credential-like literal sits in the source.
const fakeGithubToken = `${"gh"}p_${"a".repeat(36)}`;
const fakeAnthropicKey = `${"sk"}-ant-${"0".repeat(24)}`;

function bus(sinks: ((e: SelfbuildingEvent) => void)[] = []) {
  return new EventBus({ runId: "r1", processEpoch: "01abc", sinks });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EventBus", () => {
  it("fills the envelope and numbers seq per (callPath, launchId)", () => {
    const b = bus();
    const first = b.emit({ type: "log", data: { message: "a" } });
    b.emit({ type: "log" });
    const agent = b.emit({ type: "sandbox.created", callPath: "A#0", launchId: "k_e0_l0", attempt: 1 });
    b.emit({ type: "sandbox.killed", callPath: "A#0", launchId: "k_e0_l1", attempt: 1 });
    expect(first).toMatchObject({
      v: 1,
      runId: "r1",
      traceId: "r1",
      callPath: "run",
      launchId: "epoch-01abc",
      attempt: 0,
      seq: 0,
      level: "info",
    });
    expect(Date.parse(first.ts)).not.toBeNaN();
    expect(b.events.map((e) => e.seq)).toEqual([0, 1, 0, 0]);
    expect(agent.level).toBe("info");
  });

  it("redacts registered secrets and known token shapes before any sink", () => {
    const seen: SelfbuildingEvent[] = [];
    const b = bus([(e) => seen.push(e)]);
    b.addSecret("hunter2-secret-value");
    b.addSecret("abc");
    b.emit({
      type: "log",
      data: {
        message: `token hunter2-secret-value and ${fakeGithubToken} and abc`,
        nested: [fakeAnthropicKey],
      },
    });
    const data = seen[0]?.data as { message: string; nested: string[] };
    expect(data.message).toBe("token [REDACTED] and [REDACTED] and abc");
    expect(data.nested[0]).toBe("[REDACTED]");
  });

  it("caps strings at 8 KiB and whole events at 16 KiB", () => {
    const b = bus();
    const long = b.emit({ type: "log", data: { message: "x".repeat(20_000) } });
    const message = (long.data as { message: string }).message;
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(MAX_STRING_BYTES);
    expect(message).toMatch(/truncated/);
    const wide = b.emit({
      type: "log",
      data: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, "y".repeat(4000)])),
    });
    expect(wide.data).toMatchObject({ truncated: true });
    expect(JSON.stringify(wide).length).toBeLessThan(MAX_EVENT_BYTES);
  });

  it("counts a throwing sink instead of failing, and still delivers to the others", () => {
    const seen: string[] = [];
    const b = bus([
      () => {
        throw new Error("down");
      },
      (e) => seen.push(e.type),
    ]);
    b.emit({ type: "a" });
    b.emit({ type: "b" });
    expect(b.dropped).toBe(2);
    expect(seen).toEqual(["a", "b"]);
  });

  it("ingests runtime events idempotently on (callPath, launchId, seq)", () => {
    const b = bus();
    const event = {
      callPath: "A#0",
      launchId: "k_e0_l0",
      attempt: 1,
      seq: 3,
      type: "harness.tool.started",
      level: "info" as const,
    };
    expect(b.ingest(event)).not.toBeNull();
    expect(b.ingest(event)).toBeNull();
    expect(b.events).toHaveLength(1);
    // Locally emitted events continue the sequence instead of colliding with it.
    expect(b.emit({ type: "x", callPath: "A#0", launchId: "k_e0_l0" }).seq).toBe(4);
  });

  it("summarises errors inside payloads", () => {
    expect(redactValue({ error: new Error("boom") }, [])).toEqual({ error: { name: "Error", message: "boom" } });
  });
});

describe("stdoutSink", () => {
  it("writes one NDJSON line per event", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const sink = stdoutSink();
    const event = bus().emit({ type: "log", data: { message: "hi" } });
    sink(event);
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(event)}\n`);
  });
});
