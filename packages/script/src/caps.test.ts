// Every cap in demo-path §8.3 trips with ScriptLimitError naming it; caps only ever tighten.
import fs from "node:fs/promises";
import { ConfigError, ScriptLimitError } from "@selfbuilding/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyError, fakeAgents, runSource, tempDir } from "../test/kit.js";
import { tightenCaps } from "./caps.js";
import { checkScript, DEFAULT_SCRIPT_CAPS, effectiveCaps, runScript } from "./index.js";

let dir: string;
beforeAll(async () => {
  dir = await tempDir("sbs-caps-");
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function expectLimit(out: Awaited<ReturnType<typeof runSource>>, limit: string): void {
  expect(out.status).toBe("failed");
  const err = bodyError(out);
  expect(err?.code).toBe("script_limit");
  expect(err?.message).toContain(`hit its ${limit} limit`);
}

describe("caps: tightening", () => {
  it("each layer takes the minimum, intersects sizes and keeps the shorter wall clock", () => {
    const caps = tightenCaps(
      DEFAULT_SCRIPT_CAPS,
      { maxAgentCalls: 10, allowedSizes: ["small", "large"], wallClock: "1h" },
      { maxAgentCalls: 99, budgetUsd: 2, wallClock: "2h" },
    );
    expect(caps.maxAgentCalls).toBe(10);
    expect(caps.budgetUsd).toBe(2);
    expect(caps.allowedSizes).toEqual(["small"]);
    expect(caps.wallClock).toBe("1h");
    expect(caps.memoryBytes).toBe(DEFAULT_SCRIPT_CAPS.memoryBytes);
  });

  it("config.scripts tightens the defaults, and input caps tighten again", () => {
    const caps = effectiveCaps({ scripts: { maxSandboxes: 3 } }, { maxSandboxes: 8, budgetUsd: 1 });
    expect(caps.maxSandboxes).toBe(3);
    expect(caps.budgetUsd).toBe(1);
  });

  it("rejects unknown and malformed caps", () => {
    expect(() => tightenCaps(DEFAULT_SCRIPT_CAPS, { nope: 1 } as never)).toThrow(ConfigError);
    expect(() => tightenCaps(DEFAULT_SCRIPT_CAPS, { maxAgentCalls: -1 })).toThrow(ConfigError);
    expect(() => tightenCaps(DEFAULT_SCRIPT_CAPS, { wallClock: "soon" as never })).toThrow(ConfigError);
  });
});

describe("caps: every breach is ScriptLimitError", () => {
  it("source_bytes: checked before anything runs", async () => {
    const source = `export default async () => ${JSON.stringify("x".repeat(2000))};`;
    const out = await runSource(source, { dir, caps: { maxSourceBytes: 1000 } });
    expectLimit(out, "source_bytes");
    await expect(checkScript(source, { maxSourceBytes: 1000 })).rejects.toBeInstanceOf(ScriptLimitError);
  });

  it("output_bytes: the serialised return value", async () => {
    const out = await runSource('export default async () => "y".repeat(5000);', {
      dir,
      caps: { maxOutputBytes: 1000 },
    });
    expectLimit(out, "output_bytes");
  });

  it("agent_calls: the call past the cap fails the run, even when the script catches it", async () => {
    const fakes = fakeAgents({ A: {} });
    fakes.reset();
    const out = await runSource(
      "export default async (input, sb) => {\n  for (let i = 0; i < 5; i++) {\n    try { await sb.agents.A({ i }); } catch (e) {}\n  }\n  return 'kept going';\n}",
      { dir, caps: { maxAgentCalls: 2 }, script: { agents: fakes.agents } },
    );
    expectLimit(out, "agent_calls");
    expect(fakes.calls).toHaveLength(2);
  });

  it("size: a call option, sb.sandbox and handle.fork may only ask for allowed sizes", async () => {
    const fakes = fakeAgents({ A: {} });
    for (const call of [
      'await sb.agents.A({}, { size: "large" })',
      'sb.sandbox({ size: "large" })',
      'await sb.agent({ name: "x", prompt: "p", output: { type: "object" } }, { size: "xlarge" })',
    ]) {
      fakes.reset();
      const out = await runSource(`export default async (input, sb) => {\n  ${call};\n}`, {
        dir,
        caps: { allowedSizes: ["small"] },
        script: { agents: fakes.agents },
      });
      expectLimit(out, "size");
      expect(bodyError(out)?.message).toContain('asked for "');
    }
    expect(fakes.calls).toHaveLength(0);
  });

  it("size: a call that names no size is checked at its contract's default size", async () => {
    const fakes = fakeAgents({ Verify: { defaultSize: "medium" } });
    for (const call of ["await sb.agents.Verify({})", 'await sb.agents.Verify({}, { sandbox: "fresh" })']) {
      fakes.reset();
      const out = await runSource(`export default async (input, sb) => {\n  ${call};\n}`, {
        dir,
        caps: { allowedSizes: ["small"] },
        script: { agents: fakes.agents },
      });
      expectLimit(out, "size");
      expect(bodyError(out)?.message).toContain('defaults to "medium"');
      expect(bodyError(out)?.message).toContain('{ size: "small" }');
    }
    expect(fakes.calls).toHaveLength(0);
    // Naming an allowed size, or the default being allowed, passes.
    for (const [call, caps] of [
      ['await sb.agents.Verify({}, { size: "small" })', ["small"]],
      ["await sb.agents.Verify({})", ["small", "medium"]],
    ] as const) {
      const out = await runSource(`export default async (input, sb) => {\n  ${call};\n}`, {
        dir,
        caps: { allowedSizes: [...caps] },
        script: { agents: fakes.agents },
      });
      expect(out.status).toBe("ok");
    }
  });

  it("budget: a call's own budget is cut to what the run has left", async () => {
    const fakes = fakeAgents({ A: { usd: 2 } });
    fakes.reset();
    const out = await runSource(
      "export default async (input, sb) => {\n  await sb.agents.A({ n: 1 });\n  await sb.agents.A({ n: 2 }, { budget: { usd: 100 } });\n}",
      { dir, caps: { budgetUsd: 5 }, script: { agents: fakes.agents } },
    );
    expect(out.status).toBe("ok");
    expect(fakes.calls[1]?.opts?.budget).toEqual({ usd: 3 });
  });

  it("an allowed size passes through to the call", async () => {
    const fakes = fakeAgents({ A: {} });
    fakes.reset();
    const out = await runSource(
      'export default async (input, sb) => (await sb.agents.A({}, { size: "medium" })).result;',
      {
        dir,
        script: { agents: fakes.agents },
      },
    );
    expect(out.status).toBe("ok");
    expect(fakes.calls[0]?.opts?.size).toBe("medium");
  });

  it("budget: spend past budgetUsd fails the run before the next call", async () => {
    const fakes = fakeAgents({ Pricey: { usd: 2 } });
    fakes.reset();
    const out = await runSource(
      "export default async (input, sb) => {\n  await sb.agents.Pricey({ n: 1 });\n  await sb.agents.Pricey({ n: 2 });\n  await sb.agents.Pricey({ n: 3 });\n}",
      { dir, caps: { budgetUsd: 3 }, script: { agents: fakes.agents } },
    );
    expectLimit(out, "budget");
    expect(fakes.calls).toHaveLength(2);
  });

  it("wall_clock: a run that outlives its wall clock fails", async () => {
    const fakes = fakeAgents({ Slow: { delayMs: 2_000 } });
    fakes.reset();
    const out = await runSource("export default async (input, sb) => { await sb.agents.Slow({}); }", {
      dir,
      caps: { wallClock: 200 },
      script: { agents: fakes.agents },
    });
    expectLimit(out, "wall_clock");
  });

  it("sandboxes: a fork wider than maxSandboxes can never be satisfied", async () => {
    const out = await runSource("export default async (input, sb) => { await sb.sandbox().fork(5); }", {
      dir,
      caps: { maxSandboxes: 2 },
    });
    expectLimit(out, "sandboxes");
  });

  it("cpu: a synchronous infinite loop is interrupted, and the script cannot catch it", async () => {
    const out = await runSource(
      "export default async () => {\n  try { while (true) {} } catch (e) { return 'caught'; }\n}",
      {
        dir,
        caps: { cpuSliceMs: 100 },
      },
    );
    expectLimit(out, "cpu");
  });

  it("cpu: an endless chain of microtasks never yields to the host, so it is interrupted too", async () => {
    const out = await runSource("export default async () => {\n  for (;;) await null;\n}", {
      dir,
      caps: { cpuSliceMs: 100 },
    });
    expectLimit(out, "cpu");
  });

  it("cpu: the slice restarts each time the script waits on the host", async () => {
    const fakes = fakeAgents({ A: { delayMs: 20 } });
    fakes.reset();
    // Each burst is well under the slice, but together they are far over it.
    const out = await runSource(
      "export default async (input, sb) => {\n  for (let i = 0; i < 6; i++) {\n    let x = 0;\n    for (let j = 0; j < 300000; j++) x += j;\n    await sb.agents.A({ i });\n  }\n  return 'done';\n}",
      { dir, caps: { cpuSliceMs: 400 }, script: { agents: fakes.agents } },
    );
    expect(out.status).toBe("ok");
    expect(out.output).toBe("done");
  });

  // Big allocations, so memory runs out in a few steps, and a long timeout: under a full parallel run the WASM
  // isolate is slow, and many small allocations would hit the CPU slice first.
  it("memory: an allocation past memoryBytes fails the run", { timeout: 20_000 }, async () => {
    const out = await runSource(
      "export default async () => {\n  const parts = [];\n  for (;;) parts.push(new Array(1000000).fill(7));\n}",
      { dir, caps: { memoryBytes: 8 * 1024 * 1024 } },
    );
    expectLimit(out, "memory");
  });

  it("memory: one huge string allocation fails the run", async () => {
    const out = await runSource('export default async () => "x".repeat(64 * 1024 * 1024).length;', {
      dir,
      caps: { memoryBytes: 16 * 1024 * 1024 },
    });
    expectLimit(out, "memory");
  });

  it("stack: unbounded recursion fails the run", async () => {
    const out = await runSource("const down = (n) => down(n + 1) + 1;\nexport default async () => down(0);", {
      dir,
      caps: { stackBytes: 256 * 1024 },
    });
    expectLimit(out, "stack");
  });

  it("runScript outside the factory honours caps passed directly", async () => {
    await expect(
      runScript(
        "export default async () => 'z'.repeat(100);",
        {},
        { agents: {}, harnesses: {}, caps: { maxOutputBytes: 10 } },
      ),
    ).rejects.toBeInstanceOf(ScriptLimitError);
  });
});
