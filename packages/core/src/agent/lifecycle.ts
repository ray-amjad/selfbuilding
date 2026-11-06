import type { SelfbuildingError } from "../errors/base.js";
import {
  AgentInterruptedError,
  ArtifactError,
  ArtifactPathError,
  ConfigError,
  DoneCheckFailedError,
  HarnessStartError,
  HitlConfigError,
  JournalConflictError,
  ResultIntegrityError,
  ResultValidationError,
} from "../errors/classes.js";
import type { ErrorCode, Recovery, SerializedSelfbuildingError } from "../errors/codes.js";
import { registerLaunchPoller } from "../host-node/index.js";
import { commitsAhead, diffPatch, diffStat, gitHostOf, hostPush } from "../sandbox/git.js";
import { durationMs, stableUuid } from "../sandbox/hash.js";
import {
  ackVerb,
  answerVerb,
  attemptDir,
  ensureRuntime,
  launchMarker,
  launchProbe,
  readText,
  resolveRuntimeBundles,
  shq,
  stageAttempt,
  startSupervisor,
  type VerbContext,
  waitVerb,
  writeCancel,
} from "../sandbox/runtime-client.js";
import {
  DEFAULT_LIFETIME_MS,
  imageFor,
  keyFor,
  resolveBoxSize,
  sandboxSpecFor,
  sizeEventData,
} from "../sandbox/spec.js";
import type { DoneContext } from "../types/agent.js";
import type { AgentResult, ArtifactRef, Artifacts, CheckOutcome, Usage } from "../types/artifacts.js";
import type { Json } from "../types/common.js";
import type { HarnessCredential, HarnessFailure, McpServerSpec, PathsContext } from "../types/harness.js";
import type { FenceRecord, LaunchId, RawOutcome } from "../types/host.js";
import type { JournalEntry } from "../types/orchestration.js";
import type { LaunchProbe, Outcome, ReadyEvent, RuntimeEvent, RuntimeSpec } from "../types/runtime.js";
import { ATTEMPT_FILES, SANDBOX_PATHS } from "../types/runtime.js";
import type { ExecResult, ProviderSandbox, SandboxHandle, SandboxRef } from "../types/sandbox.js";
import type { Secret } from "../types/security.js";
import type { AgentRunContext, BudgetSlice } from "./context.js";
import { unwrapResult } from "./contract.js";
import {
  credentialPool,
  isAccountFailure,
  keepReturnedCopy,
  leasedContent,
  releaseLease,
  tryLease,
  waitForLease,
} from "./credentials.js";
import { errorForCode, hasCode, isSelfbuildingError, rehydrateError, serializeError } from "./errors.js";
import type { AgentDefinition, CallPlan } from "./plan.js";
import { issuesOf } from "./plan.js";
import {
  buildPreamble,
  buildUserPrompt,
  doneCheckMessage,
  interruptedMessage,
  invalidResultMessage,
  substituteBody,
} from "./prompt.js";
import { stageStartGrant } from "./start-grant.js";

// One agent call as the launch → wait → collect → accept group (spec §7.4), run in-process on the plain Node host.

/** Knobs tests turn down; production keeps the spec values. */
export const AGENT_TUNABLES = {
  /** `wait --max` per long-poll (spec §6.6: 25 s stays under every gateway's ceiling). */
  waitSliceMs: 25_000,
  /** How long to wait for a cancelled turn to write its outcome. */
  cancelSettleMs: 120_000,
  /** How long a launched supervisor may take to write state.json before the turn counts as interrupted. */
  supervisorStartMs: 5 * 60_000,
  /** Backoff between retries of one artifact upload during collect, on top of the store's own retries. */
  uploadRetryMs: [1_000, 4_000, 15_000] as number[],
};

const MIN = 60_000;

interface Attempts {
  submits: number;
  resumes: number;
  doneRetries: number;
}

/** Everything one in-flight call carries between its launches. */
export interface CallState {
  ctx: AgentRunContext;
  def: AgentDefinition<unknown, unknown>;
  plan: CallPlan;
  signal?: AbortSignal;
  box?: ProviderSandbox;
  /** True when the call created its own box (fresh placement). */
  fresh: boolean;
  release?: () => void;
  attempts: Attempts;
  usage: Usage;
  sessionId?: string;
  /** The vendor id of the box the session's transcript lives in; a session resumes only in that box. */
  sessionBoxId?: string;
  harnessVersion?: string;
  ready?: Partial<ReadyEvent>;
  startedAt: number;
  boxStartedAt?: number;
  /** The fresh box's vCPU when it was created at a known size, for `Usage.sandboxVcpuMs`. */
  boxVcpu?: number;
  lastValidResult?: unknown;
  harnessStartedAt?: string;
  /** The run budget's slice for this call; turns are charged into it as they run (spec §3.9). */
  budget?: BudgetSlice;
  /** Secret values delivered to the box: no push may carry them out, and artifacts are redacted (spec §9.3). */
  secrets?: string[];
  /** The session id already journaled, so a crash can resume it. */
  journaledSessionId?: string;
  /** The pool position this call runs on (spec §4.9). */
  credIndex?: number;
  /** A login file leased to this call, and where it sits in the box. */
  lease?: { cred: HarnessCredential; path?: string; accepts?: (returned: string) => boolean };
  /** Credential files staged in the box; removed when a shared handle's call ends, so no snapshot keeps them. */
  credentialFiles?: string[];
  /** The harness failure of the last failed launch, for the pool. */
  lastFailure?: HarnessFailure;
  /** The lifetime heartbeat while the call holds a box (invariant 15). */
  heartbeat?: ReturnType<typeof setInterval>;
  /** True while the box is parked for a cold wait: the heartbeat leaves it alone. */
  coldWaiting?: boolean;
  /** Time this call spent waiting for a human; it is not active time, so it never shortens the box (demo-path §6). */
  askWaitMs?: number;
}

type WaitResult =
  | { kind: "outcome"; outcome: Outcome }
  | { kind: "interrupted"; harnessStarted: boolean }
  /** The turn ended for a cold ask (spec §8.4): the supervisor exited and the session waits for the answer. */
  | { kind: "suspended"; askId: string; sessionId: string };

type AcceptDecision =
  | { kind: "done"; result: AgentResult<unknown> }
  | { kind: "failed"; error: SelfbuildingError; keepBox?: boolean }
  | { kind: "retry"; message: string; counts: keyof Attempts };

function vctx(state: CallState): VerbContext {
  return { box: state.box as ProviderSandbox, provider: state.plan.provider, runId: state.ctx.runId };
}

function argumentNamesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function launchIdFor(plan: CallPlan, n: number): LaunchId {
  return `${plan.hostKey}_l${n}` as LaunchId;
}

function emptyUsage(): Usage {
  return { usd: null, inputTokens: 0, outputTokens: 0, turns: 0, wallClockMs: 0, sandboxMs: 0 };
}

function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a;
  return {
    usd: a.usd === null && b.usd === null ? null : (a.usd ?? 0) + (b.usd ?? 0),
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    turns: a.turns + b.turns,
    wallClockMs: a.wallClockMs,
    sandboxMs: a.sandboxMs,
  };
}

function recoveryOf(state: CallState, outcome?: Outcome): Recovery {
  const r: Recovery = { skill: state.plan.skill };
  const branch = outcome?.git.branch ?? state.plan.git.branch;
  if (branch) r.branch = branch;
  if (outcome?.git.headSha) r.headSha = outcome.git.headSha;
  if (state.sessionId) r.sessionId = state.sessionId;
  if (state.box) r.sandbox = state.box.ref;
  if (state.lastValidResult !== undefined) r.lastValidResult = state.lastValidResult;
  return r;
}

export function errOpts(state: CallState, outcome?: Outcome) {
  return { runId: state.ctx.runId, callPath: state.plan.callPath, recovery: recoveryOf(state, outcome) };
}

// ───────────────────────────── journal ─────────────────────────────

export async function journalPut(
  state: CallState,
  entry: Partial<JournalEntry> & Pick<JournalEntry, "status" | "launchId">,
) {
  const journal = state.ctx.journal;
  if (!journal) return;
  await journal.store.assertLease(journal.lease);
  const existing = await journal.store.get(state.ctx.runId, state.plan.stepKey);
  const next: JournalEntry = {
    runId: state.ctx.runId,
    stepKey: state.plan.stepKey,
    callPath: state.plan.callPath,
    kind: "agent",
    attempt: existing?.attempt ?? 1,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    ...(existing?.sandbox ? { sandbox: existing.sandbox } : {}),
    ...(existing?.harnessStartedAt ? { harnessStartedAt: existing.harnessStartedAt } : {}),
    ...entry,
  };
  const ok = await journal.store.put(next, { lease: journal.lease, expectStatus: existing ? existing.status : null });
  if (!ok) throw new JournalConflictError(`The journal entry for ${state.plan.callPath} changed under this run.`);
}

/** Journals the harness session id on the started entry once known, so a resume after a crash can continue it. */
async function journalSession(state: CallState, launchId: LaunchId, sessionId: string): Promise<void> {
  if (!state.ctx.journal || state.journaledSessionId === sessionId) return;
  state.journaledSessionId = sessionId;
  const existing = await state.ctx.journal.store.get(state.ctx.runId, state.plan.stepKey);
  if (existing && existing.status !== "started") return;
  await journalPut(state, {
    status: "started",
    launchId,
    sandbox: {
      ...(existing?.sandbox ?? { boxId: state.plan.handle?.id ?? state.plan.callPath }),
      ...(state.box ? { ref: state.box.ref } : {}),
      harnessSessionId: sessionId,
    },
  });
}

export function setSession(state: CallState, sessionId: string): void {
  if (state.sessionId !== sessionId || state.sessionBoxId === undefined) {
    if (state.box) state.sessionBoxId = state.box.ref.id;
  }
  state.sessionId = sessionId;
}

/**
 * The session a follow-up may resume: the harness keeps its transcript inside the box, so a session started in a box
 * that is gone (a shared handle reopened after its box was disposed) cannot be resumed; the call relaunches instead.
 */
