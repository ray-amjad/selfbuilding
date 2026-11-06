import { parseDuration } from "../config/duration.js";
import { internalNow } from "../engine/hash.js";
import { BudgetExceededError, UnknownModelPriceError } from "../errors/classes.js";
import type { EmitInput } from "../events/bus.js";
import type { Budget } from "../types/budget.js";
import type { JournalEntry } from "../types/orchestration.js";
import { findPrice, priceTokens, type TokenCounts } from "./prices.js";

/** Charge entries are written at every turn end and at most this often in between (spec §3.9). */
export const CHARGE_PERSIST_INTERVAL_MS = 30_000;

export interface ChargeInput {
  launchId: string;
  /** The runtime's turnIndex; counters are cumulative within one turn (spec §9.6 rule 5). */
  turn: number;
  /** Cumulative USD for this turn, when the harness reports cost. */
  usd?: number;
  /** Cumulative input + output tokens for this turn. */
  tokens?: number;
  /** A crashed turn charged its last cumulative value. */
  estimated?: boolean;
  /** Turn end: always persisted. */
  final?: boolean;
}

export interface ChargeRecord {
  stepKey: string;
  callPath: string;
  launchId: string;
  turn: number;
  usd: number;
  tokens: number;
  attempt: number;
  estimated?: boolean;
}

export interface LedgerOptions {
  budget?: Budget;
  /** The effective `concurrency.sandboxes`; the default slice is `usd / sandboxes`. */
  sandboxes: number;
  emit?: (e: EmitInput) => void;
  /** Persists a charge as a `kind: "charge"` journal entry. */
  persist?: (record: ChargeRecord) => Promise<void>;
  now?: () => number;
}

export interface AdmitInput {
  callPath: string;
  stepKey: string;
  attempt?: number;
  /** Per-call `budget.usd`; defaults to `budget.perAgent.usd`. */
  usd?: number;
  /** Token-metered harnesses must have a price (spec §9.6 rule 4). */
  model?: string;
  tokenMetered?: boolean;
}

/** One admitted agent attempt holding its slice (spec §9.6). */
export class Reservation {
  readonly launchIds = new Set<string>();
  private released = false;
  private exceededReported = false;
  private readonly lastPersist = new Map<string, number>();

  constructor(
    private readonly ledger: BudgetLedger,
    readonly callPath: string,
    readonly stepKey: string,
    readonly attempt: number,
    /** The hard cap passed to the runtime; null when the run has no USD budget and no per-agent cap. */
    readonly sliceUsd: number | null,
  ) {}

  /** USD charged to this reservation so far. */
  get spentUsd(): number {
    return this.ledger.spentOn(this.launchIds).usd;
  }

  get spentTokens(): number {
    return this.ledger.spentOn(this.launchIds).tokens;
  }

  get isReleased(): boolean {
    return this.released;
  }

  /** Records a cumulative charge. Returns whether the slice is now exceeded; the caller stops the agent. */
  async charge(input: ChargeInput): Promise<{ exceeded: boolean }> {
    this.launchIds.add(input.launchId);
    const record = this.ledger.record(this, input);
    const key = `${input.launchId}\u0000${input.turn}`;
    const now = this.ledger.clock();
    const last = this.lastPersist.get(key);
    if (input.final || last === undefined || now - last >= CHARGE_PERSIST_INTERVAL_MS) {
      this.lastPersist.set(key, now);
      await this.ledger.persistRecord(record);
    }
    const exceeded = this.sliceUsd !== null && this.spentUsd > this.sliceUsd;
    if (exceeded && !this.exceededReported) {
      this.exceededReported = true;
      this.ledger.markExhausted(this.callPath, "running");
    }
    return { exceeded };
  }

  /** The slice this attempt may still spend, for native caps such as `--max-budget-usd`. */
  remainingUsd(): number | null {
    return this.sliceUsd === null ? null : Math.max(0, this.sliceUsd - this.spentUsd);
  }

  /** Ends the attempt: the unused part of the slice returns to the run. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.ledger.releaseReservation(this);
  }

  throwIfExceeded(opts: { runId?: string } = {}): void {
    if (this.sliceUsd !== null && this.spentUsd > this.sliceUsd) {
      throw new BudgetExceededError({ phase: "running" }, { callPath: this.callPath, ...opts });
    }
  }
}

/**
 * The run's shared budget (spec §3.12, §9.6): admission reserves slices, runtimes charge cumulative usage,
 * replayed calls are never charged again, and the ledger survives resumes through `charge` entries.
 */
export class BudgetLedger {
  readonly budget: Budget | undefined;
  /** Original cost of calls served from the journal. */
  replayedUsd = 0;
  /** Set when admission failed or an agent crossed its slice: the run ends `budget_exhausted`. */
  exhausted = false;

