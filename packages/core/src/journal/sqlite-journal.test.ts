import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, JournalConflictError, JournalVersionError, LeaseLostError } from "../errors/classes.js";
import type { AskRecord } from "../types/ask.js";
import type { JournalEntry, Lease } from "../types/orchestration.js";
import { sqliteJournal } from "./sqlite-journal.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-sqlite-"));
  file = join(dir, "nested", "journal.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(stepKey: string, status: JournalEntry["status"]): JournalEntry {
  return {
    runId: "r1",
    stepKey,
    callPath: `A#${stepKey}`,
    kind: "step",
    status,
    launchId: `${stepKey}_e0_l0`,
    attempt: 1,
    startedAt: new Date(1_000).toISOString(),
  };
}

const ask = (askId: string): AskRecord => ({
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
});

describe("sqliteJournal", () => {
  it("does no I/O until the first call, then creates parent directories and a WAL file", async () => {
    const store = sqliteJournal(file);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "nested"))).toBe(false);
    await store.lease("r1", "a", "1m");
    const db = new DatabaseSync(file);
    try {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.prepare("SELECT value FROM meta WHERE key = 'format'").get()).toEqual({ value: "1" });
    } finally {
      db.close();
    }
  });

  it("refuses bad arguments at the door", () => {
    expect(() => sqliteJournal("")).toThrow(ConfigError);
    expect(() => sqliteJournal(file, { busyTimeoutMs: -1 })).toThrow(ConfigError);
  });

  it("rejects a file written in another format", async () => {
    await sqliteJournal(file).lease("r1", "a", "1m");
    const db = new DatabaseSync(file);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'format'").run();
    db.close();
    const error = await sqliteJournal(file)
      .get("r1", "x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JournalVersionError);
    expect(error).toMatchObject({ found: 99, supported: 1 });
  });

  it("lets exactly one of two connections win a lease race, and fences the loser's puts", async () => {
    const a = sqliteJournal(file);
    const b = sqliteJournal(file);
    const leases = await Promise.all([a.lease("r1", "a", "1m"), b.lease("r1", "b", "1m")]);
    expect(leases.filter((l) => l !== null)).toHaveLength(1);

    // Two connections holding the same lease race a must-not-exist put: one write lands.
    const lease = leases.find((l) => l !== null) as Lease;
    const puts = await Promise.all([
      a.put(entry("k1", "started"), { lease, expectStatus: null }),
      b.put(entry("k1", "started"), { lease, expectStatus: null }),
    ]);
    expect(puts.filter(Boolean)).toHaveLength(1);

    // After a takeover, the old holder's put fails inside the write transaction.
    const stale = (await a.lease("r2", "a", 1)) as Lease;
    await new Promise((r) => setTimeout(r, 10));
    const fresh = (await b.lease("r2", "b", "1m")) as Lease;
    expect(fresh.leaseEpoch).toBe(stale.leaseEpoch + 1);
    const results = await Promise.allSettled([
      a.put({ ...entry("k", "ok"), runId: "r2" }, { lease: stale }),
      b.put({ ...entry("k", "ok"), runId: "r2" }, { lease: fresh }),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: expect.any(LeaseLostError) });
    expect(results[1]).toEqual({ status: "fulfilled", value: true });
  });

  it("waits out another process's write lock, fails with JournalConflictError past the timeout, then succeeds", async () => {
    const store = sqliteJournal(file, { busyTimeoutMs: 200 });
    await store.lease("r0", "a", "1m");
    // A real second process takes the write lock and holds it until told to commit.
    const holder = spawn(
      process.execPath,
      [
        "--no-warnings=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite";
         const db = new DatabaseSync(process.argv[1]);
         db.exec("BEGIN IMMEDIATE");
         db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('held', '1')").run();
         process.stdout.write("locked\\n");
         process.stdin.once("data", () => { db.exec("COMMIT"); db.close(); process.exit(0); });`,
        file,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on("data", (d: Buffer) => {
        if (d.toString().includes("locked")) resolve();
      });
      holder.on("exit", (code) => reject(new Error(`the lock holder exited early (${code})`)));
    });
    try {
      const error = await store.lease("r1", "a", "1m").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JournalConflictError);
      expect((error as Error).message).toContain(file);
      expect((error as Error).message).toContain("200 ms");
      // Reads are not blocked by a writer in WAL mode.
      expect(await store.get("r0", "missing")).toBeNull();
    } finally {
      const exited = new Promise((r) => holder.once("exit", r));
      holder.stdin.write("commit\n");
      await exited;
    }
    expect(await store.lease("r1", "a", "1m")).toMatchObject({ owner: "a", leaseEpoch: 1 });
  });

  it("keeps ask resolution a compare-and-set across connections, with markCold in the race", async () => {
    const a = sqliteJournal(file).asks;
    const b = sqliteJournal(file).asks;
    if (!a?.markCold || !b?.markCold) throw new Error("sqliteJournal must provide markCold");
    const created = await Promise.all([a.create(ask("ask_x")), b.create(ask("ask_x"))]);
    expect(created.filter((c) => c.status === "created")).toHaveLength(1);

    const cold = { since: "2026-01-01T00:00:00.000Z", sessionId: "s1" };
    const [ra, cb, rb, ca] = await Promise.all([
      a.resolve("ask_x", { answeredBy: "alice" } as never),
      b.markCold("ask_x", cold),
      b.resolve("ask_x", { answeredBy: "bob" } as never),
      a.markCold("ask_x", cold),
    ]);
    expect([ra, rb].filter((r) => r.won)).toHaveLength(1);
    const winner = ra.won ? "alice" : "bob";
    const stored = await a.get("ask_x");
    expect(stored).toMatchObject({ status: "answered", resolution: { answeredBy: winner } });
    // A markCold that ran after the answer saw it and left `cold` alone.
    for (const r of [cb, ca]) if (r?.status === "answered") expect(r.resolution).toEqual(stored?.resolution);
    await expect(a.resolve("ask_missing", {} as never)).rejects.toBeInstanceOf(ConfigError);
  });

  it("creates result records once and replaces them on the version read, across connections", async () => {
    const a = sqliteJournal(file).results;
    const b = sqliteJournal(file).results;
    if (!a || !b) throw new Error("sqliteJournal must provide a result store");
    const created = await Promise.all([a.createIfAbsent("k", { by: "a" }), b.createIfAbsent("k", { by: "b" })]);
    expect(created.filter(Boolean)).toHaveLength(1);
    const v = (await a.getVersioned("k"))?.version as string;
    expect(typeof v).toBe("string");
    const replaced = await Promise.all([a.replace("k", { n: 1 }, v), b.replace("k", { n: 2 }, v)]);
    expect(replaced.filter(Boolean)).toHaveLength(1);
    const after = await b.getVersioned("k");
    expect(after?.version).not.toBe(v);
    expect(after?.value).toEqual(replaced[0] ? { n: 1 } : { n: 2 });
    expect(await a.replace("new", { n: 0 }, null)).toBe(true);
    expect(await b.replace("new", { n: 0 }, null)).toBe(false);
  });
});

describe("sqliteJournal without node:sqlite", () => {
  afterEach(() => {
    vi.doUnmock("node:sqlite");
    vi.resetModules();
  });

  it("names the fix when node:sqlite cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("node:sqlite", () => {
      throw new Error("No such built-in module: node:sqlite");
    });
    const mod = await import("./sqlite-journal.js");
    const errors = await import("../errors/classes.js");
    const error = await mod
      .sqliteJournal(file)
      .get("r1", "k")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(errors.ConfigError);
    expect((error as Error).message).toBe(
      "sqliteJournal needs node:sqlite (Node 22.13 or later). Use fileJournal, or upgrade Node.",
    );
  });
});