export function resumableSession(state: CallState): string | undefined {
  if (!state.sessionId || !state.plan.harness.resume) return undefined;
  if (state.sessionBoxId !== undefined && state.box && state.box.ref.id !== state.sessionBoxId) return undefined;
  return state.sessionId;
}

function redact(text: string, secrets: readonly string[] | undefined): string {
  let out = text;
  for (const s of secrets ?? []) if (s.length >= 8) out = out.split(s).join("[REDACTED]");
  return out;
}

// ───────────────────────────── fences (spec §7.4.5) ─────────────────────────────

function fenceKey(state: CallState): string {
  return `fences/${state.ctx.runId}/${state.plan.hostKey}`;
}

async function advanceFence(state: CallState, launchId: LaunchId): Promise<void> {
  const results = state.ctx.results;
  for (let i = 0; i < 5; i++) {
    const current = await results.getVersioned<FenceRecord & Json>(fenceKey(state));
    if (current?.value.current === launchId) return;
    const next: FenceRecord = {
      hostKey: state.plan.hostKey as FenceRecord["hostKey"],
      current: launchId,
      branch: state.plan.git.branch,
      expectSha: current?.value.expectSha ?? null,
      superseded: current ? [...current.value.superseded, current.value.current] : [],
    };
    if (await results.replace(fenceKey(state), next as unknown as Json, current?.version ?? null)) return;
  }
  throw new JournalConflictError(`Could not advance the fence for ${state.plan.callPath}.`);
}

async function isCurrentLaunch(state: CallState, launchId: LaunchId): Promise<boolean> {
  const fence = await state.ctx.results.get<FenceRecord & Json>(fenceKey(state));
  return !fence || fence.current === launchId;
}

async function recordPushedSha(state: CallState, sha: string): Promise<void> {
  const current = await state.ctx.results.getVersioned<FenceRecord & Json>(fenceKey(state));
  if (!current) return;
  await state.ctx.results.replace(
    fenceKey(state),
    { ...(current.value as FenceRecord), expectSha: sha } as unknown as Json,
    current.version,
  );
}

// ───────────────────────────── placement ─────────────────────────────

/** Finds or creates the call's box. A fresh box is keyed by the callPath, so a retry finds the first one. */
export async function acquireBox(state: CallState, launchId: LaunchId): Promise<void> {
  const { ctx, plan } = state;
  if (state.box) return;
  if (plan.handle) {
    const lease = await plan.handle.beginCall(plan.callPath);
    state.box = lease.box;
    state.release = lease.release;
    state.fresh = false;
    return;
  }
  const key = keyFor(ctx, plan.callPath);
  const lifetimeMs = Math.min(
    plan.timeouts.callMs + 15 * MIN,
    plan.provider.limits.maxLifetimeMs,
    DEFAULT_LIFETIME_MS * 4,
  );
  // A resume recreates the box at the size the first launch journaled, even if the code now asks for another.
  const journaledSize = ctx.journal ? (await ctx.journal.store.get(ctx.runId, plan.stepKey))?.sandbox?.size : undefined;
  const size = journaledSize ?? plan.size;
  // Resolved before a slot is taken, so a refused size holds no capacity (demo-path §1.2).
  const spec = sandboxSpecFor(ctx, {
    key,
    image: imageFor(plan.harness.id),
    lifetimeMs,
    stepKey: plan.stepKey,
    launchId,
    provider: plan.provider,
    callPath: plan.callPath,
    ...(size !== undefined ? { size } : {}),
  });
  const slot = ctx.acquireSlots ? await ctx.acquireSlots(plan.callPath, 1) : undefined;
  try {
    const opened = await plan.provider.openOrCreate(key, spec, state.signal ? { signal: state.signal } : undefined);
    state.box = opened.handle;
    state.fresh = true;
    state.boxStartedAt = Date.now();
    if (spec.size) state.boxVcpu = spec.size.vcpu;
    state.release = () => slot?.release();
    if (opened.created || opened.rebuilt) {
      ctx.emit({
        type: "sandbox.created",
        callPath: plan.callPath,
        data: { ref: opened.handle.ref, rebuilt: opened.rebuilt, ...sizeEventData(plan.provider, spec) },
      });
    }
    await journalPut(state, {
      status: "started",
      launchId,
      sandbox: {
        boxId: plan.callPath,
        ref: opened.handle.ref,
        ...(spec.size ? { size: spec.size.name } : {}),
      },
    });
  } catch (error) {
    slot?.release();
    throw error;
  }
}

/** Disposition after the call (spec §6.14): fresh boxes are killed (or parked with keepOnFailure); handles stay. */
export async function disposeBox(state: CallState, ok: boolean, keep = false): Promise<void> {
  const box = state.box;
  try {
    if (!box || !state.fresh) return;
    if (!ok && (keep || state.plan.keepOnFailure)) {
      const outcome = await state.plan.provider.pause(box.ref);
      if (!outcome.confirmed) {
        state.ctx.emit({
          type: "sandbox.pause_refused",
          level: "error",
          callPath: state.plan.callPath,
          data: { ...outcome },
        });
        // Kept for inspection, not for a resume: a short TTL bounds what a running box costs (spec §9.9 #5).
        await shortenLifetime(state, box);
      }
      return;
    }
    await state.plan.provider.kill(box.ref);
    state.ctx.emit({ type: "sandbox.disposed", callPath: state.plan.callPath, data: { ref: box.ref, mode: "kill" } });
  } finally {
    state.release?.();
    state.release = undefined;
  }
}

/** How long a box whose pause was refused may keep running before the provider stops it (spec §9.9 #5). */
const REFUSED_PAUSE_TTL_MS = 15 * MIN;

/**
 * Parks a call's own box for a cold wait (spec §8.4 step 3): a pause where the provider confirms one. A refused
 * pause is an error-level event and falls back to a short provider TTL, so a days-long wait does not bill a running
 * box (spec §9.9 #5). A pause whose outcome is unknown does not fail the call: the wait goes on.
 */
async function parkBox(state: CallState): Promise<void> {
  const box = state.box;
  if (!box || state.plan.handle) return;
  let outcome: Awaited<ReturnType<typeof state.plan.provider.pause>>;
  try {
    outcome = await state.plan.provider.pause(box.ref);
  } catch (error) {
    if (!hasCode(error, "sandbox_unavailable")) throw error;
    state.ctx.emit({
      type: "sandbox.pause_refused",
      level: "error",
      callPath: state.plan.callPath,
      data: { ref: box.ref, confirmed: false, reason: "unknown", message: (error as Error).message },
    });
    await shortenLifetime(state, box);
    return;
  }
  state.ctx.emit({
    type: outcome.confirmed ? "sandbox.parked" : "sandbox.pause_refused",
    level: outcome.confirmed ? "info" : "error",
    callPath: state.plan.callPath,
    data: { ref: box.ref, ...outcome },
  });
  if (!outcome.confirmed) await shortenLifetime(state, box);
}

/** The refused-pause fallback for a box that must survive the wait: a short TTL whose expiry pauses it. */
async function shortenLifetime(state: CallState, box: ProviderSandbox): Promise<void> {
  try {
    await box.extendLifetime(Date.now() + REFUSED_PAUSE_TTL_MS, { allowShorter: true });
  } catch (error) {
    state.ctx.emit({
      type: "warning",
      level: "warn",
      callPath: state.plan.callPath,
      data: { scope: "lifetime", message: (error as Error).message },
    });
  }
}

/** Reopens a parked box before the resumed launch. */
async function unparkBox(state: CallState): Promise<void> {
  const box = state.box;
  if (!box || state.plan.handle) return;
  state.box = await state.plan.provider.open(box.ref, { lifetimeMs: state.plan.timeouts.callMs + 15 * MIN });
}

// ───────────────────────────── lifetime heartbeat (invariant 15) ─────────────────────────────

const HEARTBEAT_MS = 5 * MIN;

/**
 * Keeps the box alive for what the call may still use: its remaining active time plus a margin, re-armed at every
 * launch and every 5 minutes. A shared handle's box is created with a fixed lifetime, so without this a long
 * pipeline outlives it in the middle of a turn. An extend never shortens (the provider keeps a later deadline).
 */
async function extendForCall(state: CallState): Promise<void> {
  const box = state.box;
  if (!box || state.coldWaiting) return;
  const active = Date.now() - state.startedAt - (state.askWaitMs ?? 0);
  const remaining = Math.max(0, state.plan.timeouts.callMs - active);
  try {
    const r = await box.extendLifetime(Date.now() + Math.max(remaining, 15 * MIN) + 15 * MIN);
    if (r.clamped) {
      state.ctx.emit({
        type: "sandbox.lifetime_clamped",
        level: "warn",
        callPath: state.plan.callPath,
        data: { ref: box.ref, untilMs: r.untilMs },
      });
    }
  } catch (error) {
    state.ctx.emit({
      type: "warning",
      level: "warn",
      callPath: state.plan.callPath,
      data: { scope: "lifetime", message: (error as Error).message },
    });
  }
}

/** Keeps the box up through an ask's hot window plus a margin; the heartbeat may not run that long unaided. */
async function extendForAsk(state: CallState): Promise<void> {
  const box = state.box;
  if (!box || state.coldWaiting) return;
  try {
    await box.extendLifetime(Date.now() + state.plan.hotWaitMs + 15 * MIN);
  } catch (error) {
    state.ctx.emit({
      type: "warning",
      level: "warn",
      callPath: state.plan.callPath,
      data: { scope: "lifetime", message: (error as Error).message },
    });
  }
}

function startHeartbeat(state: CallState): void {
  if (state.heartbeat) return;
  state.heartbeat = setInterval(() => void extendForCall(state), HEARTBEAT_MS);
  (state.heartbeat as { unref?: () => void }).unref?.();
}

function stopHeartbeat(state: CallState): void {
  if (state.heartbeat) clearInterval(state.heartbeat);
  state.heartbeat = undefined;
}

// ───────────────────────────── staging ─────────────────────────────

