import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentInterruptedError, JournalConflictError, RunIdConflictError } from "../errors/classes.js";
import { fileJournal } from "../journal/index.js";
import type { JournalEntry, JournalStore, RunOptions } from "../types/orchestration.js";
import { openCall } from "./calls.js";
import { currentFrame } from "./context.js";
import { factory } from "./factory.js";
import { log, now, parallel, pipeline, random, step, uuid } from "./primitives.js";
import { run, runFactory } from "./run.js";

let dir: string;
let journal: JournalStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-engine-resume-"));
  journal = fileJournal(join(dir, "journal"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const Input = z.object({ issue: z.number() });

/** An agent-shaped journaled call whose target is its prompt; `live` counts every live execution. */
function agents() {
  const live: string[] = [];
  const agent = async <T>(name: string, prompt: string, value: () => T | Promise<T>): Promise<T> => {
    const call = openCall("agent", { kind: "agent", name, target: prompt, input: { prompt } });
    if (call.cached) return call.replay() as T;
    if (call.previous?.status === "started") {
      // §3.10 in miniature: the earlier attempt may have had effects, so never re-run silently.
      const policy = call.run.interruptedPolicy(call.callPath);
      if (policy === "fail") {
        call.abandon();
        call.run.needsAttention.add(call.callPath);
        throw new AgentInterruptedError(undefined, { callPath: call.callPath });
      }
    }
    await call.start({ harnessStartedAt: new Date(0).toISOString() });
    live.push(call.callPath);
    try {
      const out = await value();
      await call.complete(out);
      return out;
    } catch (error) {
      await call.fail(error);
      throw error;
    }
  };
  return { live, agent };
}

async function entriesOf(runId: string): Promise<JournalEntry[]> {
  const out: JournalEntry[] = [];
  for await (const e of journal.list(runId)) out.push(e);
  return out;
}

function opts(extra: RunOptions = {}): RunOptions {
  return { runId: "ship-412", journal, ...extra };
}

describe("journal-replay resume", () => {
  it("replays finished calls without running them and marks replayed log events", async () => {
    const { live, agent } = agents();
    const prompts = { plan: "plan it", build: "build it", review: "review it" };
    const f = factory({ name: "ship", input: Input }, async ({ issue }) => {
      log("begin");
      const plan = await agent("Plan", prompts.plan, () => `plan-${issue}`);
      const build = await agent("ImplementSpec", prompts.build, () => `${plan}+built`);
      const review = await agent("CodeReview", prompts.review, () => `${build}+reviewed`);
      return review;
    });

    const first = await run(f, { issue: 412 }, opts());
    expect(first.output).toBe("plan-412+built+reviewed");
    expect(live).toEqual(["Plan#0", "ImplementSpec#0", "CodeReview#0"]);

    live.length = 0;
    const second = await run(f, { issue: 412 }, opts());
    expect(second.status).toBe("ok");
    expect(second.output).toBe(first.output);
    expect(live).toEqual([]);
    expect(second.events.find((e) => e.type === "log")?.replayed).toBe(true);
  });

  it("runs an edited call and everything after it live, keeping the prefix cached", async () => {
    const { live, agent } = agents();
    const prompts = { plan: "plan it", build: "build it", review: "review it" };
    const f = factory({ name: "ship", input: Input }, async () => {
      const plan = await agent("Plan", prompts.plan, () => "p");
      const build = await agent("ImplementSpec", prompts.build, () => `${plan}b`);
      const review = await agent("CodeReview", prompts.review, () => `${build}r`);
      return review;
    });
    await run(f, { issue: 1 }, opts());

    live.length = 0;
    prompts.build = "build it better";
    await run(f, { issue: 1 }, opts());
    expect(live).toEqual(["ImplementSpec#0", "CodeReview#0"]);

    live.length = 0;
    await run(f, { issue: 1 }, opts());
    expect(live).toEqual([]);
  });

  it("keeps sibling parallel scopes as independent prefixes", async () => {
    const { live, agent } = agents();
    const prompts = { a2: "a second" };
    const f = factory({ name: "fanout", input: Input }, async () => {
      const results = await parallel([
        async () => {
          const a = await agent("A", "a first", () => "a1");
          return agent("A", prompts.a2, () => `${a}a2`);
        },
        async () => {
          const b = await agent("B", "b first", () => "b1");
          return agent("B", "b second", () => `${b}b2`);
        },
      ]);
      return agent("Join", "join", () => results.join("|"));
    });
    await run(f, { issue: 1 }, opts());

    live.length = 0;
    prompts.a2 = "a second, edited";
    await run(f, { issue: 1 }, opts());
    // Branch [1] is untouched; branch [0] reruns from its edit; the join after the barrier runs live.
    expect(live).toEqual(["parallel#0/[0]/A#1", "Join#0"]);
  });

  it("keeps pipeline stages cached for every item when a later stage is edited", async () => {
    const { live, agent } = agents();
    const prompts = { s1: "stage one" };
    const f = factory({ name: "pipe", input: Input }, async () =>
      pipeline(
        { key: (n: number) => `item-${n}` },
        [1, 2, 3],
        async (n) => agent("S0", "stage zero", () => n),
        async (n) => agent("S1", prompts.s1, () => n * 10),
      ),
    );
    const first = await run(f, { issue: 1 }, opts());
    expect(first.output).toEqual([10, 20, 30]);

    live.length = 0;
    prompts.s1 = "stage one, edited";
    await run(f, { issue: 1 }, opts());
    expect(live.sort()).toEqual([
      "pipeline#0/[item-1]/stage#1/S1#0",
      "pipeline#0/[item-2]/stage#1/S1#0",
      "pipeline#0/[item-3]/stage#1/S1#0",
    ]);
  });

  it("re-runs failed calls and never caches failures", async () => {
    const { live, agent } = agents();
    let fail = true;
    const f = factory({ name: "flaky", input: Input }, async () => {
      await agent("A", "a", () => 1);
      return agent("B", "b", () => {
        if (fail) throw new Error("model overloaded");
        return 2;
      });
    });
    const first = await run(f, { issue: 1 }, opts());
    expect(first.status).toBe("failed");

    live.length = 0;
    fail = false;
    const second = await run(f, { issue: 1 }, opts());
    expect(second.output).toBe(2);
    expect(live).toEqual(["B#0"]);
    const b = (await entriesOf("ship-412")).find((e) => e.callPath === "B#0");
    expect(b).toMatchObject({ status: "ok", attempt: 2 });
    expect(b?.launchId).toMatch(/_e0_l1$/);
  });

  it("forces refreshed callPaths live, then everything after them in scope", async () => {
    const { live, agent } = agents();
    const f = factory({ name: "refresh", input: Input }, async () => {
      await step("list-issues", async () => [1, 2]);
      await agent("A", "a", () => 1);
      await agent("B", "b", () => 2);
    });
    await run(f, { issue: 1 }, opts());
    live.length = 0;
    await run(f, { issue: 1 }, opts({ refresh: ["A#0"] }));
    expect(live).toEqual(["A#0", "B#0"]);

    live.length = 0;
    let listed = 0;
    const g = factory({ name: "refresh", input: Input }, async () => {
      await step("list-issues", async () => ++listed);
      await agent("A", "a", () => 1);
    });
    await run(g, { issue: 1 }, opts({ runId: "prefix", refresh: ["list-issues"] }));
    await run(g, { issue: 1 }, opts({ runId: "prefix", refresh: ["list-issues"] }));
    expect(listed).toBe(2);
  });

  it("kill mid-run, edit, resume: replays the prefix and never re-runs an interrupted call silently", async () => {
    const { live, agent } = agents();
    const controller = new AbortController();
    const prompts = { c: "c" };
    let hang = true;
    const f = factory({ name: "crashy", input: Input }, async () => {
      await agent("A", "a", () => "a");
      const b = await agent("B", "b", async () => {
        if (hang) {
          // The turn is killed mid-way: B's started entry stays, with no completion.
          controller.abort(new Error("killed"));
          await new Promise(() => {});
        }
        return "b";
      });
      return agent("C", prompts.c, () => `${b}c`);
    });
    const crashed = await run(f, { issue: 1 }, opts({ signal: controller.signal }));
    expect(crashed.status).toBe("aborted");
    expect((await entriesOf("ship-412")).find((e) => e.callPath === "B#0")?.status).toBe("started");

    hang = false;
    prompts.c = "c, edited";
    live.length = 0;
    const resumed = await run(f, { issue: 1 }, opts());
    expect(resumed.status).toBe("needs_attention");
    expect(live).toEqual([]);
    expect(resumed.events.find((e) => e.type === "run.end")?.data?.needsAttention).toEqual(["B#0"]);

    const decided = await run(f, { issue: 1 }, opts({ onInterrupted: { "B#0": "resume-session" } }));
    expect(decided.status).toBe("ok");
    expect(decided.output).toBe("bc");
    expect(live).toEqual(["B#0", "C#0"]);
  });

  it("refuses to take over a run whose lease another live process still holds", async () => {
    const holder = await journal.lease("ship-412", "other-process", "1m");
    expect(holder).not.toBeNull();
    const f = factory({ name: "x", input: Input }, async () => 1);
    await expect(run(f, { issue: 1 }, opts())).rejects.toBeInstanceOf(JournalConflictError);
    await journal.release?.(holder as NonNullable<typeof holder>);
    expect((await run(f, { issue: 1 }, opts())).status).toBe("ok");
  });

  it("stops writing once another process takes the lease over", async () => {
    let takeover: () => Promise<void> = async () => {};
    const f = factory({ name: "fenced", input: Input }, async () => {
      await step("before", async () => 1);
      await takeover();
      await step("after", async () => 2);
    });
    takeover = async () => {
      await new Promise((r) => setTimeout(r, 30));
      expect(await journal.lease("ship-412", "new-holder", "1m")).not.toBeNull();
    };
    const out = await runFactory(f, { issue: 1 }, opts(), { leaseTtlMs: 10 });
    expect(out.status).toBe("failed");
    expect(out.events.some((e) => e.type === "error" && e.data?.code === "lease_lost")).toBe(true);
    expect((await entriesOf("ship-412")).some((e) => e.callPath === "after")).toBe(false);
  });

  it("binds a run id to its factory and input", async () => {
    const f = factory({ name: "bound", input: Input }, async () => 1);
    await run(f, { issue: 1 }, opts());
    await expect(run(f, { issue: 2 }, opts())).rejects.toBeInstanceOf(RunIdConflictError);
    const other = factory({ name: "other", input: Input }, async () => 1);
    await expect(run(other, { issue: 1 }, opts())).rejects.toBeInstanceOf(RunIdConflictError);
    const runEntry = (await entriesOf("ship-412")).find((e) => e.kind === "run");
    expect(runEntry?.value).toMatchObject({ resumes: [expect.any(Object)] });
  });

  it("refuses a second concurrent process on the same run", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = factory({ name: "slow", input: Input }, async () => {
      await gate;
      return 1;
    });
    const first = run(f, { issue: 1 }, opts());
    await new Promise((r) => setTimeout(r, 50));
    await expect(run(f, { issue: 1 }, opts())).rejects.toBeInstanceOf(JournalConflictError);
    release();
    expect((await first).status).toBe("ok");
    // A clean exit releases the lease, so a resume can start at once.
    expect((await run(f, { issue: 1 }, opts())).status).toBe("ok");
  });

  it("replays now(), random() and uuid() per scope", async () => {
    const f = factory({ name: "clocks", input: Input }, async () => {
      const values = { t: now(), r: random(), u: uuid() };
      await step("persist", async () => true);
      return values;
    });
    const first = await run(f, { issue: 1 }, opts());
    await new Promise((r) => setTimeout(r, 5));
    const second = await run(f, { issue: 1 }, opts());
    expect(second.output).toEqual(first.output);
  });

  it("reports journal entries the replay never visited as orphaned", async () => {
    const flags = { extra: true };
    const f = factory({ name: "orphans", input: Input }, async () => {
      await step("keep", async () => 1);
      if (flags.extra) await step("dropped-later", async () => 2);
    });
    await run(f, { issue: 1 }, opts());
    flags.extra = false;
    const second = await run(f, { issue: 1 }, opts());
    const end = second.events.find((e) => e.type === "run.end");
    expect(end?.data?.orphaned).toEqual([expect.objectContaining({ callPath: "dropped-later", status: "ok" })]);
  });

  it("journals budget charges and deducts unfinished attempts on resume", async () => {
    const f = factory({ name: "spend", input: Input }, async () => {
      const call = openCall("agent", { kind: "agent", name: "A", target: "a" });
      if (call.cached) return call.replay();
      await call.start();
      const reservation = currentFrame("t").run.budget.admit({ callPath: call.callPath, stepKey: call.stepKey });
      await reservation.charge({ launchId: call.launchId(), turn: 0, usd: 3, tokens: 100, final: true });
      // The process dies before the call completes.
      call.abandon();
      return currentFrame("t").run.budget.charged();
    });
    const first = await run(f, { issue: 1 }, opts({ budget: { usd: 10 } }));
    expect(first.output).toEqual({ usd: 3, tokens: 100 });

    const g = factory({ name: "spend", input: Input }, async () => currentFrame("t").run.budget.charged());
    const second = await run(g, { issue: 1 }, opts({ budget: { usd: 10 } }));
    expect(second.output).toEqual({ usd: 3, tokens: 100 });
    const charge = (await entriesOf("ship-412")).find((e) => e.kind === "charge");
    expect(charge).toMatchObject({ status: "ok", charge: { usd: 3, tokens: 100, turn: 0, cumulative: true } });
  });
});
