import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentCallDriver,
  type AskRecord,
  agent,
  factory,
  fileArtifacts,
  type HostAgentCall,
  type Json,
  type LaunchId,
  launchDepthOf,
  noteLaunchedBy,
  type RawOutcome,
  type ResultStore,
  redactForRun,
  type SandboxRef,
  type SelfbuildingConfig,
} from "@selfbuilding/core";
import { scriptedHarness, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_TASK_ID,
  type AgentTaskPayload,
  createLocalTrigger,
  createTriggerAskResolver,
  createTriggerHost,
  FACTORY_TASK_ID,
  type FactoryTaskPayload,
  fileResultStore,
  type LocalTrigger,
  launchIdOf,
  memoryResultStore,
  resultStoreAsks,
  triggerWorkflowLauncher,
} from "../src/index.js";
import { testEngine, testFactory } from "./engine.js";
import { agentCall, setup } from "./setup.js";
import { resolution, SimDriver } from "./sim-driver.js";

// release-prep §3: what a deployed Trigger.dev project needs from the host. A result store every machine can reach,
// cold markers, AFK runs, redaction and box time across child tasks, launch depth in the child, and a waitpoint
// completion that is allowed to get lost.

const dirs: string[] = [];
const providers: ReturnType<typeof tmpdirProvider>[] = [];
afterAll(async () => {
  await Promise.all(providers.map((p) => p.close()));
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sbt-deployed-"));
  dirs.push(dir);
  return dir;
}

async function finished(t: LocalTrigger, id: string) {
  for (let i = 0; i < 2000 && !["COMPLETED", "FAILED", "SYSTEM_FAILURE"].includes(t.run(id).status); i++) {
    await t.settle();
  }
  return t.run(id);
}

const REFUSAL = "A deployed Trigger.dev run needs a result store every machine can reach.";

describe("a deployed run refuses a store only one machine can reach", () => {
  const host = (t: LocalTrigger, store?: ResultStore) => {
    const engine = testEngine();
    createTriggerHost({
      config: { deployment: "test" },
      factories: { noop: testFactory("noop", async () => "ran") },
      trigger: t,
      ...(store ? { store } : {}),
      driver: new SimDriver(t),
      runFactory: engine.runFactory,
      settleMs: 0,
    });
  };

  it.each([
    ["memoryResultStore", () => memoryResultStore()],
    ["fileResultStore", async () => fileResultStore(await freshDir())],
    ["the default store", () => undefined],
  ])("%s in PRODUCTION: the factory and agent tasks fail with the ConfigError naming the fix", async (_name, make) => {
    const t = createLocalTrigger({ environment: "PRODUCTION", maxAttempts: 1 });
    host(t, await make());
    const parent = await t.start(FACTORY_TASK_ID, { factory: "noop", input: null });
    const child = await t.start(AGENT_TASK_ID, { call: agentCall() } as unknown as Json);
    for (const id of [parent.id, child.id]) {
      const run = await finished(t, id);
      expect(run.status).toBe("FAILED");
      expect(run.error?.name).toBe("ConfigError");
      expect(run.error?.message).toContain(REFUSAL);
      expect(run.error?.message).toContain("r2ResultStoreFromEnv(process.env)");
    }
  });

  it("trigger.dev dev keeps the local stores", async () => {
    const t = createLocalTrigger({ environment: "DEVELOPMENT" });
    host(t, fileResultStore(await freshDir()));
    const { id } = await t.start(FACTORY_TASK_ID, { factory: "noop", input: null });
    expect(await finished(t, id)).toMatchObject({ status: "COMPLETED", output: { status: "ok", output: "ran" } });
  });

  it("a deployed run takes any other store", async () => {
    const t = createLocalTrigger({ environment: "PRODUCTION" });
    const inner = memoryResultStore();
    // Any store the host did not make itself, e.g. s3ResultStore: here a plain wrapper over memory.
    const shared: ResultStore = {
      get: (k) => inner.get(k),
      createIfAbsent: (k, v) => inner.createIfAbsent(k, v),
      getVersioned: (k) => inner.getVersioned(k),
      replace: (k, v, e) => inner.replace(k, v, e),
      list: (p) => inner.list(p),
    };
    host(t, shared);
    const { id } = await t.start(FACTORY_TASK_ID, { factory: "noop", input: null });
    expect(await finished(t, id)).toMatchObject({ status: "COMPLETED", output: { status: "ok" } });
  });
});

function askRecord(askId: string, over: Partial<AskRecord> = {}): AskRecord {
  return {
    askId,
    runId: "ns_t",
    ordinal: 1,
    callPath: "Review#0",
    origin: { kind: "agent", launchId: launchIdOf(agentCall(), 0), askSeq: 1 },
    specHash: "h",
    spec: { question: "Ship?", choices: ["yes", "no"] },
    status: "open",
    waitpoint: { host: "trigger", ref: "pending" },
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T04:00:00.000Z",
    ...over,
  } as AskRecord;
}

describe("resultStoreAsks", () => {
  const cold = { since: "2026-01-01T00:10:00.000Z", sessionId: "sess_1", launch: 1 };

  it("markCold is a compare-and-set on open: kept through an answer, never set on a settled ask", async () => {
    const asks = resultStoreAsks(memoryResultStore());
    if (!asks.markCold) throw new Error("resultStoreAsks implements markCold()");
    await asks.create(askRecord("ask_cold"));
    expect((await asks.markCold("ask_cold", cold))?.cold).toEqual(cold);
    await asks.resolve("ask_cold", resolution("ask_cold", "yes", { kind: "default", reason: "afk" }));
    expect(await asks.get("ask_cold")).toMatchObject({ status: "answered", cold, resolution: { choiceId: "yes" } });

    await asks.create(askRecord("ask_late"));
    await asks.resolve("ask_late", resolution("ask_late", "no", { kind: "default", reason: "afk" }));
    const after = await asks.markCold("ask_late", cold);
    expect(after?.status).toBe("answered");
    expect(after?.cold).toBeUndefined();
    expect(await asks.markCold("ask_nope", cold)).toBeNull();
  });

  it("an answer racing markCold: exactly one of them sees the ask open, and the answer always stands", async () => {
    for (let i = 0; i < 10; i++) {
      const asks = resultStoreAsks(memoryResultStore());
      await asks.create(askRecord(`ask_race_${i}`));
      const [marked, answered] = await Promise.all([
        asks.markCold?.(`ask_race_${i}`, cold),
        asks.resolve(`ask_race_${i}`, resolution(`ask_race_${i}`, "yes", { kind: "default", reason: "afk" })),
      ]);
      expect(answered.won).toBe(true);
      const stored = await asks.get(`ask_race_${i}`);
      expect(stored?.status).toBe("answered");
      expect(stored?.cold === undefined).toBe(marked?.cold === undefined);
    }
  });

  it("lists every record of a run and patches messages without duplicates", async () => {
    const asks = resultStoreAsks(memoryResultStore());
    const msg = (id: string) => ({ channel: "slack", thread: { channel: "slack", id: "t1" }, id });
    await asks.create(askRecord("ask_a", { messages: [msg("m1")] }));
    await asks.create(askRecord("ask_b", { runId: "ns_other" }));
    await asks.patch?.("ask_a", { messages: [msg("m1"), msg("m2")], reconciledAt: "2026-01-01T01:00:00.000Z" });
    const listed: AskRecord[] = [];
    for await (const r of asks.list?.({ runId: "ns_t" }) ?? []) listed.push(r);
    expect(listed.map((r) => r.askId)).toEqual(["ask_a"]);
    expect(listed[0]?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(listed[0]?.reconciledAt).toBe("2026-01-01T01:00:00.000Z");
  });

  it("the agent child marks a cold ask in the store with its box, session and launch", async () => {
    const h = setup();
    const asks = resultStoreAsks(h.store);
    await asks.create(askRecord("ask_parked"));
    await h.t.start(AGENT_TASK_ID, { call: agentCall() } as unknown as Json);
    await h.t.settle();
    const L0 = launchIdOf(agentCall(), 0);
    await h.sim.ask(L0, "ask_parked", { cold: true });
    await h.t.settle();
    const record = await asks.get("ask_parked");
    expect(record?.cold).toMatchObject({ launch: 0, sandbox: { id: `box-${L0}` } });
    expect(record?.status).toBe("open");
  });

  it("a hot ask that goes cold in the box is marked cold when the wait slice ends", async () => {
    const h = setup();
    const asks = resultStoreAsks(h.store);
    await asks.create(askRecord("ask_cooling"));
    await h.t.start(AGENT_TASK_ID, { call: agentCall() } as unknown as Json);
    await h.t.settle();
    const L0 = launchIdOf(agentCall(), 0);
    await h.sim.ask(L0, "ask_cooling");
    await h.t.settle();
    expect((await asks.get("ask_cooling"))?.cold).toBeUndefined();
    h.sim.goCold(L0);
    await h.t.advance(10 * 60_000);
    await h.t.settle();
    expect((await asks.get("ask_cooling"))?.cold).toMatchObject({ launch: 0 });
    // The answer, through the store and the waitpoint the slice took over, resumes the session as the next launch.
    h.sim.readAnswer = async (askId) => {
      const r = await asks.get(askId);
      return r?.status === "answered" && r.resolution ? r.resolution : null;
    };
    const answer = resolution("ask_cooling", "go", { kind: "human", channel: "slack", userId: "U1", displayName: "a" });
    await createTriggerAskResolver({ trigger: h.t, store: h.store }).resolve("ask_cooling", answer);
    await h.t.settle();
    expect(h.sim.starts).toBe(2);
    expect(h.sim.launches.get(launchIdOf(agentCall(), 1))?.resumedWith?.choiceId).toBe("go");
  });
});

describe("a lost waitpoint completion costs at most one wait slice", () => {
  it("an answer in the store whose completion never came is picked up when the slice ends", async () => {
    const h = setup();
    const id = (await h.t.start(AGENT_TASK_ID, { call: agentCall() } as unknown as Json)).id;
    await h.t.settle();
    const L0 = launchIdOf(agentCall(), 0);
    await h.sim.ask(L0, "ask_lost");
    await h.t.settle();
    // Store written, completion lost: nothing wakes the child.
    h.sim.asks.set("ask_lost", {
      ...h.sim.asks.get("ask_lost"),
      resolution: resolution("ask_lost", "yes", { kind: "human", channel: "slack", userId: "U1", displayName: "a" }),
    });
    await h.t.settle();
    expect(h.sim.only("Review#0").answers).toEqual([]);
    await h.t.advance(10 * 60_000);
    await h.t.settle();
    expect(h.sim.only("Review#0").answers.map((a) => a.choiceId)).toEqual(["yes"]);
    await h.sim.finish(L0, "done");
    await h.t.settle();
    expect(h.t.run(id)).toMatchObject({ status: "COMPLETED", output: { ok: true } });
  });

  it("each later slice takes over the ask's waitpoint, so an answer then wakes the child at once", async () => {
    const h = setup();
    const asks = resultStoreAsks(h.store);
    h.sim.readAnswer = async (askId) => {
      const r = await asks.get(askId);
      return r?.status === "answered" && r.resolution ? r.resolution : null;
    };
    await asks.create(askRecord("ask_slices"));
    await h.t.start(AGENT_TASK_ID, { call: agentCall() } as unknown as Json);
    await h.t.settle();
    await h.sim.ask(launchIdOf(agentCall(), 0), "ask_slices");
    await h.t.settle();
    await h.t.advance(10 * 60_000);
    await h.t.settle();
    const slice1 = h.t.tokens().find((t) => t.idempotencyKey === "ask_slices:s1");
    expect(slice1?.status).toBe("WAITING");
    expect((await asks.get("ask_slices"))?.waitpoint).toEqual({ host: "trigger", ref: slice1?.id });

    const resolver = createTriggerAskResolver({ trigger: h.t, store: h.store });
    const answer = resolution("ask_slices", "no", { kind: "human", channel: "slack", userId: "U1", displayName: "a" });
    expect((await resolver.resolve("ask_slices", answer)).won).toBe(true);
    await h.t.settle();
    expect(h.t.tokens().find((t) => t.id === slice1?.id)?.status).toBe("COMPLETED");
    expect(h.sim.only("Review#0").answers.map((a) => a.choiceId)).toEqual(["no"]);
  });

  it("an answer that lands while a new slice is armed is found at the end of that slice", async () => {
    const h = setup();
    const asks = resultStoreAsks(h.store);
    h.sim.readAnswer = async (askId) => {
      const r = await asks.get(askId);
      return r?.status === "answered" && r.resolution ? r.resolution : null;
    };
    await asks.create(askRecord("ask_between"));
    await h.t.start(AGENT_TASK_ID, { call: agentCall() } as unknown as Json);
    await h.t.settle();
    await h.sim.ask(launchIdOf(agentCall(), 0), "ask_between");
    await h.t.settle();
    // Answered with no wake at all, then the slice ends: the child finds it at once or through its own wake.
    await asks.resolve(
      "ask_between",
      resolution("ask_between", "yes", { kind: "human", channel: "slack", userId: "U1", displayName: "a" }),
    );
    await h.t.advance(10 * 60_000);
    await h.t.settle();
    expect(h.sim.only("Review#0").answers.map((a) => a.choiceId)).toEqual(["yes"]);
  });

  it("an answer that lands between the slice-end read and the waitpoint move returns at once", async () => {
    const h = setup();
    const asks = resultStoreAsks(h.store);
    h.sim.readAnswer = async (askId) => {
      const r = await asks.get(askId);
      return r?.status === "answered" && r.resolution ? r.resolution : null;
    };
    // The slice-end probe runs after the read and before the move: answer there, as a human would mid-gap.
    let answerOnProbe = false;
    const probe = h.sim.probe.bind(h.sim);
    h.sim.probe = async (call, record) => {
      if (answerOnProbe) {
        answerOnProbe = false;
        const won = resolution("ask_race", "yes", { kind: "human", channel: "slack", userId: "U1", displayName: "a" });
        await createTriggerAskResolver({ trigger: h.t, store: h.store }).resolve("ask_race", won);
      }
      return probe(call, record);
    };
    await asks.create(askRecord("ask_race"));
    await h.t.start(AGENT_TASK_ID, { call: agentCall() } as unknown as Json);
    await h.t.settle();
    await h.sim.ask(launchIdOf(agentCall(), 0), "ask_race");
    await h.t.settle();
    answerOnProbe = true;
    await h.t.advance(10 * 60_000);
    await h.t.settle();
    expect(answerOnProbe).toBe(false);
    // No further advance: the child must not wait out the next ten-minute slice.
    expect(h.sim.only("Review#0").answers.map((a) => a.choiceId)).toEqual(["yes"]);
  });
});

describe("afk on Trigger-launched runs", () => {
  const caller = { kind: "agent" as const, runId: "ns_parent", callPath: "plan#1", depth: 1 };

  it("triggerWorkflowLauncher puts afk in the factory payload, and get_workflow_status reports it", async () => {
    const t = createLocalTrigger();
    const store = memoryResultStore();
    const launcher = triggerWorkflowLauncher({ trigger: t, store });
    const receipt = await launcher.start({ name: "quiet", script: "export default async () => 1;", afk: true }, caller);
    const payload = t.runs({ taskId: FACTORY_TASK_ID })[0]?.payload as FactoryTaskPayload;
    expect(payload.afk).toBe(true);
    expect((await launcher.status?.(receipt.runId))?.afk).toBe(true);

    const loud = await launcher.start({ name: "loud", script: "export default async () => 2;" }, caller);
    expect((t.runs({ taskId: FACTORY_TASK_ID })[1]?.payload as FactoryTaskPayload | undefined)?.afk).toBeUndefined();
    expect((await launcher.status?.(loud.runId))?.afk).toBeUndefined();
  });

  it("an AFK factory run gets the AFK config, and so does every agent child's driver", async () => {
    const t = createLocalTrigger();
    const sim = new SimDriver(t);
    const engine = testEngine();
    const runModes: unknown[] = [];
    const driverModes: unknown[] = [];
    createTriggerHost({
      config: { deployment: "test", hitl: { mode: "interactive", onTimeout: "default" } },
      factories: { one: testFactory("one", async () => engine.agent("Review", { pr: 1 })) },
      trigger: t,
      store: memoryResultStore(),
      driver: (deps) => {
        driverModes.push(deps.config.hitl?.mode);
        return sim;
      },
      runFactory: async (f, input, o) => {
        runModes.push(o.config?.hitl?.mode);
        return engine.runFactory(f, input, o);
      },
      settleMs: 0,
    });
    const { id } = await t.start(FACTORY_TASK_ID, { factory: "one", input: null, afk: true });
    await t.settle();
    const child = t.runs({ taskId: AGENT_TASK_ID })[0];
    expect((child?.payload as AgentTaskPayload | undefined)?.afk).toBe(true);
    await sim.finish(sim.list()[0]?.launchId as LaunchId, "ok");
    expect(await finished(t, id)).toMatchObject({ status: "COMPLETED" });
    expect(runModes).toEqual(["afk"]);
    expect(driverModes).toEqual(["afk"]);
  });
});

describe("launch depth crosses into the agent child", () => {
  it("the parent sends its run's depth and the child mints with it", async () => {
    const h = setup({ factories: (engine) => ({ deep: testFactory("deep", async () => engine.agent("Plan", {})) }) });
    const runId = "ns_wf_depth_parent_0000000001";
    noteLaunchedBy(runId, { kind: "agent", runId: "ns_root", callPath: "a#0", depth: 2 });
    await h.t.start(FACTORY_TASK_ID, { factory: "deep", input: null, runId });
    await h.t.settle();
    expect((h.t.runs({ taskId: AGENT_TASK_ID })[0]?.payload as AgentTaskPayload | undefined)?.launchDepth).toBe(2);

    // A child whose run this process never saw learns the depth from its payload alone.
    const other = "ns_wf_depth_elsewhere_000001";
    expect(launchDepthOf(other)).toBe(1);
    await h.t.start(AGENT_TASK_ID, {
      call: agentCall({ runId: other, stepKey: "depth2" }),
      launchDepth: 3,
    } as unknown as Json);
    await h.t.settle();
    expect(launchDepthOf(other)).toBe(3);
  });
});

/** Settles every launch at once with a scripted result, after holding the "box" for a moment. */
function settlingDriver(results: unknown[], sandbox: SandboxRef): AgentCallDriver & { calls: HostAgentCall[] } {
  const calls: HostAgentCall[] = [];
  const unused = async () => {
    throw new Error("not used: every launch settles at once");
  };
  return {
    calls,
    async launch(call, launchId) {
      calls.push(call);
      await new Promise((r) => setTimeout(r, 25));
      const n = Number(/_l(\d+)$/.exec(launchId)?.[1] ?? 0);
      const ref = { uri: "file:///nowhere/x", bytes: 0, sha256: "0".repeat(64), contentType: "text/plain" };
      const outcome = {
        ok: true,
        launchId,
        result: results[Math.min(n, results.length - 1)],
        artifacts: { transcript: ref, logs: ref, files: [] },
        usage: { usd: 0.01, inputTokens: 10, outputTokens: 5, turns: 1, wallClockMs: 0, sandboxMs: 0 },
        sessionId: "sess-settled",
        sandbox,
      } as unknown as RawOutcome;
      return { kind: "settled", outcome };
    },
    registerWake: unused,
    probe: unused,
    collect: unused,
    stop: unused,
    interrupted: unused,
    openAsk: unused,
    readAnswer: unused,
    deliverAnswer: unused,
    expireAsk: unused,
  };
}

describe("a dispatched call, end to end through run()", () => {
  const CRED = "plain-credential-value-0001";
  const DECLARED = "declared-secret-value-0002";

  async function world(results: unknown[]) {
    const dir = await freshDir();
    const provider = tmpdirProvider({ root: path.join(dir, "boxes") });
    providers.push(provider);
    const base = scriptedHarness([]);
    const harness = { ...base, options: { ...base.options, credentials: [{ kind: "api-key" as const, value: CRED }] } };
    const sandbox: SandboxRef = {
      provider: provider.id,
      id: "box-settled",
      name: "box-settled",
      key: { runId: "ns_dispatch", scope: "x", deployment: "test" },
      deployment: "test",
      state: "running",
      createdAt: new Date().toISOString(),
      labels: {},
      size: "medium",
    };
    const driver = settlingDriver(results, sandbox);
    const t = createLocalTrigger({ startAt: Date.now() });
    const config: SelfbuildingConfig = {
      deployment: "test",
      sandbox: provider,
      harness,
      artifacts: fileArtifacts(path.join(dir, "artifacts")),
      secrets: { resolve: async (names) => Object.fromEntries(names.map((n) => [n, DECLARED])) },
    };
    return { t, driver, config };
  }

  it("the parent scrubs a child's credential and declared secret from what it writes", async () => {
    const w = await world([{ said: "hi" }]);
    const Speak = factory({ name: "speak", input: z.object({}) }, async () => {
      const r = await agent({
        name: "speaker",
        prompt: "Say hi.",
        output: z.object({ said: z.string() }),
        secrets: ["MY_TOKEN"],
      });
      return { said: r.result.said, scrubbed: redactForRun(`cred=${CRED} declared=${DECLARED}`) };
    });
    createTriggerHost({
      config: w.config,
      factories: { speak: Speak },
      trigger: w.t,
      store: memoryResultStore(),
      driver: w.driver,
      settleMs: 0,
    });
    const { id } = await w.t.start(FACTORY_TASK_ID, { factory: "speak", input: {}, runId: "ns_dispatch_redact" });
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    expect(run.output).toMatchObject({
      status: "ok",
      output: { said: "hi", scrubbed: "cred=[REDACTED] declared=[REDACTED]" },
    });
    // The payload a child receives carries names, never values.
    const payloads = JSON.stringify(w.t.runs({ taskId: AGENT_TASK_ID }).map((r) => r.payload));
    expect(payloads).not.toContain(CRED);
    expect(payloads).not.toContain(DECLARED);
  });

  it("box time from every launch's child is summed into the call's usage, with vCPU time", async () => {
    // The first result fails validation, so accept sends a follow-up turn: two launches, two children.
    const w = await world([{ said: 7 }, { said: "fixed" }]);
    const Speak = factory({ name: "speak2", input: z.object({}) }, async () => {
      const r = await agent({ name: "speaker", prompt: "Say hi.", output: z.object({ said: z.string() }) });
      return r.usage as unknown as Json;
    });
    createTriggerHost({
      config: w.config,
      factories: { speak2: Speak },
      trigger: w.t,
      store: memoryResultStore(),
      driver: w.driver,
      settleMs: 0,
    });
    const { id } = await w.t.start(FACTORY_TASK_ID, { factory: "speak2", input: {}, runId: "ns_dispatch_usage" });
    const run = await finished(w.t, id);
    expect(run.status, JSON.stringify(run.error)).toBe("COMPLETED");
    const children = w.t.runs({ taskId: AGENT_TASK_ID });
    expect(children).toHaveLength(2);
    const perChild = children.map((c) => (c.output as { usage: { sandboxMs: number; sandboxVcpuMs: number } }).usage);
    for (const u of perChild) {
      expect(u.sandboxMs).toBeGreaterThanOrEqual(20);
      expect(u.sandboxVcpuMs).toBe(u.sandboxMs * 4);
    }
    const usage = (run.output as { output: { sandboxMs: number; sandboxVcpuMs: number; turns: number } }).output;
    expect(usage.turns).toBe(2);
    expect(usage.sandboxMs).toBe((perChild[0]?.sandboxMs ?? 0) + (perChild[1]?.sandboxMs ?? 0));
    expect(usage.sandboxVcpuMs).toBe(usage.sandboxMs * 4);
  });
});
