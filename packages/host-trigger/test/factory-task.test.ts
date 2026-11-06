import { type AskRecord, ConfigError, type Json } from "@selfbuilding/core";
import { tmpdirProvider } from "@selfbuilding/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_TASK_ID,
  createLocalTrigger,
  createTriggerAskResolver,
  createTriggerHost,
  FACTORY_TASK_ID,
  type FactoryTaskOutput,
  memoryResultStore,
  REAPER_TASK_ID,
  type RunRecord,
  realTriggerSdk,
  resultStoreAsks,
} from "../src/index.js";
import { type AgentValue, testFactory } from "./engine.js";
import { type Harness, setup } from "./setup.js";
import { resolution, type SimLaunch } from "./sim-driver.js";

async function startFactory(h: Harness, factory: string, input: Json, runId?: string) {
  const run = await h.t.start(FACTORY_TASK_ID, { factory, input, ...(runId ? { runId } : {}) });
  await h.t.settle();
  return run.id;
}

function latest(h: Harness, callPath: string): SimLaunch {
  const launches = h.sim.list(callPath);
  const last = launches.at(-1);
  if (!last) throw new Error(`no launch for ${callPath}; log: ${h.sim.log.join(" | ")}`);
  return last;
}

async function finish(h: Harness, callPath: string, result: Json) {
  await h.sim.finish(latest(h, callPath).launchId, result);
  await h.t.settle();
}

function factoryOutput(h: Harness, id: string): FactoryTaskOutput {
  const run = h.t.run(id);
  expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
  return run.output as FactoryTaskOutput;
}

function agentRuns(h: Harness) {
  return h.t.runs({ taskId: AGENT_TASK_ID });
}

const providers: ReturnType<typeof tmpdirProvider>[] = [];
afterEach(async () => {
  for (const p of providers.splice(0)) await p.close();
});

