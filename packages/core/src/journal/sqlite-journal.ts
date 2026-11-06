import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { parseDuration } from "../config/duration.js";
import { internalNow } from "../engine/hash.js";
import { ConfigError, JournalConflictError, JournalVersionError, LeaseLostError } from "../errors/classes.js";
import type { AskRecord, AskStore, ChannelMessageRef, ThreadKey } from "../types/ask.js";
import type { Json } from "../types/common.js";
import type { ResultStore } from "../types/host.js";
import type { JournalEntry, JournalStore, Lease, SqliteJournalOptions } from "../types/orchestration.js";
import { JOURNAL_FORMAT } from "./file-journal.js";
import { statusMatches } from "./memory.js";

// A SQLite-backed journal on node:sqlite (docs/spec/release-prep.md §1). Owner: sqlite-journal.
// node:sqlite is imported lazily inside the first call, so the core main entry keeps its static imports.
//
// node:sqlite is synchronous: every transaction below runs from BEGIN to COMMIT without an await, so calls on one
// connection never interleave, and BEGIN IMMEDIATE takes the file's write lock, so connections in other processes
// queue behind it (up to busy_timeout) instead of reading stale rows and writing over them.

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

// A variable, not a literal: the bundler rewrites a literal "node:sqlite" to "sqlite", and node:sqlite exists only
// under its prefix.
const NODE_SQLITE = "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
  run_id TEXT NOT NULL, step_key TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (run_id, step_key)
);
CREATE TABLE IF NOT EXISTS leases (
  run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at TEXT NOT NULL,
  ttl_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asks (
  ask_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, channel TEXT, thread TEXT, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS asks_run_id ON asks (run_id);
CREATE INDEX IF NOT EXISTS asks_thread ON asks (thread);
CREATE TABLE IF NOT EXISTS results (key TEXT PRIMARY KEY, json TEXT NOT NULL, version INTEGER NOT NULL);
`;

interface LeaseRow {
  owner: string;
  epoch: number;
  expires_at: string;
  ttl_ms: number;
}

interface Db {
  db: DatabaseSync;
  stmt(sql: string): StatementSync;
  /** Runs `fn` inside BEGIN IMMEDIATE; commits on return, rolls back on throw. */
  tx<T>(fn: () => T): T;
  /** Maps a lock timeout to JournalConflictError; everything else passes through. */
  guard<T>(fn: () => T): T;
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown })?.errcode;
  // SQLITE_BUSY (5) and SQLITE_LOCKED (6), with or without an extended-code high byte.
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

async function openDb(path: string, busyTimeoutMs: number): Promise<Db> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = (await import(NODE_SQLITE)) as typeof import("node:sqlite");
  } catch (cause) {
    throw new ConfigError("sqliteJournal needs node:sqlite (Node 22.13 or later). Use fileJournal, or upgrade Node.", {
      cause,
    });
  }
  const [fs, nodePath] = await Promise.all([import("node:fs/promises"), import("node:path")]);
  const file = nodePath.resolve(path);
  await fs.mkdir(nodePath.dirname(file), { recursive: true });

  const conflict = (cause: unknown) =>
    new JournalConflictError(
      `The SQLite journal ${file} stayed locked by another writer for longer than the busy timeout (${busyTimeoutMs} ms). Retry, or raise sqliteJournal's busyTimeoutMs.`,
      { cause },
    );
  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      throw isBusy(error) ? conflict(error) : error;
    }
  };

  const db = guard(() => new sqlite.DatabaseSync(file));
  const statements = new Map<string, StatementSync>();
  const stmt = (sql: string) => {
    let s = statements.get(sql);
    if (!s) {
      s = db.prepare(sql);
      statements.set(sql, s);
    }
    return s;
  };
  const tx = <T>(fn: () => T): T =>
    guard(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // SQLite already rolled back (some errors end the transaction themselves).
        }
        throw error;
      }
    });

  try {
    guard(() => {
      // busy_timeout first: switching to WAL and creating the schema can wait on another process too.
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA foreign_keys = ON");
    });
    const found = tx(() => {
      db.exec(SCHEMA);
      const row = stmt("SELECT value FROM meta WHERE key = 'format'").get() as { value: string } | undefined;
      if (row) return Number(row.value);
      stmt("INSERT INTO meta (key, value) VALUES ('format', ?)").run(String(JOURNAL_FORMAT));
      return JOURNAL_FORMAT;
    });
    if (found !== JOURNAL_FORMAT) throw new JournalVersionError({ found, supported: JOURNAL_FORMAT });
  } catch (error) {
    db.close();
    throw error;
  }
  return { db, stmt, tx, guard };
}

