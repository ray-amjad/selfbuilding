import type { Json, RawOutcome } from "@selfbuilding/core";
import { tmpdirProvider } from "@selfbuilding/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_TASK_ID, launchIdOf, wakeTokenKey } from "../src/index.js";
import { agentCall, setup } from "./setup.js";

const L0 = launchIdOf(agentCall(), 0);
const L1 = launchIdOf(agentCall(), 1);

async function startChild(h: ReturnType<typeof setup>, over = {}) {
  const run = await h.t.start(AGENT_TASK_ID, { call: agentCall(over) } as unknown as Json);
  await h.t.settle();
  return run.id;
}

function output(h: ReturnType<typeof setup>, id: string): RawOutcome {
  const run = h.t.run(id);
  expect(run.status).toBe("COMPLETED");
  return run.output as RawOutcome;
}

describe("selfbuilding.agent: launch → wait → collect", () => {
  it("waits on one token keyed on the launch id, hands its URL to the sandbox, then collects", async () => {
    const h = setup();
    const id = await startChild(h);
    expect(h.sim.starts).toBe(1);
    expect(h.t.run(id).status).toBe("WAITING");
    const tokens = h.t.tokens();
    expect(tokens.map((t) => t.idempotencyKey)).toEqual([wakeTokenKey("ns_t", L0, 0)]);
    expect(tokens[0]?.idempotencyKey).toBe(`ns:ns_t:step1_e0_l0:done:w0`);
    // The token's timeout is the call timeout + 30 min, set on createToken.
    expect(tokens[0]?.timeoutAt).toBe(h.t.now() + 90 * 60_000);
    expect(h.sim.only("Review#0").wakes).toEqual([0]);

    await h.sim.finish(L0, { verdict: "approve" });
    await h.t.settle();
    const out = output(h, id);
    expect(out).toMatchObject({ ok: true, launchId: L0, result: { verdict: "approve" } });
    expect(h.sim.log.filter((l) => l.startsWith("collect"))).toEqual([`collect ${L0}`]);
  });

  it("re-arms with a new token on premature wakes, and treats the fourth as a wait timeout", async () => {
    const h = setup();
    const id = await startChild(h);
    for (let i = 0; i < 3; i++) {
      await h.sim.spuriousWake(L0);
      await h.t.settle();
    }
    expect(h.sim.only("Review#0").wakes).toEqual([0, 1, 2, 3]);
    expect(h.t.run(id).status).toBe("WAITING");
    await h.sim.spuriousWake(L0);
    await h.t.settle();
    expect(h.sim.log).toContain(`stop ${L0} wait-timeout`);
    expect(output(h, id)).toMatchObject({ ok: false, launchId: L0, error: { code: "interrupted" } });
  });

  it("on a wait timeout with the turn still running: stops it, waits for its outcome, collects", async () => {
    const h = setup({ sim: { callMs: 60_000 } });
    const id = await startChild(h);
    await h.t.advance(60_000 + 30 * 60_000);
    await h.t.settle();
    expect(h.sim.only("Review#0").stops).toBe(1);
    expect(h.sim.log).toContain(`collect ${L0}`);
    expect(output(h, id).ok).toBe(false);
  });

  it("a stopped turn that never writes an outcome becomes an interrupted value after the grace", async () => {
    const h = setup({ sim: { callMs: 60_000, onStop: "ignore" } });
    const id = await startChild(h);
    await h.t.advance(31 * 60_000);
    await h.t.settle();
    expect(h.t.run(id).status).toBe("WAITING");
    await h.t.advance(5 * 60_000);
    await h.t.settle();
    expect(h.sim.log).toContain(`interrupted ${L0} wait-timeout`);
    expect(output(h, id)).toMatchObject({ ok: false, error: { code: "interrupted" } });
  });

  it("an unknown probe after the timeout leaves the sandbox alone (no stop) and reports interrupted", async () => {
    const h = setup({ sim: { callMs: 1000 } });
    const id = await startChild(h);
    const launch = h.sim.only("Review#0");
    launch.state = "unknown";
    await h.t.advance(31 * 60_000);
    await h.t.settle();
    expect(launch.stops).toBe(0);
    expect(h.sim.log).toContain(`interrupted ${L0} unknown`);
    expect(output(h, id).ok).toBe(false);
  });

  it("a turn that died (lock FREE, no outcome) is interrupted, never re-launched", async () => {
    const h = setup();
    const id = await startChild(h);
    await h.sim.die(L0);
    await h.t.settle();
    expect(output(h, id)).toMatchObject({ ok: false, error: { code: "interrupted" } });
    expect(h.sim.starts).toBe(1);
  });

  it("returns a recorded outcome without creating or starting anything (launch is idempotent)", async () => {
    const h = setup();
    const recorded: RawOutcome = {
      ok: false,
      launchId: L0,
      error: { name: "X", code: "interrupted", kind: "agent", retryable: false, message: "m" },
    };
    h.sim.outcomeRecords.set(L0, recorded);
    const id = await startChild(h);
    expect(h.sim.starts).toBe(0);
    expect(h.t.tokens()).toHaveLength(0);
    expect(output(h, id)).toEqual(recorded);
  });

  it("sends a child wake to the parent run when it finishes", async () => {
    const h = setup();
    h.t.task({ id: "parent", run: async () => h.t.waitWake({ timeoutMs: 60_000 }) });
    const parent = await h.t.start("parent", null);
    await h.t.settle();
    const child = await h.t.start(AGENT_TASK_ID, { call: agentCall(), parentRunId: parent.id } as unknown as Json);
    await h.t.settle();
    await h.sim.finish(L0, 1);
    await h.t.settle();
    expect(h.t.run(parent.id).output).toEqual({
      ok: true,
      output: { kind: "child", hostKey: "step1_e0", childRunId: child.id },
    });
  });
});

