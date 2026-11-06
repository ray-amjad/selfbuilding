// runScript inside a real run(): the sb API, the journal, replay on resume, call options and errors.
import fs from "node:fs/promises";
import path from "node:path";
import {
  fileJournal,
  launchDepthOf,
  run,
  ScriptFailedError,
  ScriptInvalidError,
  type SelfbuildingEvent,
} from "@selfbuilding/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyError, fakeAgents, runSource, tempDir } from "../test/kit.js";
import {
  checkScript,
  createScriptFactory,
  DEFAULT_SCRIPT_CAPS,
  SCRIPT_FACTORY_NAME,
  scriptRunOptions,
} from "./index.js";

let dir: string;
beforeAll(async () => {
  dir = await tempDir("sbs-script-");
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const logs = (events: SelfbuildingEvent[]) =>
  events.filter((e) => e.type === "log").map((e) => (e.data as { message: string }).message);

describe("runScript: the basics", () => {
  it("runs the default export with the input and returns its JSON value", async () => {
    const out = await runSource(
      "export default async function main(input, sb) {\n  return { doubled: input.n * 2, same: sb.input === input || sb.input.n === input.n };\n}\n",
      { dir, input: { n: 21 } },
    );
    expect(out.status).toBe("ok");
    expect(out.output).toEqual({ doubled: 42, same: true });
  });

  it("returns null for a script that returns nothing", async () => {
    const out = await runSource("export default async () => {}", { dir });
    expect(out.status).toBe("ok");
    expect(out.output).toBeNull();
  });

  it("maps sb.log, console.log and sb.phase onto events", async () => {
    const out = await runSource(
      'export default async (input, sb) => {\n  sb.phase("plan");\n  sb.log("hello");\n  sb.log("careful", "warn");\n  console.log("from", "console", 1);\n  return 1;\n}',
      { dir },
    );
    expect(out.status).toBe("ok");
    expect(logs(out.events)).toEqual(expect.arrayContaining(["hello", "careful", "from console 1"]));
    expect(out.events.some((e) => e.type === "phase" && (e.data as { name: string }).name === "plan")).toBe(true);
    const warn = out.events.find((e) => e.type === "log" && (e.data as { message: string }).message === "careful");
    expect(warn?.level).toBe("warn");
  });

  it("calls registered agents and returns their result shape", async () => {
    const fakes = fakeAgents({ Echo: { produce: (i) => ({ echoed: (i as { text: string }).text }), usd: 0.5 } });
    const out = await runSource(
      'export default async (input, sb) => {\n  const r = await sb.agents.Echo({ text: "hi" }, { label: "echo", effort: "high" });\n  return { result: r.result, usd: r.usage.usd, files: r.artifacts.files };\n}',
      { dir, script: { agents: fakes.agents } },
    );
    expect(out.status).toBe("ok");
    expect(out.output).toEqual({ result: { echoed: "hi" }, usd: 0.5, files: [] });
    expect(fakes.calls[0]?.opts).toEqual({ label: "echo", effort: "high" });
  });

  it("settled() yields { ok: false, code } instead of throwing", async () => {
    const fakes = fakeAgents({ Broken: { fail: true } });
    const out = await runSource(
      "export default async (input, sb) => {\n  const s = await sb.agents.Broken.settled({});\n  return { ok: s.ok, code: s.code, name: s.error.name };\n}",
      { dir, script: { agents: fakes.agents } },
    );
    expect(out.output).toEqual({ ok: false, code: "no_result", name: "NoResultError" });
  });

  it("an agent error the script catches carries name, message and code but no host stack", async () => {
    const fakes = fakeAgents({ Broken: { fail: true } });
    const out = await runSource(
      "export default async (input, sb) => {\n  try { await sb.agents.Broken({}); } catch (e) {\n    return { name: e.name, code: e.code, msg: e.message, hostStack: /node:|\\.ts:|node_modules/.test(String(e.stack)) };\n  }\n}",
      { dir, script: { agents: fakes.agents } },
    );
    expect(out.output).toEqual({
      name: "NoResultError",
      code: "no_result",
      msg: "Broken failed on purpose",
      hostStack: false,
    });
  });

  it("an agent error the script rethrows fails the run with the original error", async () => {
    const fakes = fakeAgents({ Broken: { fail: true } });
    const out = await runSource("export default async (input, sb) => {\n  await sb.agents.Broken({});\n}", {
      dir,
      script: { agents: fakes.agents },
    });
    expect(out.status).toBe("failed");
    expect(bodyError(out)?.code).toBe("no_result");
  });

  it("a script that throws fails with ScriptFailedError carrying the isolate's stack and line", async () => {
    const out = await runSource(
      'function inner() {\n  throw new TypeError("bad thing");\n}\nexport default async () => {\n  inner();\n}',
      { dir },
    );
    expect(out.status).toBe("failed");
    const err = bodyError(out);
    expect(err?.code).toBe("script_failed");
    expect(err?.message).toContain("TypeError: bad thing (script line 2)");
  });

  it("parallel() runs thunks concurrently and failed items become null", async () => {
    const fakes = fakeAgents({ Slow: { delayMs: 50, produce: () => "slow" }, Broken: { fail: true } });
    const started = Date.now();
    const out = await runSource(
      "export default async (input, sb) => {\n  const list = await sb.parallel([() => sb.agents.Slow({ a: 1 }), () => sb.agents.Slow({ a: 2 }), () => sb.agents.Broken({})]);\n  const rec = await sb.parallel({ x: async () => 1, y: async () => { throw new Error('no'); } });\n  return { list: list.map((r) => r && r.result), rec };\n}",
      { dir, script: { agents: fakes.agents } },
    );
    expect(out.output).toEqual({ list: ["slow", "slow", null], rec: { x: 1, y: null } });
    expect(out.status).toBe("partial");
    // Two 50 ms calls ran at once, not one after the other.
    expect(Date.now() - started).toBeLessThan(5_000);
    const parallelPaths = out.events
      .filter((e) => e.type === "error" && e.data?.primitive === "parallel")
      .map((e) => e.callPath);
    expect(parallelPaths).toEqual(["parallel#0/[2]", "parallel#1/[y]"]);
  });

  it("parallel() starts its thunks concurrently: the bridge does not serialise host calls", async () => {
    const fakes = fakeAgents({ Slow: { delayMs: 200, produce: () => "slow" } });
    const started = Date.now();
    const out = await runSource(
      "export default async (input, sb) => {\n  await sb.parallel([1, 2, 3, 4].map((n) => () => sb.agents.Slow({ n })));\n  return true;\n}",
      { dir, script: { agents: fakes.agents } },
    );
    expect(out.output).toBe(true);
    expect(Date.now() - started).toBeLessThan(700);
  });

  it("pipeline() moves items through stages, with opts and a key function", async () => {
    const out = await runSource(
      'export default async (input, sb) => {\n  const plain = await sb.pipeline([1, 2, 3], async (n) => n * 10, async (n) => (n === 20 ? null : n + 1));\n  const keyed = await sb.pipeline({ label: "keyed", key: (s) => "item-" + s, maxInFlight: 1 }, ["a", "b"], async (s, ctx) => s + ":" + ctx.key + ":" + ctx.index);\n  return { plain, keyed };\n}',
      { dir },
    );
    expect(out.output).toEqual({ plain: [11, null, 31], keyed: ["a:item-a:0", "b:item-b:1"] });
  });

  it("sb.step journals its value; sb.now, sb.random and sb.uuid are replay-stable", async () => {
    let hits = 0;
    const fakes = fakeAgents({ Count: { produce: () => ++hits } });
    const source =
      'export default async (input, sb) => {\n  const t = sb.now();\n  const r = sb.random();\n  const id = sb.uuid();\n  const s = await sb.step("compute", async () => ({ at: t, n: (await sb.agents.Count({})).result }));\n  return { t, r, id, s };\n}';
    const runId = "ns_script_replay";
    fakes.reset();
    const first = await runSource(source, { dir, runId, script: { agents: fakes.agents } });
    fakes.reset();
    const second = await runSource(source, { dir, runId, script: { agents: fakes.agents } });
    expect(first.status).toBe("ok");
    expect(second.output).toEqual(first.output);
    expect(hits).toBe(1);
    const out = first.output as { t: number; r: number; id: string };
    expect(typeof out.t).toBe("number");
    expect(out.r).toBeGreaterThanOrEqual(0);
    expect(out.r).toBeLessThan(1);
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a resume replays finished agent calls from the journal and runs the rest live", async () => {
    const fakes = fakeAgents({ A: { produce: () => "a" }, B: { produce: () => "b", failTimes: 1 } });
    const runId = "ns_script_resume";
    const source =
      "export default async (input, sb) => {\n  const a = await sb.agents.A({});\n  const b = await sb.agents.B({});\n  return [a.result, b.result];\n}";
    fakes.reset();
    const first = await runSource(source, { dir, runId, script: { agents: fakes.agents } });
    expect(first.status).toBe("failed");
    fakes.reset();
    const again = await runSource(source, { dir, runId, script: { agents: fakes.agents } });
    expect(again.status).toBe("ok");
    expect(again.output).toEqual(["a", "b"]);
    // A ran once and was replayed; B failed once and ran live again.
    expect(fakes.calls.map((c) => c.name)).toEqual(["A", "B", "B"]);
  });

  it("code after an await inside a parallel item still runs in that item's scope", async () => {
    const runId = "ns_script_scopes";
    const out = await runSource(
      'export default async (input, sb) => {\n  await sb.step("before", async () => 0);\n  const r = await sb.parallel([\n    async () => { await sb.step("first", async () => 1); await null; return sb.step("second", async () => 2); },\n    async () => { await sb.pipeline([1], async (n) => { await sb.step("deep", async () => n); return sb.step("deeper", async () => n + 1); }); return sb.step("after", async () => 3); },\n  ]);\n  return [await sb.step("last", async () => r.length), r];\n}',
      { dir, runId },
    );
    expect(out.output).toEqual([2, [2, 3]]);
    const paths: string[] = [];
    for await (const e of fileJournal(path.join(dir, "journal")).list(runId))
      if (e.kind === "step") paths.push(e.callPath);
    expect(paths.sort()).toEqual(
      [
        "before",
        "parallel#0/[0]/first",
        "parallel#0/[0]/second",
        "parallel#0/[1]/pipeline#0/[0]/stage#0/deep",
        "parallel#0/[1]/pipeline#0/[0]/stage#0/deeper",
        "parallel#0/[1]/after",
        "last",
      ].sort(),
    );
  });

  it("calls issued with Promise.all keep their source order", async () => {
    const fakes = fakeAgents({ A: { delayMs: 30, produce: () => "a" }, B: { produce: () => "b" } });
    fakes.reset();
    const out = await runSource(
      "export default async (input, sb) => {\n  const [a, b] = await Promise.all([sb.agents.A({}), sb.agents.B({})]);\n  return [a.result, b.result];\n}",
      { dir, script: { agents: fakes.agents } },
    );
    expect(out.output).toEqual(["a", "b"]);
    expect(fakes.issued).toEqual(["A", "B"]);
  });

  it("the deployed factory is named run-script and validates its input", async () => {
    const f = createScriptFactory({ agents: {}, harnesses: {}, providers: {} });
    expect(f.name).toBe(SCRIPT_FACTORY_NAME);
    expect(f.inputSchema.safeParse({ source: "x", name: "Bad Name" }).success).toBe(false);
    expect(f.inputSchema.safeParse({ source: "x", name: "ok-name", extra: 1 }).success).toBe(false);
    expect(f.inputSchema.safeParse({ source: "x", name: "ok-name", caps: { maxSandboxes: 2 } }).success).toBe(true);
    expect(f.options.concurrency?.sandboxes).toBe(DEFAULT_SCRIPT_CAPS.maxSandboxes);
    expect(f.options.budget).toBeUndefined();
    const withConfig = createScriptFactory({ agents: {}, harnesses: {}, config: { budget: { usd: 50, tokens: 9 } } });
    expect(withConfig.options.budget).toEqual({ usd: DEFAULT_SCRIPT_CAPS.budgetUsd, tokens: 9, wallClock: "4h" });
    // The node launcher builds each run's factory with the run's caps, so they bound the engine's slots and budget.
    const perRun = createScriptFactory({ caps: { maxSandboxes: 1, budgetUsd: 3 }, config: {} });
    expect(perRun.options.concurrency?.sandboxes).toBe(1);
    expect(perRun.options.budget).toEqual({ usd: 3, wallClock: "4h" });
  });

  it("records the launcher's depth for the run, so grants minted inside it nest correctly", async () => {
    const f = createScriptFactory({ agents: {}, harnesses: {}, providers: {} });
    const runId = `ns_script_depth_${Math.random().toString(36).slice(2, 10)}`;
    expect(launchDepthOf(runId)).toBe(0);
    const out = await run(
      f,
      {
        source: "export default async function main() { return 1; }",
        name: "depth-script",
        launchedBy: { kind: "agent", runId: "ns_parent", callPath: "build", depth: 2 },
      },
      { runId, journal: fileJournal(path.join(dir, "journal-depth")), config: { deployment: "test" } },
    );
    expect(out.status).toBe("ok");
    expect(launchDepthOf(runId)).toBe(2);
  });

  it("scriptRunOptions tightens the run's slots and budget from the input caps", () => {
    expect(scriptRunOptions({ caps: { maxSandboxes: 2, budgetUsd: 3, wallClock: "1h" } })).toEqual({
      concurrency: { sandboxes: 2 },
      budget: { usd: 3, wallClock: "1h" },
    });
    // Input caps never loosen the deployment's.
    expect(
      scriptRunOptions({ caps: { maxSandboxes: 9, budgetUsd: 100 } }, { config: { scripts: { budgetUsd: 5 } } }),
    ).toEqual({ concurrency: { sandboxes: 4 }, budget: { usd: 5, wallClock: "4h" } });
  });
});

describe("checkScript", () => {
  it("accepts a module with a default export function", async () => {
    await expect(checkScript("export default async function main(input, sb) { return 1; }")).resolves.toBeUndefined();
  });

  it("rejects a compile error with its line", async () => {
    const err = await checkScript("const a = 1;\nconst b = ;\nexport default async () => a;").catch((e) => e);
    expect(err).toBeInstanceOf(ScriptInvalidError);
    expect(err.line).toBe(2);
    expect(err.message).toContain("at line 2");
  });

  it("rejects a module without a default export", async () => {
    const err = await checkScript("export const main = async () => 1;").catch((e) => e);
    expect(err).toBeInstanceOf(ScriptInvalidError);
    expect(err.message).toContain("no default export");
  });

  it("rejects a default export that is not a function", async () => {
    await expect(checkScript("export default 42;")).rejects.toBeInstanceOf(ScriptInvalidError);
  });

  it("rejects imports", async () => {
    const err = await checkScript('import fs from "fs";\nexport default async () => fs;').catch((e) => e);
    expect(err).toBeInstanceOf(ScriptInvalidError);
    expect(err.message).toContain('import "fs" is not allowed');
  });

  it("rejects a banned global used at the top level", async () => {
    const err = await checkScript("const t = Date.now();\nexport default async () => t;").catch((e) => e);
    expect(err).toBeInstanceOf(ScriptInvalidError);
    expect(err.message).toContain("use sb.now()");
    expect(err.line).toBe(1);
  });

  it("does not run the default export", async () => {
    await expect(checkScript("export default async () => { while (true) {} };")).resolves.toBeUndefined();
  });

  it("a script error is not a ScriptFailedError at check time", async () => {
    const err = await checkScript("throw new Error('top');\nexport default async () => 1;").catch((e) => e);
    expect(err).toBeInstanceOf(ScriptInvalidError);
    expect(err).not.toBeInstanceOf(ScriptFailedError);
  });
});
