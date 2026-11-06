import {
  type Agent,
  type AgentResult,
  agent,
  ask,
  type Budget,
  type ConcurrencyOptions,
  type Factory,
  type FactoryOptions,
  factory,
  type Harness,
  type HitlOptions,
  isUsageError,
  log,
  type PullRequestApi,
  parallel,
  phase,
  type SandboxHandle,
  type SandboxProvider,
  sandbox,
  step,
} from "@selfbuilding/core";
import { z } from "zod";
import { parseNumstat, pickReviewTier } from "./checks.js";
import { composePrBody, type RoundSummary, recommend, renderDecisionPage } from "./decision-page.js";
import { findingKey, type MergedFinding, mergeFindings } from "./findings.js";
import {
  CodeReviewFinding,
  type CodeReviewInput,
  type CodeReviewResult,
  IMPLEMENTATION_NOTES_PATH,
  type ImplementSpecInput,
  type ImplementSpecResult,
  SpecSource,
  VerifyFlow,
  type VerifyInput,
  VerifyOutcome,
  type VerifyResult,
} from "./schemas.js";

/** Where an agent call runs: a fork of the build box, a fresh box on the default provider, or one on another provider. */
export type Placement = "fork" | "fresh" | SandboxProvider;

export interface ReviewerSpec {
  /** Unique; names the call (`review-<round>-<label>`) and the reviewer in reports. */
  label: string;
  harness?: Harness;
  /** Default "fork": a copy of the build box, so the reviewer sees exactly what was built. */
  sandbox?: Placement;
}

export interface ShipChangeAgents {
  ImplementSpec: Agent<ImplementSpecInput, ImplementSpecResult>;
  CodeReview: Agent<CodeReviewInput, CodeReviewResult>;
  Verify: Agent<VerifyInput, VerifyResult>;
}

export interface ShipChangeOptions {
  agents: ShipChangeAgents;
  /** Default "ship-change". */
  name?: string;
  /** The build box. Its harness also runs the fixers unless `fixer.harness` is set. */
  builder?: { harness?: Harness; provider?: SandboxProvider };
  /** The review panel, run in parallel each round. At least one. */
  reviewers: readonly ReviewerSpec[];
  fixer?: { harness?: Harness };
  /** Default sandbox "fork". "shared" runs Verify in the build box itself. */
  verifier?: { harness?: Harness; sandbox?: Placement | "shared" };
  /** Review-and-fix rounds; default 2. A clean round ends the loop early. */
  maxReviewRounds?: number;
  /** Fix-and-reverify rounds after a broken flow; default 1. */
  maxVerifyFixRounds?: number;
  /**
   * Opens and refreshes the PR as the host's identity (a GitHub App's `pullRequests`). With it, the PR body carries
   * the implementation notes and the verification results. Without it, the build call opens the PR from the
   * builder's `prTitle` and `prBody`.
   */
  pullRequests?: PullRequestApi;
  /** Default true. */
  draft?: boolean;
  budget?: Budget;
  concurrency?: ConcurrencyOptions;
  hitl?: HitlOptions;
}

export const ShipChangeInput = z.object({
  /** "github.com/acme/api" */
  repo: z.string().min(1),
  spec: SpecSource,
  /** Default: the repository's default branch. */
  baseBranch: z.string().min(1).optional(),
  testCommand: z.string().min(1).optional(),
  /** The flows Verify proves; omitted, Verify derives them from the diff. */
  flows: z.array(VerifyFlow).max(10).optional(),
});
export type ShipChangeInput = z.input<typeof ShipChangeInput>;

const RoundOutput = z.object({
  round: z.number().int(),
  tier: z.enum(["medium", "high"]),
  reviewers: z.array(
    z.object({
      label: z.string(),
      ok: z.boolean(),
      verdict: z.string().optional(),
      findings: z.number().int().optional(),
      error: z.string().optional(),
    }),
  ),
  fixNow: z.number().int(),
  carried: z.number().int(),
  fixed: z.number().int(),
  unresolved: z.array(z.string()),
});

