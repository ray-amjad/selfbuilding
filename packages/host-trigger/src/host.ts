import * as core from "@selfbuilding/core";
import {
  type Agent,
  type AgentCallDriver,
  type AgentCallDriverDeps,
  type AskStore,
  ConfigError,
  type DurableHost,
  type Factory,
  type Harness,
  type JournalStore,
  type Json,
  type RawOutcome,
  type ReapOptions,
  type ReapReport,
  type ResultStore,
  type RunOptions,
  type RunOutcome,
  type SandboxProvider,
  SELFBUILDING_LABELS,
  type SelfbuildingConfig,
  SelfbuildingError,
} from "@selfbuilding/core";
import { type AgentTaskPayload, runAgentChild } from "./child.js";
import { cancelChildren, deliverCallback, hostRunStatus, killRunSandboxes } from "./control.js";
import { type RunRecord, readRunRecord, resultStoreAsks, resultStoreJournal } from "./journal.js";
import {
  AGENT_TASK_ID,
  ASK_SLICE_MS,
  assertRunId,
  FACTORY_TASK_ID,
  hostKeyOf,
  REAPER_CRON,
  REAPER_TASK_ID,
  runIdForHostRun,
  storeKeys,
} from "./keys.js";
import { type FactoryRunLimits, type FactoryTaskOutput, type FactoryTaskPayload, TriggerParentHost } from "./parent.js";
import { realTriggerSdk } from "./real-sdk.js";
import { ParentScheduler } from "./scheduler.js";
import { isDeployedRun, isTerminalStatus, type TriggerRunContext, type TriggerSdk } from "./sdk.js";
import { fileResultStore, localStoreKind, probeConditionalWrites, updateCas } from "./store.js";

/** Trigger.dev task values. Opaque here so public types never import third-party types (spec §1.7). */
export interface TriggerHost {
  /** Task id "selfbuilding.factory". */
  factoryTask: unknown;
  /** Task id "selfbuilding.agent". */
  agentTask: unknown;
  /** Scheduled every 2 minutes. */
  reaperTask: unknown;
}

/** How the factory task starts the engine. Default: `run()` from @selfbuilding/core with `host` set. */
export type RunFactoryFn = (
  factory: Factory<unknown, unknown>,
  input: unknown,
  opts: RunOptions & { runId: string; host: DurableHost; journal: JournalStore },
) => Promise<RunOutcome<unknown>>;

export interface TriggerHostOptions {
  config: SelfbuildingConfig;
  // biome-ignore lint/suspicious/noExplicitAny: factories of any input and output type are accepted.
  factories: Record<string, Factory<any, any>>;
  /** Default: the installed @trigger.dev/sdk. Tests pass `createLocalTrigger()`. */
  trigger?: TriggerSdk;
  /**
   * The result store (spec §7.10): run record, step and clock records, outcome and accept records, fences, the
   * child registry and asks. Must honour create-if-absent; probed before the first task runs.
   * Default: `fileResultStore(".selfbuilding/trigger")`.
   */
  store?: ResultStore;
  /** Default: an ask store in the result store, shared with the hooks handler. */
  asks?: AskStore;
  /** The launch/probe/collect half of an agent call. Default: core's `agentCallDriver({ config, store, asks })`. */
  driver?:
    | AgentCallDriver
    | ((deps: { config: SelfbuildingConfig; store: ResultStore; asks: AskStore }) => AgentCallDriver);
  /** Every provider the deployment uses, for cancellation and the reaper. Default: `[config.sandbox]`. */
  providers?: SandboxProvider[];
  /**
   * What an agent child may rebuild a call with besides `config.sandbox` and `config.harness`, looked up by id
   * (demo-path §5). Default providers: `providers`.
   */
  registry?: { providers?: SandboxProvider[]; harnesses?: Harness[] };
  /** Compiled agents the factories call, so the agent child finds their skills by name. */
  // biome-ignore lint/suspicious/noExplicitAny: agents of any input and output type are accepted.
  agents?: Agent<any, any>[];
  runFactory?: RunFactoryFn;
  /** Default: `reap()` from @selfbuilding/core. */
  reap?: (opts: ReapOptions) => Promise<ReapReport>;
  /** How long the factory body must stay idle before the parent suspends. Default 250 ms. */
  settleMs?: number;
  /**
   * An agent child waits for a human in slices this long, re-reading the ask store after each, so an answer whose
   * waitpoint completion was lost is picked up within one slice. Default 10 minutes.
   */
  askSliceMs?: number;
}

const MACHINE = "small-1x";
const MAX_DURATION_S = 300;
const RETRY = { maxAttempts: 3 };

