// Acceptance 8 (docs/spec/demo-path.md §8): an agent-written workflow script runs in the QuickJS isolate as the
// deployed `run-script` factory. It builds on a shared box, reviews and finds flows on forks in parallel, verifies
// each flow on its own fork, and returns JSON. A run cancelled mid-way resumes with the same run id: finished calls
// come from the journal, the rest run live. Every cap trips with ScriptLimitError before an agent launches.
//
// Every agent call runs the real runtime and MCP server in a tmpdir box; the scripted harnesses print Claude
// Code's and Codex's native streams, read by those adapters' parsers.
import fs from "node:fs/promises";
import path from "node:path";
import { CodeReview, IMPLEMENTATION_NOTES_PATH, ImplementSpec, Verify } from "@selfbuilding/agents";
import { fileArtifacts, fileJournal, type Json, type RunOutcome, run, ScriptInvalidError } from "@selfbuilding/core";
import { createScriptFactory, type RunScriptOptions } from "@selfbuilding/script";
import {
  createLocalRemote,
  type ScriptCall,
  type ScriptStep,
  scripted,
  type TmpdirProvider,
  tmpdirProvider,
} from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Recorder, recorder, scriptedClaude, scriptedCodex, tempDir, useBuiltRuntime } from "./support/kit.js";

let dir: string;
let boxes: TmpdirProvider;
let repo: string;

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-script-");
  boxes = tmpdirProvider({ root: path.join(dir, "boxes") });
  repo = (await createLocalRemote(path.join(dir, "remote"))).url;
});

