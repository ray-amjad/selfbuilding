import type { Factory, HostAgentCall, ReapOptions, ReapReport, SandboxProvider } from "@selfbuilding/core";
import { createLocalTrigger, createTriggerHost, type LocalTrigger, memoryResultStore } from "../src/index.js";
import { type TestEngine, testEngine } from "./engine.js";
import { SimDriver, type SimOptions } from "./sim-driver.js";

export interface Harness {
  t: LocalTrigger;
  sim: SimDriver;
  store: ReturnType<typeof memoryResultStore>;
  engine: TestEngine;
  reapCalls: ReapOptions[];
}

export function setup(
  o: {
    // biome-ignore lint/suspicious/noExplicitAny: test factories of any shape.
    factories?: (engine: TestEngine) => Record<string, Factory<any, any>>;
    sim?: SimOptions;
    providers?: SandboxProvider[];
    sandboxes?: number;
    reap?: (opts: ReapOptions, h: Harness) => Promise<ReapReport>;
  } = {},
): Harness {
  const t = createLocalTrigger();
  const sim = new SimDriver(t, { deployment: "test", ...o.sim });
  const store = memoryResultStore();
  const engine = testEngine();
  const reapCalls: ReapOptions[] = [];
  const h: Harness = { t, sim, store, engine, reapCalls };
  const factories = o.factories?.(engine) ?? { noop: noopFactory() };
  createTriggerHost({
    config: { deployment: "test", concurrency: { sandboxes: o.sandboxes ?? 4 } },
    factories,
    trigger: t,
    store,
    driver: sim,
    runFactory: engine.runFactory,
    settleMs: 0,
    providers: o.providers ?? [],
    reap: async (opts) => {
      reapCalls.push(opts);
      return o.reap ? o.reap(opts, h) : { killed: 0, parked: 0, held: 0, leaked: 0, errors: [], decisions: [] };
    },
  });
  return h;
}

function noopFactory() {
  // biome-ignore lint/suspicious/noExplicitAny: a placeholder factory.
  return Object.assign(async () => null, { body: async () => null, options: {}, inputSchema: {} }) as any;
}

export function agentCall(over: Partial<HostAgentCall> = {}): HostAgentCall {
  return {
    runId: "ns_t",
    epoch: 0,
    stepKey: "step1",
    callPath: "Review#0",
    launch: 0,
    spec: { prompt: "review" },
    ...over,
  };
}