describe("selfbuilding.factory: agents as child tasks, accept in the parent", () => {
  it("runs a pipeline of agents; each agent() is a child run, never a wait in the parent", async () => {
    const h = setup({
      factories: (e) => ({
        ship: testFactory("ship", async (input: Json) => {
          const plan = await e.agent("Plan", input);
          const build = await e.agent("Build", plan.ok ? plan.result : null);
          return { plan: plan.ok, build: build.ok ? build.result : null };
        }),
      }),
    });
    const id = await startFactory(h, "ship", { issue: 1 }, "ns_ship");
    expect(h.t.run(id).status).toBe("WAITING");
    expect(agentRuns(h)).toHaveLength(1);
    const child = agentRuns(h)[0];
    expect(child?.idempotencyKey).toMatch(/^ns:ns_ship:[0-9a-f]{26}:e0$/);
    expect(child?.tags).toEqual(["ns_ship"]);
    expect(child?.parentRunId).toBe(id);

    await finish(h, "Plan#0", { steps: 2 });
    expect(agentRuns(h)).toHaveLength(2);
    await finish(h, "Build#0", "built");

    const out = factoryOutput(h, id);
    expect(out).toMatchObject({ runId: "ns_ship", epoch: 0, status: "ok", output: { plan: true, build: "built" } });
    expect(h.engine.accepts.get("Plan#0")).toBe(1);
    const record = (await h.store.get("runs/ns_ship/run.json")) as RunRecord;
    expect(record).toMatchObject({ epoch: 0, hostRunIds: [id], status: "ok", factory: "ship" });
    const registry = Object.keys(h.store.dump()).filter((k) => k.startsWith("runs/ns_ship/e0/children/"));
    expect(registry).toHaveLength(2);
  });

  it("Promise.all over agent() works: children run in parallel, the parent holds one wait at a time", async () => {
    const h = setup({
      factories: (e) => ({
        fan: testFactory("fan", async () => {
          const results = await Promise.all(["a", "b", "c"].map((x) => e.agent("Review", x)));
          return results.map((r) => (r.ok ? r.result : null));
        }),
      }),
    });
    const id = await startFactory(h, "fan", null);
    expect(agentRuns(h)).toHaveLength(3);
    for (const path of ["Review#2", "Review#0", "Review#1"]) await finish(h, path, path);
    expect(factoryOutput(h, id).output).toEqual(["Review#0", "Review#1", "Review#2"]);
  });

  it("enforces the per-run sandbox cap in the parent", async () => {
    const h = setup({
      sandboxes: 1,
      factories: (e) => ({
        fan: testFactory("fan", async () => Promise.all(["a", "b"].map((x) => e.agent("Review", x)))),
      }),
    });
    const id = await startFactory(h, "fan", null);
    expect(agentRuns(h)).toHaveLength(1);
    await finish(h, "Review#0", 1);
    expect(agentRuns(h)).toHaveLength(2);
    await finish(h, "Review#1", 2);
    expect(factoryOutput(h, id).status).toBe("ok");
  });

  it("a launch's limits tighten the per-run sandbox cap", async () => {
    const h = setup({
      sandboxes: 4,
      factories: (e) => ({
        fan: testFactory("fan", async () => Promise.all(["a", "b"].map((x) => e.agent("Review", x)))),
      }),
    });
    const run = await h.t.start(FACTORY_TASK_ID, { factory: "fan", input: null, limits: { sandboxes: 1 } });
    await h.t.settle();
    expect(agentRuns(h)).toHaveLength(1);
    await finish(h, "Review#0", 1);
    expect(agentRuns(h)).toHaveLength(2);
    await finish(h, "Review#1", 2);
    expect(factoryOutput(h, run.id).status).toBe("ok");
  });

  it("an agent failure is a value: the parent accepts it and the host never retries the turn", async () => {
    const h = setup({
      factories: (e) => ({ one: testFactory("one", async () => e.agent("Fix", null)) }),
    });
    const id = await startFactory(h, "one", null);
    await h.sim.failTurn(latest(h, "Fix#0").launchId, "tests failed");
    await h.t.settle();
    const value = factoryOutput(h, id).output as AgentValue;
    expect(value).toMatchObject({ ok: false, error: { code: "interrupted" } });
    expect(h.sim.starts).toBe(1);
    expect(agentRuns(h)[0]?.attempts).toBe(1);
  });

  it("runs a nested factory as a child run and returns its output", async () => {
    const h = setup({
      factories: (e) => {
        const inner = testFactory("inner", async (n: number) => {
          const r = await e.agent("Inner", n);
          return r.ok ? r.result : null;
        });
        return {
          inner,
          outer: testFactory("outer", async () => {
            const v = await e.host().child("sub", { name: "inner", factory: inner }, 5);
            return { nested: v };
          }),
        };
      },
    });
    const id = await startFactory(h, "outer", null, "ns_outer");
    const nested = h.t.runs({ taskId: FACTORY_TASK_ID }).filter((r) => r.id !== id);
    expect(nested).toHaveLength(1);
    expect(nested[0]?.idempotencyKey).toBe("ns:ns_outer:sub:e0");
    await finish(h, "Inner#0", "deep");
    expect(factoryOutput(h, id).output).toEqual({ nested: "deep" });
  });

  it("refuses the per-launch wait in the parent: it belongs to the agent child", async () => {
    const h = setup({
      factories: (e) => ({
        bad: testFactory("bad", async () =>
          e.host().waitForCallback("x_e0_l0", { timeoutMs: 1, rearm: 0, register: async () => {} }),
        ),
      }),
    });
    const id = await startFactory(h, "bad", null);
    expect(factoryOutput(h, id)).toMatchObject({ status: "failed", error: { code: "config" } });
  });

  it("an unknown factory fails the run with a config error, without retries", async () => {
    const h = setup();
    const run = await h.t.start(FACTORY_TASK_ID, { factory: "nope", input: null });
    await h.t.settle();
    expect(h.t.run(run.id).status).toBe("FAILED");
    expect(h.t.run(run.id).error?.message).toMatch(/No factory "nope".*Registered: noop/);
  });
});