/** The Trigger.dev v4 host (spec §7.5.1). Export all three tasks from your trigger/ directory. */
export function createTriggerHost(opts: TriggerHostOptions): TriggerHost {
  const { config } = opts;
  const deployment = config.deployment;
  if (!deployment) {
    throw new ConfigError(
      'createTriggerHost needs config.deployment (e.g. "prod"): hosted runs label and reap sandboxes by deployment.',
    );
  }
  const factories = new Map(Object.entries(opts.factories));
  if (factories.size === 0) {
    throw new ConfigError("createTriggerHost needs at least one factory in `factories`.");
  }
  const sdk = opts.trigger ?? realTriggerSdk();
  const store = opts.store ?? fileResultStore(".selfbuilding/trigger");
  const local = localStoreKind(store);
  // A deployed run's tasks land on different machines; a local store would split one run's records across them.
  const assertReachableStore = (ctx: TriggerRunContext | undefined) => {
    if (local && isDeployedRun(ctx)) {
      throw new ConfigError(
        "A deployed Trigger.dev run needs a result store every machine can reach. Pass store: r2ResultStoreFromEnv(process.env) (or s3ResultStore) to createTriggerHost.",
      );
    }
  };
  const asks = opts.asks ?? resultStoreAsks(store);
  const providers = opts.providers ?? (config.sandbox ? [config.sandbox] : []);
  const now = () => sdk.now();
  const journal = resultStoreJournal(store, { now, asks });
  const maxChildren = config.concurrency?.sandboxes ?? 4;

  let probed: Promise<void> | undefined;
  const ready = () => {
    probed ??= probeConditionalWrites(store).catch((error: unknown) => {
      probed = undefined;
      throw error;
    });
    return probed;
  };

  const askSliceMs = opts.askSliceMs ?? ASK_SLICE_MS;
  // An AFK run's children open asks under the AFK policy, so they get a driver built from an AFK config.
  const drivers = new Map<boolean, Promise<AgentCallDriver>>();
  const driver = (o?: { afk?: boolean }) => {
    const afk = o?.afk === true;
    let made = drivers.get(afk);
    if (!made) {
      made = resolveDriver(opts, afk ? afkConfig(config) : config, sdk, store, asks, askSliceMs);
      made.catch(() => drivers.delete(afk));
      drivers.set(afk, made);
    }
    return made;
  };
  const vcpuOf = (size: string): number | undefined => {
    try {
      return core.sizeTable(config)[size]?.vcpu;
    } catch {
      return undefined;
    }
  };

  const runFactory: RunFactoryFn =
    opts.runFactory ?? ((f, input, o) => core.run(f, input, o) as Promise<RunOutcome<unknown>>);
  const reap = opts.reap ?? core.reap;

  const factoryTask = sdk.task<FactoryTaskPayload, FactoryTaskOutput>({
    id: FACTORY_TASK_ID,
    machine: MACHINE,
    maxDuration: MAX_DURATION_S,
    retry: RETRY,
    async run(payload, { ctx }) {
      assertReachableStore(ctx);
      await ready();
      const factory = factories.get(payload.factory);
      if (!factory) {
        throw new ConfigError(
          `No factory "${payload.factory}" is registered with createTriggerHost. Registered: ${[...factories.keys()].join(", ")}.`,
        );
      }
      const runId = payload.runId ?? runIdForHostRun(ctx.run.id);
      assertRunId(runId);
      const hostRunId = ctx.run.id;
      const begun = await beginEpoch(sdk, store, runId, hostRunId, payload.factory, now);
      if ("attachedTo" in begun) {
        return {
          runId,
          epoch: begun.epoch,
          hostRunId: begun.attachedTo,
          status: "attached",
          output: null,
          orphans: [],
        };
      }
      const limited = limitedRunOptions(factory, config, payload.limits);
      const scheduler = new ParentScheduler({ sdk, store, asks, settleMs: opts.settleMs ?? 250 });
      const host = new TriggerParentHost({
        sdk,
        store,
        asks,
        scheduler,
        runId,
        epoch: begun.epoch,
        hostRunId,
        maxChildren: Math.min(maxChildren, limited.concurrency?.sandboxes ?? maxChildren),
        ...(payload.afk ? { afk: true } : {}),
      });
      let status: string;
      let output: Json = null;
      let error: Json | undefined;
      try {
        const outcome = await runFactory(factory, payload.input, {
          runId,
          // The same switch as `selfbuilding run --afk` on plain Node.
          config: payload.afk ? afkConfig(config) : config,
          host,
          journal,
          ...(config.artifacts ? { artifacts: config.artifacts } : {}),
          ...limited,
        });
        status = outcome.status;
        output = (outcome.output ?? null) as Json;
      } catch (thrown) {
        // Usage and config errors would fail the same way on every retry; infrastructure faults are retried.
        if (!(thrown instanceof SelfbuildingError) || thrown.retryable) throw thrown;
        status = "failed";
        error = thrown.toJSON() as unknown as Json;
      } finally {
        scheduler.stop();
      }
      const orphans = await host.sweepOrphans();
      await setRunStatus(store, runId, status, now);
      const result: FactoryTaskOutput = {
        runId,
        epoch: begun.epoch,
        hostRunId,
        status,
        output,
        orphans,
        ...(error ? { error } : {}),
      };
      if (payload.parent) {
        await store.createIfAbsent(payload.parent.resultKey, { value: result });
        await sdk
          .sendWake(payload.parent.hostRunId, { kind: "child", hostKey: payload.parent.hostKey, childRunId: hostRunId })
          .catch(() => {});
      }
      return result;
    },
    async onCancel({ ctx, payload }) {
      const runId = payload.runId ?? runIdForHostRun(ctx.run.id);
      await cancelWholeRun(runId);
    },
  });

  /** Cancels children, marks open asks cancelled and kills the run's sandboxes by label (spec §7.9). */
  async function cancelWholeRun(runId: string) {
    const record = await readRunRecord(store, runId);
    if (record) await cancelChildren(sdk, store, storeKeys.childPrefix(runId, record.epoch));
    for await (const ask of asks.open({ runId })) await asks.setStatus(ask.askId, "cancelled");
    const report = await killRunSandboxes(providers, deployment as string, runId);
    await setRunStatus(store, runId, "cancelled", now);
    return report;
  }

  const agentTask = sdk.task<AgentTaskPayload, RawOutcome>({
    id: AGENT_TASK_ID,
    machine: MACHINE,
    maxDuration: MAX_DURATION_S,
    // Safe: launch checks the outcome record and markers first, and collect writes its record first (§7.4).
    retry: RETRY,
    async run(payload, { ctx }: { ctx: TriggerRunContext }) {
      assertReachableStore(ctx);
      return runAgentChild(payload, ctx, {
        sdk,
        store,
        driver,
        asks,
        asksInStore: opts.asks === undefined,
        askSliceMs,
        vcpuOf,
      });
    },
    async onCancel({ payload }) {
      const { call } = payload;
      const hostKey = hostKeyOf(call);
      await killRunSandboxes(providers, deployment as string, call.runId, (labels) => {
        const step = labels[SELFBUILDING_LABELS.step];
        return step === hostKey || step === call.stepKey;
      });
    },
  });

  const controlHost = createControlHost(sdk, store);
  const reaperTask = sdk.scheduleTask({
    id: REAPER_TASK_ID,
    cron: REAPER_CRON,
    machine: MACHINE,
    maxDuration: MAX_DURATION_S,
    async run(_payload, { ctx }) {
      assertReachableStore(ctx);
      await ready();
      const report = await reap({ providers, journal, asks, host: controlHost, deployment: deployment as string });
      return report as unknown as Json;
    },
  });

  return { factoryTask, agentTask, reaperTask };
}

