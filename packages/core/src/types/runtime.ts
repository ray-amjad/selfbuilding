import type { ErrorCode } from "../errors/codes.js";
import type { Usage } from "./artifacts.js";
import type { AskResolution, AskSpec } from "./ask.js";
import type { JsonSchema } from "./common.js";
import type { SelfbuildingEvent } from "./events.js";
import type { HarnessFailure, HarnessId, Invocation } from "./harness.js";
import type { CallbackTarget, LaunchId } from "./host.js";

// The runtime ↔ host contract (spec §6). docs/BUILD-MAP.md quotes it; this file is the typed source.

/** Canonical sandbox paths (spec §6.4). Identical on every provider, generation and box. */
export const SANDBOX_PATHS = {
  bin: "/selfbuilding/bin",
  runtimeBundle: "/selfbuilding/bin/selfbuilding-runtime.mjs",
  mcpBundle: "/selfbuilding/bin/selfbuilding-mcp.mjs",
  nsReap: "/selfbuilding/bin/ns-reap",
  runtimeVersion: "/selfbuilding/runtime-version",
  skills: "/selfbuilding/skills",
  contract: "/selfbuilding/contract/result.schema.json",
  in: "/selfbuilding/in",
  workdir: "/selfbuilding/work",
  home: "/selfbuilding/home",
  out: "/selfbuilding/out",
  state: "/selfbuilding/state",
  boxMarker: "/selfbuilding/state/box.json",
  imageStamp: "/selfbuilding/state/image.json",
  setupDone: "/selfbuilding/state/setup.done",
  launches: "/selfbuilding/state/launches",
  proc: "/selfbuilding/state/proc",
  calls: "/selfbuilding/state/calls",
  logs: "/selfbuilding/state/logs",
  run: "/run/selfbuilding",
  callLock: "/run/selfbuilding/call.lock",
  supervisorPid: "/run/selfbuilding/supervisor.pid",
  toolSocket: "/run/selfbuilding/tools.sock",
  secrets: "/run/selfbuilding/secrets",
  gitCredentialHelper: "/run/selfbuilding/bin/git-credential-selfbuilding",
  /** The repo read token for the runtime's clone at boot. Root-only; the agent user cannot read it. */
  gitReadToken: "/run/selfbuilding/secrets/GIT_READ_TOKEN",
  /** The start_workflow grant (demo-path §9.3); root-only, read by the supervisor. */
  startGrant: "/run/selfbuilding/secrets/START_WORKFLOW_GRANT",
} as const;

/** Files inside one attempt directory, `/selfbuilding/state/calls/<stepKey>/<attempt>/`. */
export const ATTEMPT_FILES = {
  spec: "spec.json",
  state: "state.json",
  events: "events.jsonl",
  submissions: "submissions",
  result: "result.json",
  outcome: "outcome.json",
  /** Written by `ack`; the runtime deletes nothing before it exists. */
  outcomeAck: "outcome.ack",
  cancel: "cancel",
  wake: "wake.json",
  inbox: "inbox",
  inboxOpen: "inbox/.open",
  runtimeLog: "runtime.log",
  harnessStderr: "harness.stderr.log",
  hooks: "hooks",
  protected: "protected",
} as const;

/** Env vars the host may set on runtime execs. Never secrets. */
export const RUNTIME_ENV = {
  /** Test providers only: the host directory standing in for "/" (see SandboxProvider.fsRoot). */
  fsRoot: "SELFBUILDING_FS_ROOT",
  runId: "SELFBUILDING_RUN_ID",
  hook: "SELFBUILDING_HOOK",
  bootMode: "SELFBUILDING_BOOT_MODE",
} as const;

/** Runtime process exit codes (spec §6.15). */
export const RUNTIME_EXIT = {
  ok: 0,
  transient: 75,
  generationMismatch: 76,
  config: 78,
} as const;

export type BootMode = "fresh" | "reuse" | "restore" | "repo-image" | "build";

