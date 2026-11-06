// Acceptance 1 (docs/BASIC-SCOPE.md): CodeReview against an emulated GitHub PR returns a typed result, and an
// invalid submit_result is rejected and retried inside the run.
//
// The PR lives in the GitHub emulator; its commits live in a local bare remote the emulator mirrors (the emulator
// has no git smart HTTP). The review reads the PR's base and head from the emulator's REST API and reviews that
// diff in a tmpdir box running the real runtime, MCP server and Claude Code stream parser.
import path from "node:path";
import { CodeReview, CodeReviewResult } from "@selfbuilding/agents";
import { factory, fileArtifacts, fileJournal, run } from "@selfbuilding/core";
import {
  type GitHubEmulator,
  openPlaygroundPr,
  type Playground,
  scripted,
  seedPlayground,
  startGitHubEmulator,
  type TmpdirProvider,
  tmpdirProvider,
} from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { recorder, scriptedClaude, tempDir, useBuiltRuntime } from "./support/kit.js";

let dir: string;
let gh: GitHubEmulator;
let playground: Playground;
let provider: TmpdirProvider;

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-review-");
  gh = await startGitHubEmulator();
  playground = await seedPlayground(gh, { dir: path.join(dir, "remote") });
  provider = tmpdirProvider({ root: path.join(dir, "boxes") });
});

afterAll(async () => {
  await provider?.close();
  await gh?.close();
  await playground?.dispose();
});

const finding = {
  file: "src/math.js",
  line: 5,
  severity: "high",
  category: "correctness",
  summary: "multiply ignores its second argument.",
  failureScenario: "multiply(2, 3) returns 4 instead of 6.",
  verdict: "CONFIRMED",
} as const;

const ReviewPr = factory(
  {
    name: "review-pr",
    input: z.object({ repo: z.string(), base: z.string(), head: z.string() }),
  },
  async ({ repo, base, head }) => {
    const review = await CodeReview({ target: { kind: "diff", base, head } }, { repo, label: "review" });
    return {
      result: review.result,
      submits: review.attempts.submits,
      harness: review.harness.id,
      diff: review.artifacts.diff?.stat ?? null,
    };
  },
);

describe("acceptance 1: review a PR", () => {
  it("returns a typed CodeReview result for an emulated PR, after rejecting an invalid submission in-run", async () => {
    const pr = await openPlaygroundPr(gh, playground, {
      branch: "feature/multiply",
      files: {
        "src/math.js":
          "export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a + a;\n}\n",
      },
      title: "Add multiply",
      body: "Implements docs/specs/multiply.md",
      as: "reviewer",
    });
    const fetched = await gh.api<{ base: { ref: string }; head: { ref: string; sha: string }; state: string }>(
      `/repos/${gh.owner}/${gh.repo}/pulls/${pr.number}`,
    );
    expect(fetched.state).toBe("open");

    const valid = {
      verdict: "request_changes",
      tier: "medium",
      summary: "multiply adds instead of multiplying.",
      findings: [finding],
    };
    const harness = scriptedClaude([
      // The reviewer reads the PR's diff where the runtime put it; the turn fails if it is missing.
      scripted.sh("grep -q 'return a + a' /selfbuilding/in/diff.patch", { expectExit: 0 }),
      scripted.say("Reviewing the multiply change."),
      // Not a CodeReview result: the MCP server must reject it and the agent tries again in the same turn.
      ...scripted.invalidThenValid({ verdict: "lgtm", findings: "none" }, valid),
    ]);

    const events = recorder();
    const out = await run(
      ReviewPr,
      { repo: playground.remote.url, base: fetched.base.ref, head: fetched.head.ref },
      {
        runId: "ns_accept_review",
        config: {
          deployment: "acceptance",
          sandbox: provider,
          harness,
          artifacts: fileArtifacts(path.join(dir, "artifacts")),
        },
        journal: fileJournal(path.join(dir, "journal")),
        events: [events.sink],
      },
    );

    expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
    const output = out.output as { result: unknown; submits: number; harness: string; diff: unknown };
    expect(CodeReviewResult.parse(output.result)).toEqual(valid);
    expect(output.harness).toBe("scripted-claude-code");
    // One rejected submission, then the accepted one, inside one launch.
    expect(output.submits).toBe(2);
    expect(events.launched()).toEqual(["review"]);
    // The MCP server rejected the first submission with the schema issues, then accepted the second.
    const submitted = events.of("result.submitted").map((e) => e.data as { valid: boolean; issues?: unknown[] });
    expect(submitted.map((d) => d.valid)).toEqual([false, true]);
    expect(JSON.stringify(submitted[0]?.issues)).toContain("/verdict");
  });
});