describe("selfbuilding.factory: step(), sleep() and factory-side ask()", () => {
  it("a step's fn runs once; a crash and restart of the parent replays its value from the result store", async () => {
    let stepRuns = 0;
    const h = setup({
      factories: (e) => ({
        s: testFactory("s", async () => {
          const sha = await e.step("resolve-base", async () => {
            stepRuns += 1;
            return `sha-${stepRuns}`;
          });
          const r = await e.agent("Build", sha);
          return { sha, r: r.ok };
        }),
      }),
    });
    const id = await startFactory(h, "s", null);
    h.t.crash();
    h.t.restart();
    await h.t.settle();
    expect(stepRuns).toBe(1);
    expect(agentRuns(h)).toHaveLength(1);
    await finish(h, "Build#0", 1);
    expect(factoryOutput(h, id).output).toEqual({ sha: "sha-1", r: true });
  });

  it("sleep() is a scheduler deadline that survives a crash", async () => {
    const h = setup({
      factories: (e) => ({
        nap: testFactory("nap", async () => {
          await e.sleep("cool-down", 5 * 60_000);
          return "awake";
        }),
      }),
    });
    const id = await startFactory(h, "nap", null);
    expect(h.t.run(id).status).toBe("WAITING");
    await h.t.advance(3 * 60_000);
    h.t.crash();
    h.t.restart();
    await h.t.settle();
    expect(h.t.run(id).status).toBe("WAITING");
    await h.t.advance(2 * 60_000);
    await h.t.settle();
    expect(factoryOutput(h, id).output).toBe("awake");
  });

  function factoryAsk(askId: string, runId: string): AskRecord {
    return {
      askId,
      runId,
      ordinal: 1,
      callPath: "ask#0",
      origin: { kind: "factory", askSeq: 0 },
      specHash: "h",
      spec: { question: "Merge?" },
      status: "open",
      waitpoint: { host: "trigger", ref: "wake-stream" },
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T04:00:00.000Z",
    };
  }

  it("factory-side asks wait on the wake stream; concurrent asks work; the store holds the answer", async () => {
    const h = setup({
      factories: (e) => ({
        decide: testFactory("decide", async () => {
          const [a, b] = await Promise.all([e.ask("ask_a", 60 * 60_000), e.ask("ask_b", 60 * 60_000)]);
          return [a?.resolution?.choiceId ?? null, b?.resolution?.choiceId ?? null];
        }),
      }),
    });
    const asks = resultStoreAsks(h.store);
    await asks.create(factoryAsk("ask_a", "ns_ask"));
    await asks.create(factoryAsk("ask_b", "ns_ask"));
    const id = await startFactory(h, "decide", null, "ns_ask");
    expect(h.t.run(id).status).toBe("WAITING");
    const resolver = createTriggerAskResolver({ trigger: h.t, store: h.store });
    await resolver.resolve("ask_b", resolution("ask_b", "merge", { kind: "default", reason: "afk" }));
    await h.t.settle();
    expect(h.t.run(id).status).toBe("WAITING");
    const lost = await resolver.resolve("ask_b", resolution("ask_b", "hold", { kind: "default", reason: "afk" }));
    expect(lost.won).toBe(false);
    await resolver.resolve("ask_a", resolution("ask_a", "ship", { kind: "default", reason: "afk" }));
    await h.t.settle();
    expect(factoryOutput(h, id).output).toEqual(["ship", "merge"]);
  });

  it("a factory-side ask resolves to null when its timeout passes", async () => {
    const h = setup({
      factories: (e) => ({
        decide: testFactory("decide", async () => (await e.ask("ask_t", 30 * 60_000)) === null),
      }),
    });
    await resultStoreAsks(h.store).create(factoryAsk("ask_t", "ns_t2"));
    const id = await startFactory(h, "decide", null, "ns_t2");
    await h.t.advance(30 * 60_000);
    await h.t.settle();
    expect(factoryOutput(h, id).output).toBe(true);
  });

  it("an answer whose wake was lost is still picked up at the next reconcile (10 minutes)", async () => {
    const h = setup({
      factories: (e) => ({
        decide: testFactory("decide", async () => (await e.ask("ask_l", 4 * 60 * 60_000))?.status ?? null),
      }),
    });
    const asks = resultStoreAsks(h.store);
    await asks.create(factoryAsk("ask_l", "ns_l"));
    const id = await startFactory(h, "decide", null, "ns_l");
    await asks.resolve("ask_l", resolution("ask_l", "x", { kind: "default", reason: "afk" }));
    await h.t.settle();
    expect(h.t.run(id).status).toBe("WAITING");
    await h.t.advance(10 * 60_000);
    await h.t.settle();
    expect(factoryOutput(h, id).output).toBe("answered");
  });
});