function pathsFor(dir: string): PathsContext {
  return {
    workdir: SANDBOX_PATHS.workdir,
    home: SANDBOX_PATHS.home,
    in: SANDBOX_PATHS.in,
    out: dir,
    bin: SANDBOX_PATHS.bin,
    skills: SANDBOX_PATHS.skills,
    secrets: SANDBOX_PATHS.secrets,
    state: SANDBOX_PATHS.state,
    run: SANDBOX_PATHS.run,
  };
}

async function resolveSecret(secret: Secret): Promise<string> {
  return typeof secret === "function" ? secret() : secret;
}

async function credentialValues(cred: HarnessCredential): Promise<Record<string, string>> {
  switch (cred.kind) {
    case "api-key": {
      const v = await resolveSecret(cred.value);
      return { value: v, API_KEY: v };
    }
    case "oauth-token": {
      const v = await resolveSecret(cred.value);
      return { value: v, OAUTH_TOKEN: v };
    }
    case "auth-file": {
      // A sandbox may have refreshed the login since it was resolved; the refreshed copy is the live one.
      const v = leasedContent(cred) ?? (await resolveSecret(cred.value));
      return { value: v, AUTH_FILE: v };
    }
    case "provider-keys": {
      const out: Record<string, string> = {};
      for (const [k, s] of Object.entries(cred.values)) out[k] = await resolveSecret(s);
      return out;
    }
  }
}

function leaseHolder(state: CallState): string {
  return `${state.ctx.runId}/${state.plan.callPath}`;
}

/**
 * The call's credential: its pinned pool position, or the first free one. A login file is leased first; when
 * another sandbox holds it, a free credential later in the pool takes over, else the call waits for the lease.
 */
async function pickCredential(state: CallState): Promise<HarnessCredential | undefined> {
  const pool = credentialPool(state.plan.harness.options.credentials);
  if (pool.length === 0) return undefined;
  const holder = leaseHolder(state);
  const start = state.credIndex ?? 0;
  if (state.credIndex === undefined) {
    for (let i = 0; i < pool.length; i++) {
      const cred = pool[i] as HarnessCredential;
      if (cred.kind !== "auth-file" || tryLease(cred, holder)) {
        state.credIndex = i;
        break;
      }
    }
  }
  state.credIndex ??= start;
  const cred = pool[state.credIndex] as HarnessCredential;
  if (cred.kind === "auth-file" && state.lease?.cred !== cred) {
    await waitForLease(cred, holder, state.signal);
    state.lease = { cred };
  }
  return cred;
}

/** A returned login file larger than this is not a login file; it is dropped. */
export const LEASED_FILE_MAX_BYTES = 64 * 1024;

/**
 * Reads a leased file back as the agent user, refusing a symlink or anything but a regular file and anything over
 * LEASED_FILE_MAX_BYTES (release-prep §7.2 #5). Exit 2: no file. Exit 3: not a regular file. Exit 4: too large.
 */
export function leasedFileReadCommand(p: string): string {
  const q = shq(p);
  return [
    `{ [ -e ${q} ] || [ -L ${q} ]; } || exit 2`,
    `{ test -f ${q} && test ! -L ${q}; } || exit 3`,
    `n=$(wc -c < ${q}) || exit 3`,
    `[ "$n" -le ${LEASED_FILE_MAX_BYTES} ] || exit 4`,
    `head -c ${LEASED_FILE_MAX_BYTES} ${q}`,
  ].join("; ");
}

/** Copies a leased login file back from the box into the pool, then removes it from the box (spec §4.9). */
async function returnLeasedFile(state: CallState): Promise<void> {
  const lease = state.lease;
  if (!lease?.path || !state.box) return;
  const r = await state.box
    .exec(leasedFileReadCommand(lease.path), { user: "agent", timeoutMs: 30_000 })
    .catch((error: unknown) => ({ exitCode: -1, stdoutTail: "", stderrTail: String(error), truncated: false }));
  let returned: string | null = null;
  if (r.exitCode === 0 && !r.truncated) returned = r.stdoutTail;
  else if (r.exitCode !== 2) {
    // The agent owns the box: a link to a root-only file, a device or a huge file never reaches the pool.
    const why =
      r.exitCode === 3
        ? "it is not a regular file"
        : r.exitCode === 4 || r.truncated
          ? `it is over ${LEASED_FILE_MAX_BYTES} bytes`
          : `it could not be read (exit ${r.exitCode})`;
    state.ctx.emit({
      type: "warning",
      level: "warn",
      callPath: state.plan.callPath,
      data: { scope: "credentials", message: `the leased login file was not returned to the pool: ${why}` },
    });
  }
  // The agent owns the file: a copy that is not the same login (another account, a corrupt object) never
  // reaches the pool that later calls lease from.
  if (returned !== null && (lease.accepts?.(returned) ?? true)) keepReturnedCopy(lease.cred, returned);
  await state.box.exec(`rm -f ${shq(lease.path)}`, { user: "root", timeoutMs: 30_000 }).catch(() => undefined);
}

function endLease(state: CallState): void {
  if (state.lease) releaseLease(state.lease.cred, leaseHolder(state));
  state.lease = undefined;
}

/** Moves to the next credential after an account failure. True when there is one to move to. */
function failOver(state: CallState): boolean {
  const failure = state.lastFailure;
  if (!failure) return false;
  const pool = credentialPool(state.plan.harness.options.credentials);
  const current = state.credIndex ?? 0;
  const cred = pool[current];
  if (!cred || !isAccountFailure(cred, failure, pool) || current + 1 >= pool.length) return false;
  endLease(state);
  state.credIndex = current + 1;
  state.ctx.emit({
    type: "agent.credential_switched",
    level: "warn",
    callPath: state.plan.callPath,
    data: { from: current, to: current + 1, reason: failure.code },
  });
  return true;
}

export async function resolveVersion(state: CallState): Promise<string> {
  const { harness } = state.plan;
  const hold = state.ctx.config.harnessHold?.[harness.id as keyof NonNullable<typeof state.ctx.config.harnessHold>];
  const policy = hold ?? harness.options.version;
  if (policy && policy !== "tested" && policy !== "latest") return policy;
  const cmd = harness.versionCommand();
  const quoted = cmd.argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const box = state.box as ProviderSandbox;
  let r = await box.exec(quoted, { timeoutMs: cmd.timeoutMs ?? 60_000, user: "agent" });
  if (r.exitCode === 127) {
    // The box's image does not carry this harness (a Codex reviewer on a fork of a Claude Code box): install it.
    await installHarness(state, policy === "latest" ? undefined : harness.testedVersion);
    r = await box.exec(quoted, { timeoutMs: cmd.timeoutMs ?? 60_000, user: "agent" });
  }
  if (r.exitCode !== 0)
    throw new HarnessStartError(`${harness.id} --version exited ${r.exitCode}: ${r.stderrTail.trim()}`);
  return harness.parseVersion(r.stdoutTail);
}

async function installHarness(state: CallState, version: string | undefined): Promise<void> {
  const { harness } = state.plan;
  if (!version) {
    throw new HarnessStartError(
      `${harness.id} is not installed in this box and has no tested version to install; use an image that carries it.`,
    );
  }
  const plan = harness.install(version);
  const box = state.box as ProviderSandbox;
  for (const c of plan.commands) {
    const env = Object.entries(c.env ?? {}).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`);
    const argv = c.argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const line = `${env.length > 0 ? `env ${env.join(" ")} ` : ""}${argv}`;
    const done = await box.exec(line, { timeoutMs: c.timeoutMs ?? 300_000, user: c.user ?? "root", cwd: c.cwd ?? "/" });
    if (done.exitCode !== 0) {
      throw new HarnessStartError(
        `Installing ${harness.id} ${version} in the box failed (${done.exitCode}): ${done.stderrTail.trim().slice(-600)}`,
      );
    }
  }
  state.ctx.emit({
    type: "warning",
    level: "warn",
    callPath: state.plan.callPath,
    data: { scope: "harness", message: `${harness.id} ${version} was not in the box's image; installed it` },
  });
}

/**
 * Builds the harness plan on the host and stages everything the runtime needs (spec §6.4): skill files, harness
 * config, secret files (0600, under /run), spec.json and the prompt. Secrets never enter spec.json or env.
 */
