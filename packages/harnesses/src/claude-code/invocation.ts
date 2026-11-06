import { ConfigError, type Effort, type Invocation, type InvokeContext } from "@selfbuilding/core";
import { claudeConfigPaths, mcpToolTimeoutMs } from "./prepare.js";
import { claudeSessionId, isUuid } from "./session.js";

export type InvocationMode =
  | { kind: "fresh" }
  | { kind: "resume"; sessionId: string }
  | { kind: "fork"; sessionId: string };

/** Claude Code's `--effort` takes low, medium, high, xhigh and max; Selfbuilding's four values map one to one. */
export const CLAUDE_EFFORTS: readonly Effort[] = ["low", "medium", "high", "max"];

/** Used when the context does not carry the timeout `prepare()` set: the default hot wait (10 min) + 2 min. */
const DEFAULT_MCP_TOOL_TIMEOUT_MS = mcpToolTimeoutMs(10 * 60_000);

export interface InvocationSettings {
  binary: string;
  model?: string;
  effort?: Effort;
}

/** The harness child's env (spec §4.4). Credentials are added by the runtime from `secretEnv`, never here. */
export function claudeCodeEnv(ctx: InvokeContext): Record<string, string> {
  return {
    HOME: ctx.paths.home,
    PWD: ctx.paths.workdir,
    CLAUDE_CONFIG_DIR: claudeConfigPaths(ctx.paths.home).configDir,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    // Subagents must finish inside the turn, and the call's own budget is the only limit on background work.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
    MCP_TOOL_TIMEOUT: String(ctx.mcpToolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS),
    // The sandbox is the security boundary; this lets the permission bypass run when a provider has only root.
    IS_SANDBOX: "1",
  };
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`budgetUsd must be a positive number of dollars, got ${value}.`);
  }
  return String(Math.round(value * 1e6) / 1e6);
}

/**
 * `claude -p --output-format stream-json --verbose ...`, with the prompt on stdin (spec §4.4). No positional prompt is
 * passed: `-p` reads the whole prompt from stdin, so nothing user-controlled reaches argv.
 */
export function claudeCodeInvocation(
  ctx: InvokeContext,
  mode: InvocationMode,
  settings: InvocationSettings,
): Invocation {
  const paths = claudeConfigPaths(ctx.paths.home);
  const argv = [settings.binary, "-p", "--output-format", "stream-json", "--verbose"];
  const model = ctx.model ?? settings.model;
  if (model) argv.push("--model", model);
  const effort = ctx.effort ?? settings.effort;
  if (effort) argv.push("--effort", effort);
  if (ctx.budgetUsd !== undefined) argv.push("--max-budget-usd", formatUsd(ctx.budgetUsd));

  let sessionId: string | undefined;
  if (mode.kind === "fresh") {
    sessionId = ctx.sessionId ?? claudeSessionId(ctx);
    if (!isUuid(sessionId)) throw new ConfigError(`Claude Code needs a UUID session id, got "${sessionId}".`);
    argv.push("--session-id", sessionId);
  } else {
    // Resume templates carry the "{sessionId}" placeholder the runtime fills in, so the id is not checked here.
    argv.push("--resume", mode.sessionId);
    if (mode.kind === "fork") argv.push("--fork-session");
    else sessionId = mode.sessionId;
  }

  argv.push("--mcp-config", paths.mcpConfig, "--strict-mcp-config", "--settings", paths.settings);
  if (ctx.systemFile) argv.push("--append-system-prompt-file", ctx.systemFile);
  argv.push("--dangerously-skip-permissions");

  return {
    argv,
    env: claudeCodeEnv(ctx),
    cwd: ctx.paths.workdir,
    stdinFile: ctx.promptFile,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}
