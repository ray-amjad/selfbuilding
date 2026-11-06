import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CodeReviewFinding,
  CodeReviewInput,
  CodeReviewResult,
  ImplementSpecInput,
  ImplementSpecResult,
  VerifyInput,
  VerifyResult,
} from "./schemas.js";
import { ShipChangeInput, ShipChangeOutput } from "./ship-change.js";

const RESERVED = ["repo", "base", "branch", "git", "pr", "sandbox", "harness", "model"];

const finding = {
  file: "src/limits.ts",
  line: 41,
  severity: "high",
  category: "correctness",
  summary: "The limiter resets on every request.",
  failureScenario: "Two requests in one window → both pass.",
  verdict: "CONFIRMED",
} as const;

describe("schemas", () => {
  it("never take where-the-work-happens keys as input (spec §2.4.3)", () => {
    for (const schema of [CodeReviewInput, ImplementSpecInput, VerifyInput]) {
      for (const key of RESERVED) expect(Object.keys(schema.shape)).not.toContain(key);
    }
  });

  it("are representable as draft-07 JSON Schema with an object at the top", () => {
    for (const schema of [
      CodeReviewInput,
      CodeReviewResult,
      ImplementSpecInput,
      ImplementSpecResult,
      VerifyInput,
      VerifyResult,
      ShipChangeInput,
      ShipChangeOutput,
    ]) {
      const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as { type?: string };
      expect(json.type).toBe("object");
    }
  });

  it("parse the canonical calls", () => {
    expect(
      CodeReviewInput.parse({
        target: { kind: "pr", url: "https://github.com/acme/api/pull/412" },
        focus: ["security"],
      }),
    ).toBeTruthy();
    expect(
      CodeReviewInput.parse({ target: { kind: "diff", base: "main", head: "feat" }, testsPassed: true, tier: "high" }),
    ).toBeTruthy();
    expect(
      ImplementSpecInput.parse({ spec: "Add rate limiting to POST /login", testCommand: "pnpm test" }),
    ).toBeTruthy();
    expect(ImplementSpecInput.parse({ spec: { path: "docs/spec.md" }, feedback: [finding] })).toBeTruthy();
    expect(
      VerifyInput.parse({ change: "Rate limit on login", flows: [{ name: "login", endState: "429 after 5 tries" }] }),
    ).toBeTruthy();
    expect(ShipChangeInput.parse({ repo: "github.com/acme/api", spec: "Add rate limiting" })).toBeTruthy();
  });

  it("reject what the contracts promise to reject", () => {
    expect(ImplementSpecInput.safeParse({ spec: "" }).success).toBe(false);
    expect(CodeReviewInput.safeParse({ tier: "low" }).success).toBe(false);
    expect(CodeReviewFinding.safeParse({ ...finding, verdict: "REFUTED" }).success).toBe(false);
    expect(CodeReviewFinding.safeParse({ ...finding, line: 0 }).success).toBe(false);
    expect(
      CodeReviewResult.safeParse({ verdict: "approve", tier: "high", summary: "s", findings: Array(11).fill(finding) })
        .success,
    ).toBe(false);
    expect(VerifyInput.safeParse({ change: "x", flows: [{ name: "f" }] }).success).toBe(false);
  });

  it("accept the results the skills describe", () => {
    expect(
      ImplementSpecResult.parse({
        status: "done",
        summary: "Added a limiter.",
        changes: [{ file: "src/limits.ts", why: "the limiter" }],
        tests: { command: "pnpm test", passed: true },
        followUps: [],
        openQuestions: ["Should admins be exempt?"],
        prTitle: "Rate-limit POST /login",
        prBody: "## What changed and why\n...",
      }),
    ).toBeTruthy();
    expect(
      VerifyResult.parse({
        summary: "no verify facts here; login: verified",
        flows: [
          {
            name: "login",
            outcome: "verified",
            claim: "verified",
            detail: "Five failures, then 429.",
            evidence: "/selfbuilding/out/files/verify/login/evidence.md",
            checked: ["db: 5 rows in login_attempts"],
            defects: [],
          },
        ],
        files: ["/selfbuilding/out/files/verify/login/evidence.md"],
      }),
    ).toBeTruthy();
  });
});
