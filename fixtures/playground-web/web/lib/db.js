// The Notes database. Plain JavaScript (not TypeScript) so `node --test` and the scripts can load it without a
// build step; the Next.js pages import the same file.
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TITLE_MAX = 80;
export const BODY_MAX = 2000;

/** Each entry upgrades the schema by one step; `PRAGMA user_version` records how many have run. */
const MIGRATIONS = [
  `CREATE TABLE notes (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     done INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   )`,
];

export const SEED_NOTES = [
  { title: "Buy milk", body: "Two litres, semi-skimmed." },
  { title: "Call the plumber", body: "The kitchen tap still drips." },
  { title: "Read chapter 3", body: "" },
];

/** @typedef {{ id: number, title: string, body: string, done: boolean, createdAt: string }} Note */
/** @typedef {{ title: string, body: string }} NoteInput */

/** The database file: `DATABASE_PATH`, else `./data/app.db` under the current directory. */
export function databasePath() {
  // The ignore comment stops Next's output tracing from copying the whole project because of a runtime path.
  return resolve(/*turbopackIgnore: true*/ process.env.DATABASE_PATH || "./data/app.db");
}

/**
 * Opens (creating if needed) and migrates the database at `path`.
 * @param {string} [path]
 */
export function openDb(path = databasePath()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL lets the checker's sqlite3 read while the dev server writes.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/** @param {DatabaseSync} db */
export function migrate(db) {
  const row = /** @type {{ user_version: number }} */ (db.prepare("PRAGMA user_version").get());
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    withTransaction(db, () => {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

const SHARED = Symbol.for("playground-web.db");

/** One connection per process and path; kept on globalThis so dev-mode reloads do not open another. */
export function getDb() {
  const path = databasePath();
  const g = /** @type {Record<symbol, { path: string, db: DatabaseSync } | undefined>} */ (
    /** @type {unknown} */ (globalThis)
  );
  const current = g[SHARED];
  if (current && current.path === path) return current.db;
  const db = openDb(path);
  g[SHARED] = { path, db };
  return db;
}

/**
 * Runs `fn` inside a transaction: commits when it returns, rolls back when it throws.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Trims and checks a submitted note.
 * @param {{ title?: unknown, body?: unknown }} input
 * @returns {({ ok: true } & NoteInput) | { ok: false, error: string }}
 */
export function validateNote(input) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (title === "") return { ok: false, error: "Title is required." };
  if (title.length > TITLE_MAX) return { ok: false, error: `Title must be at most ${TITLE_MAX} characters.` };
  if (body.length > BODY_MAX) return { ok: false, error: `Body must be at most ${BODY_MAX} characters.` };
  return { ok: true, title, body };
}

/**
 * Inserts a note and returns its id.
 * @param {DatabaseSync} db
 * @param {NoteInput} note
 * @returns {number}
 */
export function addNote(db, note) {
  const result = db
    .prepare("INSERT INTO notes (title, body, created_at) VALUES (?, ?, ?)")
    .run(note.title, note.body, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

/**
 * All notes, newest first.
 * @param {DatabaseSync} db
 * @returns {Note[]}
 */
export function listNotes(db) {
  const rows = /** @type {{ id: number, title: string, body: string, done: number, created_at: string }[]} */ (
    db.prepare("SELECT id, title, body, done, created_at FROM notes ORDER BY created_at DESC, id DESC").all()
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    done: row.done === 1,
    createdAt: row.created_at,
  }));
}

/** @param {DatabaseSync} db */
export function ping(db) {
  return /** @type {{ ok: number }} */ (db.prepare("SELECT 1 AS ok").get()).ok === 1;
}

/**
 * Deletes the database file (and its WAL companions) and migrates a fresh one.
 * @param {string} [path]
 */
export function resetDb(path = databasePath()) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  return openDb(path);
}

/**
 * Inserts the three seed notes, oldest first, and returns their ids.
 * @param {DatabaseSync} db
 */
export function seed(db) {
  return withTransaction(db, () => SEED_NOTES.map((note) => addNote(db, note)));
}
