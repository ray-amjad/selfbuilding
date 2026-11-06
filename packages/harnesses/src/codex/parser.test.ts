import { readFileSync } from "node:fs";
import type { HarnessEvent } from "@selfbuilding/core";
import { toGoldenJsonl } from "@selfbuilding/testing";
import { describe, expect, it } from "vitest";
import { createCodexParser, MAX_LINE_BYTES, MAX_TOOL_OUTPUT_BYTES } from "./parser.js";

// Golden fixtures: native `codex exec --json` streams in __fixtures__, normalised events in __golden__. The native
// streams follow the codex-cli 0.164.0 event schema (thread/turn/item events); the parse-contract probe re-records
// them against a live CLI (spec §4.11).

type Exit = { code: number | null; signal: string | null };

function parseFixture(name: string, exit: Exit = { code: 0, signal: null }) {
  const text = readFileSync(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url), "utf8");
  const parser = createCodexParser();
  // Split on "\n" only (spec §4.3).
  const events = text
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => parser.line(line));
  events.push(...parser.end(exit));
  return { events, sessionId: parser.sessionId() };
}

const golden = (name: string, events: HarnessEvent[]) =>
  expect(toGoldenJsonl(events)).toMatchFileSnapshot(`__golden__/${name}.events.jsonl`);

describe("codex parser: golden fixtures", () => {
  it("success: session, messages, tools, file changes, usage and the turn end", async () => {
    const { events, sessionId } = parseFixture("success");
    expect(sessionId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    expect(events[0]).toEqual({ type: "session.started", sessionId });
    expect(events.filter((e) => e.type === "file.changed")).toEqual([
      { type: "file.changed", path: "/selfbuilding/work/src/app.ts", change: "modify" },
      { type: "file.changed", path: "/selfbuilding/work/src/new.ts", change: "add" },
    ]);
    expect(events).toContainEqual({ type: "warning", message: "command timed out after 10000 ms; continuing" });
    expect(events.at(-2)).toEqual({
      type: "usage",
      inputTokens: 24763,
      outputTokens: 1220,
      cachedInputTokens: 20096,
      reasoningTokens: 640,
      cumulative: false,
    });
    expect(events.at(-1)).toEqual({ type: "turn.ended", reason: "end_turn" });
    await golden("success", events);
  });

  it("tool errors: failed commands, refused MCP calls and an invalid submit are tool results, not turn errors", async () => {
    const { events } = parseFixture("tool-error");
    const completed = events.filter((e) => e.type === "tool.completed");
    expect(completed.map((e) => e.type === "tool.completed" && [e.name, e.ok])).toEqual([
      ["command_execution", false],
      ["create_comment", false],
      ["submit_result", false],
      ["file_change", false],
    ]);
    expect(completed[1]).toMatchObject({ output: "MCP tool call requires approval, but approval policy is never" });
    expect(events.some((e) => e.type === "file.changed")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "turn.ended", reason: "end_turn" });
    await golden("tool-error", events);
  });

  it("usage limit: one quota error with the reset time, not two", async () => {
    const { events } = parseFixture("failure-usage-limit", { code: 1, signal: null });
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      failure: { code: "quota", retryable: false, retryAfterMs: (2 * 60 + 5) * 60_000 },
    });
    expect(events.at(-1)).toEqual({ type: "turn.ended", reason: "error" });
    await golden("failure-usage-limit", events);
  });

  it("reconnects become retry events; the final failure is a provider error", async () => {
    const { events } = parseFixture("failure-reconnect", { code: 1, signal: null });
    expect(events.filter((e) => e.type === "retry").map((e) => e.type === "retry" && e.attempt)).toEqual([1, 2]);
    expect(events.find((e) => e.type === "error")).toMatchObject({ failure: { code: "provider", retryable: true } });
    await golden("failure-reconnect", events);
  });

  it("nested vendor JSON is unwrapped into the failure message", async () => {
    const { events } = parseFixture("failure-nested-json", { code: 1, signal: null });
    expect(events.find((e) => e.type === "error")).toEqual({
      type: "error",
      failure: {
        code: "invalid_request",
        retryable: false,
        message: "The 'gpt-unknown' model is not supported when using Codex with a ChatGPT account.",
      },
    });
    await golden("failure-nested-json", events);
  });

  it("a selfbuilding MCP server that never started is an error; another server's failure is a warning", async () => {
    const { events } = parseFixture("failure-mcp-startup");
    expect(events.filter((e) => e.type === "error")).toEqual([
      {
        type: "error",
        failure: expect.objectContaining({ code: "harness_crash", message: expect.stringContaining("selfbuilding") }),
      },
    ]);
    expect(events).toContainEqual({
      type: "warning",
      message: "MCP client for `docs` failed to start: request timed out",
    });
    await golden("failure-mcp-startup", events);
  });

  it("resume: the same thread id is reported again", async () => {
    const first = parseFixture("success");
    const resumed = parseFixture("resume");
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.events[0]).toEqual({ type: "session.started", sessionId: first.sessionId });
    await golden("resume", resumed.events);
  });

  it("interrupted after a submit: no turn.completed, SIGINT from the kill path", async () => {
    const { events } = parseFixture("interrupted", { code: null, signal: "SIGINT" });
    expect(events.find((e) => e.type === "tool.started" && e.name === "command_execution")).toMatchObject({
      effect: "effect",
      summary: "bash -lc 'git push'",
    });
    expect(events.at(-1)).toEqual({ type: "turn.ended", reason: "interrupted" });
    await golden("interrupted", events);
  });
});

