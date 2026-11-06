// Live acceptance 1: CodeReview of the playground's review fixture (a branch that plants a bug) with real Claude
// Code and Codex, on Impello and on E2B. The result must parse as a CodeReview result and find the bug.
import path from "node:path";
import { CodeReview, CodeReviewResult } from "@selfbuilding/agents";
import { factory, fileArtifacts, fileJournal, run } from "@selfbuilding/core";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  budget,
  github,
  githubSkip,
  harnesses,
  liveRunId,
  needs,
  PLAYGROUND,
  providers,
  recorder,
  reviewRefs,
  targets,
  tempDir,
  useBuiltRuntime,
} from "./support/live.js";

const ReviewPr = factory(
  { name: "review-pr", input: z.object({ repo: z.string(), base: z.string(), head: z.string() }) },
  async ({ repo, base, head }) => {
    const review = await CodeReview({ target: { kind: "diff", base, head } }, { repo, label: "review" });
    return { result: review.result, harness: review.harness.id };
  },
);

beforeAll(() => useBuiltRuntime());

describe("live 1: review a PR", () => {
  for (const t of targets) {
    const skip = needs(t.skip, githubSkip);
    it.skipIf(skip !== "")(`${t.name}${skip ? ` (skipped: ${skip})` : ""}`, async () => {
      const dir = await tempDir("sbl-review-");
      const events = recorder();
      const out = await run(
        ReviewPr,
        { repo: PLAYGROUND, ...reviewRefs },
        {
          runId: liveRunId("review"),
          config: {
            deployment: "live",
            sandbox: providers[t.provider].make(t.harness),
            harness: harnesses[t.harness].make(),
            git: github(),
            budget: budget(),
            artifacts: fileArtifacts(path.join(dir, "artifacts")),
          },
          journal: fileJournal(path.join(dir, "journal")),
          events: [events.sink],
        },
      );
      expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
      const o = out.output as { result: unknown; harness: string };
      expect(o.harness).toBe(t.harness);
      const result = CodeReviewResult.parse(o.result);
      expect(result.verdict).not.toBe("approve");
      expect(result.findings.some((f) => f.file.includes("math"))).toBe(true);
    });
  }
});
