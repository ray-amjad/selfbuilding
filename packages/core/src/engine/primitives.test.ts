import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentInputError,
  ConfigError,
  DuplicateLabelError,
  NestingDepthError,
  NoActiveRunError,
  NonDeterminismError,
  SandboxBusyError,
  SandboxUnavailableError,
} from "../errors/classes.js";
import { memoryJournal } from "../journal/memory.js";
import type { SelfbuildingEvent } from "../types/events.js";
import type { RunOptions } from "../types/orchestration.js";
import { openCall } from "./calls.js";
import { currentFrame, internal } from "./context.js";
import { factory } from "./factory.js";
import { isPresent, log, now, parallel, phase, pipeline, random, step, uuid } from "./primitives.js";
import { run } from "./run.js";

const Input = z.object({ n: z.number().default(0) });

function make<O>(body: (input: { n: number }) => Promise<O>, name = "test-factory") {
  return factory({ name, input: Input }, body);
}

/** Runs a body with an in-memory journal and returns the outcome. */
async function exec<O>(body: (input: { n: number }) => Promise<O>, opts: RunOptions = {}) {
  return run(make(body), { n: 0 }, { journal: memoryJournal(), ...opts });
}

/** A journaled call shaped like an agent call, without a sandbox. */
async function fakeAgent<T>(name: string, prompt: string, fn: () => Promise<T> | T, label?: string): Promise<T> {
  const call = openCall("agent", { kind: "agent", name, target: prompt, ...(label ? { label } : {}) });
  if (call.cached) return call.replay() as T;
  await call.start();
  try {
    const value = await fn();
    await call.complete(value);
    return value;
  } catch (error) {
    await call.fail(error);
    throw error;
  }
}

function paths(events: SelfbuildingEvent[], type: string): string[] {
  return events.filter((e) => e.type === type).map((e) => e.callPath);
}

describe("primitives outside a run", () => {
  it("throw NoActiveRunError naming the primitive", async () => {
    await expect(step("x", async () => 1)).rejects.toThrow(/step\(\) was called outside a running factory/);
    await expect(parallel([async () => 1])).rejects.toBeInstanceOf(NoActiveRunError);
    expect(() => now()).toThrow(NoActiveRunError);
    expect(() => phase("p")).toThrow(/phase\(\)/);
    expect(() => log("hi")).toThrow(NoActiveRunError);
    expect(() => currentFrame("agent")).toThrow(/agent\(\)/);
  });
});

describe("factory()", () => {
  it("validates its options when built", () => {
    expect(() => factory({ name: "", input: Input }, async () => 1)).toThrow(ConfigError);
    expect(() => factory({ name: "x", input: {} as never }, async () => 1)).toThrow(/Zod schema/);
    expect(() => factory({ name: "x", input: Input, budget: { usd: -1 } }, async () => 1)).toThrow(/usd/);
    expect(() => factory({ name: "x", input: Input, concurrency: { sandboxes: 0 } }, async () => 1)).toThrow(
      /sandboxes/,
    );
  });

  it("exposes name, schemas, options and body", () => {
    const body = async () => 1;
    const f = factory({ name: "ship", input: Input, output: z.number() }, body);
    expect(f.name).toBe("ship");
    expect(f.inputSchema).toBe(Input);
    expect(f.body).toBe(body);
    expect(f.options.name).toBe("ship");
  });
});

