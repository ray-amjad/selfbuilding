import type {
  FilePlan,
  Harness,
  HarnessCapabilities,
  HarnessOptions,
  PlannedFile,
  PrepareContext,
} from "@selfbuilding/core";
import { codexAuth } from "./auth.js";
import { classifyCodexFailure } from "./classify.js";
import { CODEX_DEFAULT_BINARY, CODEX_INSTALL_HOSTS, CODEX_TESTED_VERSION } from "./constants.js";
import { codexInvocation } from "./invocation.js";
import { mcpEnvFiles, mcpToolTimeoutMs, normaliseServers } from "./mcp.js";
import { createCodexParser } from "./parser.js";
import { codexSessionTransfer } from "./session.js";
import { codexInstallPlan, parseCodexVersion } from "./version.js";

export interface CodexOptions extends HarnessOptions {
  /** Absolute path of the CLI. Default `/usr/local/bin/codex`, where images and `install()` put it. */
  binary?: string;
}

/** Skill folders are linked here, relative to `{workdir}` (spec §4.6). */
const SKILL_DIR = ".agents/skills";

export const CODEX_CAPABILITIES: HarnessCapabilities = {
  promptVia: "stdin",
  preassignSessionId: false,
  mcp: "native",
  // Codex keeps generating after a successful submit_result, so the runtime stops it (spec §4.5).
  stopAfterSubmit: "kill",
  usage: "tokens",
  nativeBudgetCap: false,
  effort: ["low", "medium", "high", "max"],
  skillDirs: [SKILL_DIR],
  subscriptionAuth: true,
  needsGlibc: false,
  streamFormat: "codex",
};

// --ignore-user-config means Codex never reads this file. It is written anyway so CODEX_HOME exists (Codex refuses
// to start without it) and so a config.toml left on a shared box by an earlier agent is overwritten.
const CONFIG_PLACEHOLDER =
  "# Written by selfbuilding. Codex runs with --ignore-user-config; settings arrive as -c overrides.\n";

function prepare(ctx: PrepareContext): FilePlan {
  const servers = normaliseServers(ctx.mcpServers, ctx.paths);
  const files: PlannedFile[] = [
    { path: `${ctx.paths.home}/.codex/config.toml`, content: CONFIG_PLACEHOLDER, mode: 0o644 },
    ...mcpEnvFiles(servers, ctx.paths),
  ];
  const links = ctx.skills.map((name) => ({
    path: `${ctx.paths.workdir}/${SKILL_DIR}/${name}`,
    target: `${ctx.paths.skills}/${name}`,
  }));
  return {
    files,
    symlinks: links,
    gitExcludes: ctx.skills.map((name) => `/${SKILL_DIR}/${name}`),
    mcpToolTimeoutMs: mcpToolTimeoutMs(ctx.hotWaitMs),
  };
}

/** The Codex harness (spec §4.4, §4.10). Credentials: a leased `auth-file` (auth.json) or an `api-key`. */
export function codex(opts: CodexOptions = {}): Harness {
  const binary = opts.binary ?? CODEX_DEFAULT_BINARY;
  const invocationOptions = {
    binary,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.effort === undefined ? {} : { effort: opts.effort }),
  };
  return {
    id: "codex",
    stability: "stable",
    capabilities: CODEX_CAPABILITIES,
    options: { ...opts, version: opts.version ?? "tested" },
    testedVersion: CODEX_TESTED_VERSION,

    install: (version) => codexInstallPlan(version, binary),
    installHosts: () => [...CODEX_INSTALL_HOSTS],
    versionCommand: () => ({ argv: [binary, "--version"], timeoutMs: 30_000 }),
    parseVersion: parseCodexVersion,

    auth: codexAuth,
    prepare,

    invoke: (ctx) => codexInvocation(ctx, invocationOptions, "fresh"),
    resume: (ctx) => codexInvocation(ctx, invocationOptions, "resume", ctx.sessionId),
    fork: (ctx) => codexInvocation(ctx, invocationOptions, "fork", ctx.sessionId),
    sessionArtifacts: codexSessionTransfer,

    createParser: createCodexParser,
    classify: classifyCodexFailure,
    // Codex 0.164 shows MCP tools to the model under their standard `mcp__<server>__<tool>` identifiers.
    toolName: (server, tool) => `mcp__${server}__${tool}`,
  };
}

export { type AuthFileStatus, authFilePath, authFileStatus, type CodexAuthFile, parseAuthFile } from "./auth.js";
export { classifyCodexFailure, classifyCodexMessage } from "./classify.js";
export { CODEX_DEFAULT_BINARY, CODEX_NPM_PACKAGE, CODEX_TESTED_VERSION } from "./constants.js";
export { CODEX_EFFORT } from "./invocation.js";
export {
  type AuthFileLease,
  AuthFileLeases,
  type AuthFileLeasesOptions,
  type AuthFileRelease,
  chooseAuthFile,
} from "./lease.js";
export { createCodexParser } from "./parser.js";
export {
  credentialFailover,
  credentialPool,
  type FailoverDecision,
  type FailoverInput,
  isAccountFailure,
  isSubscription,
  pickCredential,
  resumeNudge,
} from "./pool.js";
export {
  type CodexVersionInput,
  isExactVersion,
  parseCodexVersion,
  type ResolvedCodexVersion,
  resolveCodexVersion,
} from "./version.js";
