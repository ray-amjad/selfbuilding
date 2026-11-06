import { AskCancelledError, AskSpecError, AskTimeoutError, HitlConfigError } from "../errors/classes.js";
import type {
  AnsweredBy,
  AskAnswer,
  AskRecord,
  AskResolution,
  AskSpec,
  AskStore,
  HitlChannel,
  HitlOptions,
  HostId,
  Notification,
  NotifyOptions,
  RunInfo,
  ThreadKey,
} from "../types/ask.js";
import type { Duration } from "../types/common.js";
import type { RunStatus } from "../types/orchestration.js";
import { answerAsk, onAskSettled, updateCards, wakeAsk } from "./answer.js";
import { durationToMs, formatDuration } from "./duration.js";
import { formatResumeMessage, formatSettledCard, formatSuspended, formatToolResult } from "./format.js";
import { computeSpecHash, deriveAskId } from "./identity.js";
import { handleInbound } from "./inbound.js";
import { checkAnswer, checkPolicy, fallbackAnswer, fromStored, type NormalizedAsk, normalizeAskSpec } from "./spec.js";
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_HOT_WAIT_MS, selectWaitMode, type WaitPlan } from "./wait-mode.js";

// One run's asks (spec §8.3–§8.9): identity, the record, posting, hot and cold waits, AFK policies and the
// completion summary. The engine creates one session per run; core-agent drives agent asks through it.

export type EmitFn = (type: string, data: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;

export interface AutoAnswerRequest {
  askId: string;
  runId: string;
  callPath: string;
  /** The validated, redacted spec. */
  spec: AskSpec;
  model: string;
  /** Default $0.05 per ask. */
  maxUsd: number;
  signal?: AbortSignal;
}

export interface AutoAnswerResult {
  answer: AskAnswer<unknown>;
  /** One line, shown to the agent and in the thread. */
  rationale: string;
  costUsd?: number;
}

/** The single model call behind `onTimeout: "auto"`, run outside the sandbox with the run's credentials. */
export type AutoAnswerer = (req: AutoAnswerRequest) => Promise<AutoAnswerResult>;

/** The host's durable wait for one ask (spec §8.5). The store stays the source of truth for the answer. */
export interface AskWaitpoints {
  readonly host: HostId;
  /** Created before anything is posted, so an answer always finds something to resolve. Returns the ref. */
  create(askId: string, expiresAt: string): Promise<string>;
  /** Returns when the ask may have settled, or at `untilMs`. Never throws on timeout. */
  wait(askId: string, untilMs: number, signal?: AbortSignal): Promise<void>;
}

/** The plain Node waitpoint: in-process wake-ups plus a store poll for answers written by another process. */
export function nodeWaitpoints(store: AskStore, pollMs = 2_000): AskWaitpoints {
  return {
    host: "node",
    async create(askId) {
      return askId;
    },
    wait(askId, untilMs, signal) {
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          off();
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, Math.min(untilMs - Date.now(), pollMs)));
        const off = onAskSettled(store, askId, done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },
  };
}

export interface AskSessionOptions {
  run: RunInfo;
  store: AskStore;
  /** Merged run → factory → config (mergeHitlOptions). */
  hitl?: HitlOptions;
  notify?: NotifyOptions;
  /** Default nodeWaitpoints(store). */
  waitpoints?: AskWaitpoints;
  autoAnswer?: AutoAnswerer;
  emit?: EmitFn;
  /** Applied to every outbound string before truncation (spec §8.9). */
  redact?: (text: string) => string;
  signal?: AbortSignal;
  /** Store poll interval for the default waitpoints. Default 2 s. */
  pollMs?: number;
  /** Notification delivery retries. Default 3 tries, 500 ms base backoff. */
  notifyRetry?: { tries?: number; backoffMs?: number };
  /** The run's wall clock (the budget ledger). Time spent waiting for a human is paused on it (spec §9.6 rule 6). */
  clock?: { pauseClock(): void; resumeClock(): void };
}

/** What the caller knows about a parked call when its ask goes cold; recorded on the ask (demo-path §6). */
export interface ColdInfo {
  sandbox?: NonNullable<AskRecord["cold"]>["sandbox"];
  sessionId?: string;
  /** The launch number that will resume the session with the answer. */
  launch?: number;
}

/** The per-agent hitl option: it may only tighten (spec §8.2). */
export interface AgentHitl {
  risk?: "high";
  timeout?: Duration;
  maxAsks?: number;
}

export interface AgentAskRequest {
  callPath: string;
  launchId: string;
  /** From the runtime's state.json; it survives a park. */
  askSeq: number;
  spec: AskSpec;
  agentHitl?: AgentHitl;
  /** FilePlan.mcpToolTimeoutMs and whether the adapter has resume(). */
  harness: { mcpToolTimeoutMs: number | null; canResume: boolean };
  /** Shared handles are hot-only. */
  sharedHandle?: boolean;
}

