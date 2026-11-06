import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactError, JournalVersionError, LeaseLostError } from "../errors/classes.js";
import type { AskRecord } from "../types/ask.js";
import type { JournalEntry, JournalStore, Lease } from "../types/orchestration.js";
import { fileArtifacts, fileJournal } from "./index.js";
import { memoryJournal } from "./memory.js";
import { sqliteJournal } from "./sqlite-journal.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-journal-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(stepKey: string, status: JournalEntry["status"], extra: Partial<JournalEntry> = {}): JournalEntry {
  return {
    runId: "r1",
    stepKey,
    callPath: `A#${stepKey}`,
    kind: "step",
    status,
    launchId: `${stepKey}_e0_l0`,
    attempt: 1,
    startedAt: new Date(1_000 + Number(stepKey.replace(/\D/g, "") || 0)).toISOString(),
    ...extra,
  };
}

const stores: [string, () => JournalStore][] = [
  ["fileJournal", () => fileJournal(join(dir, "j"))],
  ["memoryJournal", () => memoryJournal()],
  ["sqliteJournal", () => sqliteJournal(join(dir, "j.db"))],
];

// The stores that persist: a second instance on the same path is another process.
const onDisk: [string, () => JournalStore][] = [
  ["fileJournal", () => fileJournal(join(dir, "j"))],
  ["sqliteJournal", () => sqliteJournal(join(dir, "j.db"))],
];

describe.each(stores)("%s", (_name, make) => {
  it("issues a lease per run and refuses a second owner while it is live", async () => {
    const store = make();
    const a = (await store.lease("r1", "a", "1m")) as Lease;
    expect(a).toMatchObject({ owner: "a", leaseEpoch: 1, runId: "r1" });
    expect(await store.lease("r1", "b", "1m")).toBeNull();
    expect(await store.lease("r2", "b", "1m")).toMatchObject({ leaseEpoch: 1 });
    // The same owner keeps its epoch.
    expect((await store.lease("r1", "a", "1m"))?.leaseEpoch).toBe(1);
  });

  it("fences writes by lease epoch after a takeover", async () => {
    const store = make();
    const a = (await store.lease("r1", "a", 1)) as Lease;
    await new Promise((r) => setTimeout(r, 10));
    const b = (await store.lease("r1", "b", "1m")) as Lease;
    expect(b.leaseEpoch).toBe(2);
    await expect(store.assertLease(a)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.put(entry("k1", "started"), { lease: a })).rejects.toBeInstanceOf(LeaseLostError);
    expect(await store.renew(a)).toBeNull();
    await store.assertLease(b);
    expect(await store.put(entry("k1", "started"), { lease: b })).toBe(true);
    const renewed = (await store.renew(b)) as Lease;
    expect(renewed.leaseEpoch).toBe(2);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual(Date.parse(b.expiresAt));
  });

  it("puts with compare-and-set on status", async () => {
    const store = make();
    const lease = (await store.lease("r1", "a", "1m")) as Lease;
    expect(await store.put(entry("k1", "started"), { lease, expectStatus: null })).toBe(true);
    expect(await store.put(entry("k1", "started"), { lease, expectStatus: null })).toBe(false);
    expect(await store.put(entry("k1", "ok", { value: { x: 1 } }), { lease, expectStatus: "failed" })).toBe(false);
    expect(await store.put(entry("k1", "ok", { value: { x: 1 } }), { lease, expectStatus: "started" })).toBe(true);
    expect(await store.get("r1", "k1")).toMatchObject({ status: "ok", value: { x: 1 } });
    expect(await store.get("r1", "missing")).toBeNull();
    expect(await store.put(entry("k2", "ok"), { lease })).toBe(true);
    const listed: string[] = [];
    for await (const e of store.list("r1")) listed.push(e.stepKey);
    expect(listed).toEqual(["k1", "k2"]);
  });

  it("releases a lease so the next process can start at once", async () => {
    const store = make();
    const a = (await store.lease("r1", "a", "1h")) as Lease;
    await store.release?.(a);
    const b = (await store.lease("r1", "b", "1h")) as Lease;
    expect(b.leaseEpoch).toBe(2);
    await expect(store.assertLease(a)).rejects.toBeInstanceOf(LeaseLostError);
  });
});

