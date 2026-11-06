import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { AskRecord, DurableHost, Factory, HostAgentCall, Json, RunOutcome } from "@selfbuilding/core";
import type { RunFactoryFn } from "../src/index.js";

// A minimal stand-in for core's engine, enough to drive the Trigger host the way `run()` will: structural call
// paths, step keys from call path and input, `agent()` as one journaled step around dispatch + accept, and the
// other primitives straight onto the host. It is test scaffolding, not an engine.

export type AgentValue = { ok: true; result: Json; launchId: string } | { ok: false; error: { [key: string]: Json } };

interface Ctx {
  host: DurableHost;
  runId: string;
  counters: Map<string, number>;
}

export interface TestEngine {
  runFactory: RunFactoryFn;
  /** `prompt` is part of the step key, as a skill hash would be. */
  agent(name: string, input: Json, prompt?: string): Promise<AgentValue>;
  step<T extends Json>(key: string, fn: () => Promise<T>): Promise<T>;
  ask(askId: string, timeoutMs: number): Promise<AskRecord | null>;
  sleep(key: string, ms: number): Promise<void>;
  host(): DurableHost;
  /** How many times accept ran per call path (accept is the closure work that only the parent can do). */
  accepts: Map<string, number>;
}

function stepKeyOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 26);
}

export function testEngine(): TestEngine {
  const als = new AsyncLocalStorage<Ctx>();
  const accepts = new Map<string, number>();
  const ctx = (): Ctx => {
    const c = als.getStore();
    if (!c) throw new Error("not inside a test factory");
    return c;
  };
  const next = (c: Ctx, name: string) => {
    const n = c.counters.get(name) ?? 0;
    c.counters.set(name, n + 1);
    return `${name}#${n}`;
  };

  const engine: TestEngine = {
    accepts,
    runFactory: async (factory, input, opts) => {
      const c: Ctx = { host: opts.host, runId: opts.runId, counters: new Map() };
      const output = await als.run(c, () => factory.body(input));
      const outcome: RunOutcome<unknown> = {
        runId: opts.runId,
        status: "ok",
        output,
        usage: { usd: 0, inputTokens: 0, outputTokens: 0, turns: 0, wallClockMs: 0, sandboxMs: 0 },
        replayedUsd: 0,
        events: [],
      };
      return outcome;
    },
    async agent(name, input, prompt = "default prompt") {
      const c = ctx();
      const callPath = next(c, name);
      const stepKey = stepKeyOf(`${callPath}|${prompt}|${JSON.stringify(input)}`);
      const host = c.host;
      if (!host.dispatchAgent) throw new Error("host has no dispatchAgent");
      const dispatch = host.dispatchAgent.bind(host);
      return host.step<AgentValue>(
        stepKey,
        async () => {
          const call: HostAgentCall = {
            runId: c.runId,
            epoch: host.epoch,
            stepKey,
            callPath,
            launch: 0,
            spec: { name, input, prompt },
          };
          const raw = await dispatch(call);
          accepts.set(callPath, (accepts.get(callPath) ?? 0) + 1);
          return raw.ok
            ? { ok: true, result: raw.result as Json, launchId: raw.launchId }
            : { ok: false, error: raw.error as unknown as { [key: string]: Json } };
        },
        { kind: "agent", callPath },
      );
    },
    step(key, fn) {
      return ctx().host.step(key, fn, { kind: "step" });
    },
    async ask(askId, timeoutMs) {
      const host = ctx().host;
      if (!host.waitForAsk) throw new Error("host has no waitForAsk");
      return host.waitForAsk(askId, { timeoutMs });
    },
    sleep(key, ms) {
      return ctx().host.sleep(key, ms);
    },
    host() {
      return ctx().host;
    },
  };
  return engine;
}

/** A factory value as `createTriggerHost` sees it; the schemas are never read by the host. */
export function testFactory<I, O>(name: string, body: (input: I) => Promise<O>): Factory<I, O> {
  const call = async () => {
    throw new Error("call through the host");
  };
  Object.defineProperty(call, "name", { value: name });
  return Object.assign(call, {
    body,
    inputSchema: {} as Factory<I, O>["inputSchema"],
    options: { name, input: {} } as unknown as Factory<I, O>["options"],
  }) as unknown as Factory<I, O>;
}
