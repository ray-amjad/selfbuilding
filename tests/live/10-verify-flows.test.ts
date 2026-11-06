// Live 10 (docs/spec/demo-path.md §4.3, §4.4): verifyFlows on the playground web app. Claude Code builds the
// "mark a note done" spec in a medium box; CodeReview and FindFlows read the diff on forks; Codex verifies each
// found flow with the browser on its own fork. The summary page is stored with the evidence (in R2 when the R2
// variables are set), posted to Slack when it is configured, and written into the PR opened by the GitHub App.
import path from "node:path";
import {
  CodeReview,
  createVerifyFlows,
  FindFlows,
  ImplementSpec,
  Verify,
  type VerifyFlowsOutput,
} from "@selfbuilding/agents";
import { r2ArtifactsFromEnv } from "@selfbuilding/artifacts-s3";
import { slack } from "@selfbuilding/channel-slack";
import { type ArtifactStore, fileArtifacts, fileJournal, type HitlOptions, run } from "@selfbuilding/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approver,
  budget,
  github,
  githubSkip,
  harnesses,
  liveRunId,
  needs,
  PLAYGROUND,
  type ProviderName,
  providers,
  recorder,
  slackChannel,
  slackSkip,
  tempDir,
  useBuiltRuntime,
} from "./support/live.js";

const env = process.env;
/** Where the build box and its forks run. Default E2B, whose Hobby plan allows the medium preset. */
const providerName = (env.SELFBUILDING_LIVE_FLOWS_PROVIDER ?? "e2b") as ProviderName;
const provider = providers[providerName];
const r2Ready = Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);

const skip = needs(
  !provider && `SELFBUILDING_LIVE_FLOWS_PROVIDER must be impello, e2b or docker, not "${providerName}"`,
  provider && !provider.ready && provider.skip,
  !harnesses["claude-code"].ready && harnesses["claude-code"].skip,
  !harnesses.codex.ready && harnesses.codex.skip,
  githubSkip,
);

beforeAll(() => useBuiltRuntime());

describe("live 10: verifyFlows on the playground web app", () => {
  it.skipIf(skip !== "")(
    `builds the mark-done spec and verifies every flow it adds or touches${skip ? ` (skipped: ${skip})` : ""}`,
    async () => {
      const dir = await tempDir("sbl-flows-");
      const claude = harnesses["claude-code"].make();
      const codexH = harnesses.codex.make();
      const git = github();
      // The build box starts from the Codex template, which has the browser every Verify fork needs; Claude Code is
      // installed into it on first use.
      const flows = createVerifyFlows({
        agents: { ImplementSpec, CodeReview, FindFlows, Verify },
        builder: {
          harness: claude,
          provider: provider?.make("codex"),
          size: env.SELFBUILDING_LIVE_FLOWS_SIZE ?? "medium",
        },
        reviewer: { harness: claude },
        finder: { harness: claude },
        verifier: { harness: codexH },
        pullRequests: git.pullRequests,
      });
      const artifacts: ArtifactStore = r2Ready
        ? r2ArtifactsFromEnv(env, { prefix: "live" })
        : fileArtifacts(path.join(dir, "artifacts"));
      // verifyFlows asks nothing, so a configured channel with an approver posts the summary without a human there.
      const hitl: HitlOptions =
        slackSkip === "" && approver
          ? { channels: [slack({ channel: slackChannel })], approvers: [{ slack: approver }] }
          : { mode: "afk" };

      const events = recorder();
      const out = await run(
        flows,
        { repo: PLAYGROUND, spec: { path: "docs/specs/web-mark-done.md" }, testCommand: "cd web && pnpm test" },
        {
          runId: liveRunId("flows"),
          config: {
            deployment: "live",
            sandbox: provider?.make("codex"),
            harness: claude,
            git,
            hitl,
            budget: budget(),
            // The build box and a fork per flow at once; Impello's default (trial) tier allows two.
            concurrency: { sandboxes: 4 },
            artifacts,
          },
          journal: fileJournal(path.join(dir, "journal")),
          events: [events.sink],
        },
      );
      expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
      const o = out.output as VerifyFlowsOutput;
      expect(o.build.status).toBe("done");
      expect(o.pr).not.toBeNull();
      expect(["all_verified", "some_failed"]).toContain(o.status);

      // findFlows names the new flow first and the add flow as the regression.
      expect(o.flows[0]?.kind).toBe("new");
      expect(o.flows.some((f) => /mark/i.test(f.name))).toBe(true);
      expect(o.flows.some((f) => /add/i.test(f.name) && f.kind === "regression")).toBe(true);
      for (const f of o.flows) {
        expect(f.callPath, f.name).not.toBe("");
        expect(
          f.evidence.some((e) => e.path.endsWith("/evidence.md")),
          f.name,
        ).toBe(true);
      }
      // One fork for the review, one for findFlows, then one per flow.
      const forked = events.of("sandbox.forked").reduce((n, e) => n + (e.data as { n: number }).n, 0);
      expect(forked).toBe(2 + o.flows.length);
      expect(o.summary.markdown).toContain("## Verification");
      expect(o.summary.page.bytes).toBeGreaterThan(0);
      if (r2Ready) expect(o.summary.page.uri.startsWith("s3://")).toBe(true);
    },
  );
});
