import { type AskRecord, type JournalEntry, LeaseLostError } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { isSuccessEntry, resultStoreAsks, resultStoreJournal, StepMemo } from "./journal.js";
import { storeKeys } from "./keys.js";
import { memoryResultStore } from "./store.js";

const now = () => Date.parse("2026-01-01T00:00:00Z");

function entry(over: Partial<JournalEntry>): JournalEntry {
  return {
    runId: "ns_r",
    stepKey: "k1",
    callPath: "A#0",
    kind: "step",
    status: "ok",
    launchId: "",
    value: 1,
    attempt: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("StepMemo", () => {
  it("serves a value inside the epoch and successes across epochs", async () => {
    const store = memoryResultStore();
    const e0 = new StepMemo(store, "ns_r", 0, now);
    expect(await e0.read("s")).toBeNull();
    expect(await e0.write("s", { sha: "abc" })).toEqual({ sha: "abc" });
    expect(await e0.read("s")).toEqual({ value: { sha: "abc" } });
    const e1 = new StepMemo(store, "ns_r", 1, now);
    expect(await e1.read("s")).toEqual({ value: { sha: "abc" } });
  });

  it("first write wins when two attempts race", async () => {
    const memo = new StepMemo(memoryResultStore(), "ns_r", 0, now);
    const [a, b] = await Promise.all([memo.write("s", "first"), memo.write("s", "second")]);
    expect(a).toBe(b);
  });

  it("serves a failed agent outcome inside its epoch only (failures are never cached across a resume)", async () => {
    const store = memoryResultStore();
    const failed = { ok: false, error: { code: "interrupted" } };
    await new StepMemo(store, "ns_r", 0, now).write("agent1", failed, { kind: "agent", callPath: "A#0" });
    expect(await new StepMemo(store, "ns_r", 0, now).read("agent1")).toEqual({ value: failed });
    expect(await new StepMemo(store, "ns_r", 1, now).read("agent1")).toBeNull();
    expect(await store.get(storeKeys.cache("ns_r", "agent1"))).toBeNull();
  });

  it("caches a successful agent outcome for later epochs", async () => {
    const store = memoryResultStore();
    await new StepMemo(store, "ns_r", 0, now).write("agent1", { ok: true, result: 3 }, { kind: "agent" });
    expect(await new StepMemo(store, "ns_r", 2, now).read("agent1")).toEqual({ value: { ok: true, result: 3 } });
  });
});

describe("isSuccessEntry", () => {
  it("treats ok agent values as successes and { ok: false } as failures", () => {
    expect(isSuccessEntry({ status: "ok", kind: "agent", value: { ok: true } })).toBe(true);
    expect(isSuccessEntry({ status: "ok", kind: "agent", value: { ok: false } })).toBe(false);
    expect(isSuccessEntry({ status: "ok", kind: "step", value: { ok: false } })).toBe(true);
    expect(isSuccessEntry({ status: "failed", kind: "step", value: 1 })).toBe(false);
  });
});

describe("resultStoreJournal", () => {
  it("reads the records the host step memo writes (one durability system)", async () => {
    const store = memoryResultStore();
    await new StepMemo(store, "ns_r", 0, now).write("k1", 42, { callPath: "step#0" });
    const journal = resultStoreJournal(store, { now });
    expect((await journal.get("ns_r", "k1"))?.value).toBe(42);
    const listed: JournalEntry[] = [];
    for await (const e of journal.list("ns_r")) listed.push(e);
    expect(listed.map((e) => e.stepKey)).toEqual(["k1"]);
  });

  it("follows the run's epoch from the run record", async () => {
    const store = memoryResultStore();
    await new StepMemo(store, "ns_r", 0, now).write("bad", { ok: false }, { kind: "agent" });
    await new StepMemo(store, "ns_r", 0, now).write("good", { ok: true }, { kind: "agent" });
    const journal = resultStoreJournal(store, { now });
    expect(await journal.get("ns_r", "bad")).not.toBeNull();
    await store.createIfAbsent(storeKeys.run("ns_r"), {
      epoch: 1,
      hostRunIds: ["a", "b"],
      status: "running",
      factory: "f",
      updatedAt: "x",
    });
    expect(await journal.get("ns_r", "bad")).toBeNull();
    expect((await journal.get("ns_r", "good"))?.value).toEqual({ ok: true });
  });

  it("fences puts by the lease and honours expectStatus", async () => {
    const journal = resultStoreJournal(memoryResultStore(), { now });
    const lease = await journal.lease("ns_r", "host-a", "5m");
    expect(lease?.leaseEpoch).toBe(1);
    if (!lease) throw new Error("no lease");
    expect(await journal.lease("ns_r", "host-b", "5m")).toBeNull();
    expect(await journal.put(entry({ status: "started" }), { lease, expectStatus: null })).toBe(true);
    expect(await journal.put(entry({ status: "started" }), { lease, expectStatus: null })).toBe(false);
    expect(await journal.put(entry({ status: "ok" }), { lease, expectStatus: "failed" })).toBe(false);
    expect(await journal.put(entry({ status: "ok", value: 7 }), { lease, expectStatus: "started" })).toBe(true);
    expect((await journal.get("ns_r", "k1"))?.value).toBe(7);
    expect(await journal.renew(lease)).not.toBeNull();
  });

  it("a takeover after expiry makes the old holder lose its lease", async () => {
    let t = now();
    const journal = resultStoreJournal(memoryResultStore(), { now: () => t });
    const old = await journal.lease("ns_r", "laptop", "1m");
    if (!old) throw new Error("no lease");
    t += 120_000;
    const fresh = await journal.lease("ns_r", "server", "1m");
    expect(fresh?.leaseEpoch).toBe(2);
    await expect(journal.assertLease(old)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(journal.put(entry({}), { lease: old })).rejects.toBeInstanceOf(LeaseLostError);
    expect(await journal.renew(old)).toBeNull();
  });
});

function askRecord(askId: string, over: Partial<AskRecord> = {}): AskRecord {
  return {
    askId,
    runId: "ns_r",
    ordinal: 1,
    callPath: "ask#0",
    origin: { kind: "factory", askSeq: 0 },
    specHash: "h",
    spec: { question: "Ship it?" },
    status: "open",
    waitpoint: { host: "trigger", ref: "" },
    messages: [{ channel: "slack", thread: { channel: "slack", id: "C1:1" }, id: "m1" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T04:00:00.000Z",
    ...over,
  };
}

describe("resultStoreAsks", () => {
  it("creates once, resolves once (first answer wins) and filters open asks", async () => {
    const asks = resultStoreAsks(memoryResultStore());
    expect(await asks.create(askRecord("ask_1"))).toEqual({ status: "created" });
    expect((await asks.create(askRecord("ask_1", { ordinal: 9 }))).status).toBe("exists");
    await asks.create(askRecord("ask_2", { runId: "ns_other" }));
    const open: string[] = [];
    for await (const r of asks.open({ runId: "ns_r" })) open.push(r.askId);
    expect(open).toEqual(["ask_1"]);
    expect((await asks.openForThread({ channel: "slack", id: "C1:1" })).map((r) => r.askId)).toEqual([
      "ask_1",
      "ask_2",
    ]);

    const res = {
      askId: "ask_1",
      answer: { kind: "choice" as const, choiceId: "yes" },
      choiceId: "yes",
      answeredBy: { kind: "human" as const, channel: "slack" as const, userId: "U1", displayName: "a" },
      answeredAt: "t",
    };
    const [a, b] = await Promise.all([asks.resolve("ask_1", res), asks.resolve("ask_1", { ...res, choiceId: "no" })]);
    expect([a.won, b.won].filter(Boolean)).toHaveLength(1);
    expect((await asks.get("ask_1"))?.status).toBe("answered");

    await asks.setStatus("ask_2", "cancelled");
    expect((await asks.get("ask_2"))?.status).toBe("cancelled");
  });
});
