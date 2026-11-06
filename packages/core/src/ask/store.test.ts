import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AskRecord, AskResolution, AskStore } from "../types/ask.js";
import { fileAskStore, memoryAskStore } from "./store.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sb-askstore-"));
  dirs.push(d);
  return d;
}

function record(askId: string, over: Partial<AskRecord> = {}): AskRecord {
  return {
    askId,
    runId: "run-1",
    ordinal: 1,
    callPath: "root",
    origin: { kind: "factory", askSeq: 0 },
    specHash: "h",
    spec: { question: "Ship?", choices: ["yes", "no"] },
    status: "open",
    waitpoint: { host: "node", ref: askId },
    messages: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-11-01T04:00:00.000Z",
    ...over,
  };
}

function resolution(askId: string, choiceId: string): AskResolution {
  return {
    askId,
    answer: { kind: "choice", choiceId },
    choiceId,
    answeredBy: { kind: "human", channel: "slack", userId: "user-1", displayName: "user-1" },
    answeredAt: "2026-11-01T00:01:00.000Z",
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const thread = { channel: "slack", id: "C1:1.0" };
const msg = (id: string) => ({ channel: "slack", thread, id });

describe.each([
  ["memoryAskStore", async () => memoryAskStore() as AskStore],
  ["fileAskStore", async () => fileAskStore(await tempDir())],
])("%s", (_name, make) => {
  it("creates once and returns the existing record after", async () => {
    const s = await make();
    expect(await s.create(record("ask_a"))).toEqual({ status: "created" });
    const again = await s.create(record("ask_a", { specHash: "other" }));
    expect(again.status).toBe("exists");
    expect(again.status === "exists" && again.record.specHash).toBe("h");
    expect(await s.get("ask_missing")).toBeNull();
  });

  it("lets exactly one of many concurrent answers win", async () => {
    const s = await make();
    await s.create(record("ask_race"));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => s.resolve("ask_race", resolution("ask_race", i % 2 ? "yes" : "no"))),
    );
    expect(results.filter((r) => r.won)).toHaveLength(1);
    const winner = (await s.get("ask_race")) as AskRecord;
    expect(winner.status).toBe("answered");
    for (const r of results) if (!r.won) expect(r.current.resolution).toEqual(winner.resolution);
  });

  it("finds open asks by thread, run and channel", async () => {
    const s = await make();
    await s.create(record("ask_one", { messages: [msg("m1")] }));
    await s.create(record("ask_two", { runId: "run-2", ordinal: 1 }));
    await s.create(record("ask_three", { ordinal: 2 }));
    await s.patch?.("ask_three", { messages: [msg("m3")] });
    expect((await s.openForThread(thread)).map((r) => r.askId).sort()).toEqual(["ask_one", "ask_three"]);
    expect((await collect(s.open({ runId: "run-1" }))).map((r) => r.askId).sort()).toEqual(["ask_one", "ask_three"]);
    expect((await collect(s.open({ channel: "slack" }))).map((r) => r.askId).sort()).toEqual(["ask_one", "ask_three"]);
    await s.resolve("ask_one", resolution("ask_one", "yes"));
    expect((await s.openForThread(thread)).map((r) => r.askId)).toEqual(["ask_three"]);
    if (!s.list) throw new Error("both stores implement list()");
    expect((await collect(s.list({ runId: "run-1" }))).length).toBe(2);
  });

  it("never lets setStatus overwrite an answer", async () => {
    const s = await make();
    await s.create(record("ask_done"));
    await s.resolve("ask_done", resolution("ask_done", "yes"));
    await s.setStatus("ask_done", "expired");
    expect((await s.get("ask_done"))?.status).toBe("answered");
    await s.create(record("ask_gone"));
    await s.setStatus("ask_gone", "cancelled");
    expect((await s.get("ask_gone"))?.status).toBe("cancelled");
    expect((await s.resolve("ask_gone", resolution("ask_gone", "yes"))).won).toBe(false);
  });

  it("patches messages without duplicates and records reconciledAt", async () => {
    const s = await make();
    await s.create(record("ask_p", { messages: [msg("m1")] }));
    await s.patch?.("ask_p", { messages: [msg("m1"), msg("m2")], reconciledAt: "2026-11-01T01:00:00.000Z" });
    const r = await s.get("ask_p");
    expect(r?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(r?.reconciledAt).toBe("2026-11-01T01:00:00.000Z");
  });

  it("marks an open ask cold by compare-and-set, keeps it through an answer, and never marks a settled one", async () => {
    const s = await make();
    if (!s.markCold) throw new Error("both stores implement markCold()");
    const cold = { since: "2026-11-01T00:10:00.000Z", sessionId: "sess_1", launch: 1 };
    await s.create(record("ask_cold"));
    expect((await s.markCold("ask_cold", cold))?.cold).toEqual(cold);
    await s.resolve("ask_cold", resolution("ask_cold", "yes"));
    expect(await s.get("ask_cold")).toMatchObject({ status: "answered", cold, resolution: { choiceId: "yes" } });

    await s.create(record("ask_late"));
    await s.resolve("ask_late", resolution("ask_late", "no"));
    const after = await s.markCold("ask_late", cold);
    expect(after?.status).toBe("answered");
    expect(after?.cold).toBeUndefined();
    expect(await s.markCold("ask_nope", cold)).toBeNull();
  });
});

describe("fileAskStore across processes", () => {
  it("shares state between two store instances on one directory", async () => {
    const dir = await tempDir();
    const a = fileAskStore(dir);
    const b = fileAskStore(dir);
    await a.create(record("ask_shared"));
    expect((await b.create(record("ask_shared"))).status).toBe("exists");
    const [ra, rb] = await Promise.all([
      a.resolve("ask_shared", resolution("ask_shared", "yes")),
      b.resolve("ask_shared", resolution("ask_shared", "no")),
    ]);
    expect([ra.won, rb.won].filter(Boolean)).toHaveLength(1);
    expect((await readdir(dir)).sort()).toEqual(["ask_shared.json"]);
  });

  it("keeps an answer written while no run process exists, for the next process to read", async () => {
    const dir = await tempDir();
    const host = fileAskStore(dir);
    await host.create(record("ask_parked"));
    await host.markCold?.("ask_parked", { since: "2026-11-01T00:10:00.000Z", sessionId: "sess_9" });
    // The host process is gone; a webhook handler with its own store instance answers.
    expect((await fileAskStore(dir).resolve("ask_parked", resolution("ask_parked", "no"))).won).toBe(true);
    const restarted = fileAskStore(dir);
    expect(await restarted.get("ask_parked")).toMatchObject({
      status: "answered",
      cold: { sessionId: "sess_9" },
      resolution: { choiceId: "no" },
    });
  });

  it("refuses ids that could escape its directory", async () => {
    const s = fileAskStore(await tempDir());
    await expect(s.get("../etc/passwd")).rejects.toThrow(/invalid ask id/);
    await expect(s.create(record("ask_../x"))).rejects.toThrow(/invalid ask id/);
  });
});
