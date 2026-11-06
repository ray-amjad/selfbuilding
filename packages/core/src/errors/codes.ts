import type { ArtifactRef, ArtifactRefJson } from "../types/artifacts.js";
import type { SandboxRef } from "../types/sandbox.js";

/** The one error-code union (spec §9.8). `Outcome.reason` and `Settled.code` use it too. */
export type ErrorCode =
  // usage and configuration
  | "config"
  | "timeout_order"
  | "provider_lifetime"
  | "nesting_depth"
  | "non_determinism"
  | "duplicate_label"
  | "sandbox_handle_scope"
  | "sandbox_busy"
  | "not_owner"
  | "sandbox_cap_deadlock"
  | "run_id_conflict"
  | "no_active_run"
  | "journal_version"
  | "skill_load"
  | "duplicate_skill"
  | "contract"
  | "input_invalid"
  | "hitl_config"
  | "ask_spec"
  // credentials, secrets and policy
  | "secret_missing"
  | "credential_missing"
  | "credential_refresh"
  | "repo_unprotected"
  | "secret_in_env"
  | "egress_unsupported"
  | "image_secret"
  | "price_unknown"
  // result contract
  | "no_result"
  | "result_invalid"
  | "result_integrity"
  | "done_check_failed"
  | "skill_context_failed"
  | "artifact_failed"
  // harness
  | "harness_start"
  | "harness_protocol"
  | "harness_error"
  | "harness_version_unavailable"
  // sandbox
  | "sandbox_unavailable"
  | "sandbox_guest_gone"
  | "sandbox_not_found"
  | "sandbox_file_not_found"
  | "exec_timeout"
  | "sandbox_quota"
  | "sandbox_auth"
  | "sandbox_wedged"
  | "sandbox_unsupported"
  | "sandbox_not_quiescent"
  | "sandbox_output"
  | "snapshot_unclean"
  | "image_unavailable"
  | "image_activation_pending"
  // lifecycle and budget
  | "budget"
  | "timeout"
  | "idle_timeout"
  | "boot"
  | "interrupted"
  | "lost"
  | "push_failed"
  | "host_step_limit"
  | "aborted"
  // durability
  | "journal_conflict"
  | "journal_divergence"
  | "lease_lost"
  // HITL
  | "ask_timeout"
  | "ask_cancelled"
  | "channel_delivery"
  | "webhook_signature"
  // sizes (demo-path §1)
  | "size_unknown"
  | "size_unavailable"
  // scripts and agent-launched runs (demo-path §8, §9)
  | "script_invalid"
  | "script_failed"
  | "script_limit"
  | "workflow_guard"
  // release prep (docs/spec/release-prep.md)
  | "pr_target";

/** Every member of ErrorCode, for exhaustiveness checks. */
export const ERROR_CODES: readonly ErrorCode[] = [
  "config",
  "timeout_order",
  "provider_lifetime",
  "nesting_depth",
  "non_determinism",
  "duplicate_label",
  "sandbox_handle_scope",
  "sandbox_busy",
  "not_owner",
  "sandbox_cap_deadlock",
  "run_id_conflict",
  "no_active_run",
  "journal_version",
  "skill_load",
  "duplicate_skill",
  "contract",
  "input_invalid",
  "hitl_config",
  "ask_spec",
  "secret_missing",
  "credential_missing",
  "credential_refresh",
  "repo_unprotected",
  "secret_in_env",
  "egress_unsupported",
  "image_secret",
  "price_unknown",
  "no_result",
  "result_invalid",
  "result_integrity",
  "done_check_failed",
  "skill_context_failed",
  "artifact_failed",
  "harness_start",
  "harness_protocol",
  "harness_error",
  "harness_version_unavailable",
  "sandbox_unavailable",
  "sandbox_guest_gone",
  "sandbox_not_found",
  "sandbox_file_not_found",
  "exec_timeout",
  "sandbox_quota",
  "sandbox_auth",
  "sandbox_wedged",
  "sandbox_unsupported",
  "sandbox_not_quiescent",
  "sandbox_output",
  "snapshot_unclean",
  "image_unavailable",
  "image_activation_pending",
  "budget",
  "timeout",
  "idle_timeout",
  "boot",
  "interrupted",
  "lost",
  "push_failed",
  "host_step_limit",
  "aborted",
  "journal_conflict",
  "journal_divergence",
  "lease_lost",
  "ask_timeout",
  "ask_cancelled",
  "channel_delivery",
  "webhook_signature",
  "size_unknown",
  "size_unavailable",
  "script_invalid",
  "script_failed",
  "script_limit",
  "workflow_guard",
  "pr_target",
];

/** Everything needed to pick up the pieces by hand. Every field is optional (spec §9.8). */
export interface Recovery {
  /** The call's branch, pushed or local. */
  branch?: string;
  headSha?: string;
  commits?: string[];
  /** The harness session, resumable with the same harness version. */
  sessionId?: string;
  /** Set when the box was kept. */
  sandbox?: SandboxRef;
  snapshotId?: string;
  /** Read with `ref.text()`. */
  transcript?: ArtifactRef;
  /** DoneCheckFailedError, ArtifactError. */
  lastValidResult?: unknown;
  skill?: { name: string; hash: string };
  /** AskTimeoutError and AskCancelledError. */
  askId?: string;
}

/** The JSON form of a SelfbuildingError, as carried in RawOutcome and host step values (spec §7.4). */
export interface SerializedSelfbuildingError {
  name: string;
  code: ErrorCode;
  kind: "usage" | "agent";
  retryable: boolean;
  message: string;
  runId?: string;
  callPath?: string;
  recovery?: Omit<Recovery, "transcript"> & { transcript?: ArtifactRefJson };
  /** Class-specific fields, e.g. `{ phase: "running" }` on BudgetExceededError. */
  details?: Record<string, unknown>;
}
