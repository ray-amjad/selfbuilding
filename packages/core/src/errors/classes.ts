import type { HarnessFailure, HarnessId } from "../types/harness.js";
import type { SizeRefusal } from "../types/sizes.js";
import { SelfbuildingError, type SelfbuildingErrorOptions, SelfbuildingUsageError } from "./base.js";
import type { ErrorCode } from "./codes.js";

// The error registry (spec §9.8). One class per row; `registry.ts` lists them all for the registry test.
// Constructors take the class-specific fields first and a default message is built from them;
// `opts.message` overrides it. Messages say what to do next.

type Opts = SelfbuildingErrorOptions;

/** Where a sandbox error came from. Every sandbox class carries it (spec §5.3). */
export interface SandboxErrorContext {
  provider: string;
  sandboxId?: string;
}

// ───────────────────────────── usage and configuration ─────────────────────────────

export class ConfigError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "config";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

/** The §6.11 timeout chain is broken. Names the two values. */
export class TimeoutOrderError extends ConfigError {
  override readonly code: ErrorCode = "timeout_order";
  readonly first: string;
  readonly second: string;
  constructor(fields: { first: string; second: string }, opts?: Opts) {
    super(
      `Timeout order violated: ${fields.first} must be shorter than ${fields.second}. Lower the first or raise the second.`,
      opts,
    );
    this.first = fields.first;
    this.second = fields.second;
  }
  protected override details(): Record<string, unknown> {
    return { first: this.first, second: this.second };
  }
}

/** A call cannot fit the provider's session maximum, even with continuation (spec §7.7). */
export class ProviderLifetimeError extends ConfigError {
  override readonly code: ErrorCode = "provider_lifetime";
  readonly provider: string;
  readonly maxLifetimeMs: number;
  readonly timeoutMs: number;
  constructor(fields: { provider: string; maxLifetimeMs: number; timeoutMs: number }, opts?: Opts) {
    super(
      `Provider "${fields.provider}" allows sessions of ${fields.maxLifetimeMs} ms, but the call timeout is ${fields.timeoutMs} ms plus a 15 min margin. Lower the timeout or use a harness and placement that can continue on a new box.`,
      opts,
    );
    this.provider = fields.provider;
    this.maxLifetimeMs = fields.maxLifetimeMs;
    this.timeoutMs = fields.timeoutMs;
  }
  protected override details(): Record<string, unknown> {
    return { provider: this.provider, maxLifetimeMs: this.maxLifetimeMs, timeoutMs: this.timeoutMs };
  }
}

export class NestingDepthError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "nesting_depth";
  readonly retryable: boolean = false;
  constructor(
    message = "Factories nest one level deep. Start deeper trees as separate runs with run() inside a step().",
    opts?: Opts,
  ) {
    super(message, opts);
  }
}

export class NonDeterminismError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "non_determinism";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class DuplicateLabelError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "duplicate_label";
  readonly retryable: boolean = false;
  readonly label: string;
  constructor(fields: { label: string }, opts?: Opts) {
    super(`Label "${fields.label}" is used twice in one scope. Labels and step names must be unique per scope.`, opts);
    this.label = fields.label;
  }
}

export class SandboxHandleScopeError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "sandbox_handle_scope";
  readonly retryable: boolean = false;
  constructor(
    message = "A shared sandbox handle was used from a concurrent scope that did not create it. Use fork() for concurrent work.",
    opts?: Opts,
  ) {
    super(message, opts);
  }
}

export class SandboxBusyError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "sandbox_busy";
  readonly retryable: boolean = false;
  constructor(
    message = "The sandbox handle is already running a call. Await it first, or fork() for concurrent work.",
    opts?: Opts,
  ) {
    super(message, opts);
  }
}

export class NotOwnerError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "not_owner";
  readonly retryable: boolean = false;
  constructor(
    message = "This sandbox handle is borrowed. Only the scope that created it may dispose it.",
    opts?: Opts,
  ) {
    super(message, opts);
  }
}

