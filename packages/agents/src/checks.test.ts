import type { DoneCheck, DoneContext, ProviderSandbox, SandboxHandle } from "@selfbuilding/core";
import { openTestBox, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  filesInPatch,
  findingsInDiffCheck,
  findingsOutsideDiff,
  findTestRemovals,
  implementationNotesCheck,
  noTestRemovalCheck,
  parseNumstat,
  pickReviewTier,
  verdictConsistentCheck,
  verdictProblems,
  verifyEvidenceCheck,
  verifyResultProblems,
} from "./checks.js";
import type { CodeReviewFinding, CodeReviewResult, VerifyResult } from "./schemas.js";

const finding = (over: Partial<CodeReviewFinding> = {}): CodeReviewFinding => ({
  file: "src/a.ts",
  line: 3,
  severity: "high",
  category: "correctness",
  summary: "s",
  failureScenario: "f",
  verdict: "CONFIRMED",
  ...over,
});

describe("pickReviewTier", () => {
  it("picks medium for a small change in few files", () => {
    expect(pickReviewTier({ files: 3, insertions: 60, deletions: 40, paths: ["src/a.ts"] }).tier).toBe("medium");
  });
  it("picks high past 100 lines or 3 files", () => {
    expect(pickReviewTier({ files: 3, insertions: 61, deletions: 40 }).tier).toBe("high");
    expect(pickReviewTier({ files: 4, insertions: 4, deletions: 0 }).tier).toBe("high");
  });
  it("picks high for any size in a sensitive area", () => {
    for (const path of ["src/auth/session.ts", "db/migrations/0003_add.sql", "billing/invoice.ts", "lib/mutex.go"]) {
      const r = pickReviewTier({ files: 1, insertions: 2, deletions: 0, paths: [path] });
      expect(r).toMatchObject({ tier: "high", reason: expect.stringContaining(path) });
    }
    expect(pickReviewTier({ files: 1, insertions: 2, deletions: 0, paths: ["package-lock.json"] }).tier).toBe("medium");
  });
});

describe("parseNumstat", () => {
  it("sums lines, counts binaries as files and resolves renames", () => {
    const stat = parseNumstat("10\t2\tsrc/a.ts\n-\t-\tlogo.png\n1\t1\tsrc/{old => new}/b.ts\n3\t0\tx.ts => y.ts\n");
    expect(stat).toEqual({
      files: 4,
      insertions: 14,
      deletions: 3,
      paths: ["src/a.ts", "logo.png", "src/new/b.ts", "y.ts"],
    });
  });
});

describe("filesInPatch", () => {
  it("reads both header styles and skips /dev/null", () => {
    const files = filesInPatch(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n--- /dev/null\n+++ b/new.ts\n",
    );
    expect([...files].sort()).toEqual(["new.ts", "src/a.ts"]);
  });
});

describe("findTestRemovals", () => {
  it("flags deleted test files and added focus or skip markers", () => {
    const issues = findTestRemovals(
      "D\tsrc/a.test.ts\nD\tsrc/a.ts\nM\ttests/test_x.py\n",
      [
        "+++ b/src/b.test.ts",
        '+  it.only("x", () => {});',
        '+  describe.skip("y", () => {});',
        '+  xit("z", () => {});',
        "+++ b/tests/test_x.py",
        "+@pytest.mark.skip(reason='later')",
        "-  it.skip('removed skip is fine')",
        "+  const skip = 1;",
      ].join("\n"),
    );
    expect(issues).toEqual([
      "deleted test file src/a.test.ts",
      'src/b.test.ts: added "it.only("x", () => {});"',
      'src/b.test.ts: added "describe.skip("y", () => {});"',
      'src/b.test.ts: added "xit("z", () => {});"',
      "tests/test_x.py: added \"@pytest.mark.skip(reason='later')\"",
    ]);
  });
});

describe("code-review result rules", () => {
  const result = (over: Partial<CodeReviewResult>): CodeReviewResult => ({
    verdict: "request_changes",
    tier: "high",
    summary: "s",
    findings: [finding()],
    ...over,
  });

  it("reject approve with findings, comment over a confirmed high, and the tier cap", () => {
    expect(verdictProblems(result({}))).toEqual([]);
    expect(verdictProblems(result({ verdict: "approve" })).join()).toMatch(/approve but 1 finding/);
    expect(verdictProblems(result({ verdict: "comment" })).join()).toMatch(/need request_changes/);
    expect(verdictProblems(result({ verdict: "comment", findings: [finding({ verdict: "PLAUSIBLE" })] }))).toEqual([]);
    expect(verdictProblems(result({ verdict: "approve", findings: [] }))).toEqual([]);
    expect(verdictProblems(result({ tier: "medium", findings: Array(9).fill(finding()) })).join()).toMatch(/at most 8/);
  });

  it("finds findings outside the diff", () => {
    const r = result({ findings: [finding(), finding({ file: "./src/b.ts" }), finding({ file: "other.ts" })] });
    expect(findingsOutsideDiff(r, new Set(["src/a.ts", "src/b.ts"]))).toEqual(["other.ts"]);
  });
});