describe.each(onDisk)("%s on disk", (_name, make) => {
  it("survives a new store instance (another process) and serialises concurrent puts", async () => {
    const first = make();
    const lease = (await first.lease("r1", "a", "1m")) as Lease;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => first.put(entry("race", "started"), { lease, expectStatus: null })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const second = make();
    expect(await second.get("r1", "race")).toMatchObject({ status: "started" });
    await expect(second.assertLease(lease)).resolves.toBeUndefined();
    expect(await second.lease("r1", "b", "1m")).toBeNull();
  });

  it("keeps any step key, however odd, and lists in start order", async () => {
    const store = make();
    const lease = (await store.lease("r1", "a", "1m")) as Lease;
    await store.put(entry("k9", "ok"), { lease });
    await store.put(entry("../../escape", "ok", { startedAt: new Date(0).toISOString() }), { lease });
    await store.put(entry("k2", "ok"), { lease });
    expect(await store.get("r1", "../../escape")).toMatchObject({ stepKey: "../../escape" });
    const listed: string[] = [];
    for await (const e of make().list("r1")) listed.push(e.stepKey);
    expect(listed).toEqual(["../../escape", "k2", "k9"]);
  });
});

describe("fileJournal on disk", () => {
  it("rejects a journal written in another format", async () => {
    const store = fileJournal(join(dir, "j"));
    await store.lease("r1", "a", "1m");
    await writeFile(join(dir, "j", "runs", "r1", "format.json"), JSON.stringify({ format: 99 }));
    await expect(store.get("r1", "x")).rejects.toBeInstanceOf(JournalVersionError);
  });

  it("keeps file names inside the run directory whatever the key", async () => {
    const store = fileJournal(join(dir, "j"));
    const lease = (await store.lease("r1", "a", "1m")) as Lease;
    await store.put(entry("../../escape", "ok"), { lease });
    expect(await readdir(dir)).toEqual(["j"]);
  });

  it("breaks a stale lock left by a dead process", async () => {
    const store = fileJournal(join(dir, "j"));
    const lease = (await store.lease("r1", "a", "1m")) as Lease;
    const { mkdir, utimes } = await import("node:fs/promises");
    const lock = join(dir, "j", "runs", "r1", ".lock");
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await store.put(entry("k", "ok"), { lease })).toBe(true);
  });
});

describe.each(onDisk)("%s asks", (_name, make) => {
  const ask = (askId: string, extra: Partial<AskRecord> = {}): AskRecord => ({
    askId,
    runId: "r1",
    ordinal: 1,
    callPath: "ask#0",
    origin: { kind: "factory", askSeq: 0 },
    specHash: "h",
    spec: { question: "Merge?" } as AskRecord["spec"],
    status: "open",
    waitpoint: { host: "node", ref: "w" } as AskRecord["waitpoint"],
    messages: [{ channel: "slack", thread: { channel: "slack", id: "T1" }, id: "m1" }],
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1e12).toISOString(),
    ...extra,
  });

  it("creates once, resolves once, and filters open asks", async () => {
    const asks = make().asks;
    if (!asks) throw new Error("an on-disk journal must provide an ask store");
    expect(await asks.create(ask("ask_a1"))).toEqual({ status: "created" });
    expect(await asks.create(ask("ask_a1", { ordinal: 9 }))).toMatchObject({
      status: "exists",
      record: { ordinal: 1 },
    });
    await asks.create(ask("ask_a2", { runId: "r2", messages: [] }));

    expect((await asks.openForThread({ channel: "slack", id: "T1" })).map((r) => r.askId)).toEqual(["ask_a1"]);
    const open: string[] = [];
    for await (const r of asks.open({ runId: "r1" })) open.push(r.askId);
    expect(open).toEqual(["ask_a1"]);

    const resolution = { answeredBy: "u" } as never;
    expect(await asks.resolve("ask_a1", resolution)).toEqual({ won: true });
    expect(await asks.resolve("ask_a1", resolution)).toMatchObject({ won: false, current: { status: "answered" } });
    await asks.setStatus("ask_a2", "expired");
    expect((await asks.get("ask_a2"))?.status).toBe("expired");
    await asks.setStatus("ask_a1", "cancelled");
    expect((await asks.get("ask_a1"))?.status).toBe("answered");
  });

  it("patches cards, lists every record of a run, and marks an open ask cold once", async () => {
    const store = make();
    const asks = store.asks;
    if (!asks?.patch || !asks.list || !asks.markCold) throw new Error("the ask store must implement every member");
    await asks.create(ask("ask_b2"));
    await asks.create(ask("ask_b1", { messages: [] }));
    await asks.create(ask("ask_b3", { runId: "r2" }));
    const card = { channel: "github", thread: { channel: "github", id: "o/r#1" }, id: "c1" };
    await asks.patch("ask_b1", { messages: [card], reconciledAt: "2026-01-01T00:00:00.000Z" });
    await asks.patch("ask_b1", { messages: [card] });
    await asks.patch("ask_missing", { messages: [card] });
    expect(await asks.get("ask_b1")).toMatchObject({ messages: [card], reconciledAt: "2026-01-01T00:00:00.000Z" });
    expect((await asks.openForThread({ channel: "github", id: "o/r#1" })).map((r) => r.askId)).toEqual(["ask_b1"]);
    const github: string[] = [];
    for await (const r of asks.open({ channel: "github" })) github.push(r.askId);
    expect(github).toEqual(["ask_b1"]);

    const cold = { since: "2026-01-01T00:00:00.000Z", sessionId: "s1" };
    expect(await asks.markCold("ask_b2", cold)).toMatchObject({ status: "open", cold });
    await asks.resolve("ask_b1", { answeredBy: "u" } as never);
    expect((await asks.markCold("ask_b1", cold))?.cold).toBeUndefined();
    expect(await asks.markCold("ask_missing", cold)).toBeNull();

    // A second instance (another process) sees every record, open or not, in id order.
    const listed: string[] = [];
    for await (const r of make().asks?.list?.({ runId: "r1" }) ?? []) listed.push(`${r.askId}:${r.status}`);
    expect(listed).toEqual(["ask_b1:answered", "ask_b2:open"]);
  });
});