async function stageLaunch(
  state: CallState,
  launchId: LaunchId,
  attempt: number,
  followUp: { message: string; resumeSessionId: string } | undefined,
): Promise<void> {
  const { ctx, plan, def } = state;
  const box = state.box as ProviderSandbox;
  const dir = attemptDir(plan.stepKey, attempt);
  const paths = pathsFor(dir);
  const harness = plan.harness;
  state.harnessVersion ??= await resolveVersion(state);
  const sessionId =
    followUp?.resumeSessionId ??
    (harness.capabilities.preassignSessionId ? stableUuid(`${ctx.runId}:${plan.callPath}:${attempt}`) : undefined);

  const skillName = def.skill?.name;
  const writes: { path: string; data: string | Uint8Array; mode: number; owner: "agent" | "root" }[] = [];
  if (def.skill) {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    for (const file of def.skill.files) {
      writes.push({
        path: `${SANDBOX_PATHS.skills}/${def.skill.name}/${file.path}`,
        data: await readFile(join(def.skill.dir, file.path)),
        mode: file.mode & 0o777 || 0o644,
        owner: "root",
      });
    }
  }

  // start_workflow (demo-path §9.3): a fresh grant per launch, root-only; the MCP server offers the tool on the flag.
  const startGrant = plan.startWorkflow
    ? await stageStartGrant(ctx.config, {
        runId: ctx.runId,
        callPath: plan.callPath,
        agentName: plan.agentName,
        ...(plan.budget?.usd !== undefined ? { budgetUsd: plan.budget.usd } : {}),
      })
    : undefined;
  const mcpServers: McpServerSpec[] = [
    {
      name: "selfbuilding",
      type: "stdio",
      command: "node",
      args: [SANDBOX_PATHS.mcpBundle, ...(startGrant ? ["--start-workflow"] : [])],
    },
    // The selfbuilding server cannot be shadowed by a caller's server of the same name.
    ...(plan.mcpServers ?? []).filter((server) => server.name !== "selfbuilding"),
  ];
  const filePlan = harness.prepare({
    runId: ctx.runId,
    callPath: plan.callPath,
    attempt,
    paths,
    skills: skillName ? [skillName] : [],
    mcpServers,
    hotWaitMs: plan.hotWaitMs,
    ...(harness.options.model ? { model: harness.options.model } : {}),
    ...(plan.effort ? { effort: plan.effort } : {}),
  });
  for (const f of filePlan.files) {
    writes.push({ path: f.path, data: f.content, mode: f.mode, owner: f.owner ?? (f.secret ? "root" : "agent") });
    if (f.secret) state.credentialFiles = [...new Set([...(state.credentialFiles ?? []), f.path])];
  }

  const secretEnv: Record<string, string> = {};
  const stripEnv: string[] = [];
  const delivered: string[] = [];
  const credential = await pickCredential(state);
  if (credential) {
    const values = await credentialValues(credential);
    delivered.push(...Object.values(values));
    const authPlan = harness.auth(credential, { paths, values });
    for (const f of authPlan.files) {
      writes.push({ path: f.path, data: f.content, mode: 0o600, owner: f.owner ?? "root" });
    }
    if (authPlan.leasedFile && state.lease?.cred === credential) {
      state.lease.path = authPlan.leasedFile.path;
      if (authPlan.leasedFile.accepts) state.lease.accepts = authPlan.leasedFile.accepts;
    }
    state.credentialFiles = [...new Set([...(state.credentialFiles ?? []), ...authPlan.files.map((f) => f.path)])];
    for (const [name, value] of Object.entries(authPlan.env)) {
      const file = `${SANDBOX_PATHS.secrets}/${name}`;
      writes.push({ path: file, data: value, mode: 0o600, owner: "root" });
      secretEnv[name] = file;
    }
    // Adapters that already wrote the secret as a file name the variable it becomes (env name → file path).
    Object.assign(secretEnv, authPlan.secretEnv ?? {});
    stripEnv.push(...authPlan.stripEnv);
  }
  if (plan.secrets.length > 0) {
    if (!ctx.config.secrets) {
      throw new ConfigError(
        `${plan.agentName} declares secrets ${plan.secrets.join(", ")} but no secret source is configured.`,
      );
    }
    const values = await ctx.config.secrets.resolve(plan.secrets);
    delivered.push(...Object.values(values));
    for (const [name, value] of Object.entries(values)) {
      writes.push({ path: `${SANDBOX_PATHS.secrets}/${name}`, data: value, mode: 0o600, owner: "root" });
    }
  }
  // The runtime clones the repo at boot as root, reading the read token from a root-only file. A fresh token per
  // launch, since installation tokens expire within the hour.
  const broker = ctx.config.git;
  if (broker && plan.repo && gitHostOf(plan.repo)) {
    const token = await broker.readToken({ repo: plan.repo, runId: ctx.runId, callPath: plan.callPath });
    delivered.push(token.value);
    writes.push({ path: SANDBOX_PATHS.gitReadToken, data: token.value, mode: 0o600, owner: "root" });
  }
  if (startGrant) {
    writes.push(startGrant.file);
    delivered.push(startGrant.grant);
  }
  if (writes.length > 0) await box.writeFiles(writes);
  state.secrets = [...new Set([...(state.secrets ?? []), ...delivered])];
  ctx.noteSecrets?.(delivered);
  plan.handle?.noteSecrets(delivered);
  plan.handle?.noteCredentialFiles(state.credentialFiles ?? []);
  // A preassigned id is known before the harness starts; journaling it lets a crashed turn resume (spec §3.10).
  if (sessionId && !followUp) setSession(state, sessionId);

  const promptFile = `${SANDBOX_PATHS.in}/prompt.md`;
  const systemFile = `${SANDBOX_PATHS.in}/system.md`;
  const invokeCtx = {
    runId: ctx.runId,
    callPath: plan.callPath,
    attempt,
    paths,
    promptFile,
    systemFile,
    ...(harness.options.model ? { model: harness.options.model } : {}),
    ...(plan.effort ? { effort: plan.effort } : {}),
    ...(plan.budget?.usd !== undefined ? { budgetUsd: plan.budget.usd } : {}),
    ...(sessionId && !followUp ? { sessionId } : {}),
    // Adapters that set MCP servers and the tool timeout per invocation (on argv or env) need what prepare() got.
    mcpServers,
    hotWaitMs: plan.hotWaitMs,
    ...(filePlan.mcpToolTimeoutMs === null ? {} : { mcpToolTimeoutMs: filePlan.mcpToolTimeoutMs }),
  };
  const invocation = harness.invoke(invokeCtx);
  const resume = harness.resume?.({ ...invokeCtx, sessionId: "{sessionId}", promptFile: "{promptFile}" });

  const userPrompt = followUp
    ? followUp.message
    : buildUserPrompt({
        title: def.skill ? `Skill: ${def.skill.name}` : plan.agentName,
        body: def.literal
          ? def.body
          : substituteBody(def.body, {
              skillName: skillName ?? plan.agentName,
              ...(sessionId ? { sessionId } : {}),
              input: plan.input,
              argumentNames: argumentNamesOf(def.skill?.frontmatter.arguments),
            }).text,
        workspace: {
          ...(plan.repo ? { repo: plan.repo } : {}),
          baseBranch: plan.git.baseBranch,
          branch: plan.git.branch,
          readOnly: plan.git.readOnly,
        },
        input: plan.input,
      });
  const system = buildPreamble({
    resultSchema: plan.resultJsonSchema,
    doneChecks: plan.doneChecks,
    protectedPaths: plan.protectedPaths,
    branchRequirement: plan.branchRequirement,
    ...(plan.testCommand ? { testCommand: plan.testCommand } : {}),
    submitTool: harness.toolName("selfbuilding", "submit_result"),
    askTool: harness.toolName("selfbuilding", "ask_human"),
    harnessNotes: harness.id === "claude-code" ? [] : ["Subagents are unavailable: do every step in sequence."],
  });

  const spec: RuntimeSpec = {
    v: 1,
    runId: ctx.runId,
    callId: `${ctx.runId}.${plan.callPath}`,
    callPath: plan.callPath,
    stepKey: plan.stepKey,
    attempt,
    launchId,
    harness: harness.id,
    harnessVersion: state.harnessVersion,
    ...(sessionId && !followUp ? { sessionId } : {}),
    ...(followUp ? { resumeSessionId: followUp.resumeSessionId } : {}),
    resultSchema: plan.resultJsonSchema,
    maxResultBytes: plan.maxResultBytes,
    git: plan.git,
    timeouts: plan.timeouts,
    hotWaitMs: plan.hotWaitMs,
    env: { declared: plan.secrets },
    agentName: plan.agentName,
    bootMode: state.fresh ? "fresh" : "reuse",
    plan: {
      streamFormat: harness.capabilities.streamFormat ?? (harness.id as RuntimeSpec["plan"]["streamFormat"]),
      invocation,
      ...(resume ? { resume } : {}),
      stopAfterSubmit: harness.capabilities.stopAfterSubmit,
      stripEnv,
      secretEnv,
      versionArgv: harness.versionCommand().argv,
    },
    maxSubmitAttempts: plan.maxSubmitAttempts,
    maxResumes: plan.maxResumes,
    maxDoneRetries: plan.maxDoneRetries,
    doneChecks: plan.doneChecks,
    protect: { paths: plan.protectedPaths, allow: [...def.contract.protect.allow] },
    artifactsBranch: plan.branchRequirement,
    ...(plan.budget?.usd !== undefined ? { budgetUsd: plan.budget.usd } : {}),
    postSubmitChanges: "revert",
    wipPushIntervalMs: plan.provider.limits.lifetimeGuaranteed ? 0 : 10 * MIN,
    skills: { names: skillName ? [skillName] : [], linkDirs: [...harness.capabilities.skillDirs] },
    requireIsolation: plan.requireIsolation,
    turnIndexBase: state.usage.turns,
    ...(startGrant ? { startWorkflow: startGrant.spec } : {}),
  };
  await stageAttempt(box, spec, { "prompt.md": userPrompt, "system.md": system });
}

// ───────────────────────────── launch (spec §7.4.1) ─────────────────────────────

export type LaunchResult =
  | { kind: "recorded"; raw: RawOutcome }
  | { kind: "probe"; probe: LaunchProbe; attempt: number };

export async function launchAttempt(
  state: CallState,
  n: number,
  requested?: { message: string; resumeSessionId: string },
): Promise<LaunchResult> {
  let followUp = requested;
  const { ctx, plan } = state;
  const launchId = launchIdFor(plan, n);
  const attempt = n + 1;
  if (ctx.journal) await ctx.journal.store.assertLease(ctx.journal.lease);
  const recorded = await ctx.results.get<RawOutcome & Json>(`outcomes/${ctx.runId}/${launchId}`);
  if (recorded) return { kind: "recorded", raw: recorded as unknown as RawOutcome };
  await advanceFence(state, launchId);
  await acquireBox(state, launchId);
  if (followUp && state.sessionBoxId !== undefined && state.box && state.box.ref.id !== state.sessionBoxId) {
    // The decision to resume can be made before this box existed (a replayed outcome); its session is not here.
    ctx.emit({
      type: "warning",
      level: "warn",
      callPath: plan.callPath,
      data: { scope: "session", message: "the session lived in a box that is gone; relaunching instead of resuming" },
    });
    followUp = undefined;
    state.sessionId = undefined;
    state.sessionBoxId = undefined;
  }
  await extendForCall(state);
  startHeartbeat(state);
  const box = state.box as ProviderSandbox;
  await ensureRuntime(box, await resolveRuntimeBundles());
  if ((await readText(box, launchMarker(launchId, "launched"))) === null) {
    await stageLaunch(state, launchId, attempt, followUp);
  }
  if (ctx.journal) await ctx.journal.store.assertLease(ctx.journal.lease);
  const probe = await launchProbe(vctx(state), plan.stepKey, attempt, launchId);
  if (probe.action === "start") {
    try {
      await startSupervisor(vctx(state), plan.stepKey, attempt, launchId);
    } catch (error) {
      // A detached start is never retried blindly: the marker tells whether it took (spec §6.8).
      const again = await launchProbe(vctx(state), plan.stepKey, attempt, launchId).catch(() => null);
      if (again?.action !== "reattached" && again?.action !== "settled") throw error;
      return { kind: "probe", probe: again, attempt };
    }
    state.harnessStartedAt = new Date().toISOString();
    await journalPut(state, { status: "started", launchId, harnessStartedAt: state.harnessStartedAt });
    if (state.sessionId) await journalSession(state, launchId, state.sessionId);
    ctx.emit({ type: "agent.launched", callPath: plan.callPath, launchId, attempt, data: { sandbox: box.ref.id } });
  }
  return { kind: "probe", probe, attempt };
}

