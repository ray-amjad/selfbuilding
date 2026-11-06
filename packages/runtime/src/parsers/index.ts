import type { HarnessParser, ParseContext } from "@selfbuilding/core";
import { createClaudeCodeParser } from "@selfbuilding/harnesses/claude-code/parser";
import { createCodexParser } from "@selfbuilding/harnesses/codex/parser";

export type StreamParserFactory = (ctx: ParseContext) => HarnessParser;

/**
 * The harness packages' own parsers, keyed by `HarnessRunPlan.streamFormat` and bundled into the runtime. The
 * runtime never imports a harness factory (BUILD-MAP §2), only these pure parsers.
 */
export const STREAM_PARSERS: Record<string, StreamParserFactory> = {
  "claude-code": (ctx) => createClaudeCodeParser(ctx),
  codex: (ctx) => createCodexParser(ctx),
};

export function parserFor(format: string, ctx: ParseContext): HarnessParser | undefined {
  return STREAM_PARSERS[format]?.(ctx);
}