export type AgentAskTicket =
  /** Settled already: a replayed answer, AFK, or nothing could deliver it. Return `toolText` to the model. */
  | { kind: "resolved"; record: AskRecord; resolution: AskResolution; toolText: string }
  /** A tool error the model should read and act on (a bad spec, a limit). Nothing was posted. */
  | { kind: "rejected"; toolText: string }
  /** Posted. Wait as the plan says; `suspendedText` is the tool result for a cold wait. */
  | { kind: "wait"; record: AskRecord; plan: WaitPlan; suspendedText: string };

export interface RunSummary {
  status: RunStatus;
  skill?: string;
  durationMs?: number;
  costUsd?: number;
  /** The typed result; its `summary` field is used when present. */
  result?: unknown;
  artifacts?: { prUrl?: string; branch?: string };
  error?: { name: string; message: string; hint?: string; branch?: string; sessionId?: string };
  transcriptUrl?: string;
}

const FAILED: ReadonlySet<RunStatus> = new Set(["failed", "budget_exhausted", "aborted", "needs_attention"]);
const TEXT_LIMITS: Record<string, number> = { slack: 3_000, discord: 2_000, github: 60_000 };
const DEFAULT_AUTO_MAX_USD = 0.05;

interface Settings {
  mode: "interactive" | "afk";
  channels: HitlChannel[];
  timeoutMs: number;
  onTimeout: "default" | "auto" | "fail";
  hotWaitMs: number;
  maxAsksPerAgent: number;
  maxOpenAsks: number;
}

function hitlDuration(d: Duration | undefined, name: string, fallback: number): number {
  if (d === undefined) return fallback;
  const ms = durationToMs(d);
  if (ms === null) throw new HitlConfigError(`hitl.${name} ${JSON.stringify(d)} is not a duration like "10m" or "4h".`);
  return ms;
}

/** Merges HITL layers field by field; the first layer that sets a field wins (run → factory → config). */
export function mergeHitlOptions(...layers: (HitlOptions | undefined)[]): HitlOptions {
  const out: HitlOptions = {};
  for (const layer of [...layers].reverse()) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Checks HITL configuration at run start (spec §8.7 rule 5, §8.8). A run with a channel but nobody who can
 * answer fails before any ask is posted.
 */
export function validateHitlConfig(hitl: HitlOptions | undefined, requester?: string): void {
  if (!hitl) return;
  const channels = hitl.channels ?? [];
  // In AFK mode every ask resolves by policy, so nobody needs to be able to answer.
  if (channels.length > 0 && hitl.mode !== "afk" && (hitl.approvers ?? []).length === 0 && !requester)
    throw new HitlConfigError();
  if (hitl.onTimeout === "auto" && !hitl.autoAnswer)
    throw new HitlConfigError('hitl.onTimeout is "auto" but hitl.autoAnswer is not set. Add autoAnswer: { model }.');
  if (hitl.mode !== undefined && hitl.mode !== "interactive" && hitl.mode !== "afk")
    throw new HitlConfigError('hitl.mode must be "interactive" or "afk".');
  hitlDuration(hitl.timeout, "timeout", 1);
  hitlDuration(hitl.hotWait, "hotWait", 1);
  for (const [name, v] of [
    ["maxAsksPerAgent", hitl.maxAsksPerAgent],
    ["maxOpenAsks", hitl.maxOpenAsks],
  ] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < 1))
      throw new HitlConfigError(`hitl.${name} must be a positive integer.`);
  }
}

type Opened = { kind: "resolved"; record: AskRecord; resolution: AskResolution } | { kind: "open"; record: AskRecord };

export class AskSession {
  readonly run: RunInfo;
  readonly store: AskStore;
  private readonly o: AskSessionOptions;
  private readonly s: Settings;
  private readonly waitpoints: AskWaitpoints;
  private readonly threads = new Map<string, Promise<ThreadKey>>();
  private readonly factorySeq = new Map<string, number>();
  private readonly superseded = new Map<string, string>();
  private readonly agentAsks = new Map<string, number>();
  private readonly fyis = new Map<string, number>();
  private ordinal: Promise<number> | null = null;

  constructor(o: AskSessionOptions) {
    validateHitlConfig(o.hitl, o.run.requestedBy);
    this.o = o;
    this.run = o.run;
    this.store = o.store;
    const h = o.hitl ?? {};
    const channels = [...(h.channels ?? [])];
    this.s = {
      mode: h.mode ?? (channels.length > 0 ? "interactive" : "afk"),
      channels,
      timeoutMs: hitlDuration(h.timeout, "timeout", DEFAULT_ASK_TIMEOUT_MS),
      onTimeout: h.onTimeout ?? "fail",
      hotWaitMs: hitlDuration(h.hotWait, "hotWait", DEFAULT_HOT_WAIT_MS),
      maxAsksPerAgent: h.maxAsksPerAgent ?? 10,
      maxOpenAsks: h.maxOpenAsks ?? 3,
    };
    this.waitpoints = o.waitpoints ?? nodeWaitpoints(o.store, o.pollMs);
  }

  get mode(): "interactive" | "afk" {
    return this.s.mode;
  }

  /** Effective hotWait in ms, for the harness adapter's tool timeout (hotWait + 2 min, spec §6.11). */
  get hotWaitMs(): number {
    return this.s.hotWaitMs;
  }