  private readonly charges = new Map<string, Map<number, { usd: number; tokens: number }>>();
  private readonly excludedSteps = new Set<string>();
  private readonly reservations = new Set<Reservation>();
  private readonly sandboxes: number;
  private readonly emit: (e: EmitInput) => void;
  private readonly persist: ((record: ChargeRecord) => Promise<void>) | undefined;
  readonly clock: () => number;
  private warned = false;
  private readonly wallClockMs: number | undefined;
  private activeStart: number | null;
  private activeAccum = 0;
  private pauseDepth = 0;

  constructor(opts: LedgerOptions) {
    this.budget = opts.budget;
    this.sandboxes = Math.max(1, opts.sandboxes);
    this.emit = opts.emit ?? (() => {});
    this.persist = opts.persist;
    this.clock = opts.now ?? internalNow;
    this.wallClockMs = opts.budget?.wallClock === undefined ? undefined : parseDuration(opts.budget.wallClock);
    this.activeStart = this.clock();
  }

  /**
   * Rebuilds spend from a journal on resume. Charges of attempts that completed `ok` before this process are
   * excluded: if their call replays, its cost arrives through `noteReplayed`; if it re-runs, it is a new spend.
   */
  restore(entries: Iterable<JournalEntry>): void {
    const list = [...entries];
    for (const entry of list) {
      // Every launch of a finished call is excluded, not just the one that returned the value: the replayed
      // value's usage already covers the earlier launches (retries, resumes) of the same call.
      if (entry.kind === "agent" && entry.status === "ok") this.excludedSteps.add(stepOfLaunch(entry.launchId));
    }
    for (const entry of list) {
      if (entry.kind !== "charge" || !entry.charge) continue;
      this.setCharge(entry.launchId, entry.charge.turn, entry.charge.usd, entry.charge.tokens);
    }
  }

  /** Records the original cost of a call served from the journal. */
  noteReplayed(usd: number | null | undefined): void {
    if (usd) this.replayedUsd += usd;
  }

  /** Spend counted against the run: live charges, unfinished earlier attempts, and replayed calls. */
  charged(): { usd: number; tokens: number } {
    let usd = this.replayedUsd;
    let tokens = 0;
    for (const [launchId, turns] of this.charges) {
      if (this.excludedSteps.has(stepOfLaunch(launchId))) continue;
      for (const c of turns.values()) {
        usd += c.usd;
        tokens += c.tokens;
      }
    }
    return { usd: round(usd), tokens };
  }

  spentOn(launchIds: Iterable<string>): { usd: number; tokens: number } {
    let usd = 0;
    let tokens = 0;
    for (const launchId of launchIds) {
      for (const c of this.charges.get(launchId)?.values() ?? []) {
        usd += c.usd;
        tokens += c.tokens;
      }
    }
    return { usd: round(usd), tokens };
  }

  /** USD not yet charged or held by an in-flight reservation; Infinity without a USD budget. */
  unreserved(): number {
    if (this.budget?.usd === undefined) return Number.POSITIVE_INFINITY;
    let held = 0;
    for (const r of this.reservations) if (r.sliceUsd !== null) held += Math.max(0, r.sliceUsd - r.spentUsd);
    return round(this.budget.usd - this.charged().usd - held);
  }

  /** Admission (spec §9.6 rule 1). Throws BudgetExceededError { phase: "admission" } when no slice fits. */
  admit(input: AdmitInput): Reservation {
    const b = this.budget;
    if (input.tokenMetered && input.model !== undefined && findPrice(input.model, b?.prices) === undefined) {
      if (!b?.allowUnmetered) throw new UnknownModelPriceError({ model: input.model }, { callPath: input.callPath });
      this.emit({
        type: "budget.warning",
        level: "warn",
        callPath: input.callPath,
        data: { reason: "unmetered", model: input.model },
      });
    }
    if (b?.tokens !== undefined && this.charged().tokens >= b.tokens) this.refuse(input.callPath, "tokens");
    if (this.wallClockMs !== undefined && this.activeMs() >= this.wallClockMs) this.refuse(input.callPath, "wallClock");

    const cap = input.usd ?? b?.perAgent?.usd;
    let slice: number | null;
    if (b?.usd === undefined) {
      slice = cap ?? null;
    } else {
      const unreserved = this.unreserved();
      slice = round(Math.min(cap ?? b.usd / this.sandboxes, unreserved));
      const minAgentUsd = b.minAgentUsd ?? Math.min(b.perAgent?.usd ?? Number.POSITIVE_INFINITY, 0.1 * b.usd);
      if (slice <= 0 || slice < minAgentUsd) this.refuse(input.callPath, "usd", { unreserved, minAgentUsd });
    }
    const reservation = new Reservation(this, input.callPath, input.stepKey, input.attempt ?? 1, slice);
    this.reservations.add(reservation);
    this.emit({ type: "budget.reserved", callPath: input.callPath, data: { sliceUsd: slice } });
    return reservation;
  }

