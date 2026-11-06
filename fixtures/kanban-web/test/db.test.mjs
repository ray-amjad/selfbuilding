import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  addCard,
  DESCRIPTION_MAX,
  listBoard,
  migrate,
  openDb,
  ping,
  resetDb,
  SEED_CARDS,
  seed,
  TITLE_MAX,
  validateCard,
  withTransaction,
} from "../lib/db.js";

const dir = mkdtempSync(join(tmpdir(), "kanban-web-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const freshPath = () => join(dir, `db-${counter++}`, "app.db");

describe("schema", () => {
  it("creates the cards table with the documented columns", () => {
    const db = openDb(freshPath());
    const columns = db.prepare("PRAGMA table_info(cards)").all();
    assert.deepEqual(
      columns.map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
      [
        ["id", "INTEGER", 0, null, 1],
        ["title", "TEXT", 1, null, 0],
        ["description", "TEXT", 1, "''", 0],
        ["column", "TEXT", 1, "'todo'", 0],
        ["position", "INTEGER", 1, null, 0],
        ["created_at", "TEXT", 1, null, 0],
      ],
    );
    assert.equal(ping(db), true);
    db.close();
  });

  it("migrates idempotently and rejects an unknown column", () => {
    const path = freshPath();
    const db = openDb(path);
    migrate(db);
    assert.throws(() =>
      db.prepare(`INSERT INTO cards (title, "column", position, created_at) VALUES ('x', 'later', 1, 'now')`).run(),
    );
    db.close();
    const again = openDb(path);
    assert.equal(again.prepare("PRAGMA user_version").get().user_version, 1);
    again.close();
  });
});

describe("cards", () => {
  it("adds cards to the bottom of To do", () => {
    const db = openDb(freshPath());
    const a = addCard(db, { title: "first", description: "" });
    const b = addCard(db, { title: "second", description: "more" });
    const board = listBoard(db);
    assert.deepEqual(
      board.todo.map((c) => [c.id, c.title, c.description, c.column, c.position]),
      [
        [a, "first", "", "todo", 1],
        [b, "second", "more", "todo", 2],
      ],
    );
    assert.deepEqual([board.in_progress, board.done], [[], []]);
    assert.match(board.todo[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
    db.close();
  });

  it("commits a transaction that returns and rolls back one that throws", () => {
    const db = openDb(freshPath());
    const id = withTransaction(db, () => addCard(db, { title: "kept", description: "" }));
    assert.throws(
      () =>
        withTransaction(db, () => {
          addCard(db, { title: "dropped", description: "" });
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.deepEqual(
      listBoard(db).todo.map((c) => [c.id, c.title]),
      [[id, "kept"]],
    );
    db.close();
  });

  it("seeds three cards, persists them and reset empties the database", () => {
    const path = freshPath();
    const db = openDb(path);
    assert.equal(seed(db).length, 3);
    db.close();
    const other = openDb(path);
    assert.deepEqual(
      listBoard(other).todo.map((c) => c.title),
      SEED_CARDS.map((c) => c.title),
    );
    other.close();
    const fresh = resetDb(path);
    assert.deepEqual(listBoard(fresh), { todo: [], in_progress: [], done: [] });
    fresh.close();
  });
});

describe("validateCard", () => {
  it("trims and accepts a valid card", () => {
    assert.deepEqual(validateCard({ title: "  hi  ", description: " there " }), {
      ok: true,
      title: "hi",
      description: "there",
    });
    assert.deepEqual(validateCard({ title: "hi", description: null }), { ok: true, title: "hi", description: "" });
  });

  it("rejects a blank title and enforces the length limits", () => {
    assert.equal(validateCard({ title: "   " }).ok, false);
    assert.equal(validateCard({}).ok, false);
    assert.equal(validateCard({ title: "x".repeat(TITLE_MAX) }).ok, true);
    assert.equal(validateCard({ title: "x".repeat(TITLE_MAX + 1) }).ok, false);
    assert.equal(validateCard({ title: "t", description: "x".repeat(DESCRIPTION_MAX + 1) }).ok, false);
  });
});