  // ───────────────────────────── factory asks ─────────────────────────────

  /** `ask()` from factory code. Replay-stable: the same spec at the same place returns the stored answer. */
  async ask(spec: AskSpec, scope: { callPath: string }): Promise<AskResolution> {
    // Taken before any await, so the sequence follows the factory's (deterministic) call order.
    const askSeq = this.factorySeq.get(scope.callPath) ?? 0;
    this.factorySeq.set(scope.callPath, askSeq + 1);
    const norm = await this.prepare(spec, {});
    const specHash = await computeSpecHash(norm.stored);
    const opened = await this.openAsk({
      callPath: scope.callPath,
      origin: { kind: "factory", askSeq },
      norm,
      specHash,
      timeoutMs: this.timeoutFor(norm.stored, undefined),
    });
    if (opened.kind === "resolved") return opened.resolution;
    return this.paused(() => this.awaitResolution(opened.record.askId));
  }

  // ───────────────────────────── agent asks ─────────────────────────────

  /** Handles an `ask_human` the runtime surfaced as `pendingAsk`. Throws AskTimeoutError when policy fails. */
  async openAgentAsk(req: AgentAskRequest): Promise<AgentAskTicket> {
    let norm: NormalizedAsk;
    try {
      norm = await this.prepare(req.spec, req.agentHitl ?? {});
    } catch (err) {
      if (err instanceof AskSpecError) return { kind: "rejected", toolText: `ask_human error: ${err.message}` };
      throw err;
    }
    const specHash = await computeSpecHash(norm.stored);
    const timeoutMs = this.timeoutFor(norm.stored, req.agentHitl?.timeout);

    // A harness that retries the tool call attaches to the open ask instead of posting a second card.
    let record = await this.findOpen(
      (r) => r.origin.kind === "agent" && r.origin.launchId === req.launchId && r.specHash === specHash,
    );
    if (!record) {
      // A restarted host meets the same ask again. Its answer may have been written while nothing ran, and it
      // must count as the ask it is, not as one more ask against the limits.
      const known = await this.knownAgentAsk(req, specHash);
      if (known?.status === "open") record = known;
      else if (known) {
        const resolution = this.settledResult(known);
        return { kind: "resolved", record: known, resolution, toolText: formatToolResult(known, resolution) };
      }
    }

    if (!record) {
      const maxAsks = Math.min(this.s.maxAsksPerAgent, req.agentHitl?.maxAsks ?? Number.POSITIVE_INFINITY);
      const asked = await this.countAgentAsks(req.callPath);
      if (asked >= maxAsks)
        return {
          kind: "rejected",
          toolText: `ask_human error: this call has already asked ${asked} questions, the limit. Decide for yourself and continue.`,
        };
      let open = 0;
      for await (const _ of this.store.open({ runId: this.run.runId })) open++;
      if (open >= this.s.maxOpenAsks)
        return {
          kind: "rejected",
          toolText: `ask_human error: ${open} questions are already open in this run, the limit. Decide for yourself and continue.`,
        };
      const opened = await this.openAsk({
        callPath: req.callPath,
        origin: { kind: "agent", launchId: req.launchId, askSeq: req.askSeq },
        norm,
        specHash,
        timeoutMs,
      });
      if (opened.kind === "resolved")
        return {
          kind: "resolved",
          record: opened.record,
          resolution: opened.resolution,
          toolText: formatToolResult(opened.record, opened.resolution),
        };
      record = opened.record;
    }

    const plan = selectWaitMode({
      hotWaitMs: this.s.hotWaitMs,
      mcpToolTimeoutMs: req.harness.mcpToolTimeoutMs,
      askTimeoutMs: Math.max(0, Date.parse(record.expiresAt) - Date.now()),
      canResume: req.harness.canResume,
      sharedHandle: req.sharedHandle ?? false,
    });
    if (plan.mode === "policy") {
      const resolution = await this.awaitResolution(record.askId, { deadlineMs: Date.now() });
      const settled = (await this.store.get(record.askId)) ?? record;
      return { kind: "resolved", record: settled, resolution, toolText: formatToolResult(settled, resolution) };
    }
    return { kind: "wait", record, plan, suspendedText: formatSuspended(record) };
  }

  /**
   * Holds a hot wait for up to `hotMs`. Returns the resolution, or null when the hot window passed and the
   * ask is still open (the caller then goes cold, or calls `expire()` when it cannot).
   */
  async waitHot(askId: string, hotMs: number): Promise<AskResolution | null> {
    const record = await this.mustGet(askId);
    const expiry = Date.parse(record.expiresAt);
    const until = Math.min(Date.now() + hotMs, expiry);
    const after = await this.paused(() => this.waitUntil(askId, until));
    if (after.status !== "open") return this.settledResult(after);
    if (Date.now() >= expiry) return this.awaitResolution(askId, { deadlineMs: Date.now() });
    return null;
  }

