import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEvent, HarnessParser } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { parserFor, STREAM_PARSERS } from "./index.js";

const ctx = { runId: "r", callPath: "c", attempt: 1 };

const run = (parser: HarnessParser, lines: string[]): HarnessEvent[] => [
  ...lines.flatMap((line) => parser.line(line)),
  ...parser.end({ code: 0, signal: null }),
];

// The test kit's golden streams, normalised.
function goldenLines(name: string): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "../../../testing/src/scripted/__golden__", name);
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

describe("bundled stream parsers", () => {
  it("are the harness packages' parsers, registered by stream format", () => {
    expect(Object.keys(STREAM_PARSERS).sort()).toEqual(["claude-code", "codex"]);
    expect(parserFor("opencode", ctx)).toBeUndefined();
  });

  it("read the golden Claude Code stream: submit_result is a read, Bash an effect", () => {
    const parser = parserFor("claude-code", ctx) as HarnessParser;
    const events = run(parser, goldenLines("claude-code-invalid-then-valid.jsonl"));
    const submit = events.find((e) => e.type === "tool.started" && e.name === "mcp__selfbuilding__submit_result");
    expect(submit).toMatchObject({ source: "mcp", server: "selfbuilding", effect: "read" });
    const bash = events.find((e) => e.type === "tool.started" && e.name === "Bash");
    expect(bash).toMatchObject({ effect: "effect" });
  });

  it("report an interrupted Codex turn that ended without a turn event", () => {
    const parser = parserFor("codex", ctx) as HarnessParser;
    const events = parser.end({ code: null, signal: "SIGINT" });
    expect(events.length).toBeGreaterThan(0);
  });
});
