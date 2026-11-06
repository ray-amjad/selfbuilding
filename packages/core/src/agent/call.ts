import type { SelfbuildingError } from "../errors/base.js";
import { AgentInterruptedError, DoneCheckFailedError, ResultValidationError } from "../errors/classes.js";
import type { ErrorCode } from "../errors/codes.js";
import { nodeHost } from "../host-node/index.js";
import { SharedSandbox } from "../sandbox/handle.js";
import type { AgentCallOptions, Settled } from "../types/agent.js";
import type { AgentResult, Usage } from "../types/artifacts.js";
import type { Json } from "../types/common.js";
import type { LaunchId } from "../types/host.js";
import type { JournalEntry } from "../types/orchestration.js";
import type { SandboxRef } from "../types/sandbox.js";
import { type AgentRunContext, currentAgentContext, standaloneContext } from "./context.js";
import { credentialPool, leasedContent } from "./credentials.js";
import { agentCallSpec } from "./driver.js";
import { errorCode, isSelfbuildingError, isUsageError, rehydrateError, serializeError } from "./errors.js";
import {
  acceptAttempt,
  type CallState,
  errOpts,
  hydrateResult,
  journalPut,
  resumeStarted,
  runCall,
} from "./lifecycle.js";
import { type AgentDefinition, type CallPlan, parseInput, resolvePlan, stepIdentity } from "./plan.js";
import { interruptedMessage } from "./prompt.js";

// One agent call from the caller's side: usage checks, identity, journal replay, then the lifecycle (spec §3.4).

/** The ambient run, or the handle's: found synchronously, so the call's identity is fixed before any await. */
function ambientContext(opts: AgentCallOptions): AgentRunContext | undefined {
  return currentAgentContext() ?? (SharedSandbox.is(opts.sandbox) ? opts.sandbox.context : undefined);
}