  /** Applies the onTimeout policy now: the hot window of a harness that cannot resume ran out. */
  expire(askId: string): Promise<AskResolution> {
    return this.awaitResolution(askId, { deadlineMs: Date.now() });
  }

  /**
   * The cold half of an agent ask: waits until the ask settles (or applies its policy at expiry) and returns the
   * first message of the turn that resumes the session with the answer (spec §8.4, cold wait step 5).
   */
  async awaitCold(askId: string, info: ColdInfo = {}): Promise<{ resolution: AskResolution; message: string }> {
    await this.markCold(askId, info);
    const resolution = await this.paused(() => this.awaitResolution(askId));
    const record = (await this.store.get(resolution.askId)) ?? (await this.mustGet(askId));
    this.delivered(record, "resume");
    return { resolution, message: formatResumeMessage(record, resolution) };
  }

  /**
   * Records on the ask that it went cold, before the run reports waiting (demo-path §6.1), so whoever resumes the
   * run reads the parked box and session from the store. An ask that already settled is left alone.
   */
  async markCold(askId: string, info: ColdInfo = {}): Promise<AskRecord | null> {
    const prior = await this.store.get(askId);
    // A resumed run that waits again keeps the moment the ask first went cold.
    const cold: NonNullable<AskRecord["cold"]> = { since: prior?.cold?.since ?? new Date().toISOString(), ...info };
    if (!this.store.markCold) {
      this.skip("ask-store-cannot-mark-cold", { askId });
      return prior;
    }
    const after = await this.store.markCold(askId, cold);
    if (after?.cold) this.emit("ask.cold", { askId, ordinal: after.ordinal, ...info });
    return after;
  }

  /** Records that the answer was handed to the agent (inbox or resume message). */
  delivered(record: AskRecord, how: "inbox" | "resume"): void {
    this.emit("ask.delivered", { askId: record.askId, ordinal: record.ordinal, how, callPath: record.callPath });
  }

  /**
   * `notify_human` from an agent: an FYI in the run thread. Returns the tool result text. `postInAfk` (factory
   * code's `notify()`, release-prep §7.2 #2) posts in AFK mode too: AFK means nobody answers asks, not silence.
   */
  async notifyHuman(req: {
    callPath: string;
    text: string;
    postInAfk?: boolean;
  }): Promise<{ isError: boolean; toolText: string }> {
    const n = this.fyis.get(req.callPath) ?? 0;
    if (n >= this.s.maxAsksPerAgent)
      return { isError: true, toolText: "notify_human error: the notification limit for this call is reached." };
    if (typeof req.text !== "string" || req.text.trim() === "")
      return { isError: true, toolText: "notify_human error: text must be a non-empty string." };
    this.fyis.set(req.callPath, n + 1);
    if ((this.s.mode === "afk" && !req.postInAfk) || this.s.channels.length === 0)
      return { isError: false, toolText: "Noted. No channel is configured, so nobody was notified." };
    const sent = await this.broadcast(this.s.channels, {
      kind: "fyi",
      text: req.text,
      data: { callPath: req.callPath },
    });
    return sent > 0
      ? { isError: false, toolText: "Posted to the run thread." }
      : { isError: false, toolText: "The notification could not be delivered; continue without it." };
  }

  // ───────────────────────────── waiting and policy ─────────────────────────────

  /**
   * Waits for an ask to settle, until its expiry (or `deadlineMs`), then applies the onTimeout policy. This is
   * the plain Node durable wait; after a restart the replayed ask resumes here with the remaining time.
   */
  async awaitResolution(askId: string, o: { deadlineMs?: number } = {}): Promise<AskResolution> {
    let id = askId;
    for (;;) {
      const record = await this.mustGet(id);
      if (record.status !== "open") {
        const next = record.status === "cancelled" ? this.superseded.get(id) : undefined;
        if (next) {
          id = next;
          continue;
        }
        return this.settledResult(record);
      }
      const deadline = o.deadlineMs ?? Date.parse(record.expiresAt);
      const after = await this.waitUntil(id, deadline);
      if (after.status !== "open") continue;
      await this.finalReconcile(after);
      const latest = await this.mustGet(id);
      if (latest.status !== "open") continue;
      return this.applyPolicy(latest, "timeout");
    }
  }

  /** Marks every open ask of the run cancelled and edits its cards (spec §8.5, run cancellation). */
  async cancelOpen(reason = "the run was cancelled"): Promise<number> {
    let n = 0;
    for await (const r of this.store.open({ runId: this.run.runId })) {
      await this.store.setStatus(r.askId, "cancelled");
      const now = await this.store.get(r.askId);
      if (now?.status !== "cancelled") continue;
      n++;
      wakeAsk(this.store, r.askId);
      this.emit("ask.cancelled", { askId: r.askId, ordinal: r.ordinal, reason });
      await updateCards(now, this.s.channels, "cancelled", formatSettledCard(now, null), this.cardError);
    }
    return n;
  }

  /** Answers in process: the CLI path and tests. Same validation, CAS and card edits as a webhook. */
  answer(askId: string, answer: AskAnswer<unknown>, answeredBy: AnsweredBy) {
    return answerAsk({
      store: this.store,
      askId,
      answer,
      answeredBy,
      channels: this.s.channels,
      onCardError: this.cardError,
    });
  }

