import path from "node:path";
import type { ReapReport, SandboxRef } from "@selfbuilding/core";
import { type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cli,
  configSource,
  DEPLOYMENT,
  FACTORY_SOURCE,
  fakeCore,
  jsonLines,
  type MemAskStore,
  makeProject,
  type TestProject,
} from "../../test/helpers.js";
import { EXIT } from "../exit.js";
import { statePaths } from "../project.js";
import { readCancelRequest, readRunRecord } from "../state.js";
import type { CancelReport } from "./cancel.js";

let project: TestProject;
let primary: TmpdirProvider;
let second: TmpdirProvider;
let primaryRoot: string;
let secondRoot: string;

beforeEach(() => {
  project = makeProject();
  primaryRoot = path.join(project.root, "boxes");
  secondRoot = path.join(project.root, "boxes2");
  // The config builds its own providers on the same roots, as a second process talking to one vendor would.
  primary = tmpdirProvider({ root: primaryRoot });
  second = tmpdirProvider({ root: secondRoot, id: "second" });
  project.write("selfbuilding.config.ts", configSource({ providerRoot: primaryRoot, secondRoot }));
  project.write("factories/double.ts", FACTORY_SOURCE);
});
afterEach(async () => {
  await primary.close();
  await second.close();
  project.cleanup();
});

async function box(provider: TmpdirProvider, runId: string, scope: string): Promise<SandboxRef> {
  const { handle } = await provider.openOrCreate(
    { runId, scope, deployment: DEPLOYMENT },
    {
      image: { name: "selfbuilding-base", ref: "selfbuilding/base:test", version: "0.0.0-test" },
      env: {},
      lifetimeMs: 600_000,
      onExpire: "kill",
      labels: {
        "selfbuilding.deployment": DEPLOYMENT,
        "selfbuilding.run": runId,
        "selfbuilding.name": `${runId}-${scope}`,
      },
    },
  );
  return handle.ref;
}

async function live(provider: TmpdirProvider, runId: string): Promise<SandboxRef[]> {
  const out: SandboxRef[] = [];
  for await (const ref of provider.list({ deployment: DEPLOYMENT, runId })) out.push(ref);
  return out;
}

describe("selfbuilding cancel", () => {
  it("kills the run's sandboxes on every configured provider and nobody else's", async () => {
    await box(primary, "target", "build");
    await box(primary, "target", "build/fork[0]");
    await box(second, "target", "review");
    await box(primary, "bystander", "build");

    const r = await cli(["cancel", "target", "--json"], { cwd: project.root, core: fakeCore() });
    expect(r.code).toBe(EXIT.ok);
    const [report] = jsonLines(r.stdout) as [CancelReport];
    expect(report).toMatchObject({ runId: "target", killed: 3, alreadyGone: 0, listingFailed: [], killFailed: [] });
    expect(await live(primary, "target")).toEqual([]);
    expect(await live(second, "target")).toEqual([]);
    expect(await live(primary, "bystander")).toHaveLength(1);
    expect(readCancelRequest(statePaths(project.root), "target")).toMatchObject({
      reason: "cancelled from the CLI",
      by: "tester",
    });
  });

  it("says so when a provider listing failed instead of reporting 0 killed", async () => {
    await box(primary, "target", "build");
    // The fault goes on the config's own provider instance, the one the CLI lists through.
    project.write(
      "selfbuilding.config.ts",
      configSource({ secondRoot, extra: "sandbox: flaky," }).replace(
        "export default",
        `const flaky = tmpdirProvider({ root: ${JSON.stringify(primaryRoot)} });
flaky.faults.inject("503", "list", { times: 100 });
export default`,
      ),
    );
    const r = await cli(["cancel", "target", "--reason", "wrong spec"], { cwd: project.root, core: fakeCore() });
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr).toContain("Could not list sandboxes on tmpdir");
    expect(r.stderr).toContain("the count above does not cover it");
    expect(await live(primary, "target")).toHaveLength(1);
    expect(readCancelRequest(statePaths(project.root), "target")?.reason).toBe("wrong spec");
  });

  it("counts sandboxes that are already gone", async () => {
    const ref = await box(primary, "target", "build");
    primary.ghost(ref, "not-found");
    const r = await cli(["cancel", "target", "--json"], { cwd: project.root, core: fakeCore() });
    const [report] = jsonLines(r.stdout) as [CancelReport];
    expect(report.killed + report.alreadyGone).toBe(1);
  });

  it("stops a run that is still being driven, then sweeps", async () => {
    await box(primary, "driven", "build");
    const core = fakeCore({
      run: ({ opts }) =>
        new Promise((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve({ status: "aborted" }));
        }),
    });
    const running = cli(["run", "factories/double.ts", "--run-id", "driven"], { cwd: project.root, core });
    const paths = statePaths(project.root);
    while (!readRunRecord(paths, "driven")?.pid) await new Promise((r) => setTimeout(r, 5));

    const r = await cli(["cancel", "driven", "--json", "--wait", "5s"], { cwd: project.root, core });
    const [report] = jsonLines(r.stdout) as [CancelReport];
    expect(report.process).toEqual({ pid: process.pid, stopped: true });
    expect(report.killed).toBe(1);
    expect((await running).code).toBe(EXIT.aborted);
    expect(readRunRecord(paths, "driven")?.status).toBe("aborted");
  });

  it("cancels the run's open asks and marks a parked run aborted", async () => {
    const core = fakeCore({ run: async () => ({ status: "waiting" }) });
    await cli(["run", "factories/double.ts", "--run-id", "parked"], { cwd: project.root, core });
    const asks = core.journalFor(statePaths(project.root).journal).asks as MemAskStore;
    asks.add({ askId: "a1", runId: "parked", ordinal: 1, spec: { question: "Merge?" } });
    asks.add({ askId: "a2", runId: "other", ordinal: 1, spec: { question: "Other?" } });

    const r = await cli(["cancel", "parked"], { cwd: project.root, core });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain("Cancelled 1 open ask.");
    expect(asks.records.get("a1")?.status).toBe("cancelled");
    expect(asks.records.get("a2")?.status).toBe("open");
    expect(readRunRecord(statePaths(project.root), "parked")?.status).toBe("aborted");
  });

  it("needs a config", async () => {
    project.cleanup();
    project = makeProject();
    const r = await cli(["cancel", "x"], { cwd: project.root, core: fakeCore() });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("Run selfbuilding init");
  });
});

