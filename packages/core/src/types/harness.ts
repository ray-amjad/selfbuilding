import type { ArtifactRef } from "./artifacts.js";
import type { Effort, Stability } from "./common.js";
import type { Secret } from "./security.js";

// Harness adapters (spec §4). Adapters are pure: they build plans and parse lines, and never touch a
// sandbox, the network or a clock.

export type HarnessId = "claude-code" | "codex" | "opencode" | "amp" | "droid" | "pi" | "grok";

/** The one version-policy type, set as the `version` option of a harness value (spec §4.11). */
export type VersionSpec = "tested" | "latest" | (string & {});

export type HarnessCredential =
  | { kind: "api-key"; value: Secret }
  | { kind: "oauth-token"; value: Secret } // long-lived subscription token, e.g. CLAUDE_CODE_OAUTH_TOKEN
  | { kind: "auth-file"; value: Secret; leased: true } // refreshable credential file, e.g. Codex auth.json
  | { kind: "provider-keys"; values: Record<string, Secret> };

/** Options every harness factory accepts, e.g. `claudeCode({ model, effort, credentials })`. */
export interface HarnessOptions {
  /** The harness's own model id, passed through unchanged. */
  model?: string;
  effort?: Effort;
  /** Default "tested". */
  version?: VersionSpec;
  /** One credential, or a pool tried in order (subscription first, API key fallback). */
  credentials?: HarnessCredential | HarnessCredential[];
}

/** Canonical sandbox paths by name. Values are defined once, in spec §6.4 (see `SANDBOX_PATHS`). */
export interface PathsContext {
  workdir: string;
  home: string;
  in: string;
  /** The attempt directory /selfbuilding/state/calls/<stepKey>/<attempt>. */
  out: string;
  bin: string;
  skills: string;
  secrets: string;
  state: string;
  run: string;
}

/** A command as an argv array. Never a shell string. */
export interface Command {
  /** argv[0] is an absolute path. */
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  user?: "agent" | "root";
  timeoutMs?: number;
}

export interface InstallPlan {
  version: string;
  commands: Command[];
  /** Absolute path of the installed binary. */
  binary: string;
}

/** A file a plan asks the runtime or host to write. Secret files are mode 0600 and never logged. */
export interface PlannedFile {
  path: string;
  content: string;
  mode: number;
  secret?: boolean;
  /**
   * Who owns the file in the box. Default: "root" for secret files, "agent" otherwise. A secret the harness itself
   * reads and rewrites (a login file it refreshes) is "agent": the harness runs as the agent user.
   */
  owner?: "agent" | "root";
}

export interface AuthContext {
  paths: PathsContext;
  /** Resolved secret values for this credential, keyed by variable name. Resolved on the orchestrator. */
  values: Record<string, string>;
}

/** Turns a credential into env vars and 0600 files. Never argv. */
export interface AuthPlan {
  /** Set only on the harness child process. */
  env: Record<string, string>;
  files: PlannedFile[];
  /** Variables belonging to the auth mode not in use; the runtime strips them from the child env. */
  stripEnv: string[];
  /**
   * Set for leased credential files: copy back to the pool when the call ends. The agent can write the file, so a
   * returned copy is kept only when `accepts(returned)` says it is still the same login (refreshed, not replaced).
   */
  leasedFile?: { path: string; accepts?: (returned: string) => boolean };
  /**
   * Env var → secret file among `files`. The runtime reads each file and sets the value on the harness child only
   * (copied into `HarnessRunPlan.secretEnv`), so the value never appears in a plan's env.
   */
  secretEnv?: Record<string, string>;
}

export type McpServerSpec =
  | { name: string; type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; type: "http"; url: string; headers?: Record<string, string> };

export interface PrepareContext {
  runId: string;
  callPath: string;
  attempt: number;
  paths: PathsContext;
  /** Names of the skills materialised under `{skills}`. */
  skills: string[];
  /** The `selfbuilding` server is always first and cannot be shadowed. */
  mcpServers: McpServerSpec[];
  /** Effective hot wait; the adapter sets the MCP tool timeout to this + 2 min (spec §6.11). */
  hotWaitMs: number;
  model?: string;
  effort?: Effort;
}