export class SandboxCapDeadlockError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "sandbox_cap_deadlock";
  readonly retryable: boolean = false;
  readonly holders: string[];
  readonly waiters: string[];
  constructor(fields: { holders: string[]; waiters: string[] }, opts?: Opts) {
    super(
      `concurrency.sandboxes can never admit the waiting calls (${fields.waiters.join(", ")}); every slot is held by ${fields.holders.join(", ")}. Raise the cap or restructure the factory.`,
      opts,
    );
    this.holders = fields.holders;
    this.waiters = fields.waiters;
  }
  protected override details(): Record<string, unknown> {
    return { holders: this.holders, waiters: this.waiters };
  }
}

export class RunIdConflictError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "run_id_conflict";
  readonly retryable: boolean = false;
  constructor(fields: { runId: string }, opts?: Opts) {
    super(`Run id "${fields.runId}" is bound to a different factory or input. Use a new run id.`, {
      runId: fields.runId,
      ...opts,
    });
  }
}

export class NoActiveRunError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "no_active_run";
  readonly retryable: boolean = false;
  readonly primitive: string;
  constructor(fields: { primitive: string }, opts?: Opts) {
    super(
      `${fields.primitive}() was called outside a running factory. Call it inside a factory body passed to run().`,
      opts,
    );
    this.primitive = fields.primitive;
  }
}

export class JournalVersionError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "journal_version";
  readonly retryable: boolean = false;
  readonly found: number;
  readonly supported: number;
  readonly lastVersionThatReads?: string;
  constructor(fields: { found: number; supported: number; lastVersionThatReads?: string }, opts?: Opts) {
    super(
      `The journal format is ${fields.found}; this version reads ${fields.supported}.${fields.lastVersionThatReads ? ` Resume with selfbuilding ${fields.lastVersionThatReads}.` : ""}`,
      opts,
    );
    this.found = fields.found;
    this.supported = fields.supported;
    if (fields.lastVersionThatReads !== undefined) this.lastVersionThatReads = fields.lastVersionThatReads;
  }
}

export class SkillLoadError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "skill_load";
  readonly retryable: boolean = false;
  readonly dir: string;
  readonly issues: string[];
  constructor(fields: { dir: string; issues: string[] }, opts?: Opts) {
    super(`Skill folder ${fields.dir} is invalid:\n- ${fields.issues.join("\n- ")}`, opts);
    this.dir = fields.dir;
    this.issues = fields.issues;
  }
}

export class DuplicateSkillError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "duplicate_skill";
  readonly retryable: boolean = false;
  readonly skill: string;
  constructor(fields: { skill: string; dirs: string[] }, opts?: Opts) {
    super(
      `Skill "${fields.skill}" appears more than once in one source tier: ${fields.dirs.join(", ")}. Rename or remove one.`,
      opts,
    );
    this.skill = fields.skill;
  }
}

export class ContractError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "contract";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class AgentInputError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "input_invalid";
  readonly retryable: boolean = false;
  readonly issues: string[];
  constructor(fields: { agent: string; issues: string[] }, opts?: Opts) {
    super(`Invalid input for ${fields.agent}:\n- ${fields.issues.join("\n- ")}`, opts);
    this.issues = fields.issues;
  }
}

export class HitlConfigError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "hitl_config";
  readonly retryable: boolean = false;
  constructor(
    message = "HITL channels are configured but nobody can answer. Add hitl.approvers to the factory or to run().",
    opts?: Opts,
  ) {
    super(message, opts);
  }
}

export class AskSpecError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "ask_spec";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

/** A usage error at plan time; raised as an agent-level error at run time once the step counter is nearly spent. */
export class HostStepLimitError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "host_step_limit";
  readonly retryable: boolean = false;
  override readonly kind: "usage" | "agent";
  readonly steps: number;
  readonly limit: number;
  constructor(fields: { steps: number; limit: number; phase: "plan" | "run" }, opts?: Opts) {
    super(
      `The plan needs about ${fields.steps} host steps; the limit is ${fields.limit}. Split the work into nested factories, which each get their own step budget.`,
      opts,
    );
    this.kind = fields.phase === "plan" ? "usage" : "agent";
    this.steps = fields.steps;
    this.limit = fields.limit;
  }
}

// ───────────────────────────── credentials, secrets and policy ─────────────────────────────

export class MissingSecretError extends SelfbuildingError {
  readonly code: ErrorCode = "secret_missing";
  readonly retryable: boolean = false;
  readonly secret: string;
  constructor(fields: { secret: string; agent?: string }, opts?: Opts) {
    super(
      `${fields.secret} is declared${fields.agent ? ` by agent "${fields.agent}"` : ""} but the SecretSource returned nothing. Add it to your secret store or remove it from secrets.`,
      opts,
    );
    this.secret = fields.secret;
  }
}