// ───────────────────────────── wait (spec §7.4.2, §7.5.4) ─────────────────────────────

function readyOf(event: RuntimeEvent): Partial<ReadyEvent> | undefined {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data) return undefined;
  if (event.type === "ready" || (event.type === "boot" && data.phase === "ready")) {
    const payload = (data.detail ?? data) as Partial<ReadyEvent>;
    return payload;
  }
  return undefined;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

async function pollLaunch(
  state: CallState,
  launchId: LaunchId,
  attempt: number,
  stop: AbortSignal,
): Promise<WaitResult> {
  const { ctx, plan } = state;
  let after = 0;
  let freeStrikes = 0;
  let cancelSent = false;
  const started = Date.now();
  const turnUsage = new Map<number, { usd: number; tokens: number; priced: boolean }>();
  for (;;) {
    if (stop.aborted) throw stop.reason ?? new Error("wait stopped");
    if (state.signal?.aborted && !cancelSent) {
      cancelSent = true;
      await writeCancel(state.box as ProviderSandbox, plan.stepKey, attempt, "aborted");
    }
    const r = await waitVerb(vctx(state), plan.stepKey, attempt, after, AGENT_TUNABLES.waitSliceMs);
    for (const event of r.events) {
      const ready = readyOf(event);
      if (ready) state.ready = { ...state.ready, ...ready };
      await chargeTurn(state, launchId, event, turnUsage);
      ctx.emit({
        type: event.type,
        level: event.level,
        callPath: plan.callPath,
        launchId,
        attempt,
        ...(event.data ? { data: event.data } : {}),
      });
    }
    after = Math.max(after, r.lastSeq);
    if (r.state?.sessionId) {
      setSession(state, r.state.sessionId);
      await journalSession(state, launchId, r.state.sessionId).catch(() => undefined);
    }
    if (r.outcome && r.outcome.launchId === launchId) return { kind: "outcome", outcome: r.outcome };
    if (r.outcome) return { kind: "outcome", outcome: r.outcome };
    if (r.pendingAsk && ctx.asks && r.state?.pendingAsk) {
      const suspended = r.state.phase === "suspended" && r.lock === "FREE";
      // An open ask holds the box for its hot window, whatever the call's own clock says (demo-path §6). A
      // suspended turn has no hot window: its box is parked or about to be.
      if (!suspended) await extendForAsk(state);
      const askStarted = Date.now();
      const answer = await ctx.asks
        .handle({
          runId: ctx.runId,
          callPath: plan.callPath,
          launchId,
          askSeq: r.state.pendingAsk.askSeq,
          spec: r.pendingAsk,
          ...(state.signal ? { signal: state.signal } : {}),
          harness: { mcpToolTimeoutMs: plan.timeouts.mcpToolMs, canResume: plan.harness.resume !== undefined },
          sharedHandle: plan.handle !== undefined,
        })
        .finally(() => {
          state.askWaitMs = (state.askWaitMs ?? 0) + (Date.now() - askStarted);
        });
      const sessionId = r.state.sessionId ?? state.sessionId;
      if (
        answer.kind === "answer" &&
        suspended &&
        sessionId &&
        ctx.asks.awaitCold &&
        !answer.resolution.askId.startsWith("ask_rejected_")
      ) {
        // The turn already ended for a cold wait and the answer arrived while no host ran (a restart): nobody in
        // the box can take it hot, so the session resumes with it as the next launch.
        return { kind: "suspended", askId: answer.resolution.askId, sessionId };
      }
      if (answer.kind === "answer") {
        await answerVerb(vctx(state), plan.stepKey, attempt, {
          askId: answer.resolution.askId,
          resolution: answer.resolution,
        });
        continue;
      }
      if (suspended && answer.askId && sessionId && ctx.asks.awaitCold) {
        return { kind: "suspended", askId: answer.askId, sessionId };
      }
      continue;
    }
    const phase = r.state?.phase;
    const waiting = phase === "waiting" || phase === "suspended";
    if (r.lock === "FREE" && !waiting && !(phase && TERMINAL.has(phase))) {
      if (r.state || Date.now() - started > AGENT_TUNABLES.supervisorStartMs) freeStrikes++;
      // Two FREE reads in a row: one could race the supervisor taking the lock.
      if (freeStrikes >= 2) return { kind: "interrupted", harnessStarted: Boolean(r.state?.harnessStartedAt) };
    } else {
      freeStrikes = 0;
    }
    if (cancelSent && Date.now() - started > AGENT_TUNABLES.cancelSettleMs + plan.timeouts.cancelGraceMs) {
      return { kind: "interrupted", harnessStarted: true };
    }
  }
}

/**
 * Mirrors the runtime's per-turn usage into the run budget as it streams in: cumulative per turn, persisted at
 * turn end and at most every 30 s by the ledger (spec §3.9), so a crash mid-call still counts what was spent.
 */
async function chargeTurn(
  state: CallState,
  launchId: LaunchId,
  event: RuntimeEvent,
  turns: Map<number, { usd: number; tokens: number; priced: boolean }>,
): Promise<void> {
  const charge = state.budget?.charge;
  if (!charge || event.turnIndex === undefined) return;
  const turn = event.turnIndex;
  const data = (event.data ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    cumulative?: boolean;
  };
  if (event.type === "harness.usage") {
    const prev = turns.get(turn) ?? { usd: 0, tokens: 0, priced: false };
    const tokens = (data.inputTokens ?? 0) + (data.outputTokens ?? 0);
    const usd = data.costUsd ?? 0;
    const next = data.cumulative
      ? { usd, tokens, priced: prev.priced || data.costUsd !== undefined }
      : { usd: prev.usd + usd, tokens: prev.tokens + tokens, priced: prev.priced || data.costUsd !== undefined };
    turns.set(turn, next);
    await charge({ launchId, turn, ...(next.priced ? { usd: next.usd } : {}), tokens: next.tokens });
    return;
  }
  if (event.type === "turn.ended") {
    const last = turns.get(turn);
    if (!last) return;
    await charge({ launchId, turn, ...(last.priced ? { usd: last.usd } : {}), tokens: last.tokens, final: true });
  }
}