export type BootPhase = "runtime" | "sync" | "setup" | "start" | "skills" | "harness" | "ready";

/** The agent call state machine (spec §6.7). The host journal is authoritative. */
export type CallState =
  | "planned"
  | "provisioning"
  | "booting"
  | "running"
  | "waiting"
  | "suspended"
  | "settling"
  | "unknown"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type TerminalCallState = "succeeded" | "failed" | "cancelled" | "timed_out";

/** Every timeout resolved to milliseconds for one call (spec §6.11). */
export interface ResolvedTimeouts {
  /** The call's active-time limit (`timeout`). */
  callMs: number;
  idleMs: number;
  setupMs: number;
  startMs: number;
  bootMs: number;
  postSubmitGraceMs: number;
  cancelGraceMs: number;
  /** Internal: harness exited but descendants hold stdout. */
  exitQuietMs: number;
  /** Effective hot wait + 2 min. */
  mcpToolMs: number;
}

export interface GitSpec {
  /** "remote": clone/fetch with the read token. "local": a git bundle copied in (Docker, unpushed work). */
  mode: "remote" | "local";
  /** "github.com/acme/api". */
  repo?: string;
  /** https URL; credentials come from the credential helper, never the URL. */
  remoteUrl?: string;
  /** Path of the uploaded bundle when mode is "local". */
  bundlePath?: string;
  /** The working branch; `branchName(runId, scope)` unless overridden. */
  branch: string;
  baseBranch: string;
  /** Recorded at checkout when absent. */
  baseSha?: string;
  /** Read-only agents (`artifacts.branch: "forbidden"`) check out the review head and must not commit. */
  readOnly: boolean;
  /** Review agents: the diff written to /selfbuilding/in/diff.patch. */
  review?: { baseSha: string; headSha: string };
  commitLeftovers: boolean;
  identity: { authorName: string; authorEmail: string; committerName: string; committerEmail: string };
  /** Added to every commit by the supervisor and the prepare-commit-msg hook. */
  trailers: { run: string; call: string; agent: string };
  /** Refs the host may push beyond refs/heads/selfbuilding/** and refs/selfbuilding/**. */
  allowPushTo: string[];
}

/** A done check of the kinds that run in the sandbox (spec §2.7). `assert` checks run on the host. */
export interface RuntimeDoneCheck {
  id: string;
  cmd: string;
  cwd?: string;
  timeoutMs?: number;
  expectExit?: number;
}

/**
 * The precomputed harness plan. The host calls the pure adapter; the runtime executes the plan and
 * normalises the stream with its bundled parser for `streamFormat`.
 */
export interface HarnessRunPlan {
  /** Which bundled parser reads stdout: "claude-code" or "codex" in the basic build. */
  streamFormat: HarnessId;
  /** The fresh-session invocation for the first turn. */
  invocation: Invocation;
  /**
   * Template for follow-up turns on the same session (nudges, done-check feedback, ask answers,
   * interrupted resumes). The runtime substitutes "{sessionId}" and "{promptFile}" in argv and stdinFile.
   * Absent: the harness cannot resume.
   */
  resume?: Invocation;
  stopAfterSubmit: "hook" | "kill";
  /** Variables stripped from the child env (the auth mode not in use). */
  stripEnv: string[];
  /** Secret file → env var on the harness child only, e.g. { ANTHROPIC_API_KEY: "/run/selfbuilding/secrets/ANTHROPIC_API_KEY" }. */
  secretEnv: Record<string, string>;
  /** Exact command whose output is recorded as the version that ran. */
  versionArgv: string[];
}

