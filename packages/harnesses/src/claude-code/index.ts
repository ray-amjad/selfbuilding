import { ConfigError, type Harness, type HarnessCapabilities, type HarnessOptions } from "@selfbuilding/core";
import { claudeCodeAuth } from "./auth.js";
import { classifyClaudeFailure } from "./classify.js";
import { CLAUDE_EFFORTS, claudeCodeInvocation } from "./invocation.js";
import { createClaudeCodeParser } from "./parser.js";
import { CLAUDE_SKILL_DIR, claudeCodePrepare } from "./prepare.js";
import { claudeSessionArtifacts } from "./session.js";
import {
  CLAUDE_CODE_BINARY,
  CLAUDE_CODE_INSTALL_HOSTS,
  CLAUDE_CODE_TESTED_VERSION,
  claudeCodeInstallPlan,
  parseClaudeCodeVersion,
} from "./version.js";

export { API_KEY_VAR, claudeCodeAuth, claudeCredentialVariable, OAUTH_TOKEN_VAR } from "./auth.js";
export { classifyClaudeFailure, classifyEvent, classifyExit, classifyText, unwrapMessage } from "./classify.js";
export { CLAUDE_EFFORTS, claudeCodeEnv, claudeCodeInvocation, type InvocationMode } from "./invocation.js";
export {
  createClaudeCodeParser,
  MAX_LINE_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  READ_ONLY_TOOLS,
  splitMcpName,
} from "./parser.js";
export {
  type ClaudeCredentialPool,
  claudeCredentialPool,
  isAccountFailure,
  type PoolDecision,
} from "./pool.js";
export {
  CLAUDE_SKILL_DIR,
  claudeCodePrepare,
  claudeConfigPaths,
  MCP_TOOL_TIMEOUT_MARGIN_MS,
  mcpToolTimeoutMs,
  renderMcpConfig,
  renderSettings,
  SELFBUILDING_SERVER,
  SUBMIT_TOOL,
} from "./prepare.js";
export { claudeSessionArtifacts, claudeSessionFiles, claudeSessionId, encodeProjectDir, uuidv5 } from "./session.js";
export {
  CLAUDE_CODE_BINARY,
  CLAUDE_CODE_INSTALL_HOSTS,
  CLAUDE_CODE_NPM_PACKAGE,
  CLAUDE_CODE_TESTED_VERSION,
  claudeCodeImageInstallCommand,
  claudeCodeInstallPlan,
  isExactVersion,
  parseClaudeCodeVersion,
  resolveClaudeCodeVersion,
  type VersionResolution,
} from "./version.js";

export interface ClaudeCodeOptions extends HarnessOptions {
  /** Absolute path of the CLI. Default `/usr/local/bin/claude`, where official images install it. */
  binary?: string;
}

export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = {
  promptVia: "stdin",
  preassignSessionId: true,
  mcp: "native",
  stopAfterSubmit: "hook",
  usage: "usd",
  nativeBudgetCap: true,
  effort: CLAUDE_EFFORTS,
  skillDirs: [CLAUDE_SKILL_DIR],
  subscriptionAuth: true,
  needsGlibc: false,
  streamFormat: "claude-code",
};

/**
 * The Claude Code harness (spec §4.4, §4.10). Credentials: `oauth-token` (CLAUDE_CODE_OAUTH_TOKEN) or `api-key`, or a
 * pool of both, tried subscription first (see `claudeCredentialPool`).
 */
export function claudeCode(opts: ClaudeCodeOptions = {}): Harness {
  const binary = opts.binary ?? CLAUDE_CODE_BINARY;
  if (!binary.startsWith("/")) {
    throw new ConfigError(`claudeCode({ binary }) must be an absolute path, got "${binary}".`);
  }
  const options: ClaudeCodeOptions = { version: "tested", ...opts };
  const settings = {
    binary,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.effort === undefined ? {} : { effort: opts.effort }),
  };

  return {
    id: "claude-code",
    stability: "stable",
    capabilities: CLAUDE_CODE_CAPABILITIES,
    options,
    testedVersion: CLAUDE_CODE_TESTED_VERSION,

    install: (version) => claudeCodeInstallPlan(version, binary),
    installHosts: () => [...CLAUDE_CODE_INSTALL_HOSTS],
    versionCommand: () => ({ argv: [binary, "--version"], env: { DISABLE_AUTOUPDATER: "1" }, timeoutMs: 15_000 }),
    parseVersion: parseClaudeCodeVersion,

    auth: claudeCodeAuth,
    prepare: claudeCodePrepare,

    invoke: (ctx) => claudeCodeInvocation(ctx, { kind: "fresh" }, settings),
    resume: (ctx) => claudeCodeInvocation(ctx, { kind: "resume", sessionId: ctx.sessionId }, settings),
    fork: (ctx) => claudeCodeInvocation(ctx, { kind: "fork", sessionId: ctx.sessionId }, settings),
    sessionArtifacts: claudeSessionArtifacts,

    createParser: createClaudeCodeParser,
    classify: classifyClaudeFailure,
    toolName: (server, tool) => `mcp__${server}__${tool}`,
  };
}