afterAll(async () => {
  await boxes?.close();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const MATH =
  "export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n";
const TEST =
  'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add, multiply } from "../src/math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n\ntest("multiply", () => {\n  assert.equal(multiply(2, 3), 6);\n});\n';

const heredoc = (file: string, content: string) =>
  `mkdir -p "$(dirname ${file})" && cat > ${file} <<'EOF'\n${content}EOF`;

/** One script per agent call, picked by the call's label (the last callPath segment). */
function harnessScript(call: ScriptCall): ScriptStep[] {
  const label = call.callPath.split("/").at(-1) ?? "";
  if (label === "implement") {
    return [
      scripted.sh(heredoc("src/math.js", MATH)),
      scripted.sh(heredoc("test/math.test.js", TEST)),
      scripted.sh(
        heredoc(
          IMPLEMENTATION_NOTES_PATH,
          "# Implementation notes\n\n## Design decisions\n- multiply lives next to add.\n\n## Deviations\n\n## Tradeoffs\n\n## Open questions\n",
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
        openQuestions: [],
        prTitle: "Add multiply",
        prBody: "Adds multiply(a, b).",
      }),
    ];
  }
  if (label === "review") {
    return [
      scripted.sh("grep -q 'return a \\* b' /selfbuilding/in/diff.patch", { expectExit: 0 }),
      scripted.submit({ verdict: "approve", tier: "medium", summary: "multiply is right.", findings: [] }),
    ];
  }
  if (label === "find-flows") {
    return [
      scripted.submit({
        flows: [
          { name: "multiply", endState: "multiply(2, 3) returns 6" },
          { name: "add", endState: "add(2, 3) still returns 5" },
        ],
      }),
    ];
  }
  if (label.startsWith("verify-")) {
    const flow = label.slice("verify-".length);
    const call = flow === "multiply" ? "multiply(2, 3)" : "add(2, 3)";
    const want = flow === "multiply" ? "6" : "5";
    const evidence = `/selfbuilding/out/files/verify/${flow}/evidence.md`;
    return [
      scripted.sh(
        `mkdir -p /selfbuilding/out/files/verify/${flow} && node -e 'import("./src/math.js").then(m => console.log("${call} =", m.${call}))' > ${evidence} 2>&1`,
      ),
      scripted.sh(`grep -q '= ${want}' ${evidence}`, { expectExit: 0 }),
      scripted.submit({
        summary: `${call} returns ${want}.`,
        flows: [
          {
            name: flow,
            outcome: "verified",
            claim: "verified",
            detail: `Called ${call} as a user of the module and got ${want}.`,
            evidence,
            checked: [`${call} === ${want}`],
            defects: [],
          },
        ],
        files: [evidence],
      }),
    ];
  }
  return [scripted.say(`no script for ${call.callPath}`)];
}

/**
 * The demo-path §8.2 script, with FindFlows as an inline agent and explicit harness names. Forks are taken in the
 * scope that owns the build handle, as for a TypeScript factory: a concurrent child may not fork a shared handle.
 */
const WORKFLOW = `export default async function main(input, sb) {
  sb.phase("build");
  const build = sb.sandbox({ label: "build", repo: input.repo, size: "medium" });
  const impl = await sb.agents.ImplementSpec(
    { spec: { path: "docs/specs/multiply.md" }, testCommand: "node --test" },
    { sandbox: build, label: "implement", harness: "claude-code" },
  );
  sb.phase("check");
  // A shared handle is forked from the scope that owns it; each concurrent checker then claims its own fork.
  const [reviewBox, flowsBox] = await build.fork(2);
  const [review, found] = await sb.parallel([
    () =>
      sb.agents.CodeReview(
        { target: { kind: "diff", base: "main", head: impl.artifacts.branch.name } },
        { sandbox: reviewBox, label: "review", harness: "claude-code" },
      ),
    async () =>
      sb.agent(
        {
          name: "FindFlows",
          prompt: "List the user flows this change touches, each with the end state a user reaches.",
          input: { change: impl.result.summary },
          output: {
            type: "object",
            required: ["flows"],
            properties: {
              flows: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "endState"],
                  properties: { name: { type: "string" }, endState: { type: "string" } },
                },
              },
            },
          },
        },
        { sandbox: flowsBox, label: "find-flows", harness: "codex" },
      ),
  ]);
  const flows = found ? found.result.flows : [];
  // Live handles count against maxSandboxes (release-prep §7.3): free the checkers' forks before forking again.
  await Promise.all([reviewBox.dispose(), flowsBox.dispose()]);
  sb.phase("verify");
  const verifyBoxes = flows.length > 0 ? await build.fork(flows.length) : [];
  const verdicts = await sb.pipeline(flows, async (flow, { index }) =>
    sb.agents.Verify(
      { change: impl.result.summary, flows: [flow] },
      { sandbox: verifyBoxes[index], label: "verify-" + flow.name, harness: "codex" },
    ),
  );
  await Promise.all(verifyBoxes.map((b) => b && b.dispose()));
  return {
    status: impl.result.status,
    branch: impl.artifacts.branch ? impl.artifacts.branch.name : null,
    review: review ? review.result.verdict : null,
    flows: verdicts.map((v, i) => ({ name: flows[i].name, outcome: v ? v.result.flows[0].outcome : null, replayed: v ? v.replayed : null })),
  };
}
`;

function options(): RunScriptOptions {
  return {
    agents: { ImplementSpec, CodeReview, Verify },
    harnesses: { "claude-code": scriptedClaude(harnessScript), codex: scriptedCodex(harnessScript) },
  };
}

async function runWorkflow(
  source: string,
  runId: string,
  events: Recorder,
  extra: { signal?: AbortSignal; caps?: Record<string, unknown>; script?: RunScriptOptions } = {},
): Promise<RunOutcome<Json>> {
  const f = createScriptFactory({ ...options(), ...extra.script });
  return run(
    f,
    { source, name: "demo-path", input: { repo }, ...(extra.caps ? { caps: extra.caps } : {}) },
    {
      runId,
      config: {
        deployment: "acceptance",
        sandbox: boxes,
        harness: scriptedClaude(harnessScript),
        artifacts: fileArtifacts(path.join(dir, "artifacts")),
      },
      journal: fileJournal(path.join(dir, "journal")),
      events: [events.sink],
      ...(extra.signal ? { signal: extra.signal } : {}),
    },
  );
}

const label = (callPath: string) => callPath.split("/").at(-1) ?? "";

describe("acceptance 8: run-script in a QuickJS isolate", () => {
  it("runs the §8.2 workflow end to end: build, review and find flows on forks in parallel, verify each flow", async () => {
    const events = recorder();
    const out = await runWorkflow(WORKFLOW, "ns_accept_script", events);
    expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
    expect(out.output).toEqual({
      status: "done",
      branch: expect.stringMatching(/^selfbuilding\//),
      review: "approve",
      flows: [
        { name: "multiply", outcome: "verified", replayed: false },
        { name: "add", outcome: "verified", replayed: false },
      ],
    });

    // callPaths follow the script's structure: the parallel children and pipeline items own their calls.
    const launched = events.launched();
    expect(launched[0]).toBe("implement");
    expect(launched.slice(1, 3).sort()).toEqual(["parallel#0/[0]/review", "parallel#0/[1]/find-flows"]);
    expect(launched.slice(3).sort()).toEqual([
      "pipeline#0/[0]/stage#0/verify-multiply",
      "pipeline#0/[1]/stage#0/verify-add",
    ]);
    // Forks of the build box: two for the checkers, then one per flow; the phases came from the script.
    expect(events.of("sandbox.forked").map((e) => (e.data as { n: number }).n)).toEqual([2, 2]);
    expect(events.of("phase").map((e) => (e.data as { name: string }).name)).toEqual(["build", "check", "verify"]);
    // Two harnesses picked by name from the registry, each read by its own adapter's parser.
    const sessions = events.of("harness.session.started");
    expect(sessions.length).toBeGreaterThanOrEqual(5);
  });

  it("a run cancelled before Verify resumes with the same run id: finished calls replay, Verify runs live", async () => {
    const runId = "ns_accept_script_resume";
    const first = recorder();
    const abort = new AbortController();
    const sink = first.sink;
    // Cancel the moment the script enters its verify phase: build, review and find-flows have all finished.
    first.sink = (e) => {
      sink(e);
      if (e.type === "phase" && (e.data as { name: string }).name === "verify") abort.abort(new Error("cancelled"));
    };
    const cancelled = await runWorkflow(WORKFLOW, runId, { ...first, sink: first.sink }, { signal: abort.signal });
    expect(cancelled.status).toBe("aborted");
    expect(first.launched().map(label).sort()).toEqual(["find-flows", "implement", "review"]);

    const second = recorder();
    const resumed = await runWorkflow(WORKFLOW, runId, second);
    expect(resumed.status, JSON.stringify(second.of("error").map((e) => e.data))).toBe("ok");
    // Nothing that finished before the cancel launched again.
    expect(second.launched().map(label).sort()).toEqual(["verify-add", "verify-multiply"]);
    expect(resumed.output).toMatchObject({
      status: "done",
      review: "approve",
      flows: [
        { name: "multiply", outcome: "verified", replayed: false },
        { name: "add", outcome: "verified", replayed: false },
      ],
    });

    // A third pass replays everything.
    const third = recorder();
    const replayed = await runWorkflow(WORKFLOW, runId, third);
    expect(third.launched()).toEqual([]);
    expect(replayed.output).toMatchObject({
      flows: [
        { name: "multiply", outcome: "verified", replayed: true },
        { name: "add", outcome: "verified", replayed: true },
      ],
    });
  });

  describe("every cap trips with ScriptLimitError, and no agent launches past it", () => {
    const cases: { limit: string; caps?: Record<string, unknown>; source?: string }[] = [
      { limit: "size", caps: { allowedSizes: ["small"] } },
      { limit: "agent_calls", caps: { maxAgentCalls: 1 } },
      { limit: "budget", caps: { budgetUsd: 0.5 } },
      {
        limit: "sandboxes",
        source: "export default async (input, sb) => { await sb.sandbox({ repo: input.repo }).fork(9); }",
      },
      { limit: "source_bytes", caps: { maxSourceBytes: 100 } },
      { limit: "output_bytes", caps: { maxOutputBytes: 10 }, source: 'export default async () => "x".repeat(100);' },
      { limit: "cpu", caps: { cpuSliceMs: 50 }, source: "export default async () => { for (;;) {} };" },
      {
        limit: "memory",
        caps: { memoryBytes: 4 * 1024 * 1024 },
        source: "export default async () => { const a = []; for (;;) a.push(new Array(1e5).fill(1)); };",
      },
      {
        limit: "stack",
        caps: { stackBytes: 128 * 1024 },
        source: "const f = (n) => f(n + 1) + 1;\nexport default async () => f(0);",
      },
      {
        limit: "wall_clock",
        caps: { wallClock: 100 },
        source: "export default async () => { await new Promise(() => {}); };",
      },
    ];
    for (const c of cases) {
      it(c.limit, async () => {
        const events = recorder();
        const out = await runWorkflow(c.source ?? WORKFLOW, `ns_accept_cap_${c.limit}`, events, {
          ...(c.caps ? { caps: c.caps } : {}),
          // The budget case prices ImplementSpec at 1 USD, so the spend passes the cap before the next call.
          ...(c.limit === "budget"
            ? { script: { agents: { ImplementSpec: pricedImplement, CodeReview, Verify } } }
            : {}),
        });
        expect(out.status).toBe("failed");
        const body = events.of("error").find((e) => (e.data as { primitive?: string }).primitive === "run");
        const data = (body?.data ?? {}) as { code?: string; message?: string };
        expect(data.code).toBe("script_limit");
        expect(data.message).toContain(`hit its ${c.limit} limit`);
        const allowed = c.limit === "budget" || c.limit === "agent_calls" ? ["implement"] : [];
        expect(events.launched().map(label)).toEqual(allowed);
      });
    }
  });

  it("an invalid script fails at once as a usage error, before any box is created", async () => {
    const events = recorder();
    const err = await runWorkflow(
      'export default async (input, sb) => {\n  await sb.agents.ImplementSpec({}, { secrets: ["X"] });\n}',
      "ns_accept_script_invalid",
      events,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ScriptInvalidError);
    expect(err.line).toBe(2);
    expect(events.launched()).toEqual([]);
  });
});

/** ImplementSpec, reporting a fixed cost so the budget cap has a spend to count. */
const pricedImplement = Object.assign(
  async (input: unknown, opts?: Parameters<typeof ImplementSpec>[1]) => {
    const r = await ImplementSpec(input as Parameters<typeof ImplementSpec>[0], opts);
    return { ...r, usage: { ...r.usage, usd: 1 } };
  },
  {
    settled: ImplementSpec.settled,
  },
) as unknown as typeof ImplementSpec;