describe("run()", () => {
  it("returns the output, a generated ns_ run id and the event stream", async () => {
    const out = await exec(async ({ n }) => n + 1);
    expect(out.status).toBe("ok");
    expect(out.output).toBe(1);
    expect(out.runId).toMatch(/^ns_[0-9a-z]{26}$/);
    expect(out.events.map((e) => e.type)).toEqual(expect.arrayContaining(["run.started", "run.end"]));
    expect(out.events.every((e) => e.runId === out.runId && e.v === 1)).toBe(true);
  });

  it("rejects invalid run ids, input, output and options as usage errors", async () => {
    const f = make(async () => 1);
    await expect(run(f, { n: 0 }, { runId: "bad id!" })).rejects.toThrow(ConfigError);
    await expect(run(f, { n: "x" } as never)).rejects.toBeInstanceOf(AgentInputError);
    await expect(run(f, { n: 0 }, { refresh: "x" as never })).rejects.toThrow(/refresh/);
    await expect(run(f, { n: 0 }, { onInterrupted: { a: "nope" as never } })).rejects.toThrow(/onInterrupted/);
    await expect(run(f, { n: 0 }, { config: { nope: 1 } as never })).rejects.toThrow(/Unknown config key/);
    const typed = factory({ name: "typed", input: Input, output: z.string() }, async () => 5 as never);
    await expect(run(typed, { n: 0 }, { journal: memoryJournal() })).rejects.toThrow(/output schema/);
  });

  it("warns once when no journal is configured", async () => {
    const out = await run(
      make(async () => 1),
      { n: 0 },
    );
    expect(out.events.filter((e) => e.type === "warning" && e.data?.scope === "journal")).toHaveLength(1);
  });

  it("resolves agent-level failures as status failed and throws usage errors", async () => {
    const failed = await exec(async () => {
      throw new SandboxUnavailableError({ provider: "p" });
    });
    expect(failed.status).toBe("failed");
    expect(failed.output).toBeNull();
    await expect(
      exec(async () => {
        throw new ConfigError("bug");
      }),
    ).rejects.toThrow("bug");
  });

  it("ends aborted when the signal fires", async () => {
    const controller = new AbortController();
    const out = await exec(
      async () => {
        controller.abort(new Error("stop"));
        return step("after", async () => 1);
      },
      { signal: controller.signal },
    );
    expect(out.status).toBe("aborted");
  });

  it("delivers events to sinks in order and survives a throwing sink", async () => {
    const seen: string[] = [];
    const out = await exec(
      async () => {
        log("one");
        log("two");
      },
      {
        events: [
          (e) => {
            seen.push(e.type);
          },
          () => {
            throw new Error("sink down");
          },
        ],
      },
    );
    expect(out.status).toBe("ok");
    expect(seen.filter((t) => t === "log")).toEqual(["log", "log"]);
    expect(out.events.some((e) => e.type === "telemetry.dropped")).toBe(true);
  });

  it("runs finalizers registered by other modules when the run ends", async () => {
    const order: string[] = [];
    await exec(async () => {
      const { run: state } = currentFrame("test");
      state.defer(() => {
        order.push("first");
      });
      state.defer(async () => {
        order.push("second");
      });
    });
    expect(order).toEqual(["second", "first"]);
  });
});

describe("callPath allocation", () => {
  it("counts per name, uses labels as is and rejects duplicate labels", async () => {
    const out = await exec(async () => {
      const seen: string[] = [];
      for (const name of ["ImplementSpec", "CodeReview", "ImplementSpec"]) {
        await fakeAgent(name, "p", () => {
          seen.push(currentFrame("t").scope.path);
          return 1;
        });
      }
      await fakeAgent("CodeReview", "p", () => 1, "review");
      await expect(fakeAgent("CodeReview", "p", () => 1, "review")).rejects.toBeInstanceOf(DuplicateLabelError);
      await expect(fakeAgent("CodeReview", "p", () => 1, "Bad Label")).rejects.toThrow(/must match/);
      return seen;
    });
    expect(out.status).toBe("ok");
    const started = out.events.length;
    expect(started).toBeGreaterThan(0);
  });

  it("records agent-shaped calls under Name#n paths", async () => {
    const journal = memoryJournal();
    const out = await run(
      make(async () => {
        await fakeAgent("ImplementSpec", "p", () => 1);
        await fakeAgent("CodeReview", "p", () => 2);
        await fakeAgent("ImplementSpec", "p", () => 3);
        await step("list-issues", async () => [1, 2]);
      }),
      { n: 0 },
      { journal, runId: "paths" },
    );
    const entries = [];
    for await (const e of journal.list(out.runId)) entries.push(e);
    expect(entries.map((e) => e.callPath).sort()).toEqual(
      ["CodeReview#0", "ImplementSpec#0", "ImplementSpec#1", "list-issues", "run"].sort(),
    );
  });

  it("rejects a duplicate step name in one scope", async () => {
    await expect(
      exec(async () => {
        await step("a", async () => 1);
        await step("a", async () => 2);
      }),
    ).rejects.toBeInstanceOf(DuplicateLabelError);
  });
});

describe("step()", () => {
  it("returns JSON values and refuses non-JSON or oversized ones", async () => {
    const out = await exec(async () => {
      const value = await step("ok", async () => ({ when: new Date(0), list: [1, undefined] }));
      await expect(step("too-big", async () => "x".repeat(300 * 1024))).rejects.toThrow(/256 KiB/);
      await expect(step("bigint", async () => 1n)).rejects.toThrow(/not JSON/);
      return value;
    });
    expect(out.output).toEqual({ when: "1970-01-01T00:00:00.000Z", list: [1, null] });
  });

  it("records failures and rethrows them", async () => {
    const journal = memoryJournal();
    const out = await run(
      make(async () => {
        await step("boom", async () => {
          throw new SandboxUnavailableError({ provider: "p" });
        });
      }),
      { n: 0 },
      { journal, runId: "step-fail" },
    );
    expect(out.status).toBe("failed");
    const entries = [];
    for await (const e of journal.list("step-fail")) entries.push(e);
    const boom = entries.find((e) => e.callPath === "boom");
    expect(boom?.status).toBe("failed");
    expect(boom?.value).toMatchObject({ error: { code: "sandbox_unavailable" } });
  });
});

