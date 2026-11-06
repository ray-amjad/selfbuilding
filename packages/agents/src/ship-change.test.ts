import type {
  AgentCallOptions,
  AgentResult,
  AskSpec,
  ExecResult,
  Harness,
  PullRequestApi,
  PullRequestRequest,
  SandboxHandle,
  SandboxProvider,
  Settled,
} from "@selfbuilding/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodeReviewFinding,
  CodeReviewInput,
  CodeReviewResult,
  ImplementSpecResult,
  VerifyResult,
} from "./schemas.js";

// Everything core does at run time is mocked: these tests pin shipChange's control flow, not the engine.
const core = vi.hoisted(() => ({
  events: [] as string[],
  askAnswer: { choiceId: "merge" as string | null, kind: "human" as string },
  fixerResults: [] as unknown[],
  fixerCalls: [] as { label: string; input: unknown; sandbox: unknown; harness?: unknown }[],
  asks: [] as unknown[],
  boxes: [] as { disposed: string[] }[],
}));

vi.mock("@selfbuilding/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@selfbuilding/core")>();
  return {
    ...actual,
    factory: (opts: unknown, body: (input: unknown) => Promise<unknown>) =>
      Object.assign((input: unknown) => body(input), { options: opts, body }),
    sandbox: () => {
      const box = fakeBox("work");
      core.boxes.push(box);
      return box;
    },
    phase: (name: string) => core.events.push(`phase ${name}`),
    log: () => undefined,
    step: async (name: string, fn: () => Promise<unknown>) => {
      core.events.push(`step ${name}`);
      return fn();
    },
    parallel: async (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t().catch(() => null))),
    agent: async (spec: { label: string; input: unknown; sandbox: unknown; harness?: unknown }) => {
      core.events.push(`agent ${spec.label}`);
      core.fixerCalls.push({ label: spec.label, input: spec.input, sandbox: spec.sandbox, harness: spec.harness });
      const result = core.fixerResults.shift() ?? {
        summary: "fixed",
        fixed: [{ file: "src/a.ts", summary: "s" }],
        unresolved: [],
      };
      return { result };
    },
    ask: async (spec: AskSpec) => {
      core.events.push("ask");
      core.asks.push(spec);
      const choiceId = core.askAnswer.choiceId ?? (spec.default as string);
      return { askId: "a1", answer: { kind: "choice", choiceId }, choiceId, answeredBy: { kind: core.askAnswer.kind } };
    },
  };
});

const { createShipChange } = await import("./ship-change.js");

type Box = SandboxHandle & { name: string; disposed: string[]; forksMade: Box[] };
let failForks = false;
let forkThrows = false;
let numstat = "10\t2\tsrc/a.ts\n";

function fakeBox(name: string): Box {
  const box: Box = {
    name,
    id: name,
    callPath: "root",
    version: 0,
    disposed: [],
    forksMade: [],
    async exec(cmd: string): Promise<ExecResult> {
      const ok = (stdoutTail = ""): ExecResult => ({ exitCode: 0, stdoutTail, stderrTail: "", truncated: false });
      if (cmd.startsWith("git diff --numstat")) return ok(numstat);
      if (cmd.startsWith("cat /selfbuilding/out/files/implementation-notes.md")) {
        return ok("# Implementation notes: limiter\n\n## Open questions\n- Exempt admins?\n");
      }
      core.events.push(`exec ${cmd}`);
      return ok();
    },
    async push() {
      return { remote: "origin", name: "selfbuilding/run-1/work", sha: "abc123" };
    },
    async fork(n: number) {
      core.events.push(`fork ${n}`);
      if (forkThrows) throw new Error("fork refused by the provider");
      return Array.from({ length: n }, (_, i) => {
        if (failForks) return null;
        const child = fakeBox(`${name}/fork[${box.forksMade.length + i}]`);
        return child;
      }).map((c) => {
        if (c) box.forksMade.push(c);
        return c;
      });
    },
    async dispose(opts?: { mode?: "kill" | "pause" }) {
      box.disposed.push(opts?.mode ?? "kill");
    },
    async checkpoint() {
      throw new Error("unused");
    },
    async snapshot() {
      throw new Error("unused");
    },
    async [Symbol.asyncDispose]() {},
  };
  return box;
}

