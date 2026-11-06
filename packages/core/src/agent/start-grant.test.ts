import { describe, expect, it } from "vitest";
import { ConfigError, WorkflowGuardError } from "../errors/classes.js";
import { SANDBOX_PATHS } from "../types/runtime.js";
import type { StartWorkflowCaller, StartWorkflowRequest } from "../types/workflow.js";
import {
  checkStartGuards,
  launchDepthOf,
  noteLaunchedBy,
  resolveStartPolicy,
  signStartGrant,
  stageStartGrant,
  startWorkflowCaps,
  verifyStartGrant,
  workflowRunId,
} from "./start-grant.js";

const NOW = 1_800_000_000_000;
const agent: StartWorkflowCaller = { kind: "agent", runId: "ns_parent", callPath: "triage#1", depth: 1 };
const req: StartWorkflowRequest = { name: "fix", script: "export default async () => 1;" };

function refusal(fn: () => unknown): WorkflowGuardError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowGuardError);
    return error as WorkflowGuardError;
  }
  throw new Error("expected a WorkflowGuardError");
}

describe("start grants", () => {
  const payload = { runId: "ns_a", callPath: "a#1", depth: 1, exp: NOW + 60_000 };

  it("round-trip, and refuse a tampered body, a wrong secret, a bad shape and an expired grant", () => {
    const grant = signStartGrant("s3cret", payload);
    expect(grant).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyStartGrant("s3cret", grant, NOW)).toEqual(payload);
    expect(verifyStartGrant("other", grant, NOW)).toBeNull();
    expect(verifyStartGrant("s3cret", grant, NOW + 60_000)).toBeNull();
    const [, sig] = grant.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, depth: 0 })).toString("base64url");
    expect(verifyStartGrant("s3cret", `${forged}.${sig}`, NOW)).toBeNull();
    expect(verifyStartGrant("s3cret", "garbage", NOW)).toBeNull();
    expect(verifyStartGrant("s3cret", `${grant}.x`, NOW)).toBeNull();
    expect(verifyStartGrant("", grant, NOW)).toBeNull();
    expect(() => signStartGrant("", payload)).toThrow(ConfigError);
  });

  it("carry the calling agent's budget", () => {
    const grant = signStartGrant("k", { ...payload, budgetUsd: 3 });
    expect(verifyStartGrant("k", grant, NOW)?.budgetUsd).toBe(3);
  });
});

describe("start guards", () => {
  const policy = resolveStartPolicy({ enabled: true });
  const idle = { runs: 0, sandboxes: 0 };

  it("default to the spec's values", () => {
    expect(resolveStartPolicy(undefined)).toEqual({
      enabled: false,
      secretName: "SELFBUILDING_START_SECRET",
      maxConcurrentRuns: 2,
      maxConcurrentSandboxes: 4,
      maxSandboxesPerRun: 2,
      allowedSizes: ["small"],
      maxBudgetUsd: 10,
      maxScriptBytes: 262_144,
      maxDepth: 1,
      grantTtl: "2h",
    });
  });

  it("pass a request inside every limit", () => {
    expect(() => checkStartGuards(policy, req, agent, idle)).not.toThrow();
  });

  it("refuse each rule with its limit and the request", () => {
    expect(refusal(() => checkStartGuards(resolveStartPolicy({}), req, agent, idle)).rule).toBe("disabled");
    expect(refusal(() => checkStartGuards(policy, req, { ...agent, depth: 2 }, idle))).toMatchObject({
      rule: "depth",
      limit: "depth 1",
      requested: "depth 2",
    });
    const big = { ...req, script: "x".repeat(262_145) };
    expect(refusal(() => checkStartGuards(policy, big, agent, idle)).rule).toBe("script_bytes");
    expect(refusal(() => checkStartGuards(policy, { ...req, size: "large" }, agent, idle))).toMatchObject({
      rule: "size",
      requested: '"large"',
    });
    expect(refusal(() => checkStartGuards(policy, { ...req, budgetUsd: 11 }, agent, idle)).rule).toBe("budget");
    expect(refusal(() => checkStartGuards(policy, { ...req, maxSandboxes: 3 }, agent, idle)).rule).toBe(
      "sandboxes_per_run",
    );
    expect(refusal(() => checkStartGuards(policy, req, agent, { runs: 2, sandboxes: 0 })).rule).toBe("concurrent_runs");
    expect(refusal(() => checkStartGuards(policy, req, agent, { runs: 1, sandboxes: 3 })).rule).toBe(
      "concurrent_sandboxes",
    );
  });

  it("check in the spec's order: the first refusal wins", () => {
    const everything = { ...req, script: "x".repeat(300_000), size: "large", budgetUsd: 99, maxSandboxes: 9 };
    expect(
      refusal(() => checkStartGuards(policy, everything, { ...agent, depth: 5 }, { runs: 9, sandboxes: 9 })).rule,
    ).toBe("depth");
    expect(refusal(() => checkStartGuards(policy, everything, agent, { runs: 9, sandboxes: 9 })).rule).toBe(
      "script_bytes",
    );
  });

  it("hold a launch to the calling agent's own budget", () => {
    const e = refusal(() => checkStartGuards(policy, { ...req, budgetUsd: 5 }, agent, idle, { budgetUsd: 2 }));
    expect(e).toMatchObject({ rule: "budget", limit: "$2", requested: "$5" });
  });

  it("skip disabled and depth for a local caller, but apply the rest", () => {
    const local: StartWorkflowCaller = { kind: "local", user: "ray" };
    expect(() => checkStartGuards(resolveStartPolicy({}), req, local, idle)).not.toThrow();
    expect(refusal(() => checkStartGuards(resolveStartPolicy({}), { ...req, size: "medium" }, local, idle)).rule).toBe(
      "size",
    );
  });
});

