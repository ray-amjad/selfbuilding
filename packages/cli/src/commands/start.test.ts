import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ScriptInvalidError, type StartWorkflowReceipt } from "@selfbuilding/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, configSource, jsonLines, makeProject, type TestProject } from "../../test/helpers.js";
import { EXIT } from "../exit.js";
import { statePaths } from "../project.js";
import { readRunRecord } from "../state.js";

// The run-script package compiles scripts; here a script containing BAD is invalid and everything else compiles.
vi.mock("@selfbuilding/script", () => ({
  checkScript: async (source: string) => {
    if (source.includes("BAD")) throw new ScriptInvalidError({ reason: "no default export" });
  },
}));

let project: TestProject;
beforeEach(() => {
  project = makeProject();
  project.write("selfbuilding.config.ts", configSource());
  project.write("scripts/nightly-fix.js", "export default async (input, sb) => ({ n: input.n });\n");
});
afterEach(() => project.cleanup());

/**
 * Stands in for the detached `selfbuilding run`: records its argv, then writes the events a script run would and
 * exits, so a following `start` sees the run end.
 */
function stubCli(): string {
  const marker = path.join(project.root, "stub-argv.json");
  return project.write(
    "stub-cli.mjs",
    `import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(argv));
const runId = argv[argv.indexOf("--run-id") + 1];
const file = path.join(${JSON.stringify(path.join(project.root, ".selfbuilding", "events"))}, runId + ".jsonl");
fs.mkdirSync(path.dirname(file), { recursive: true });
const ev = (type, data, callPath = "run") => JSON.stringify({ v: 1, runId, callPath, launchId: "e", attempt: 1, seq: 0, ts: "2026-11-02T10:00:00.000Z", traceId: runId, type, level: "info", data }) + "\\n";
fs.appendFileSync(file, ev("phase", { name: "build" }) + ev("sandbox.created", { size: "small" }, "impl#1") + ev("agent.started", { agent: "ImplementSpec" }, "impl#1") + ev("agent.finished", { usage: { usd: 0.75 } }, "impl#1") + ev("run.end", { status: "ok", usage: { usd: 0.75 } }));
`,
  );
}

async function waitFor(file: string): Promise<void> {
  for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 25));
}

describe("selfbuilding start", () => {
  it("--detach --json launches the run-script factory and prints the receipt", async () => {
    const entry = stubCli();
    const r = await cli(["start", "scripts/nightly-fix.js", "--input", '{"n":3}', "--detach", "--json"], {
      cwd: project.root,
      env: { SELFBUILDING_CLI_ENTRY: entry },
    });
    expect(r.code, r.stderr).toBe(EXIT.ok);
    const receipt = jsonLines(r.stdout)[0] as StartWorkflowReceipt;
    expect(receipt).toMatchObject({ status: "started", host: "node", watch: `selfbuilding watch ${receipt.runId}` });
    expect(receipt.runId).toMatch(/^ns_wf_/);

    const record = readRunRecord(statePaths(project.root), receipt.runId);
    expect(record?.input).toMatchObject({
      name: "nightly-fix",
      input: { n: 3 },
      launchedBy: { kind: "local", user: "tester" },
      caps: { maxSandboxes: 2, allowedSizes: ["small"], budgetUsd: 10 },
    });
    await waitFor(path.join(project.root, "stub-argv.json"));
    const argv = JSON.parse(readFileSync(path.join(project.root, "stub-argv.json"), "utf8")) as string[];
    expect(argv.slice(0, 4)).toEqual(["run", record?.factoryFile, "--run-id", receipt.runId]);

    // The same script and input again converge on the same run.
    const again = await cli(["start", "scripts/nightly-fix.js", "--input", '{"n":3}', "--detach", "--json"], {
      cwd: project.root,
      env: { SELFBUILDING_CLI_ENTRY: entry },
    });
    expect(jsonLines(again.stdout)[0]).toEqual({ ...receipt, status: "exists" });
  });

  it("without --detach follows the run like watch and ends with the phase, agents, sizes and costs", async () => {
    const r = await cli(["start", "scripts/nightly-fix.js", "--name", "fix"], {
      cwd: project.root,
      env: { SELFBUILDING_CLI_ENTRY: stubCli() },
    });
    expect(r.code, r.stderr).toBe(EXIT.ok);
    expect(r.stderr).toMatch(/Started run ns_wf_\w+ on node/);
    expect(r.stderr).toContain("▸ phase build");
    expect(r.stderr).toMatch(/Workflow fix \(ns_wf_\w+\): ok, phase build, \$0\.75/);
    expect(r.stderr).toMatch(/impl#1\s+ImplementSpec\s+small\s+succeeded\s+\$0\.75/);
  });

  it("applies the guards to a local caller: a size outside allowedSizes is refused and nothing starts", async () => {
    const r = await cli(["start", "scripts/nightly-fix.js", "--size", "large", "--detach"], {
      cwd: project.root,
      env: { SELFBUILDING_CLI_ENTRY: stubCli() },
    });
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr).toContain("[workflow_guard]");
    expect(r.stderr).toContain("start_workflow refused the launch: size allows sizes small");
    expect(existsSync(path.join(project.root, ".selfbuilding", "runs"))).toBe(false);
  });

  it("honours the config's policy: a larger size and budget once allowed", async () => {
    project.write(
      "selfbuilding.config.ts",
      configSource({ extra: `startWorkflow: { allowedSizes: ["small", "medium"], maxBudgetUsd: 20 },` }),
    );
    const r = await cli(
      [
        "start",
        "scripts/nightly-fix.js",
        "--size",
        "medium",
        "--budget",
        "15",
        "--max-sandboxes",
        "1",
        "--detach",
        "--json",
      ],
      { cwd: project.root, env: { SELFBUILDING_CLI_ENTRY: stubCli() } },
    );
    expect(r.code, r.stderr).toBe(EXIT.ok);
    const receipt = jsonLines(r.stdout)[0] as StartWorkflowReceipt;
    expect(readRunRecord(statePaths(project.root), receipt.runId)?.input).toMatchObject({
      caps: { maxSandboxes: 1, allowedSizes: ["medium", "small"], budgetUsd: 15 },
    });
  });

  it("refuses an invalid script as a usage error before starting anything", async () => {
    project.write("scripts/bad.js", "BAD");
    const r = await cli(["start", "scripts/bad.js", "--detach"], {
      cwd: project.root,
      env: { SELFBUILDING_CLI_ENTRY: stubCli() },
    });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("The workflow script is invalid");
  });

  it("checks its flags", async () => {
    const run = (args: string[]) => cli(["start", ...args], { cwd: project.root });
    expect((await run(["scripts/missing.js"])).stderr).toContain("does not exist");
    expect((await run(["scripts/nightly-fix.js", "--name", "Bad Name"])).stderr).toContain("--name");
    expect((await run(["scripts/nightly-fix.js", "--host", "lambda"])).stderr).toContain("node or trigger");
    expect((await run(["scripts/nightly-fix.js", "--budget", "-1"])).stderr).toContain("--budget");
    expect((await run(["scripts/nightly-fix.js", "--input", "[1]"])).stderr).toContain("JSON object");
    expect((await run(["scripts/nightly-fix.js", "--host", "trigger"])).stderr).toContain("TRIGGER_SECRET_KEY");
  });
});
