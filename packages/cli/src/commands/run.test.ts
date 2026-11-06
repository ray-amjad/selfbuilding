import { readFileSync } from "node:fs";
import path from "node:path";
import type { RunStatus, SelfbuildingEvent } from "@selfbuilding/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cli,
  configSource,
  event,
  FACTORY_SOURCE,
  fakeCore,
  jsonLines,
  makeProject,
  type TestProject,
} from "../../test/helpers.js";
import { EXIT } from "../exit.js";
import { statePaths } from "../project.js";
import { eventsPath, readRunRecord, writeRunRecord } from "../state.js";
import { parseInterrupted } from "./resume.js";

let project: TestProject;
beforeEach(() => {
  project = makeProject();
  project.write("selfbuilding.config.ts", configSource());
  project.write("factories/double.ts", FACTORY_SOURCE);
});
afterEach(() => project.cleanup());

const paths = () => statePaths(project.root);

describe("selfbuilding run", () => {
  it("loads the factory with jiti, runs it and prints its output", async () => {
    const core = fakeCore();
    const r = await cli(["run", "factories/double.ts", "--input", '{"n":21}', "--run-id", "r-1"], {
      cwd: project.root,
      core,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout)).toEqual({ doubled: 42 });
    expect(r.stderr).toContain("▸ phase work");
    expect(r.stderr).toContain("Run r-1 ok ($0.50)");

    const [call] = core.runs;
    expect(call?.factory.name).toBe("double");
    expect(call?.input).toEqual({ n: 21 });
    expect(call?.opts.runId).toBe("r-1");
    expect(call?.opts.config?.deployment).toBe("test-cli");
    // The CLI default journal lives under the project, not the current directory.
    expect(call?.opts.journal).toBe(core.journalFor(path.join(project.root, ".selfbuilding", "journal")));
    expect(call?.opts.signal).toBeInstanceOf(AbortSignal);
    expect(call?.opts.hitl).toBeUndefined();
  });

  it("finds the config from a subdirectory and resolves the factory from the current directory", async () => {
    const core = fakeCore();
    const r = await cli(["run", "double.ts", "--run-id", "r-sub"], { cwd: path.join(project.root, "factories"), core });
    expect(r.code).toBe(EXIT.ok);
    expect(readRunRecord(paths(), "r-sub")?.configPath).toBe(path.join(project.root, "selfbuilding.config.ts"));
  });

  it("keeps a JSONL event file per run and a run record", async () => {
    await cli(["run", "factories/double.ts", "--run-id", "r-2"], { cwd: project.root, core: fakeCore() });
    const events = jsonLines(readFileSync(eventsPath(paths(), "r-2"), "utf8")) as SelfbuildingEvent[];
    expect(events.map((e) => e.type)).toEqual(["phase", "run.end"]);
    const record = readRunRecord(paths(), "r-2");
    expect(record).toMatchObject({ runId: "r-2", status: "ok", input: {} });
    expect(record?.pid).toBeUndefined();
    expect(record?.finishedAt).toBeDefined();
    expect(project.read(".selfbuilding/runs/r-2.json")).toContain(path.join(project.root, "factories/double.ts"));
  });

  it("streams NDJSON with --json and ends with the RunOutcome", async () => {
    const r = await cli(["run", "factories/double.ts", "--json", "--run-id", "r-3", "--input", '{"n":2}'], {
      cwd: project.root,
      core: fakeCore(),
    });
    const lines = jsonLines(r.stdout) as Record<string, unknown>[];
    expect(lines.map((l) => l.type ?? "outcome")).toEqual(["phase", "run.end", "outcome"]);
    expect(lines.at(-1)).toMatchObject({ runId: "r-3", status: "ok", output: { doubled: 4 } });
    expect(lines.at(-1)).not.toHaveProperty("events");
  });

  it.each([
    ["ok", 0],
    ["failed", 1],
    ["partial", 3],
    ["budget_exhausted", 4],
    ["needs_attention", 5],
    ["waiting", 6],
    ["aborted", 7],
  ] as [RunStatus, number][])("exits for status %s with %i", async (status, code) => {
    const core = fakeCore({ run: async () => ({ status }) });
    const r = await cli(["run", "factories/double.ts"], { cwd: project.root, core });
    expect(r.code).toBe(code);
  });

  it("tells the user how to continue a parked run", async () => {
    const core = fakeCore({ run: async () => ({ status: "waiting" }) });
    const r = await cli(["run", "factories/double.ts", "--run-id", "parked"], { cwd: project.root, core });
    expect(r.stderr).toContain("selfbuilding answer parked '#1'");
    expect(r.stderr).toContain("selfbuilding resume parked");
  });

  it("reads input from a file and from stdin", async () => {
    project.write("input.json", '{"n":5}');
    const core = fakeCore();
    await cli(["run", "factories/double.ts", "--input", "@input.json"], { cwd: project.root, core });
    await cli(["run", "factories/double.ts", "--input", "-"], { cwd: project.root, core, stdinText: '{"n":7}' });
    expect(core.runs.map((c) => c.input)).toEqual([{ n: 5 }, { n: 7 }]);
  });

  it("rejects bad input, ids and exports before anything runs", async () => {
    const core = fakeCore();
    const bad = await cli(["run", "factories/double.ts", "--input", "{nope"], { cwd: project.root, core });
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.stderr).toContain("is not valid JSON");
    const id = await cli(["run", "factories/double.ts", "--run-id", "bad id"], { cwd: project.root, core });
    expect(id.code).toBe(EXIT.usage);
    const missing = await cli(["run", "factories/nope.ts"], { cwd: project.root, core });
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stderr).toContain("does not exist");
    const exp = await cli(["run", "factories/double.ts", "--export", "missing"], { cwd: project.root, core });
    expect(exp.code).toBe(EXIT.usage);
    expect(exp.stderr).toContain("Factories it exports: default, other");
    const notFactory = await cli(["run", "factories/double.ts", "--export", "notAFactory"], {
      cwd: project.root,
      core,
    });
    expect(notFactory.stderr).toContain('export "notAFactory" is not a factory');
    expect(core.runs).toHaveLength(0);
  });

  it("uses a named export with --export", async () => {
    const core = fakeCore();
    await cli(["run", "factories/double.ts", "--export", "other"], { cwd: project.root, core });
    expect(core.runs[0]?.factory.name).toBe("other");
  });

  it("passes --afk, SELFBUILDING_STRICT and the config's own sinks", async () => {
    project.write(
      "selfbuilding.config.ts",
      configSource({
        extra: `hitl: { timeout: "1h" }, events: [(e) => { (globalThis as any).__sbSeen = ((globalThis as any).__sbSeen ?? 0) + 1; }],`,
      }),
    );
    const core = fakeCore();
    await cli(["run", "factories/double.ts", "--afk"], { cwd: project.root, core, env: { SELFBUILDING_STRICT: "1" } });
    const opts = core.runs[0]?.opts;
    expect(opts?.hitl).toEqual({ timeout: "1h", mode: "afk" });
    expect(opts?.strict).toBe(true);
    expect((globalThis as { __sbSeen?: number }).__sbSeen).toBe(2);
  });

  it("runs without a config file when the factory carries its own defaults", async () => {
    project.cleanup();
    project = makeProject();
    project.write("f.ts", FACTORY_SOURCE);
    const core = fakeCore();
    const r = await cli(["run", "f.ts", "--input", '{"n":1}'], { cwd: project.root, core });
    expect(r.code).toBe(EXIT.ok);
    expect(core.runs[0]?.opts.config).toEqual({});
  });

  it("explains a config passed with --config that does not exist", async () => {
    const r = await cli(["run", "factories/double.ts", "--config", "nope.config.ts"], {
      cwd: project.root,
      core: fakeCore(),
    });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("does not exist");
  });

  it("refuses two config files in one directory", async () => {
    project.write("selfbuilding.config.mjs", "export default {};\n");
    const r = await cli(["run", "factories/double.ts"], { cwd: project.root, core: fakeCore() });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("selfbuilding.config.ts and selfbuilding.config.mjs");
  });

  it("maps usage errors from run() to exit 2 and other throws to exit 1", async () => {
    const usage = fakeCore({
      run: async () => {
        throw Object.assign(new Error('Run id "x" is bound to a different factory or input.'), {
          kind: "usage",
          code: "run_id_conflict",
        });
      },
    });
    const a = await cli(["run", "factories/double.ts"], { cwd: project.root, core: usage });
    expect(a.code).toBe(EXIT.usage);
    expect(a.stderr).toContain("bound to a different factory");
    const crash = fakeCore({
      run: async () => {
        throw new Error("disk on fire");
      },
    });
    const b = await cli(["run", "factories/double.ts", "--run-id", "r-crash"], { cwd: project.root, core: crash });
    expect(b.code).toBe(EXIT.failed);
    expect(b.stderr).toContain("disk on fire");
    expect(readRunRecord(paths(), "r-crash")?.finishedAt).toBeDefined();
  });

  it("exits 130 when interrupted before the run settles", async () => {
    const interrupt = new AbortController();
    const core = fakeCore({
      run: ({ opts }) =>
        new Promise((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve({ status: "aborted" }));
          setTimeout(() => interrupt.abort(), 5);
        }),
    });
    const r = await cli(["run", "factories/double.ts"], { cwd: project.root, core, interrupt: interrupt.signal });
    expect(r.code).toBe(EXIT.interrupted);
  });

  it("loads --env-file before evaluating the config", async () => {
    const name = "SB_TEST_RUN_ENV_FILE";
    project.write(".env.test", `${name}=from-file\n`);
    project.write(
      "selfbuilding.config.ts",
      configSource({ extra: `effort: (process.env.${name} === "from-file" ? "high" : "low") as never,` }),
    );
    const core = fakeCore();
    const env: Record<string, string | undefined> = process.env;
    try {
      await cli(["run", "factories/double.ts", "--env-file", ".env.test"], { cwd: project.root, core, env });
      expect(core.runs[0]?.opts.config?.effort).toBe("high");
    } finally {
      delete process.env[name];
    }
  });
});