/** spec.json, staged atomically by the host at `<attempt>.tmp/` then renamed into place (spec §6.4). */
export interface RuntimeSpec {
  v: 1;
  runId: string;
  /** Display only: `<runId>.<callPath>`. */
  callId: string;
  callPath: string;
  /** Directory name under state/calls/. */
  stepKey: string;
  attempt: number;
  launchId: LaunchId;
  harness: HarnessId | (string & {});
  /** Exact version; the host resolves the policy first. */
  harnessVersion: string;
  /** Pre-assigned where the harness allows. */
  sessionId?: string;
  /** Set on resume and follow-up turns. */
  resumeSessionId?: string;
  /** Draft-07; also written to /selfbuilding/contract/result.schema.json. */
  resultSchema: JsonSchema;
  /** Default 262_144, at most 1 MiB. */
  maxResultBytes: number;
  git: GitSpec;
  timeouts: ResolvedTimeouts;
  /** Effective hot wait for this call. */
  hotWaitMs: number;
  /** HMAC key for wake callbacks. Redacted everywhere. */
  callbackToken?: string;
  /** Names only; values arrive as files under /run/selfbuilding/secrets. */
  env: { declared: string[] };

  // Fields below extend the spec's RuntimeSpec with what the runtime needs to drive a turn (BUILD-MAP §3).
  /** The agent's display name for commit subjects and trailers. */
  agentName: string;
  bootMode: BootMode;
  plan: HarnessRunPlan;
  /** Default 3. */
  maxSubmitAttempts: number;
  /** Default 1. */
  maxResumes: number;
  /** Default 2. */
  maxDoneRetries: number;
  /** In-sandbox done checks, in order; `tests` first when a testCommand resolved. */
  doneChecks: RuntimeDoneCheck[];
  /** Paths restored from base while checks run (spec §2.7.4). */
  protect: { paths: string[]; allow: string[] };
  /** The built-in checks implied by the contract (spec §2.7.3). */
  artifactsBranch: "required" | "optional" | "forbidden";
  /** Per-agent budget slice; the runtime stops the harness when crossed. */
  budgetUsd?: number;
  /** Default "revert" (spec §4.5.1). */
  postSubmitChanges: "revert" | "keep";
  /** 0 = off. */
  wipPushIntervalMs: number;
  escrow?: { url: string; expiresAt: string };
  /** Hooks supplied in code replace .selfbuilding/setup.sh and start.sh for this call. */
  hooks?: { setup?: HookSpec; start?: HookSpec };
  /** Skills materialised under /selfbuilding/skills and linked into these dirs relative to the workdir. */
  skills: { names: string[]; linkDirs: string[] };
  requireIsolation: boolean;
  /** Turn index base for budget accounting across launches. */
  turnIndexBase: number;
  /**
   * Set when the call may launch workflows (demo-path §9.3). The supervisor, never the agent, reads the grant at
   * `SANDBOX_PATHS.startGrant` and POSTs the request to `url`.
   */
  startWorkflow?: { url: string };
}

export interface HookSpec {
  command: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}

/** state.json, written by the supervisor (spec §6.4). */
export interface RuntimeState {
  phase: CallState;
  bootPhase?: BootPhase;
  launchId: LaunchId;
  pids: { supervisor?: number; harness?: number; harnessPgid?: number };
  sessionId?: string;
  lastSeq: number;
  /** ISO, every 15 s. */
  heartbeatAt: string;
  /** Active-time clocks; paused while waiting. */
  clock: { activeMs: number; paused: boolean };
  askSeq: number;
  turnIndex: number;
  /** Set when the harness process was spawned. Absent = positive evidence nothing ran. */
  harnessStartedAt?: string;
  pendingAsk?: { askId?: string; askSeq: number; spec: AskSpec };
  /** Recorded at an accepted submit (spec §4.5.1). */
  submitTree?: { headSha: string; treeSha: string; at: string };
  wip?: { sha: string; at: string };
  isolation?: "isolated" | "same-user";
}

/** Events in events.jsonl: the envelope plus a payload. `seq` is monotonic per launch. */
export type RuntimeEvent = SelfbuildingEvent;