describe("acceptance 3 on the Trigger host: crash + resume", () => {
  function shipFactory(prompts: { build: string }) {
    return (e: Harness["engine"]) => ({
      ship: testFactory("ship", async (input: Json) => {
        const plan = await e.agent("Plan", input);
        const build = await e.agent("Build", plan.ok ? plan.result : null, prompts.build);
        const review = await e.agent("Review", build.ok ? build.result : null);
        return {
          plan: plan.ok ? plan.result : null,
          build: build.ok ? build.result : { failed: build.error.code },
          review: review.ok ? review.result : null,
        };
      }),
    });
  }

  it("crash mid-run, edit a prompt, resume: finished calls replay, the edited call and later ones run live", async () => {
    const prompts = { build: "build v1" };
    const h = setup({ factories: shipFactory(prompts) });
    const id = await startFactory(h, "ship", { spec: "x" }, "ns_crash");
    await finish(h, "Plan#0", "the plan");
    expect(h.sim.list("Build#0")).toHaveLength(1);

    // The worker dies mid-Build; the next deploy carries an edited Build prompt.
    h.t.crash();
    prompts.build = "build v2";
    h.t.restart();
    await h.t.settle();

    // Plan replays from the result store: no new child, no new launch, accept not re-run.
    expect(h.sim.list("Plan#0")).toHaveLength(1);
    expect(h.engine.accepts.get("Plan#0")).toBe(1);
    expect(
      agentRuns(h).filter((r) => (r.payload as { call: { callPath: string } }).call.callPath === "Plan#0"),
    ).toHaveLength(1);
    // The edited Build is a new step: it runs live.
    expect(h.sim.list("Build#0")).toHaveLength(2);
    const [oldBuild, newBuild] = h.sim.list("Build#0");
    expect(oldBuild?.call.stepKey).not.toBe(newBuild?.call.stepKey);

    await finish(h, "Build#0", "built v2");
    await finish(h, "Review#0", "lgtm");
    const out = factoryOutput(h, id);
    expect(out.output).toEqual({ plan: "the plan", build: "built v2", review: "lgtm" });
    // The v1 Build child was never visited by the replay: the orphan sweep cancelled it.
    expect(out.orphans).toEqual([oldBuild?.call.stepKey]);
    const oldChild = agentRuns(h).find(
      (r) => (r.payload as { call: { stepKey: string } }).call.stepKey === oldBuild?.call.stepKey,
    );
    expect(oldChild?.status).toBe("CANCELED");
  });

  it("an unedited in-flight call reattaches after the crash: one harness start, one child run", async () => {
    const prompts = { build: "same" };
    const h = setup({ factories: shipFactory(prompts) });
    const id = await startFactory(h, "ship", null, "ns_reattach");
    await finish(h, "Plan#0", "p");
    h.t.crash();
    h.t.restart();
    await h.t.settle();
    expect(h.sim.list("Build#0")).toHaveLength(1);
    expect(agentRuns(h)).toHaveLength(2);
    await finish(h, "Build#0", "b");
    await finish(h, "Review#0", "r");
    expect(factoryOutput(h, id)).toMatchObject({ status: "ok", orphans: [] });
    expect(h.sim.starts).toBe(3);
  });

  it("an interrupted call is never silently re-run; a resume (new epoch) re-runs it and serves successes from cache", async () => {
    const prompts = { build: "same" };
    const h = setup({ factories: shipFactory(prompts) });
    const first = await startFactory(h, "ship", null, "ns_epoch");
    await finish(h, "Plan#0", "p");
    const buildLaunch = latest(h, "Build#0").launchId;

    // The crash also kills the harness mid-turn.
    h.t.crash();
    await h.sim.die(buildLaunch);
    h.t.restart();
    await h.t.settle();
    expect(h.sim.list("Build#0")).toHaveLength(1);
    await finish(h, "Review#0", "reviewed nothing");
    const out = factoryOutput(h, first);
    expect(out.output).toMatchObject({ build: { failed: "interrupted" } });
    expect(h.sim.starts).toBe(3);

    // Resume with the same run id: a new parent run at epoch 1.
    const second = await startFactory(h, "ship", null, "ns_epoch");
    expect(h.sim.list("Plan#0")).toHaveLength(1);
    expect(h.sim.list("Build#0")).toHaveLength(2);
    expect(latest(h, "Build#0").launchId).toMatch(/_e1_l0$/);
    await finish(h, "Build#0", "b2");
    await finish(h, "Review#0", "r2");
    expect(factoryOutput(h, second)).toMatchObject({
      epoch: 1,
      status: "ok",
      output: { plan: "p", build: "b2", review: "r2" },
    });
    const record = (await h.store.get("runs/ns_epoch/run.json")) as RunRecord;
    expect(record).toMatchObject({ epoch: 1, hostRunIds: [first, second], status: "ok" });
  });

  it("a second host run for a run that is still live attaches instead of bumping the epoch", async () => {
    const h = setup({
      factories: (e) => ({ one: testFactory("one", async () => e.agent("A", null)) }),
    });
    const first = await startFactory(h, "one", null, "ns_live");
    const second = await startFactory(h, "one", null, "ns_live");
    expect(factoryOutput(h, second)).toMatchObject({ status: "attached", hostRunId: first, epoch: 0 });
    expect(agentRuns(h)).toHaveLength(1);
  });

  it("a run id bound to another factory is refused", async () => {
    const h = setup({
      factories: (e) => ({
        one: testFactory("one", async () => e.agent("A", null)),
        two: testFactory("two", async () => 2),
      }),
    });
    await startFactory(h, "one", null, "ns_bound");
    await finish(h, "A#0", 1);
    const run = await h.t.start(FACTORY_TASK_ID, { factory: "two", input: null, runId: "ns_bound" });
    await h.t.settle();
    expect(h.t.run(run.id).status).toBe("FAILED");
    expect(h.t.run(run.id).error?.message).toMatch(/belongs to factory "one"/);
  });
});

