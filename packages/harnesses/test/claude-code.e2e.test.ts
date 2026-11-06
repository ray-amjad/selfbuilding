import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCode, encodeProjectDir } from "../src/claude-code/index.js";
import { openRealBox, type RealBox, type RealTurn, runRealClaudeTurn, toFixture } from "./real-claude.js";

// Drives the installed Claude Code CLI with the adapter's real argv, env, MCP config, settings and stop hook, against a
// localhost fake of the Messages API: no model, no credentials, no network. Gated because CI has no CLI:
//   SELFBUILDING_E2E_CLAUDE_BIN=$(readlink -f "$(command -v claude)") pnpm vitest run packages/harnesses
// SELFBUILDING_RECORD_CLAUDE_FIXTURES=1 also rewrites the recorded fixtures under src/claude-code/__fixtures__/.

const BIN = process.env.SELFBUILDING_E2E_CLAUDE_BIN;
const RECORD = process.env.SELFBUILDING_RECORD_CLAUDE_FIXTURES === "1";
const FIXTURES = fileURLToPath(new URL("../src/claude-code/__fixtures__/", import.meta.url));
const SUBMIT = "mcp__selfbuilding__submit_result";

function record(name: string, box: RealBox, turn: RealTurn): void {
  if (RECORD) writeFileSync(join(FIXTURES, `${name}.jsonl`), toFixture(turn.lines, box.root));
}

describe.skipIf(!BIN)("claudeCode() against the real CLI and a fake API", () => {
  const harness = claudeCode({ binary: BIN ?? "/usr/local/bin/claude", model: "claude-offline-test" });
  let box: RealBox;
  afterEach(() => box?.close());

  it("loads the MCP config, rejects an invalid submit, and the hook stops the turn after a valid one", async () => {
    box = openRealBox();
    const turn = await runRealClaudeTurn(box, harness, {
      script: [
        { kind: "tool", name: SUBMIT, input: { status: "bogus" }, text: "Submitting." },
        { kind: "tool", name: SUBMIT, input: { status: "done", summary: "ok" } },
        { kind: "text", text: "This turn must never be requested." },
      ],
    });
    record("real-submit-stop", box, turn);
    expect(turn.exitCode, turn.stderr).toBe(0);
    expect(turn.api.mainCalls()).toBe(2);
    const started = turn.events.find((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: turn.invocation.sessionId, model: "claude-offline-test" });
    expect(started?.type === "session.started" && started.mcp).toEqual([{ name: "selfbuilding", status: "connected" }]);
    const completed = turn.events.filter((e) => e.type === "tool.completed");
    expect(completed.map((e) => e.type === "tool.completed" && e.ok)).toEqual([false, true]);
    expect(turn.events.at(-1)).toEqual({ type: "turn.ended", reason: "end_turn" });

    // The session lands where sessionArtifacts() captures it from.
    const encoded = encodeProjectDir(box.paths.workdir);
    expect(existsSync(join(box.paths.home, ".claude/projects", encoded, `${turn.invocation.sessionId}.jsonl`))).toBe(
      true,
    );
  }, 120_000);

  it("resumes the same session by id", async () => {
    box = openRealBox();
    const first = await runRealClaudeTurn(box, harness, {
      script: [{ kind: "tool", name: SUBMIT, input: { status: "done" } }],
    });
    const sessionId = first.invocation.sessionId as string;
    const second = await runRealClaudeTurn(box, harness, {
      resumeSessionId: sessionId,
      prompt: "Your previous turn was interrupted. Call submit_result when done.",
      script: [{ kind: "tool", name: SUBMIT, input: { status: "done", summary: "again" } }],
    });
    record("real-resume", box, second);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.events.find((e) => e.type === "session.started")).toMatchObject({ sessionId });
    const mainRequest = second.api.requests.find((r) => r.main);
    expect((mainRequest?.body.messages as unknown[] | undefined)?.length ?? 0).toBeGreaterThan(1);
  }, 120_000);

  it("reports file edits and shell effects", async () => {
    box = openRealBox();
    const file = join(box.paths.workdir, "notes.txt");
    const turn = await runRealClaudeTurn(box, harness, {
      script: [
        { kind: "tool", name: "Bash", input: { command: "echo hi", description: "say hi" } },
        { kind: "tool", name: "Write", input: { file_path: file, content: "hello\n" } },
        { kind: "tool", name: "Read", input: { file_path: file } },
        { kind: "tool", name: SUBMIT, input: { status: "done" } },
      ],
    });
    record("real-tools", box, turn);
    expect(turn.exitCode, turn.stderr).toBe(0);
    const started = turn.events.filter((e) => e.type === "tool.started");
    expect(started.map((e) => e.type === "tool.started" && [e.name, e.effect])).toEqual([
      ["Bash", "effect"],
      ["Write", "effect"],
      ["Read", "read"],
      [SUBMIT, "read"],
    ]);
    expect(turn.events).toContainEqual({ type: "file.changed", path: file, change: "add" });
  }, 120_000);

  it("classifies a rate limit after the CLI's own retries", async () => {
    box = openRealBox();
    const error = {
      kind: "error",
      status: 429,
      type: "rate_limit_error",
      message: "Rate limited",
      retryAfterS: 0,
    } as const;
    const turn = await runRealClaudeTurn(box, harness, { script: [error, error, error, error] });
    record("real-rate-limit", box, turn);
    expect(turn.events.some((e) => e.type === "retry" && e.cause === "rate_limit")).toBe(true);
    expect(turn.events).toContainEqual(
      expect.objectContaining({ type: "error", failure: expect.objectContaining({ code: "rate_limit" }) }),
    );
    expect(turn.events.at(-1)).toEqual({ type: "turn.ended", reason: "error" });
  }, 120_000);

  it("classifies a rejected credential as an account failure", async () => {
    box = openRealBox();
    const turn = await runRealClaudeTurn(box, harness, {
      script: Array.from({ length: 4 }, () => ({
        kind: "error" as const,
        status: 401,
        type: "authentication_error",
        message: "invalid x-api-key",
      })),
    });
    record("real-auth", box, turn);
    expect(turn.events).toContainEqual(
      expect.objectContaining({ type: "error", failure: expect.objectContaining({ code: "auth" }) }),
    );
  }, 120_000);

  it("stops at the native budget cap", async () => {
    box = openRealBox();
    const shell = { kind: "tool", name: "Bash", input: { command: "true", description: "noop" } } as const;
    const turn = await runRealClaudeTurn(box, harness, {
      budgetUsd: 0.0005,
      script: [shell, shell, shell, { kind: "tool", name: SUBMIT, input: { status: "done" } }],
    });
    record("real-budget", box, turn);
    expect(turn.invocation.argv).toContain("--max-budget-usd");
    expect(turn.events.at(-1)).toEqual({ type: "turn.ended", reason: "budget" });
  }, 120_000);

  it("delivers a subscription token from its secret file and classifies a usage limit as quota", async () => {
    box = openRealBox();
    const reset = 1_900_000_000;
    const limited = {
      kind: "error",
      status: 429,
      type: "rate_limit_error",
      message: "Usage limit reached",
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(reset),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      },
    } as const;
    const turn = await runRealClaudeTurn(box, harness, {
      credential: "oauth-token",
      script: [limited, limited, limited, limited],
    });
    record("real-usage-limit", box, turn);
    const error = turn.events.find((e) => e.type === "error");
    expect(error, JSON.stringify(turn.events)).toBeDefined();
    expect(error).toMatchObject({ failure: { code: "quota", retryable: false } });
    expect(turn.invocation.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  }, 120_000);
});
