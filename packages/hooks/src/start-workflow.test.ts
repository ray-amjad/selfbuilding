import {
  ScriptInvalidError,
  type StartWorkflowCaller,
  type StartWorkflowReceipt,
  type StartWorkflowRequest,
  type WorkflowLauncher,
  type WorkflowRunStatus,
  workflowRunId,
} from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { createStartWorkflowHandler, signStartGrant } from "./start-workflow.js";

const NOW = 1_800_000_000_000;
const SECRET = "test-start-secret";

function fakeLauncher(active = { runs: 0, sandboxes: 0 }) {
  const started: { req: StartWorkflowRequest; caller: StartWorkflowCaller }[] = [];
  const runs = new Map<string, WorkflowRunStatus>();
  const launcher: WorkflowLauncher = {
    host: "node",
    async start(req, caller): Promise<StartWorkflowReceipt> {
      const runId = workflowRunId(caller, req);
      const existed = runs.has(runId);
      if (!existed) {
        started.push({ req, caller });
        runs.set(runId, { runId, status: "running", name: req.name, agents: [], sandboxes: 0, launchedBy: caller });
      }
      return { runId, status: existed ? "exists" : "started", host: "node", watch: `selfbuilding watch ${runId}` };
    },
    active: async () => active,
    status: async (runId) => runs.get(runId) ?? null,
  };
  return { launcher, started, runs };
}

function grant(over: Partial<{ runId: string; callPath: string; depth: number; exp: number; budgetUsd: number }> = {}) {
  return signStartGrant(SECRET, { runId: "ns_parent", callPath: "triage#1", depth: 1, exp: NOW + 60_000, ...over });
}

function post(body: unknown, g: string | null = grant()): Request {
  return new Request("https://host.example/start-workflow", {
    method: "POST",
    headers: { "content-type": "application/json", ...(g ? { authorization: `Bearer ${g}` } : {}) },
    body: JSON.stringify(body),
  });
}

const script = "export default async (input, sb) => ({ ok: true });";