/**
 * Run options that tighten the factory's (or the config's) sandbox slots and budget to a launch's limits. Run
 * options replace those settings outright, so each is built from what the run would otherwise use.
 */
function limitedRunOptions(
  factory: Factory<unknown, unknown>,
  config: SelfbuildingConfig,
  limits: FactoryRunLimits | undefined,
): Pick<RunOptions, "concurrency" | "budget"> {
  if (!limits) return {};
  const out: Pick<RunOptions, "concurrency" | "budget"> = {};
  if (limits.sandboxes !== undefined) {
    const base = factory.options.concurrency ?? config.concurrency ?? {};
    out.concurrency = { ...base, sandboxes: Math.min(base.sandboxes ?? limits.sandboxes, limits.sandboxes) };
  }
  if (limits.budgetUsd !== undefined) {
    const base = factory.options.budget ?? config.budget ?? {};
    out.budget = { ...base, usd: Math.min(base.usd ?? limits.budgetUsd, limits.budgetUsd) };
  }
  return out;
}

/**
 * Starts this host run's epoch (spec §7.6). A retry of the same host run keeps its epoch; a new host run for a
 * finished run bumps it; a new host run while the previous one is still live attaches instead.
 */
async function beginEpoch(
  sdk: TriggerSdk,
  store: ResultStore,
  runId: string,
  hostRunId: string,
  factory: string,
  now: () => number,
): Promise<{ epoch: number } | { epoch: number; attachedTo: string }> {
  const key = storeKeys.run(runId);
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await store.getVersioned<RunRecord>(key);
    const at = new Date(now()).toISOString();
    if (!current) {
      const fresh: RunRecord = { epoch: 0, hostRunIds: [hostRunId], status: "running", factory, updatedAt: at };
      if (await store.replace(key, fresh, null)) return { epoch: 0 };
      continue;
    }
    const record = current.value;
    if (record.factory !== factory) {
      throw new core.RunIdConflictError(
        { runId },
        { message: `Run ${runId} belongs to factory "${record.factory}", not "${factory}". Use a new run id.` },
      );
    }
    if (record.hostRunIds.includes(hostRunId)) return { epoch: record.epoch };
    const previous = record.hostRunIds.at(-1);
    if (previous) {
      const run = await sdk.retrieveRun(previous).catch(() => null);
      if (run && !isTerminalStatus(run.status)) return { epoch: record.epoch, attachedTo: previous };
    }
    // The orphan sweep runs before a new epoch starts: the previous epoch's children are cancelled.
    await cancelChildren(sdk, store, storeKeys.childPrefix(runId, record.epoch));
    const next: RunRecord = {
      ...record,
      epoch: record.epoch + 1,
      hostRunIds: [...record.hostRunIds, hostRunId],
      status: "running",
      updatedAt: at,
    };
    if (await store.replace(key, next, current.version)) return { epoch: next.epoch };
  }
  throw new core.JournalConflictError(`Could not start a new epoch for run ${runId}: the run record kept changing.`);
}

