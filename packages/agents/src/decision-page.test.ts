import { describe, expect, it } from "vitest";
import {
  composePrBody,
  type DecisionPageInput,
  recommend,
  renderDecisionPage,
  replaceSection,
} from "./decision-page.js";
import { findingKey, mergeFindings } from "./findings.js";
import type { CodeReviewFinding } from "./schemas.js";

const finding = (over: Partial<CodeReviewFinding> = {}): CodeReviewFinding => ({
  file: "src/a.ts",
  line: 3,
  severity: "medium",
  category: "correctness",
  summary: "Off by one.",
  failureScenario: "n=0 → crash",
  verdict: "PLAUSIBLE",
  ...over,
});

describe("mergeFindings", () => {
  it("merges one defect flagged twice, keeping the strongest verdict and severity", () => {
    const { fixNow, carry } = mergeFindings([
      { label: "a", findings: [finding(), finding({ file: "src/b.ts", line: 1, severity: "nit" })] },
      {
        label: "b",
        findings: [finding({ file: "./src/a.ts", verdict: "CONFIRMED", severity: "high", failureScenario: "proven" })],
      },
    ]);
    expect(fixNow).toEqual([
      expect.objectContaining({
        file: "src/a.ts",
        verdict: "CONFIRMED",
        severity: "high",
        failureScenario: "proven",
        reviewers: ["a", "b"],
      }),
    ]);
    expect(carry.map((f) => f.file)).toEqual(["src/b.ts"]);
  });

  it("keys a finding with no line by its summary", () => {
    expect(findingKey(finding({ line: undefined, summary: "  Same   THING " }))).toBe(
      findingKey(finding({ line: undefined, summary: "same thing" })),
    );
  });
});

const page = (over: Partial<DecisionPageInput> = {}): DecisionPageInput => ({
  repo: "github.com/acme/api",
  pr: { url: "https://github.com/acme/api/pull/7", number: 7 },
  branch: "selfbuilding/r/work",
  title: "Rate-limit login",
  summary: "Added a limiter.",
  openQuestions: [],
  rounds: [],
  unresolved: [],
  carried: [],
  verify: { flows: [{ name: "login", outcome: "verified", detail: "ok" }] },
  ...over,
});

describe("recommend", () => {
  it("recommends merge only with nothing unresolved and every flow verified or unreachable", () => {
    expect(recommend(page()).choice).toBe("merge");
    expect(recommend(page({ verify: { flows: [{ name: "x", outcome: "unverifiable", detail: "d" }] } })).choice).toBe(
      "merge",
    );
    expect(recommend(page({ unresolved: ["x"] })).choice).toBe("change-first");
    expect(recommend(page({ verify: { error: "no_result" } })).choice).toBe("change-first");
    expect(recommend(page({ verify: { flows: [{ name: "x", outcome: "could_not_boot", detail: "d" }] } })).choice).toBe(
      "change-first",
    );
  });
});

describe("renderDecisionPage", () => {
  it("puts the call first, then each open decision, the carried findings and the checks", () => {
    const text = renderDecisionPage(
      page({
        openQuestions: ["Exempt admins?"],
        carried: [finding({ file: "src/b.ts" })],
        unresolved: ["src/c.ts:1: race (needs a lock)"],
        verify: { flows: [{ name: "reset", outcome: "unverifiable", detail: "No user reaches it." }] },
        rounds: [
          {
            round: 1,
            tier: "high",
            reviewers: [
              { label: "claude", ok: true, verdict: "request_changes", findings: 2 },
              { label: "codex", ok: false },
            ],
            fixNow: 1,
            carried: 1,
            fixed: 0,
            unresolved: ["src/c.ts:1: race (needs a lock)"],
          },
        ],
      }),
    );
    expect(text.indexOf("## Your call")).toBeLessThan(text.indexOf("## Decisions"));
    expect(text).toContain("Recommended: **Change it first** (1 finding(s) unresolved)");
    expect(text).toContain("- **Unresolved finding:** src/c.ts:1: race (needs a lock)");
    expect(text).toContain("- **Unreachable branch:** reset: No user reaches it. Delete that branch");
    expect(text).toContain("- **Open question:** Exempt admins?");
    expect(text).toContain("- src/b.ts:3 [medium] Off by one.: n=0 → crash");
    expect(text).toContain(
      "| Review round 1 (high; claude: request_changes, codex: unavailable) | 1 to fix, 0 fixed, 1 carried, 1 unresolved |",
    );
    expect(text).toContain("| Verify: reset | unverifiable |");
  });

  it("says when there was nothing to verify or no PR", () => {
    expect(renderDecisionPage(page({ verify: { flows: [] } }))).toContain("| Verify | no runnable surface |");
    expect(renderDecisionPage(page({ pr: null, verify: null }))).toContain(
      "# branch selfbuilding/r/work: Rate-limit login",
    );
  });
});

describe("composePrBody", () => {
  const body =
    "## What changed and why\nX.\n\n## Implementation notes\n(pending)\n\n## Verified\nNot verified: pending\n\n## Source\nspec";

  it("fills the notes and the verified sections, demoting the notes' own headings", () => {
    const out = composePrBody({
      prBody: body,
      notes: "# Implementation notes: x\n\n## Open questions\n- Q?",
      verified: [{ name: "login", outcome: "verified", detail: "ok" }],
    });
    expect(out).toContain(
      "## Implementation notes\n### Implementation notes: x\n\n#### Open questions\n- Q?\n\n## Verified",
    );
    expect(out).toContain("## Verified\n- **login**: verified. ok\n\n## Source\nspec");
    expect(composePrBody({ prBody: out, notes: "# N\n## Open questions\n- R?" })).toContain(
      "## Implementation notes\n### N\n#### Open questions\n- R?\n\n## Verified",
    );
  });

  it("appends a missing section and leaves the body alone with no notes", () => {
    expect(replaceSection("## A\nx", "B", "y")).toBe("## A\nx\n\n## B\ny");
    expect(composePrBody({ prBody: "## A\nx", notes: "" })).toBe("## A\nx\n");
  });
});