describe("createStartWorkflowHandler", () => {
  const enabled = { enabled: true, allowedSizes: ["small", "medium"] };

  it("launches with capped options, answers the receipt and posts one notify message", async () => {
    const { launcher, started } = fakeLauncher();
    const notes: string[] = [];
    const checked: string[] = [];
    const handler = createStartWorkflowHandler({
      secret: SECRET,
      launcher,
      policy: enabled,
      now: () => NOW,
      checkScript: async (s) => {
        checked.push(s);
      },
      notify: async (text) => {
        notes.push(text);
      },
    });
    const res = await handler(post({ name: "fix-it", script, size: "medium" }));
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as StartWorkflowReceipt;
    expect(receipt).toMatchObject({ status: "started", host: "node" });
    expect(receipt.runId).toMatch(/^ns_wf_/);
    expect(receipt.watch).toBe(`selfbuilding watch ${receipt.runId}`);
    expect(checked).toEqual([script]);
    expect(started).toHaveLength(1);
    expect(started[0]?.req).toMatchObject({ name: "fix-it", size: "medium", maxSandboxes: 2, budgetUsd: 10 });
    expect(started[0]?.caller).toEqual({ kind: "agent", runId: "ns_parent", callPath: "triage#1", depth: 1 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Workflow "fix-it" started as');
    expect(notes[0]).toContain("ns_parent (triage#1)");
  });

  it("converges a retried call on the same run", async () => {
    const { launcher, started } = fakeLauncher();
    const handler = createStartWorkflowHandler({ secret: SECRET, launcher, policy: enabled, now: () => NOW });
    const first = (await (await handler(post({ name: "a", script }))).json()) as StartWorkflowReceipt;
    const again = (await (await handler(post({ name: "a", script }))).json()) as StartWorkflowReceipt;
    expect(again).toEqual({ ...first, status: "exists" });
    expect(started).toHaveLength(1);
  });

  it("refuses each guard once, with the right HTTP status and a WorkflowGuardError body", async () => {
    const cases: { name: string; status: number; rule: string; make: () => Promise<Response> }[] = [
      {
        name: "disabled",
        status: 403,
        rule: "disabled",
        make: () =>
          createStartWorkflowHandler({ secret: SECRET, launcher: fakeLauncher().launcher, policy: {}, now: () => NOW })(
            post({ name: "a", script }),
          ),
      },
      ...[
        null,
        "nope.nope",
        grant({ exp: NOW - 1 }),
        signStartGrant("other", { runId: "r", callPath: "c", depth: 1, exp: NOW + 1 }),
      ].map((g) => ({
        name: `grant ${g}`,
        status: 401,
        rule: "grant",
        make: () =>
          createStartWorkflowHandler({
            secret: SECRET,
            launcher: fakeLauncher().launcher,
            policy: enabled,
            now: () => NOW,
          })(post({ name: "a", script }, g)),
      })),
    ];
    const guarded = (body: object, g = grant(), active = { runs: 0, sandboxes: 0 }) =>
      createStartWorkflowHandler({
        secret: SECRET,
        launcher: fakeLauncher(active).launcher,
        policy: enabled,
        now: () => NOW,
      })(post({ name: "a", script, ...body }, g));
    cases.push(
      { name: "depth", status: 403, rule: "depth", make: () => guarded({}, grant({ depth: 2 })) },
      { name: "script_bytes", status: 403, rule: "script_bytes", make: () => guarded({ script: "x".repeat(262_145) }) },
      { name: "size", status: 403, rule: "size", make: () => guarded({ size: "large" }) },
      { name: "budget", status: 403, rule: "budget", make: () => guarded({ budgetUsd: 50 }) },
      {
        name: "agent budget",
        status: 403,
        rule: "budget",
        make: () => guarded({ budgetUsd: 3 }, grant({ budgetUsd: 2 })),
      },
      { name: "sandboxes_per_run", status: 403, rule: "sandboxes_per_run", make: () => guarded({ maxSandboxes: 3 }) },
      {
        name: "concurrent_runs",
        status: 403,
        rule: "concurrent_runs",
        make: () => guarded({}, grant(), { runs: 2, sandboxes: 0 }),
      },
      {
        name: "concurrent_sandboxes",
        status: 403,
        rule: "concurrent_sandboxes",
        make: () => guarded({}, grant(), { runs: 0, sandboxes: 3 }),
      },
    );
    for (const c of cases) {
      const res = await c.make();
      expect(res.status, c.name).toBe(c.status);
      const body = (await res.json()) as { error: { code: string; details: { rule: string }; message: string } };
      expect(body.error, c.name).toMatchObject({ code: "workflow_guard", details: { rule: c.rule } });
      expect(body.error.message, c.name).toContain("start_workflow refused the launch");
    }
  });

  it("answers 400 with the ScriptInvalidError when the script does not compile", async () => {
    const { launcher, started } = fakeLauncher();
    const handler = createStartWorkflowHandler({
      secret: SECRET,
      launcher: {
        ...launcher,
        checkScript: async () => {
          throw new ScriptInvalidError({ reason: "no default export" });
        },
      },
      policy: enabled,
      now: () => NOW,
    });
    const res = await handler(post({ name: "a", script: "nope" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("script_invalid");
    expect(started).toEqual([]);
  });

  it("reads the status of a run this run launched, and nobody else's", async () => {
    const { launcher, runs } = fakeLauncher();
    const handler = createStartWorkflowHandler({ secret: SECRET, launcher, policy: enabled, now: () => NOW });
    const receipt = (await (await handler(post({ name: "a", script }))).json()) as StartWorkflowReceipt;
    const get = (runId: string, g = grant()) =>
      handler(
        new Request(`https://host.example/start-workflow?runId=${runId}`, {
          headers: { authorization: `Bearer ${g}` },
        }),
      );
    const mine = await get(receipt.runId);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ runId: receipt.runId, status: "running", name: "a" });
    expect((await get(receipt.runId, grant({ runId: "ns_stranger" }))).status).toBe(404);
    expect((await get("ns_wf_missing")).status).toBe(404);
    expect(runs.size).toBe(1);
  });

  it("answers 404 to every grant for a run launched locally or with no recorded caller (§7.1 #1)", async () => {
    const { launcher, runs } = fakeLauncher();
    runs.set("ns_local", {
      runId: "ns_local",
      status: "running",
      agents: [],
      sandboxes: 0,
      launchedBy: { kind: "local", user: "someone" },
    });
    runs.set("ns_anon", { runId: "ns_anon", status: "running", agents: [], sandboxes: 0 });
    const handler = createStartWorkflowHandler({ secret: SECRET, launcher, policy: enabled, now: () => NOW });
    for (const runId of ["ns_local", "ns_anon"]) {
      for (const g of [grant(), grant({ runId: "ns_local" }), grant({ runId: "ns_anon" })]) {
        const res = await handler(
          new Request(`https://host.example/start-workflow?runId=${runId}`, {
            headers: { authorization: `Bearer ${g}` },
          }),
        );
        expect(res.status, runId).toBe(404);
      }
    }
  });

  it("answers an existing run's receipt without calling start or applying the new options (§7.1 #2)", async () => {
    const { launcher, started } = fakeLauncher();
    let starts = 0;
    let checks = 0;
    const counting: WorkflowLauncher = {
      ...launcher,
      start: async (req, caller) => {
        starts++;
        return launcher.start(req, caller);
      },
    };
    const notes: string[] = [];
    const handler = createStartWorkflowHandler({
      secret: SECRET,
      launcher: counting,
      policy: enabled,
      now: () => NOW,
      checkScript: async () => {
        checks++;
      },
      notify: async (text) => {
        notes.push(text);
      },
    });
    const first = (await (
      await handler(post({ name: "a", script, size: "small", idempotencyKey: "k1" }))
    ).json()) as StartWorkflowReceipt;
    const res = await handler(
      post({ name: "a", script: "nope", size: "medium", maxSandboxes: 1, idempotencyKey: "k1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...first, status: "exists" });
    expect(starts).toBe(1);
    expect(checks).toBe(1);
    expect(started).toHaveLength(1);
    expect(started[0]?.req).toMatchObject({ size: "small", script });
    expect(notes[1]).toContain("already running as");
    expect(notes[1]).not.toContain("medium");
  });

  it("sends a retry of a launch that never reached its host back through start, even at the cap", async () => {
    const { launcher, started, runs } = fakeLauncher({ runs: 1, sandboxes: 2 });
    const policy = { ...enabled, maxConcurrentRuns: 1 };
    const req = { name: "a", script, size: "small" as const, idempotencyKey: "k1" };
    const runId = workflowRunId({ kind: "agent", runId: "ns_parent", callPath: "triage#1", depth: 1 }, req);
    // What the trigger launcher reports after trigger() threw: a failed record with no host run.
    runs.set(runId, { runId, status: "running", agents: [], sandboxes: 2, untriggered: true });
    let starts = 0;
    const handler = createStartWorkflowHandler({
      secret: SECRET,
      launcher: {
        ...launcher,
        start: async (r, c) => {
          starts++;
          runs.delete(runId);
          return launcher.start(r, c);
        },
      },
      policy,
      now: () => NOW,
    });
    const res = await handler(post(req));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId, status: "started" });
    expect(starts).toBe(1);
    expect(started).toHaveLength(1);
  });
});
