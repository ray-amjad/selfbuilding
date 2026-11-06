import { type AgentRunContext, setAgentContextResolver } from "../agent/context.js";
import { runWithAskScope } from "../ask/context.js";
import { AskSession, mergeHitlOptions } from "../ask/session.js";
import { memoryAskStore } from "../ask/store.js";
import { BudgetLedger } from "../budget/ledger.js";
import { defaultSandboxCap, SandboxSlots } from "../budget/slots.js";
import { validateBudget, validateConcurrency, validateConfig } from "../config/index.js";
import {
  AgentInterruptedError,
  BudgetExceededError,
  ConfigError,
  JournalConflictError,
  JournalVersionError,
  LeaseLostError,
  RunIdConflictError,
} from "../errors/classes.js";
import { isUsageError, serializeThrown } from "../errors/serialize.js";
import { EventBus } from "../events/bus.js";
import { fileArtifacts } from "../journal/index.js";
import { memoryJournal } from "../journal/memory.js";
import type { SelfbuildingConfig } from "../types/config.js";
import type { EventSink } from "../types/events.js";
import type {
  Factory,
  InterruptedPolicy,
  JournalEntry,
  JournalStore,
  Lease,
  RunOptions,
  RunOutcome,
  RunStatus,
} from "../types/orchestration.js";
import { agentContextFor, setRootScope } from "./agent-bridge.js";
import { maybeFrame, withScope } from "./context.js";
import { isFactory, parseInput, parseOutput } from "./factory.js";
import { canonicalJson, internalNow, sha256Hex, ulid } from "./hash.js";
import { isSuspension, RunState } from "./run-state.js";
import { Scope } from "./scope.js";
import { installStrict } from "./strict.js";

const RUN_ID = /^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$/;
/** The run-binding entry's step key (spec §3.9: the first entry of every run is `kind: "run"`). */
export const RUN_ENTRY_KEY = "run";
export const RUN_ENTRY_VERSION = 1;
const LEASE_TTL_MS = 60_000;
const INTERRUPTED_POLICIES = new Set<InterruptedPolicy>(["fail", "resume-session", "restore-and-rerun", "skip"]);

// Agent calls and sandbox handles find the run they are in through the engine's frame.
const agentContexts = new WeakMap<RunState, AgentRunContext>();
setAgentContextResolver(() => {
  const frame = maybeFrame();
  return frame ? agentContexts.get(frame.run) : undefined;
});

interface RunBinding {
  v: number;
  factory: string;
  binding: string;
  resumes: { resumeId: string; at: string }[];
}

/** Internal knobs for host adapters that drive `run()` themselves. */
export interface RunInternals {
  /** Durable hosts bump it per resume after a terminal failure (spec §7.6). */
  epoch?: number;
  /** A host replay of the same resume passes the same id, so `refresh` salts stay stable. */
  resumeId?: string;
  leaseTtlMs?: number;
  /** Test hook: how long an all-idle sandbox cap must persist before it counts as deadlocked. */
  deadlockAfterMs?: number;
}

/**
 * Runs a factory, or resumes it when `runId` already has a journal (spec §3.9). Resolves for every
 * agent-level outcome; throws only usage and config errors.
 */
export async function run<I, O>(f: Factory<I, O>, input: I, opts?: RunOptions): Promise<RunOutcome<O>> {
  return runFactory(f, input, opts ?? {}, {});
}