function onThread(r: AskRecord, t: ThreadKey): boolean {
  return r.messages.some((m) => m.thread.channel === t.channel && m.thread.id === t.id);
}

function mergeMessages(have: ChannelMessageRef[], add: ChannelMessageRef[]): ChannelMessageRef[] {
  const key = (m: ChannelMessageRef) => `${m.channel}\u0000${m.thread.id}\u0000${m.id}`;
  const seen = new Set(have.map(key));
  return [...have, ...add.filter((m) => !seen.has(key(m)))];
}

/**
 * The row of an ask: `[run_id, status, channel, thread, json]`. `channel` and `thread` are the first card's, for
 * lookups by hand; queries match threads on the JSON, since later cards can sit on other threads.
 */
function askColumns(r: AskRecord): [string, string, string | null, string | null, string] {
  const first = r.messages[0];
  return [
    r.runId,
    r.status,
    first?.channel ?? null,
    first ? `${first.thread.channel}:${first.thread.id}` : null,
    JSON.stringify(r),
  ];
}

/**
 * A journal, ask store and result store in one SQLite file (WAL, busy timeout), safe for several processes on one
 * machine. Same semantics as `fileJournal`: fenced lease, compare-and-set put, CAS ask resolution. SQLite's locking
 * does not hold on network filesystems, so keep the file on a local disk. A write that waits longer than
 * `busyTimeoutMs` for another process's lock fails with `JournalConflictError`.
 */
