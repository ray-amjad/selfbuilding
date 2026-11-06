import { describe, expect, it } from "vitest";
import { classifyCodexFailure, classifyCodexMessage, retryAfterMs, unwrapMessage } from "./classify.js";

// The account matcher is fixture-tested on both sides (spec §4.9): too broad moves a session between accounts for
// errors that are not account errors; too narrow stops on a dead account while others still have capacity.

const code = (message: string) => classifyCodexMessage(message).code;

describe("classifyCodexMessage: account failures (the pool moves on)", () => {
  it.each([
    ["You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again in 3 days 4 hours.", "quota"],
    [
      'unexpected status 429 Too Many Requests: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":3600}}',
      "quota",
    ],
    ["unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", "auth"],
    ["Your access token could not be refreshed. Please log out and sign in again.", "auth"],
    [
      "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      "auth",
    ],
    [
      'unexpected status 401 Unauthorized: {"error":{"message":"Incorrect API key provided: sk-abc***","type":"invalid_request_error","code":"invalid_api_key"}}',
      "auth",
    ],
    ["OAuth refresh token was rejected: refresh_token_reused", "auth"],
  ])("%s → %s", (message, expected) => {
    expect(code(message)).toBe(expected);
    expect(classifyCodexMessage(message).retryable).toBe(false);
  });
});

describe("classifyCodexMessage: not account failures (the pool stays)", () => {
  it.each([
    ["unexpected status 403 Forbidden: permission denied for this resource", "unknown"],
    ["permission_error: the tool is not allowed to write here", "unknown"],
    ["gh: HTTP 403: Resource not accessible by integration", "unknown"],
    ["exceeded retry limit, last status: 429 Too Many Requests", "rate_limit"],
    [
      'unexpected status 429 Too Many Requests: {"error":{"message":"Rate limit reached for gpt-5 on tokens per min. Please try again in 1.5s.","type":"tokens","code":"rate_limit_exceeded"}}',
      "rate_limit",
    ],
    ["server overloaded, please retry", "rate_limit"],
    ["stream disconnected before completion: error sending request", "provider"],
    ["unexpected status 502 Bad Gateway", "provider"],
    ["exceeded retry limit, last status: 503 Service Unavailable", "provider"],
    ["Quota exceeded. Check your plan and billing details.", "billing"],
    ['{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}', "billing"],
    [
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      "context_overflow",
    ],
    [
      'unexpected status 400 Bad Request: {"error":{"message":"Unsupported value: reasoning.effort","type":"invalid_request_error"}}',
      "invalid_request",
    ],
    ["the build produced 500 lines of output", "unknown"],
    ["line 401 of the log", "unknown"],
    ["something odd happened", "unknown"],
  ])("%s → %s", (message, expected) => {
    expect(code(message)).toBe(expected);
  });

  it("rate limits and provider errors are retryable, with the vendor's wait when it gives one", () => {
    expect(
      classifyCodexMessage(
        '{"error":{"message":"Rate limit reached. Please try again in 1.5s.","code":"rate_limit_exceeded"}}',
      ),
    ).toEqual({
      code: "rate_limit",
      retryable: true,
      retryAfterMs: 1500,
      message: "Rate limit reached. Please try again in 1.5s.",
    });
    expect(classifyCodexMessage("unexpected status 500 Internal Server Error")).toMatchObject({ retryable: true });
  });

  it("a selfbuilding MCP server that failed to start is a harness crash", () => {
    expect(code("MCP client for `selfbuilding` failed to start: ENOENT")).toBe("harness_crash");
    expect(code("MCP client for `selfbuilding` timed out after 10 seconds")).toBe("harness_crash");
    expect(code("MCP client for `docs` failed to start: ENOENT")).toBe("unknown");
  });
});

describe("unwrapMessage and retryAfterMs", () => {
  it("unwraps nested JSON twice over and keeps the vendor codes", () => {
    const inner = JSON.stringify({ error: { message: "deep", code: "c2" } });
    const outer = `unexpected status 400 Bad Request: ${JSON.stringify({ error: { message: inner, type: "t1" } })}`;
    expect(unwrapMessage(outer)).toEqual({ message: "deep", vendorCode: "t1 c2", status: 400 });
    expect(unwrapMessage("plain text")).toEqual({ message: "plain text", vendorCode: "" });
    expect(unwrapMessage("broken {json")).toMatchObject({ message: "broken {json" });
  });

  it("reads the vendor's wait in several shapes", () => {
    expect(retryAfterMs("try again in 4 days 3 hours 22 minutes.")).toBe(((4 * 24 + 3) * 60 + 22) * 60_000);
    expect(retryAfterMs("Please try again in 1.5s")).toBe(1500);
    expect(retryAfterMs("Please try again in 250ms")).toBe(250);
    expect(retryAfterMs("retry after 20 seconds")).toBe(20_000);
    expect(retryAfterMs('"resets_in_seconds": 90')).toBe(90_000);
    expect(retryAfterMs("no wait given")).toBeUndefined();
  });
});

describe("classifyCodexFailure", () => {
  it("reads native error events in each shape", () => {
    expect(
      classifyCodexFailure({ kind: "event", event: { type: "error", message: "unexpected status 401 Unauthorized" } })
        .code,
    ).toBe("auth");
    expect(
      classifyCodexFailure({
        kind: "event",
        event: { type: "turn.failed", error: { message: "hit your usage limit" } },
      }).code,
    ).toBe("quota");
    expect(
      classifyCodexFailure({
        kind: "event",
        event: { type: "item.completed", item: { type: "error", message: "stream disconnected" } },
      }).code,
    ).toBe("provider");
    expect(classifyCodexFailure({ kind: "event", event: "raw text 429 Too Many Requests" }).code).toBe("rate_limit");
  });

  it("uses stderr only when it names a vendor failure; otherwise a crash with the last line", () => {
    expect(
      classifyCodexFailure({
        kind: "exit",
        code: 1,
        signal: null,
        stderrTail: "Error: unexpected status 401 Unauthorized\n",
      }).code,
    ).toBe("auth");
    expect(
      classifyCodexFailure({
        kind: "exit",
        code: 101,
        signal: null,
        stderrTail: "thread 'main' panicked\nnote: run with RUST_BACKTRACE",
      }),
    ).toEqual({
      code: "harness_crash",
      retryable: false,
      message: "codex exited with code 101: note: run with RUST_BACKTRACE",
    });
    expect(classifyCodexFailure({ kind: "exit", code: 127, signal: null, stderrTail: "" }).message).toContain(
      "not found",
    );
    expect(classifyCodexFailure({ kind: "exit", code: null, signal: "SIGSEGV", stderrTail: "" }).message).toBe(
      "codex exited with signal SIGSEGV",
    );
  });
});