  // ───────────────────────────── notifications ─────────────────────────────

  /**
   * Posts the run's final summary (spec §8.9) to every thread the run opened, and to the configured channels
   * when `notify.on` asks for it. Never throws: delivery failures become `notify.failed` events.
   */
  async notifyRunEnd(summary: RunSummary): Promise<void> {
    const kind = FAILED.has(summary.status) ? "run.failed" : "run.end";
    const on = this.o.notify?.on ?? ["run.end", "run.failed"];
    const targets = new Map<string, HitlChannel>();
    for (const ch of this.s.channels) if (this.threads.has(ch.id)) targets.set(ch.id, ch);
    if (on.includes(kind)) for (const ch of this.notifyChannels()) targets.set(ch.id, ch);
    if (targets.size === 0) return;
    const mention = this.o.notify?.mention ?? "on-failure";
    const text = await this.summaryText(summary);
    await this.broadcast([...targets.values()], {
      kind,
      text,
      mention: mention === "approvers" || (mention === "on-failure" && kind === "run.failed"),
      data: { runId: this.run.runId, status: summary.status },
    });
  }

  /** `agent.end` (and any other opted-in kind) notifications. */
  async notifyEvent(kind: "agent.end" | "ask.expired", text: string, data?: Record<string, unknown>): Promise<void> {
    if (!(this.o.notify?.on ?? []).includes(kind)) return;
    await this.broadcast(this.notifyChannels(), { kind, text, ...(data ? { data } : {}) });
  }

  // ───────────────────────────── internals ─────────────────────────────

  private readonly cardError = (err: unknown, channel: string) => {
    this.emit("ask.card.failed", { channel, error: String(err) }, "warn");
  };

  private emit(type: string, data: Record<string, unknown>, level: "debug" | "info" | "warn" | "error" = "info") {
    try {
      this.o.emit?.(type, data, level);
    } catch {
      // Event sinks are fail-soft (spec §9.7).
    }
  }

  private skip(reason: string, data: Record<string, unknown> = {}) {
    this.emit("skip", { reason, ...data }, "debug");
  }

  private notifyChannels(): HitlChannel[] {
    return [...(this.o.notify?.channels ?? this.s.channels)];
  }

  private redact(s: string): string {
    return this.o.redact ? this.o.redact(s) : s;
  }

  private async prepare(spec: AskSpec, agentHitl: AgentHitl): Promise<NormalizedAsk> {
    const redacted: AskSpec = {
      ...spec,
      question: typeof spec.question === "string" ? this.redact(spec.question) : spec.question,
    };
    if (typeof spec.title === "string") redacted.title = this.redact(spec.title);
    if (typeof spec.context === "string") redacted.context = this.redact(spec.context);
    // The agent can never lower a risk the factory set.
    if (agentHitl.risk === "high") redacted.risk = "high";
    const norm = await normalizeAskSpec(redacted);
    const onTimeout = norm.stored.onTimeout ?? this.s.onTimeout;
    const risk = norm.stored.risk ?? "low";
    if (onTimeout === "auto" && !this.o.hitl?.autoAnswer)
      throw new AskSpecError('ask: onTimeout: "auto" needs hitl.autoAnswer in the run configuration.');
    checkPolicy(norm, onTimeout, risk);
    if (agentHitl.timeout !== undefined && durationToMs(agentHitl.timeout) === null)
      throw new AskSpecError(`ask: hitl.timeout ${JSON.stringify(agentHitl.timeout)} is not a duration.`);
    return norm;
  }

  private timeoutFor(stored: AskSpec, agentTimeout: Duration | undefined): number {
    const own = durationToMs(stored.timeout) ?? this.s.timeoutMs;
    const cap = durationToMs(agentTimeout);
    return cap === null ? own : Math.min(own, cap);
  }

  private async mustGet(askId: string): Promise<AskRecord> {
    const r = await this.store.get(askId);
    if (!r) throw new Error(`ask ${askId} is missing from the ask store`);
    return r;
  }

  /** Pauses the run's wall clock around a wait for a human. */
  private async paused<T>(fn: () => Promise<T>): Promise<T> {
    const clock = this.o.clock;
    clock?.pauseClock();
    try {
      return await fn();
    } finally {
      clock?.resumeClock();
    }
  }

  /** The record an agent ask maps to, whatever its status, or null when this ask was never created. */
  private async knownAgentAsk(req: AgentAskRequest, specHash: string): Promise<AskRecord | null> {
    const origin = { kind: "agent" as const, launchId: req.launchId, askSeq: req.askSeq };
    for (let collision = 0; collision < 8; collision++) {
      const askId = await deriveAskId({
        runId: this.run.runId,
        callPath: req.callPath,
        launchId: req.launchId,
        askSeq: req.askSeq,
        specHash,
        collision,
      });
      const r = await this.store.get(askId);
      if (!r) return null;
      if (this.sameAsk(r, origin, specHash)) return r;
    }
    return null;
  }