  private refuse(callPath: string, reason: string, data: Record<string, unknown> = {}): never {
    this.markExhausted(callPath, "admission", { reason, ...data });
    throw new BudgetExceededError({ phase: "admission" }, { callPath });
  }

  markExhausted(callPath: string, phase: "admission" | "running", data: Record<string, unknown> = {}): void {
    this.exhausted = true;
    this.emit({ type: "budget.exceeded", level: "error", callPath, data: { phase, ...data } });
  }

  /** @internal Called by Reservation. */
  record(r: Reservation, input: ChargeInput): ChargeRecord {
    const turns = this.charges.get(input.launchId);
    const prev = turns?.get(input.turn);
    const usd = Math.max(prev?.usd ?? 0, input.usd ?? 0);
    const tokens = Math.max(prev?.tokens ?? 0, input.tokens ?? 0);
    this.setCharge(input.launchId, input.turn, usd, tokens);
    this.emit({
      type: "budget.charged",
      callPath: r.callPath,
      launchId: input.launchId,
      attempt: r.attempt,
      turnIndex: input.turn,
      data: { usd, tokens, ...(input.estimated ? { estimated: true } : {}), runUsd: this.charged().usd },
    });
    const total = this.budget?.usd;
    if (total !== undefined && !this.warned && this.charged().usd >= 0.8 * total) {
      this.warned = true;
      this.emit({
        type: "budget.warning",
        level: "warn",
        callPath: r.callPath,
        data: { reason: "80%", usd: this.charged().usd, budgetUsd: total },
      });
    }
    return {
      stepKey: r.stepKey,
      callPath: r.callPath,
      launchId: input.launchId,
      turn: input.turn,
      usd,
      tokens,
      attempt: r.attempt,
      ...(input.estimated ? { estimated: true } : {}),
    };
  }

  /** @internal */
  async persistRecord(record: ChargeRecord): Promise<void> {
    await this.persist?.(record);
  }

  /** @internal */
  releaseReservation(r: Reservation): void {
    this.reservations.delete(r);
  }

  /** Prices token usage for a token-metered harness; null when unmetered is allowed and the price unknown. */
  priceUsage(model: string, tokens: TokenCounts): number | null {
    const price = findPrice(model, this.budget?.prices);
    if (price) return priceTokens(price, tokens);
    if (this.budget?.allowUnmetered) return null;
    throw new UnknownModelPriceError({ model });
  }

  // Wall clock: Selfbuilding's own clock, paused during cold ask() waits (spec §9.6 rule 6).

  /** Stops the run clock, e.g. for a cold ask wait. Nested pauses need matching resumes. */
  pauseClock(): void {
    if (this.pauseDepth++ === 0 && this.activeStart !== null) {
      this.activeAccum += this.clock() - this.activeStart;
      this.activeStart = null;
    }
  }

  resumeClock(): void {
    if (this.pauseDepth === 0) return;
    if (--this.pauseDepth === 0) this.activeStart = this.clock();
  }

  activeMs(): number {
    return this.activeAccum + (this.activeStart === null ? 0 : this.clock() - this.activeStart);
  }

  /** Remaining run wall clock in ms, or undefined without a `wallClock` budget. */
  remainingWallClockMs(): number | undefined {
    return this.wallClockMs === undefined ? undefined : Math.max(0, this.wallClockMs - this.activeMs());
  }

  inFlight(): number {
    return this.reservations.size;
  }

  private setCharge(launchId: string, turn: number, usd: number, tokens: number): void {
    let turns = this.charges.get(launchId);
    if (!turns) {
      turns = new Map();
      this.charges.set(launchId, turns);
    }
    turns.set(turn, { usd, tokens });
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** `<stepKey>_e<epoch>_l<n>` (and the `_p` form of a whole-call charge) → the step key. */
function stepOfLaunch(launchId: string): string {
  const i = launchId.indexOf("_");
  return i === -1 ? launchId : launchId.slice(0, i);
}