async function standaloneFor(opts: AgentCallOptions): Promise<AgentRunContext> {
  const ctx = standaloneContext({
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const journal = opts.config?.journal;
  if (!journal) return ctx;
  // Journaled only when the settings include a journal (spec §1.8).
  const lease = await journal.lease(ctx.runId, `standalone-${process.pid}`, "1h");
  if (!lease) return ctx;
  return { ...ctx, journal: { store: journal, lease } };
}

export async function callAgent<I, O>(
  def: AgentDefinition<I, O>,
  input: I,
  opts: AgentCallOptions = {},
): Promise<AgentResult<O>> {
  const d = def as unknown as AgentDefinition<unknown, unknown>;
  // No await before the step key: a step() that settles synchronously next to this call must not move the chain
  // head between the live run and its replay (spec §3.2). `??` skips the await whenever a run is ambient.
  const ctx = ambientContext(opts) ?? (await standaloneFor(opts));
  const parsed = parseInput(d, input);
  const callPath = ctx.nextCallPath(def.name, opts.label);
  const base = resolvePlan(ctx, d, input, parsed, opts, callPath);
  const stepKey = ctx.stepKey(stepIdentity(d, base, callPath));
  const plan: CallPlan = { ...base, stepKey, hostKey: `${stepKey}_e${ctx.epoch}` };
  const signal = opts.signal ?? ctx.signal;
  if (signal?.aborted) throw signal.reason;
  const state: CallState = {
    ctx,
    def: d,
    plan,
    ...(signal ? { signal } : {}),
    fresh: !plan.handle,
    attempts: { submits: 0, resumes: 0, doneRetries: 0 },
    usage: { usd: null, inputTokens: 0, outputTokens: 0, turns: 0, wallClockMs: 0, sandboxMs: 0 },
    startedAt: Date.now(),
  };

  const journal = ctx.journal;
  try {
    const entry = journal ? await journal.store.get(ctx.runId, stepKey) : null;
    if (entry?.status === "ok" && entry.value) {
      ctx.advanceChain(stepKey, entry.launchId);
      plan.handle?.noteCallSettled(stepKey, {
        replayed: true,
        ...((entry.checkpointAfter ?? (entry.value as AgentResult<unknown>).artifacts?.checkpoint)
          ? { checkpoint: entry.checkpointAfter ?? (entry.value as AgentResult<unknown>).artifacts.checkpoint }
          : {}),
      });
      ctx.emit({ type: "agent.replayed", callPath, launchId: entry.launchId, data: { stepKey } });
      const replayed = hydrateResult(ctx, entry.value as AgentResult<unknown>) as AgentResult<O>;
      ctx.noteUsage?.(replayed.usage, true);
      return replayed;
    }
    const admitted = ctx.admit ? await ctx.admit(callPath, plan.budget?.usd) : undefined;
    if (admitted?.usd !== undefined) plan.budget = { usd: admitted.usd };
    if (admitted) state.budget = admitted;
    try {
      const dispatching = ctx.host.dispatchAgent !== undefined;
      // A shared handle's box lives with the parent's handle, so its calls stay in-process on every host
      // (docs/decisions/0002-shared-handles-on-trigger.md).
      if (dispatching && plan.handle) {
        noteSharedHandleInParent(ctx, plan.callPath);
        state.ctx = withInProcessWaits(ctx);
      }
      const result =
        dispatching && !plan.handle
          ? await runDispatched(state, entry ? dispatchStart(entry) : 0, entry ? journaledResume(entry) : undefined)
          : entry?.status === "started"
            ? await resumeStarted(state, entry)
            : await runCall(state, entry ? entryAttempt(entry) : 0);
      const settled = journal ? await journal.store.get(ctx.runId, stepKey) : null;
      admitted?.release(result.usage.usd, settled?.status === "ok" ? settled.launchId : undefined);
      ctx.noteUsage?.(result.usage, false);
      return result as AgentResult<O>;
    } catch (error) {
      admitted?.release(state.usage.usd);
      ctx.noteUsage?.(state.usage, false);
      if (error instanceof AgentInterruptedError) ctx.markNeedsAttention?.(callPath);
      throw error;
    }
  } finally {
    // A no-op once the lifecycle advanced the chain; otherwise later calls keep the current head.
    ctx.abandonChain?.(stepKey);
  }
}

/** A started entry re-dispatches the same launch (the child finds it); a failed one starts the next. */
function dispatchStart(entry: { status: string; launchId: string }): number {
  if (entry.status !== "started") return entryAttempt(entry);
  const m = /_l(\d+)$/.exec(entry.launchId);
  return m ? Number(m[1]) : 0;
}

/**
 * The follow-up message a started dispatched launch was sent with, so a replay re-dispatches it unchanged: the
 * child may not have been triggered before the parent crashed.
 */
function journaledResume(entry: JournalEntry): DispatchResume | undefined {
  if (entry.status !== "started") return undefined;
  const r = (entry.value as { resume?: unknown } | undefined)?.resume as Partial<DispatchResume> | undefined;
  return r && typeof r.message === "string" && typeof r.sessionId === "string"
    ? { message: r.message, sessionId: r.sessionId }
    : undefined;
}

type DispatchResume = { message: string; sessionId: string };

/** A failed entry is re-run live under a fresh launch number, so its old outcome record never answers. */
function entryAttempt(entry: { launchId: string }): number {
  const m = /_l(\d+)$/.exec(entry.launchId);
  return m ? Number(m[1]) + 1 : 0;
}

/** The value form (spec §1.9 rule 2). Usage errors still throw. */
export async function settle<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (isUsageError(error)) throw error;
    if (signal?.aborted && error === signal.reason) return { ok: false, code: "aborted", error };
    const code = (errorCode(error) as ErrorCode | undefined) ?? "harness_error";
    return { ok: false, code, error: error as SelfbuildingError };
  }
}

// ───────────────────────────── dispatch (demo-path §5) ─────────────────────────────

/** In-process calls on a dispatching host wait like plain Node: the durable host's own wait is for child runs. */
export function withInProcessWaits(ctx: AgentRunContext): AgentRunContext {
  const host = nodeHost({ runId: ctx.runId, epoch: ctx.epoch });
  // A prototype link keeps the context's scope getters live; a spread would freeze them.
  return Object.create(ctx, { host: { value: host, enumerable: true } }) as AgentRunContext;
}

// Hosts whose run already logged that a shared-handle call stays in the parent: one line per run, not per call.
const sharedHandleNoted = new WeakSet<object>();

/** Says once per run that shared-handle calls run in the parent task on a dispatching host (decision 0002). */
function noteSharedHandleInParent(ctx: AgentRunContext, callPath: string): void {
  if (sharedHandleNoted.has(ctx.host)) return;
  sharedHandleNoted.add(ctx.host);
  ctx.emit({
    type: "log",
    level: "info",
    callPath,
    data: {
      message: `shared-handle call runs in the parent task: ${callPath} and every later call on a sandbox() handle run in this ${ctx.host.id} task, which holds the box, its lease and its checkpoints. Only calls on a fresh box are dispatched as child tasks.`,
    },
  });
}