export const ShipChangeOutput = z.object({
  status: z.enum(["awaiting_decision", "build_incomplete"]),
  branch: z.string(),
  pr: z.object({ url: z.string(), number: z.number().int() }).nullable(),
  build: z.object({ status: z.enum(["done", "blocked", "failed"]), summary: z.string() }),
  rounds: z.array(RoundOutput),
  carried: z.array(CodeReviewFinding.extend({ reviewers: z.array(z.string()) })),
  unresolved: z.array(z.string()),
  verify: z
    .union([
      z.object({ flows: z.array(z.object({ name: z.string(), outcome: VerifyOutcome, detail: z.string() })) }),
      z.object({ error: z.string() }),
    ])
    .nullable(),
  decision: z.object({
    recommended: z.enum(["merge", "change-first"]),
    choice: z.string().nullable(),
    answeredBy: z.string().nullable(),
  }),
  decisionPage: z.string(),
  /** shipChange never merges; a human does, after the decision. */
  merged: z.literal(false),
});
export type ShipChangeOutput = z.infer<typeof ShipChangeOutput>;

const FixResult = z.object({
  summary: z.string().min(1).max(4000),
  fixed: z.array(z.object({ file: z.string(), line: z.number().int().optional(), summary: z.string() })),
  unresolved: z.array(
    z.object({ file: z.string(), line: z.number().int().optional(), summary: z.string(), reason: z.string() }),
  ),
});
type FixResult = z.infer<typeof FixResult>;

const FIX_PROMPT = `You are a fixer on an existing branch. Fix exactly the findings in the input, nothing else.

- Findings with one root cause get one design, not N patches: a locally correct patch can break a property the
  code holds somewhere else.
- The defect is proven, but the suggested remedy is a guess. You may reject a remedy you find worse, but you must
  still fix the defect and say what you did instead.
- Commit after each group of findings, with clear messages. Do not push and do not open a pull request.
- Run the type checker, the linter and the tests for the area you changed (the input's testCommand if it has one).
- Do not finish half-built features or start new work. Do not delete, skip or focus tests.
- Append each call you make to ${IMPLEMENTATION_NOTES_PATH} (create it with the sections Design decisions,
  Deviations, Tradeoffs and Open questions if it is missing).
- A finding you cannot resolve goes in "unresolved", with why.`;

const exitedZero = (r: { exitCode: number }) => r.exitCode === 0;
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const prRef = (pr: { url: string; number: number } | undefined | null) =>
  pr ? { url: pr.url, number: pr.number } : null;

/**
 * Builds the shipChange factory: ImplementSpec in a shared box, a PR opened as the host, up to two rounds of a
 * parallel review panel (each reviewer on a fork of the build box, a fresh box, or another provider) with a fixer
 * in the shared box, then Verify, then a merge question with the decision page. It never merges.
 */