describe("selfbuilding.agent: crash and retry", () => {
  it("a crash mid-wait restarts the child from the top: it reattaches, reuses its token, starts no second harness", async () => {
    const h = setup();
    const id = await startChild(h);
    h.t.crash();
    h.t.restart();
    await h.t.settle();
    expect(h.sim.starts).toBe(1);
    expect(h.t.tokens()).toHaveLength(1);
    expect(h.sim.log.filter((l) => l === `launch ${L0}`)).toHaveLength(2);
    await h.sim.finish(L0, "done");
    await h.t.settle();
    expect(output(h, id)).toMatchObject({ ok: true, result: "done" });
  });

  it("a callback that lands while the worker is down is not lost: the restarted wait returns at once", async () => {
    const h = setup();
    const id = await startChild(h);
    h.t.crash();
    await h.sim.finish(L0, "while-down");
    h.t.restart();
    await h.t.settle();
    expect(output(h, id)).toMatchObject({ ok: true, result: "while-down" });
    expect(h.sim.starts).toBe(1);
  });
});

describe("selfbuilding.agent: ask_human", () => {
  it("hot ask: waits on the ask's own token (key: askId), delivers the answer, re-arms the launch wait", async () => {
    const h = setup();
    const id = await startChild(h);
    await h.sim.ask(L0, "ask_hot");
    await h.t.settle();
    const askToken = h.t.tokens().find((t) => t.idempotencyKey === "ask_hot");
    expect(askToken).toBeDefined();
    expect(h.sim.asks.get("ask_hot")?.waitpoint).toEqual({ host: "trigger", ref: askToken?.id });
    expect(h.t.run(id).status).toBe("WAITING");

    await h.sim.answer("ask_hot", "yes");
    await h.t.settle();
    const launch = h.sim.only("Review#0");
    expect(launch.answers.map((a) => a.choiceId)).toEqual(["yes"]);
    expect(launch.wakes).toEqual([0, 1]);

    await h.sim.finish(L0, "after-answer");
    await h.t.settle();
    expect(output(h, id)).toMatchObject({ ok: true, launchId: L0 });
  });

  it("a hot ask that goes cold before the answer resumes as the next launch with the answer", async () => {
    const h = setup();
    const id = await startChild(h);
    await h.sim.ask(L0, "ask_slow");
    await h.t.settle();
    h.sim.goCold(L0);
    await h.sim.answer("ask_slow", "hold");
    await h.t.settle();
    expect(h.sim.starts).toBe(2);
    const resumed = h.sim.launches.get(L1);
    expect(resumed?.resumedWith?.choiceId).toBe("hold");
    await h.sim.finish(L1, "resumed");
    await h.t.settle();
    expect(output(h, id)).toMatchObject({ ok: true, launchId: L1, result: "resumed" });
  });

  it("cold ask: relaunches only after the answer; a crash while parked does not relaunch twice", async () => {
    const h = setup();
    const id = await startChild(h);
    await h.sim.ask(L0, "ask_cold", { cold: true });
    await h.t.settle();
    h.t.crash();
    h.t.restart();
    await h.t.settle();
    expect(h.sim.starts).toBe(1);
    await h.sim.answer("ask_cold", "go");
    await h.t.settle();
    expect(h.sim.starts).toBe(2);
    await h.sim.finish(L1, "ok");
    await h.t.settle();
    expect(output(h, id)).toMatchObject({ ok: true, launchId: L1 });
  });

  it("an answer already in the store is used without waiting (store first)", async () => {
    const h = setup();
    const id = await startChild(h);
    h.sim.asks.set("ask_pre", {
      resolution: {
        askId: "ask_pre",
        answer: { kind: "choice", choiceId: "pre" },
        choiceId: "pre",
        answeredBy: { kind: "default", reason: "afk" },
        answeredAt: "t",
      },
    });
    await h.sim.ask(L0, "ask_pre");
    await h.t.settle();
    expect(h.sim.only("Review#0").answers.map((a) => a.choiceId)).toEqual(["pre"]);
    expect(h.t.run(id).status).toBe("WAITING");
  });

  it("ask timeout with an AFK default answers and continues", async () => {
    const h = setup({ sim: { onAskTimeout: "default" } });
    const id = await startChild(h);
    await h.sim.ask(L0, "ask_afk", { timeoutMs: 10 * 60_000 });
    await h.t.settle();
    await h.t.advance(10 * 60_000);
    await h.t.settle();
    expect(h.sim.log).toContain("expire ask_afk");
    expect(h.sim.only("Review#0").answers[0]?.answeredBy).toEqual({ kind: "default", reason: "timeout" });
    await h.sim.finish(L0, "x");
    await h.t.settle();
    expect(output(h, id).ok).toBe(true);
  });

  it("ask timeout with onTimeout fail ends the call as an AskTimeoutError value", async () => {
    const h = setup();
    const id = await startChild(h);
    await h.sim.ask(L0, "ask_fail", { timeoutMs: 60_000 });
    await h.t.settle();
    await h.t.advance(60_000);
    await h.t.settle();
    expect(output(h, id)).toMatchObject({ ok: false, error: { code: "ask_timeout" } });
  });
});

