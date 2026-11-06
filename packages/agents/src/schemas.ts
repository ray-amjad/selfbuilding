import { ReviewTarget } from "@selfbuilding/core";
import { z } from "zod";

// Input and result schemas of the built-in agents (BASIC-SCOPE.md, "The built-in agents"). None of the inputs
// carries repo, branch, base, git or pr: those are call options (spec §2.4.3).

/** Where every agent drops files the run should collect. Outside the workdir, so never part of the diff. */
export const OUT_FILES_DIR = "/selfbuilding/out/files";
/** The one notes file every builder and fixer appends to. */
export const IMPLEMENTATION_NOTES_PATH = `${OUT_FILES_DIR}/implementation-notes.md`;
/** Where Verify keeps its setup files, claims, verdicts and evidence. */
export const VERIFY_EVIDENCE_DIR = `${OUT_FILES_DIR}/verify`;
/** Written by the runtime for review contracts (spec §2.3.1). */
export const REVIEW_DIFF_PATH = "/selfbuilding/in/diff.patch";

// code-review

export const ReviewTier = z.enum(["medium", "high"]);
export type ReviewTier = z.infer<typeof ReviewTier>;

export const FindingSeverity = z.enum(["critical", "high", "medium", "low", "nit"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const FindingVerdict = z.enum(["CONFIRMED", "PLAUSIBLE"]);
export type FindingVerdict = z.infer<typeof FindingVerdict>;

export const CodeReviewFinding = z.object({
  file: z.string().min(1).describe("Path relative to the repository root; must appear in the diff"),
  line: z.number().int().positive().optional(),
  severity: FindingSeverity,
  category: z.string().min(1).max(40).describe('e.g. "correctness", "simplification", "efficiency"'),
  summary: z.string().min(1).max(1000).describe("One-sentence statement of the defect"),
  failureScenario: z.string().min(1).max(2000).describe("Concrete inputs/state → wrong output/crash"),
  verdict: FindingVerdict,
});
export type CodeReviewFinding = z.infer<typeof CodeReviewFinding>;

export const CodeReviewInput = z.object({
  /** Optional only on a shared handle, where the handle's branch is reviewed against its base. */
  target: ReviewTarget.optional(),
  /** Overrides the tier the diff size would pick. */
  tier: ReviewTier.optional(),
  focus: z.array(z.string().min(1)).max(10).optional(),
  testsPassed: z.boolean().optional(),
  notes: z.string().max(4000).optional(),
});
export type CodeReviewInput = z.input<typeof CodeReviewInput>;

/** The most findings each tier returns (its prompt's output cap). */
export const TIER_FINDING_CAP: Record<ReviewTier, number> = { medium: 8, high: 10 };

export const CodeReviewResult = z.object({
  /** A pull-request review event, lower-cased. */
  verdict: z.enum(["approve", "request_changes", "comment"]),
  tier: ReviewTier,
  summary: z.string().min(1).max(4000),
  findings: z.array(CodeReviewFinding).max(TIER_FINDING_CAP.high),
});
export type CodeReviewResult = z.infer<typeof CodeReviewResult>;

// implement-spec

export const SpecSource = z.union([
  z.string().min(1),
  z.object({ path: z.string().min(1).describe("A spec file in the repository") }),
]);

export const ImplementSpecInput = z.object({
  spec: SpecSource,
  /** Findings to fix, e.g. from CodeReview. Present means "fix these", not "build the spec". */
  feedback: z.array(CodeReviewFinding).optional(),
  testCommand: z.string().min(1).optional(),
  /** What a previous builder left: its summary, what it could not finish. */
  context: z.string().max(8000).optional(),
});
export type ImplementSpecInput = z.input<typeof ImplementSpecInput>;

export const ImplementSpecResult = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string().min(1).max(4000),
  changes: z.array(z.object({ file: z.string().min(1), why: z.string().min(1) })),
  tests: z.object({ command: z.string().min(1), passed: z.boolean() }).optional(),
  followUps: z.array(z.string()),
  openQuestions: z.array(z.string()),
  prTitle: z.string().min(1).max(120),
  prBody: z.string(),
});
export type ImplementSpecResult = z.infer<typeof ImplementSpecResult>;

// verify

export const VerifyOutcome = z.enum(["verified", "broken", "could_not_boot", "unverifiable"]);
export type VerifyOutcome = z.infer<typeof VerifyOutcome>;

export const VerifyFlow = z.object({
  name: z.string().min(1).max(80),
  /** The end state the user reaches. */
  endState: z.string().min(1).max(2000),
  /** The rows the app must write. */
  rows: z.array(z.string().min(1)).optional(),
  /** Effects outside the app; a missing one fails the flow unless optional. */
  sideEffects: z.array(z.object({ what: z.string().min(1), optional: z.boolean().optional() })).optional(),
});
export type VerifyFlow = z.infer<typeof VerifyFlow>;

