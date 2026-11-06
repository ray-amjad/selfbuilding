import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  ConfigError,
  SandboxCapDeadlockError,
  UnknownModelPriceError,
} from "../errors/classes.js";
import type { EmitInput } from "../events/bus.js";
import type { JournalEntry } from "../types/orchestration.js";
import { BudgetLedger, type ChargeRecord } from "./ledger.js";
import { findPrice, priceTokens } from "./prices.js";
import { CreateRateLimiter, createBackoffMs, effectiveCreatesPerMinute } from "./rate.js";
import { defaultSandboxCap, SandboxSlots } from "./slots.js";

function ledger(budget: ConstructorParameters<typeof BudgetLedger>[0]["budget"], extra: { sandboxes?: number } = {}) {
  const events: EmitInput[] = [];
  const persisted: ChargeRecord[] = [];
  let clock = 1_000_000;
  const l = new BudgetLedger({
    budget,
    sandboxes: extra.sandboxes ?? 4,
    emit: (e) => events.push(e),
    persist: async (r) => {
      persisted.push(r);
    },
    now: () => clock,
  });
  return {
    l,
    events,
    persisted,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("BudgetLedger admission", () => {
  it("reserves usd / sandboxes by default and never lets slices exceed the budget", () => {
    const { l } = ledger({ usd: 10 }, { sandboxes: 4 });
    const a = l.admit({ callPath: "A#0", stepKey: "a" });
    expect(a.sliceUsd).toBe(2.5);
    for (const name of ["B", "C", "D"]) l.admit({ callPath: `${name}#0`, stepKey: name });
    expect(l.unreserved()).toBe(0);
    expect(() => l.admit({ callPath: "E#0", stepKey: "e" })).toThrow(BudgetExceededError);
    expect(l.exhausted).toBe(true);
  });

  it("uses perAgent.usd and per-call usd, clamped to what is unreserved", () => {
    const { l } = ledger({ usd: 10, perAgent: { usd: 4 } });
    expect(l.admit({ callPath: "A#0", stepKey: "a" }).sliceUsd).toBe(4);
    expect(l.admit({ callPath: "B#0", stepKey: "b", usd: 1 }).sliceUsd).toBe(1);
    expect(l.admit({ callPath: "C#0", stepKey: "c" }).sliceUsd).toBe(4);
    // 1 left: exactly minAgentUsd = min(perAgent.usd, 10% of usd), which still admits.
    expect(l.admit({ callPath: "D#0", stepKey: "d" }).sliceUsd).toBe(1);
    expect(() => l.admit({ callPath: "E#0", stepKey: "e" })).toThrow(/budget/);
  });

  it("refuses a slice smaller than minAgentUsd", () => {
    const { l, events } = ledger({ usd: 10, minAgentUsd: 3, perAgent: { usd: 8 } });
    l.admit({ callPath: "A#0", stepKey: "a" });
    expect(() => l.admit({ callPath: "B#0", stepKey: "b" })).toThrow(BudgetExceededError);
    expect(events.find((e) => e.type === "budget.exceeded")?.data).toMatchObject({ phase: "admission", reason: "usd" });
  });

  it("returns the unused part of a slice when the attempt ends", async () => {
    const { l } = ledger({ usd: 10, perAgent: { usd: 6 } });
    const a = l.admit({ callPath: "A#0", stepKey: "a" });
    await a.charge({ launchId: "a_e0_l0", turn: 0, usd: 1, final: true });
    expect(l.unreserved()).toBe(4);
    a.release();
    expect(l.unreserved()).toBe(9);
    expect(l.inFlight()).toBe(0);
  });

  it("has no USD cap without a USD budget, but still honours per-call caps", () => {
    const { l } = ledger(undefined);
    expect(l.admit({ callPath: "A#0", stepKey: "a" }).sliceUsd).toBeNull();
    expect(l.admit({ callPath: "B#0", stepKey: "b", usd: 2 }).sliceUsd).toBe(2);
    expect(l.unreserved()).toBe(Number.POSITIVE_INFINITY);
  });

  it("refuses admission once the token budget or the wall clock is spent", async () => {
    const tokens = ledger({ tokens: 100 });
    const r = tokens.l.admit({ callPath: "A#0", stepKey: "a" });
    await r.charge({ launchId: "l", turn: 0, tokens: 100 });
    expect(() => tokens.l.admit({ callPath: "B#0", stepKey: "b" })).toThrow(BudgetExceededError);

    const clock = ledger({ wallClock: "1m" });
    clock.tick(30_000);
    clock.l.pauseClock();
    clock.tick(10 * 60_000);
    clock.l.resumeClock();
    expect(clock.l.remainingWallClockMs()).toBe(30_000);
    clock.l.admit({ callPath: "A#0", stepKey: "a" });
    clock.tick(30_000);
    expect(() => clock.l.admit({ callPath: "B#0", stepKey: "b" })).toThrow(BudgetExceededError);
  });

  it("requires a price for token-metered models unless unmetered use is allowed", () => {
    const strict = ledger({ usd: 10 });
    expect(() => strict.l.admit({ callPath: "A#0", stepKey: "a", model: "mystery-1", tokenMetered: true })).toThrow(
      UnknownModelPriceError,
    );
    strict.l.admit({ callPath: "A#0", stepKey: "a", model: "gpt-5-codex", tokenMetered: true });
    const custom = ledger({ usd: 10, prices: { "mystery-1": { inputPerMTok: 1, outputPerMTok: 2 } } });
    custom.l.admit({ callPath: "A#0", stepKey: "a", model: "mystery-1", tokenMetered: true });
    expect(custom.l.priceUsage("mystery-1", { inputTokens: 1_000_000, outputTokens: 500_000 })).toBe(2);
    const loose = ledger({ usd: 10, allowUnmetered: true });
    loose.l.admit({ callPath: "A#0", stepKey: "a", model: "mystery-1", tokenMetered: true });
    expect(loose.events.some((e) => e.type === "budget.warning" && e.data?.reason === "unmetered")).toBe(true);
    expect(loose.l.priceUsage("mystery-1", { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});

describe("BudgetLedger charges", () => {
  it("charges the max cumulative value per turn and sums turns", async () => {
    const { l } = ledger({ usd: 100 });
    const r = l.admit({ callPath: "A#0", stepKey: "a" });
    await r.charge({ launchId: "a_l0", turn: 0, usd: 1 });
    await r.charge({ launchId: "a_l0", turn: 0, usd: 2.5 });
    await r.charge({ launchId: "a_l0", turn: 0, usd: 2 }); // a resent, older event never lowers it
    await r.charge({ launchId: "a_l0", turn: 1, usd: 0.5 }); // counters reset per harness process
    expect(r.spentUsd).toBe(3);
    expect(l.charged().usd).toBe(3);
  });

  it("reports when an agent crosses its slice and marks the run exhausted", async () => {
    const { l, events } = ledger({ usd: 10, perAgent: { usd: 1 } });
    const r = l.admit({ callPath: "A#0", stepKey: "a" });
    expect(await r.charge({ launchId: "l", turn: 0, usd: 0.9 })).toEqual({ exceeded: false });
    expect(r.remainingUsd()).toBeCloseTo(0.1);
    expect(await r.charge({ launchId: "l", turn: 0, usd: 1.2 })).toEqual({ exceeded: true });
    expect(() => r.throwIfExceeded()).toThrow(BudgetExceededError);
    expect(l.exhausted).toBe(true);
    expect(events.filter((e) => e.type === "budget.exceeded")).toHaveLength(1);
  });

  it("warns once at 80% of the run budget", async () => {
    const { l, events } = ledger({ usd: 10 });
    const r = l.admit({ callPath: "A#0", stepKey: "a", usd: 10 });
    await r.charge({ launchId: "l", turn: 0, usd: 8 });
    await r.charge({ launchId: "l", turn: 0, usd: 9 });
    expect(events.filter((e) => e.type === "budget.warning" && e.data?.reason === "80%")).toHaveLength(1);
  });

  it("persists at turn end and at most every 30 s in between", async () => {
    const { l, persisted, tick } = ledger({ usd: 10 });
    const r = l.admit({ callPath: "A#0", stepKey: "a", attempt: 2 });
    await r.charge({ launchId: "l", turn: 0, usd: 0.1 });
    await r.charge({ launchId: "l", turn: 0, usd: 0.2 });
    tick(31_000);
    await r.charge({ launchId: "l", turn: 0, usd: 0.3 });
    await r.charge({ launchId: "l", turn: 0, usd: 0.4, final: true });
    expect(persisted.map((p) => p.usd)).toEqual([0.1, 0.3, 0.4]);
    expect(persisted[0]).toMatchObject({ stepKey: "a", callPath: "A#0", launchId: "l", turn: 0, attempt: 2 });
  });

  it("restores spend from the journal, excluding attempts that completed before", () => {
    const { l } = ledger({ usd: 10 });
    const at = new Date(0).toISOString();
    const base = { runId: "r", attempt: 1, startedAt: at };
    const entries: JournalEntry[] = [
      { ...base, stepKey: "done", callPath: "A#0", kind: "agent", status: "ok", launchId: "done_e0_l0" },
      { ...base, stepKey: "x", callPath: "B#0", kind: "agent", status: "started", launchId: "x_e0_l0" },
      {
        ...base,
        stepKey: "done_e0_l0_t0",
        callPath: "A#0",
        kind: "charge",
        status: "ok",
        launchId: "done_e0_l0",
        charge: { usd: 2, tokens: 10, turn: 0, cumulative: true },
      },
      {
        ...base,
        stepKey: "x_e0_l0_t0",
        callPath: "B#0",
        kind: "charge",
        status: "ok",
        launchId: "x_e0_l0",
        charge: { usd: 1.5, tokens: 5, turn: 0, cumulative: true },
      },
    ];
    l.restore(entries);
    expect(l.charged()).toEqual({ usd: 1.5, tokens: 5 });
    l.noteReplayed(2);
    expect(l.charged().usd).toBe(3.5);
    expect(l.replayedUsd).toBe(2);
  });
});

describe("prices", () => {
  it("finds models with provider prefixes and dated suffixes", () => {
    expect(findPrice("openai/gpt-5")).toBeDefined();
    expect(findPrice("gpt-5-2025-08-07")).toBeDefined();
    expect(findPrice("nope")).toBeUndefined();
  });

  it("prices cached input at the cached rate", () => {
    const price = { inputPerMTok: 2, cachedInputPerMTok: 0.5, outputPerMTok: 8 };
    expect(priceTokens(price, { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 })).toBe(1.25);
  });
});

describe("SandboxSlots", () => {
  it("defaults to min(4, provider maxConcurrent)", () => {
    expect(defaultSandboxCap(undefined, undefined)).toBe(4);
    expect(defaultSandboxCap(undefined, 2)).toBe(2);
    expect(defaultSandboxCap(undefined, 50)).toBe(4);
    expect(defaultSandboxCap(9, 2)).toBe(9);
  });

  it("caps live sandboxes and serves waiters by depth, then index", async () => {
    const slots = new SandboxSlots(1);
    const [held] = await slots.acquire("first");
    const order: string[] = [];
    const requests: [string, { depth: number; index: number }][] = [
      ["stage0-item1", { depth: 0, index: 1 }],
      ["stage2-item5", { depth: 2, index: 5 }],
      ["stage2-item0", { depth: 2, index: 0 }],
    ];
    const waits = requests.map(([name, priority]) =>
      slots.acquire(name, priority).then(([slot]) => {
        order.push(name);
        slot?.release();
      }),
    );
    expect(slots.waiting).toBe(3);
    held?.release();
    await Promise.all(waits);
    expect(order).toEqual(["stage2-item0", "stage2-item5", "stage0-item1"]);
    slots.close();
  });

  it("takes n slots atomically and refuses n above the cap at once", async () => {
    const slots = new SandboxSlots(3);
    const [one] = await slots.acquire("single");
    let forked = false;
    const fork = slots.acquire("fork", undefined, 3).then((s) => {
      forked = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(forked).toBe(false);
    expect(slots.inUse).toBe(1);
    one?.release();
    const all = await fork;
    expect(all).toHaveLength(3);
    expect(slots.inUse).toBe(3);
    expect(() => slots.acquire("too-many", undefined, 4)).toThrow(ConfigError);
    for (const s of all) s.release();
    slots.close();
  });

  it("rejects a waiter whose signal aborts", async () => {
    const slots = new SandboxSlots(1);
    await slots.acquire("holder");
    const controller = new AbortController();
    const waiting = slots.acquire("waiter", undefined, 1, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(slots.waiting).toBe(0);
    slots.close();
  });

  it("parks an idle shared handle to break a deadlock", async () => {
    const slots = new SandboxSlots(2, { deadlockAfterMs: 5 });
    const [a] = await slots.acquire("branch-a/sandbox#0");
    const [b] = await slots.acquire("branch-b/sandbox#0");
    a?.setBusy(false);
    b?.setBusy(false);
    let parked = 0;
    a?.setParker(async () => {
      parked++;
      a.release();
      return true;
    });
    const [reviewer] = await slots.acquire("branch-a/CodeReview#0");
    expect(parked).toBe(1);
    expect(reviewer?.callPath).toBe("branch-a/CodeReview#0");
    slots.close();
  });

  it("reports SandboxCapDeadlockError naming holders and waiters when nothing can park", async () => {
    const slots = new SandboxSlots(2, { deadlockAfterMs: 5 });
    const [a] = await slots.acquire("parallel#0/[0]/sandbox#0");
    const [b] = await slots.acquire("parallel#0/[1]/sandbox#0");
    a?.setBusy(false);
    b?.setBusy(false);
    const error = await slots.acquire("parallel#0/[0]/CodeReview#0").catch((e) => e);
    expect(error).toBeInstanceOf(SandboxCapDeadlockError);
    expect(error.holders).toEqual(["parallel#0/[0]/sandbox#0", "parallel#0/[1]/sandbox#0"]);
    expect(error.waiters).toEqual(["parallel#0/[0]/CodeReview#0"]);
    slots.close();
  });

  it("does not report a deadlock while a holder is busy", async () => {
    const slots = new SandboxSlots(1, { deadlockAfterMs: 5 });
    const [a] = await slots.acquire("busy");
    const waiting = slots.acquire("waiter");
    await new Promise((r) => setTimeout(r, 30));
    a?.release();
    expect(await waiting).toHaveLength(1);
    slots.close();
  });
});

describe("CreateRateLimiter", () => {
  it("allows perMinute creates per 60 s window, in order", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new CreateRateLimiter(2, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await limiter.take();
    now += 1_000;
    await limiter.take();
    await limiter.take();
    expect(sleeps).toEqual([59_000]);
    expect(now).toBe(60_000);
  });

  it("lets concurrency.createsPerMinute only lower the provider limit", () => {
    expect(effectiveCreatesPerMinute(undefined, undefined)).toBe(10);
    expect(effectiveCreatesPerMinute(5, 20)).toBe(5);
    expect(effectiveCreatesPerMinute(50, 20)).toBe(20);
    expect(effectiveCreatesPerMinute(undefined, 30)).toBe(30);
  });

  it("backs off with full jitter under a cap", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const ms = createBackoffMs(attempt, { baseMs: 100, capMs: 1_000 });
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(Math.min(1_000, 100 * 2 ** attempt));
    }
  });
});