  private async findOpen(pred: (r: AskRecord) => boolean): Promise<AskRecord | null> {
    for await (const r of this.store.open({ runId: this.run.runId })) if (pred(r)) return r;
    return null;
  }

  private async countAgentAsks(callPath: string): Promise<number> {
    if (this.store.list) {
      let n = 0;
      for await (const r of this.store.list({ runId: this.run.runId }))
        if (r.origin.kind === "agent" && r.callPath === callPath) n++;
      return n;
    }
    return this.agentAsks.get(callPath) ?? 0;
  }

  private nextOrdinal(): Promise<number> {
    const prev =
      this.ordinal ??
      (async () => {
        let max = 0;
        const source = this.store.list
          ? this.store.list({ runId: this.run.runId })
          : this.store.open({ runId: this.run.runId });
        for await (const r of source) max = Math.max(max, r.ordinal);
        return max;
      })();
    this.ordinal = prev.then((n) => n + 1);
    return this.ordinal;
  }

  private sameAsk(r: AskRecord, origin: AskRecord["origin"], specHash: string): boolean {
    if (r.specHash !== specHash || r.origin.kind !== origin.kind) return false;
    return origin.kind === "factory" || (r.origin.kind === "agent" && r.origin.launchId === origin.launchId);
  }

  /** Creates the record, or finds the same ask again (spec §8.3 matching rules), then posts or resolves it. */
  private async openAsk(p: {
    callPath: string;
    origin: AskRecord["origin"];
    norm: NormalizedAsk;
    specHash: string;
    timeoutMs: number;
  }): Promise<Opened> {
    const stored: AskSpec = {
      ...p.norm.stored,
      onTimeout: p.norm.stored.onTimeout ?? this.s.onTimeout,
      risk: p.norm.stored.risk ?? "low",
    };
    for (let collision = 0; ; collision++) {
      const askId = await deriveAskId({
        runId: this.run.runId,
        callPath: p.callPath,
        ...(p.origin.kind === "agent" ? { launchId: p.origin.launchId } : {}),
        askSeq: p.origin.askSeq,
        specHash: p.specHash,
        collision,
      });
      let existing = await this.store.get(askId);
      if (!existing) {
        const now = Date.now();
        const expiresAt = new Date(now + p.timeoutMs).toISOString();
        const record: AskRecord = {
          askId,
          runId: this.run.runId,
          ordinal: await this.nextOrdinal(),
          callPath: p.callPath,
          origin: p.origin,
          specHash: p.specHash,
          spec: stored,
          status: "open",
          waitpoint: { host: this.waitpoints.host, ref: await this.waitpoints.create(askId, expiresAt) },
          messages: [],
          createdAt: new Date(now).toISOString(),
          expiresAt,
        };
        const created = await this.store.create(record);
        if (created.status === "created") {
          if (p.origin.kind === "agent") this.agentAsks.set(p.callPath, (this.agentAsks.get(p.callPath) ?? 0) + 1);
          this.emit("ask.created", { askId, ordinal: record.ordinal, callPath: p.callPath, origin: p.origin.kind });
          return this.publish(record, p.norm);
        }
        existing = created.record;
      }
      if (this.sameAsk(existing, p.origin, p.specHash)) {
        if (existing.status === "answered" && existing.resolution)
          return { kind: "resolved", record: existing, resolution: existing.resolution };
        if (existing.status !== "open")
          return { kind: "resolved", record: existing, resolution: this.settledResult(existing) };
        return { kind: "open", record: existing };
      }
      // Never hand an old answer to a different question or launch.
      this.skip("ask-id-collision", { askId, callPath: p.callPath });
    }
  }

  /** Supersedes a same-dedupeKey ask, then resolves at once (AFK, undeliverable) or posts to the channels. */
  private async publish(record: AskRecord, norm: NormalizedAsk): Promise<Opened> {
    if (record.spec.dedupeKey !== undefined) await this.supersede(record);

    if (this.s.mode === "afk") return this.resolveNow(record, norm, "afk");

    const results = await Promise.all(
      this.s.channels.map(async (ch) => {
        try {
          const thread = await this.thread(ch);
          return await ch.post(record, thread);
        } catch (err) {
          this.emit("ask.post.failed", { askId: record.askId, channel: ch.id, error: String(err) }, "warn");
          return null;
        }
      }),
    );
    const messages = results.filter((m) => m !== null);
    if (messages.length === 0) {
      // No ask waits silently (spec §8.1 rule 8).
      this.emit("ask.undeliverable", { askId: record.askId, ordinal: record.ordinal }, "warn");
      return this.resolveNow(record, norm, "undeliverable");
    }
    record.messages = messages;
    await this.store.patch?.(record.askId, { messages });
    this.emit("ask.posted", { askId: record.askId, ordinal: record.ordinal, channels: messages.map((m) => m.channel) });
    return { kind: "open", record };
  }

  private async resolveNow(record: AskRecord, _norm: NormalizedAsk, reason: "afk" | "undeliverable"): Promise<Opened> {
    const resolution = await this.applyPolicy(record, reason);
    const settled = (await this.store.get(record.askId)) ?? record;
    return { kind: "resolved", record: settled, resolution };
  }

