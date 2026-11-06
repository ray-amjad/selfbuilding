import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ScriptRunInput, StartWorkflowCaller } from "@selfbuilding/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { event, makeProject, type TestProject } from "../test/helpers.js";
import { formatWorkflowSummary, isScriptRun, nodeWorkflowLauncher, summariseRun } from "./launcher.js";
import { statePaths } from "./project.js";
import { eventsPath, readRunRecord, writeRunRecord } from "./state.js";

let project: TestProject;
beforeEach(() => {
  project = makeProject();
});
afterEach(() => project.cleanup());

const caller: StartWorkflowCaller = { kind: "agent", runId: "ns_parent", callPath: "plan#1", depth: 1 };
const req = { name: "nightly", script: "export default async () => 1;", input: { n: 1 }, size: "medium" };

function at(e: ReturnType<typeof event>, callPath: string) {
  return { ...e, callPath };
}

describe("summariseRun", () => {
  it("reports the phase, each agent with its size and cost, live sandboxes and the total", () => {
    const events = [
      event("r", "phase", { name: "build" }),
      at(event("r", "sandbox.created", { size: "medium" }), "impl#1"),
      at(event("r", "agent.started", { agent: "ImplementSpec" }), "impl#1"),
      at(event("r", "agent.finished", { usage: { usd: 1.25 } }), "impl#1"),
      event("r", "phase", { name: "review" }),
      at(event("r", "agent.started", { agent: "CodeReview" }), "review#1"),
      at(event("r", "sandbox.created", { size: "small" }), "review#1"),
      at(event("r", "sandbox.disposed", {}), "impl#1"),
    ];
    const s = summariseRun("r", events, null);
    expect(s).toMatchObject({ runId: "r", status: "running", phase: "review", sandboxes: 1, usd: 1.25 });
    expect(s.agents).toEqual([
      { callPath: "impl#1", agent: "ImplementSpec", size: "medium", status: "succeeded", usd: 1.25 },
      { callPath: "review#1", agent: "CodeReview", size: "small", status: "running" },
    ]);
    const text = formatWorkflowSummary({ ...s, name: "nightly" });
    expect(text).toContain("Workflow nightly (r): running, phase review, $1.25, 1 live sandbox");
    expect(text).toMatch(/impl#1\s+ImplementSpec\s+medium\s+succeeded\s+\$1\.25/);
    expect(text).toMatch(/review#1\s+CodeReview\s+small\s+running\s+-/);
  });

  it("takes the status and cost from run.end", () => {
    const events = [
      at(event("r", "agent.started", { agent: "Verify" }), "v#1"),
      at(event("r", "agent.failed", { code: "no_result" }), "v#1"),
      event("r", "run.end", { status: "partial", usage: { usd: 0.5 } }),
    ];
    expect(summariseRun("r", events, null)).toMatchObject({
      status: "partial",
      usd: 0.5,
      sandboxes: 0,
      agents: [{ callPath: "v#1", status: "failed" }],
    });
  });
});

describe("nodeWorkflowLauncher", () => {
  it("starts the run-script factory detached with a fixed run id, and records the run with its caller", async () => {
    const spawned: { argv: string[]; cwd: string }[] = [];
    const launcher = nodeWorkflowLauncher({
      cwd: project.root,
      configPath: path.join(project.root, "selfbuilding.config.ts"),
      cliEntry: "/opt/selfbuilding/cli.js",
      spawn: (argv, o) => {
        spawned.push({ argv, cwd: o.cwd });
        return process.pid;
      },
    });
    const receipt = await launcher.start({ ...req, afk: true }, caller);
    expect(receipt).toMatchObject({ status: "started", host: "node", watch: `selfbuilding watch ${receipt.runId}` });

    const paths = statePaths(project.root);
    const factoryFile = path.join(paths.dir, "scripts", `${receipt.runId}.mjs`);
    expect(spawned).toEqual([
      {
        cwd: project.root,
        argv: [
          "/opt/selfbuilding/cli.js",
          "run",
          factoryFile,
          "--run-id",
          receipt.runId,
          "--input",
          `@${path.join(paths.dir, "scripts", `${receipt.runId}.input.json`)}`,
          "--config",
          path.join(project.root, "selfbuilding.config.ts"),
          "--afk",
        ],
      },
    ]);
    const source = readFileSync(factoryFile, "utf8");
    expect(source).toContain("createScriptFactory");
    expect(source).toContain(`noteLaunchedBy(${JSON.stringify(receipt.runId)}, ${JSON.stringify(caller)})`);
    const input = JSON.parse(
      readFileSync(path.join(paths.dir, "scripts", `${receipt.runId}.input.json`), "utf8"),
    ) as ScriptRunInput;
    expect(input).toEqual({
      source: req.script,
      input: { n: 1 },
      name: "nightly",
      caps: { maxSandboxes: 2, allowedSizes: ["medium", "small"], budgetUsd: 10 },
      launchedBy: caller,
    });
    const record = readRunRecord(paths, receipt.runId);
    expect(isScriptRun(record)).toBe(true);
    expect(record).toMatchObject({ pid: process.pid, afk: true, factoryFile });

    // A retry converges; the running run counts toward the guards.
    expect((await launcher.start({ ...req, afk: true }, caller)).status).toBe("exists");
    expect(spawned).toHaveLength(1);
    expect(await launcher.active()).toEqual({ runs: 1, sandboxes: 0 });
    expect(await launcher.status?.(receipt.runId)).toMatchObject({
      runId: receipt.runId,
      status: "running",
      name: "nightly",
      launchedBy: caller,
    });
  });

  it("builds the run's factory with its caps and the deployment's script caps and budget", async () => {
    const launcher = nodeWorkflowLauncher({
      cwd: project.root,
      config: { scripts: { maxAgentCalls: 5 }, budget: { usd: 50, perAgent: { usd: 5 } } },
      spawn: () => process.pid,
    });
    const receipt = await launcher.start({ ...req, name: "capped", maxSandboxes: 1 }, caller);
    const source = readFileSync(path.join(statePaths(project.root).dir, "scripts", `${receipt.runId}.mjs`), "utf8");
    const args = /createScriptFactory\((.*)\);/.exec(source)?.[1];
    expect(JSON.parse(args ?? "null")).toEqual({
      caps: { maxSandboxes: 1, allowedSizes: ["medium", "small"], budgetUsd: 10 },
      config: { scripts: { maxAgentCalls: 5 }, budget: { usd: 50, perAgent: { usd: 5 } } },
    });
  });

  it("counts live sandboxes from the event stream and ignores finished runs and ordinary runs", async () => {
    const paths = statePaths(project.root);
    const launcher = nodeWorkflowLauncher({ cwd: project.root, spawn: () => process.pid });
    const live = await launcher.start(req, caller);
    const { appendFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(eventsPath(paths, live.runId)), { recursive: true });
    for (const e of [event(live.runId, "sandbox.created", {}), event(live.runId, "sandbox.created", {})]) {
      appendFileSync(eventsPath(paths, live.runId), `${JSON.stringify(e)}\n`);
    }
    const done = await launcher.start({ ...req, name: "done", input: { n: 2 } }, caller);
    const rec = readRunRecord(paths, done.runId);
    if (rec) writeRunRecord(paths, { ...rec, finishedAt: new Date().toISOString(), status: "ok" });
    const now = new Date().toISOString();
    writeRunRecord(paths, {
      v: 1,
      runId: "ns_plain",
      factoryFile: "f.ts",
      input: {},
      configPath: null,
      startedAt: now,
      updatedAt: now,
      pid: process.pid,
    });
    expect(await launcher.active()).toEqual({ runs: 1, sandboxes: 2 });
    expect(await launcher.status?.(done.runId)).toMatchObject({ status: "ok" });
    expect(await launcher.status?.("ns_wf_none")).toBeNull();
    expect(existsSync(path.join(paths.dir, "scripts"))).toBe(true);
  });
});
