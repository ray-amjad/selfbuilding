import type { SelfbuildingError } from "./base.js";
import * as classes from "./classes.js";
import type { ErrorCode } from "./codes.js";

// The one error registry in code (spec §10.3 L0). One row per class. A thrown class without a row fails the
// registry test, and so does a class whose instance disagrees with its row.

export interface ErrorRegistryRow {
  name: string;
  code: ErrorCode;
  kind: "usage" | "agent";
  /** "conditional": decided per instance (e.g. HarnessStreamError follows its HarnessFailure). */
  retryable: "yes" | "no" | "conditional";
  /** The spec section that raises it. */
  section: string;
  /** Constructors differ per class; the row only needs identity. */
  ctor: abstract new (
    ...args: never[]
  ) => SelfbuildingError;
}

const row = (
  ctor: ErrorRegistryRow["ctor"],
  code: ErrorCode,
  kind: ErrorRegistryRow["kind"],
  retryable: ErrorRegistryRow["retryable"],
  section: string,
): ErrorRegistryRow => ({ name: ctor.name, code, kind, retryable, section, ctor });

export const ERROR_REGISTRY: readonly ErrorRegistryRow[] = [
  // usage and configuration
  row(classes.ConfigError, "config", "usage", "no", "§1.11"),
  row(classes.TimeoutOrderError, "timeout_order", "usage", "no", "§6.11"),
  row(classes.ProviderLifetimeError, "provider_lifetime", "usage", "no", "§7.7"),
  row(classes.NestingDepthError, "nesting_depth", "usage", "no", "§3.7"),
  row(classes.NonDeterminismError, "non_determinism", "usage", "no", "§3.8"),
  row(classes.DuplicateLabelError, "duplicate_label", "usage", "no", "§3.2"),
  row(classes.SandboxHandleScopeError, "sandbox_handle_scope", "usage", "no", "§3.11"),
  row(classes.SandboxBusyError, "sandbox_busy", "usage", "no", "§3.11"),
  row(classes.NotOwnerError, "not_owner", "usage", "no", "§3.11"),
  row(classes.SandboxCapDeadlockError, "sandbox_cap_deadlock", "usage", "no", "§3.12"),
  row(classes.RunIdConflictError, "run_id_conflict", "usage", "no", "§3.2"),
  row(classes.NoActiveRunError, "no_active_run", "usage", "no", "§1.8"),
  row(classes.JournalVersionError, "journal_version", "usage", "no", "§1.13"),
  row(classes.SkillLoadError, "skill_load", "usage", "no", "§2.2"),
  row(classes.DuplicateSkillError, "duplicate_skill", "usage", "no", "§2.2"),
  row(classes.ContractError, "contract", "usage", "no", "§2.4"),
  row(classes.AgentInputError, "input_invalid", "usage", "no", "§2.4.3"),
  row(classes.HitlConfigError, "hitl_config", "usage", "no", "§8.7"),
  row(classes.AskSpecError, "ask_spec", "usage", "no", "§8.2"),
  row(classes.HostStepLimitError, "host_step_limit", "usage", "no", "§7.5.2"),
  // credentials, secrets and policy
  row(classes.MissingSecretError, "secret_missing", "agent", "no", "§9.2"),
  row(classes.MissingCredentialError, "credential_missing", "agent", "no", "§9.2"),
  row(classes.CredentialRefreshError, "credential_refresh", "agent", "yes", "§9.2"),
  row(classes.UnprotectedRepoError, "repo_unprotected", "agent", "no", "§9.2"),
  row(classes.SecretInEnvError, "secret_in_env", "agent", "no", "§9.2"),
  row(classes.EgressPolicyUnsupportedError, "egress_unsupported", "agent", "no", "§9.5"),
  row(classes.ImageSecretError, "image_secret", "agent", "no", "§9.3"),
  row(classes.UnknownModelPriceError, "price_unknown", "agent", "no", "§9.6"),
  // result contract
  row(classes.NoResultError, "no_result", "agent", "no", "§2.6.5"),
  row(classes.ResultValidationError, "result_invalid", "agent", "no", "§2.6.4"),
  row(classes.ResultIntegrityError, "result_integrity", "agent", "no", "§2.6.4"),
  row(classes.DoneCheckFailedError, "done_check_failed", "agent", "no", "§2.7"),
  row(classes.SkillContextError, "skill_context_failed", "agent", "yes", "§2.3.4"),
  row(classes.ArtifactError, "artifact_failed", "agent", "yes", "§2.8.2"),
  row(classes.ArtifactPathError, "artifact_failed", "agent", "yes", "§2.8.2"),
  row(classes.BudgetExceededError, "budget", "agent", "no", "§9.6"),
  // harness
  row(classes.HarnessStartError, "harness_start", "agent", "no", "§4.12"),
  row(classes.HarnessProtocolError, "harness_protocol", "agent", "no", "§9.9"),
  row(classes.HarnessStreamError, "harness_error", "agent", "conditional", "§4.12"),
  row(classes.HarnessVersionUnavailableError, "harness_version_unavailable", "agent", "conditional", "§4.11"),
  // sandbox
  row(classes.SandboxUnavailableError, "sandbox_unavailable", "agent", "yes", "§5.3"),
  row(classes.SandboxGuestGoneError, "sandbox_guest_gone", "agent", "yes", "§5.3"),
  row(classes.SandboxNotFoundError, "sandbox_not_found", "agent", "no", "§5.3"),
  row(classes.SandboxFileNotFoundError, "sandbox_file_not_found", "agent", "no", "§5.3"),
  row(classes.SandboxCommandTimeoutError, "exec_timeout", "agent", "conditional", "§5.3"),
  row(classes.SandboxQuotaError, "sandbox_quota", "agent", "yes", "§5.3"),
  row(classes.SandboxAuthError, "sandbox_auth", "agent", "no", "§5.3"),
  row(classes.SandboxWedgedError, "sandbox_wedged", "agent", "no", "§5.3"),
  row(classes.SandboxUnsupportedError, "sandbox_unsupported", "agent", "no", "§5.3"),
  row(classes.SandboxNotQuiescentError, "sandbox_not_quiescent", "agent", "conditional", "§5.8"),
  row(classes.SandboxOutputRejectedError, "sandbox_output", "agent", "no", "§9.1"),
  row(classes.SnapshotNotCleanError, "snapshot_unclean", "agent", "no", "§9.3"),
  row(classes.ImageUnavailableError, "image_unavailable", "agent", "no", "§5.7"),
  row(classes.ImageActivationPendingError, "image_activation_pending", "agent", "yes", "§5.7"),
  // lifecycle and budget
  row(classes.CallTimeoutError, "timeout", "agent", "no", "§6.11"),
  row(classes.IdleTimeoutError, "idle_timeout", "agent", "no", "§6.11"),
  row(classes.BootTimeoutError, "boot", "agent", "yes", "§6.5"),
  row(classes.HookTimeoutError, "boot", "agent", "yes", "§6.11"),
  row(classes.AgentInterruptedError, "interrupted", "agent", "no", "§3.10"),
  row(classes.AgentLostError, "lost", "agent", "no", "§5.9"),
  row(classes.PushFailedError, "push_failed", "agent", "yes", "§9.2"),
  row(classes.AskTimeoutError, "ask_timeout", "agent", "no", "§8.8"),
  row(classes.AskCancelledError, "ask_cancelled", "agent", "no", "§8.5"),
  // durability and channels
  row(classes.JournalConflictError, "journal_conflict", "agent", "no", "§7"),
  row(classes.JournalDivergenceError, "journal_divergence", "agent", "no", "§7.3"),
  row(classes.LeaseLostError, "lease_lost", "agent", "no", "§7.5.4"),
  row(classes.ChannelDeliveryError, "channel_delivery", "agent", "yes", "§8.9"),
  row(classes.WebhookSignatureError, "webhook_signature", "agent", "no", "§8.6"),
  // sizes, scripts and agent-launched runs (docs/spec/demo-path.md)
  row(classes.SizeUnknownError, "size_unknown", "usage", "no", "demo-path §1.5"),
  row(classes.SizeUnavailableError, "size_unavailable", "agent", "no", "demo-path §1.5"),
  row(classes.ScriptInvalidError, "script_invalid", "usage", "no", "demo-path §8.5"),
  row(classes.ScriptFailedError, "script_failed", "agent", "no", "demo-path §8.5"),
  row(classes.ScriptLimitError, "script_limit", "agent", "no", "demo-path §8.5"),
  row(classes.WorkflowGuardError, "workflow_guard", "agent", "no", "demo-path §9.4"),
  // release prep (docs/spec/release-prep.md)
  row(classes.PrTargetError, "pr_target", "usage", "no", "release-prep §2.2"),
];

/** Codes that legitimately appear on more than one class. */
export const SHARED_ERROR_CODES: readonly ErrorCode[] = ["artifact_failed", "boot"];

/** Codes with no class: an aborted call rejects with `signal.reason` (spec §6.10). */
export const CLASSLESS_ERROR_CODES: readonly ErrorCode[] = ["aborted"];