/** Sums two usages. Box time adds up too: each dispatched launch reports the box time it held (release-prep §3.2). */
function addUsage(a: Usage, b: Usage): Usage {
  const vcpu = a.sandboxVcpuMs !== undefined || b.sandboxVcpuMs !== undefined;
  return {
    usd: a.usd === null && b.usd === null ? null : (a.usd ?? 0) + (b.usd ?? 0),
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    turns: a.turns + b.turns,
    wallClockMs: a.wallClockMs,
    sandboxMs: a.sandboxMs + (b.sandboxMs ?? 0),
    ...(vcpu ? { sandboxVcpuMs: (a.sandboxVcpuMs ?? 0) + (b.sandboxVcpuMs ?? 0) } : {}),
  };
}

/**
 * Registers with the run's redactor every secret value a child task can be handed for this call: the harness
 * credentials (any of them, since the child picks from the pool) and the call's declared secrets. The child
 * resolves its own copies; the parent only needs the values to scrub them from what it stores and posts. A value
 * that does not resolve here is skipped: the child reports that failure itself. Values are never logged.
 */
async function noteDispatchedSecrets(state: CallState): Promise<void> {
  const { ctx, plan } = state;
  const values: string[] = [];
  const read = async (s: unknown): Promise<string | undefined> => {
    try {
      const v = typeof s === "function" ? await (s as () => Promise<string> | string)() : s;
      return typeof v === "string" && v !== "" ? v : undefined;
    } catch {
      return undefined;
    }
  };
  for (const cred of credentialPool(plan.harness.options.credentials)) {
    if (cred.kind === "provider-keys") {
      for (const s of Object.values(cred.values)) values.push((await read(s)) ?? "");
    } else if (cred.kind === "auth-file") {
      values.push(leasedContent(cred) ?? (await read(cred.value)) ?? "");
    } else {
      values.push((await read(cred.value)) ?? "");
    }
  }
  if (plan.secrets.length > 0 && ctx.config.secrets) {
    try {
      values.push(...Object.values(await ctx.config.secrets.resolve(plan.secrets)));
    } catch {
      // The child resolves the same names and fails the call with the real error.
    }
  }
  const delivered = [...new Set(values.filter((v) => v !== ""))];
  if (delivered.length === 0) return;
  state.secrets = [...new Set([...(state.secrets ?? []), ...delivered])];
  ctx.noteSecrets?.(delivered);
}

function launchNumber(launchId: string): number {
  const m = /_l(\d+)$/.exec(launchId);
  return m ? Number(m[1]) : 0;
}

/**
 * One agent call on a host that runs launch, wait and collect elsewhere (a Trigger.dev agent child): each launch is
 * dispatched as plain JSON and resolves with its raw outcome; accept, follow-up turns, the journal and box disposal
 * run here, where the closures live. The journal entry is the accept record, so there is one durability system.
 */