export async function runFactory<I, O>(
  f: Factory<I, O>,
  input: I,
  opts: RunOptions,
  internals: RunInternals,
): Promise<RunOutcome<O>> {
  if (!isFactory(f)) throw new ConfigError("run(f, input, opts) needs a factory created with factory({...}, body).");
  const config: SelfbuildingConfig = opts.config ?? {};
  validateConfig(config);
  validateRunOptions(opts);
  const runId = opts.runId ?? `ns_${ulid()}`;
  if (!RUN_ID.test(runId)) {
    throw new ConfigError(
      `runId "${runId}" must match ^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$ so it is valid on every host.`,
    );
  }
  const parsedInput = parseInput(f.name, f.inputSchema, input);

  // Run-level settings: run() options, then the factory's options, then config (spec §1.11).
  const budget = opts.budget ?? f.options.budget ?? config.budget;
  const concurrency = opts.concurrency ?? f.options.concurrency ?? config.concurrency ?? {};
  const hitl = mergeHitlOptions(opts.hitl, f.options.hitl, config.hitl);
  const sinks: EventSink[] = opts.events ?? config.events ?? [];
  const strict = opts.strict ?? config.strict ?? false;
  const provider = f.options.defaults?.sandbox ?? config.sandbox;
  const sandboxes = defaultSandboxCap(concurrency.sandboxes, provider?.limits.maxConcurrent);

  const processEpoch = ulid();
  const events = new EventBus({ runId, processEpoch, sinks });
  let journal: JournalStore | undefined = opts.journal ?? config.journal;
  if (!journal) {
    journal = memoryJournal();
    events.emit({
      type: "warning",
      level: "warn",
      data: {
        scope: "journal",
        message: "No journal is configured, so this run cannot be resumed. Pass journal: fileJournal(dir).",
      },
    });
  }
  const artifacts = opts.artifacts ?? config.artifacts ?? fileArtifacts(".selfbuilding/artifacts");
  const abort = new AbortController();
  // Built before the lease: a HITL setup nobody can answer fails the run before anything starts (spec §8.8).
  const asks = new AskSession({
    run: { runId, factory: f.name },
    store: journal.asks ?? memoryAskStore(),
    hitl,
    ...((opts.notify ?? config.notify) ? { notify: opts.notify ?? config.notify } : {}),
    emit: (type, data, level) => events.emit({ type, data, ...(level ? { level } : {}) }),
    redact: (text) => events.redact(text),
    signal: abort.signal,
    // The ledger is built after the lease; the session only touches it once the run body waits on a human.
    clock: { pauseClock: () => ledger.pauseClock(), resumeClock: () => ledger.resumeClock() },
  });

  const leaseTtl = internals.leaseTtlMs ?? LEASE_TTL_MS;
  const lease = await journal.lease(runId, processEpoch, leaseTtl);
  if (!lease) {
    throw new JournalConflictError(
      `Run ${runId} is held by another process. Wait for it to finish (or for its lease to expire) before resuming.`,
      { runId },
    );
  }
  const leased: Lease = lease.runId === undefined ? { ...lease, runId } : lease;

  let entries: JournalEntry[];
  try {
    entries = [];
    for await (const entry of journal.list(runId)) entries.push(entry);
  } catch (error) {
    await journal.release?.(leased).catch(() => {});
    throw error;
  }
  const resumeId = internals.resumeId ?? processEpoch;
  const binding = sha256Hex(f.name + canonicalJson(parsedInput));
  const runEntry = entries.find((e) => e.kind === "run" && e.stepKey === RUN_ENTRY_KEY) ?? null;
  const prior = runEntry?.value as RunBinding | undefined;
  try {
    if (prior !== undefined) {
      if (prior.v !== RUN_ENTRY_VERSION) {
        throw new JournalVersionError({ found: prior.v, supported: RUN_ENTRY_VERSION }, { runId });
      }
      if (prior.binding !== binding) throw new RunIdConflictError({ runId });
    }
  } catch (error) {
    await journal.release?.(leased).catch(() => {});
    throw error;
  }

  const onExternalAbort = () => abort.abort(opts.signal?.reason);
  if (opts.signal?.aborted) abort.abort(opts.signal.reason);
  else opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  // The ledger persists charges through the run state, which exists only after the ledger does.
  let state: RunState | undefined;
  const ledger = new BudgetLedger({
    ...(budget === undefined ? {} : { budget }),
    sandboxes,
    emit: (e) => events.emit(e),
    persist: async (record) => {
      if (!state) return;
      const at = new Date(internalNow()).toISOString();
      await state.write({
        runId,
        stepKey: `${record.launchId}_t${record.turn}`,
        callPath: record.callPath,
        kind: "charge",
        status: "ok",
        launchId: record.launchId,
        charge: { usd: record.usd, tokens: record.tokens, turn: record.turn, cumulative: true },
        attempt: record.attempt,
        startedAt: at,
        finishedAt: at,
        ...(record.estimated ? { value: { estimated: true } } : {}),
      });
    },
  });
  ledger.restore(entries);

  const slots = new SandboxSlots(
    sandboxes,
    internals.deadlockAfterMs === undefined ? {} : { deadlockAfterMs: internals.deadlockAfterMs },
  );
  const factoryFrame = { name: f.name, options: f.options, depth: 0 };
  state = new RunState({
    runId,
    factory: factoryFrame,
    epoch: internals.epoch ?? opts.host?.epoch ?? 0,
    processEpoch,
    resumeId,
    config,
    options: opts,
    journal,
    lease: leased,
    artifacts,
    events,
    budget: ledger,
    slots,
    concurrency: {
      sandboxes,
      ...(concurrency.createsPerMinute === undefined ? {} : { createsPerMinute: concurrency.createsPerMinute }),
    },
    hitl,
    notify: opts.notify ?? config.notify,
    strict,
    entries,
    abort,
  });
  const run = state;
  agentContexts.set(run, agentContextFor(run, asks));

  const startedAt = internalNow();
  const renewEvery = Math.max(1000, Math.floor(leaseTtl / 3));
  const renewTimer = setInterval(() => {
    void journal
      .renew(run.lease)
      .then((next) => {
        if (next) run.lease = next.runId === undefined ? { ...next, runId } : next;
        else run.loseLease(new LeaseLostError(undefined, { runId }));
      })
      .catch(() => {});
  }, renewEvery);
  (renewTimer as { unref?: () => void }).unref?.();

  const releaseStrict = strict ? installStrict() : null;
  let status: RunStatus = "ok";
  let output: O | null = null;
  let usageError: unknown;
  let bodyError: unknown;

  try {
    const bindingValue: RunBinding = {
      v: RUN_ENTRY_VERSION,
      factory: f.name,
      binding,
      resumes: [...(prior?.resumes ?? []), { resumeId, at: new Date(startedAt).toISOString() }],
    };
    const at = new Date(startedAt).toISOString();
    await run.writeOrConflict(
      {
        runId,
        stepKey: RUN_ENTRY_KEY,
        callPath: "run",
        kind: "run",
        status: "ok",
        launchId: `${RUN_ENTRY_KEY}_e${run.epoch}_l${bindingValue.resumes.length - 1}`,
        value: bindingValue,
        attempt: bindingValue.resumes.length,
        startedAt: runEntry?.startedAt ?? at,
        finishedAt: at,
      },
      runEntry?.status ?? null,
    );
    run.emit({
      type: "run.started",
      data: { factory: f.name, resumed: run.resumed, epoch: run.epoch, resumeId, strict, sandboxes },
    });

    const root = new Scope(run, "", factoryFrame, { path: "" }, { depth: 0, index: 0 }, null, "");
    setRootScope(run, root);
    const askScope = { session: asks, callPath: () => maybeFrame()?.scope.path || "run" };
    const body = Promise.resolve(withScope(root, () => runWithAskScope(askScope, () => f.body(parsedInput))));
    body.catch(() => {});
    // An abort ends the run at once, even when factory code is awaiting something that never settles.
    const aborted = new Promise<never>((_, reject) => {
      if (abort.signal.aborted) reject(abort.signal.reason);
      else abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
    aborted.catch(() => {});
    const raw = await Promise.race([body, aborted]);
    output = parseOutput(f.name, f.outputSchema, raw);
  } catch (error) {
    output = null;
    if (isUsageError(error)) usageError = error;
    else bodyError = error;
  }

  // Disposal and the final journal writes happen before the outcome is decided, so a failure there counts.
  const finalizerErrors = await run.runFinalizers();
  try {
    await run.settleWrites();
  } catch (error) {
    if (!usageError && !bodyError) bodyError = error;
  }
  if (!bodyError && !usageError && finalizerErrors.length > 0) bodyError = finalizerErrors[0];

  if (usageError) status = "failed";
  else if (abort.signal.aborted && !run.leaseLost) status = "aborted";
  else if (isSuspension(bodyError)) status = "waiting";
  else if (bodyError instanceof AgentInterruptedError || run.needsAttention.size > 0) status = "needs_attention";
  else if (bodyError instanceof BudgetExceededError || run.budget.exhausted) status = "budget_exhausted";
  else if (bodyError !== undefined) status = "failed";
  else if (run.dropped > 0) status = "partial";

  if (status === "aborted") await asks.cancelOpen("the run was cancelled").catch(() => 0);
  if (status !== "waiting") {
    await asks
      .notifyRunEnd({
        status,
        skill: f.name,
        durationMs: internalNow() - startedAt,
        ...(run.usage.usd == null ? {} : { costUsd: run.usage.usd }),
        ...(output === null ? {} : { result: output }),
        ...(bodyError === undefined ? {} : { error: summarizeForHumans(bodyError) }),
      })
      .catch(() => {});
  }

  if (bodyError !== undefined && !isSuspension(bodyError)) {
    run.emit({ type: "error", level: "error", data: { ...summarize(bodyError), primitive: "run" } });
  }

  clearInterval(renewTimer);
  opts.signal?.removeEventListener("abort", onExternalAbort);
  releaseStrict?.();
  slots.close();

  run.usage.wallClockMs = internalNow() - startedAt;
  const orphaned = [...run.entries.values()]
    .filter((e) => e.kind !== "run" && e.kind !== "charge" && !run.visited.has(e.stepKey))
    .map((e) => ({ callPath: e.callPath, stepKey: e.stepKey, status: e.status }));
  if (run.events.dropped > 0) {
    run.emit({ type: "telemetry.dropped", level: "warn", data: { count: run.events.dropped } });
  }
  run.emit({
    type: "run.end",
    level: status === "ok" || status === "waiting" ? "info" : status === "partial" ? "warn" : "error",
    data: {
      status,
      usage: { ...run.usage },
      replayedUsd: run.budget.replayedUsd,
      orphaned,
      ...(run.needsAttention.size > 0 ? { needsAttention: [...run.needsAttention] } : {}),
    },
  });
  run.close();
  await journal.release?.(run.lease).catch(() => {});

  if (usageError) throw usageError;
  return {
    runId,
    status,
    // A body that returned keeps its output even when some calls ran out of budget along the way.
    output: bodyError === undefined ? output : null,
    usage: { ...run.usage },
    replayedUsd: run.budget.replayedUsd,
    events: [...run.events.events],
  };
}

function summarize(error: unknown): Record<string, unknown> {
  const json = serializeThrown(error) as { name: string; message: string; code?: string; retryable?: boolean };
  return { code: json.code ?? "unknown", retryable: json.retryable ?? false, name: json.name, message: json.message };
}

function summarizeForHumans(error: unknown): { name: string; message: string; hint?: string } {
  const json = serializeThrown(error) as { name: string; message: string; hint?: string };
  return { name: json.name, message: json.message, ...(json.hint ? { hint: json.hint } : {}) };
}

function validateRunOptions(opts: RunOptions): void {
  if (opts.budget !== undefined) validateBudget(opts.budget, "run() budget");
  validateConcurrency(opts.concurrency, "run() concurrency");
  if (opts.refresh !== undefined) {
    if (!Array.isArray(opts.refresh) || !opts.refresh.every((r) => typeof r === "string" && r.length > 0)) {
      throw new ConfigError('run() refresh must be an array of callPaths; end an entry with "/" to match a prefix.');
    }
  }
  const o = opts.onInterrupted;
  if (o !== undefined) {
    if (typeof o === "string") {
      if (o !== "fail" && o !== "resume-session") {
        throw new ConfigError(
          `run() onInterrupted must be "fail", "resume-session" or a record by callPath; got "${o}".`,
        );
      }
    } else if (o === null || typeof o !== "object") {
      throw new ConfigError("run() onInterrupted must be a string or a record by callPath.");
    } else {
      for (const [path, policy] of Object.entries(o)) {
        if (!INTERRUPTED_POLICIES.has(policy)) {
          throw new ConfigError(
            `run() onInterrupted["${path}"] must be one of fail, resume-session, restore-and-rerun, skip; got "${policy}".`,
          );
        }
      }
    }
  }
  if (opts.events !== undefined && !(Array.isArray(opts.events) && opts.events.every((s) => typeof s === "function"))) {
    throw new ConfigError("run() events must be an array of functions (event) => void.");
  }
}
