import { readdirSync, readFileSync } from "node:fs";
import type { HarnessEvent } from "@selfbuilding/core";
import { toGoldenJsonl } from "@selfbuilding/testing";
import { describe, expect, it } from "vitest";
import { createClaudeCodeParser, MAX_LINE_BYTES, MAX_TOOL_OUTPUT_BYTES } from "./parser.js";

// Fixtures named real-* were recorded from Claude Code 2.1.316 (the tested pin) driven against a localhost fake of the
// Messages API (see test/claude-code.e2e.test.ts); synthetic-* cover shapes a fake cannot provoke.
const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixtureNames = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => name.slice(0, -".jsonl".length))
  .sort();

function parseFixture(name: string, exit = { code: 0 as number | null, signal: null as string | null }) {
  const parser = createClaudeCodeParser();
  const lines = readFileSync(new URL(`${name}.jsonl`, FIXTURES), "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const events = lines.flatMap((line) => parser.line(line));
  events.push(...parser.end(exit));
  return { events, parser };
}

const ofType = <T extends HarnessEvent["type"]>(events: HarnessEvent[], type: T) =>
  events.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);

describe("Claude Code stream parser: golden fixtures", () => {
  it("has the recorded fixtures", () => {
    expect(fixtureNames).toEqual(
      expect.arrayContaining(["real-submit-stop", "real-resume", "real-tools", "real-rate-limit", "real-usage-limit"]),
    );
  });

  for (const name of fixtureNames) {
    it(`normalises ${name}`, async () => {
      const { events } = parseFixture(name);
      await expect(toGoldenJsonl(events)).toMatchFileSnapshot(`__golden__/${name}.events.jsonl`);
    });
  }
});

describe("Claude Code stream parser: what the fixtures prove", () => {
  it("submit then hook stop: one session, rejected then accepted submit, clean end", () => {
    const { events, parser } = parseFixture("real-submit-stop");
    const started = ofType(events, "session.started");
    expect(started).toHaveLength(1);
    expect(started[0]?.mcp).toEqual([{ name: "selfbuilding", status: "connected" }]);
    expect(parser.sessionId()).toBe(started[0]?.sessionId);
    const submits = ofType(events, "tool.started");
    expect(submits.map((e) => [e.source, e.server, e.effect])).toEqual([
      ["mcp", "selfbuilding", "read"],
      ["mcp", "selfbuilding", "read"],
    ]);
    expect(ofType(events, "tool.completed").map((e) => [e.ok, e.output])).toEqual([
      [false, 'status: must be "done"'],
      [true, "Accepted. Stop now."],
    ]);
    expect(ofType(events, "usage")[0]).toMatchObject({ cumulative: true, inputTokens: 200, cachedInputTokens: 40 });
    expect(events.at(-1)).toEqual({ type: "turn.ended", reason: "end_turn" });
    expect(ofType(events, "error")).toEqual([]);
  });

  it("tools: shell and writes are effects, reads are not, and a created file is reported", () => {
    const { events } = parseFixture("real-tools");
    expect(ofType(events, "tool.started").map((e) => [e.name, e.effect, e.summary])).toEqual([
      ["Bash", "effect", "Bash: echo hi"],
      ["Write", "effect", "Write: /selfbuilding/work/notes.txt"],
      ["Read", "read", "Read: /selfbuilding/work/notes.txt"],
      ["mcp__selfbuilding__submit_result", "read", "mcp__selfbuilding__submit_result"],
    ]);
    expect(ofType(events, "file.changed")).toEqual([
      { type: "file.changed", path: "/selfbuilding/work/notes.txt", change: "add" },
    ]);
  });

  it("rate limit: vendor retries become retry events and the turn ends in a retryable error", () => {
    const { events } = parseFixture("real-rate-limit", { code: 1, signal: null });
    expect(ofType(events, "retry").map((e) => [e.attempt, e.cause])).toEqual([
      [1, "rate_limit"],
      [2, "rate_limit"],
    ]);
    expect(ofType(events, "error")).toEqual([
      { type: "error", failure: expect.objectContaining({ code: "rate_limit", retryable: true }) },
    ]);
    expect(ofType(events, "message")).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "turn.ended", reason: "error" });
  });

  it("subscription usage limit: quota, never retryable on the same credential", () => {
    const { events } = parseFixture("real-usage-limit", { code: 1, signal: null });
    expect(ofType(events, "warning")[0]?.message).toMatch(/usage limit reached \(five_hour\)/);
    expect(ofType(events, "error")[0]?.failure).toMatchObject({ code: "quota", retryable: false });
    expect(ofType(events, "error")[0]?.failure.message).toMatch(/hit your 5-hour limit/);
  });

  it("rejected credentials and a missing login are auth failures", () => {
    expect(ofType(parseFixture("real-auth").events, "error")[0]?.failure.code).toBe("auth");
    expect(ofType(parseFixture("real-not-logged-in").events, "error")[0]?.failure).toMatchObject({
      code: "auth",
      message: "Not logged in · Please run /login",
    });
  });

  it("budget cap ends the turn with reason budget", () => {
    expect(parseFixture("real-budget").events.at(-1)).toEqual({ type: "turn.ended", reason: "budget" });
  });

  it("resume keeps the session id", () => {
    const resumed = parseFixture("real-resume").parser.sessionId();
    expect(resumed).toBe(parseFixture("real-submit-stop").parser.sessionId());
  });

  it("nested vendor JSON is unwrapped and classified", () => {
    const { events } = parseFixture("synthetic-api-error", { code: 1, signal: null });
    expect(ofType(events, "retry")).toEqual([{ type: "retry", attempt: 1, delayMs: 600, cause: "provider" }]);
    expect(ofType(events, "error")[0]?.failure).toEqual({
      code: "context_overflow",
      retryable: false,
      message: "API Error: 400 prompt is too long: 210000 tokens > 200000 maximum",
    });
  });

  it("a failed selfbuilding server is an error at session start", () => {
    const { events } = parseFixture("synthetic-mcp-failed");
    expect(events[1]).toMatchObject({ type: "error", failure: { code: "harness_crash" } });
  });

  it("mixed stream: sources, deltas, subagent tools, warnings and unknown lines", () => {
    const { events } = parseFixture("synthetic-mixed");
    expect(events[0]).toMatchObject({
      type: "session.started",
      mcp: [
        { name: "selfbuilding", status: "connected" },
        { name: "github", status: "failed", error: "spawn ENOENT" },
      ],
    });
    expect(ofType(events, "message.delta")).toEqual([
      { type: "message.delta", kind: "thinking", text: "Plan the work." },
      { type: "message.delta", kind: "text", text: "Starting" },
    ]);
    expect(ofType(events, "message")).toEqual([{ type: "message", role: "assistant", text: "Starting" }]);
    expect(ofType(events, "tool.started").map((e) => [e.name, e.source, e.effect])).toEqual([
      ["Skill", "skill", "effect"],
      ["Task", "subagent", "effect"],
      ["Grep", "builtin", "read"],
      ["Edit", "builtin", "effect"],
      ["mcp__selfbuilding__ask_human", "mcp", "effect"],
    ]);
    expect(ofType(events, "tool.completed").find((e) => e.callId === "toolu_task")).toMatchObject({
      output: "Tests live in src.",
    });
    expect(ofType(events, "file.changed")).toEqual([
      { type: "file.changed", path: "/selfbuilding/work/src/a.ts", change: "modify" },
    ]);
    expect(ofType(events, "warning")[0]?.message).toMatch(/close to its limit \(seven_day\)/);
    expect(ofType(events, "usage")[0]).toEqual({
      type: "usage",
      inputTokens: 1200,
      outputTokens: 400,
      cachedInputTokens: 5000,
      costUsd: 0.25,
      cumulative: true,
    });
    expect(events.at(-1)).toEqual({ type: "turn.ended", reason: "max_turns" });
  });
});

