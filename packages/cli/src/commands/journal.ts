import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type AskRecord,
  ConfigError,
  fileJournal,
  JournalConflictError,
  type JournalEntry,
  sqliteJournal,
} from "@selfbuilding/core";
import { parseCommandArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../exit.js";

export const JOURNAL_HELP = `Usage: selfbuilding journal import <file-journal-dir> <db> [--json]

Copies a file journal into a SQLite journal file (created if missing): every run's entries in their order, its
asks and its result records. Leases are not copied, so an imported run resumes with a fresh lease.

Each run is imported in its own transaction. A run whose lease in the source is still live is refused: stop the
process driving it, or wait for the lease to expire. Rows already in the file with the same contents are skipped,
so importing twice is safe; a row with different contents is a conflict and nothing of that run is written.

Options:
  --json   One JSON object per run on stdout

Exit codes: 0 every run imported or already present, 1 any run refused or in conflict, 2 usage error.
`;

export interface JournalImportReport {
  runId: string;
  ok: boolean;
  entries: number;
  asks: number;
  results: number;
  /** Rows that were already in the file with the same contents. */
  skipped: number;
  reason?: string;
}

interface SourceRun {
  runId: string;
  /** The run's directory under `runs/`, when it has one. */
  dir?: string;
  asks: AskRecord[];
  resultKeys: string[];
}

export async function journalCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseCommandArgs("journal", argv, { json: { type: "boolean" } }, { min: 3, max: 3 });
  const [sub, srcArg, dbArg] = args.positionals as [string, string, string];
  if (sub !== "import") {
    throw new ConfigError(`selfbuilding journal: unknown subcommand "${sub}". Use selfbuilding journal import.`);
  }
  const src = path.resolve(ctx.cwd, srcArg);
  const dbFile = path.resolve(ctx.cwd, dbArg);
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new ConfigError(`selfbuilding journal import: ${src} is not a directory. Pass a fileJournal directory.`);
  }
  if (!["runs", "asks", "results"].some((d) => existsSync(path.join(src, d)))) {
    throw new ConfigError(
      `selfbuilding journal import: ${src} has no runs/, asks/ or results/; it is not a fileJournal directory.`,
    );
  }

  const source = fileJournal(src);
  const runs = await collectRuns(src, source);

  // Opening through sqliteJournal creates the schema and checks the format before anything is written.
  await sqliteJournal(dbFile).get("", "");
  const db = await openRaw(dbFile);
  const reports: JournalImportReport[] = [];
  try {
    for (const run of runs) reports.push(await importRun(db, dbFile, source, run));
  } finally {
    db.close();
  }

  for (const r of reports) {
    if (args.bool("json")) ctx.stdout.write(`${JSON.stringify(r)}\n`);
    else if (r.ok) ctx.stdout.write(`ok   ${r.runId}  ${r.entries} entries  ${r.asks} asks  ${r.results} results\n`);
    else ctx.stdout.write(`fail ${r.runId}  ${r.reason}\n`);
  }
  if (reports.length === 0 && !args.bool("json")) ctx.stderr.write(`No runs found in ${src}.\n`);
  return reports.every((r) => r.ok) ? EXIT.ok : EXIT.failed;
}

/** fileJournal names a run directory with the run id, or `~` + base64url for ids that are not file-safe. */
function runIdOf(dirName: string): string {
  return dirName.startsWith("~") ? Buffer.from(dirName.slice(1), "base64url").toString("utf8") : dirName;
}

/** Result keys carry their run as the second segment: `outcomes/<runId>/…`, `fences/<runId>/…`, `runs/<runId>/…`. */
function runOfKey(key: string): string {
  const parts = key.split("/");
  return parts[1] ?? parts[0] ?? key;
}

async function collectRuns(src: string, source: ReturnType<typeof fileJournal>): Promise<SourceRun[]> {
  const byId = new Map<string, SourceRun>();
  const runOf = (runId: string) => {
    let run = byId.get(runId);
    if (!run) {
      run = { runId, asks: [], resultKeys: [] };
      byId.set(runId, run);
    }
    return run;
  };
  const runsDir = path.join(src, "runs");
  if (existsSync(runsDir)) {
    for (const name of readdirSync(runsDir)) {
      const dir = path.join(runsDir, name);
      if (statSync(dir).isDirectory()) runOf(runIdOf(name)).dir = dir;
    }
  }
  const asksDir = path.join(src, "asks");
  if (existsSync(asksDir)) {
    for (const name of readdirSync(asksDir).sort()) {
      // Only finished files: the ask store's temp and lock files have other suffixes.
      if (!/^ask_[a-z0-9_]+\.json$/.test(name)) continue;
      const record = JSON.parse(readFileSync(path.join(asksDir, name), "utf8")) as AskRecord;
      runOf(record.runId).asks.push(record);
    }
  }
  if (source.results) for await (const key of source.results.list("")) runOf(runOfKey(key)).resultKeys.push(key);
  return [...byId.values()].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}