  private async supersede(record: AskRecord): Promise<void> {
    for await (const old of this.store.open({ runId: this.run.runId })) {
      if (old.askId === record.askId || old.spec.dedupeKey !== record.spec.dedupeKey) continue;
      await this.store.setStatus(old.askId, "cancelled");
      this.superseded.set(old.askId, record.askId);
      wakeAsk(this.store, old.askId);
      this.emit("ask.cancelled", { askId: old.askId, ordinal: old.ordinal, supersededBy: record.askId });
      await updateCards(
        { ...old, status: "cancelled" },
        this.s.channels,
        "superseded",
        `Superseded by #${record.ordinal}`,
        this.cardError,
      );
    }
  }

  private thread(ch: HitlChannel): Promise<ThreadKey> {
    let t = this.threads.get(ch.id);
    if (!t) {
      t = ch.openThread(this.run);
      this.threads.set(ch.id, t);
      t.catch(() => this.threads.delete(ch.id));
    }
    return t;
  }

  private waitUntil(askId: string, untilMs: number): Promise<AskRecord> {
    return (async () => {
      for (;;) {
        const r = await this.mustGet(askId);
        if (r.status !== "open" || Date.now() >= untilMs) return r;
        if (this.o.signal?.aborted) {
          await this.cancelOpen(String(this.o.signal.reason ?? "aborted"));
          return this.mustGet(askId);
        }
        await this.waitpoints.wait(askId, untilMs, this.o.signal);
      }
    })();
  }

  private settledResult(r: AskRecord): AskResolution {
    if (r.status === "answered" && r.resolution) return r.resolution;
    const opts = { runId: r.runId, callPath: r.callPath };
    if (r.status === "cancelled") throw new AskCancelledError({ askId: r.askId }, opts);
    throw new AskTimeoutError({ askId: r.askId }, opts);
  }

  /** For channels that can pull missed answers: one last pull before the timeout counts (spec §8.8). */
  private async finalReconcile(record: AskRecord): Promise<void> {
    for (const ch of this.s.channels) {
      if (!ch.reconcile || !record.messages.some((m) => m.channel === ch.id)) continue;
      const since = record.reconciledAt ?? record.createdAt;
      try {
        for await (const ev of ch.reconcile(record, since)) {
          const out = await handleInbound(ev, {
            store: this.store,
            channels: this.s.channels,
            approvers: this.o.hitl?.approvers ?? [],
            ...(this.run.requestedBy === undefined ? {} : { requester: this.run.requestedBy }),
            onSkip: (reason) => this.skip(reason, { askId: record.askId, via: "reconcile" }),
          });
          if (out.action === "answered")
            this.emit("ask.answered", { askId: out.result.record.askId, via: "reconcile" });
        }
        await this.store.patch?.(record.askId, { reconciledAt: new Date().toISOString() });
        this.emit("ask.reconciled", { askId: record.askId, channel: ch.id });
      } catch (err) {
        // A failed reconcile never resolves or expires an ask by itself.
        this.emit("ask.reconcile.failed", { askId: record.askId, channel: ch.id, error: String(err) }, "warn");
      }
    }
  }

  /** Resolves an ask without a human, or expires it and throws AskTimeoutError (spec §8.8). */
  private async applyPolicy(record: AskRecord, reason: "timeout" | "afk" | "undeliverable"): Promise<AskResolution> {
    const norm = fromStored(record.spec);
    const onTimeout = record.spec.onTimeout ?? this.s.onTimeout;
    const risk = record.spec.risk ?? "low";
    let answer: AskAnswer<unknown> | null = null;
    let answeredBy: AnsweredBy | null = null;

    if (onTimeout === "auto" && risk !== "high") {
      const auto = await this.tryAutoAnswer(record, norm);
      if (auto) {
        answer = auto.answer;
        answeredBy = { kind: "auto", model: auto.model, rationale: auto.rationale };
      }
    }
    if (!answer && onTimeout !== "fail") {
      answer = fallbackAnswer(norm, risk);
      if (answer) answeredBy = { kind: "default", reason };
    }

    if (answer && answeredBy) {
      const r = await answerAsk({
        store: this.store,
        askId: record.askId,
        answer,
        answeredBy,
        channels: this.s.channels,
        onCardError: this.cardError,
      });
      if (r.status === "answered") {
        this.emit("ask.answered", {
          askId: record.askId,
          ordinal: record.ordinal,
          answeredBy: answeredBy.kind,
          reason,
          choiceId: r.resolution.choiceId,
        });
        return r.resolution;
      }
      if (r.status === "lost") return this.settledResult(r.current);
      this.emit(
        "ask.policy.invalid",
        { askId: record.askId, error: r.status === "invalid" ? r.message : r.status },
        "warn",
      );
    }

    await this.store.setStatus(record.askId, "expired");
    const now = await this.mustGet(record.askId);
    if (now.status === "answered" && now.resolution) return now.resolution;
    wakeAsk(this.store, record.askId);
    this.emit("ask.expired", { askId: record.askId, ordinal: record.ordinal, reason, onTimeout, risk }, "warn");
    await updateCards(now, this.s.channels, "expired", formatSettledCard(now, null), this.cardError);
    await this.notifyEvent("ask.expired", `Question #${record.ordinal} expired with nobody answering.`, {
      askId: record.askId,
    });
    throw new AskTimeoutError({ askId: record.askId }, { runId: record.runId, callPath: record.callPath });
  }