export async function waitAttempt(
  state: CallState,
  n: number,
  probe: LaunchProbe,
  attempt: number,
): Promise<WaitResult> {
  if (probe.action === "settled") return { kind: "outcome", outcome: probe.outcome };
  if (probe.action === "interrupted") return { kind: "interrupted", harnessStarted: probe.harnessStarted };
  // "suspended" (a turn that ended for a cold ask) polls on: the poll finds the open ask and takes the cold path,
  // so a resume delivers the answer instead of replaying the turn (spec §8.4).
  const { ctx, plan } = state;
  const launchId = launchIdFor(plan, n);
  const unregister = registerLaunchPoller(launchId, async (stop) => {
    const r = await pollLaunch(state, launchId, attempt, stop);
    return r as unknown as Json;
  });
  try {
    const waited = await ctx.host.waitForCallback<Json>(launchId, {
      timeoutMs: plan.timeouts.callMs + 30 * MIN,
      rearm: 0,
      register: async () => undefined,
    });
    if (waited.ok) return waited.value as unknown as WaitResult;
  } finally {
    unregister();
  }
  // The host wait timed out: stop the harness through the sentinel, then collect what it settles to.
  await writeCancel(state.box as ProviderSandbox, plan.stepKey, attempt, "timeout");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TUNABLES.cancelSettleMs + plan.timeouts.cancelGraceMs);
  try {
    return await pollLaunch(state, launchId, attempt, controller.signal);
  } catch {
    return { kind: "interrupted", harnessStarted: true };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── collect (spec §7.4.3) ─────────────────────────────

function containedPath(p: string): boolean {
  return !p.startsWith("/") && !p.split("/").includes("..");
}

/**
 * One artifact write during collect. A store outage of a few seconds must not fail a call whose work is done, so
 * each write is retried with backoff before collect gives up.
 */
async function putArtifact(
  state: CallState,
  key: string,
  data: string | Uint8Array,
  contentType: string,
): Promise<ArtifactRef> {
  const waits = AGENT_TUNABLES.uploadRetryMs;
  for (let i = 0; ; i++) {
    try {
      return await state.ctx.artifacts.put(key, data, { contentType });
    } catch (error) {
      if (i >= waits.length || state.signal?.aborted) throw error;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

/** Uploads the file's bytes as they are: collected files include screenshots and traces, which text decoding breaks. */
async function uploadFile(
  state: CallState,
  path: string,
  key: string,
  contentType: string,
): Promise<ArtifactRef | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await (state.box as ProviderSandbox).readFile(path);
  } catch (error) {
    if ((error as { code?: string }).code === "sandbox_file_not_found") return undefined;
    throw error;
  }
  return putArtifact(state, key, bytes, contentType);
}

async function integrityCheck(
  state: CallState,
  outcome: Outcome,
  resultPath: string,
): Promise<"isolated" | "same-user"> {
  const isolation = outcome.isolation ?? state.ready?.isolation ?? "same-user";
  if (isolation === "same-user") {
    if (state.plan.requireIsolation) {
      throw new ResultIntegrityError(
        "requireIsolation is set, but this sandbox runs the agent and the supervisor as the same user.",
        errOpts(state, outcome),
      );
    }
    return "same-user";
  }
  const r = await (state.box as ProviderSandbox).exec(`stat -c '%u %a %F' '${resultPath}'`, {
    user: "root",
    timeoutMs: 30_000,
  });
  const [uid, mode, ...type] = r.stdoutTail.trim().split(" ");
  const fileType = type.join(" ");
  const modeBits = Number.parseInt(mode ?? "0", 8);
  const problems: string[] = [];
  if (r.exitCode !== 0) problems.push("stat failed");
  if (fileType !== "regular file" && fileType !== "regular empty file") problems.push(`it is a ${fileType}`);
  if ((modeBits & 0o022) !== 0) problems.push(`mode ${mode} lets group or other write`);
  if (state.ready?.supervisorUid !== undefined && Number(uid) !== state.ready.supervisorUid) {
    problems.push(`owner uid ${uid} is not the supervisor`);
  }
  if (state.ready?.agentUid !== undefined && Number(uid) === state.ready.agentUid)
    problems.push("the agent user owns it");
  if (problems.length > 0) {
    throw new ResultIntegrityError(
      `result.json failed the integrity check: ${problems.join("; ")}.`,
      errOpts(state, outcome),
    );
  }
  return "isolated";
}

interface CollectedArtifacts {
  artifacts: Artifacts;
  integrity: "isolated" | "same-user";
}

async function collectArtifacts(
  state: CallState,
  launchId: LaunchId,
  attempt: number,
  outcome: Outcome,
): Promise<CollectedArtifacts> {
  const { ctx, plan } = state;
  const box = state.box as ProviderSandbox;
  const dir = attemptDir(plan.stepKey, attempt);
  const prefix = `${ctx.runId}/${plan.stepKey}/${attempt}`;
  const transcriptPath = outcome.artifacts?.transcript ?? ATTEMPT_FILES.events;
  const logPath = outcome.artifacts?.logs?.[0] ?? ATTEMPT_FILES.runtimeLog;
  for (const p of [transcriptPath, logPath, ...(outcome.artifacts?.files ?? [])]) {
    if (!containedPath(p)) throw new ArtifactPathError({ path: p }, errOpts(state, outcome));
  }
  const transcript =
    (await uploadFile(state, `${dir}/${transcriptPath}`, `${prefix}/transcript.jsonl`, "application/x-ndjson")) ??
    (await putArtifact(state, `${prefix}/transcript.jsonl`, "", "application/x-ndjson"));
  const logs =
    (await uploadFile(state, `${dir}/${logPath}`, `${prefix}/runtime.log`, "text/plain")) ??
    (await putArtifact(state, `${prefix}/runtime.log`, "", "text/plain"));
  const files: Artifacts["files"] = [];
  for (const p of outcome.artifacts?.files ?? []) {
    const ref = await uploadFile(state, `${dir}/${p}`, `${prefix}/files/${p}`, "application/octet-stream");
    if (ref) files.push({ path: p, ref });
  }
  const artifacts: Artifacts = { transcript, logs, files };

  const { baseSha, headSha } = outcome.git;
  // The branch is the host's, never the sandbox's: an outcome naming another branch is not pushed anywhere.
  const branch = outcome.git.branch === undefined ? undefined : plan.git.branch;
  if (outcome.git.branch !== undefined && outcome.git.branch !== plan.git.branch) {
    ctx.emit({
      type: "warning",
      level: "warn",
      callPath: plan.callPath,
      launchId,
      data: {
        scope: "push",
        message: `the outcome names branch ${outcome.git.branch}; only ${plan.git.branch} is pushed`,
      },
    });
  }
  if (branch && baseSha && headSha) {
    const autoCommitted = outcome.git.autoCommitted ?? false;
    let pushed = outcome.git.pushed && outcome.git.branch === plan.git.branch;
    const ahead = baseSha !== headSha;
    if (ahead && plan.repo && plan.branchRequirement !== "forbidden") {
      if (await isCurrentLaunch(state, launchId)) {
        const broker = ctx.config.git;
        const token =
          broker && gitHostOf(plan.repo)
            ? await broker.pushToken({ repo: plan.repo, runId: ctx.runId, callPath: plan.callPath, launchId })
            : undefined;
        const fence = await ctx.results.get<FenceRecord & Json>(fenceKey(state));
        const res = await hostPush(box, {
          source: headSha,
          remoteRef: branch,
          remoteUrl: plan.git.remoteUrl ?? plan.repo,
          // The sha this call last pushed, when there is one; otherwise the lease is what the remote says now.
          ...(fence?.expectSha ? { expectSha: fence.expectSha } : {}),
          ...(token ? { token } : {}),
          allowPushTo: plan.git.allowPushTo,
          secrets: state.secrets ?? [],
        });
        pushed = res.pushed;
        if (pushed) await recordPushedSha(state, headSha);
      } else {
        ctx.emit({ type: "late_outcome", level: "warn", callPath: plan.callPath, launchId, data: { branch } });
      }
    }
    artifacts.branch = { name: branch, base: plan.git.baseBranch, baseSha, headSha, pushed, autoCommitted };
    if (ahead) {
      artifacts.commits = await commitsAhead(box, baseSha, headSha);
      const patch = redact(await diffPatch(box, baseSha, headSha), state.secrets);
      artifacts.diff = {
        stat: await diffStat(box, baseSha, headSha),
        ref: await putArtifact(state, `${prefix}/diff.patch`, patch, "text/x-diff"),
      };
    } else {
      artifacts.commits = [];
    }
  }
  return { artifacts, integrity: outcome.isolation ?? "same-user" };
}

/** Collect never kills or releases a box; it writes the outcome record, then marks and acks (spec §7.4.3). */
export async function collectAttempt(
  state: CallState,
  n: number,
  attempt: number,
  outcome: Outcome,
): Promise<RawOutcome> {
  const { ctx, plan } = state;
  const launchId = launchIdFor(plan, n);
  const recordKey = `outcomes/${ctx.runId}/${launchId}`;
  const existing = await ctx.results.get<RawOutcome & Json>(recordKey);
  if (existing) return existing as unknown as RawOutcome;
  if (outcome.sessionId) setSession(state, outcome.sessionId);
  if (outcome.harnessVersion) state.harnessVersion = outcome.harnessVersion;
  state.lastFailure = outcome.failure;
  await returnLeasedFile(state);
  if (outcome.attempts) {
    state.attempts.submits += outcome.attempts.submits;
    state.attempts.resumes += outcome.attempts.resumes;
    state.attempts.doneRetries += outcome.attempts.doneRetries;
  }
  const usage = outcome.usage ?? emptyUsage();
  let raw: RawOutcome;
  // A collect that failed on the artifact store is not pinned: a later collect of this launch tries again.
  let collectFailed = false;
  try {
    if (outcome.status === "succeeded") {
      const dir = attemptDir(plan.stepKey, attempt);
      const resultPath = `${dir}/${ATTEMPT_FILES.result}`;
      const text = await readText(state.box as ProviderSandbox, resultPath);
      if (text === null)
        throw errorForCode(
          "no_result",
          outcome.message ?? "The outcome says succeeded but result.json is missing.",
          errOpts(state, outcome),
        );
      if (Buffer.byteLength(text) > plan.maxResultBytes) {
        throw new ResultValidationError(
          { issues: [`the result is ${Buffer.byteLength(text)} bytes; the cap is ${plan.maxResultBytes}`] },
          errOpts(state, outcome),
        );
      }
      const integrity = await integrityCheck(state, outcome, resultPath);
      const result = JSON.parse(text) as unknown;
      state.lastValidResult = result;
      let collected: CollectedArtifacts;
      try {
        collected = await collectArtifacts(state, launchId, attempt, outcome);
      } catch (error) {
        // A path the box reported is refused the same way every time; anything else may pass on a later collect.
        collectFailed = !(error instanceof ArtifactPathError);
        if (isSelfbuildingError(error) && hasCode(error, "artifact_failed")) throw error;
        throw new ArtifactError(
          `Collecting artifacts failed after a valid result: ${(error as Error).message}. Retry collection; the agent does not run again.`,
          { ...errOpts(state, outcome), cause: error },
        );
      }
      raw = {
        ok: true,
        launchId,
        result,
        artifacts: { ...collected.artifacts },
        usage,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      };
      (raw as { integrity?: string }).integrity = integrity;
      (raw as { checks?: unknown }).checks = outcome.checks ?? [];
    } else {
      const code: ErrorCode =
        outcome.reason ??
        (outcome.status === "timed_out" ? "timeout" : outcome.status === "cancelled" ? "aborted" : "harness_error");
      const message =
        outcome.message ??
        (outcome.status === "timed_out"
          ? "The call's active-time timeout passed."
          : outcome.status === "cancelled"
            ? "The call was cancelled."
            : "The agent call failed.");
      const transcript = await uploadFile(
        state,
        `${attemptDir(plan.stepKey, attempt)}/${ATTEMPT_FILES.events}`,
        `${ctx.runId}/${plan.stepKey}/${attempt}/transcript.jsonl`,
        "application/x-ndjson",
      ).catch(() => undefined);
      const recovery = { ...recoveryOf(state, outcome), ...(transcript ? { transcript } : {}) };
      const error =
        code === "aborted"
          ? { name: "AgentInterruptedError", code, kind: "agent" as const, retryable: false, message }
          : errorForCode(code, message, { runId: ctx.runId, callPath: plan.callPath, recovery }).toJSON();
      raw = { ok: false, launchId, error: error as SerializedSelfbuildingError };
    }
  } catch (error) {
    raw = { ok: false, launchId, error: serializeError(error) };
  }
  state.usage = addUsage(state.usage, usage);
  if (collectFailed) return raw;
  if (!(await ctx.results.createIfAbsent(recordKey, raw as unknown as Json))) {
    raw = (await ctx.results.get<RawOutcome & Json>(recordKey)) as unknown as RawOutcome;
  }
  try {
    await (state.box as ProviderSandbox).writeFiles([
      { path: launchMarker(launchId, "collected"), data: new Date().toISOString(), mode: 0o644, owner: "root" },
    ]);
    await ackVerb(vctx(state), plan.stepKey, attempt);
  } catch (error) {
    ctx.emit({
      type: "warning",
      level: "warn",
      callPath: plan.callPath,
      launchId,
      data: { scope: "ack", message: (error as Error).message },
    });
  }
  return raw;
}

// ───────────────────────────── accept (spec §7.4.4) ─────────────────────────────

function restrictedHandle(box: ProviderSandbox, id: string, callPath: string): SandboxHandle {
  const refuse = (op: string) => async () => {
    throw new ConfigError(`DoneContext.sandbox allows exec only; ${op} is not available inside a done check.`);
  };
  return {
    id,
    callPath,
    version: 0,
    exec: (cmd, o) =>
      box.exec(cmd, {
        cwd: o?.cwd ?? SANDBOX_PATHS.workdir,
        timeoutMs: durationMs(o?.timeout, 120_000),
      }) as Promise<ExecResult>,
    checkpoint: refuse("checkpoint"),
    push: refuse("push"),
    snapshot: refuse("snapshot"),
    fork: refuse("fork"),
    dispose: refuse("dispose"),
    [Symbol.asyncDispose]: async () => undefined,
  } as SandboxHandle;
}

function hydrateArtifacts(state: CallState, a: Artifacts): Artifacts {
  const h = (ref: ArtifactRef) => state.ctx.artifacts.hydrate(ref);
  return {
    ...a,
    transcript: h(a.transcript),
    logs: h(a.logs),
    files: a.files.map((f) => ({ path: f.path, ref: h(f.ref) })),
    ...(a.diff ? { diff: { stat: a.diff.stat, ref: h(a.diff.ref) } } : {}),
  };
}

async function openPr(state: CallState, launchId: LaunchId, result: unknown, artifacts: Artifacts): Promise<void> {
  const { ctx, plan } = state;
  if (!plan.pr || !artifacts.branch?.pushed || !plan.repo) return;
  if (!(await isCurrentLaunch(state, launchId))) return;
  const api = ctx.config.git?.pullRequests;
  if (!api)
    throw new ArtifactError("A pull request was requested but the git broker has no pull-request API.", errOpts(state));
  const r = (result ?? {}) as { prTitle?: unknown; prBody?: unknown; summary?: unknown };
  const summary = typeof r.summary === "string" ? r.summary : "";
  const title =
    typeof plan.pr.title === "function"
      ? plan.pr.title(result)
      : (plan.pr.title ?? (typeof r.prTitle === "string" ? r.prTitle : `${plan.agentName}: ${summary.slice(0, 72)}`));
  const bodyText =
    typeof plan.pr.body === "function"
      ? plan.pr.body(result, artifacts)
      : (plan.pr.body ?? (typeof r.prBody === "string" ? r.prBody : summary));
  const stat = artifacts.diff?.stat;
  const footer = [
    "",
    "---",
    stat ? `${stat.files} files changed, +${stat.insertions} −${stat.deletions}` : "",
    `Selfbuilding-Run: ${ctx.runId}`,
    `Selfbuilding-Call: ${ctx.runId}.${plan.callPath}`,
    `Selfbuilding-Agent: ${plan.agentName}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
  const pr = await api.openOrUpdate({
    repo: plan.repo,
    head: artifacts.branch.name,
    base: plan.pr.base ?? plan.git.baseBranch,
    title,
    body: `${bodyText}\n${footer}`,
    draft: plan.pr.draft ?? true,
    ...(plan.pr.labels ? { labels: plan.pr.labels } : {}),
  });
  artifacts.pr = { url: pr.url, number: pr.number, draft: pr.draft };
}

export async function acceptAttempt(state: CallState, raw: RawOutcome, n: number): Promise<AcceptDecision> {
  const { ctx, plan, def } = state;
  const launchId = launchIdFor(plan, n);
  if (!(await isCurrentLaunch(state, launchId))) {
    ctx.emit({ type: "late_outcome", level: "warn", callPath: plan.callPath, launchId });
  }
  if (!raw.ok) {
    const error = rehydrateError(raw.error);
    return { kind: "failed", error, keepBox: raw.error.code === "result_integrity" };
  }
  const parsed = plan.wireSchema.safeParse(raw.result);
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    if (state.attempts.resumes < plan.maxResumes)
      return { kind: "retry", message: invalidResultMessage(issues), counts: "resumes" };
    return { kind: "failed", error: new ResultValidationError({ issues }, errOpts(state)) };
  }
  const result = unwrapResult(plan.outputSchema, parsed.data);
  state.lastValidResult = result;
  const artifacts = hydrateArtifacts(state, raw.artifacts);
  const runtimeChecks = ((raw as { checks?: CheckOutcome[] }).checks ?? []).map((c) => ({ ...c }));
  const checks: CheckOutcome[] = [...runtimeChecks];
  const status = (result as { status?: unknown } | null)?.status;
  const gated = status === undefined || status === "done";
  let doneFailed: { id: string; output: string } | undefined;

  const failCheck = (id: string, output: string, hard: boolean): AcceptDecision | undefined => {
    checks.push({ id, ok: false, verified: true });
    if (!hard && state.attempts.doneRetries < plan.maxDoneRetries) {
      return { kind: "retry", message: doneCheckMessage(id, output), counts: "doneRetries" };
    }
    if (!hard && plan.onDoneFailure === "return") {
      doneFailed = { id, output };
      return undefined;
    }
    return {
      kind: "failed",
      error: new DoneCheckFailedError({ checkId: id, output }, errOpts(state)),
      keepBox: hard,
    };
  };

  if (gated) {
    const branch = artifacts.branch;
    if (
      plan.branchRequirement === "forbidden" &&
      branch &&
      (branch.headSha !== branch.baseSha || branch.autoCommitted)
    ) {
      const d = failCheck("branch-forbidden", "This read-only agent made commits or left the tree dirty.", true);
      if (d) return d;
    }
    if (plan.branchRequirement === "required") {
      const ahead = branch ? branch.headSha !== branch.baseSha : false;
      const pushedOk = !plan.repo || branch?.pushed === true;
      if (!ahead || !pushedOk) {
        const d = failCheck(
          "branch-required",
          ahead ? "The branch was not pushed." : "No commit ahead of the base: commit your work on the current branch.",
          false,
        );
        if (d) return d;
      } else {
        checks.push({ id: "branch-required", ok: true, verified: true });
      }
    }
    const dctx: DoneContext = {
      sandbox: restrictedHandle(state.box as ProviderSandbox, plan.handle?.id ?? plan.callPath, plan.callPath),
      git: {
        base: branch?.baseSha ?? "",
        head: branch?.headSha ?? "",
        commitsAhead: artifacts.commits?.length ?? 0,
        dirty: branch?.autoCommitted ?? false,
        changedPaths: [],
        remoteHasBranch: async () => branch?.pushed ?? false,
      },
      artifacts,
    };
    for (const check of def.contract.done) {
      if (doneFailed) break;
      if (!("assert" in check)) continue;
      let verdict: true | string;
      try {
        verdict = await check.assert(result, dctx);
      } catch (error) {
        verdict = `the check threw: ${(error as Error).message}`;
      }
      if (verdict === true) {
        checks.push({ id: check.id, ok: true, verified: true });
        continue;
      }
      const d = failCheck(check.id, verdict, false);
      if (d) return d;
    }
  }

  try {
    await openPr(state, launchId, result, artifacts);
  } catch (error) {
    if (isSelfbuildingError(error) && error.kind === "usage") throw error;
    return {
      kind: "failed",
      error: isSelfbuildingError(error)
        ? error
        : new ArtifactError(`Opening the pull request failed: ${(error as Error).message}`, {
            ...errOpts(state),
            cause: error,
          }),
    };
  }
  if (plan.handle && plan.checkpoint !== "none") {
    artifacts.checkpoint = await plan.handle.checkpointLocked(plan.checkpoint);
  }

  // A call on a shared handle holds the handle's box for its own duration, at the handle's size (release-prep
  // §7.2 #7); a fresh box counts from its create.
  const boxFrom = state.boxStartedAt ?? (plan.handle ? state.startedAt : undefined);
  const sandboxMs = boxFrom ? Date.now() - boxFrom : 0;
  const boxVcpu = state.boxVcpu ?? (plan.handle && boxFrom ? handleVcpu(ctx, plan.handle) : undefined);
  const agentResult: AgentResult<unknown> = {
    result,
    runId: ctx.runId,
    callPath: plan.callPath,
    stepKey: plan.stepKey,
    attempts: { ...state.attempts },
    replayed: false,
    usage: {
      ...state.usage,
      wallClockMs: Date.now() - state.startedAt,
      sandboxMs,
      ...(boxFrom && boxVcpu !== undefined ? { sandboxVcpuMs: sandboxMs * boxVcpu } : {}),
    },
    artifacts,
    checks,
    integrity: (raw as { integrity?: "isolated" | "same-user" }).integrity ?? "same-user",
    harness: {
      id: plan.harness.id,
      version: state.harnessVersion ?? "unknown",
      ...(plan.harness.options.model ? { model: plan.harness.options.model } : {}),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    },
    skill: plan.skill,
    ...(doneFailed ? { doneFailed } : {}),
  };
  return { kind: "done", result: agentResult };
}

/** The vCPU of a shared handle's box, from its size (the provider default when it has none); undefined if unknown. */
function handleVcpu(ctx: AgentRunContext, handle: NonNullable<CallPlan["handle"]>): number | undefined {
  try {
    const provider = handle.resolveProvider();
    return resolveBoxSize(ctx, {
      image: imageFor(undefined),
      provider,
      ...(handle.size !== undefined ? { size: handle.size } : {}),
    })?.vcpu;
  } catch {
    // The box already exists at this size; a lookup that fails now only leaves the weighted figure out.
    return undefined;
  }
}

// ───────────────────────────── the whole group ─────────────────────────────

async function writeAcceptRecord(state: CallState, value: Json, ok: boolean): Promise<void> {
  const { ctx, plan } = state;
  await ctx.results.replace(`runs/${ctx.runId}/e${ctx.epoch}/accepted/${plan.stepKey}`, value, null).catch(() => false);
  if (ok) await ctx.results.createIfAbsent(`runs/${ctx.runId}/cache/${plan.stepKey}`, value);
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/** Runs launch → wait → collect → accept until the call succeeds, fails or needs another turn. */
export async function runCall(
  state: CallState,
  startN = 0,
  startFollowUp?: { message: string; resumeSessionId: string },
) {
  const { ctx, plan } = state;
  let n = startN;
  let followUp = startFollowUp;
  ctx.emit({ type: "agent.started", callPath: plan.callPath, data: { agent: plan.agentName, stepKey: plan.stepKey } });
  let ok = false;
  let keep = false;
  try {
    for (;;) {
      if (state.signal?.aborted) throw state.signal.reason;
      const launched = await launchAttempt(state, n, followUp);
      let raw: RawOutcome;
      if (launched.kind === "recorded") {
        raw = launched.raw;
      } else {
        const waited = await waitAttempt(state, n, launched.probe, launched.attempt);
        if (state.signal?.aborted) {
          if (waited.kind === "outcome")
            await collectAttempt(state, n, launched.attempt, waited.outcome).catch(() => undefined);
          throw state.signal.reason;
        }
        if (waited.kind === "suspended") {
          // Cold wait: park the box, wait for the answer with no compute held, then resume the same session with
          // the answer as a new launch. Shared handles never get here; their asks are hot-only.
          state.sessionId = waited.sessionId;
          state.coldWaiting = true;
          await parkBox(state);
          // pollLaunch reports "suspended" only when the bridge offers awaitCold.
          const awaitCold = ctx.asks?.awaitCold;
          if (!awaitCold) throw new HitlConfigError("The run's ask bridge cannot wait for a cold answer.");
          const coldStarted = Date.now();
          const cold = await awaitCold(waited.askId, {
            sessionId: waited.sessionId,
            launch: n + 1,
            ...(state.box ? { sandbox: state.box.ref } : {}),
          }).finally(() => {
            state.askWaitMs = (state.askWaitMs ?? 0) + (Date.now() - coldStarted);
          });
          await unparkBox(state);
          state.coldWaiting = false;
          n++;
          followUp = { message: cold.message, resumeSessionId: waited.sessionId };
          continue;
        }
        if (waited.kind === "interrupted") {
          const canResume =
            plan.onInterrupted === "resume-session" &&
            resumableSession(state) !== undefined &&
            state.attempts.resumes < plan.maxResumes;
          if (canResume) {
            state.attempts.resumes++;
            n++;
            followUp = {
              message: interruptedMessage(new Date().toISOString()),
              resumeSessionId: state.sessionId as string,
            };
            continue;
          }
          throw new AgentInterruptedError(undefined, errOpts(state));
        }
        raw = await collectAttempt(state, n, launched.attempt, waited.outcome);
      }
      const decision = await acceptAttempt(state, raw, n);
      if (decision.kind === "retry") {
        const resumable = resumableSession(state);
        if (!resumable && state.sessionId && plan.harness.resume) {
          // The session's box is gone: relaunch from the original prompt on the branch the box synced, once.
          ctx.emit({
            type: "warning",
            level: "warn",
            callPath: plan.callPath,
            data: {
              scope: "session",
              message: "the session lived in a box that is gone; relaunching instead of resuming",
            },
          });
          state.attempts[decision.counts]++;
          state.sessionId = undefined;
          state.sessionBoxId = undefined;
          n++;
          followUp = undefined;
          continue;
        }
        if (!resumable) {
          const issue = decision.message;
          throw decision.counts === "doneRetries"
            ? new DoneCheckFailedError({ checkId: "resume-unavailable", output: issue }, errOpts(state))
            : new ResultValidationError({ issues: [issue] }, errOpts(state));
        }
        state.attempts[decision.counts]++;
        n++;
        followUp = { message: decision.message, resumeSessionId: resumable };
        continue;
      }
      if (decision.kind === "failed") {
        if (failOver(state)) {
          // A switch resumes the same session when it can, so the work so far is kept (spec §4.9).
          n++;
          const resumable = resumableSession(state);
          followUp = resumable
            ? { message: credentialSwitchMessage(state.lastFailure?.code ?? "auth"), resumeSessionId: resumable }
            : undefined;
          continue;
        }
        keep = decision.keepBox ?? false;
        throw decision.error;
      }
      ok = true;
      const value = toJson(decision.result);
      await writeAcceptRecord(state, value, true);
      const checkpointAfter = decision.result.artifacts.checkpoint;
      await journalPut(state, {
        status: "ok",
        launchId: launchIdFor(plan, n),
        value,
        ...(plan.handle && checkpointAfter ? { checkpointAfter } : {}),
        finishedAt: new Date().toISOString(),
      });
      ctx.advanceChain(plan.stepKey, launchIdFor(plan, n));
      plan.handle?.noteCallSettled(plan.stepKey, { replayed: false });
      ctx.emit({
        type: "agent.finished",
        callPath: plan.callPath,
        launchId: launchIdFor(plan, n),
        data: { usage: decision.result.usage },
      });
      return decision.result;
    }
  } catch (error) {
    if (!isUsageLike(error)) {
      const serialized = serializeError(error);
      await writeAcceptRecord(state, { ok: false, error: serialized } as unknown as Json, false).catch(() => undefined);
      await journalPut(state, {
        status: "failed",
        launchId: launchIdFor(plan, n),
        value: { error: serialized } as unknown as JournalEntry["value"],
        finishedAt: new Date().toISOString(),
      }).catch(() => undefined);
      ctx.advanceChain(plan.stepKey, launchIdFor(plan, n));
      ctx.emit({
        type: "agent.failed",
        level: "error",
        callPath: plan.callPath,
        launchId: launchIdFor(plan, n),
        data: { code: serialized.code, message: serialized.message },
      });
    }
    throw error;
  } finally {
    stopHeartbeat(state);
    endLease(state);
    if (plan.handle) {
      // The box outlives the call: its credential files go now, so no snapshot or fork child inherits them.
      await scrubCredentialFiles(state);
      state.release?.();
    } else {
      await disposeBox(state, ok, keep).catch((error) =>
        ctx.emit({
          type: "warning",
          level: "warn",
          callPath: plan.callPath,
          data: { scope: "dispose", message: String(error) },
        }),
      );
    }
  }
}

function credentialSwitchMessage(code: string): string {
  return (
    `Your previous turn stopped because of an account error (${code}); it now runs on another credential. Your work ` +
    "so far is in this session and in the working tree. Check `git status` and `git log` before you continue, do " +
    "not repeat actions that already took effect, and call submit_result when done."
  );
}

async function scrubCredentialFiles(state: CallState): Promise<void> {
  const files = state.credentialFiles ?? [];
  if (!state.box || files.length === 0) return;
  await state.box.exec(`rm -f ${files.map(shq).join(" ")}`, { user: "root", timeoutMs: 30_000 }).catch(() => undefined);
}

function isUsageLike(error: unknown): boolean {
  return isSelfbuildingError(error) && error.kind === "usage";
}

/** Rehydrates a journaled AgentResult so `ArtifactRef.text()` works again. */
export function hydrateResult(ctx: AgentRunContext, value: AgentResult<unknown>): AgentResult<unknown> {
  const h = (ref: ArtifactRef) => ctx.artifacts.hydrate(ref);
  const a = value.artifacts;
  return {
    ...value,
    replayed: true,
    artifacts: {
      ...a,
      transcript: h(a.transcript),
      logs: h(a.logs),
      files: a.files.map((f) => ({ path: f.path, ref: h(f.ref) })),
      ...(a.diff ? { diff: { stat: a.diff.stat, ref: h(a.diff.ref) } } : {}),
    },
  };
}

/** The interrupted-call rule (spec §3.10) for a `started` journal entry found on replay. */
export async function resumeStarted(state: CallState, entry: JournalEntry): Promise<AgentResult<unknown>> {
  const { ctx, plan } = state;
  const match = /_l(\d+)$/.exec(entry.launchId);
  const n = match ? Number(match[1]) : 0;
  // No harness ever launched: positive evidence nothing ran, so it runs live from the start.
  if (!entry.harnessStartedAt) return runCall(state, n);
  const sessionId = entry.sandbox?.harnessSessionId;
  if (sessionId) {
    state.sessionId = sessionId;
    state.journaledSessionId = sessionId;
    const ref = entry.sandbox?.ref as SandboxRef | undefined;
    if (ref?.id) state.sessionBoxId = ref.id;
  }
  // An outcome already recorded settles the call whether or not its box survived (spec §3.10 step 1).
  const recorded = await ctx.results.get<RawOutcome & Json>(`outcomes/${ctx.runId}/${entry.launchId}`);
  if (recorded) return runCall(state, n);
  const ref = entry.sandbox?.ref as SandboxRef | undefined;
  if (ref && !plan.handle) {
    // The reopened box counts against the sandbox cap like any other (spec §3.12).
    const slot = ctx.acquireSlots ? await ctx.acquireSlots(plan.callPath, 1) : undefined;
    try {
      state.box = await plan.provider.open(ref, { lifetimeMs: plan.timeouts.callMs + 15 * MIN });
      state.fresh = true;
      state.boxStartedAt = Date.now();
      state.release = () => slot?.release();
    } catch (error) {
      slot?.release();
      if (!hasCode(error, "sandbox_not_found", "sandbox_guest_gone")) throw error;
    }
  }
  if (state.box || plan.handle) return runCall(state, n);
  throw new AgentInterruptedError(
    "The agent's turn was cut off and its sandbox is gone. It is not re-run silently; resume it with onInterrupted or refresh.",
    errOpts(state),
  );
}
