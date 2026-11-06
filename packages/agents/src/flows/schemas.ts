import { ReviewTarget } from "@selfbuilding/core";
import { z } from "zod";
import { CodeReviewResult, SpecSource, VerifyFlow, VerifyOutcome } from "../schemas.js";

// findFlows and verifyFlows (docs/spec/demo-path.md §4). Owner: verify-flows.

// find-flows

export const FlowKind = z.enum(["new", "changed", "regression"]);
export type FlowKind = z.infer<typeof FlowKind>;

export const FindFlowsInput = z.object({
  /** What changed, in plain words (the builder's summary). The diff itself is the review target. */
  change: z.string().min(1).max(8000),
  /** Default 6, at most 10. */
  maxFlows: z.number().int().min(1).max(10).optional(),
  /**
   * The diff to read, written to /selfbuilding/in/diff.patch. Optional only on a shared handle, where the handle's
   * branch is read against its base.
   */
  target: ReviewTarget.optional(),
});
export type FindFlowsInput = z.input<typeof FindFlowsInput>;

export const FoundFlow = VerifyFlow.extend({
  kind: FlowKind,
  /** Where a user starts the flow: a URL path ("/notes") or a UI entry ("the Add button on /"). */
  entry: z.string().min(1).max(500),
  /** Why this flow is affected, tied to the diff. */
  why: z.string().min(1).max(1000),
});
export type FoundFlow = z.infer<typeof FoundFlow>;

export const FindFlowsResult = z.object({
  summary: z.string().min(1).max(4000),
  /** Ordered: new flows first, then changed, then the nearest regression. */
  flows: z.array(FoundFlow).max(10),
  /** True for docs-only, types-only, CI-only or pure-refactor diffs; `flows` is then empty. */
  noRunnableSurface: z.boolean(),
  skipped: z.array(z.object({ what: z.string().min(1), why: z.string().min(1) })),
});
export type FindFlowsResult = z.infer<typeof FindFlowsResult>;

// verify-flows

export const FlowEvidence = z.object({
  /** Path inside the box, under /selfbuilding/out/files/verify/<flow-slug>/. */
  path: z.string().min(1),
  /** The stored artifact (s3://, file://). Never a signed URL: those expire. */
  uri: z.string().min(1),
  contentType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
});
export type FlowEvidence = z.infer<typeof FlowEvidence>;

export const FlowVerdict = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  kind: FlowKind.optional(),
  outcome: VerifyOutcome,
  detail: z.string(),
  /** The flow's Verify call. */
  callPath: z.string(),
  evidence: z.array(FlowEvidence),
  /** Set when the Verify call itself failed; `outcome` is then "unverifiable". */
  error: z.string().optional(),
});
export type FlowVerdict = z.infer<typeof FlowVerdict>;

export const VerifyFlowsInput = z.object({
  /** "github.com/acme/api" */
  repo: z.string().min(1),
  spec: SpecSource,
  baseBranch: z.string().min(1).optional(),
  testCommand: z.string().min(1).optional(),
  /** Boot facts when the repository has no .selfbuilding/verify/README.md. */
  appNotes: z.string().max(8000).optional(),
  /** Given: findFlows is skipped and exactly these are verified. */
  flows: z.array(VerifyFlow).max(10).optional(),
  /** Default 6. */
  maxFlows: z.number().int().min(1).max(10).optional(),
});
export type VerifyFlowsInput = z.input<typeof VerifyFlowsInput>;

export const VerifyFlowsOutput = z.object({
  status: z.enum(["all_verified", "some_failed", "no_flows", "build_incomplete"]),
  branch: z.string(),
  pr: z.object({ url: z.string(), number: z.number().int() }).nullable(),
  build: z.object({ status: z.enum(["done", "blocked", "failed"]), summary: z.string() }),
  review: z
    .union([
      z.object({
        verdict: CodeReviewResult.shape.verdict,
        findings: z.number().int(),
        summary: z.string(),
      }),
      z.object({ error: z.string() }),
    ])
    .nullable(),
  flows: z.array(FlowVerdict),
  summary: z.object({
    markdown: z.string(),
    /** The stored HTML page. */
    page: z.object({ uri: z.string(), sha256: z.string(), bytes: z.number().int(), contentType: z.string() }),
  }),
});
export type VerifyFlowsOutput = z.infer<typeof VerifyFlowsOutput>;