  private async tryAutoAnswer(
    record: AskRecord,
    norm: NormalizedAsk,
  ): Promise<{ answer: AskAnswer<unknown>; rationale: string; model: string } | null> {
    const cfg = this.o.hitl?.autoAnswer;
    if (!cfg || !this.o.autoAnswer) {
      this.skip("auto-answer-unavailable", { askId: record.askId });
      return null;
    }
    try {
      const maxUsd = cfg.maxUsd ?? DEFAULT_AUTO_MAX_USD;
      const out = await this.o.autoAnswer({
        askId: record.askId,
        runId: record.runId,
        callPath: record.callPath,
        spec: record.spec,
        model: cfg.model,
        maxUsd,
        ...(this.o.signal ? { signal: this.o.signal } : {}),
      });
      if (out.costUsd !== undefined)
        this.emit("budget.charge", { usd: out.costUsd, askId: record.askId, what: "auto-answer" });
      const problem = await checkAnswer(norm, out.answer);
      const rationale = typeof out.rationale === "string" ? (out.rationale.trim().split("\n")[0] ?? "") : "";
      if (problem || rationale === "" || (out.costUsd !== undefined && out.costUsd > maxUsd)) {
        this.emit(
          "ask.auto.invalid",
          { askId: record.askId, error: problem ?? "missing rationale or over budget" },
          "warn",
        );
        return null;
      }
      return { answer: out.answer, rationale: this.redact(rationale), model: cfg.model };
    } catch (err) {
      this.emit("ask.auto.failed", { askId: record.askId, error: String(err) }, "warn");
      return null;
    }
  }

  private async summaryText(s: RunSummary): Promise<string> {
    const lines = [`*${this.run.factory}* finished: ${s.status}`];
    if (s.skill) lines.push(`Skill: ${s.skill}`);
    const meta: string[] = [];
    if (s.durationMs !== undefined) meta.push(`took ${formatDuration(s.durationMs)}`);
    if (s.costUsd !== undefined) meta.push(`cost $${s.costUsd.toFixed(2)}`);
    if (meta.length) lines.push(meta.join(", "));
    if (s.result !== undefined) {
      const summary = (s.result as { summary?: unknown } | null)?.summary;
      lines.push(typeof summary === "string" ? summary : (JSON.stringify(s.result)?.slice(0, 500) ?? ""));
    }
    if (s.artifacts?.prUrl) lines.push(`PR: ${s.artifacts.prUrl}`);
    if (s.artifacts?.branch) lines.push(`Branch: ${s.artifacts.branch}`);
    const asks: AskRecord[] = [];
    if (this.store.list) for await (const r of this.store.list({ runId: this.run.runId })) asks.push(r);
    if (asks.length > 0) {
      const by = asks
        .map((r) => r.resolution?.answeredBy)
        .filter((b) => b !== undefined)
        .map((b) => (b.kind === "human" ? `@${b.displayName || b.userId}` : b.kind));
      lines.push(`Questions: ${asks.length}${by.length ? ` (answered by ${[...new Set(by)].join(", ")})` : ""}`);
    }
    if (s.error) {
      lines.push(`Error: ${s.error.name}: ${s.error.message}`);
      if (s.error.hint) lines.push(`Next: ${s.error.hint}`);
      if (s.error.branch) lines.push(`Work kept on branch ${s.error.branch}`);
      if (s.error.sessionId) lines.push(`Session: ${s.error.sessionId}`);
    }
    if (s.transcriptUrl) lines.push(`Transcript: ${s.transcriptUrl}`);
    return lines.join("\n");
  }

  /** Sends one notification to each channel's run thread, with retries. Returns how many succeeded. */
  private async broadcast(channels: HitlChannel[], n: Notification): Promise<number> {
    const tries = this.o.notifyRetry?.tries ?? 3;
    const backoffMs = this.o.notifyRetry?.backoffMs ?? 500;
    // Redact, then truncate: truncating first could publish a readable prefix of a secret.
    const redacted = this.redact(n.text);
    const sent = await Promise.all(
      channels.map(async (ch) => {
        const limit = TEXT_LIMITS[ch.id] ?? TEXT_LIMITS.slack ?? 3_000;
        const text = redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted;
        let last: unknown;
        for (let i = 0; i < tries; i++) {
          try {
            await ch.notify(await this.thread(ch), { ...n, text });
            return true;
          } catch (err) {
            last = err;
            if (i < tries - 1) await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
          }
        }
        this.emit("notify.failed", { channel: ch.id, kind: n.kind, error: String(last) }, "warn");
        return false;
      }),
    );
    return sent.filter(Boolean).length;
  }
}