export class MissingCredentialError extends SelfbuildingError {
  readonly code: ErrorCode = "credential_missing";
  readonly retryable: boolean = false;
  readonly consumer: string;
  constructor(fields: { consumer: string }, opts?: Opts) {
    super(
      `${fields.consumer} has no credential. Pass one in its options, for example credentials: { kind: "api-key", value: fromEnv("...") }.`,
      opts,
    );
    this.consumer = fields.consumer;
  }
}

export class CredentialRefreshError extends SelfbuildingError {
  readonly code: ErrorCode = "credential_refresh";
  readonly retryable: boolean = true;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class UnprotectedRepoError extends SelfbuildingError {
  readonly code: ErrorCode = "repo_unprotected";
  readonly retryable: boolean = false;
  readonly repo: string;
  constructor(fields: { repo: string }, opts?: Opts) {
    super(
      `The GitHub App can write to ${fields.repo} and no ruleset limits it to refs/heads/selfbuilding/* and refs/selfbuilding/*. Add that ruleset, or pass requireRuleset: false for a throwaway repo.`,
      opts,
    );
    this.repo = fields.repo;
  }
}

export class SecretInEnvError extends SelfbuildingError {
  readonly code: ErrorCode = "secret_in_env";
  readonly retryable: boolean = false;
  readonly variable: string;
  constructor(fields: { variable: string }, opts?: Opts) {
    super(
      `${fields.variable} looks like a secret and was passed as sandbox env. Secrets reach a sandbox only as 0600 files; declare it in secrets instead.`,
      opts,
    );
    this.variable = fields.variable;
  }
}

export class EgressPolicyUnsupportedError extends SelfbuildingError {
  readonly code: ErrorCode = "egress_unsupported";
  readonly retryable: boolean = false;
  readonly provider: string;
  readonly requested: string;
  readonly supported: string[];
  constructor(fields: { provider: string; requested: string; supported: string[] }, opts?: Opts) {
    super(
      `Provider "${fields.provider}" cannot enforce the ${fields.requested} egress policy. It supports: ${fields.supported.join(", ")}.`,
      opts,
    );
    this.provider = fields.provider;
    this.requested = fields.requested;
    this.supported = fields.supported;
  }
}

export class ImageSecretError extends SelfbuildingError {
  readonly code: ErrorCode = "image_secret";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class UnknownModelPriceError extends SelfbuildingError {
  readonly code: ErrorCode = "price_unknown";
  readonly retryable: boolean = false;
  readonly model: string;
  constructor(fields: { model: string }, opts?: Opts) {
    super(
      `No price is known for model "${fields.model}". Add it to budget.prices, or set budget.allowUnmetered: true.`,
      opts,
    );
    this.model = fields.model;
  }
}

// ───────────────────────────── result contract ─────────────────────────────

export class NoResultError extends SelfbuildingError {
  readonly code: ErrorCode = "no_result";
  readonly retryable: boolean = false;
  constructor(
    message = "The agent ended without calling submit_result, even after a resume nudge. Its work is in the recovery branch and session.",
    opts?: Opts,
  ) {
    super(message, opts);
  }
}

export class ResultValidationError extends SelfbuildingError {
  readonly code: ErrorCode = "result_invalid";
  readonly retryable: boolean = false;
  readonly issues: string[];
  constructor(fields: { issues: string[] }, opts?: Opts) {
    super(`The result failed its schema after every allowed attempt:\n- ${fields.issues.join("\n- ")}`, opts);
    this.issues = fields.issues;
  }
}

export class ResultIntegrityError extends SelfbuildingError {
  readonly code: ErrorCode = "result_integrity";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class DoneCheckFailedError extends SelfbuildingError {
  readonly code: ErrorCode = "done_check_failed";
  readonly retryable: boolean = false;
  readonly checkId: string;
  readonly output: string;
  constructor(fields: { checkId: string; output: string }, opts?: Opts) {
    super(
      `Done check "${fields.checkId}" still fails after the allowed retries. The last valid result is in recovery.lastValidResult.`,
      opts,
    );
    this.checkId = fields.checkId;
    this.output = fields.output;
  }
  protected override details(): Record<string, unknown> {
    return { checkId: this.checkId, output: this.output };
  }
}

export class SkillContextError extends SelfbuildingError {
  readonly code: ErrorCode = "skill_context_failed";
  readonly retryable: boolean = true;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

/** Collection failed after a valid result. Retry collection; the agent does not run again. */
export class ArtifactError extends SelfbuildingError {
  readonly code: ErrorCode = "artifact_failed";
  readonly retryable: boolean = true;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class ArtifactPathError extends ArtifactError {
  readonly path: string;
  constructor(fields: { path: string }, opts?: Opts) {
    super(
      `Artifact path ${fields.path} is outside the workdir and /selfbuilding/out. Paths reported by a sandbox are untrusted.`,
      opts,
    );
    this.path = fields.path;
  }
}

export class BudgetExceededError extends SelfbuildingError {
  readonly code: ErrorCode = "budget";
  readonly retryable: boolean = false;
  readonly phase: "admission" | "running";
  constructor(fields: { phase: "admission" | "running" }, opts?: Opts) {
    super(
      fields.phase === "admission"
        ? "The run budget cannot cover a new agent slice. Raise budget.usd or lower budget.perAgent."
        : "The agent crossed its reserved budget slice and was stopped. Resume from recovery with a bigger budget.",
      opts,
    );
    this.phase = fields.phase;
  }
  protected override details(): Record<string, unknown> {
    return { phase: this.phase };
  }
}

// ───────────────────────────── harness ─────────────────────────────

export class HarnessStartError extends SelfbuildingError {
  readonly code: ErrorCode = "harness_start";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class HarnessProtocolError extends SelfbuildingError {
  readonly code: ErrorCode = "harness_protocol";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

/** The harness reported an error event, even if it exited 0. Retryable when the failure is. */
export class HarnessStreamError extends SelfbuildingError {
  readonly code: ErrorCode = "harness_error";
  readonly retryable: boolean;
  readonly failure: HarnessFailure;
  constructor(fields: { failure: HarnessFailure }, opts?: Opts) {
    super(`The harness reported ${fields.failure.code}: ${fields.failure.message}`, opts);
    this.failure = fields.failure;
    this.retryable = fields.failure.retryable;
  }
  protected override details(): Record<string, unknown> {
    return { failure: this.failure };
  }
}

export class HarnessVersionUnavailableError extends SelfbuildingError {
  readonly code: ErrorCode = "harness_version_unavailable";
  readonly retryable: boolean;
  readonly harness: HarnessId | (string & {});
  readonly version: string;
  readonly reason: "network" | "egress" | "unpublished" | "mismatch";
  constructor(
    fields: {
      harness: HarnessId | (string & {});
      version: string;
      reason: "network" | "egress" | "unpublished" | "mismatch";
    },
    opts?: Opts,
  ) {
    super(
      `${fields.harness} ${fields.version} cannot be installed (${fields.reason}). Bake it into the image or allow its install hosts.`,
      opts,
    );
    this.harness = fields.harness;
    this.version = fields.version;
    this.reason = fields.reason;
    this.retryable = fields.reason === "network";
  }
}

// ───────────────────────────── sandbox ─────────────────────────────

export class SandboxUnavailableError extends SelfbuildingError {
  readonly code: ErrorCode = "sandbox_unavailable";
  readonly retryable: boolean = true;
  readonly provider: string;
  readonly sandboxId?: string;
  constructor(ctx: SandboxErrorContext, opts?: Opts) {
    super(
      `Provider "${ctx.provider}" did not answer${ctx.sandboxId ? ` for ${ctx.sandboxId}` : ""}. The outcome is unknown; this is never treated as not-found.`,
      opts,
    );
    this.provider = ctx.provider;
    if (ctx.sandboxId !== undefined) this.sandboxId = ctx.sandboxId;
  }
}

export class SandboxGuestGoneError extends SandboxUnavailableError {
  override readonly code: ErrorCode = "sandbox_guest_gone";
}

export class SandboxNotFoundError extends SelfbuildingError {
  readonly code: ErrorCode = "sandbox_not_found";
  readonly retryable: boolean = false;
  readonly provider: string;
  readonly sandboxId?: string;
  constructor(ctx: SandboxErrorContext, opts?: Opts) {
    super(`Provider "${ctx.provider}" confirmed that sandbox ${ctx.sandboxId ?? "(unknown id)"} does not exist.`, opts);
    this.provider = ctx.provider;
    if (ctx.sandboxId !== undefined) this.sandboxId = ctx.sandboxId;
  }
}

export class SandboxFileNotFoundError extends SelfbuildingError {
  readonly code: ErrorCode = "sandbox_file_not_found";
  readonly retryable: boolean = false;
  readonly provider: string;
  readonly sandboxId?: string;
  readonly path: string;
  constructor(ctx: SandboxErrorContext & { path: string }, opts?: Opts) {
    super(
      `${ctx.path} does not exist in sandbox ${ctx.sandboxId ?? "(unknown id)"}. The sandbox itself is fine.`,
      opts,
    );
    this.provider = ctx.provider;
    if (ctx.sandboxId !== undefined) this.sandboxId = ctx.sandboxId;
    this.path = ctx.path;
  }
}

export class SandboxCommandTimeoutError extends SelfbuildingError {
  readonly code: ErrorCode = "exec_timeout";
  readonly retryable: boolean;
  readonly provider: string;
  readonly sandboxId?: string;
  readonly cmd: string;
  readonly mayStillBeRunning: boolean;
  constructor(
    ctx: SandboxErrorContext & { cmd: string; mayStillBeRunning: boolean; idempotent?: boolean },
    opts?: Opts,
  ) {
    super(
      `Command timed out in ${ctx.provider}${ctx.mayStillBeRunning ? " and may still be running" : ""}: ${ctx.cmd}`,
      opts,
    );
    this.provider = ctx.provider;
    if (ctx.sandboxId !== undefined) this.sandboxId = ctx.sandboxId;
    this.cmd = ctx.cmd;
    this.mayStillBeRunning = ctx.mayStillBeRunning;
    this.retryable = ctx.idempotent === true && !ctx.mayStillBeRunning;
  }
}

export class SandboxQuotaError extends SelfbuildingError {
  readonly code: ErrorCode = "sandbox_quota";
  readonly retryable: boolean = true;
  readonly provider: string;
  readonly sandboxId?: string;
  readonly retryAfterMs?: number;
  constructor(ctx: SandboxErrorContext & { retryAfterMs?: number }, opts?: Opts) {
    super(
      `Provider "${ctx.provider}" refused the request for quota or rate reasons. Back off and keep the slot.`,
      opts,
    );
    this.provider = ctx.provider;
    if (ctx.sandboxId !== undefined) this.sandboxId = ctx.sandboxId;
    if (ctx.retryAfterMs !== undefined) this.retryAfterMs = ctx.retryAfterMs;
  }
}

export class SandboxAuthError extends SelfbuildingError {
  readonly code: ErrorCode = "sandbox_auth";
  readonly retryable: boolean = false;
  readonly provider: string;
  readonly sandboxId?: string;
  constructor(ctx: SandboxErrorContext, opts?: Opts) {
    super(
      `Provider "${ctx.provider}" rejected the credentials or billing. Every sandbox on this provider is affected; fix the account.`,
      opts,
    );
    this.provider = ctx.provider;
    if (ctx.sandboxId !== undefined) this.sandboxId = ctx.sandboxId;
  }
}

export class SandboxWedgedError extends SelfbuildingError {
  readonly code: ErrorCode = "sandbox_wedged";
  readonly retryable: boolean = false;
  readonly provider: string;
  readonly sandboxId?: string;
  constructor(ctx: SandboxErrorContext, opts?: Opts) {
    super(
      `Provider "${ctx.provider}" reports ${ctx.sandboxId ?? "the sandbox"} paused while it is still running. A human should kill it.`,
      opts,
    );
    this.provider = ctx.provider;
    if (ctx.sandboxId !== undefined) this.sandboxId = ctx.sandboxId;
  }
}

export class SandboxUnsupportedError extends SelfbuildingError {
  readonly code: ErrorCode = "sandbox_unsupported";
  readonly retryable: boolean = false;
  readonly provider: string;
  readonly sandboxId?: string;
  readonly op: string;
  constructor(ctx: SandboxErrorContext & { op: string }, opts?: Opts) {
    super(
      `Provider "${ctx.provider}" does not support ${ctx.op}. Use a git checkpoint or a typed result instead.`,
      opts,
    );
    this.provider = ctx.provider;
    if (ctx.sandboxId !== undefined) this.sandboxId = ctx.sandboxId;
    this.op = ctx.op;
  }
  protected override details(): Record<string, unknown> {
    return { op: this.op };
  }
}

export type NotQuiescentReason = "busy" | "unknown" | "unacked-outcome" | "process-survived" | "git-index-lock";

/** Raised by the core, never by adapters (spec §5.3). */
export class SandboxNotQuiescentError extends SelfbuildingError {
  readonly code: ErrorCode = "sandbox_not_quiescent";
  readonly retryable: boolean;
  readonly reason: NotQuiescentReason;
  readonly detail?: string;
  constructor(fields: { reason: NotQuiescentReason; detail?: string }, opts?: Opts) {
    super(
      `The sandbox is not at a clean boundary (${fields.reason})${fields.detail ? `: ${fields.detail}` : ""}.`,
      opts,
    );
    this.reason = fields.reason;
    if (fields.detail !== undefined) this.detail = fields.detail;
    this.retryable = fields.reason === "busy" || fields.reason === "unknown";
  }
}

export class SandboxOutputRejectedError extends SelfbuildingError {
  readonly code: ErrorCode = "sandbox_output";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class SnapshotNotCleanError extends SelfbuildingError {
  readonly code: ErrorCode = "snapshot_unclean";
  readonly retryable: boolean = false;
  readonly target: "snapshot" | "checkpoint" | "push";
  readonly locations: string[];
  constructor(fields: { target: "snapshot" | "checkpoint" | "push"; locations: string[] }, opts?: Opts) {
    super(
      `A secret value was found before ${fields.target} in: ${fields.locations.join(", ")}. Remove it from the tree.`,
      opts,
    );
    this.target = fields.target;
    this.locations = fields.locations;
  }
}

export class ImageUnavailableError extends SelfbuildingError {
  readonly code: ErrorCode = "image_unavailable";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class ImageActivationPendingError extends SelfbuildingError {
  readonly code: ErrorCode = "image_activation_pending";
  readonly retryable: boolean = true;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

// ───────────────────────────── lifecycle and budget ─────────────────────────────

export class CallTimeoutError extends SelfbuildingError {
  readonly code: ErrorCode = "timeout";
  readonly retryable: boolean = false;
  constructor(
    message = "The call's active-time timeout passed. Continue from recovery with a new call on the same branch.",
    opts?: Opts,
  ) {
    super(message, opts);
  }
}

export class IdleTimeoutError extends SelfbuildingError {
  readonly code: ErrorCode = "idle_timeout";
  readonly retryable: boolean = false;
  constructor(message = "The harness produced no output for timeouts.idle and was stopped.", opts?: Opts) {
    super(message, opts);
  }
}

export class BootTimeoutError extends SelfbuildingError {
  readonly code: ErrorCode = "boot";
  readonly retryable: boolean = true;
  readonly phase: string;
  constructor(fields: { phase: string }, opts?: Opts) {
    super(`Boot phase "${fields.phase}" did not finish within timeouts.boot.`, opts);
    this.phase = fields.phase;
  }
}

export class HookTimeoutError extends SelfbuildingError {
  readonly code: ErrorCode = "boot";
  readonly retryable: boolean = true;
  readonly hook: "setup" | "start";
  constructor(fields: { hook: "setup" | "start" }, opts?: Opts) {
    super(
      `The ${fields.hook} hook did not finish within timeouts.${fields.hook}. Its log is in the call's artifacts.`,
      opts,
    );
    this.hook = fields.hook;
  }
}

export class AgentInterruptedError extends SelfbuildingError {
  readonly code: ErrorCode = "interrupted";
  readonly retryable: boolean = false;
  constructor(
    message = "The agent's turn died with no outcome. It is not re-run silently; resume it with onInterrupted or refresh, using the recovery data.",
    opts?: Opts,
  ) {
    super(message, opts);
  }
}

export class AgentLostError extends AgentInterruptedError {
  override readonly code: ErrorCode = "lost";
}

export class PushFailedError extends SelfbuildingError {
  readonly code: ErrorCode = "push_failed";
  readonly retryable: boolean = true;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class AskTimeoutError extends SelfbuildingError {
  readonly code: ErrorCode = "ask_timeout";
  readonly retryable: boolean = false;
  constructor(fields: { askId: string }, opts?: Opts) {
    super(`Ask ${fields.askId} timed out with onTimeout: "fail".`, {
      ...opts,
      recovery: { ...opts?.recovery, askId: fields.askId },
    });
  }
}

export class AskCancelledError extends SelfbuildingError {
  readonly code: ErrorCode = "ask_cancelled";
  readonly retryable: boolean = false;
  constructor(fields: { askId: string }, opts?: Opts) {
    super(`Ask ${fields.askId} was cancelled with its run.`, {
      ...opts,
      recovery: { ...opts?.recovery, askId: fields.askId },
    });
  }
}

// ───────────────────────────── durability and channels ─────────────────────────────

export class JournalConflictError extends SelfbuildingError {
  readonly code: ErrorCode = "journal_conflict";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class JournalDivergenceError extends SelfbuildingError {
  readonly code: ErrorCode = "journal_divergence";
  readonly retryable: boolean = false;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class LeaseLostError extends SelfbuildingError {
  readonly code: ErrorCode = "lease_lost";
  readonly retryable: boolean = false;
  constructor(
    message = "Another process took over this run's journal lease. This process stops before doing anything remote.",
    opts?: Opts,
  ) {
    super(message, opts);
  }
}

export class ChannelDeliveryError extends SelfbuildingError {
  readonly code: ErrorCode = "channel_delivery";
  readonly retryable: boolean = true;
  constructor(message: string, opts?: Opts) {
    super(message, opts);
  }
}

export class WebhookSignatureError extends SelfbuildingError {
  readonly code: ErrorCode = "webhook_signature";
  readonly retryable: boolean = false;
  constructor(message = "The inbound request failed signature verification.", opts?: Opts) {
    super(message, opts);
  }
}

// ───────────────────────────── sizes (docs/spec/demo-path.md §1) ─────────────────────────────

/** A size name that is neither built in nor in the config's `sizes` table. */
export class SizeUnknownError extends ConfigError {
  override readonly code: ErrorCode = "size_unknown";
  readonly size: string;
  readonly known: string[];
  constructor(fields: { size: string; known: string[] }, opts?: Opts) {
    super(
      `Size "${fields.size}" is not defined. Use one of ${fields.known.join(", ")}, or add it to the config's sizes table: sizes: { "${fields.size}": { vcpu, memoryMiB } }.`,
      opts,
    );
    this.size = fields.size;
    this.known = fields.known;
  }
  protected override details(): Record<string, unknown> {
    return { size: this.size, known: this.known };
  }
}

export type SizeRefusalReason = SizeRefusal;

/** The provider cannot give this size. Never falls back to another size; the message names the fix. */
export class SizeUnavailableError extends SelfbuildingError {
  readonly code: ErrorCode = "size_unavailable";
  readonly retryable: boolean = false;
  readonly provider: string;
  readonly size: string;
  readonly vcpu: number;
  readonly memoryMiB: number;
  readonly reason: SizeRefusalReason;
  /** One sentence: the command or option change that makes the size available. */
  readonly fix: string;
  constructor(
    fields: { provider: string; size: string; vcpu: number; memoryMiB: number; reason: SizeRefusalReason; fix: string },
    opts?: Opts,
  ) {
    super(
      `Provider "${fields.provider}" cannot give size "${fields.size}" (${fields.vcpu} vCPU, ${fields.memoryMiB} MiB): ${fields.reason}. ${fields.fix}`,
      opts,
    );
    this.provider = fields.provider;
    this.size = fields.size;
    this.vcpu = fields.vcpu;
    this.memoryMiB = fields.memoryMiB;
    this.reason = fields.reason;
    this.fix = fields.fix;
  }
  protected override details(): Record<string, unknown> {
    return {
      provider: this.provider,
      size: this.size,
      vcpu: this.vcpu,
      memoryMiB: this.memoryMiB,
      reason: this.reason,
      fix: this.fix,
    };
  }
}

// ───────────────────────────── scripts and agent-launched runs (demo-path §8, §9) ─────────────────────────────

/** The script does not compile, has no default export, or misuses the script API. */
export class ScriptInvalidError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "script_invalid";
  readonly retryable: boolean = false;
  readonly line?: number;
  readonly column?: number;
  constructor(fields: { reason: string; line?: number; column?: number }, opts?: Opts) {
    const at =
      fields.line === undefined
        ? ""
        : ` at line ${fields.line}${fields.column === undefined ? "" : `:${fields.column}`}`;
    super(`The workflow script is invalid${at}: ${fields.reason}. Fix the script and start it again.`, opts);
    if (fields.line !== undefined) this.line = fields.line;
    if (fields.column !== undefined) this.column = fields.column;
  }
  protected override details(): Record<string, unknown> {
    return { line: this.line, column: this.column };
  }
}

/** The script threw. `scriptStack` is the isolate's stack, never the host's. */
export class ScriptFailedError extends SelfbuildingError {
  readonly code: ErrorCode = "script_failed";
  readonly retryable: boolean = false;
  readonly scriptStack?: string;
  constructor(fields: { reason: string; scriptStack?: string }, opts?: Opts) {
    super(`The workflow script threw: ${fields.reason}`, opts);
    if (fields.scriptStack !== undefined) this.scriptStack = fields.scriptStack;
  }
  protected override details(): Record<string, unknown> {
    return { scriptStack: this.scriptStack };
  }
}

export type ScriptLimit =
  | "memory"
  | "stack"
  | "cpu"
  | "agent_calls"
  | "sandboxes"
  | "size"
  | "budget"
  | "wall_clock"
  | "output_bytes"
  | "source_bytes"
  /** PR comments and edits from `sb.pr` (release-prep §2.3). */
  | "pr_writes";

/** A script run hit one of its caps. */
export class ScriptLimitError extends SelfbuildingError {
  readonly code: ErrorCode = "script_limit";
  readonly retryable: boolean = false;
  readonly limit: ScriptLimit;
  readonly max: string;
  constructor(fields: { limit: ScriptLimit; max: string }, opts?: Opts) {
    super(
      `The workflow script hit its ${fields.limit} limit (${fields.max}). Do less per run, or raise scripts.${fields.limit} in the deployment config.`,
      opts,
    );
    this.limit = fields.limit;
    this.max = fields.max;
  }
  protected override details(): Record<string, unknown> {
    return { limit: this.limit, max: this.max };
  }
}

export type WorkflowGuardRule =
  | "disabled"
  | "grant"
  | "concurrent_runs"
  | "concurrent_sandboxes"
  | "sandboxes_per_run"
  | "size"
  | "budget"
  | "script_bytes"
  | "depth";

/** start_workflow refused a launch. Nothing was started. */
export class WorkflowGuardError extends SelfbuildingError {
  readonly code: ErrorCode = "workflow_guard";
  readonly retryable: boolean = false;
  readonly rule: WorkflowGuardRule;
  readonly limit: string;
  readonly requested: string;
  constructor(fields: { rule: WorkflowGuardRule; limit: string; requested: string }, opts?: Opts) {
    super(
      `start_workflow refused the launch: ${fields.rule} allows ${fields.limit}, the request needs ${fields.requested}. Ask for less, wait for a running workflow to finish, or have the owner raise startWorkflow.${fields.rule} in the config.`,
      opts,
    );
    this.rule = fields.rule;
    this.limit = fields.limit;
    this.requested = fields.requested;
  }
  protected override details(): Record<string, unknown> {
    return { rule: this.rule, limit: this.limit, requested: this.requested };
  }
}

// ───────────────────────────── release prep (docs/spec/release-prep.md) ─────────────────────────────

/** A pull request target that names no PR this run can reach: not a PR URL, no number, or another git host. */
export class PrTargetError extends SelfbuildingUsageError {
  readonly code: ErrorCode = "pr_target";
  readonly retryable: boolean = false;
  readonly target: string;
  constructor(fields: { target: string; reason: string }, opts?: Opts) {
    super(
      `${fields.reason} (got ${fields.target}). Pass the PR from an agent result (result.artifacts.pr), its URL ("https://github.com/<owner>/<repo>/pull/<n>"), or { repo: "github.com/<owner>/<repo>", number }.`,
      opts,
    );
    this.target = fields.target;
  }
  protected override details(): Record<string, unknown> {
    return { target: this.target };
  }
}