describe.each(onDisk)("%s results", (_name, make) => {
  it("creates once, replaces on the version it read, and lists by prefix", async () => {
    const results = make().results;
    if (!results) throw new Error("an on-disk journal must provide a result store");
    expect(await results.createIfAbsent("outcomes/r1/l1", { n: 1 })).toBe(true);
    expect(await results.createIfAbsent("outcomes/r1/l1", { n: 2 })).toBe(false);
    expect(await results.get("outcomes/r1/l1")).toEqual({ n: 1 });
    const v1 = await results.getVersioned("outcomes/r1/l1");
    expect(v1?.value).toEqual({ n: 1 });
    expect(await results.replace("outcomes/r1/l1", { n: 3 }, v1?.version ?? null)).toBe(true);
    expect(await results.replace("outcomes/r1/l1", { n: 4 }, v1?.version ?? null)).toBe(false);
    expect(await results.replace("outcomes/r1/l1", { n: 4 }, null)).toBe(false);
    expect(await results.replace("fences/r1/h", { f: 1 }, null)).toBe(true);
    expect(await results.get("missing")).toBeNull();
    expect(await results.getVersioned("missing")).toBeNull();
    await results.createIfAbsent("outcomes/r1/a b", { n: 5 });
    const keys: string[] = [];
    for await (const k of make().results?.list("outcomes/") ?? []) keys.push(k);
    expect(keys).toEqual(["outcomes/r1/a b", "outcomes/r1/l1"]);
  });
});

describe("fileArtifacts", () => {
  it("is content-addressed and rehydrates text()", async () => {
    const store = fileArtifacts(join(dir, "a"));
    const a = await store.put("transcript", "hello", { contentType: "text/plain" });
    const b = await store.put("other-key", "hello");
    expect(b.uri).toBe(a.uri);
    expect(a).toMatchObject({ bytes: 5, contentType: "text/plain" });
    expect(a.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(await a.text()).toBe("hello");
    expect(JSON.parse(JSON.stringify(a))).toEqual({
      uri: a.uri,
      bytes: 5,
      sha256: a.sha256,
      contentType: "text/plain",
    });
    const hydrated = store.hydrate(JSON.parse(JSON.stringify(a)));
    expect(await hydrated.text()).toBe("hello");
    const bin = await store.put("bin", new Uint8Array([1, 2, 3]));
    expect([...(await store.read(bin.uri))]).toEqual([1, 2, 3]);
  });

  it("refuses uris outside the store", async () => {
    const store = fileArtifacts(join(dir, "a"));
    await expect(store.read("file:///etc/passwd")).rejects.toBeInstanceOf(ArtifactError);
    await expect(store.read("s3://bucket/x")).rejects.toBeInstanceOf(ArtifactError);
  });
});
