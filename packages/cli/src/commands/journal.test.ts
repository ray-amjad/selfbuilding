import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type AskRecord, fileJournal, type JournalEntry, type Lease, sqliteJournal } from "@selfbuilding/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, jsonLines } from "../../test/helpers.js";
import { EXIT } from "../exit.js";
import type { JournalImportReport } from "./journal.js";

let root: string;
let src: string;
let db: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "sbcli-journal-"));
  src = path.join(root, ".selfbuilding", "journal");
  db = path.join(root, ".selfbuilding", "journal.db");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function entry(runId: string, stepKey: string, at: number): JournalEntry {
  return {
    runId,
    stepKey,
    callPath: `A#${stepKey}`,
    kind: "step",
    status: "ok",
    launchId: `${stepKey}_e0_l0`,
    attempt: 1,
    startedAt: new Date(at).toISOString(),
    value: { stepKey },
  };
}

const ask = (askId: string, runId: string): AskRecord => ({
  askId,
  runId,
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

/** Two finished runs in a file journal: r1 with three entries, an ask and two result records; r2 with one entry. */
async function seed(): Promise<void> {
  const j = fileJournal(src);
  const l1 = (await j.lease("r1", "host", "1m")) as Lease;
  await j.put(entry("r1", "c", 3000), { lease: l1 });
  await j.put(entry("r1", "a", 1000), { lease: l1 });
  await j.put(entry("r1", "b", 2000), { lease: l1 });
  await j.release?.(l1);
  const l2 = (await j.lease("run/2", "host", "1m")) as Lease;
  await j.put(entry("run/2", "only", 1000), { lease: l2 });
  await j.release?.(l2);
  await j.asks?.create(ask("ask_r1_1", "r1"));
  await j.results?.createIfAbsent("outcomes/r1/l1", { ok: true });
  await j.results?.createIfAbsent("fences/r1/h", { launch: "l1" });
}

const importArgs = (...extra: string[]) => ["journal", "import", src, db, ...extra];

describe("selfbuilding journal import", () => {
  it("copies every run's entries in order, asks and results, and skips them on a second import", async () => {
    await seed();
    const first = await cli(importArgs(), { cwd: root });
    expect(first.code, first.stderr).toBe(EXIT.ok);
    expect(first.stdout).toBe("ok   r1  3 entries  1 asks  2 results\nok   run/2  1 entries  0 asks  0 results\n");

    const store = sqliteJournal(db);
    const keys: string[] = [];
    for await (const e of store.list("r1")) keys.push(e.stepKey);
    expect(keys).toEqual(["a", "b", "c"]);
    expect(await store.get("run/2", "only")).toMatchObject({ value: { stepKey: "only" } });
    expect(await store.asks?.get("ask_r1_1")).toMatchObject({ runId: "r1", status: "open" });
    expect(await store.results?.get("fences/r1/h")).toEqual({ launch: "l1" });
    // Leases are not copied: the imported run starts at the first epoch with any owner.
    const taken = (await store.lease("r1", "someone-else", "1m")) as Lease;
    expect(taken.leaseEpoch).toBe(1);
    // While a process drives the run on the SQLite file, importing into it is refused.
    const busy = await cli(importArgs(), { cwd: root });
    expect(busy.code).toBe(EXIT.failed);
    expect(busy.stdout).toContain("fail r1  a process holds its lease in");
    await store.release?.(taken);

    const again = await cli(importArgs("--json"), { cwd: root });
    expect(again.code).toBe(EXIT.ok);
    const reports = jsonLines(again.stdout) as JournalImportReport[];
    expect(reports).toEqual([
      { runId: "r1", ok: true, entries: 3, asks: 1, results: 2, skipped: 6 },
      { runId: "run/2", ok: true, entries: 1, asks: 0, results: 0, skipped: 1 },
    ]);
  });

  it("reports a row with different contents as a conflict and writes nothing of that run", async () => {
    await seed();
    expect((await cli(importArgs(), { cwd: root })).code).toBe(EXIT.ok);
    // The source changes after the first import, and gains a new entry.
    const j = fileJournal(src);
    const lease = (await j.lease("r1", "host", "1m")) as Lease;
    await j.put({ ...entry("r1", "b", 2000), value: { changed: true } }, { lease });
    await j.put(entry("r1", "d", 4000), { lease });
    await j.release?.(lease);

    const res = await cli(importArgs(), { cwd: root });
    expect(res.code).toBe(EXIT.failed);
    expect(res.stdout).toContain("fail r1  entry b is already in");
    expect(res.stdout).toContain("ok   run/2  1 entries");
    expect(await sqliteJournal(db).get("r1", "d")).toBeNull();
  });

  it("refuses a run whose source lease is live, and still imports the others", async () => {
    await seed();
    const j = fileJournal(src);
    await j.lease("r3", "busy-host", "1h");
    const res = await cli(importArgs("--json"), { cwd: root });
    expect(res.code).toBe(EXIT.failed);
    const reports = jsonLines(res.stdout) as JournalImportReport[];
    expect(reports.find((r) => r.runId === "r3")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("owner busy-host"),
    });
    expect(reports.filter((r) => r.ok).map((r) => r.runId)).toEqual(["r1", "run/2"]);
    const raw = new DatabaseSync(db);
    try {
      expect(raw.prepare("SELECT COUNT(*) AS n FROM leases").get()).toEqual({ n: 0 });
    } finally {
      raw.close();
    }
  });

  it("treats a wrong subcommand, a missing directory or a non-journal directory as usage errors", async () => {
    expect((await cli(["journal", "export", src, db], { cwd: root })).code).toBe(EXIT.usage);
    expect((await cli(["journal", "import", src], { cwd: root })).code).toBe(EXIT.usage);
    const missing = await cli(importArgs(), { cwd: root });
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stderr).toContain("is not a directory");
    writeFileSync(path.join(root, "notes.txt"), "x");
    const notJournal = await cli(["journal", "import", root, db], { cwd: root });
    expect(notJournal.code).toBe(EXIT.usage);
    expect(notJournal.stderr).toContain("not a fileJournal directory");
  });
});