export function createShipChange(o: ShipChangeOptions): Factory<z.infer<typeof ShipChangeInput>, ShipChangeOutput> {
  if (o.reviewers.length === 0) throw new Error("shipChange needs at least one reviewer");
  const labels = new Set(o.reviewers.map((r) => r.label));
  if (labels.size !== o.reviewers.length) throw new Error("shipChange reviewer labels must be unique");
  const A = o.agents;
  const maxReviewRounds = o.maxReviewRounds ?? 2;
  const maxVerifyFixRounds = o.maxVerifyFixRounds ?? 1;
  const draft = o.draft ?? true;

  const opts: FactoryOptions<typeof ShipChangeInput, typeof ShipChangeOutput> = {
    name: o.name ?? "ship-change",
    input: ShipChangeInput,
    output: ShipChangeOutput,
  };
  if (o.budget) opts.budget = o.budget;
  if (o.concurrency) opts.concurrency = o.concurrency;
  if (o.hitl) opts.hitl = o.hitl;

  return factory(opts, async (input) => {
    const box = sandbox({ provider: o.builder?.provider, repo: input.repo, label: "work" });
    try {
      return await ship(input, box);
    } finally {
      // Paused, not killed: a human may want to continue in the build box after the decision.
      await box.dispose({ mode: "pause" });
    }
  });

  async function ship(input: z.infer<typeof ShipChangeInput>, box: SandboxHandle): Promise<ShipChangeOutput> {
    const { repo } = input;
    const fixerHarness = o.fixer?.harness ?? o.builder?.harness;

    // 1. Build: one builder, and one more on the same branch if the first leaves work undone.
    phase("build");
    const buildOpts = (label: string) => ({
      sandbox: box,
      label,
      ...(o.builder?.harness ? { harness: o.builder.harness } : {}),
      ...(input.baseBranch ? { git: { baseBranch: input.baseBranch } } : {}),
      // Without a PR API the host opens the PR in the build call's collect step, from prTitle and prBody.
      ...(o.pullRequests ? {} : { pr: { draft } }),
    });
    const implementInput: ImplementSpecInput = { spec: input.spec };
    if (input.testCommand) implementInput.testCommand = input.testCommand;
    let build = await A.ImplementSpec(implementInput, buildOpts("implement"));
    if (build.result.status !== "done") {
      log("warn", "the builder left work undone; one more builder finishes it", { status: build.result.status });
      build = await A.ImplementSpec(
        {
          ...implementInput,
          context: `A previous builder stopped with status ${build.result.status}: ${build.result.summary}`,
        },
        buildOpts("implement-finish"),
      );
    }
    const branch = build.artifacts.branch;
    const branchName = branch?.name ?? (await step("push-build", () => box.push())).name;
    if (build.result.status !== "done") {
      const page = renderDecisionPage({
        repo,
        pr: null,
        branch: branchName,
        title: build.result.prTitle,
        summary: `The build stopped with status ${build.result.status}: ${build.result.summary}`,
        openQuestions: build.result.openQuestions,
        rounds: [],
        unresolved: [],
        carried: [],
        verify: null,
      });
      return {
        status: "build_incomplete",
        branch: branchName,
        pr: null,
        build: { status: build.result.status, summary: build.result.summary },
        rounds: [],
        carried: [],
        unresolved: [],
        verify: null,
        decision: { recommended: "change-first", choice: null, answeredBy: null },
        decisionPage: page,
        merged: false,
      };
    }
    const baseSha = branch?.baseSha;
    const baseBranch = branch?.base ?? input.baseBranch ?? "main";

    // 2. Open the PR as the host, with the notes in the body.
    phase("open-pr");
    // Pushes and execs on the handle are journaled steps: on a resume they return what they returned the first
    // time, instead of re-running against a tree that later fixes already changed.
    const head = await step("push-pr", () => box.push());
    let pr = prRef(build.artifacts.pr);
    if (o.pullRequests) {
      const api = o.pullRequests;
      pr = prRef(
        await step("open-pr", async () =>
          api.openOrUpdate({
            repo,
            head: head.name,
            base: baseBranch,
            title: build.result.prTitle,
            body: composePrBody({ prBody: build.result.prBody, notes: await readNotes(box) }),
            draft,
          }),
        ),
      );
    } else if (!pr) {
      log("warn", "no pullRequests API was given and the build call opened no PR; continuing on the branch");
    }

    // 3. Review and fix, up to maxReviewRounds.
    const rounds: RoundSummary[] = [];
    const carried: MergedFinding[] = [];
    const carriedKeys = new Set<string>();
    const unresolved: string[] = [];
    for (let round = 1; round <= maxReviewRounds; round++) {
      phase(`review-${round}`);
      const pushed = await step(`review-${round}-push`, () => box.push());
      const diffBase = baseSha ?? baseBranch;
      const { tier, reason } = await step(`review-${round}-tier`, async () => {
        const numstat = await box.exec(`git diff --numstat ${shellQuote(diffBase)}...HEAD`);
        return pickReviewTier(parseNumstat(numstat.stdoutTail));
      });
      const testCommand = input.testCommand;
      const testsPassed = testCommand
        ? await step(`review-${round}-tests`, async () => exitedZero(await box.exec(testCommand, { timeout: "15m" })))
        : undefined;
      const reviewInput: CodeReviewInput = {
        target: { kind: "diff", base: baseBranch, head: pushed.name },
        tier,
        notes: `Tier ${tier}: ${reason}.`,
      };
      if (testsPassed !== undefined) reviewInput.testsPassed = testsPassed;

      const reviews = await runPanel(box, repo, round, reviewInput);
      const summary: RoundSummary = {
        round,
        tier,
        reviewers: reviews.map((r) =>
          r.value
            ? { label: r.label, ok: true, verdict: r.value.result.verdict, findings: r.value.result.findings.length }
            : { label: r.label, ok: false, error: "the reviewer failed" },
        ),
        fixNow: 0,
        carried: 0,
        fixed: 0,
        unresolved: [],
      };
      rounds.push(summary);
      const answered = reviews.flatMap((r) => (r.value ? [{ label: r.label, findings: r.value.result.findings }] : []));
      for (const r of reviews) if (!r.value) log("warn", `reviewer ${r.label} is unavailable this round`, { round });
      if (answered.length === 0) {
        log("warn", "no reviewer answered; stopping the review loop", { round });
        break;
      }

      const { fixNow, carry } = mergeFindings(answered);
      for (const f of carry) {
        const key = findingKey(f);
        if (carriedKeys.has(key)) continue;
        carriedKeys.add(key);
        carried.push(f);
        summary.carried++;
      }
      summary.fixNow = fixNow.length;
      if (fixNow.length === 0) break;

      phase(`fix-${round}`);
      const fix = await runFixer(box, `fix-${round}`, fixerHarness, {
        findings: fixNow,
        testCommand: input.testCommand,
      });
      summary.fixed = fix.fixed.length;
      summary.unresolved = fix.unresolved.map(formatUnresolved);
      unresolved.push(...summary.unresolved);
    }

    // 4. Verify, with one fix-and-reverify round for a broken flow.
    phase("verify");
    const verifyInput: VerifyInput = { change: build.result.summary };
    if (input.flows) verifyInput.flows = input.flows;
    let verify = await runVerify(box, repo, verifyInput, "verify");
    for (let attempt = 1; attempt <= maxVerifyFixRounds; attempt++) {
      if (!verify.value) break;
      const broken = verify.value.result.flows.filter((f) => f.outcome === "broken");
      if (broken.length === 0) break;
      phase(`verify-fix-${attempt}`);
      const fix = await runFixer(box, `verify-fix-${attempt}`, fixerHarness, {
        brokenFlows: broken,
        testCommand: input.testCommand,
      });
      unresolved.push(...fix.unresolved.map(formatUnresolved));
      verify = await runVerify(box, repo, verifyInput, `reverify-${attempt}`);
    }
    const verifySummary: ShipChangeOutput["verify"] = verify.value
      ? { flows: verify.value.result.flows.map((f) => ({ name: f.name, outcome: f.outcome, detail: f.detail })) }
      : { error: verify.error };

    // Refresh the PR body with the final notes and the verification results.
    if (o.pullRequests && pr) {
      const api = o.pullRequests;
      const final = await step("push-final", () => box.push());
      await step("update-pr", async () =>
        api.openOrUpdate({
          repo,
          head: final.name,
          base: baseBranch,
          title: build.result.prTitle,
          body: composePrBody({
            prBody: build.result.prBody,
            notes: await readNotes(box),
            verified: "flows" in verifySummary ? verifySummary.flows : null,
          }),
          draft,
        }),
      );
    }

    // 5. Ask before any merge. AFK resolves to "change-first": an unattended run never merges.
    phase("decide");
    const pageInput = {
      repo,
      pr,
      branch: branchName,
      title: build.result.prTitle,
      summary: build.result.summary,
      openQuestions: build.result.openQuestions,
      rounds,
      unresolved,
      carried,
      verify: verifySummary,
    };
    const page = renderDecisionPage(pageInput);
    const recommended = recommend(pageInput).choice;
    let decision: ShipChangeOutput["decision"] = { recommended, choice: null, answeredBy: null };
    if (pr) {
      const answer = await ask({
        title: `Merge PR #${pr.number}? ${build.result.prTitle}`.slice(0, 120),
        question: `Merge PR #${pr.number}?`,
        context: page.length > 4000 ? `${page.slice(0, 3990)}\n...` : page,
        choices: [
          { id: "merge", label: "Merge", style: "primary" },
          { id: "change-first", label: "Change it first", safe: true },
          { id: "close", label: "Close it", style: "danger" },
        ],
        default: "change-first",
        onTimeout: "default",
        risk: "high",
        dedupeKey: `${repo}:pr:${pr.number}`,
      });
      decision = { recommended, choice: answer.choiceId, answeredBy: answer.answeredBy.kind };
    }

    return {
      status: "awaiting_decision",
      branch: branchName,
      pr,
      build: { status: build.result.status, summary: build.result.summary },
      rounds,
      carried,
      unresolved,
      verify: verifySummary,
      decision,
      decisionPage: page,
      merged: false,
    };
  }

  async function runPanel(
    box: SandboxHandle,
    repo: string,
    round: number,
    reviewInput: CodeReviewInput,
  ): Promise<{ label: string; value: AgentResult<CodeReviewResult> | null }[]> {
    const forkCount = o.reviewers.filter((r) => (r.sandbox ?? "fork") === "fork").length;
    const forks = forkCount > 0 ? await forkOrNothing(box, forkCount, round) : [];
    try {
      let next = 0;
      const thunks = o.reviewers.map((r) => {
        const placement = r.sandbox ?? "fork";
        let where: "fresh" | SandboxProvider | SandboxHandle = placement === "fork" ? "fresh" : placement;
        if (placement === "fork") {
          const fork = forks[next++];
          if (fork) where = fork;
          else log("warn", `fork for reviewer ${r.label} failed; reviewing in a fresh sandbox instead`, { round });
        }
        const callOpts = {
          sandbox: where,
          label: `review-${round}-${r.label}`,
          ...(isHandle(where) ? {} : { repo }),
          ...(r.harness ? { harness: r.harness } : {}),
        };
        return () => A.CodeReview(reviewInput, callOpts);
      });
      const results = await parallel(thunks);
      return o.reviewers.map((r, i) => ({ label: r.label, value: results[i] ?? null }));
    } finally {
      await Promise.all(forks.map((f) => f?.dispose()));
    }
  }

  /** A fork that fails as a whole counts as every child failing: each reviewer then takes its fresh fallback. */
  async function forkOrNothing(box: SandboxHandle, n: number, round?: number): Promise<(SandboxHandle | null)[]> {
    try {
      return await box.fork(n);
    } catch (error) {
      if (isUsageError(error)) throw error;
      log("warn", `fork failed (${error instanceof Error ? error.message : String(error)}); using fresh sandboxes`, {
        ...(round === undefined ? {} : { round }),
      });
      return Array.from({ length: n }, () => null);
    }
  }

  async function runFixer(
    box: SandboxHandle,
    label: string,
    harness: Harness | undefined,
    work: { findings?: MergedFinding[]; brokenFlows?: unknown[]; testCommand: string | undefined },
  ): Promise<FixResult> {
    const fixInput: Record<string, unknown> = {};
    if (work.findings) fixInput.findings = work.findings;
    if (work.brokenFlows) fixInput.brokenFlows = work.brokenFlows;
    if (work.testCommand) fixInput.testCommand = work.testCommand;
    const result = await agent({
      name: "fixer",
      prompt: work.brokenFlows
        ? `${FIX_PROMPT}\n\nThe input lists flows that a verifier drove as a user and found broken, with the evidence. Fix the defect each one shows.`
        : FIX_PROMPT,
      input: fixInput,
      output: FixResult,
      sandbox: box,
      label,
      ...(harness ? { harness } : {}),
    });
    return result.result;
  }

  async function runVerify(
    box: SandboxHandle,
    repo: string,
    verifyInput: VerifyInput,
    label: string,
  ): Promise<{ value: AgentResult<VerifyResult>; error?: undefined } | { value: null; error: string }> {
    const placement = o.verifier?.sandbox ?? "fork";
    const harness = o.verifier?.harness ? { harness: o.verifier.harness } : {};
    let fork: SandboxHandle | null = null;
    let where: "fresh" | SandboxProvider | SandboxHandle;
    if (placement === "shared") where = box;
    else if (placement === "fork") {
      fork = (await forkOrNothing(box, 1))[0] ?? null;
      if (!fork) log("warn", "fork for Verify failed; verifying in a fresh sandbox instead");
      where = fork ?? "fresh";
    } else where = placement;
    const branchName = isHandle(where) ? undefined : (await step(`${label}-push`, () => box.push())).name;
    try {
      const settled = await A.Verify.settled(verifyInput, {
        sandbox: where,
        label,
        ...harness,
        ...(branchName ? { repo, git: { branch: branchName } } : {}),
      });
      if (settled.ok) return { value: settled.value };
      log("warn", "Verify did not complete; the flows are unverified", { code: settled.code });
      return { value: null, error: String(settled.code) };
    } finally {
      await fork?.dispose();
    }
  }
}

function isHandle(where: "fresh" | SandboxProvider | SandboxHandle): where is SandboxHandle {
  return typeof where === "object" && "push" in where && "checkpoint" in where;
}

function formatUnresolved(u: { file: string; line?: number | undefined; summary: string; reason: string }): string {
  return `${u.line !== undefined ? `${u.file}:${u.line}` : u.file}: ${u.summary} (${u.reason})`;
}

async function readNotes(box: SandboxHandle): Promise<string> {
  const r = await box.exec(`cat ${IMPLEMENTATION_NOTES_PATH} 2>/dev/null || true`);
  return r.stdoutTail;
}
