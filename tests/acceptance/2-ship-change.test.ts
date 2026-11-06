// Acceptance 2 (docs/BASIC-SCOPE.md): shipChange runs implement → PR (emulated GitHub, as the App) → review on
// forks with reviewers on different providers and harnesses → fix → verify → Slack ask (emulated) → stops before
// merge.
//
// Every agent call runs the real runtime and MCP server in a tmpdir box; the scripted harnesses print Claude Code's
// and Codex's native streams, read by those adapters' parsers. Shell steps are real: the builder and the fixer
// commit, the reviewers read the diff the runtime wrote, the verifier writes its evidence file.
import path from "node:path";
import {
  CodeReview,
  createShipChange,
  IMPLEMENTATION_NOTES_PATH,
  ImplementSpec,
  type ShipChangeOutput,
  Verify,
} from "@selfbuilding/agents";
import { fileArtifacts, fileJournal, run } from "@selfbuilding/core";
import { type ScriptCall, type ScriptStep, scripted, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitHubRig, startGitHubRig } from "./support/github.js";
import { recorder, scriptedClaude, scriptedCodex, tempDir, useBuiltRuntime } from "./support/kit.js";
import { type SlackRig, startSlackRig } from "./support/slack.js";

let dir: string;
let github: GitHubRig;
let slackRig: SlackRig;
let build: TmpdirProvider;
let other: TmpdirProvider;
/** Every box either provider made: its provider, and the box it was forked from. */
const placements = new Map<string, { provider: string; forkOf?: string }>();

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-ship-");
  github = await startGitHubRig(path.join(dir, "remote"));
  slackRig = await startSlackRig();
  build = tracked(tmpdirProvider({ id: "tmpdir-build", root: path.join(dir, "build") }));
  other = tracked(tmpdirProvider({ id: "tmpdir-other", root: path.join(dir, "other") }));
});

afterAll(async () => {
  await build?.close();
  await other?.close();
  await slackRig?.close();
  await github?.close();
});