describe("selfbuilding.agent: cancellation", () => {
  const providers: ReturnType<typeof tmpdirProvider>[] = [];
  afterEach(async () => {
    for (const p of providers.splice(0)) await p.close();
  });

  it("cancelling the child kills its step's sandboxes by label and leaves other steps alone", async () => {
    const provider = tmpdirProvider();
    providers.push(provider);
    const h = setup({ sim: { provider }, providers: [provider] });
    const a = await startChild(h, { stepKey: "stepA", callPath: "A#0" });
    await startChild(h, { stepKey: "stepB", callPath: "B#0" });
    const before: string[] = [];
    for await (const ref of provider.list({ deployment: "test", runId: "ns_t" }))
      before.push(ref.labels["selfbuilding.step"] ?? "");
    expect(before.sort()).toEqual(["stepA_e0", "stepB_e0"]);

    expect(h.t.run(a).status).toBe("WAITING");
    await h.t.cancelRun(a);
    expect(h.t.hookErrors).toEqual([]);
    const after: string[] = [];
    for await (const ref of provider.list({ deployment: "test", runId: "ns_t" }))
      after.push(ref.labels["selfbuilding.step"] ?? "");
    expect(after).toEqual(["stepB_e0"]);
    expect(h.t.run(a).status).toBe("CANCELED");
  });
});