async function setRunStatus(store: ResultStore, runId: string, status: string, now: () => number): Promise<void> {
  await updateCas<RunRecord>(store, storeKeys.run(runId), (record) =>
    record ? { ...record, status, updatedAt: new Date(now()).toISOString() } : undefined,
  );
}

/** What the reaper sees as its host: run status and wait repair, nothing that needs a running factory. */
function createControlHost(sdk: TriggerSdk, store: ResultStore): DurableHost {
  const outsideRun = (what: string) =>
    new ConfigError(`${what} only works inside a selfbuilding.factory run, not from the reaper.`);
  return {
    id: "trigger",
    limits: { maxStepOutputBytes: 262_144, parallelWaits: false },
    epoch: 0,
    step: async () => {
      throw outsideRun("host.step");
    },
    waitForCallback: async () => {
      throw outsideRun("host.waitForCallback");
    },
    sleep: async () => {
      throw outsideRun("host.sleep");
    },
    all: (branches) => Promise.all(branches.map((b) => b())),
    child: async () => {
      throw outsideRun("host.child");
    },
    runStatus: (hostRunId) => hostRunStatus(sdk, hostRunId),
    deliverCallback: (cb) => deliverCallback(sdk, store, cb),
  };
}

const DRIVER_EXPORT = "agentCallDriver";

/** The config with no humans: every ask resolves by its AFK policy. */
function afkConfig(config: SelfbuildingConfig): SelfbuildingConfig {
  return { ...config, hitl: { ...config.hitl, mode: "afk" } };
}

async function resolveDriver(
  opts: TriggerHostOptions,
  config: SelfbuildingConfig,
  sdk: TriggerSdk,
  store: ResultStore,
  asks: AskStore,
  askSliceMs: number,
): Promise<AgentCallDriver> {
  const providers = opts.registry?.providers ?? opts.providers;
  const deps: AgentCallDriverDeps = {
    config,
    store,
    asks,
    registry: {
      ...(providers ? { providers } : {}),
      ...(opts.registry?.harnesses ? { harnesses: opts.registry.harnesses } : {}),
    },
    ...(opts.agents ? { agents: opts.agents } : {}),
    // An agent ask waits on its own token, keyed on the ask id, created before the ask is posted (spec §8.5). It
    // is the first slice of the child's wait, so it never outlives one slice.
    askWaitpoint: {
      host: "trigger",
      async create(askId, expiresAt) {
        const token = await sdk.createToken({
          idempotencyKey: askId,
          timeoutMs: Math.max(1, Math.min(askSliceMs, Date.parse(expiresAt) - sdk.now())),
        });
        return token.id;
      },
    },
  };
  if (typeof opts.driver === "function") return opts.driver(deps);
  if (opts.driver) return opts.driver;
  const make = (core as Record<string, unknown>)[DRIVER_EXPORT];
  if (typeof make !== "function") {
    throw new ConfigError(
      `@selfbuilding/core does not export ${DRIVER_EXPORT}() yet, so the agent child cannot launch calls. Pass createTriggerHost({ driver }).`,
    );
  }
  return (make as (d: typeof deps) => AgentCallDriver)(deps);
}