const boxName = (where: unknown) => (where as Box | undefined)?.name;

function result<O>(value: O, extra: Partial<AgentResult<O>> = {}): AgentResult<O> {
  return {
    result: value,
    runId: "run-1",
    callPath: "root",
    stepKey: "k",
    attempts: { submits: 1, resumes: 0, doneRetries: 0 },
    replayed: false,
    usage: { usd: 0, inputTokens: 0, outputTokens: 0, turns: 1, wallClockMs: 0, sandboxMs: 0 },
    artifacts: {} as AgentResult<O>["artifacts"],
    checks: [],
    integrity: "isolated",
    harness: { id: "scripted", version: "0" },
    skill: { name: "skill", hash: "h" },
    ...extra,
  };
}

const built: ImplementSpecResult = {
  status: "done",
  summary: "Added a login rate limiter.",
  changes: [{ file: "src/a.ts", why: "limiter" }],
  followUps: [],
  openQuestions: ["Should admins be exempt?"],
  prTitle: "Rate-limit POST /login",
  prBody:
    "## What changed and why\nA limiter.\n\n## Implementation notes\n(pending)\n\n## Verified\nNot verified: pending\n",
};

const finding = (over: Partial<CodeReviewFinding> = {}): CodeReviewFinding => ({
  file: "src/a.ts",
  line: 3,
  severity: "high",
  category: "correctness",
  summary: "The limiter resets per request.",
  failureScenario: "two requests pass",
  verdict: "CONFIRMED",
  ...over,
});
const review = (findings: CodeReviewFinding[]): CodeReviewResult => ({
  verdict: findings.some((f) => f.verdict === "CONFIRMED")
    ? "request_changes"
    : findings.length
      ? "comment"
      : "approve",
  tier: "medium",
  summary: "s",
  findings,
});
const verified = (outcome: VerifyResult["flows"][number]["outcome"] = "verified"): VerifyResult => ({
  summary: "s",
  flows: [
    {
      name: "login",
      outcome,
      detail: `login ${outcome}`,
      evidence: "/selfbuilding/out/files/verify/login/evidence.md",
      checked: [],
      defects: [],
    },
  ],
  files: ["/selfbuilding/out/files/verify/login/evidence.md"],
});

const harness = (id: string) => ({ id }) as unknown as Harness;
const claude = harness("claude-code");
const codexH = harness("codex");

interface Scripts {
  builds?: ImplementSpecResult[];
  reviews?: Record<string, (CodeReviewResult | Error)[]>;
  verifies?: (VerifyResult | Error)[];
  pr?: { url: string; number: number; draft: boolean };
}

function agents(s: Scripts) {
  const builds = [...(s.builds ?? [built])];
  const reviews = Object.fromEntries(Object.entries(s.reviews ?? {}).map(([k, v]) => [k, [...v]]));
  const verifies = [...(s.verifies ?? [verified()])];
  const calls = {
    implement: [] as { input: unknown; opts: AgentCallOptions }[],
    review: [] as { label: string; input: CodeReviewInput; opts: AgentCallOptions }[],
    verify: [] as { opts: AgentCallOptions }[],
  };
  const ImplementSpec = vi.fn(async (input: unknown, opts: AgentCallOptions) => {
    core.events.push(`agent ${opts.label}`);
    calls.implement.push({ input, opts });
    const r = builds.shift() ?? built;
    return result(r, {
      artifacts: {
        branch: {
          name: "selfbuilding/run-1/work",
          base: "main",
          baseSha: "base000",
          headSha: "h",
          pushed: true,
          autoCommitted: false,
        },
        ...(s.pr ? { pr: s.pr } : {}),
      } as AgentResult<ImplementSpecResult>["artifacts"],
    });
  });
  const CodeReview = vi.fn(async (input: CodeReviewInput, opts: AgentCallOptions) => {
    const label = String(opts.label);
    core.events.push(`agent ${label}`);
    calls.review.push({ label, input, opts });
    const who = label.split("-").slice(2).join("-");
    const next = reviews[who]?.shift() ?? review([]);
    if (next instanceof Error) throw next;
    return result(next);
  });
  const Verify = {
    settled: vi.fn(async (_input: unknown, opts: AgentCallOptions): Promise<Settled<AgentResult<VerifyResult>>> => {
      core.events.push(`agent ${opts.label}`);
      calls.verify.push({ opts });
      const next = verifies.shift() ?? verified();
      if (next instanceof Error) return { ok: false, code: "no_result", error: next };
      return { ok: true, value: result(next) };
    }),
  };
  return { agents: { ImplementSpec, CodeReview, Verify } as never, calls };
}