describe("Claude Code stream parser: framing and exit rules (spec §4.3)", () => {
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", mcp_servers: [] });

  it("drops non-JSON, arrays and unknown event types", () => {
    const parser = createClaudeCodeParser();
    expect(parser.line("not json")).toEqual([]);
    expect(parser.line("[1,2]")).toEqual([]);
    expect(parser.line('{"type":"nope"}')).toEqual([]);
    expect(parser.line("")).toEqual([]);
  });

  it("drops a line over 4 MiB with a warning", () => {
    const parser = createClaudeCodeParser();
    const huge = JSON.stringify({ type: "assistant", pad: "x".repeat(MAX_LINE_BYTES) });
    expect(parser.line(huge)).toEqual([{ type: "warning", message: expect.stringMatching(/over 4194304 bytes/) }]);
  });

  it("keeps U+2028 inside a line instead of splitting on it", () => {
    const parser = createClaudeCodeParser();
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "a b" }] },
    });
    expect(parser.line(line)).toEqual([{ type: "message", role: "assistant", text: "a b" }]);
  });

  it("bounds tool output and reports the truncated bytes", () => {
    const parser = createClaudeCodeParser();
    parser.line(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat big" } }] },
      }),
    );
    const [completed] = parser.line(
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "y".repeat(MAX_TOOL_OUTPUT_BYTES + 10) }],
        },
      }),
    );
    expect(completed).toMatchObject({ type: "tool.completed", name: "Bash", ok: true, truncatedBytes: 10 });
    expect(completed?.type === "tool.completed" && completed.output?.length).toBe(MAX_TOOL_OUTPUT_BYTES);
  });

  it("a clean exit with no result still ends the turn", () => {
    const parser = createClaudeCodeParser();
    parser.line(init);
    expect(parser.end({ code: 0, signal: null })).toEqual([{ type: "turn.ended", reason: "end_turn" }]);
    expect(parser.sessionId()).toBe("s-1");
  });

  it("SIGINT is an interruption, not a crash", () => {
    expect(createClaudeCodeParser().end({ code: null, signal: "SIGINT" })).toEqual([
      { type: "turn.ended", reason: "interrupted" },
    ]);
    expect(createClaudeCodeParser().end({ code: 130, signal: null })).toEqual([
      { type: "turn.ended", reason: "interrupted" },
    ]);
  });

  it("SIGTERM and crashes are harness_crash errors; a seen API failure wins", () => {
    expect(createClaudeCodeParser().end({ code: 143, signal: null })).toEqual([
      {
        type: "error",
        failure: {
          code: "harness_crash",
          retryable: false,
          message: expect.stringMatching(/SIGTERM records no result/),
        },
      },
      { type: "turn.ended", reason: "error" },
    ]);
    const parser = createClaudeCodeParser();
    parser.line(
      JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, error_status: 500, error: "server_error" }),
    );
    expect(parser.end({ code: 1, signal: null })[0]).toMatchObject({ failure: { code: "provider", retryable: true } });
  });

  it("does not end twice after a result", () => {
    const parser = createClaudeCodeParser();
    parser.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: {} }));
    expect(parser.end({ code: 1, signal: null })).toEqual([]);
  });
});
