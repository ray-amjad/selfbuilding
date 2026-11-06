import {
  type AgentCallDriver,
  AgentInterruptedError,
  type AskResolution,
  type AskStore,
  type HostAgentCall,
  type Json,
  type LaunchProbeState,
  type LaunchRecord,
  noteLaunchDepth,
  type RawOutcome,
  type ResultStore,
  type SandboxRef,
} from "@selfbuilding/core";
import { rotateAskWaitpoint } from "./journal.js";
import {
  ASK_SLICE_MS,
  hostKeyOf,
  launchIdOf,
  MAX_PREMATURE_REARMS,
  MINUTE_MS,
  storeKeys,
  WAIT_GRACE_MS,
  wakeTokenKey,
} from "./keys.js";
import type { TriggerRunContext, TriggerSdk } from "./sdk.js";

// The `selfbuilding.agent` child task (spec §7.5.1): launch → one long wait per launch on a waitpoint token keyed
// on the launch id → collect. It returns the raw outcome; accept runs in the parent. Every step is safe to run again
// from the top after a retry or a crash: launch checks the outcome record and markers, tokens come back by their
// idempotency keys, and a completed token returns at once.

export interface AgentTaskPayload {
  call: HostAgentCall;
  /** The parent run to wake when this child finishes. */
  parentRunId?: string;
  /** Where the parent reads this child's outcome; written before the wake. */
  resultKey?: string;
  /**
   * The parent run's start_workflow launch depth, when it is not 0. This child is another process, and the start
   * grants it mints must carry that depth + 1 (release-prep §3.2 item 7).
   */
  launchDepth?: number;
  /** The run was started with no humans: every ask resolves by its AFK policy (release-prep §3.2 item 4). */
  afk?: boolean;
}

export interface ChildDeps {
  sdk: TriggerSdk;
  store: ResultStore;
  driver: (opts?: { afk?: boolean }) => Promise<AgentCallDriver>;
  /** The ask store the driver opens asks in; cold asks are marked there. */
  asks?: AskStore;
  /** True when asks live in `store` (the default ask store), so each wait slice can take over the waitpoint. */
  asksInStore?: boolean;
  /** Default ASK_SLICE_MS. */
  askSliceMs?: number;
  /** The vCPU count of a size name, for `Usage.sandboxVcpuMs`. */
  vcpuOf?: (size: string) => number | undefined;
  /** How long a stopped turn gets to write its outcome before the call counts as interrupted. */
  stopGraceMs?: number;
}

type LaunchEnd = { kind: "outcome"; outcome: RawOutcome } | { kind: "relaunch"; answer: AskResolution };

export async function runAgentChild(
  payload: AgentTaskPayload,
  ctx: TriggerRunContext,
  deps: ChildDeps,
): Promise<RawOutcome> {
  const { call } = payload;
  if (typeof payload.launchDepth === "number") noteLaunchDepth(call.runId, payload.launchDepth);
  const driver = await deps.driver(payload.afk ? { afk: true } : undefined);
  // Box time is wall-clock time, kept in the store so a retried child counts from the first attempt.
  const clockKey = storeKeys.launchClock(call.runId, launchIdOf(call, call.launch));
  await deps.store.createIfAbsent(clockKey, { at: Date.now() });
  const startedAt = (await deps.store.get<{ at: number }>(clockKey))?.at ?? Date.now();
  let launch = call.launch;
  let answer: AskResolution | undefined;
  let outcome: RawOutcome;
  for (;;) {
    const launchId = launchIdOf(call, launch);
    const started = await driver.launch(call, launchId, answer ? { answer } : undefined);
    if (started.kind === "settled") {
      outcome = started.outcome;
      break;
    }
    const end = await waitLaunch(call, started.record, driver, deps);
    if (end.kind === "outcome") {
      outcome = end.outcome;
      break;
    }
    // A cold ask: the answer resumes the session as the next launch attempt (spec §8.4 step 5).
    answer = end.answer;
    launch += 1;
  }
  outcome = withSandboxTime(outcome, Date.now() - startedAt, deps.vcpuOf);
  if (payload.resultKey) {
    // A retried child whose first attempt already wrote its value returns that one, so both agree.
    if (!(await deps.store.createIfAbsent(payload.resultKey, { value: outcome as unknown as Json }))) {
      const stored = await deps.store.get<{ value: Json }>(payload.resultKey);
      if (stored?.value) outcome = stored.value as unknown as RawOutcome;
    }
  }
  if (payload.parentRunId) {
    await deps.sdk
      .sendWake(payload.parentRunId, { kind: "child", hostKey: hostKeyOf(call), childRunId: ctx.run.id })
      .catch(() => {});
  }
  return outcome;
}