async function openRaw(file: string): Promise<DatabaseSync> {
  // A variable, not a literal: the bundler rewrites a literal "node:sqlite" to "sqlite", which does not exist.
  const specifier = "node:sqlite";
  const { DatabaseSync } = (await import(specifier)) as typeof import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** JSON with sorted keys, so two records with the same contents compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

function liveLease(file: string, now: number): { owner: string; expiresAt: string } | null {
  if (!existsSync(file)) return null;
  const lease = JSON.parse(readFileSync(file, "utf8")) as { owner: string; expiresAt: string };
  return Date.parse(lease.expiresAt) > now ? lease : null;
}

async function importRun(
  db: DatabaseSync,
  dbFile: string,
  source: ReturnType<typeof fileJournal>,
  run: SourceRun,
): Promise<JournalImportReport> {
  const report: JournalImportReport = { runId: run.runId, ok: false, entries: 0, asks: 0, results: 0, skipped: 0 };
  const now = Date.now();
  const live = run.dir ? liveLease(path.join(run.dir, "lease.json"), now) : null;
  if (live) {
    report.reason = `its lease in the source is live (owner ${live.owner} until ${live.expiresAt}). Stop that process or wait for the lease to expire, then import again.`;
    return report;
  }
  const target = db.prepare("SELECT owner, expires_at FROM leases WHERE run_id = ?").get(run.runId) as
    | { owner: string; expires_at: string }
    | undefined;
  if (target && Date.parse(target.expires_at) > now) {
    report.reason = `a process holds its lease in ${dbFile} (owner ${target.owner} until ${target.expires_at}). Import it once that run stops.`;
    return report;
  }

  // Read everything first: the transaction below must not await.
  const entries: JournalEntry[] = [];
  const results: { key: string; value: unknown }[] = [];
  try {
    if (run.dir) for await (const e of source.list(run.runId)) entries.push(e);
    for (const key of run.resultKeys) results.push({ key, value: await source.results?.get(key) });
  } catch (error) {
    report.reason = `could not read it from the source: ${(error as Error).message}`;
    return report;
  }

  const sameOrInsert = (what: string, existing: { json: string } | undefined, value: unknown, insert: () => void) => {
    if (existing === undefined) {
      insert();
      return;
    }
    if (canonical(JSON.parse(existing.json)) === canonical(value)) {
      report.skipped++;
      return;
    }
    throw new JournalConflictError(
      `${what} is already in ${dbFile} with different contents; nothing of this run was written.`,
    );
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const e of entries) {
      const existing = db
        .prepare("SELECT json FROM entries WHERE run_id = ? AND step_key = ?")
        .get(run.runId, e.stepKey) as { json: string } | undefined;
      sameOrInsert(`entry ${e.stepKey}`, existing, e, () => {
        db.prepare(
          `INSERT INTO entries (run_id, step_key, seq, status, json)
           VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM entries WHERE run_id = ?), ?, ?)`,
        ).run(run.runId, e.stepKey, run.runId, e.status, JSON.stringify(e));
      });
      report.entries++;
    }
    for (const a of run.asks) {
      const existing = db.prepare("SELECT json FROM asks WHERE ask_id = ?").get(a.askId) as
        | { json: string }
        | undefined;
      sameOrInsert(`ask ${a.askId}`, existing, a, () => {
        const first = a.messages[0];
        db.prepare("INSERT INTO asks (ask_id, run_id, status, channel, thread, json) VALUES (?, ?, ?, ?, ?, ?)").run(
          a.askId,
          a.runId,
          a.status,
          first?.channel ?? null,
          first ? `${first.thread.channel}:${first.thread.id}` : null,
          JSON.stringify(a),
        );
      });
      report.asks++;
    }
    for (const r of results) {
      const existing = db.prepare("SELECT json FROM results WHERE key = ?").get(r.key) as { json: string } | undefined;
      sameOrInsert(`result ${r.key}`, existing, r.value, () => {
        db.prepare("INSERT INTO results (key, json, version) VALUES (?, ?, 1)").run(r.key, JSON.stringify(r.value));
      });
      report.results++;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (!(error instanceof JournalConflictError)) throw error;
    return { runId: run.runId, ok: false, entries: 0, asks: 0, results: 0, skipped: 0, reason: error.message };
  }
  report.ok = true;
  return report;
}
