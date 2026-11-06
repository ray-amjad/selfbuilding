import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  addNote,
  BODY_MAX,
  listNotes,
  migrate,
  openDb,
  ping,
  resetDb,
  SEED_NOTES,
  seed,
  TITLE_MAX,
  validateNote,
  withTransaction,
} from "../lib/db.js";

const dir = mkdtempSync(join(tmpdir(), "playground-web-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const freshPath = () => join(dir, `db-${counter++}`, "app.db");

describe("schema", () => {
  it("creates the notes table with the documented columns", () => {
    const db = openDb(freshPath());
    const columns = db.prepare("PRAGMA table_info(notes)").all();
    assert.deepEqual(
      columns.map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
      [
        ["id", "INTEGER", 0, null, 1],
        ["title", "TEXT", 1, null, 0],
        ["body", "TEXT", 1, "''", 0],
        ["done", "INTEGER", 1, "0", 0],
        ["created_at", "TEXT", 1, null, 0],
      ],
    );
    assert.equal(ping(db), true);
    db.close();
  });

  it("migrates idempotently", () => {
    const path = freshPath();
    const db = openDb(path);
    migrate(db);
    db.close();
    const again = openDb(path);
    assert.equal(again.prepare("PRAGMA user_version").get().user_version, 1);
    again.close();
  });
});

describe("notes", () => {
  it("adds notes and lists them newest first", () => {
    const db = openDb(freshPath());
    const a = addNote(db, { title: "first", body: "" });
    const b = addNote(db, { title: "second", body: "more" });
    const notes = listNotes(db);
    assert.deepEqual(
      notes.map((n) => [n.id, n.title, n.body, n.done]),
      [
        [b, "second", "more", false],
        [a, "first", "", false],
      ],
    );
    assert.match(notes[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
    db.close();
  });

  it("commits a transaction that returns and rolls back one that throws", () => {
    const db = openDb(freshPath());
    const id = withTransaction(db, () => addNote(db, { title: "kept", body: "" }));
    assert.throws(
      () =>
        withTransaction(db, () => {
          addNote(db, { title: "dropped", body: "" });
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.deepEqual(
      listNotes(db).map((n) => [n.id, n.title]),
      [[id, "kept"]],
    );
    db.close();
  });

  it("seeds three notes and reset empties the database", () => {
    const path = freshPath();
    const db = openDb(path);
    const ids = seed(db);
    assert.equal(ids.length, 3);
    assert.deepEqual(
      listNotes(db)
        .map((n) => n.title)
        .sort(),
      SEED_NOTES.map((n) => n.title).sort(),
    );
    db.close();
    const fresh = resetDb(path);
    assert.deepEqual(listNotes(fresh), []);
    fresh.close();
  });

  it("persists across connections", () => {
    const path = freshPath();
    const db = openDb(path);
    addNote(db, { title: "durable", body: "" });
    db.close();
    const other = openDb(path);
    assert.deepEqual(
      listNotes(other).map((n) => n.title),
      ["durable"],
    );
    other.close();
  });
});

describe("validateNote", () => {
  it("trims and accepts a valid note", () => {
    assert.deepEqual(validateNote({ title: "  hi  ", body: " there " }), { ok: true, title: "hi", body: "there" });
    assert.deepEqual(validateNote({ title: "hi", body: null }), { ok: true, title: "hi", body: "" });
  });

  it("rejects a missing or blank title", () => {
    assert.equal(validateNote({ title: "   " }).ok, false);
    assert.equal(validateNote({}).ok, false);
  });

  it("enforces the length limits", () => {
    assert.equal(validateNote({ title: "x".repeat(TITLE_MAX) }).ok, true);
    assert.equal(validateNote({ title: "x".repeat(TITLE_MAX + 1) }).ok, false);
    assert.equal(validateNote({ title: "t", body: "x".repeat(BODY_MAX) }).ok, true);
    assert.equal(validateNote({ title: "t", body: "x".repeat(BODY_MAX + 1) }).ok, false);
  });
});