describe("cancellation", () => {
  it("cancelling the parent cancels children, cancels open asks and kills the run's sandboxes by label", async () => {
    const provider = tmpdirProvider();
    providers.push(provider);
    const h = setup({
      sim: { provider },
      providers: [provider],
      factories: (e) => ({
        fan: testFactory("fan", async () => Promise.all([e.agent("A", 1), e.agent("B", 2)])),
      }),
    });
    const asks = resultStoreAsks(h.store);
    const id = await startFactory(h, "fan", null, "ns_cancel");
    await asks.create({
      askId: "ask_c",
      runId: "ns_cancel",
      ordinal: 1,
      callPath: "A#0",
      origin: { kind: "agent", launchId: "x_e0_l0", askSeq: 0 },
      specHash: "h",
      spec: { question: "?" },
      status: "open",
      waitpoint: { host: "trigger", ref: "w" },
      messages: [],
      createdAt: "t",
      expiresAt: "t",
    });
    const boxes = async () => {
      const out: string[] = [];
      for await (const ref of provider.list({ deployment: "test", runId: "ns_cancel" })) out.push(ref.id);
      return out;
    };
    expect(await boxes()).toHaveLength(2);

    await h.t.cancelRun(id);
    await h.t.settle();
    expect(h.t.hookErrors).toEqual([]);
    expect(await boxes()).toEqual([]);
    expect(agentRuns(h).map((r) => r.status)).toEqual(["CANCELED", "CANCELED"]);
    expect((await asks.get("ask_c"))?.status).toBe("cancelled");
    expect(((await h.store.get("runs/ns_cancel/run.json")) as RunRecord).status).toBe("cancelled");
  });
});