async function waitLaunch(
  call: HostAgentCall,
  record: LaunchRecord,
  driver: AgentCallDriver,
  deps: ChildDeps,
): Promise<LaunchEnd> {
  const { sdk } = deps;
  const tags = [call.runId];
  const waitDeadline = Date.parse(record.deadline) + WAIT_GRACE_MS;
  let rearm = 0;
  let premature = 0;
  let probe: LaunchProbeState | null = null;

  const armAndWait = async (deadline: number): Promise<boolean> => {
    const remaining = deadline - sdk.now();
    if (remaining <= 0) return false;
    const token = await sdk.createToken({
      idempotencyKey: wakeTokenKey(call.runId, record.launchId, rearm),
      timeoutMs: remaining,
      tags,
    });
    await driver.registerWake(call, record, { rearm, target: { kind: "url", url: token.url } });
    return (await sdk.forToken<Json>(token.id)).ok;
  };

  for (;;) {
    let woke = true;
    if (probe === null) {
      woke = await armAndWait(waitDeadline);
      probe = await driver.probe(call, record);
    }
    const state: LaunchProbeState = probe;
    probe = null;
    switch (state.state) {
      case "outcome":
        return { kind: "outcome", outcome: await driver.collect(call, record) };
      case "free":
        return { kind: "outcome", outcome: await driver.interrupted(call, record, "lock-free") };
      case "gone":
        return { kind: "outcome", outcome: await driver.interrupted(call, record, "gone") };
      case "ask":
      case "suspended": {
        const askId = state.ask.askId;
        let cold = state.state === "suspended";
        if (cold) await markCold(deps, askId, record);
        // A hot ask goes cold in the box when its hot wait ends, and nothing wakes this child for that: each wait
        // slice that ends unanswered looks again, so the record says cold soon after the turn does.
        const onSliceEnd = async () => {
          if (cold) return;
          const now = await driver.probe(call, record).catch(() => null);
          if (now?.state === "suspended" && now.ask.askId === askId) {
            cold = true;
            await markCold(deps, askId, record);
          }
        };
        const answered = await waitForAnswer(call, record, askId, state.ask.timeoutMs, driver, deps, onSliceEnd);
        if ("outcome" in answered) return { kind: "outcome", outcome: answered.outcome };
        // Hot or cold is decided by where the turn is now, not where it was: a hot ask can go cold while waiting.
        const now = await driver.probe(call, record);
        if (now.state === "ask" && now.ask.askId === state.ask.askId) {
          await driver.deliverAnswer(call, record, answered.resolution);
          rearm += 1;
          continue;
        }
        if (now.state === "suspended" && now.ask.askId === state.ask.askId) {
          return { kind: "relaunch", answer: answered.resolution };
        }
        rearm += 1;
        probe = now;
        continue;
      }
      case "busy":
      case "unknown": {
        if (woke && premature < MAX_PREMATURE_REARMS) {
          premature += 1;
          rearm += 1;
          continue;
        }
        if (state.state === "unknown") {
          return { kind: "outcome", outcome: await driver.interrupted(call, record, "unknown") };
        }
        return stopAndCollect(call, record, driver, deps, rearm + 1);
      }
    }
  }
}

/** The wait timed out with the turn still running: stop it through the cancel sentinel, then collect (§7.4.2). */
async function stopAndCollect(
  call: HostAgentCall,
  record: LaunchRecord,
  driver: AgentCallDriver,
  deps: ChildDeps,
  rearm: number,
): Promise<LaunchEnd> {
  const { sdk } = deps;
  await driver.stop(call, record, "wait-timeout");
  const token = await sdk.createToken({
    idempotencyKey: wakeTokenKey(call.runId, record.launchId, rearm),
    timeoutMs: deps.stopGraceMs ?? 5 * MINUTE_MS,
    tags: [call.runId],
  });
  await driver.registerWake(call, record, { rearm, target: { kind: "url", url: token.url } });
  await sdk.forToken<Json>(token.id);
  const after = await driver.probe(call, record);
  if (after.state === "outcome") return { kind: "outcome", outcome: await driver.collect(call, record) };
  return { kind: "outcome", outcome: await driver.interrupted(call, record, "wait-timeout") };
}