describe("selfbuilding resume", () => {
  it("re-runs the same factory and input under the same run id", async () => {
    const core = fakeCore({ run: async () => ({ status: core.runs.length === 1 ? "waiting" : "ok" }) });
    const first = await cli(["run", "factories/double.ts", "--run-id", "again", "--input", '{"n":3}', "--afk"], {
      cwd: project.root,
      core,
    });
    expect(first.code).toBe(EXIT.waiting);
    const second = await cli(["resume", "again"], { cwd: project.root, core });
    expect(second.code).toBe(EXIT.ok);
    const [a, b] = core.runs;
    expect(b?.opts.runId).toBe("again");
    expect(b?.input).toEqual({ n: 3 });
    expect(b?.factory.name).toBe(a?.factory.name);
    expect(b?.opts.hitl).toMatchObject({ mode: "afk" });
    expect(readRunRecord(paths(), "again")?.status).toBe("ok");
  });

  it("passes --interrupted choices through as onInterrupted", async () => {
    const core = fakeCore();
    await cli(["run", "factories/double.ts", "--run-id", "int"], { cwd: project.root, core });
    await cli(["resume", "int", "--interrupted", "review/0=resume-session", "--interrupted", "fix=skip"], {
      cwd: project.root,
      core,
    });
    expect(core.runs[1]?.opts.onInterrupted).toEqual({ "review/0": "resume-session", fix: "skip" });
  });

  it("parses --interrupted forms", () => {
    expect(parseInterrupted([])).toBeUndefined();
    expect(parseInterrupted(["fail"])).toBe("fail");
    expect(parseInterrupted(["a=b=restore-and-rerun"])).toEqual({ "a=b": "restore-and-rerun" });
    expect(() => parseInterrupted(["skip"])).toThrow(/needs a call path/);
    expect(() => parseInterrupted(["x=maybe"])).toThrow(/not one of/);
    expect(() => parseInterrupted(["fail", "x=skip"])).toThrow(/not both/);
    expect(() => parseInterrupted(["=skip"])).toThrow(/empty/);
  });

  it("sweeps leaked sandboxes first on plain Node, and only warns when the sweep fails", async () => {
    project.write("selfbuilding.config.ts", configSource({ providerRoot: path.join(project.root, "boxes") }));
    const core = fakeCore({
      reap: async () => {
        throw new Error("provider down");
      },
    });
    await cli(["run", "factories/double.ts", "--run-id", "sw"], { cwd: project.root, core });
    const r = await cli(["resume", "sw"], { cwd: project.root, core });
    expect(r.code).toBe(EXIT.ok);
    expect(core.reaps).toHaveLength(1);
    expect(core.reaps[0]?.deployment).toBe("test-cli");
    expect(r.stderr).toContain("warn: the reaper sweep before resume failed: provider down");
  });

  it("refuses an unknown run and a run another process is still driving", async () => {
    const unknown = await cli(["resume", "ghost"], { cwd: project.root, core: fakeCore() });
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.stderr).toContain("No run ghost");

    writeRunRecord(paths(), {
      v: 1,
      runId: "busy",
      factoryFile: path.join(project.root, "factories/double.ts"),
      input: {},
      configPath: null,
      startedAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
      pid: process.pid,
    });
    const busy = await cli(["resume", "busy"], { cwd: project.root, core: fakeCore() });
    expect(busy.code).toBe(EXIT.usage);
    expect(busy.stderr).toContain(`still running in process ${process.pid}`);
  });

  it("settles as aborted when the run was cancelled while nothing was running", async () => {
    const core = fakeCore({
      run: async ({ opts }) => ({ status: opts.signal?.aborted ? "aborted" : "ok" }),
    });
    await cli(["run", "factories/double.ts", "--run-id", "c1"], { cwd: project.root, core });
    project.write(".selfbuilding/runs/c1.cancel", JSON.stringify({ reason: "stop", at: "now", by: "me" }));
    const r = await cli(["resume", "c1"], { cwd: project.root, core });
    expect(r.code).toBe(EXIT.aborted);
  });
});

