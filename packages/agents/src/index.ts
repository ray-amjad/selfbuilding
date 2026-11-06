// @selfbuilding/agents: the built-in agents and the shipChange factory (BASIC-SCOPE.md).
import { Agent } from "@selfbuilding/core";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { codex } from "@selfbuilding/harnesses/codex";
import { codeReviewContract, findFlowsContract, implementSpecContract, verifyContract } from "./contracts.js";
import { createVerifyFlows } from "./flows/index.js";
import type { FindFlowsInput, FindFlowsResult } from "./flows/schemas.js";
import { skillDir } from "./pack.js";
import type {
  CodeReviewInput,
  CodeReviewResult,
  ImplementSpecInput,
  ImplementSpecResult,
  VerifyInput,
  VerifyResult,
} from "./schemas.js";
import { createShipChange } from "./ship-change.js";

export {
  type DiffStat,
  filesInPatch,
  findingsInDiffCheck,
  findingsOutsideDiff,
  findTestRemovals,
  implementationNotesCheck,
  noTestRemovalCheck,
  parseNumstat,
  pickReviewTier,
  type VerifyRoleFiles,
  verdictConsistentCheck,
  verdictProblems,
  verifyEvidenceCheck,
  verifyResultProblems,
  verifyRoleFileProblems,
} from "./checks.js";
export {
  codeReviewContract,
  findFlowsContract,
  implementSpecContract,
  VERIFY_BROWSER_SERVER,
  VERIFY_BROWSERS_PATH,
  VERIFY_DEFAULT_SIZE,
  verifyContract,
} from "./contracts.js";
export {
  composePrBody,
  type DecisionPageInput,
  type MergeRecommendation,
  type RoundSummary,
  recommend,
  renderDecisionPage,
  replaceSection,
} from "./decision-page.js";
export { describeFinding, findingKey, type MergedFinding, mergeFindings } from "./findings.js";
export {
  createVerifyFlows,
  FindFlowsInput,
  FindFlowsResult,
  FlowEvidence,
  FlowKind,
  FlowVerdict,
  FoundFlow,
  findFlowsConsistentCheck,
  findFlowsProblems,
  flowSlug,
  type RunSummaryInput,
  type RunSummarySlack,
  renderRunSummary,
  type VerifyFlowsAgents,
  VerifyFlowsInput,
  type VerifyFlowsOptions,
  VerifyFlowsOutput,
} from "./flows/index.js";
export { type BuiltInSkillName, defaultPack, SKILL_NAMES, skillDir } from "./pack.js";
export {
  CodeReviewFinding,
  CodeReviewInput,
  CodeReviewResult,
  FindingSeverity,
  FindingVerdict,
  IMPLEMENTATION_NOTES_PATH,
  ImplementSpecInput,
  ImplementSpecResult,
  OUT_FILES_DIR,
  REVIEW_DIFF_PATH,
  ReviewTier,
  SpecSource,
  TIER_FINDING_CAP,
  VERIFY_BOOT_WAIT_SECONDS,
  VERIFY_EVIDENCE_DIR,
  VERIFY_FLOW_FILES,
  VERIFY_SERVER_LOG_BYTES,
  VerifyClaimFile,
  VerifyDefect,
  VerifyFlow,
  type VerifyFlowFile,
  VerifyFlowResult,
  VerifyInput,
  VerifyOutcome,
  VerifyResult,
  VerifySetupFile,
  VerifyVerdictFile,
  verifyFlowPaths,
  verifySlug,
} from "./schemas.js";
export {
  createShipChange,
  type Placement,
  type ReviewerSpec,
  type ShipChangeAgents,
  ShipChangeInput,
  type ShipChangeOptions,
  ShipChangeOutput,
} from "./ship-change.js";

// Agent.fromSkill validates each folder at import time, so a broken built-in skill fails here, loudly.

/** Builds a change from a spec on its own branch, with implementation notes. Runs on Claude Code by default. */
export const ImplementSpec: Agent<ImplementSpecInput, ImplementSpecResult> = await Agent.fromSkill(
  skillDir("implement-spec"),
  { ...implementSpecContract, defaults: { harness: claudeCode() } },
);

/** Reviews a target at the medium or high tier. One skill for every harness; pick one per call with `harness`. */
export const CodeReview: Agent<CodeReviewInput, CodeReviewResult> = await Agent.fromSkill(
  skillDir("code-review"),
  codeReviewContract,
);

/**
 * Proves a web-app change runs for a real user: setup boots the app on a fresh database, the verifier drives each
 * flow through the `browser` MCP server, the checker reads the database and logs and writes the verdict. Runs on
 * Codex, at `medium` on a fresh box (a fork or a shared handle keeps its own size).
 */
export const Verify: Agent<VerifyInput, VerifyResult> = await Agent.fromSkill(skillDir("verify"), {
  ...verifyContract,
  defaults: { ...verifyContract.defaults, harness: codex() },
});

/**
 * The default shipChange factory: ImplementSpec on Claude Code, a Claude Code and a Codex reviewer on forks of the
 * build box, the fixer on the builder's harness, Verify on a fork with Codex. Use `createShipChange` to place the
 * reviewers or the verifier elsewhere (a fresh box, or another provider) or to open the PR with a GitHub App.
 */
export const shipChange = createShipChange({
  agents: { ImplementSpec, CodeReview, Verify },
  builder: { harness: claudeCode() },
  reviewers: [
    { label: "claude-code", harness: claudeCode(), sandbox: "fork" },
    { label: "codex", harness: codex(), sandbox: "fork" },
  ],
  verifier: { harness: codex(), sandbox: "fork" },
});

/** Reads a diff and lists every user flow it adds or changes, plus the nearest regression. Claude Code by default. */
export const FindFlows: Agent<FindFlowsInput, FindFlowsResult> = await Agent.fromSkill(skillDir("find-flows"), {
  ...findFlowsContract,
  defaults: { harness: claudeCode() },
});

/**
 * The default verifyFlows factory: ImplementSpec on Claude Code in a medium build box, CodeReview and FindFlows on
 * forks of it, then one Verify per flow on Codex, each on its own fork, and the summary page. Use
 * `createVerifyFlows` to change harnesses, sizes, or to open the PR with a GitHub App.
 */
export const verifyFlows = createVerifyFlows({
  agents: { ImplementSpec, CodeReview, FindFlows, Verify },
  builder: { harness: claudeCode() },
  reviewer: { harness: claudeCode() },
  finder: { harness: claudeCode() },
  verifier: { harness: codex() },
});