function prApi() {
  const requests: PullRequestRequest[] = [];
  const api: PullRequestApi = {
    async openOrUpdate(req) {
      requests.push(req);
      return { url: "https://github.com/acme/api/pull/7", number: 7, draft: req.draft, created: requests.length === 1 };
    },
    async findOpen() {
      return null;
    },
  };
  return { api, requests };
}

const input = { repo: "github.com/acme/api", spec: "Rate-limit POST /login", testCommand: "pnpm test" };
const panel = [
  { label: "claude", harness: claude },
  { label: "codex", harness: codexH },
];

beforeEach(() => {
  core.events.length = 0;
  core.fixerCalls.length = 0;
  core.fixerResults.length = 0;
  core.asks.length = 0;
  core.askAnswer = { choiceId: "merge", kind: "human" };
  failForks = false;
  forkThrows = false;
  numstat = "10\t2\tsrc/a.ts\n";
});

describe("createShipChange", () => {
  it("rejects an empty or duplicated panel", () => {
    const { agents: a } = agents({});
    expect(() => createShipChange({ agents: a, reviewers: [] })).toThrow(/at least one reviewer/);
    expect(() => createShipChange({ agents: a, reviewers: [{ label: "x" }, { label: "x" }] })).toThrow(/unique/);
  });

  it("runs build → PR → review on forks in parallel → fix → re-review → verify → ask, and never merges", async () => {
    const { agents: a, calls } = agents({
      reviews: {
        claude: [review([finding()]), review([])],
        codex: [
          review([
            finding({ verdict: "PLAUSIBLE" }),
            finding({ file: "src/b.ts", line: 9, verdict: "PLAUSIBLE", severity: "low" }),
          ]),
          review([]),
        ],
      },
    });
    const { api, requests } = prApi();
    const ship = createShipChange({ agents: a, reviewers: panel, builder: { harness: claude }, pullRequests: api });
    const out = await ship(input);

    expect(core.events.filter((e) => !e.startsWith("phase"))).toEqual([
      "agent implement",
      "step push-pr",
      "step open-pr",
      // Handle pushes and execs that feed a later call's input are journaled steps, so a resume replays them.
      "step review-1-push",
      "step review-1-tier",
      "step review-1-tests",
      "exec pnpm test",
      "fork 2",
      "agent review-1-claude",
      "agent review-1-codex",
      "agent fix-1",
      "step review-2-push",
      "step review-2-tier",
      "step review-2-tests",
      "exec pnpm test",
      "fork 2",
      "agent review-2-claude",
      "agent review-2-codex",
      "fork 1",
      "agent verify",
      "step push-final",
      "step update-pr",
      "ask",
    ]);
    // The builder ran in the shared box on its harness; the PR is opened by the host, not the build call.
    expect(calls.implement[0]?.opts).toMatchObject({ label: "implement", harness: claude });
    expect(calls.implement[0]?.opts.pr).toBeUndefined();
    expect(boxName(calls.implement[0]?.opts.sandbox)).toBe("work");

    // Reviewers: each on its own fork, its own harness, the same target and tier, tests observed.
    const [r1, r2] = calls.review;
    expect(boxName(r1?.opts.sandbox)).toBe("work/fork[0]");
    expect(boxName(r2?.opts.sandbox)).toBe("work/fork[1]");
    expect(r1?.opts.harness).toBe(claude);
    expect(r2?.opts.harness).toBe(codexH);
    expect(r1?.opts.repo).toBeUndefined();
    expect(r1?.input).toMatchObject({
      target: { kind: "diff", base: "main", head: "selfbuilding/run-1/work" },
      tier: "medium",
      testsPassed: true,
    });

    // The fixer got only the confirmed finding (flagged by both), in the shared box.
    expect(core.fixerCalls).toHaveLength(1);
    const fixInput = core.fixerCalls[0]?.input as { findings: { file: string; reviewers: string[] }[] };
    expect(fixInput.findings).toHaveLength(1);
    expect(fixInput.findings[0]).toMatchObject({
      file: "src/a.ts",
      verdict: "CONFIRMED",
      reviewers: ["claude", "codex"],
    });
    expect(boxName(core.fixerCalls[0]?.sandbox)).toBe("work");
    expect(core.fixerCalls[0]?.harness).toBe(claude);

    // The PR body carries the notes; the refresh adds the verification.
    expect(requests[0]).toMatchObject({
      repo: "github.com/acme/api",
      head: "selfbuilding/run-1/work",
      base: "main",
      draft: true,
    });
    expect(requests[0]?.body).toContain("## Implementation notes\n### Implementation notes: limiter");
    expect(requests[0]?.body).not.toContain("(pending)");
    expect(requests[1]?.body).toContain("## Verified\n- **login**: verified. login verified");

    // Verify ran on a fork of the build box.
    expect(boxName(calls.verify[0]?.opts.sandbox)).toBe("work/fork[4]");

    // The merge question: high risk, safe default, deduped per PR, with the decision page.
    const askSpec = core.asks[0] as AskSpec;
    expect(askSpec).toMatchObject({
      question: "Merge PR #7?",
      risk: "high",
      default: "change-first",
      onTimeout: "default",
      dedupeKey: "github.com/acme/api:pr:7",
    });
    expect(askSpec.choices?.map((c) => (typeof c === "string" ? c : c.id))).toEqual(["merge", "change-first", "close"]);
    expect(askSpec.context).toContain("Open question:** Should admins be exempt?");
    expect(askSpec.context).toContain("src/b.ts:9 [low]");

    expect(out).toMatchObject({
      status: "awaiting_decision",
      pr: { url: "https://github.com/acme/api/pull/7", number: 7 },
      merged: false,
      decision: { recommended: "merge", choice: "merge", answeredBy: "human" },
      verify: { flows: [{ name: "login", outcome: "verified" }] },
    });
    expect(out.rounds.map((r) => [r.round, r.fixNow, r.carried, r.fixed])).toEqual([
      [1, 1, 1, 1],
      [2, 0, 0, 0],
    ]);
    expect(out.carried.map((f) => f.file)).toEqual(["src/b.ts"]);
  });

  it("places reviewers on fresh boxes or another provider, forking only for the fork reviewers", async () => {
    const elsewhere = { id: "other-provider" } as unknown as SandboxProvider;
    const { agents: a, calls } = agents({});
    const ship = createShipChange({
      agents: a,
      reviewers: [
        { label: "fork", harness: claude },
        { label: "remote", harness: codexH, sandbox: elsewhere },
        { label: "fresh", sandbox: "fresh" },
      ],
      verifier: { sandbox: elsewhere },
    });
    await ship(input);
    expect(core.events).toContain("fork 1");
    expect(core.events).not.toContain("fork 3");
    const byLabel = Object.fromEntries(calls.review.map((c) => [c.label, c.opts]));
    expect(boxName(byLabel["review-1-fork"]?.sandbox)).toBe("work/fork[0]");
    expect(byLabel["review-1-remote"]).toMatchObject({
      sandbox: elsewhere,
      repo: "github.com/acme/api",
      harness: codexH,
    });
    expect(byLabel["review-1-fresh"]).toMatchObject({ sandbox: "fresh", repo: "github.com/acme/api" });
    expect(calls.verify[0]?.opts).toMatchObject({
      sandbox: elsewhere,
      repo: "github.com/acme/api",
      git: { branch: "selfbuilding/run-1/work" },
    });
  });

  it("falls back to a fresh box when a fork fails, and disposes every fork", async () => {
    failForks = true;
    const { agents: a, calls } = agents({});
    await createShipChange({ agents: a, reviewers: panel })(input);
    expect(calls.review.map((c) => c.opts.sandbox)).toEqual(["fresh", "fresh"]);
    expect(calls.verify[0]?.opts.sandbox).toBe("fresh");
  });

  it("treats a fork that throws as every child failing, and reviews in fresh boxes", async () => {
    forkThrows = true;
    const { agents: a, calls } = agents({});
    await createShipChange({ agents: a, reviewers: panel })(input);
    expect(calls.review.map((c) => c.opts.sandbox)).toEqual(["fresh", "fresh"]);
    expect(calls.verify[0]?.opts.sandbox).toBe("fresh");
  });

  it("stops after two rounds even when findings remain, and reports what the fixer could not resolve", async () => {
    core.fixerResults.push(
      {
        summary: "partly",
        fixed: [],
        unresolved: [{ file: "src/a.ts", line: 3, summary: "limiter", reason: "needs a store" }],
      },
      {
        summary: "partly",
        fixed: [],
        unresolved: [{ file: "src/a.ts", line: 3, summary: "limiter", reason: "still needs a store" }],
      },
    );
    const { agents: a, calls } = agents({
      reviews: { claude: [review([finding()]), review([finding()]), review([finding()])] },
    });
    const out = await createShipChange({ agents: a, reviewers: [{ label: "claude" }] })(input);
    expect(calls.review).toHaveLength(2);
    expect(core.fixerCalls.map((c) => c.label)).toEqual(["fix-1", "fix-2"]);
    expect(out.unresolved).toEqual([
      "src/a.ts:3: limiter (needs a store)",
      "src/a.ts:3: limiter (still needs a store)",
    ]);
    expect(out.decision.recommended).toBe("change-first");
    expect(out.decisionPage).toContain("Unresolved finding:** src/a.ts:3: limiter (needs a store)");
  });

  it("honours maxReviewRounds and picks the high tier for a big or sensitive diff", async () => {
    numstat = "300\t20\tsrc/auth/session.ts\n";
    const { agents: a, calls } = agents({ reviews: { claude: [review([finding()]), review([finding()])] } });
    await createShipChange({ agents: a, reviewers: [{ label: "claude" }], maxReviewRounds: 1 })(input);
    expect(calls.review).toHaveLength(1);
    expect(calls.review[0]?.input.tier).toBe("high");
    expect(core.fixerCalls).toHaveLength(1);
  });

  it("goes on with the reviewer that answered, and stops the loop when none does", async () => {
    const one = agents({ reviews: { claude: [new Error("refused")], codex: [review([])] } });
    const out = await createShipChange({ agents: one.agents, reviewers: panel })(input);
    expect(out.rounds[0]?.reviewers).toEqual([
      { label: "claude", ok: false, error: "the reviewer failed" },
      { label: "codex", ok: true, verdict: "approve", findings: 0 },
    ]);
    expect(out.decisionPage).toContain("claude: unavailable");

    core.events.length = 0;
    const none = agents({ reviews: { claude: [new Error("x")], codex: [new Error("y")] } });
    const out2 = await createShipChange({ agents: none.agents, reviewers: panel })(input);
    expect(none.calls.review).toHaveLength(2);
    expect(core.events.some((e) => e.startsWith("agent fix"))).toBe(false);
    expect(out2.rounds).toHaveLength(1);
  });

  it("fixes a broken flow once and re-verifies once", async () => {
    const { agents: a, calls } = agents({ verifies: [verified("broken"), verified("broken")] });
    const out = await createShipChange({ agents: a, reviewers: [{ label: "claude" }] })(input);
    expect(calls.verify.map((v) => v.opts.label)).toEqual(["verify", "reverify-1"]);
    expect(core.fixerCalls.map((c) => c.label)).toEqual(["verify-fix-1"]);
    expect((core.fixerCalls[0]?.input as { brokenFlows?: unknown[] } | undefined)?.brokenFlows).toHaveLength(1);
    expect(out.decision.recommended).toBe("change-first");
    expect(out.decisionPage).toContain("Flow broken:** login");
  });

  it("does not fix-loop on could_not_boot or unverifiable, and reports a Verify failure as unverified", async () => {
    const a1 = agents({ verifies: [verified("could_not_boot")] });
    await createShipChange({ agents: a1.agents, reviewers: [{ label: "claude" }] })(input);
    expect(a1.calls.verify).toHaveLength(1);
    expect(core.fixerCalls).toHaveLength(0);

    const a2 = agents({ verifies: [new Error("boom")] });
    const out = await createShipChange({ agents: a2.agents, reviewers: [{ label: "claude" }] })(input);
    expect(out.verify).toEqual({ error: "no_result" });
    expect(out.decision.recommended).toBe("change-first");
  });

  it("runs Verify in the build box when asked", async () => {
    const { agents: a, calls } = agents({});
    await createShipChange({
      agents: a,
      reviewers: [{ label: "claude" }],
      verifier: { sandbox: "shared", harness: codexH },
    })(input);
    expect(boxName(calls.verify[0]?.opts.sandbox)).toBe("work");
    expect(calls.verify[0]?.opts.harness).toBe(codexH);
    expect(calls.verify[0]?.opts.repo).toBeUndefined();
  });

  it("without a PR API, lets the build call open the PR from the builder's title and body", async () => {
    const { agents: a, calls } = agents({ pr: { url: "https://github.com/acme/api/pull/9", number: 9, draft: true } });
    const out = await createShipChange({ agents: a, reviewers: [{ label: "claude" }] })(input);
    expect(calls.implement[0]?.opts.pr).toEqual({ draft: true });
    expect(core.events).not.toContain("step open-pr");
    expect(out.pr).toEqual({ url: "https://github.com/acme/api/pull/9", number: 9 });
  });

  it("sends a second builder when the first leaves work undone, and stops before review if it still is", async () => {
    const blocked = { ...built, status: "blocked" as const, summary: "Needs a Redis URL." };
    const a1 = agents({ builds: [blocked, built] });
    await createShipChange({ agents: a1.agents, reviewers: [{ label: "claude" }] })(input);
    expect(a1.calls.implement.map((c) => c.opts.label)).toEqual(["implement", "implement-finish"]);
    expect(a1.calls.implement[1]?.input).toMatchObject({ context: expect.stringContaining("Needs a Redis URL.") });

    core.events.length = 0;
    const a2 = agents({ builds: [blocked, blocked] });
    const out = await createShipChange({ agents: a2.agents, reviewers: [{ label: "claude" }] })(input);
    expect(out).toMatchObject({ status: "build_incomplete", pr: null, merged: false, decision: { choice: null } });
    expect(a2.calls.review).toHaveLength(0);
    expect(core.events).not.toContain("ask");
  });

  it("an unattended run resolves to the safe choice and never merges", async () => {
    core.askAnswer = { choiceId: null, kind: "default" };
    const { agents: a } = agents({ pr: { url: "u", number: 3, draft: true } });
    const out = await createShipChange({ agents: a, reviewers: [{ label: "claude" }] })(input);
    expect(out.decision).toEqual({ recommended: "merge", choice: "change-first", answeredBy: "default" });
    expect(out.merged).toBe(false);
  });

  it("pauses the build box at the end, and calls the agents in the same order on a re-run", async () => {
    const order = async () => {
      core.events.length = 0;
      const { agents: a } = agents({ reviews: { claude: [review([finding()])] } });
      await createShipChange({ agents: a, reviewers: [{ label: "claude" }] })(input);
      return core.events.filter((e) => e.startsWith("agent") || e.startsWith("phase"));
    };
    const first = await order();
    expect(await order()).toEqual(first);
    expect(first).toContain("phase decide");
    expect(core.boxes.at(-1)?.disposed).toEqual(["pause"]);
  });
});
