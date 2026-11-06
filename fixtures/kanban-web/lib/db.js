// The board's database. Plain JavaScript (not TypeScript) so `node --test` and the scripts can load it without a
// build step; the Next.js pages import the same file.
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 1000;

/** @typedef {"todo" | "in_progress" | "done"} ColumnId */

/**
 * The three columns, in board order. `id` is what the `column` field stores.
 * @type {{ id: ColumnId, label: string }[]}
 */
export const COLUMNS = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
];

/** Each entry upgrades the schema by one step; `PRAGMA user_version` records how many have run. */
const MIGRATIONS = [
  // "column" is an SQL keyword, so it is always quoted.
  `CREATE TABLE cards (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     "column" TEXT NOT NULL DEFAULT 'todo' CHECK ("column" IN ('todo', 'in_progress', 'done')),
     position INTEGER NOT NULL,
     created_at TEXT NOT NULL
   )`,
];

export const SEED_CARDS = [
  { title: "Write the onboarding email", description: "Three short paragraphs and one link." },
  { title: "Fix the login timeout", description: "" },
  { title: "Plan the team offsite", description: "Pick two dates and a venue." },
];

/** @typedef {{ id: number, title: string, description: string, column: ColumnId, position: number, createdAt: string }} Card */
/** @typedef {{ title: string, description: string }} CardInput */

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
  // WAL lets a checker's sqlite3 read while the dev server writes.
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

const SHARED = Symbol.for("kanban-web.db");

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
  db.exec("BEGIN IMMEDIATE");
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
 * Trims and checks a submitted card.
 * @param {{ title?: unknown, description?: unknown }} input
 * @returns {({ ok: true } & CardInput) | { ok: false, error: string }}
 */
export function validateCard(input) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (title === "") return { ok: false, error: "Title is required." };
  if (title.length > TITLE_MAX) return { ok: false, error: `Title must be at most ${TITLE_MAX} characters.` };
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, error: `Description must be at most ${DESCRIPTION_MAX} characters.` };
  }
  return { ok: true, title, description };
}

/**
 * Adds a card to the bottom of "To do" and returns its id.
 * @param {DatabaseSync} db
 * @param {CardInput} card
 * @returns {number}
 */
export function addCard(db, card) {
  const result = db
    .prepare(
      `INSERT INTO cards (title, description, "column", position, created_at)
       VALUES (?, ?, 'todo', (SELECT COALESCE(MAX(position), 0) + 1 FROM cards WHERE "column" = 'todo'), ?)`,
    )
    .run(card.title, card.description, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

/**
 * Every card, grouped by column in board order, each column top to bottom.
 * @param {DatabaseSync} db
 * @returns {Record<ColumnId, Card[]>}
 */
export function listBoard(db) {
  const rows =
    /** @type {{ id: number, title: string, description: string, column: ColumnId, position: number, created_at: string }[]} */ (
      db.prepare(`SELECT id, title, description, "column", position, created_at FROM cards ORDER BY position, id`).all()
    );
  /** @type {Record<ColumnId, Card[]>} */
  const board = { todo: [], in_progress: [], done: [] };
  for (const row of rows) {
    board[row.column].push({
      id: row.id,
      title: row.title,
      description: row.description,
      column: row.column,
      position: row.position,
      createdAt: row.created_at,
    });
  }
  return board;
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
 * Adds the three seed cards to "To do", in order, and returns their ids.
 * @param {DatabaseSync} db
 */
export function seed(db) {
  return withTransaction(db, () => SEED_CARDS.map((card) => addCard(db, card)));
}
