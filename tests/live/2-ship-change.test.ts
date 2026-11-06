// Live acceptance 2: shipChange on the playground repo. The builder runs Claude Code on Impello; the review panel
// mixes harnesses and providers (Claude Code on a fork, Codex on a fork, Codex on E2B); Verify runs on a fork.
// The PR is opened by the GitHub App (or the PAT fallback). With Slack configured the merge question is posted
// there, and with a human present they answer it; without one the run takes the AFK default. It never merges.
import path from "node:path";
import { CodeReview, createShipChange, ImplementSpec, type ShipChangeOutput, Verify } from "@selfbuilding/agents";
import { slack } from "@selfbuilding/channel-slack";
import { fileArtifacts, fileJournal, type HitlOptions, run } from "@selfbuilding/core";
import { beforeAll, describe, expect, it } from "vitest";
import { serveHitl } from "./support/hooks.js";
import {
  approver,
  budget,
  github,
  githubSkip,
  harnesses,
  hooksPort,
  humanSkip,
  liveRunId,
  needs,
  PLAYGROUND,
  providers,
  recorder,
  slackChannel,
  slackSkip,
  tempDir,
  useBuiltRuntime,
} from "./support/live.js";

const skip = needs(
  !providers.impello.ready && providers.impello.skip,
  !providers.e2b.ready && providers.e2b.skip,
  !harnesses["claude-code"].ready && harnesses["claude-code"].skip,
  !harnesses.codex.ready && harnesses.codex.skip,
  githubSkip,
);
const human = humanSkip === "" && slackSkip === "";

beforeAll(() => useBuiltRuntime());

describe("live 2: spec to PR loop", () => {
  it.skipIf(skip !== "")(`ships a spec to a PR without merging${skip ? ` (skipped: ${skip})` : ""}`, async () => {
    const dir = await tempDir("sbl-ship-");
    const claude = harnesses["claude-code"].make();
    const codexH = harnesses.codex.make();
    const git = github();
    const ship = createShipChange({
      agents: { ImplementSpec, CodeReview, Verify },
      builder: { harness: claude, provider: providers.impello.make("claude-code") },
      reviewers: [
        { label: "claude", harness: claude, sandbox: "fork" },
        { label: "codex", harness: codexH, sandbox: "fork" },
        { label: "codex-e2b", harness: codexH, sandbox: providers.e2b.make("codex") },
      ],
      verifier: { harness: codexH, sandbox: "fork" },
      pullRequests: git.pullRequests,
    });

    const journal = fileJournal(path.join(dir, "journal"));
    const channel = slackSkip === "" ? slack({ channel: slackChannel }) : undefined;
    const server =
      human && channel && journal.asks
        ? await serveHitl({ port: hooksPort, channel, store: journal.asks, approver })
        : undefined;
    const hitl: HitlOptions = channel
      ? { channels: [channel], ...(human ? { approvers: [{ slack: approver }] } : { mode: "afk" }) }
      : { mode: "afk" };

    const events = recorder();
    try {
      const out = await run(
        ship,
        { repo: PLAYGROUND, spec: { path: "docs/specs/multiply.md" }, testCommand: "node --test" },
        {
          runId: liveRunId("ship"),
          config: {
            deployment: "live",
            sandbox: providers.impello.make("claude-code"),
            harness: claude,
            git,
            hitl,
            budget: budget(),
            // The build box, two forks and the reviewer on E2B at once; Impello's default (trial) tier allows two.
            concurrency: { sandboxes: 4 },
            artifacts: fileArtifacts(path.join(dir, "artifacts")),
          },
          journal,
          events: [events.sink],
        },
      );
      expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
      const o = out.output as ShipChangeOutput;
      expect(o.pr).not.toBeNull();
      expect(o.rounds.length).toBeGreaterThan(0);
      expect(o.rounds[0]?.reviewers.map((r) => r.label)).toEqual(["claude", "codex", "codex-e2b"]);
      expect(o.merged).toBe(false);
      expect(events.of("sandbox.forked").length).toBeGreaterThan(0);
    } finally {
      await server?.close();
    }
  });
});