describe("selfbuilding reap", () => {
  const report = (over: Partial<ReapReport> = {}): ReapReport => ({
    killed: 0,
    parked: 0,
    held: 0,
    leaked: 0,
    errors: [],
    decisions: [],
    ...over,
  });

  it("sweeps every configured provider with the project's journal and ask store", async () => {
    const ref = await box(primary, "old", "build");
    const core = fakeCore({
      reap: async () =>
        report({
          killed: 1,
          held: 1,
          decisions: [
            { sandbox: ref, action: "kill", reason: "run-terminal" },
            { sandbox: ref, action: "hold", reason: "owner-unknown" },
          ],
        }),
    });
    const r = await cli(["reap"], { cwd: project.root, core });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain("killed 1, parked 0, held 1; 0 leaked.");
    expect(r.stderr).toContain("kill tmpdir/old-build [run-terminal]");
    expect(r.stderr).toContain("skip [owner-unknown] tmpdir/old-build");
    const [opts] = core.reaps;
    expect(opts?.providers.map((p) => p.id)).toEqual(["tmpdir", "second"]);
    expect(opts?.deployment).toBe(DEPLOYMENT);
    expect(opts?.journal).toBe(core.journalFor(statePaths(project.root).journal));
    expect(opts?.asks).toBe(opts?.journal.asks);
    expect(opts?.dryRun).toBeUndefined();
  });

  it("filters with --provider, passes --dry-run and prints JSON", async () => {
    const core = fakeCore();
    const r = await cli(["reap", "--provider", "second", "--dry-run", "--json"], { cwd: project.root, core });
    expect(r.code).toBe(EXIT.ok);
    expect(core.reaps[0]?.providers.map((p) => p.id)).toEqual(["second"]);
    expect(core.reaps[0]?.dryRun).toBe(true);
    expect(jsonLines(r.stdout)).toEqual([report()]);
  });

  it("rejects a provider that is not configured", async () => {
    const r = await cli(["reap", "--provider", "e2b"], { cwd: project.root, core: fakeCore() });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("Configured providers: tmpdir, second");
  });

  it("exits 1 when a provider could not be listed", async () => {
    const core = fakeCore({
      reap: async () => report({ errors: [{ provider: "second", code: "sandbox_unavailable", message: "503" }] }),
    });
    const r = await cli(["reap"], { cwd: project.root, core });
    expect(r.code).toBe(EXIT.failed);
    expect(r.stderr).toContain("Could not sweep second (sandbox_unavailable): 503. Its sandboxes were not counted.");
  });

  it("sweeps again --every interval until interrupted, surviving a failed sweep", async () => {
    const interrupt = new AbortController();
    let n = 0;
    const core = fakeCore({
      reap: async () => {
        n++;
        if (n === 2) throw new Error("blip");
        if (n === 3) interrupt.abort();
        return report();
      },
    });
    const r = await cli(["reap", "--every", "10ms"], { cwd: project.root, core, interrupt: interrupt.signal });
    expect(n).toBe(3);
    expect(r.stderr).toContain("Sweep failed: blip");
    expect(r.code).toBe(EXIT.ok);
  });

  it("refuses a journal without an ask store, and a config with no provider", async () => {
    const noAsks = await cli(["reap"], { cwd: project.root, core: fakeCore({ asks: false }) });
    expect(noAsks.code).toBe(EXIT.usage);
    expect(noAsks.stderr).toContain("no ask store");

    project.write("selfbuilding.config.ts", configSource());
    const none = await cli(["reap"], { cwd: project.root, core: fakeCore() });
    expect(none.code).toBe(EXIT.usage);
    expect(none.stderr).toContain("No sandbox provider to sweep");
  });
});