/** Records where each box came from, as the provider made it. */
function tracked(p: TmpdirProvider): TmpdirProvider {
  return new Proxy(p, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "openOrCreate") {
        return async (...args: Parameters<TmpdirProvider["openOrCreate"]>) => {
          const opened = await target.openOrCreate(...args);
          if (!placements.has(opened.handle.ref.id)) placements.set(opened.handle.ref.id, { provider: target.id });
          return opened;
        };
      }
      if (key === "fork") {
        return async (...args: Parameters<NonNullable<TmpdirProvider["fork"]>>) => {
          const children = await (target.fork as NonNullable<TmpdirProvider["fork"]>)(...args);
          for (const c of children) {
            if ("ref" in c) placements.set(c.ref.id, { provider: target.id, forkOf: args[0].id });
          }
          return children;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function live(p: TmpdirProvider): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const ref of p.list({ deployment: "acceptance" })) if (ref.state !== "stopped") out.set(ref.id, ref.state);
  return out;
}

const BUGGY =
  "export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a + a;\n}\n";
const TEST =
  'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add, multiply } from "../src/math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n\ntest("multiply by itself", () => {\n  assert.equal(multiply(2, 2), 4);\n});\n';

const finding = {
  file: "src/math.js",
  line: 6,
  severity: "high",
  category: "correctness",
  summary: "multiply adds its first argument to itself.",
  failureScenario: "multiply(2, 3) returns 4, not 6.",
  verdict: "CONFIRMED",
} as const;

const heredoc = (file: string, content: string) =>
  `mkdir -p "$(dirname ${file})" && cat > ${file} <<'EOF'\n${content}EOF`;

/** One script per agent call, picked by the call's label (the last callPath segment). */
function script(call: ScriptCall): ScriptStep[] {
  const label = call.callPath.split("/").at(-1) ?? "";
  if (label === "implement") {
    return [
      scripted.sh(heredoc("src/math.js", BUGGY)),
      scripted.sh(heredoc("test/math.test.js", TEST)),
      scripted.sh(
        heredoc(
          IMPLEMENTATION_NOTES_PATH,
          "# Implementation notes\n\n## Design decisions\n- multiply lives next to add.\n\n## Deviations\n\n## Tradeoffs\n\n## Open questions\n- Should multiply accept bigints?\n",
        ),
      ),
      scripted.sh("git add -A && git commit -qm 'Add multiply'"),
      scripted.submit({
        status: "done",
        summary: "Added multiply(a, b) with a test.",
        changes: [
          { file: "src/math.js", why: "the spec asks for multiply" },
          { file: "test/math.test.js", why: "cover it" },
        ],
        tests: { command: "node --test", passed: true },
        followUps: [],
        openQuestions: ["Should multiply accept bigints?"],
        prTitle: "Add multiply",
        prBody: "## What changed and why\nAdds multiply(a, b), as docs/specs/multiply.md asks.\n",
      }),
    ];
  }
  if (label.startsWith("review-1-")) {
    return [
      scripted.sh("grep -q 'return a + a' /selfbuilding/in/diff.patch", { expectExit: 0 }),
      scripted.submit({
        verdict: "request_changes",
        tier: "medium",
        summary: "multiply is wrong.",
        findings: [finding],
      }),
    ];
  }
  if (label.startsWith("review-2-")) {
    return [
      scripted.sh("grep -q 'return a \\* b' /selfbuilding/in/diff.patch", { expectExit: 0 }),
      scripted.submit({ verdict: "approve", tier: "medium", summary: "multiply is right now.", findings: [] }),
    ];
  }
  if (label === "fix-1") {
    return [
      scripted.sh("sed -i 's/return a + a;/return a * b;/' src/math.js && grep -q 'a \\* b' src/math.js", {
        expectExit: 0,
      }),
      scripted.sh(`echo '- fix-1: multiply now multiplies.' >> ${IMPLEMENTATION_NOTES_PATH}`),
      scripted.sh("git commit -qam 'Fix multiply'"),
      scripted.submit({
        summary: "multiply multiplies.",
        fixed: [{ file: "src/math.js", line: 6, summary: "use a * b" }],
        unresolved: [],
      }),
    ];
  }
  if (label === "verify") {
    const evidence = "/selfbuilding/out/files/verify/multiply/evidence.md";
    return [
      scripted.sh(
        `mkdir -p /selfbuilding/out/files/verify/multiply && node -e 'import("./src/math.js").then(m => console.log("multiply(2,3) =", m.multiply(2, 3)))' > ${evidence} 2>&1; cat ${evidence} >&2; pwd >&2; git log --oneline >&2`,
      ),
      scripted.sh(`grep -q '= 6' ${evidence} || { cat ${evidence}; pwd; git log --oneline; exit 1; }`, {
        expectExit: 0,
      }),
      scripted.submit({
        summary: "multiply(2, 3) returns 6.",
        flows: [
          {
            name: "multiply",
            outcome: "verified",
            claim: "verified",
            detail: "Called multiply(2, 3) as a user of the module and got 6.",
            evidence,
            checked: ["multiply(2, 3) === 6"],
            defects: [],
          },
        ],
        files: [evidence],
      }),
    ];
  }
  return [scripted.say(`no script for ${call.callPath}`)];
}

describe("acceptance 2: spec to PR loop", () => {
  it("implements, opens the PR as the App, reviews on forks and another provider, fixes, verifies and asks on Slack without merging", async () => {
    const claude = scriptedClaude(script);
    const codexH = scriptedCodex(script);
    const ship = createShipChange({
      agents: { ImplementSpec, CodeReview, Verify },
      builder: { harness: claude },
      reviewers: [
        { label: "claude", harness: claude, sandbox: "fork" },
        { label: "codex", harness: codexH, sandbox: "fork" },
        { label: "codex-other", harness: codexH, sandbox: other },
      ],
      verifier: { harness: codexH, sandbox: "fork" },
      pullRequests: github.pullRequests,
    });

    const runId = "ns_accept_ship";
    const journal = fileJournal(path.join(dir, "journal"));
    const asks = journal.asks;
    if (!asks) throw new Error("fileJournal must provide an ask store");
    slackRig.listen(asks);
    const events = recorder();

    const running = run(
      ship,
      { repo: github.repo, spec: { path: "docs/specs/multiply.md" }, testCommand: "node --test" },
      {
        runId,
        config: {
          deployment: "acceptance",
          sandbox: build,
          harness: claude,
          hitl: slackRig.hitl(),
          artifacts: fileArtifacts(path.join(dir, "artifacts")),
        },
        journal,
        events: [events.sink],
      },
    );
    running.catch(() => {});

    // The merge question reaches Slack; the human clicks Merge. shipChange records the choice and still never merges.
    const ask = await Promise.race([
      slackRig.waitForAsk(asks, runId, 150_000),
      running.then((o) => {
        throw new Error(`the run ended before asking: ${o.status} ${JSON.stringify(events.of("error"))}`);
      }),
    ]);
    expect(ask.spec.question).toMatch(/^Merge PR #\d+\?$/);
    await slackRig.click(ask, "Merge");

    const out = await running;
    expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
    const o = out.output as ShipChangeOutput;

    // Implement → PR, opened and refreshed by the App, with the notes in the body.
    expect(o.build.status).toBe("done");
    expect(o.pr).not.toBeNull();
    const pulls = await github.pulls();
    expect(pulls).toHaveLength(1);
    const pr = pulls[0];
    expect(pr?.number).toBe(o.pr?.number);
    expect(pr?.head.ref).toBe(o.branch);
    expect(pr?.user.login).toMatch(/\[bot\]$/);
    expect(pr?.body).toContain("multiply now multiplies");
    expect(pr?.body).toContain("Should multiply accept bigints?");
    expect(github.opened.map((p) => p.title)).toEqual(["Add multiply", "Add multiply"]);

    // Review round 1 on two forks and a second provider, in parallel; one fix; round 2 is clean.
    expect(o.rounds).toHaveLength(2);
    expect(o.rounds[0]).toMatchObject({ round: 1, fixNow: 1, fixed: 1 });
    expect(o.rounds[0]?.reviewers.map((r) => [r.label, r.ok, r.verdict])).toEqual([
      ["claude", true, "request_changes"],
      ["codex", true, "request_changes"],
      ["codex-other", true, "request_changes"],
    ]);
    expect(o.rounds[1]).toMatchObject({ round: 2, fixNow: 0 });
    expect(o.rounds[1]?.reviewers.every((r) => r.verdict === "approve")).toBe(true);

    // Launch order: the reviewers of a round run in parallel, so only the rounds are ordered.
    const launched = events.launched().map((p) => p.split("/").at(-1) ?? "");
    const round = (n: number) => ["claude", "codex", "codex-other"].map((r) => `review-${n}-${r}`);
    expect(launched[0]).toBe("implement");
    expect(launched.slice(1, 4).sort()).toEqual(round(1));
    expect(launched[4]).toBe("fix-1");
    expect(launched.slice(5, 8).sort()).toEqual(round(2));
    expect(launched[8]).toBe("verify");

    // Placement: the build box is forked for each round's two fork reviewers and for Verify; the third reviewer
    // runs on the other provider; the fixer runs in the build box itself.
    expect(events.of("sandbox.forked").map((e) => (e.data as { n: number }).n)).toEqual([2, 2, 1]);
    const boxOf = Object.fromEntries(
      events.of("agent.launched").map((e) => [e.callPath?.split("/").at(-1), (e.data as { sandbox: string }).sandbox]),
    );
    const buildBox = boxOf.implement as string;
    expect(placements.get(buildBox)).toEqual({ provider: "tmpdir-build" });
    expect(boxOf["fix-1"]).toBe(buildBox);
    for (const label of ["review-1-claude", "review-1-codex", "review-2-claude", "review-2-codex", "verify"]) {
      expect(placements.get(boxOf[label] as string), label).toEqual({ provider: "tmpdir-build", forkOf: buildBox });
    }
    for (const label of ["review-1-codex-other", "review-2-codex-other"]) {
      expect(placements.get(boxOf[label] as string), label).toEqual({ provider: "tmpdir-other" });
    }
    // Nothing is left running: fork and fresh review boxes are killed; the build box is paused for the human.
    expect([...(await live(build))]).toEqual([[buildBox, "paused"]]);
    expect(await live(other)).toEqual(new Map());
    // Two harnesses: each reviewer's stream was read by its own adapter's parser.
    const harnessOf = (label: string) =>
      events.events.find((e) => e.type === "harness.session.started" && e.callPath?.endsWith(label))?.data;
    expect(JSON.stringify(harnessOf("review-1-claude"))).not.toBe(JSON.stringify(harnessOf("review-1-codex")));

    // Verify, then the decision: asked on Slack, answered by the human, not merged.
    expect(o.verify).toEqual({
      flows: [
        {
          name: "multiply",
          outcome: "verified",
          detail: "Called multiply(2, 3) as a user of the module and got 6.",
        },
      ],
    });
    expect(o.decision).toEqual({ recommended: "merge", choice: "merge", answeredBy: "human" });
    expect(o.merged).toBe(false);
    expect(o.status).toBe("awaiting_decision");
    expect(pr?.merged).toBe(false);
    expect(pr?.state).toBe("open");
    expect(await slackRig.transcript()).toContain(`Merge PR #${o.pr?.number}`);
  });
});
