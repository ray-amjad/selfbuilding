import { describe, expect, it } from "vitest";
import { createLocalTrigger } from "./local.js";

describe("createLocalTrigger", () => {
  it("returns the same run for the same idempotency key", async () => {
    const t = createLocalTrigger();
    t.task({ id: "echo", run: async (p: { n: number }) => p.n * 2 });
    const a = await t.start("echo", { n: 2 }, { idempotencyKey: "k" });
    const b = await t.start("echo", { n: 9 }, { idempotencyKey: "k" });
    expect(b.id).toBe(a.id);
    await t.settle();
    expect(t.run(a.id)).toMatchObject({ status: "COMPLETED", output: 4 });
  });

  it("retries a throwing task up to maxAttempts, then fails", async () => {
    const t = createLocalTrigger({ maxAttempts: 3 });
    let calls = 0;
    t.task({
      id: "flaky",
      run: async () => {
        calls += 1;
        if (calls < 3) throw new Error("boom");
        return "ok";
      },
    });
    t.task({
      id: "broken",
      run: async () => {
        throw new Error("always");
      },
    });
    const ok = await t.start("flaky", null);
    const bad = await t.start("broken", null);
    await t.settle();
    expect(t.run(ok.id)).toMatchObject({ status: "COMPLETED", output: "ok", attempts: 3 });
    expect(t.run(bad.id)).toMatchObject({ status: "FAILED", error: { message: "always" } });
  });

  it("waits on a token until completed; a completed token returns at once", async () => {
    const t = createLocalTrigger();
    t.task({
      id: "waiter",
      run: async () => {
        const token = await t.createToken({ idempotencyKey: "tok", timeoutMs: 60_000 });
        const first = await t.forToken<{ v: number }>(token.id);
        const again = await t.forToken<{ v: number }>(token.id);
        return { first, again };
      },
    });
    const run = await t.start("waiter", null);
    await t.settle();
    expect(t.run(run.id).status).toBe("WAITING");
    const token = t.tokens()[0];
    expect(token?.idempotencyKey).toBe("tok");
    expect(await t.postToTokenUrl(token?.url ?? "", { v: 7 })).toBe(true);
    await t.settle();
    expect(t.run(run.id).output).toEqual({
      first: { ok: true, output: { v: 7 } },
      again: { ok: true, output: { v: 7 } },
    });
  });

  it("times a token out only when the virtual clock passes it", async () => {
    const t = createLocalTrigger();
    t.task({
      id: "timeout",
      run: async () => {
        const token = await t.createToken({ idempotencyKey: "tok", timeoutMs: 60_000 });
        const r = await t.forToken(token.id);
        return r.ok;
      },
    });
    const run = await t.start("timeout", null);
    await t.settle();
    await t.advance(59_000);
    await t.settle();
    expect(t.run(run.id).status).toBe("WAITING");
    await t.advance(1_000);
    await t.settle();
    expect(t.run(run.id)).toMatchObject({ status: "COMPLETED", output: false });
  });

  it("rejects a second concurrent wait in one run", async () => {
    const t = createLocalTrigger({ maxAttempts: 1 });
    t.task({
      id: "two-waits",
      run: async () => {
        const a = await t.createToken({ idempotencyKey: "a", timeoutMs: 1000 });
        const b = await t.createToken({ idempotencyKey: "b", timeoutMs: 1000 });
        await Promise.all([t.forToken(a.id), t.forToken(b.id)]);
      },
    });
    const run = await t.start("two-waits", null);
    await t.settle();
    expect(t.run(run.id)).toMatchObject({ status: "FAILED" });
    expect(t.run(run.id).error?.message).toMatch(/one wait per run/);
  });

  it("buffers wakes sent before the wait and delivers them in order", async () => {
    const t = createLocalTrigger();
    t.task({
      id: "listener",
      run: async () => {
        const token = await t.createToken({ idempotencyKey: "gate", timeoutMs: 60_000 });
        await t.forToken(token.id);
        const a = await t.waitWake({ timeoutMs: 1000 });
        const b = await t.waitWake({ timeoutMs: 1000 });
        return [a, b];
      },
    });
    const run = await t.start("listener", null);
    await t.settle();
    await t.sendWake(run.id, { kind: "tick" });
    await t.sendWake(run.id, { kind: "ask", askId: "ask_1" });
    await t.completeToken(t.tokens()[0]?.id ?? "", null);
    await t.settle();
    expect(t.run(run.id).output).toEqual([
      { ok: true, output: { kind: "tick" } },
      { ok: true, output: { kind: "ask", askId: "ask_1" } },
    ]);
  });

  it("a crash kills every attempt; restart runs unfinished runs from the top, server state intact", async () => {
    const t = createLocalTrigger();
    const starts: number[] = [];
    let sideEffects = 0;
    t.task({
      id: "durable",
      run: async (_p, { ctx }) => {
        starts.push(ctx.attempt?.number ?? 0);
        const token = await t.createToken({ idempotencyKey: "same", timeoutMs: 60_000 });
        const r = await t.forToken<string>(token.id);
        sideEffects += 1;
        return r.ok ? r.output : null;
      },
    });
    const run = await t.start("durable", null);
    await t.settle();
    t.crash();
    await t.completeToken(t.tokens()[0]?.id ?? "", "answer");
    await t.settle();
    expect(sideEffects).toBe(0);
    expect(t.run(run.id).status).not.toBe("COMPLETED");
    t.restart();
    await t.settle();
    expect(starts).toEqual([1, 2]);
    expect(t.tokens()).toHaveLength(1);
    expect(t.run(run.id)).toMatchObject({ status: "COMPLETED", output: "answer" });
    expect(sideEffects).toBe(1);
  });

  it("cancels a run and calls its onCancel hook", async () => {
    const t = createLocalTrigger();
    const cancelled: string[] = [];
    t.task({
      id: "long",
      run: async () => {
        const token = await t.createToken({ idempotencyKey: "never", timeoutMs: 60_000 });
        await t.forToken(token.id);
        return "done";
      },
      onCancel: async ({ ctx }) => {
        cancelled.push(ctx.run.id);
      },
    });
    const run = await t.start("long", null);
    await t.settle();
    await t.cancelRun(run.id);
    await t.completeToken(t.tokens()[0]?.id ?? "", null);
    await t.settle();
    expect(t.run(run.id).status).toBe("CANCELED");
    expect(cancelled).toEqual([run.id]);
  });

  it("runs a scheduled task on demand and reports its cron", async () => {
    const t = createLocalTrigger();
    t.scheduleTask({ id: "sweep", cron: "*/2 * * * *", run: async ({ timestamp }) => timestamp.toISOString() });
    expect(t.schedules()).toEqual([{ id: "sweep", cron: "*/2 * * * *" }]);
    const run = await t.fireSchedule("sweep");
    await t.settle();
    expect(t.run(run.id)).toMatchObject({ status: "COMPLETED", output: "2026-01-01T00:00:00.000Z" });
  });
});
