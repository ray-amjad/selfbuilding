import { type Json, type ScriptRunInput, type StartWorkflowCaller, workflowRunId } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { FACTORY_TASK_ID } from "./keys.js";
import { AGENT_LAUNCHED_TAG, triggerWorkflowLauncher } from "./launcher.js";
import type { TriggerRunView, TriggerSdk } from "./sdk.js";
import { memoryResultStore } from "./store.js";

/** The slice of the SDK the launcher calls: trigger, retrieveRun and the clock. */
function fakeTrigger() {
  const triggered: { taskId: string; payload: Json; opts: { idempotencyKey: string; tags?: string[] } }[] = [];
  const runs = new Map<string, TriggerRunView>();
  const byKey = new Map<string, string>();
  const sdk = {
    kind: "fake",
    now: () => 1_800_000_000_000,
    async trigger(taskId: string, payload: Json, opts: { idempotencyKey: string; tags?: string[] }) {
      const existing = byKey.get(opts.idempotencyKey);
      if (existing) return { id: existing };
      const id = `run_${triggered.length + 1}`;
      triggered.push({ taskId, payload, opts });
      byKey.set(opts.idempotencyKey, id);
      runs.set(id, { id, status: "EXECUTING" });
      return { id };
    },
    async retrieveRun(id: string) {
      return runs.get(id) ?? { id, status: "QUEUED" };
    },
  } as unknown as TriggerSdk;
  return { sdk, triggered, runs };
}

const caller: StartWorkflowCaller = { kind: "agent", runId: "ns_parent", callPath: "plan#1", depth: 1 };

describe("triggerWorkflowLauncher", () => {
  it("triggers the run-script factory with the fixed run id, caps, caller and tag", async () => {
    const { sdk, triggered } = fakeTrigger();
    const launcher = triggerWorkflowLauncher({
      trigger: sdk,
      store: memoryResultStore(),
      dashboardUrl: (id) => `https://cloud.example/runs/${id}`,
    });
    const receipt = await launcher.start(
      { name: "nightly", script: "export default async () => 1;", input: { a: 1 }, size: "small", maxSandboxes: 1 },
      caller,
    );
    expect(receipt).toMatchObject({ status: "started", host: "trigger", url: "https://cloud.example/runs/run_1" });
    expect(triggered).toHaveLength(1);
    const call = triggered[0];
    expect(call?.taskId).toBe(FACTORY_TASK_ID);
    expect(call?.opts).toEqual({ idempotencyKey: receipt.runId, tags: [AGENT_LAUNCHED_TAG] });
    const payload = call?.payload as unknown as { factory: string; runId: string; input: ScriptRunInput };
    expect(payload.factory).toBe("run-script");
    expect(payload.runId).toBe(receipt.runId);
    expect(payload.input).toEqual({
      source: "export default async () => 1;",
      input: { a: 1 },
      name: "nightly",
      caps: { maxSandboxes: 1, allowedSizes: ["small"], budgetUsd: 10 },
      launchedBy: caller,
    });
  });

  it("returns exists for a retry, counts live runs, and reports a finished run's status", async () => {
    const { sdk, triggered, runs } = fakeTrigger();
    const launcher = triggerWorkflowLauncher({ trigger: sdk, store: memoryResultStore() });
    const req = { name: "a", script: "export default async () => 1;", maxSandboxes: 2 };
    const first = await launcher.start(req, caller);
    expect((await launcher.start(req, caller)).status).toBe("exists");
    expect(triggered).toHaveLength(1);
    expect(await launcher.active()).toEqual({ runs: 1, sandboxes: 2 });
    expect(await launcher.status?.(first.runId)).toMatchObject({ status: "running", name: "a", launchedBy: caller });

    runs.set("run_1", { id: "run_1", status: "COMPLETED", output: { status: "ok" } });
    expect(await launcher.active()).toEqual({ runs: 0, sandboxes: 0 });
    expect(await launcher.status?.(first.runId)).toMatchObject({ status: "ok", sandboxes: 0 });
    expect(await launcher.status?.("ns_wf_nothing")).toBeNull();
  });

  it("sends the approved sandbox and budget caps as the run's engine limits", async () => {
    const { sdk, triggered } = fakeTrigger();
    const launcher = triggerWorkflowLauncher({ trigger: sdk, store: memoryResultStore() });
    await launcher.start({ name: "a", script: "export default async () => 1;", maxSandboxes: 1, budgetUsd: 3 }, caller);
    expect((triggered[0]?.payload as { limits?: unknown } | undefined)?.limits).toEqual({ sandboxes: 1, budgetUsd: 3 });
  });

  it("a launch whose trigger failed holds no run, and starting it again triggers it", async () => {
    const fake = fakeTrigger();
    let refuse = true;
    const sdk = Object.assign(Object.create(fake.sdk), {
      trigger: async (...args: Parameters<TriggerSdk["trigger"]>) => {
        if (refuse) throw new Error("429 Too Many Requests");
        return fake.sdk.trigger(...args);
      },
    }) as TriggerSdk;
    const launcher = triggerWorkflowLauncher({ trigger: sdk, store: memoryResultStore() });
    const req = { name: "a", script: "export default async () => 1;", maxSandboxes: 2 };
    await expect(launcher.start(req, caller)).rejects.toThrow(/429/);
    expect(await launcher.active()).toEqual({ runs: 0, sandboxes: 0 });
    // The handler reads this flag to send the retry back through start() instead of answering "exists".
    expect(await launcher.status?.(workflowRunId(caller, req))).toMatchObject({ status: "failed", untriggered: true });
    refuse = false;
    expect((await launcher.start(req, caller)).status).toBe("started");
    expect(fake.triggered).toHaveLength(1);
    expect(await launcher.active()).toEqual({ runs: 1, sandboxes: 2 });
    expect(await launcher.status?.(workflowRunId(caller, req))).not.toHaveProperty("untriggered");
  });

  it("a record left without a host run id stops counting once it is stale", async () => {
    const { sdk } = fakeTrigger();
    const store = memoryResultStore();
    const launcher = triggerWorkflowLauncher({ trigger: sdk, store });
    const startedAt = new Date(sdk.now() - 11 * 60_000).toISOString();
    await store.createIfAbsent("workflows/ns_wf_stale", {
      runId: "ns_wf_stale",
      name: "a",
      size: "small",
      maxSandboxes: 2,
      launchedBy: caller,
      startedAt,
    } as unknown as Json);
    expect(await launcher.active()).toEqual({ runs: 0, sandboxes: 0 });
    expect(await launcher.status?.("ns_wf_stale")).toMatchObject({ status: "failed" });
  });
});