describe("selfbuilding.reaper", () => {
  it("is scheduled every 2 minutes and calls reap() with the deployment's providers, journal, asks and host", async () => {
    const provider = tmpdirProvider();
    providers.push(provider);
    const h = setup({ providers: [provider] });
    expect(h.t.schedules()).toEqual([{ id: REAPER_TASK_ID, cron: "*/2 * * * *" }]);
    const run = await h.t.fireSchedule(REAPER_TASK_ID);
    await h.t.settle();
    expect(h.t.run(run.id).status).toBe("COMPLETED");
    expect(h.reapCalls).toHaveLength(1);
    const opts = h.reapCalls[0];
    expect(opts?.deployment).toBe("test");
    expect(opts?.providers).toEqual([provider]);
    expect(opts?.host?.id).toBe("trigger");
    expect(typeof opts?.journal.get).toBe("function");
    expect(typeof opts?.asks.resolve).toBe("function");
    await expect(opts?.host?.step("x", async () => 1)).rejects.toBeInstanceOf(ConfigError);
  });

  it("repairs a lost callback: completes the launch's armed token and ticks the parent", async () => {
    const h = setup({
      factories: (e) => ({ one: testFactory("one", async () => e.agent("A", null)) }),
      reap: async (opts, hh) => {
        for (const launch of hh.sim.list()) {
          if (launch.state !== "outcome") continue;
          await opts.host?.deliverCallback?.({
            v: 1,
            runId: launch.call.runId,
            stepKey: launch.call.stepKey,
            launchId: launch.launchId,
            status: "finished",
            rearm: 0,
            source: "reaper",
            at: new Date(hh.t.now()).toISOString(),
          });
        }
        return { killed: 0, parked: 0, held: 0, leaked: 0, errors: [], decisions: [] };
      },
    });
    const id = await startFactory(h, "one", null, "ns_lost");
    const launch = latest(h, "A#0");
    // The turn finishes but its callback never arrives.
    launch.state = "outcome";
    launch.outcome = {
      ok: true,
      launchId: launch.launchId,
      result: "late",
      artifacts: {} as never,
      usage: { usd: 0, inputTokens: 0, outputTokens: 0, turns: 1, wallClockMs: 0, sandboxMs: 0 },
    };
    await h.t.settle();
    expect(h.t.run(id).status).toBe("WAITING");
    expect(h.reapCalls).toHaveLength(0);
    await h.t.fireSchedule(REAPER_TASK_ID);
    await h.t.settle();
    expect((factoryOutput(h, id).output as AgentValue).ok).toBe(true);
    const token = h.t.tokens().find((t) => t.idempotencyKey === `ns:ns_lost:${launch.launchId}:done:w0`);
    expect(token?.output).toMatchObject({ source: "reaper", status: "finished" });
  });

  it("reports host run status for the reaper's owner check", async () => {
    const h = setup({
      factories: (e) => ({ one: testFactory("one", async () => e.agent("A", null)) }),
      reap: async (opts) => {
        const parent = h.t.runs({ taskId: FACTORY_TASK_ID })[0]?.id ?? "";
        statuses.push(await (opts.host?.runStatus?.(parent) ?? "missing"));
        statuses.push(await (opts.host?.runStatus?.("run_missing") ?? "missing"));
        return { killed: 0, parked: 0, held: 0, leaked: 0, errors: [], decisions: [] };
      },
    });
    const statuses: string[] = [];
    await startFactory(h, "one", null, "ns_status");
    await h.t.fireSchedule(REAPER_TASK_ID);
    await h.t.settle();
    await finish(h, "A#0", 1);
    await h.t.fireSchedule(REAPER_TASK_ID);
    await h.t.settle();
    expect(statuses).toEqual(["waiting", "not-found", "terminal", "not-found"]);
  });
});

