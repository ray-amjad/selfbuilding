// Acceptance 9 (docs/spec/demo-path.md §9): an agent launches a workflow from inside its sandbox.
//
// The agent calls start_workflow through the real selfbuilding-mcp; the real supervisor reads the root-only start
// grant core staged, POSTs to the host's createStartWorkflowHandler over HTTP, and returns the receipt. Each guard
// refuses once, a retried call converges on the run it already started, and get_workflow_status reads it back.
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  agent,
  factory,
  fileArtifacts,
  fileJournal,
  run,
  type SelfbuildingEvent,
  type StartWorkflowCaller,
  type StartWorkflowPolicy,
  type StartWorkflowRequest,
  type WorkflowLauncher,
  type WorkflowRunStatus,
  workflowRunId,
} from "@selfbuilding/core";
import { createStartWorkflowHandler } from "@selfbuilding/hooks";
import { type ScriptStep, scripted, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { recorder, scriptedClaude, tempDir, useBuiltRuntime } from "./support/kit.js";

const SECRET = "acceptance-start-secret";
const SCRIPT = "export default async (input, sb) => { sb.phase('fix'); return { ok: true }; };";

let dir: string;
let provider: TmpdirProvider;
let server: http.Server;
let url: string;
let handler: (req: Request) => Promise<Response>;

/** An in-memory launcher: every launch is a run that stays alive, holding the sandboxes it asked for. */
function memoryLauncher() {
  const runs = new Map<string, { req: StartWorkflowRequest; caller: StartWorkflowCaller; status: WorkflowRunStatus }>();
  const launcher: WorkflowLauncher = {
    host: "node",
    async start(req, caller) {
      const runId = workflowRunId(caller, req);
      const existed = runs.has(runId);
      if (!existed) {
        runs.set(runId, {
          req,
          caller,
          status: {
            runId,
            status: "running",
            name: req.name,
            phase: "fix",
            agents: [],
            sandboxes: 0,
            launchedBy: caller,
          },
        });
      }
      return { runId, status: existed ? "exists" : "started", host: "node", watch: `selfbuilding watch ${runId}` };
    },
    async active() {
      let sandboxes = 0;
      for (const r of runs.values()) sandboxes += r.req.maxSandboxes ?? 0;
      return { runs: runs.size, sandboxes };
    },
    async status(runId) {
      return runs.get(runId)?.status ?? null;
    },
    async checkScript(source) {
      if (!source.includes("export default")) throw new Error("unreachable in this test");
    },
  };
  return { launcher, runs };
}

function useHandler(policy: StartWorkflowPolicy, launcher: WorkflowLauncher, secret = SECRET): void {
  handler = createStartWorkflowHandler({ secret, launcher, policy });
}

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-start-");
  provider = tmpdirProvider({ root: path.join(dir, "boxes") });
  // The host's handler, served over real HTTP so the supervisor's POST goes through fetch.
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const response = await handler(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method ?? "GET",
        headers,
        ...(req.method === "POST" ? { body } : {}),
      }),
    );
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/start-workflow`;
});

afterAll(async () => {
  await provider?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

const Launched = z.object({ launched: z.boolean() });

const Launching = factory({ name: "launching-agent", input: z.object({}) }, async () => {
  const r = await agent({
    name: "planner",
    prompt: "Launch the follow-up workflow, then submit.",
    output: Launched,
    label: "planner",
    startWorkflow: true,
    budget: { usd: 6 },
  });
  return r.result;
});

const startCall = (input: Record<string, unknown>, expect: "accepted" | "rejected"): ScriptStep =>
  ({ tool: "start_workflow", input: { name: "follow-up", script: SCRIPT, ...input }, expect }) as unknown as ScriptStep;

/** The tool results the agent saw for one tool, in call order. */
function toolOutputs(events: SelfbuildingEvent[], tool: string): string[] {
  const ids = new Set(
    events
      .filter((e) => e.type === "harness.tool.started" && JSON.stringify(e.data).includes(tool))
      .map((e) => (e.data as { callId: string }).callId),
  );
  return events
    .filter((e) => e.type === "harness.tool.completed" && ids.has((e.data as { callId: string }).callId))
    .map((e) => String((e.data as { output?: unknown }).output ?? ""));
}

function runOnce(runId: string, steps: ScriptStep[], policy: StartWorkflowPolicy) {
  const events = recorder();
  const out = run(
    Launching,
    {},
    {
      runId,
      config: {
        deployment: "acceptance",
        sandbox: provider,
        harness: scriptedClaude([...steps, scripted.submit({ launched: true })]),
        artifacts: fileArtifacts(path.join(dir, "artifacts")),
        secrets: { resolve: async (names) => Object.fromEntries(names.map((n) => [n, SECRET])) },
        startWorkflow: { ...policy, url },
      },
      journal: fileJournal(path.join(dir, runId)),
      events: [events.sink],
    },
  );
  return { out, events };
}

describe("acceptance 9: start_workflow", () => {
  it("launches through the tool socket, refuses each host-side guard once, converges on retry and reads status", async () => {
    const policy: StartWorkflowPolicy = {
      enabled: true,
      allowedSizes: ["small", "medium"],
      maxBudgetUsd: 10,
      maxSandboxesPerRun: 2,
      maxConcurrentRuns: 2,
      maxConcurrentSandboxes: 3,
      maxScriptBytes: 200,
    };
    const { launcher, runs } = memoryLauncher();
    useHandler(policy, launcher);
    const { out, events } = runOnce(
      "ns_accept_start",
      [
        startCall({ size: "medium", maxSandboxes: 2, input: { issue: 7 } }, "accepted"),
        // A retried tool call converges on the run it already started.
        startCall({ size: "medium", maxSandboxes: 2, input: { issue: 7 } }, "accepted"),
        startCall({ size: "large" }, "rejected"),
        startCall({ budgetUsd: 5, maxSandboxes: 1, input: { second: true } }, "accepted"),
        startCall({ budgetUsd: 7 }, "rejected"),
        startCall({ maxSandboxes: 3 }, "rejected"),
        startCall({ script: `${SCRIPT}${" ".repeat(200)}` }, "rejected"),
        startCall({ maxSandboxes: 2, input: { third: true } }, "rejected"),
        { tool: "get_workflow_status", input: { runId: "placeholder" }, expect: "rejected" } as unknown as ScriptStep,
      ],
      policy,
    );
    const outcome = await out;
    expect(outcome.status, JSON.stringify(events.of("agent.failed").map((e) => e.data))).toBe("ok");

    const outputs = toolOutputs(events.events, "start_workflow");
    expect(outputs).toHaveLength(8);
    const [first, retry, size, okBudget, budget, perRun, bytes, concurrent] = outputs as string[];
    const runId = /Started run (ns_wf_\w+) on node/.exec(first ?? "")?.[1];
    expect(runId, first).toBeDefined();
    expect(first).toBe(`Started run ${runId} on node. Follow it with: selfbuilding watch ${runId}`);
    expect(retry).toBe(first);
    expect(size).toContain("size allows sizes small, medium");
    expect(okBudget).toContain("Started run");
    // The agent's own budget slice ($6) caps what it may hand a launched run.
    expect(budget).toContain("budget allows $6");
    expect(perRun).toContain("sandboxes_per_run");
    expect(bytes).toContain("script_bytes");
    // Two runs alive (2 + 2 sandboxes asked) hit the concurrency guard before the sandbox one.
    expect(concurrent).toContain("concurrent_runs");

    expect(runs.size).toBe(2);
    const launched = runs.get(runId as string);
    expect(launched?.caller).toEqual({ kind: "agent", runId: "ns_accept_start", callPath: "planner", depth: 1 });
    expect(launched?.req).toMatchObject({ name: "follow-up", size: "medium", maxSandboxes: 2, input: { issue: 7 } });
    // The status of an id this run never launched is not readable.
    expect(toolOutputs(events.events, "get_workflow_status")[0]).toContain("No workflow run placeholder");
    // The supervisor told the host about the launch; the grant itself never reached an event.
    expect(events.events.some((e) => JSON.stringify(e).includes("Bearer"))).toBe(false);
  });

  it("refuses concurrent sandboxes, and reads the status of a launched run", async () => {
    const policy: StartWorkflowPolicy = { enabled: true, maxConcurrentRuns: 3, maxConcurrentSandboxes: 3 };
    const { launcher, runs } = memoryLauncher();
    useHandler(policy, launcher);
    const { out, events } = runOnce(
      "ns_accept_start_sb",
      [
        startCall({ maxSandboxes: 2, input: { a: 1 } }, "accepted"),
        startCall({ maxSandboxes: 2, input: { b: 1 } }, "rejected"),
      ],
      policy,
    );
    expect((await out).status).toBe("ok");
    const outputs = toolOutputs(events.events, "start_workflow");
    expect(outputs[1]).toContain("concurrent_sandboxes allows 3 sandboxes at once");
    expect(runs.size).toBe(1);
    expect([...runs.values()][0]?.status.phase).toBe("fix");
  });

  it("refuses a disabled host, a grant the host cannot verify, and a launch from a launched run (depth)", async () => {
    const policy: StartWorkflowPolicy = { enabled: true };
    const cases: { runId: string; set: () => void; expect: string }[] = [
      {
        runId: "ns_accept_disabled",
        set: () => useHandler({ enabled: false }, memoryLauncher().launcher),
        expect: "disabled",
      },
      {
        runId: "ns_accept_badgrant",
        set: () => useHandler(policy, memoryLauncher().launcher, "a-different-secret"),
        expect: "grant allows a valid, unexpired start grant",
      },
      // A run started by start_workflow mints grants one level deeper; the default maxDepth is 1.
      {
        runId: "ns_wf_acceptancedepthcheck",
        set: () => useHandler(policy, memoryLauncher().launcher),
        expect: "depth",
      },
    ];
    for (const c of cases) {
      c.set();
      const { out, events } = runOnce(c.runId, [startCall({}, "rejected")], policy);
      expect((await out).status, c.runId).toBe("ok");
      expect(toolOutputs(events.events, "start_workflow")[0], c.runId).toContain(c.expect);
    }
  });

  it("a call without startWorkflow: true gets no tool, and a config without enabled refuses the option", async () => {
    const { launcher } = memoryLauncher();
    useHandler({ enabled: true }, launcher);
    const events = recorder();
    const out = await run(
      factory({ name: "no-flag", input: z.object({}) }, async () => {
        const r = await agent({ name: "plain", prompt: "Try.", output: Launched, label: "plain" });
        return r.result;
      }),
      {},
      {
        runId: "ns_accept_noflag",
        config: {
          deployment: "acceptance",
          sandbox: provider,
          harness: scriptedClaude([startCall({}, "rejected"), scripted.submit({ launched: false })]),
          artifacts: fileArtifacts(path.join(dir, "artifacts")),
        },
        journal: fileJournal(path.join(dir, "noflag")),
        events: [events.sink],
      },
    );
    expect(out.status).toBe("ok");
    expect(toolOutputs(events.events, "start_workflow")[0]).toContain("Unknown tool");

    // A usage error: it throws out of run() instead of failing the run.
    await expect(
      run(
        Launching,
        {},
        {
          runId: "ns_accept_notenabled",
          config: {
            deployment: "acceptance",
            sandbox: provider,
            harness: scriptedClaude([scripted.submit({ launched: false })]),
            artifacts: fileArtifacts(path.join(dir, "artifacts")),
          },
          journal: fileJournal(path.join(dir, "notenabled")),
        },
      ),
    ).rejects.toThrow(/startWorkflow\.enabled is not true/);
  });
});