export const VerifyInput = z.object({
  /** What changed, in plain words. */
  change: z.string().min(1).max(8000),
  /** Omitted: the agent derives the flows from the diff. */
  flows: z.array(VerifyFlow).max(10).optional(),
  /** Boot facts, when the repository has no .selfbuilding/verify/README.md. */
  appNotes: z.string().max(8000).optional(),
});
export type VerifyInput = z.input<typeof VerifyInput>;

export const VerifyDefect = z.object({
  where: z.string().min(1),
  seen: z.string().min(1),
  evidence: z.string().min(1),
});
export type VerifyDefect = z.infer<typeof VerifyDefect>;

export const VerifyFlowResult = z.object({
  name: z.string().min(1),
  /** The checker's verdict; the caller routes on this, never on the claim. */
  outcome: VerifyOutcome,
  /** The verifier's claim. The checker may lower it, never raise it. */
  claim: VerifyOutcome.optional(),
  detail: z.string().min(1).max(2000),
  /** Absolute path of the flow's one evidence file, under /selfbuilding/out/files/. */
  evidence: z.string().min(1),
  /** Every other file for the flow (screenshots, trace, db dump, server log), under the same flow directory. */
  evidenceFiles: z.array(z.string().min(1)).max(50).optional(),
  checked: z.array(z.string()),
  defects: z.array(VerifyDefect),
});
export type VerifyFlowResult = z.infer<typeof VerifyFlowResult>;

export const VerifyResult = z.object({
  summary: z.string().min(1).max(4000),
  flows: z.array(VerifyFlowResult),
  /** Every evidence path, collected as artifacts. */
  files: z.array(z.string().min(1)),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

// The per-flow evidence layout (demo-path §4.2). The paths are fixed so the three roles, the done check and the
// run summary find the same files without being told.

/** A flow's directory name: lowercased, runs of anything but `[a-z0-9]` become "-", trimmed, at most 48 chars. */
export function verifySlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug === "" ? "flow" : slug;
}

/** The files of one flow, relative to its directory. */
export const VERIFY_FLOW_FILES = {
  setup: "setup.json",
  claim: "claim.json",
  verdict: "verdict.json",
  evidence: "evidence.md",
  screenshots: "screenshots",
  db: "db.txt",
  serverLog: "server.log",
  trace: "trace.zip",
} as const;
export type VerifyFlowFile = keyof typeof VERIFY_FLOW_FILES;

/** The absolute paths of one flow's files, under `/selfbuilding/out/files/verify/<slug>/`. */
export function verifyFlowPaths(name: string): { dir: string } & Record<VerifyFlowFile, string> {
  const dir = `${VERIFY_EVIDENCE_DIR}/${verifySlug(name)}`;
  const paths = Object.fromEntries(Object.entries(VERIFY_FLOW_FILES).map(([key, file]) => [key, `${dir}/${file}`]));
  return { dir, ...(paths as Record<VerifyFlowFile, string>) };
}

/** How long setup waits for the readiness URL before the flow is `could_not_boot`. */
export const VERIFY_BOOT_WAIT_SECONDS = 300;
/** The tail of the dev server log the checker keeps as `server.log`. */
export const VERIFY_SERVER_LOG_BYTES = 64 * 1024;

/** `setup.json`: everything the verifier and the checker learn from setup. Extra keys are kept. */
export const VerifySetupFile = z.looseObject({
  app_url: z.string().min(1),
  readiness_url: z.string().min(1).optional(),
  database_path: z.string().min(1).optional(),
  server_log: z.string().min(1).optional(),
  /** false: the readiness URL never answered; the flow is `could_not_boot`. */
  booted: z.boolean().optional(),
  seeded: z.record(z.string(), z.unknown()).optional(),
  shims: z.array(z.record(z.string(), z.unknown())).optional(),
  external: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type VerifySetupFile = z.infer<typeof VerifySetupFile>;

/** `claim.json`: what the verifier says happened. */
export const VerifyClaimFile = z.looseObject({
  outcome: VerifyOutcome,
  evidence_file: z.string().min(1),
  detail: z.string().min(1),
  observations: z.array(z.string()).optional(),
});
export type VerifyClaimFile = z.infer<typeof VerifyClaimFile>;

/** `verdict.json`: the checker's judgement. The result's `outcome` repeats it. */
export const VerifyVerdictFile = z.looseObject({
  outcome: VerifyOutcome,
  claim: VerifyOutcome.optional(),
  detail: z.string().min(1),
  checked: z.array(z.string()),
  defects: z.array(VerifyDefect).optional(),
});
export type VerifyVerdictFile = z.infer<typeof VerifyVerdictFile>;