describe("launched runs", () => {
  it("get a stable ns_wf_ id per caller and script, or per idempotency key", () => {
    const id = workflowRunId(agent, req);
    expect(id).toMatch(/^ns_wf_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(workflowRunId(agent, { ...req })).toBe(id);
    expect(workflowRunId(agent, { ...req, input: { a: 1 } })).not.toBe(id);
    expect(workflowRunId({ ...agent, callPath: "triage#2" }, req)).not.toBe(id);
    expect(workflowRunId(agent, { ...req, idempotencyKey: "k" })).toBe(
      workflowRunId(agent, { ...req, script: "other", idempotencyKey: "k" }),
    );
  });

  it("are capped at the approved sandboxes, budget and the sizes no bigger than the requested one", () => {
    const policy = resolveStartPolicy({ enabled: true, allowedSizes: ["small", "medium", "large"] });
    expect(startWorkflowCaps(policy, req)).toEqual({ maxSandboxes: 2, allowedSizes: ["small"], budgetUsd: 10 });
    expect(startWorkflowCaps(policy, { ...req, size: "medium", maxSandboxes: 1, budgetUsd: 4 })).toEqual({
      maxSandboxes: 1,
      allowedSizes: ["medium", "small"],
      budgetUsd: 4,
    });
    const config = { sizes: { tiny: { vcpu: 1, memoryMiB: 1024 }, wide: { vcpu: 16, memoryMiB: 4096 } } };
    expect(startWorkflowCaps(policy, { ...req, size: "medium" }, config).allowedSizes).toEqual([
      "medium",
      "small",
      "tiny",
    ]);
    expect(startWorkflowCaps(policy, req, undefined, { budgetUsd: 3 }).budgetUsd).toBe(3);
  });

  it("know their launch depth", () => {
    expect(launchDepthOf("ns_person")).toBe(0);
    expect(launchDepthOf("ns_wf_unknownelsewhere")).toBe(1);
    noteLaunchedBy("ns_wf_deep", { kind: "agent", runId: "x", callPath: "y", depth: 2 });
    expect(launchDepthOf("ns_wf_deep")).toBe(2);
  });
});

describe("stageStartGrant", () => {
  const secrets = { resolve: async (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, "k"])) };
  const call = { runId: "ns_run", callPath: "triage#1", agentName: "Triage", budgetUsd: 5 };

  it("writes a root-only grant signed with the declared secret and points the runtime at the handler", async () => {
    const staged = await stageStartGrant(
      { startWorkflow: { enabled: true, url: "https://host.example/start", grantTtl: "1h" }, secrets },
      call,
      NOW,
    );
    expect(staged.file).toMatchObject({ path: SANDBOX_PATHS.startGrant, mode: 0o600, owner: "root" });
    expect(staged.spec).toEqual({ url: "https://host.example/start" });
    expect(verifyStartGrant("k", staged.grant, NOW)).toEqual({
      runId: "ns_run",
      callPath: "triage#1",
      depth: 1,
      exp: NOW + 3_600_000,
      budgetUsd: 5,
    });
  });

  it("refuses with ConfigError when disabled, without a URL, or without a secret source", async () => {
    await expect(stageStartGrant({ secrets }, call)).rejects.toThrow(/startWorkflow.enabled/);
    await expect(stageStartGrant({ startWorkflow: { enabled: true }, secrets }, call)).rejects.toThrow(
      /startWorkflow.url/,
    );
    await expect(stageStartGrant({ startWorkflow: { enabled: true, url: "https://h" } }, call)).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});