describe("selfbuilding watch", () => {
  function writeEvents(runId: string, events: SelfbuildingEvent[]) {
    project.write(`.selfbuilding/events/${runId}.jsonl`, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }

  it("prints a finished run's events and exits with its status", async () => {
    writeEvents("w1", [
      event("w1", "phase", { name: "build" }, 0),
      event("w1", "log", { message: "hello" }, 1),
      event("w1", "run.end", { status: "partial" }, 2),
    ]);
    const r = await cli(["watch", "w1"], { cwd: project.root });
    expect(r.code).toBe(EXIT.partial);
    expect(r.stderr).toContain("▸ phase build");
    expect(r.stderr).toContain("hello");
    expect(r.stderr).toContain("■ run partial");
  });

  it("skips the first n events with --from and prints NDJSON with --json", async () => {
    writeEvents("w2", [
      event("w2", "phase", { name: "a" }, 0),
      event("w2", "phase", { name: "b" }, 1),
      event("w2", "run.end", { status: "ok" }, 2),
    ]);
    const r = await cli(["watch", "w2", "--from", "1", "--json"], { cwd: project.root });
    expect(r.code).toBe(EXIT.ok);
    const lines = jsonLines(r.stdout) as SelfbuildingEvent[];
    expect(lines.map((e) => e.data?.name ?? e.type)).toEqual(["b", "run.end"]);
    const bad = await cli(["watch", "w2", "--from", "-1"], { cwd: project.root });
    expect(bad.code).toBe(EXIT.usage);
  });

  it("follows a live run until it ends", async () => {
    let release: () => void = () => {};
    const core = fakeCore({
      run: ({ opts }) =>
        new Promise((resolve) => {
          const sink = opts.events?.[0];
          sink?.(event("live", "phase", { name: "first" }, 0));
          release = () => {
            sink?.(event("live", "phase", { name: "second" }, 1));
            sink?.(event("live", "run.end", { status: "needs_attention" }, 2));
            resolve({ status: "needs_attention" });
          };
        }),
    });
    const running = cli(["run", "factories/double.ts", "--run-id", "live"], { cwd: project.root, core });
    while (!readRunRecord(paths(), "live")) await new Promise((r) => setTimeout(r, 5));
    const watching = cli(["watch", "live", "--json"], { cwd: project.root });
    await new Promise((r) => setTimeout(r, 60));
    release();
    const [ran, watched] = await Promise.all([running, watching]);
    expect(ran.code).toBe(EXIT.needsAttention);
    expect(watched.code).toBe(EXIT.needsAttention);
    expect((jsonLines(watched.stdout) as SelfbuildingEvent[]).map((e) => e.data?.name ?? e.type)).toEqual([
      "first",
      "second",
      "run.end",
    ]);
  });

  it("stops when the driving process is gone, using the recorded status", async () => {
    writeEvents("w3", [event("w3", "phase", { name: "x" }, 0)]);
    writeRunRecord(paths(), {
      v: 1,
      runId: "w3",
      factoryFile: "f.ts",
      input: {},
      configPath: null,
      startedAt: "t",
      updatedAt: "t",
      status: "waiting",
      finishedAt: "t",
    });
    const r = await cli(["watch", "w3"], { cwd: project.root });
    expect(r.code).toBe(EXIT.waiting);
  });

  it("exits 130 when interrupted while following", async () => {
    writeRunRecord(paths(), {
      v: 1,
      runId: "w4",
      factoryFile: "f.ts",
      input: {},
      configPath: null,
      startedAt: "t",
      updatedAt: "t",
      pid: process.pid,
    });
    const interrupt = new AbortController();
    setTimeout(() => interrupt.abort(), 30);
    const r = await cli(["watch", "w4"], { cwd: project.root, interrupt: interrupt.signal });
    expect(r.code).toBe(EXIT.interrupted);
  });

  it("refuses an unknown run", async () => {
    const r = await cli(["watch", "nobody"], { cwd: project.root });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("No run nobody");
  });
});