/** outcome.json, created once with O_EXCL (spec §6.7). */
export interface Outcome {
  callId: string;
  attempt: number;
  launchId: LaunchId;
  status: TerminalCallState;
  reason?: ErrorCode;
  /** Re-validated on the host before use. */
  result?: unknown;
  sessionId?: string;
  git: { branch?: string; baseSha?: string; headSha?: string; pushed: boolean; autoCommitted?: boolean };
  usage?: Usage;
  /** The harness's classified failure, when a turn failed on one (the pool reads it for account failures). */
  failure?: HarnessFailure;
  harnessVersion: string;
  /** Redacted, actionable. */
  message?: string;
  attempts?: { submits: number; resumes: number; doneRetries: number };
  checks?: { id: string; ok: boolean; verified: boolean; protectedChanged?: string[] }[];
  /** Paths relative to the attempt dir the host uploads: transcript, diff, logs, files. */
  artifacts?: { transcript?: string; diff?: string; logs?: string[]; files?: string[]; postSubmitPatch?: string };
  isolation?: "isolated" | "same-user";
}

/** `selfbuilding-runtime wait` output (spec §6.6). One JSON object on stdout, ≤ 256 KiB. */
export interface WaitResponse {
  events: RuntimeEvent[];
  lastSeq: number;
  state: RuntimeState | null;
  pendingAsk?: AskSpec;
  outcome?: Outcome;
  /** The turn lock as the runtime saw it. */
  lock: "FREE" | "BUSY";
}

/** `selfbuilding-runtime launch` output: what the host must do next. */
export type LaunchProbe =
  | { action: "start" } // marker newly written; the host spawns `supervise` detached
  | { action: "reattached" } // marker exists and the turn lock is held
  | { action: "interrupted"; harnessStarted: boolean } // marker exists, lock FREE, no outcome
  | { action: "settled"; outcome: Outcome } // outcome.json already exists
  /** Lock FREE, no outcome, the turn ended for a cold ask: the session waits for its answer, not a re-run. */
  | { action: "suspended" };

/** launches/<launchId>.status, rewritten by the runtime on every state change; read by the plain Node wait. */
export interface LaunchStatus {
  launchId: LaunchId;
  state: CallState;
  lastSeq: number;
  hasOutcome: boolean;
  pendingAsk: boolean;
  at: string;
}

/** wake.json, mode 0600, written by the host before each armed wait (spec §6.6). */
export interface WakeFile {
  launchId: LaunchId;
  rearm: number;
  target: CallbackTarget;
}

/** inbox/<askId>.json, written by the host as the agent user while inbox/.open exists (spec §6.9). */
export interface InboxAnswer {
  askId: string;
  resolution: AskResolution;
}

/** cancel sentinel, written by the host (spec §6.10). */
export interface CancelSentinel {
  reason: string;
  at: string;
}

/** box.json marker (spec §3.11, §5.8). */
export interface BoxMarker {
  runId: string;
  boxId: string;
  version: number;
  generation: string;
  sandboxId: string;
}

/** The `ready` boot event payload (spec §6.5). */
export interface ReadyEvent {
  runtimeVersion: string;
  harness: string;
  harnessVersion: string;
  isolation: "isolated" | "same-user";
  baseSha: string;
  bootMode: BootMode;
  /** The supervisor uid the host checks result.json ownership against. */
  supervisorUid: number;
  agentUid: number;
}

/** Tool socket protocol between selfbuilding-mcp and the supervisor: one JSON object per line. */
export type ToolSocketRequest =
  | { id: number; kind: "hello"; pid: number }
  | {
      id: number;
      kind: "tool";
      /** `start_workflow` and `get_workflow_status` only when the spec carries `startWorkflow` (demo-path §9.3). */
      tool: "submit_result" | "ask_human" | "notify_human" | "start_workflow" | "get_workflow_status";
      input: unknown;
    };

export interface ToolSocketResponse {
  id: number;
  /** Text returned to the model as the tool result. */
  content: string;
  isError: boolean;
  /** ask_human only: the ask moved to a cold wait; the harness must end its turn. */
  suspended?: boolean;
}