describe("verify result rules", () => {
  const flow = (over: Partial<VerifyResult["flows"][number]> = {}) => ({
    name: "login",
    outcome: "verified" as const,
    claim: "verified" as const,
    detail: "d",
    evidence: "/selfbuilding/out/files/verify/login/evidence.md",
    checked: [],
    defects: [],
    ...over,
  });

  it("require collected, distinct evidence and never a raised claim", () => {
    const ok: VerifyResult = { summary: "s", flows: [flow()], files: [flow().evidence] };
    expect(verifyResultProblems(ok)).toEqual([]);
    expect(verifyResultProblems({ ...ok, files: [] }).join()).toMatch(/not listed in files/);
    expect(
      verifyResultProblems({ ...ok, flows: [flow({ evidence: "/tmp/e.md" })], files: ["/tmp/e.md"] }).join(),
    ).toMatch(/not under/);
    expect(verifyResultProblems({ ...ok, flows: [flow(), flow({ name: "two" })] }).join()).toMatch(
      /share one evidence/,
    );
    expect(verifyResultProblems({ ...ok, flows: [flow({ claim: "broken" })] }).join()).toMatch(
      /broken claim stays broken/,
    );
    expect(verifyResultProblems({ ...ok, flows: [flow({ claim: "could_not_boot" })] }).join()).toMatch(/never raise/);
    expect(verifyResultProblems({ ...ok, flows: [flow({ claim: "verified", outcome: "broken" })] })).toEqual([]);
  });
});

// The exec-backed checks, run for real against a git repository in a tmpdir sandbox.
describe("done checks in a sandbox", () => {
  let provider: TmpdirProvider;
  let box: ProviderSandbox;
  let base = "";
  let head = "";

  const ctx = (): DoneContext => ({
    sandbox: {
      exec: (cmd: string) => box.exec(cmd, { cwd: "/selfbuilding/work" }),
    } as unknown as SandboxHandle,
    git: { base, head, commitsAhead: 1, dirty: false, changedPaths: [], remoteHasBranch: async () => true },
    artifacts: {},
  });
  const run = async <O>(check: DoneCheck<unknown, O>, r: O) => {
    if (!("assert" in check)) throw new Error("not an assert check");
    return check.assert(r, ctx());
  };
  const sh = async (cmd: string) => {
    const r = await box.exec(cmd, { cwd: "/selfbuilding/work" });
    if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderrTail}`);
    return r.stdoutTail.trim();
  };

  beforeAll(async () => {
    provider = tmpdirProvider();
    box = await openTestBox(provider, "checks");
    await box.exec("mkdir -p /selfbuilding/work /selfbuilding/out/files /selfbuilding/in");
    await sh("git init -q -b main && git config user.email t@example.test && git config user.name t");
    await sh(
      "mkdir -p src && printf 'a\\n' > src/a.ts && printf 'it(\"x\")\\n' > src/a.test.ts && git add -A && git commit -qm base",
    );
    base = await sh("git rev-parse HEAD");
  }, 30_000);
  afterAll(async () => {
    await provider.close();
  });

  it("no-test-removal passes a clean change and fails a skipped or deleted test", async () => {
    await sh("git checkout -q -b clean && printf 'b\\n' >> src/a.ts && git commit -qam change");
    head = await sh("git rev-parse HEAD");
    expect(await run(noTestRemovalCheck, {})).toBe(true);

    await sh(`git checkout -q -b bad ${base} && printf 'it.skip("y")\\n' >> src/a.test.ts && git commit -qam skip`);
    head = await sh("git rev-parse HEAD");
    expect(await run(noTestRemovalCheck, {})).toMatch(/it\.skip/);

    await sh(`git checkout -q -b gone ${base} && git rm -q src/a.test.ts && git commit -qm drop`);
    head = await sh("git rev-parse HEAD");
    expect(await run(noTestRemovalCheck, {})).toMatch(/deleted test file src\/a.test.ts/);
  });

  it("implementation-notes requires a non-empty notes file", async () => {
    expect(await run(implementationNotesCheck, {})).toMatch(/missing or empty/);
    await box.exec("printf '# Implementation notes\\n' > /selfbuilding/out/files/implementation-notes.md");
    expect(await run(implementationNotesCheck, {})).toBe(true);
  });

  it("findings-in-diff reads the review diff the runtime wrote", async () => {
    await box.exec(`cd /selfbuilding/work && git diff ${base}...clean > /selfbuilding/in/diff.patch`);
    const r: CodeReviewResult = { verdict: "request_changes", tier: "medium", summary: "s", findings: [finding()] };
    expect(await run(findingsInDiffCheck, r)).toBe(true);
    expect(await run(findingsInDiffCheck, { ...r, findings: [finding({ file: "nope.ts" })] })).toMatch(/nope.ts/);
    expect(await run(findingsInDiffCheck, { ...r, findings: [] })).toBe(true);
    expect(await run(verdictConsistentCheck, r)).toBe(true);
  });

  it("verify-evidence requires each evidence file to exist", async () => {
    const evidence = "/selfbuilding/out/files/verify/login/evidence.md";
    const r: VerifyResult = {
      summary: "s",
      flows: [{ name: "login", outcome: "verified", detail: "d", evidence, checked: [], defects: [] }],
      files: [evidence],
    };
    expect(await run(verifyEvidenceCheck, r)).toMatch(/missing or empty/);
    await box.exec(`mkdir -p /selfbuilding/out/files/verify/login && printf 'step 1\\n' > ${evidence}`);
    expect(await run(verifyEvidenceCheck, r)).toBe(true);
  });
});
