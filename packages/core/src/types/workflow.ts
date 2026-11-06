import type { Duration, Json } from "./common.js";
import type { SizeName } from "./sizes.js";

// Agent-written workflow scripts and start_workflow (docs/spec/demo-path.md §8, §9).

/** Limits on one script run. Every limit breach throws ScriptLimitError naming the limit. */
export interface ScriptCaps {
  /** QuickJS heap. Default 64 MiB. */
  memoryBytes?: number;
  /** QuickJS stack. Default 1 MiB. */
  stackBytes?: number;
  /** Synchronous CPU between two host calls before the isolate is interrupted. Default 1000 ms. */
  cpuSliceMs?: number;
  /** Agent calls over the whole run. Default 50. */
  maxAgentCalls?: number;
  /** Live sandboxes at once (feeds `concurrency.sandboxes`). Default 4. */
  maxSandboxes?: number;
  /** Sizes the script may ask for. Default ["small", "medium"]. */
  allowedSizes?: SizeName[];
  /** Run budget. Default 20 USD. */
  budgetUsd?: number;
  /** Wall clock for the whole run. Default "4h". */
  wallClock?: Duration;
  /** Serialised return value. Default 256 KiB. */
  maxOutputBytes?: number;
  /** Source size. Default 256 KiB. */
  maxSourceBytes?: number;
  /** PR comments and PR edits through `sb.pr` over the whole run. Default 20 (release-prep §2.3). */
  maxPrWrites?: number;
}

/** The input of the deployed `run-script` factory. */
export interface ScriptRunInput {
  /** The script source: an ES module whose default export is `async (input, sb) => Json`. */
  source: string;
  /** Default {}. */
  input?: Json;
  /** Shown in events and Slack; `^[a-z0-9][a-z0-9-]{0,47}$`. */
  name: string;
  /** Tightens the deployment's caps; never loosens them. */
  caps?: ScriptCaps;
  /** Set by start_workflow launchers; grants minted inside the run carry `depth + 1` (demo-path §9.3). */
  launchedBy?: StartWorkflowCaller;
}

/** What an agent (or a person) asks start_workflow to launch. */
export interface StartWorkflowRequest {
  name: string;
  /** Script source, at most `StartWorkflowPolicy.maxScriptBytes`. */
  script: string;
  input?: Json;
  /** The largest size the script will ask for; checked against `allowedSizes` up front. Default "small". */
  size?: SizeName;
  /** Default: the policy's `maxSandboxesPerRun`. */
  maxSandboxes?: number;
  /** Default: the policy's `maxBudgetUsd`. */
  budgetUsd?: number;
  /** No humans: every ask resolves by its AFK policy. Default false. */
  afk?: boolean;
  /** Idempotency: the same key from the same caller returns the first receipt. */
  idempotencyKey?: string;
}

/** Who asked. Agent callers are proven by a signed start grant (demo-path §9.3). */
export type StartWorkflowCaller =
  | { kind: "agent"; runId: string; callPath: string; depth: number }
  | { kind: "local"; user: string };

export interface StartWorkflowReceipt {
  runId: string;
  status: "started" | "exists";
  host: "node" | "trigger";
  /** The command a person runs to follow it. */
  watch: string;
  /** A dashboard URL when the host has one. */
  url?: string;
}

/** Guards on agent-launched runs (config key `startWorkflow`). Every refusal is a WorkflowGuardError. */
export interface StartWorkflowPolicy {
  /** Default false: start_workflow is not offered to agents. */
  enabled?: boolean;
  /** The public URL of the host's start-workflow handler; required when enabled. */
  url?: string;
  /** The declared secret the grants are signed with. Default "SELFBUILDING_START_SECRET". */
  secretName?: string;
  /** Agent-launched runs alive at once, per deployment. Default 2. */
  maxConcurrentRuns?: number;
  /** Live sandboxes across every agent-launched run. Default 4. */
  maxConcurrentSandboxes?: number;
  /** Per run. Default 2. */
  maxSandboxesPerRun?: number;
  /** Default ["small"]. */
  allowedSizes?: SizeName[];
  /** Per run. Default 10 USD. */
  maxBudgetUsd?: number;
  /** Default 262_144. */
  maxScriptBytes?: number;
  /** An agent-launched run may itself launch runs this deep. Default 1 (no grandchildren). */
  maxDepth?: number;
  /** Lifetime of a start grant handed to a sandbox. Default "2h". */
  grantTtl?: Duration;
}

/** Starts a workflow on some host. `nodeWorkflowLauncher` (cli) and `triggerWorkflowLauncher` (host-trigger). */
export interface WorkflowLauncher {
  readonly host: "node" | "trigger";
  start(req: StartWorkflowRequest, caller: StartWorkflowCaller): Promise<StartWorkflowReceipt>;
  /** Live agent-launched runs and their live sandboxes, for the concurrency guards. */
  active(): Promise<{ runs: number; sandboxes: number }>;
  /** What one launched run is doing, for get_workflow_status and `watch`. null = no such run. */
  status?(runId: string): Promise<WorkflowRunStatus | null>;
  /** Compiles a script without running it (`checkScript` from @selfbuilding/script); throws ScriptInvalidError. */
  checkScript?(source: string): Promise<void>;
}

/** The signed claims of a start grant (demo-path §9.3). `exp` is epoch milliseconds. */
export interface StartGrantPayload {
  runId: string;
  callPath: string;
  /** The depth a run launched with this grant gets: the minting run's depth + 1. */
  depth: number;
  exp: number;
  /** The calling agent's own budget slice; a launch may not ask for more. */
  budgetUsd?: number;
}

/** One agent call inside a launched run, as `get_workflow_status` and `watch` report it. */
export interface WorkflowAgentStatus {
  callPath: string;
  agent?: string;
  size?: string;
  status: "running" | "succeeded" | "failed";
  usd?: number;
}

/** A launched run, summarised from its events. */
export interface WorkflowRunStatus {
  runId: string;
  /** "running" until the run settles, then its RunStatus. */
  status: "running" | "ok" | "partial" | "failed" | "budget_exhausted" | "aborted" | "needs_attention" | "waiting";
  name?: string;
  phase?: string;
  agents: WorkflowAgentStatus[];
  /** Live sandboxes the run holds now. */
  sandboxes: number;
  usd?: number;
  launchedBy?: StartWorkflowCaller;
  startedAt?: string;
  finishedAt?: string;
  /** The run was started with `afk: true`: nobody is asked, every ask resolves by its AFK policy. */
  afk?: boolean;
  /**
   * The launch never reached its host: the trigger failed, or the process died between writing the record and
   * triggering. Calling `start()` again with the same request recovers it, so a retry must not short-circuit.
   */
  untriggered?: true;
}