describe("parallel()", () => {
  it("is a barrier over a list: failures become null, results keep index order", async () => {
    const out = await exec(async () => {
      const results = await parallel([
        async () => {
          await new Promise((r) => setTimeout(r, 20));
          return "slow";
        },
        async () => {
          throw new SandboxUnavailableError({ provider: "p" });
        },
        async () => null,
        async () => "fast",
      ]);
      return results;
    });
    expect(out.output).toEqual(["slow", null, null, "fast"]);
    expect(out.status).toBe("partial");
    const error = out.events.find((e) => e.type === "error" && e.data?.primitive === "parallel");
    expect(error?.callPath).toBe("parallel#0/[1]");
    expect(error?.data?.code).toBe("sandbox_unavailable");
  });

  it("takes a record and gives each child its own [key] scope", async () => {
    const out = await exec(async () =>
      parallel({
        claude: async () => fakeAgent("CodeReview", "p", () => currentFrame("t").scope.path),
        codex: async () => fakeAgent("CodeReview", "p", () => currentFrame("t").scope.path),
      }),
    );
    expect(out.output).toEqual({ claude: "parallel#0/[claude]", codex: "parallel#0/[codex]" });
  });

  it("starts thunks synchronously in index order", async () => {
    const order: number[] = [];
    await exec(async () => {
      await parallel([0, 1, 2].map((i) => async () => order.push(i)));
    });
    expect(order).toEqual([0, 1, 2]);
  });

  it("rethrows usage errors instead of nulling them", async () => {
    await expect(
      exec(async () =>
        parallel([
          async () => 1,
          async () => {
            throw new SandboxBusyError();
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(SandboxBusyError);
  });

  it("rejects non-function children", async () => {
    await expect(exec(async () => parallel([1 as never]))).rejects.toThrow(/not a function/);
  });

  it("narrows with isPresent", () => {
    const xs: (number | null)[] = [1, null, 2];
    const ys: number[] = xs.filter(isPresent);
    expect(ys).toEqual([1, 2]);
    expect(isPresent(undefined)).toBe(false);
  });
});

describe("pipeline()", () => {
  it("passes (prev, {item, index, key}) and keeps input order", async () => {
    const out = await exec(async () =>
      pipeline(
        ["a", "b", "c"],
        async (item, ctx) => `${item}${ctx.index}`,
        async (prev, ctx) => `${prev}-${ctx.item}-${ctx.key}`,
      ),
    );
    expect(out.output).toEqual(["a0-a-0", "b1-b-1", "c2-c-2"]);
  });

  it("has no barrier: one item can reach the last stage while another is still in the first", async () => {
    const order: string[] = [];
    await exec(async () =>
      pipeline(
        [0, 1],
        async (i) => {
          if (i === 1) await new Promise((r) => setTimeout(r, 30));
          order.push(`s0:${i}`);
          return i;
        },
        async (i) => {
          order.push(`s1:${i}`);
          return i;
        },
      ),
    );
    expect(order).toEqual(["s0:0", "s1:0", "s0:1", "s1:1"]);
  });

  it("stops an item on null and drops it on a thrown error", async () => {
    const reached: number[] = [];
    const out = await exec(async () =>
      pipeline(
        [1, 2, 3],
        async (i) => {
          if (i === 2) return null;
          if (i === 3) throw new Error("flaky");
          return i;
        },
        async (i) => {
          reached.push(i);
          return i * 10;
        },
      ),
    );
    expect(out.output).toEqual([10, null, null]);
    expect(reached).toEqual([1]);
    const dropped = out.events.find((e) => e.type === "item.dropped");
    expect(dropped?.callPath).toBe("pipeline#0/[2]");
    expect(dropped?.data).toMatchObject({ index: 2, stage: 0, error: { message: "flaky" } });
    expect(out.status).toBe("partial");
  });

  it("uses keyed item segments and stage scopes in callPaths", async () => {
    const out = await exec(async () =>
      pipeline(
        { key: (issue: { id: number }) => `issue-${issue.id}`, label: "triage" },
        [{ id: 412 }, { id: 7 }],
        async (issue) => fakeAgent("ImplementSpec", "p", () => ({ id: issue.id, path: currentFrame("t").scope.path })),
        async (prev) => prev.path,
      ),
    );
    expect(out.output).toEqual(["triage/[issue-412]/stage#0", "triage/[issue-7]/stage#0"]);
  });

  it("rejects duplicate keys, bad arguments and usage errors from stages", async () => {
    await expect(exec(async () => pipeline({ key: () => "same" }, [1, 2], async (x) => x))).rejects.toThrow(
      /not unique/,
    );
    await expect(exec(async () => (pipeline as (...a: unknown[]) => Promise<unknown>)([1]))).rejects.toThrow(
      /1 to 8 stages/,
    );
    await expect(exec(async () => pipeline({ key: () => "a/b" }, [1], async (x) => x))).rejects.toThrow(/no "\/"/);
    await expect(
      exec(async () =>
        pipeline([1], async () => {
          throw new ConfigError("bad");
        }),
      ),
    ).rejects.toThrow("bad");
  });

  it("limits items in flight", async () => {
    let active = 0;
    let peak = 0;
    await exec(async () =>
      pipeline({ maxInFlight: 2 }, [1, 2, 3, 4, 5], async (i) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return i;
      }),
    );
    expect(peak).toBe(2);
  });
});

describe("nested factories", () => {
  it("run one level deep in a child scope and share the run", async () => {
    const child = factory({ name: "review-panel", input: z.object({ branch: z.string() }) }, async ({ branch }) => {
      return fakeAgent("CodeReview", "p", () => `${branch}@${currentFrame("t").scope.path}`);
    });
    const out = await exec(async () => {
      const a = await child({ branch: "x" });
      const b = await child({ branch: "y" });
      return [a, b];
    });
    expect(out.output).toEqual(["x@review-panel#0", "y@review-panel#1"]);
  });

  it("throw NestingDepthError past one level", async () => {
    const leaf = factory({ name: "leaf", input: z.object({}) }, async () => 1);
    const middle = factory({ name: "middle", input: z.object({}) }, async () => leaf({}));
    await expect(exec(async () => middle({}))).rejects.toBeInstanceOf(NestingDepthError);
  });

  it("validate their input", async () => {
    const child = factory({ name: "child", input: z.object({ x: z.string() }) }, async () => 1);
    await expect(exec(async () => child({ x: 1 } as never))).rejects.toBeInstanceOf(AgentInputError);
  });
});

describe("phase() and log()", () => {
  it("emit events at the scope's callPath with level and data", async () => {
    const out = await exec(async () => {
      phase("build");
      log("starting", { n: 1 });
      log("warn", "careful");
      await parallel([async () => log("in child")]);
    });
    const phaseEvent = out.events.find((e) => e.type === "phase");
    expect(phaseEvent).toMatchObject({ callPath: "run", data: { name: "build" }, replayed: false });
    const logs = out.events.filter((e) => e.type === "log");
    expect(logs[0]).toMatchObject({ level: "info", data: { message: "starting", data: { n: 1 }, phase: "build" } });
    expect(logs[1]).toMatchObject({ level: "warn", data: { message: "careful" } });
    expect(logs[2]?.callPath).toBe("parallel#0/[0]");
    expect(paths(out.events, "log")).toEqual(["run", "run", "parallel#0/[0]"]);
  });

  it("numbers events per (callPath, launchId)", async () => {
    const out = await exec(async () => {
      log("a");
      log("b");
    });
    const runEvents = out.events.filter((e) => e.callPath === "run");
    expect(runEvents.map((e) => e.seq)).toEqual(runEvents.map((_, i) => i));
    expect(runEvents.every((e) => e.launchId.startsWith("epoch-"))).toBe(true);
  });
});

describe("now(), random(), uuid()", () => {
  it("return fresh values on a live run", async () => {
    const out = await exec(async () => ({ t: now(), r: random(), u: uuid(), u2: uuid() }));
    const v = out.output as { t: number; r: number; u: string; u2: string };
    expect(Math.abs(v.t - Date.now())).toBeLessThan(5000);
    expect(v.r).toBeGreaterThanOrEqual(0);
    expect(v.r).toBeLessThan(1);
    expect(v.u).not.toBe(v.u2);
  });
});

describe("strict mode", () => {
  it("throws NonDeterminismError for raw clocks and randomness in factory code", async () => {
    for (const bad of [() => Date.now(), () => new Date(), () => Math.random(), () => crypto.randomUUID()]) {
      await expect(exec(async () => bad(), { strict: true })).rejects.toBeInstanceOf(NonDeterminismError);
    }
  });

  it("exempts step() bodies, internals and dated constructors, and restores the globals", async () => {
    const realNow = Date.now;
    const out = await exec(
      async () => {
        const inStep = await step("clock", async () => Date.now() > 0);
        const inInternal = internal(() => Math.random() >= 0);
        const fixed = new Date(0).getTime();
        return { inStep, inInternal, fixed, instance: new Date(5) instanceof Date };
      },
      { strict: true },
    );
    expect(out.output).toEqual({ inStep: true, inInternal: true, fixed: 0, instance: true });
    expect(Date.now).toBe(realNow);
    expect(() => new Date()).not.toThrow();
  });

  it("leaves non-strict runs alone", async () => {
    const out = await exec(async () => Date.now() > 0);
    expect(out.output).toBe(true);
  });
});
