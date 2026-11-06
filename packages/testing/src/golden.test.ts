import { describe, expect, it } from "vitest";
import { normalizeEvents, toGoldenJsonl } from "./golden.js";

describe("golden event streams", () => {
  it("numbers ids by first appearance and keeps references everywhere they appear", () => {
    const events = [
      { type: "sandbox.created", runId: "run-abc", sandboxId: "sb12345678", at: "2026-11-01T10:00:00.123Z" },
      { type: "log", message: "opened sb12345678 for run-abc on http://127.0.0.1:43210/x", ts: 1_793_540_000_000 },
      { type: "sandbox.created", sandboxId: "sb87654321" },
      { type: "session.started", sessionId: "0b5f6a4e-1d2c-4e3f-9a8b-7c6d5e4f3a2b" },
      { type: "message", text: "resuming 0b5f6a4e-1d2c-4e3f-9a8b-7c6d5e4f3a2b in sb87654321" },
      { type: "usage", costUsd: 0.0123, durationMs: 812, inputTokens: 10 },
    ];
    expect(normalizeEvents(events)).toEqual([
      { at: "<time>", runId: "<run:1>", sandboxId: "<sandbox:1>", type: "sandbox.created" },
      { message: "opened <sandbox:1> for <run:1> on http://127.0.0.1:<port:1>/x", ts: "<time>", type: "log" },
      { sandboxId: "<sandbox:2>", type: "sandbox.created" },
      { sessionId: "<session:1>", type: "session.started" },
      { text: "resuming <session:1> in <sandbox:2>", type: "message" },
      { costUsd: "<usd>", durationMs: "<duration>", inputTokens: 10, type: "usage" },
    ]);
  });

  it("produces identical files for runs that differ only in volatile values", () => {
    const run = (id: string, box: string, root: string) => [
      { type: "a", runId: id, sandboxId: box, path: `${root}/selfbuilding/work` },
      { type: "b", detail: `${box} done at 2026-01-0${id.length % 9}T00:00:00Z` },
    ];
    const a = toGoldenJsonl(run("run-1", "sbaaaa1111", "/tmp/x1"), { roots: ["/tmp/x1"] });
    const b = toGoldenJsonl(run("run-22", "sbbbbb2222", "/tmp/y2"), { roots: ["/tmp/y2"] });
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });

  it("reads JSONL text, sorts keys and drops requested keys", () => {
    const text = '{"seq":1,"type":"x","b":2,"a":1}\n\n{"seq":2,"type":"y"}\n';
    expect(toGoldenJsonl(text, { dropKeys: ["seq"] })).toBe('{"a":1,"b":2,"type":"x"}\n{"type":"y"}\n');
  });
});