/** Config files for one agent call: MCP servers, hooks, skill links, instructions, settings. */
export interface FilePlan {
  files: PlannedFile[];
  /** Skill links under `{workdir}`; also added to .git/info/exclude. */
  symlinks: { path: string; target: string }[];
  gitExcludes: string[];
  /** The per-call MCP tool timeout this adapter set; null = no limit (spec §8.4). */
  mcpToolTimeoutMs: number | null;
}

export interface InvokeContext {
  runId: string;
  callPath: string;
  attempt: number;
  model?: string;
  effort?: Effort;
  paths: PathsContext;
  /** {in}/prompt.md */
  promptFile: string;
  /** {in}/system.md */
  systemFile?: string;
  /** Passed to the native cap if there is one, as a backstop. */
  budgetUsd?: number;
  /** Preassigned session id for harnesses that accept one. */
  sessionId?: string;
  /** `FilePlan.mcpToolTimeoutMs` from `prepare()`, for harnesses that take the MCP tool timeout as env (§6.11). */
  mcpToolTimeoutMs?: number;
  /**
   * The servers `prepare()` was given. Harnesses that configure MCP on the command line (Codex) render them
   * from here; absent, they fall back to the `selfbuilding` server alone.
   */
  mcpServers?: McpServerSpec[];
  /** The effective hot wait `prepare()` was given; harnesses that set the MCP tool timeout per invocation use it. */
  hotWaitMs?: number;
}

export interface Invocation {
  /** argv[0] is an absolute path, never a PATH lookup. */
  argv: string[];
  env: Record<string, string>;
  /** Always {workdir}. */
  cwd: string;
  /** The runtime redirects stdin from this file, then closes it. */
  stdinFile?: string;
  /** Set when preassigned. */
  sessionId?: string;
}

export interface SessionTransfer {
  /** Run in the old sandbox; files land under {state}. */
  capture: Command[];
  /** Run in the new sandbox after install, before resume(). */
  restore: Command[];
  /** Paths captured, relative to {home}. */
  files: string[];
}

/** Stored with every captured session. A resume runs exactly `harnessVersion`. */
export interface SessionArtifact {
  harness: HarnessId | (string & {});
  harnessVersion: string;
  sessionId: string;
  ref: ArtifactRef;
}

export interface ParseContext {
  runId: string;
  callPath: string;
  attempt: number;
  /** Keep dropped lines as redacted raw attachments (`debug.rawEvents`). */
  rawEvents?: boolean;
}

export interface HarnessFailure {
  code:
    | "auth"
    | "quota"
    | "rate_limit"
    | "billing"
    | "invalid_request"
    | "context_overflow"
    | "provider"
    | "harness_crash"
    | "unknown";
  retryable: boolean;
  retryAfterMs?: number;
  /** Unwrapped from nested vendor JSON. */
  message: string;
}

/** What `classify()` is given: a native error event from the stream, or the process exit. */
export type FailureSignal =
  | { kind: "event"; event: unknown }
  | { kind: "exit"; code: number | null; signal: string | null; stderrTail: string };

export type HarnessEvent =
  | {
      type: "session.started";
      sessionId: string;
      model?: string;
      tools?: string[];
      mcp?: { name: string; status: "connected" | "failed" | "pending"; error?: string }[];
    }
  | { type: "message.delta"; kind: "text" | "thinking"; text: string }
  | { type: "message"; role: "assistant"; text: string }
  | {
      type: "tool.started";
      callId: string;
      name: string;
      source: "builtin" | "mcp" | "skill" | "subagent";
      server?: string;
      /** Anything not on the read-only allowlist is "effect" (spec §4.3). */
      effect: "read" | "effect";
      input?: unknown;
      summary: string;
    }
  | {
      type: "tool.completed";
      callId: string;
      name: string;
      ok: boolean;
      output?: string;
      truncatedBytes?: number;
      durationMs?: number;
    }
  | { type: "file.changed"; path: string; change: "add" | "modify" | "delete" }
  | { type: "retry"; attempt: number; delayMs?: number; cause: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      reasoningTokens?: number;
      costUsd?: number;
      cumulative: boolean;
    }
  | { type: "warning"; message: string }
  | { type: "error"; failure: HarnessFailure }
  | { type: "turn.ended"; reason: "end_turn" | "max_turns" | "budget" | "interrupted" | "error" };