export function sqliteJournal(path: string, opts?: SqliteJournalOptions): JournalStore {
  if (typeof path !== "string" || path === "") throw new ConfigError("sqliteJournal(path) needs a file path.");
  const busyTimeoutMs = opts?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isFinite(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new ConfigError(
      `sqliteJournal busyTimeoutMs must be a number of milliseconds >= 0, got ${String(busyTimeoutMs)}.`,
    );
  }
  let opened: Promise<Db> | undefined;
  const conn = (): Promise<Db> => {
    opened ??= openDb(path, busyTimeoutMs).catch((error) => {
      // A failed open (locked, wrong format) is retried by the next call rather than cached.
      opened = undefined;
      throw error;
    });
    return opened;
  };

  const publicLease = (runId: string, row: LeaseRow): Lease => ({
    owner: row.owner,
    leaseEpoch: row.epoch,
    expiresAt: row.expires_at,
    runId,
  });
  const leaseRow = (d: Db, runId: string) =>
    d.stmt("SELECT owner, epoch, expires_at, ttl_ms FROM leases WHERE run_id = ?").get(runId) as LeaseRow | undefined;
  const holds = (d: Db, lease: Lease): LeaseRow | null => {
    if (lease.runId === undefined) throw new ConfigError("This lease was not issued by a journal (no runId).");
    const row = leaseRow(d, lease.runId);
    return row && row.epoch === lease.leaseEpoch && row.owner === lease.owner ? row : null;
  };
  const writeLease = (d: Db, runId: string, row: LeaseRow) =>
    d
      .stmt(
        `INSERT INTO leases (run_id, owner, epoch, expires_at, ttl_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET owner = excluded.owner, epoch = excluded.epoch,
           expires_at = excluded.expires_at, ttl_ms = excluded.ttl_ms`,
      )
      .run(runId, row.owner, row.epoch, row.expires_at, row.ttl_ms);

  const store: JournalStore = {
    async get(runId, stepKey) {
      const d = await conn();
      const row = d.guard(
        () =>
          d.stmt("SELECT json FROM entries WHERE run_id = ? AND step_key = ?").get(runId, stepKey) as
            | { json: string }
            | undefined,
      );
      return row ? (JSON.parse(row.json) as JournalEntry) : null;
    },

    async *list(runId) {
      const d = await conn();
      const rows = d.guard(
        () => d.stmt("SELECT json FROM entries WHERE run_id = ? ORDER BY seq").all(runId) as { json: string }[],
      );
      const entries = rows.map((r) => JSON.parse(r.json) as JournalEntry);
      // The order fileJournal returns, so a run replays the same whichever store wrote it.
      entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.stepKey.localeCompare(b.stepKey));
      yield* entries;
    },

    async lease(runId, owner, ttl) {
      const ttlMs = parseDuration(ttl, "lease ttl");
      const d = await conn();
      return d.tx(() => {
        const current = leaseRow(d, runId);
        const now = internalNow();
        const live = current !== undefined && Date.parse(current.expires_at) > now;
        if (live && current.owner !== owner) return null;
        const next: LeaseRow = {
          owner,
          epoch: live ? current.epoch : (current?.epoch ?? 0) + 1,
          expires_at: new Date(now + ttlMs).toISOString(),
          ttl_ms: ttlMs,
        };
        writeLease(d, runId, next);
        return publicLease(runId, next);
      });
    },

    async renew(lease) {
      if (lease.runId === undefined) return null;
      const runId = lease.runId;
      const d = await conn();
      return d.tx(() => {
        const current = holds(d, lease);
        if (!current) return null;
        const next: LeaseRow = { ...current, expires_at: new Date(internalNow() + current.ttl_ms).toISOString() };
        writeLease(d, runId, next);
        return publicLease(runId, next);
      });
    },

    async assertLease(lease) {
      const d = await conn();
      if (!d.guard(() => holds(d, lease))) throw new LeaseLostError(undefined, { runId: lease.runId });
    },

    async put(entry, putOpts) {
      const d = await conn();
      return d.tx(() => {
        // Re-checked inside the write transaction: a writer that lost its lease after assertLease fails here.
        if (putOpts.lease.runId !== entry.runId || !holds(d, putOpts.lease)) {
          throw new LeaseLostError(undefined, { runId: entry.runId, callPath: entry.callPath });
        }
        const existing = d
          .stmt("SELECT json FROM entries WHERE run_id = ? AND step_key = ?")
          .get(entry.runId, entry.stepKey) as { json: string } | undefined;
        if (!statusMatches(existing ? (JSON.parse(existing.json) as JournalEntry) : null, putOpts.expectStatus)) {
          return false;
        }
        d.stmt(
          `INSERT INTO entries (run_id, step_key, seq, status, json)
           VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM entries WHERE run_id = ?), ?, ?)
           ON CONFLICT (run_id, step_key) DO UPDATE SET status = excluded.status, json = excluded.json`,
        ).run(entry.runId, entry.stepKey, entry.runId, entry.status, JSON.stringify(entry));
        return true;
      });
    },

    async release(lease) {
      if (lease.runId === undefined) return;
      const runId = lease.runId;
      const d = await conn();
      d.tx(() => {
        const current = holds(d, lease);
        if (current) writeLease(d, runId, { ...current, expires_at: new Date(0).toISOString() });
      });
    },
  };

  const readAsk = (d: Db, askId: string): AskRecord | null => {
    const row = d.stmt("SELECT json FROM asks WHERE ask_id = ?").get(askId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as AskRecord) : null;
  };
  const writeAsk = (d: Db, r: AskRecord) => {
    d.stmt("UPDATE asks SET run_id = ?, status = ?, channel = ?, thread = ?, json = ? WHERE ask_id = ?").run(
      ...askColumns(r),
      r.askId,
    );
  };
  const askRows = (d: Db, sql: string, ...params: SQLInputValue[]): AskRecord[] =>
    d.guard(() => (d.stmt(sql).all(...params) as { json: string }[]).map((r) => JSON.parse(r.json) as AskRecord));

  const asks: AskStore = {
    async create(r) {
      const d = await conn();
      return d.tx(() => {
        const existing = readAsk(d, r.askId);
        if (existing) return { status: "exists" as const, record: existing };
        d.stmt("INSERT INTO asks (ask_id, run_id, status, channel, thread, json) VALUES (?, ?, ?, ?, ?, ?)").run(
          r.askId,
          ...askColumns(r),
        );
        return { status: "created" as const };
      });
    },
    async get(askId) {
      const d = await conn();
      return d.guard(() => readAsk(d, askId));
    },
    async resolve(askId, res) {
      const d = await conn();
      return d.tx(() => {
        const r = readAsk(d, askId);
        if (!r) throw new ConfigError(`sqliteJournal asks: no ask ${askId} to resolve. Create the ask first.`);
        if (r.status !== "open") return { won: false as const, current: r };
        writeAsk(d, { ...r, status: "answered", resolution: res });
        return { won: true as const };
      });
    },
    async openForThread(thread) {
      const d = await conn();
      return askRows(d, "SELECT json FROM asks WHERE status = 'open' ORDER BY ask_id").filter((r) =>
        onThread(r, thread),
      );
    },
    async *open(filter) {
      const d = await conn();
      const rows =
        filter.runId === undefined
          ? askRows(d, "SELECT json FROM asks WHERE status = 'open' ORDER BY ask_id")
          : askRows(d, "SELECT json FROM asks WHERE status = 'open' AND run_id = ? ORDER BY ask_id", filter.runId);
      for (const r of rows) {
        if (filter.channel !== undefined && !r.messages.some((m) => m.channel === filter.channel)) continue;
        yield r;
      }
    },
    async setStatus(askId, s) {
      const d = await conn();
      d.tx(() => {
        const r = readAsk(d, askId);
        if (r?.status === "open") writeAsk(d, { ...r, status: s });
      });
    },
    async patch(askId, p) {
      const d = await conn();
      d.tx(() => {
        const r = readAsk(d, askId);
        if (!r) return;
        const next = { ...r };
        if (p.messages) next.messages = mergeMessages(r.messages, p.messages);
        if (p.reconciledAt !== undefined) next.reconciledAt = p.reconciledAt;
        writeAsk(d, next);
      });
    },
    async *list(filter) {
      const d = await conn();
      yield* askRows(d, "SELECT json FROM asks WHERE run_id = ? ORDER BY ask_id", filter.runId);
    },
    async markCold(askId, cold) {
      const d = await conn();
      return d.tx(() => {
        const r = readAsk(d, askId);
        if (r?.status !== "open") return r;
        const next = { ...r, cold };
        writeAsk(d, next);
        return next;
      });
    },
  };

  const resultRow = (d: Db, key: string) =>
    d.stmt("SELECT json, version FROM results WHERE key = ?").get(key) as { json: string; version: number } | undefined;

  const results: ResultStore = {
    async get<T extends Json>(key: string) {
      const d = await conn();
      const row = d.guard(() => resultRow(d, key));
      return row ? (JSON.parse(row.json) as T) : null;
    },
    async createIfAbsent(key, value) {
      const d = await conn();
      return d.tx(() => {
        if (resultRow(d, key)) return false;
        d.stmt("INSERT INTO results (key, json, version) VALUES (?, ?, 1)").run(key, JSON.stringify(value));
        return true;
      });
    },
    async getVersioned<T extends Json>(key: string) {
      const d = await conn();
      const row = d.guard(() => resultRow(d, key));
      return row ? { value: JSON.parse(row.json) as T, version: String(row.version) } : null;
    },
    async replace(key, value, expectVersion) {
      const d = await conn();
      return d.tx(() => {
        const row = resultRow(d, key);
        if (expectVersion === null ? row !== undefined : row === undefined || String(row.version) !== expectVersion) {
          return false;
        }
        if (row === undefined) {
          d.stmt("INSERT INTO results (key, json, version) VALUES (?, ?, 1)").run(key, JSON.stringify(value));
        } else {
          d.stmt("UPDATE results SET json = ?, version = ? WHERE key = ?").run(
            JSON.stringify(value),
            row.version + 1,
            key,
          );
        }
        return true;
      });
    },
    async *list(prefix) {
      const d = await conn();
      const keys = d.guard(() => (d.stmt("SELECT key FROM results").all() as { key: string }[]).map((r) => r.key));
      // Sorted in JS, as fileResultStore does: SQLite's BINARY collation orders by UTF-8 bytes, not code units.
      keys.sort();
      for (const key of keys) if (key.startsWith(prefix)) yield key;
    },
  };

  Object.defineProperty(store, "asks", { value: asks, enumerable: true });
  Object.defineProperty(store, "results", { value: results, enumerable: true });
  return store;
}