describe("codex parser: rules", () => {
  it("classifies effects: submit_result and web_search read, everything else is an effect", () => {
    const { events } = parseFixture("success");
    const started = events.filter((e) => e.type === "tool.started");
    expect(started.map((e) => e.type === "tool.started" && [e.name, e.source, e.effect])).toEqual([
      ["command_execution", "builtin", "effect"],
      ["web_search", "builtin", "read"],
      ["file_change", "builtin", "effect"],
      ["submit_result", "mcp", "read"],
    ]);
    const parser = createCodexParser();
    const [other] = parser.line(
      JSON.stringify({
        type: "item.started",
        item: { id: "i", type: "mcp_tool_call", server: "other", tool: "submit_result", arguments: {} },
      }),
    );
    expect(other).toMatchObject({ effect: "effect", server: "other" });
    const [askHuman] = parser.line(
      JSON.stringify({
        type: "item.started",
        item: { id: "j", type: "mcp_tool_call", server: "selfbuilding", tool: "ask_human" },
      }),
    );
    expect(askHuman).toMatchObject({ effect: "effect" });
  });

  it("drops non-JSON lines, JSON that is not an object, and unknown event types", () => {
    const parser = createCodexParser();
    expect(parser.line("not json")).toEqual([]);
    expect(parser.line("[1,2]")).toEqual([]);
    expect(parser.line('"text"')).toEqual([]);
    expect(parser.line(JSON.stringify({ type: "turn.started" }))).toEqual([]);
    expect(parser.line(JSON.stringify({ type: "something.new", x: 1 }))).toEqual([]);
    expect(
      parser.line(JSON.stringify({ type: "item.completed", item: { id: "r", type: "reasoning", text: "t" } })),
    ).toEqual([]);
  });

  it("drops lines over 4 MiB with a warning", () => {
    const parser = createCodexParser();
    const huge = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "x".repeat(MAX_LINE_BYTES) },
    });
    expect(parser.line(huge)).toEqual([{ type: "warning", message: expect.stringContaining("over") }]);
    // Multi-byte text crosses the limit in bytes before it does in characters.
    const wide = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "é".repeat(MAX_LINE_BYTES / 2) },
    });
    expect(wide.length).toBeLessThan(MAX_LINE_BYTES);
    expect(parser.line(wide)[0]?.type).toBe("warning");
  });

  it("keeps the tail of long tool output and reports how much was cut", () => {
    const parser = createCodexParser();
    parser.line(JSON.stringify({ type: "item.started", item: { id: "c", type: "command_execution", command: "yes" } }));
    const output = `${"a".repeat(MAX_TOOL_OUTPUT_BYTES)}THE END`;
    const [done] = parser.line(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "c",
          type: "command_execution",
          command: "yes",
          aggregated_output: output,
          exit_code: 0,
          status: "completed",
        },
      }),
    );
    expect(done).toMatchObject({ ok: true, truncatedBytes: 7 });
    expect(done?.type === "tool.completed" && done.output?.endsWith("THE END")).toBe(true);
  });

  it("emits tool.started for an item that only completes (declined commands, patches)", () => {
    const parser = createCodexParser();
    const events = parser.line(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "d",
          type: "command_execution",
          command: "rm -rf /",
          aggregated_output: "",
          exit_code: null,
          status: "declined",
        },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["tool.started", "tool.completed"]);
    expect(events[1]).toMatchObject({ ok: false });
  });

  it("reports subagent (collab) calls as subagent effects", () => {
    const parser = createCodexParser();
    const events = [
      ...parser.line(
        JSON.stringify({
          type: "item.started",
          item: { id: "s", type: "collab_tool_call", tool: "spawn_agent", prompt: "go", status: "in_progress" },
        }),
      ),
      ...parser.line(
        JSON.stringify({
          type: "item.completed",
          item: { id: "s", type: "collab_tool_call", tool: "spawn_agent", status: "completed" },
        }),
      ),
    ];
    expect(events).toEqual([
      {
        type: "tool.started",
        callId: "s",
        name: "spawn_agent",
        source: "subagent",
        effect: "effect",
        input: { prompt: "go" },
        summary: "spawn_agent",
      },
      { type: "tool.completed", callId: "s", name: "spawn_agent", ok: true },
    ]);
  });

  it("joins MCP text content, and falls back to structured content", () => {
    const parser = createCodexParser();
    const complete = (result: unknown) =>
      parser.line(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: `m${Math.random()}`,
            type: "mcp_tool_call",
            server: "s",
            tool: "t",
            result,
            error: null,
            status: "completed",
          },
        }),
      )[1];
    expect(
      complete({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toMatchObject({ output: "a\nb" });
    expect(complete({ content: [], structured_content: { ok: 1 } })).toMatchObject({ output: '{"ok":1}' });
  });

  describe("end(): a turn can end with no turn event", () => {
    const ended = (exit: Exit, lines: unknown[] = []) => {
      const parser = createCodexParser();
      for (const line of lines) parser.line(JSON.stringify(line));
      return parser.end(exit);
    };

    it("nothing more after turn.completed or turn.failed", () => {
      expect(ended({ code: 0, signal: null }, [{ type: "turn.completed", usage: {} }])).toEqual([]);
      expect(ended({ code: 1, signal: null }, [{ type: "turn.failed", error: { message: "x" } }])).toEqual([]);
    });

    it("SIGINT, SIGTERM, SIGKILL and their exit codes are interruptions", () => {
      for (const exit of [
        { code: null, signal: "SIGINT" },
        { code: null, signal: "SIGKILL" },
        { code: 130, signal: null },
        { code: 143, signal: null },
      ]) {
        expect(ended(exit)).toEqual([{ type: "turn.ended", reason: "interrupted" }]);
      }
    });

    it("a non-zero exit with no stream error is a harness crash", () => {
      expect(ended({ code: 2, signal: null })).toEqual([
        { type: "error", failure: { code: "harness_crash", retryable: false, message: "codex exited with code 2" } },
        { type: "turn.ended", reason: "error" },
      ]);
    });

    it("a stream error already reported is not repeated at exit", () => {
      expect(
        ended({ code: 1, signal: null }, [{ type: "error", message: "unexpected status 401 Unauthorized" }]),
      ).toEqual([{ type: "turn.ended", reason: "error" }]);
    });

    it("exit 0 with no turn.completed is observed, not judged", () => {
      expect(ended({ code: 0, signal: null })).toEqual([
        { type: "warning", message: "codex exited 0 without turn.completed" },
        { type: "turn.ended", reason: "end_turn" },
      ]);
    });
  });
});