/** One parser per process. Stateful, because some formats need lookback. */
export interface HarnessParser {
  /** One complete line, without its "\n". */
  line(line: string): HarnessEvent[];
  end(exit: { code: number | null; signal: string | null }): HarnessEvent[];
  sessionId(): string | undefined;
}

export interface HarnessCapabilities {
  promptVia: "stdin" | "file-ref";
  /** The session id can be chosen before launch. */
  preassignSessionId: boolean;
  /** bridge: Selfbuilding tools only, through a harness extension. */
  mcp: "native" | "bridge";
  /** How the run ends after a valid submit_result (spec §4.5). */
  stopAfterSubmit: "hook" | "kill";
  usage: "usd" | "tokens" | "none";
  nativeBudgetCap: boolean;
  effort: readonly Effort[];
  /** Directories, relative to {workdir}, the harness discovers skills from. */
  skillDirs: readonly string[];
  subscriptionAuth: boolean;
  needsGlibc: boolean;
  /** A fixed per-call MCP tool timeout, when the harness cannot raise it. */
  mcpToolTimeoutMs?: number;
  /**
   * The bundled runtime parser that reads this harness's stream. Real adapters use their own id; the
   * scripted test harness emits a real harness's native format and names it here.
   */
  streamFormat?: HarnessId;
}

/** The one harness interface (spec §4.2). Capabilities that are operations are methods, never booleans. */
export interface Harness {
  /** Third-party adapters use their own id. */
  readonly id: HarnessId | (string & {});
  readonly stability: Stability;
  readonly capabilities: HarnessCapabilities;
  /** The options the harness value was built with. Serialisable; secrets stay as `Secret` values. */
  readonly options: HarnessOptions;
  /** The exact version this release pins for `version: "tested"` (harness-versions, spec §4.11). */
  readonly testedVersion?: string;

  /** Commands that install the CLI at an exact version. Skipped when the image already has it. */
  install(version: string): InstallPlan;
  /** Hosts the install plan needs to reach; added to the egress allowlist when an install is planned. */
  installHosts(): string[];
  /** `<bin> --version`, run at the start of every agent call. */
  versionCommand(): Command;
  parseVersion(stdout: string): string;

  /** Turns a credential into env vars and 0600 files. Never argv. */
  auth(cred: HarnessCredential, ctx: AuthContext): AuthPlan;
  /** Config files for one agent call. */
  prepare(ctx: PrepareContext): FilePlan;

  /** A fresh session. */
  invoke(ctx: InvokeContext): Invocation;
  /** Continue a session with a new user message. Absent: the harness cannot resume. */
  resume?(ctx: InvokeContext & { sessionId: string }): Invocation;
  /** Branch a session into a new one. Absent: the harness cannot fork. */
  fork?(ctx: InvokeContext & { sessionId: string }): Invocation;
  /** Move a session between sandboxes. Absent: resume works only in the same sandbox. */
  sessionArtifacts?(sessionId: string, ctx: PathsContext): SessionTransfer;

  createParser(ctx: ParseContext): HarnessParser;
  /** Only the adapter reads vendor text. */
  classify(signal: FailureSignal): HarnessFailure;
  /** The model-visible name of an MCP tool, e.g. "mcp__selfbuilding__submit_result". */
  toolName(server: string, tool: string): string;
}
