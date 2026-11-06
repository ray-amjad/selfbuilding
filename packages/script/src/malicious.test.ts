// Scripts that try to escape: reach host objects, pollute prototypes across the boundary, break determinism,
// tamper with the bridge, or exhaust the host. None of it may affect the host; each fails with a typed error.
import fs from "node:fs/promises";
import { ScriptInvalidError } from "@selfbuilding/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyError, fakeAgents, runSource, tempDir } from "../test/kit.js";
import { checkScript } from "./index.js";

let dir: string;
beforeAll(async () => {
  dir = await tempDir("sbs-evil-");
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** ScriptInvalidError is a usage error: run() throws it instead of resolving with an outcome. */
async function expectInvalid(running: Promise<unknown>, text: string, line?: number): Promise<ScriptInvalidError> {
  const err = await running.then(
    (out) => {
      throw new Error(`expected ScriptInvalidError, the run ended ${JSON.stringify(bodyError(out as never) ?? out)}`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ScriptInvalidError);
  const invalid = err as ScriptInvalidError;
  expect(invalid.message).toContain(text);
  if (line !== undefined) expect(invalid.line).toBe(line);
  return invalid;
}

describe("malicious scripts: no host objects are reachable", () => {
  it("has no process, require, module, fetch, timers or Node globals", async () => {
    const out = await runSource(
      'export default async () => ["process", "Buffer", "module", "exports", "global", "__dirname", "performance", "TextEncoder", "WebAssembly", "XMLHttpRequest", "WeakRef", "FinalizationRegistry", "std", "os"].filter((k) => typeof globalThis[k] !== "undefined");',
      { dir },
    );
    expect(out.status).toBe("ok");
    expect(out.output).toEqual([]);
  });

  it("cannot climb from sb functions to a host Function constructor", async () => {
    const out = runSource(
      'export default async (input, sb) => {\n  const F = sb.log.constructor;\n  return F("return typeof process")();\n}',
      { dir },
    );
    await expectInvalid(out, "the Function constructor is not available", 3);
  });

  it("cannot reach a constructor through async or generator functions either", async () => {
    for (const expr of [
      "(async () => {}).constructor",
      "(function* () {}).constructor",
      "(async function* () {}).constructor",
      "Object.getPrototypeOf(function () {}).constructor",
    ]) {
      const out = runSource(`export default async () => {\n  return (${expr})("return 1")();\n}`, { dir });
      await expectInvalid(out, "the Function constructor is not available", 2);
    }
  });

  it("sb and its members are frozen", async () => {
    const out = await runSource(
      'export default async (input, sb) => {\n  const tries = [() => { sb.agents = 1; }, () => { sb.log = null; }, () => { sb.extra = 1; }, () => { sb.agent.settled = null; }];\n  return tries.map((t) => { try { t(); return "changed"; } catch (e) { return e.name; } });\n}',
      { dir },
    );
    expect(out.output).toEqual(["TypeError", "TypeError", "TypeError", "TypeError"]);
  });

  it("a host error delivered to the script has no host stack, path or prototype", async () => {
    const fakes = fakeAgents({ Broken: { fail: true } });
    const out = await runSource(
      "export default async (input, sb) => {\n  try { await sb.agents.Broken({}); } catch (e) {\n    return { proto: Object.getPrototypeOf(e) === Error.prototype, keys: Object.keys(e).sort(), stack: String(e.stack) };\n  }\n}",
      { dir, script: { agents: fakes.agents } },
    );
    const value = out.output as { proto: boolean; keys: string[]; stack: string };
    expect(value.proto).toBe(true);
    expect(value.stack).not.toMatch(/\/Users|node_modules|\.ts:|node:/);
  });

  it("an unknown agent name is ScriptInvalidError with its line", async () => {
    const out = runSource("export default async (input, sb) => {\n  await sb.agents.Nope({});\n}", { dir });
    await expectInvalid(out, 'there is no agent named "Nope"', 2);
  });

  it("an unknown call option is ScriptInvalidError with its line", async () => {
    const fakes = fakeAgents({ A: {} });
    const out = runSource(
      'export default async (input, sb) => {\n  const x = 1;\n  await sb.agents.A({}, { secrets: ["GITHUB_TOKEN"] });\n}',
      { dir, script: { agents: fakes.agents } },
    );
    await expectInvalid(out, 'option "secrets" is not supported', 3);
    expect(fakes.calls).toHaveLength(0);
  });

  it("call options the host does not allow (config, signal, hooks) are refused", async () => {
    const fakes = fakeAgents({ A: {} });
    for (const key of ["config", "signal", "mcpServers", "startWorkflow", "requireIsolation", "lifecycle"]) {
      const out = runSource(`export default async (input, sb) => sb.agents.A({}, { ${key}: {} });`, {
        dir,
        script: { agents: fakes.agents },
      });
      await expectInvalid(out, `option "${key}" is not supported`);
    }
  });

  it("a forged sandbox handle is refused", async () => {
    const fakes = fakeAgents({ A: {} });
    const out = runSource(
      "export default async (input, sb) => sb.agents.A({}, { sandbox: { $sandbox: 99, id: 'forged' } });",
      { dir, script: { agents: fakes.agents } },
    );
    await expectInvalid(out, "not a sandbox handle");
  });

  it("an unregistered harness or provider name is refused", async () => {
    const fakes = fakeAgents({ A: {} });
    let out = runSource('export default async (input, sb) => sb.agents.A({}, { harness: "evil" });', {
      dir,
      script: { agents: fakes.agents },
    });
    await expectInvalid(out, 'no harness named "evil"');
    out = runSource('export default async (input, sb) => sb.sandbox({ provider: "elsewhere" });', { dir });
    await expectInvalid(out, 'no provider named "elsewhere"');
  });
});

describe("malicious scripts: prototype pollution stays inside the isolate", () => {
  it("polluting Object.prototype in the isolate does not reach host objects", async () => {
    const out = await runSource(
      'export default async (input, sb) => {\n  Object.prototype.polluted = "yes";\n  Array.prototype.polluted = "yes";\n  return { seen: ({}).polluted };\n}',
      { dir },
    );
    expect(out.output).toEqual({ seen: "yes" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a __proto__ key crossing to the host is dropped, so no host object is re-prototyped", async () => {
    const fakes = fakeAgents({ A: { produce: (i) => i as never } });
    const out = await runSource(
      'export default async (input, sb) => {\n  const evil = JSON.parse(\'{"__proto__": {"isAdmin": true}, "ok": 1}\');\n  const r = await sb.agents.A(evil);\n  return { returned: JSON.parse(\'{"__proto__": {"isAdmin": true}, "fine": 2}\'), echoed: r.result };\n}',
      { dir, script: { agents: fakes.agents } },
    );
    expect(out.status).toBe("ok");
    const input = fakes.calls[0]?.input as Record<string, unknown>;
    expect(input).toEqual({ ok: 1 });
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    expect((input as { isAdmin?: boolean }).isAdmin).toBeUndefined();
    expect(Object.hasOwn(out.output as object, "__proto__")).toBe(false);
    expect((out.output as { returned: Record<string, unknown> }).returned).toEqual({ fine: 2 });
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it("replacing JSON, Promise.prototype.then and Map methods breaks only the script, never the bridge", async () => {
    const fakes = fakeAgents({ A: { produce: () => "from host" } });
    const out = await runSource(
      'export default async (input, sb) => {\n  JSON.stringify = () => "{}";\n  JSON.parse = () => ({ hijacked: true });\n  Promise.prototype.then = function () { return this; };\n  Map.prototype.set = () => { throw new Error("no"); };\n  WeakMap.prototype.get = () => 1;\n  Object.defineProperty(Object.prototype, "resolve", { get() { throw new Error("trap"); } });\n  const r = await sb.agents.A({ q: 1 });\n  return r.result;\n}',
      { dir, script: { agents: fakes.agents } },
    );
    expect(out.status).toBe("ok");
    expect(out.output).toBe("from host");
    expect(fakes.calls[0]?.input).toEqual({ q: 1 });
  });

  it("a toJSON or getter on a value sent to the host runs inside the isolate, under its limits", async () => {
    const fakes = fakeAgents({ A: { produce: (i) => i as never } });
    const out = await runSource(
      "export default async (input, sb) => {\n  const sneaky = { get x() { return typeof process; }, toJSON() { return { y: typeof globalThis.process }; } };\n  return (await sb.agents.A(sneaky)).result;\n}",
      { dir, script: { agents: fakes.agents } },
    );
    expect(out.output).toEqual({ y: "undefined" });
  });

  it("a value with a cycle is a plain script error, not a host crash", async () => {
    const fakes = fakeAgents({ A: {} });
    const out = await runSource(
      "export default async (input, sb) => {\n  const a = {}; a.self = a;\n  await sb.agents.A(a);\n}",
      { dir, script: { agents: fakes.agents } },
    );
    expect(out.status).toBe("failed");
    expect(bodyError(out)?.code).toBe("script_failed");
    expect(fakes.calls).toHaveLength(0);
  });

  it("a value over 1 MiB is refused at the crossing", async () => {
    const fakes = fakeAgents({ A: {} });
    const out = runSource(
      'export default async (input, sb) => {\n  await sb.agents.A({ blob: "z".repeat(2 * 1024 * 1024) });\n}',
      { dir, script: { agents: fakes.agents } },
    );
    await expectInvalid(out, "capped at 1 MiB", 2);
    expect(fakes.calls).toHaveLength(0);
  });
});

describe("malicious scripts: determinism cannot be broken", () => {
  const cases: [string, string, string][] = [
    ["Date.now()", "Date.now()", "use sb.now()"],
    ["new Date()", "new Date()", "use new Date(sb.now())"],
    ["Date()", "Date()", "use new Date(sb.now()).toString()"],
    ["Math.random()", "Math.random()", "use sb.random()"],
    ['eval("1 + 1")', "eval", "use plain code"],
    ["setTimeout(() => {}, 10)", "setTimeout", "no timers"],
    ["setInterval(() => {}, 10)", "setInterval", "no timers"],
    ['fetch("https://example.com")', "fetch", "no network"],
    ['require("fs")', "require", "cannot import"],
    ['Function("return 1")()', "the Function constructor", "plain functions"],
  ];
  for (const [expr, what, use] of cases) {
    it(`${what} throws ScriptInvalidError naming the replacement, with the line`, async () => {
      const out = runSource(`export default async () => {\n  const ok = 1;\n  return ${expr};\n}`, { dir });
      const err = await expectInvalid(out, `${what} is not available in a workflow script`, 3);
      expect(err.message).toContain(use);
    });
  }

  it("catching a banned call does not let the script carry on", async () => {
    const out = runSource(
      'export default async () => {\n  let t;\n  try { t = Date.now(); } catch (e) { t = 0; }\n  return "continued " + t;\n}',
      { dir },
    );
    await expectInvalid(out, "Date.now() is not available", 3);
  });

  it("dates from an explicit time still work", async () => {
    const out = await runSource(
      "export default async (input, sb) => {\n  const d = new Date(0);\n  return { iso: d.toISOString(), utc: Date.UTC(2020, 0, 1), parsed: Date.parse('2020-01-01T00:00:00Z'), isDate: d instanceof Date };\n}",
      { dir },
    );
    expect(out.output).toEqual({
      iso: "1970-01-01T00:00:00.000Z",
      utc: 1577836800000,
      parsed: 1577836800000,
      isDate: true,
    });
  });

  it("the original Date cannot be recovered from a date's constructor", async () => {
    const out = runSource("export default async () => {\n  const D = new Date(0).constructor;\n  return D.now();\n}", {
      dir,
    });
    await expectInvalid(out, "Date.now() is not available", 3);
  });

  it("a static import is refused at load time", async () => {
    const out = runSource('import { x } from "node:fs";\nexport default async () => x;', { dir });
    await expectInvalid(out, 'import "node:fs" is not allowed');
  });

  it("a dynamic import is refused even when the script catches it", async () => {
    const out = runSource(
      'export default async () => {\n  try { await import("node:child_process"); } catch (e) {}\n  return "continued";\n}',
      { dir },
    );
    await expectInvalid(out, 'import "node:child_process" is not allowed');
  });
});

describe("malicious scripts: resource exhaustion", () => {
  it("an infinite loop at the top level is interrupted at check time", async () => {
    const err = await checkScript("while (true) {}\nexport default async () => 1;", { cpuSliceMs: 100 }).catch(
      (e) => e,
    );
    expect(err?.code).toBe("script_limit");
    expect(err?.limit).toBe("cpu");
  });

  it("a script awaiting forever is ended by its wall clock", async () => {
    const out = await runSource("export default async () => { await new Promise(() => {}); }", {
      dir,
      caps: { wallClock: 150 },
    });
    expect(bodyError(out)?.code).toBe("script_limit");
  });

  it("a runaway in one run does not affect another run in the same process", async () => {
    const [bad, good] = await Promise.all([
      runSource("export default async () => { const a = []; for (;;) a.push('x'.repeat(1000)); }", {
        dir,
        caps: { memoryBytes: 8 * 1024 * 1024 },
      }),
      runSource("export default async (input) => input.n + 1;", { dir, input: { n: 1 } }),
    ]);
    expect(bodyError(bad)?.code).toBe("script_limit");
    expect(good.output).toBe(2);
  });

  it("a long chain of host calls does not leak isolate handles", async () => {
    const out = await runSource(
      "export default async (input, sb) => {\n  let s = 0;\n  for (let i = 0; i < 3000; i++) { sb.log('tick ' + i, 'debug'); s++; }\n  for (let i = 0; i < 50; i++) s += (await sb.step('s' + i, async () => i)) >= 0 ? 0 : 1;\n  return s;\n}",
      { dir },
    );
    expect(out.output).toBe(3000);
  });
});