/**
 * The ask's own waitpoint (idempotency key: the ask id), created before anything is posted. The store is read
 * before and after every wait; the token only wakes the child (spec §8.5).
 *
 * The wait runs in slices of `askSliceMs`. When a slice times out with no answer in the store, the next slice gets
 * its own token (`<askId>:s<n>`), which the open ask's waitpoint is moved to, so the next answer completes the token
 * this child holds. An answer whose completion never arrived is found at the end of the slice it landed in.
 */
async function waitForAnswer(
  call: HostAgentCall,
  record: LaunchRecord,
  askId: string,
  timeoutMs: number,
  driver: AgentCallDriver,
  deps: ChildDeps,
  onSliceEnd: () => Promise<void>,
): Promise<{ resolution: AskResolution } | { outcome: RawOutcome }> {
  const { sdk } = deps;
  const tags = [call.runId];
  const slice = Math.max(1, deps.askSliceMs ?? ASK_SLICE_MS);
  const deadline = sdk.now() + Math.max(1, timeoutMs);
  const nextTimeout = () => Math.max(1, Math.min(slice, deadline - sdk.now()));
  let token = await sdk.createToken({ idempotencyKey: askId, timeoutMs: nextTimeout(), tags });
  let resolution = await driver.openAsk(call, record, askId, { host: "trigger", ref: token.id });
  for (let n = 1; !resolution; n++) {
    const completed = (await sdk.forToken<Json>(token.id)).ok;
    resolution = await driver.readAnswer(askId);
    // A completed token with no answer behind it (a cancel, a reaper repair) ends the wait as before.
    if (resolution || completed || sdk.now() >= deadline) break;
    await onSliceEnd();
    token = await sdk.createToken({ idempotencyKey: `${askId}:s${n}`, timeoutMs: nextTimeout(), tags });
    if (deps.asksInStore) await rotateAskWaitpoint(deps.store, askId, token.id);
    // Answered between the read above and the move: the rotate leaves an answered ask alone, so its waitpoint
    // still names the expired token and no wake reaches this one. Read again rather than wait out the slice.
    resolution = await driver.readAnswer(askId);
  }
  if (resolution) return { resolution };
  return driver.expireAsk(call, record, askId);
}

/** Records on the ask that its turn ended waiting (demo-path §6.1), keeping when it first went cold. */
async function markCold(deps: ChildDeps, askId: string, record: LaunchRecord): Promise<void> {
  if (!deps.asks?.markCold) return;
  const prior = await deps.asks.get(askId);
  const launch = /_l(\d+)$/.exec(record.launchId);
  await deps.asks.markCold(askId, {
    since: prior?.cold?.since ?? new Date(deps.sdk.now()).toISOString(),
    sandbox: record.sandbox,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(launch ? { launch: Number(launch[1]) } : {}),
  });
}

/**
 * Box time for a dispatched launch: from the first time a child started it to its outcome. The parent sums it over
 * launches (release-prep §3.2 item 6); a driver that measured it already keeps its own figure.
 */
function withSandboxTime(
  outcome: RawOutcome,
  elapsedMs: number,
  vcpuOf: ((size: string) => number | undefined) | undefined,
): RawOutcome {
  if (!outcome.ok || outcome.usage.sandboxMs > 0) return outcome;
  const sandboxMs = Math.max(0, elapsedMs);
  const size = (outcome as { sandbox?: SandboxRef }).sandbox?.size;
  const vcpu = size ? vcpuOf?.(size) : undefined;
  return {
    ...outcome,
    usage: { ...outcome.usage, sandboxMs, ...(vcpu !== undefined ? { sandboxVcpuMs: sandboxMs * vcpu } : {}) },
  };
}

/** A child that ended without returning (failed after its retries, cancelled, crashed) as an outcome value. */
export function childFailureOutcome(
  call: HostAgentCall,
  childRunId: string,
  status: string,
  message?: string,
): RawOutcome {
  const error = new AgentInterruptedError(
    `The agent child run ${childRunId} ended ${status}${message ? `: ${message}` : ""}. It is not re-run silently; resume the run to try it again.`,
    { runId: call.runId, callPath: call.callPath },
  );
  return { ok: false, launchId: launchIdOf(call, call.launch), error: error.toJSON() };
}