describe("agent asks through the resolver", () => {
  it("completes the agent ask's waitpoint token from the record", async () => {
    const h = setup({
      factories: (e) => ({ one: testFactory("one", async () => e.agent("A", null)) }),
    });
    const id = await startFactory(h, "one", null, "ns_hot");
    const launch = latest(h, "A#0");
    await h.sim.ask(launch.launchId, "ask_agent");
    await h.t.settle();
    const waitpoint = h.sim.asks.get("ask_agent")?.waitpoint;
    if (!waitpoint) throw new Error("no waitpoint");
    const res = resolution("ask_agent", "yes", { kind: "default", reason: "afk" });
    h.sim.asks.set("ask_agent", { waitpoint, resolution: res });
    const resolver = createTriggerAskResolver({ trigger: h.t, store: h.store });
    await resolver.wake({
      askId: "ask_agent",
      runId: "ns_hot",
      ordinal: 1,
      callPath: "A#0",
      origin: { kind: "agent", launchId: launch.launchId, askSeq: 0 },
      specHash: "h",
      spec: { question: "?" },
      status: "answered",
      resolution: res,
      waitpoint: { host: "trigger", ref: waitpoint.ref },
      messages: [],
      createdAt: "t",
      expiresAt: "t",
    });
    await h.t.settle();
    expect(launch.answers.map((a) => a.choiceId)).toEqual(["yes"]);
    await finish(h, "A#0", "done");
    expect(factoryOutput(h, id).status).toBe("ok");
  });
});

describe("createTriggerHost", () => {
  it("requires config.deployment", () => {
    expect(() =>
      createTriggerHost({
        config: {},
        factories: { a: testFactory("a", async () => 1) },
        trigger: createLocalTrigger(),
      }),
    ).toThrow(ConfigError);
  });

  it("requires at least one factory", () => {
    expect(() =>
      createTriggerHost({ config: { deployment: "test" }, factories: {}, trigger: createLocalTrigger() }),
    ).toThrow(ConfigError);
  });

  it("refuses to run on a store without conditional writes", async () => {
    const t = createLocalTrigger();
    const inner = memoryResultStore();
    createTriggerHost({
      config: { deployment: "test" },
      factories: { a: testFactory("a", async () => 1) },
      trigger: t,
      store: { ...inner, createIfAbsent: async () => true },
    });
    const run = await t.start(FACTORY_TASK_ID, { factory: "a", input: null });
    await t.settle();
    expect(t.run(run.id).error?.message).toMatch(/create-if-absent/);
  });

  it("without a driver option, the agent child uses core's agentCallDriver", async () => {
    const t = createLocalTrigger({ maxAttempts: 1 });
    createTriggerHost({
      config: { deployment: "test" },
      factories: { a: testFactory("a", async () => 1) },
      trigger: t,
      store: memoryResultStore(),
    });
    const run = await t.start(AGENT_TASK_ID, {
      call: { runId: "ns_x", epoch: 0, stepKey: "s", callPath: "A#0", launch: 0, spec: null },
    });
    await t.settle();
    // Core's driver reads the call spec it wrote; a spec from elsewhere fails with a message naming the fix.
    expect(t.run(run.id).error?.message).toMatch(/carries a spec this version of @selfbuilding\/core cannot read/);
  });

  it("builds the three tasks on the real Trigger.dev SDK without touching the network", () => {
    const host = createTriggerHost({
      config: { deployment: "test" },
      factories: { a: testFactory("a", async () => 1) },
      trigger: realTriggerSdk(),
      store: memoryResultStore(),
    });
    expect((host.factoryTask as { id: string }).id).toBe("selfbuilding.factory");
    expect((host.agentTask as { id: string }).id).toBe("selfbuilding.agent");
    expect((host.reaperTask as { id: string }).id).toBe("selfbuilding.reaper");
  });
});