export async function runDispatched(
  state: CallState,
  startN: number,
  startResume?: DispatchResume,
): Promise<AgentResult<unknown>> {
  const { ctx, plan, def } = state;
  const host = ctx.host;
  const dispatch = (host.dispatchAgent as NonNullable<typeof host.dispatchAgent>).bind(host);
  const spec = agentCallSpec(def, plan, ctx.runId);
  let n = startN;
  let resume: DispatchResume | undefined = startResume;
  if (startResume) state.sessionId ??= startResume.sessionId;
  let ref: SandboxRef | undefined;
  let ok = false;
  let keep = false;
  const slot = ctx.acquireSlots ? await ctx.acquireSlots(plan.callPath, 1) : undefined;
  ctx.emit({ type: "agent.started", callPath: plan.callPath, data: { agent: plan.agentName, stepKey: plan.stepKey } });
  try {
    await noteDispatchedSecrets(state);
    for (;;) {
      if (state.signal?.aborted) throw state.signal.reason;
      const launchId = `${plan.hostKey}_l${n}` as LaunchId;
      await journalPut(state, {
        status: "started",
        launchId,
        ...(resume ? { value: { resume } as unknown as JournalEntry["value"] } : {}),
      });
      const raw = await dispatch({
        runId: ctx.runId,
        epoch: ctx.epoch,
        stepKey: plan.stepKey,
        callPath: plan.callPath,
        launch: n,
        spec,
        ...(resume ? { resume } : {}),
      });
      // The child may have moved on to later launches (a cold ask resumes as the next one).
      n = Math.max(n, launchNumber(raw.launchId));
      ref = (raw as { sandbox?: SandboxRef }).sandbox ?? ref;
      if (raw.ok) {
        state.usage = addUsage(state.usage, raw.usage);
        if (raw.sessionId) state.sessionId = raw.sessionId;
      } else if (raw.error.recovery?.sessionId) {
        state.sessionId = raw.error.recovery.sessionId;
      }
      if (!raw.ok && raw.error.code === "interrupted") {
        const canResume =
          plan.onInterrupted === "resume-session" &&
          plan.harness.resume !== undefined &&
          state.sessionId !== undefined &&
          state.attempts.resumes < plan.maxResumes;
        if (canResume) {
          state.attempts.resumes++;
          n++;
          resume = { message: interruptedMessage(new Date().toISOString()), sessionId: state.sessionId as string };
          continue;
        }
        throw rehydrateError(raw.error);
      }
      if (raw.ok && ref && !state.box && def.contract.done.some((check) => "assert" in check)) {
        // Done checks may exec in the box; it stays up until accept is over.
        state.box = await plan.provider.open(ref, { lifetimeMs: plan.timeouts.callMs });
      }
      const decision = await acceptAttempt(state, raw, n);
      if (decision.kind === "retry") {
        if (!state.sessionId || !plan.harness.resume) {
          const issue = decision.message;
          throw decision.counts === "doneRetries"
            ? new DoneCheckFailedError({ checkId: "resume-unavailable", output: issue }, errOpts(state))
            : new ResultValidationError({ issues: [issue] }, errOpts(state));
        }
        state.attempts[decision.counts]++;
        n++;
        resume = { message: decision.message, sessionId: state.sessionId };
        continue;
      }
      if (decision.kind === "failed") {
        keep = decision.keepBox ?? false;
        throw decision.error;
      }
      ok = true;
      // Accept measures box time on a box this process created; here every launch's child measured its own.
      if (state.boxStartedAt === undefined) {
        const { sandboxVcpuMs: _drop, ...usage } = decision.result.usage;
        decision.result.usage = {
          ...usage,
          sandboxMs: state.usage.sandboxMs,
          ...(state.usage.sandboxVcpuMs !== undefined ? { sandboxVcpuMs: state.usage.sandboxVcpuMs } : {}),
        };
      }
      const value = JSON.parse(JSON.stringify(decision.result)) as Json;
      await journalPut(state, {
        status: "ok",
        launchId: `${plan.hostKey}_l${n}` as LaunchId,
        value,
        finishedAt: new Date().toISOString(),
      });
      ctx.advanceChain(plan.stepKey, `${plan.hostKey}_l${n}`);
      ctx.emit({
        type: "agent.finished",
        callPath: plan.callPath,
        launchId: `${plan.hostKey}_l${n}`,
        data: { usage: decision.result.usage },
      });
      return decision.result;
    }
  } catch (error) {
    if (!(isSelfbuildingError(error) && error.kind === "usage")) {
      const serialized = serializeError(error);
      const launchId = `${plan.hostKey}_l${n}` as LaunchId;
      await journalPut(state, {
        status: "failed",
        launchId,
        value: { error: serialized } as unknown as JournalEntry["value"],
        finishedAt: new Date().toISOString(),
      }).catch(() => undefined);
      ctx.advanceChain(plan.stepKey, launchId);
      ctx.emit({
        type: "agent.failed",
        level: "error",
        callPath: plan.callPath,
        launchId,
        data: { code: serialized.code, message: serialized.message },
      });
    }
    throw error;
  } finally {
    await disposeDispatched(state, ref, ok, keep).catch((error) =>
      ctx.emit({
        type: "warning",
        level: "warn",
        callPath: plan.callPath,
        data: { scope: "dispose", message: String(error) },
      }),
    );
    slot?.release();
  }
}

/** The fresh box outlives each child, so follow-up turns resume in it; the parent disposes of it after accept. */
async function disposeDispatched(state: CallState, ref: SandboxRef | undefined, ok: boolean, keep: boolean) {
  const { ctx, plan } = state;
  if (!ref) return;
  if (!ok && (keep || plan.keepOnFailure)) {
    const outcome = await plan.provider.pause(ref);
    ctx.emit({
      type: outcome.confirmed ? "sandbox.parked" : "sandbox.pause_refused",
      level: outcome.confirmed ? "info" : "error",
      callPath: plan.callPath,
      data: { ref, ...outcome },
    });
    return;
  }
  await plan.provider.kill(ref);
  ctx.emit({ type: "sandbox.disposed", callPath: plan.callPath, data: { ref, mode: "kill" } });
}
