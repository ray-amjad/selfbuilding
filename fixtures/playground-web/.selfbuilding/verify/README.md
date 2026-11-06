# Verifying this app

app dir            web/                                   (pnpm; the lockfile is web/pnpm-lock.yaml)
install            cd web && pnpm install --frozen-lockfile
fresh database     export DATABASE_PATH=/tmp/verify-<slug>.db && pnpm db:reset && pnpm db:seed
dev command        DATABASE_PATH=$DATABASE_PATH pnpm dev   (listens on 0.0.0.0, port 3000; PORT overrides)
boot wait          curl -sf http://localhost:3000/api/health   → {"ok":true,"db":"ok"}
typical boot       a few seconds after install; the first page request compiles it (another few seconds)

The root of this repository is a separate small library (`src/`, `test/`); the web app is only `web/`.
Nothing here needs network once `pnpm install` has run: no auth, no external APIs, no keys.

## Environment
DATABASE_PATH      the SQLite file; default web/data/app.db. Always set it to a fresh file per run.
PORT               default 3000

Node prints `ExperimentalWarning: SQLite is an experimental feature`; that line is noise.

## The app
One page, `/`, titled "Notes":
- lists notes newest first;
- a form "Add note": title required, at most 80 characters; body optional, at most 2000;
- submitting redirects to `/?added=<id>`, which shows the flash "Note added" and the note in the list;
- an invalid submission redirects to `/?error=<message>` and shows the message.

## Selectors
form               [data-testid=note-form]
title / body       [data-testid=note-title] / [data-testid=note-body]
submit             [data-testid=note-submit]
list / one note    [data-testid=note-list] / [data-testid=note-item]   (each item has data-note-id=<id>)
flash              [data-testid=flash]
form error         [data-testid=form-error]
mark done          [data-testid=note-done-button]; a done note has [data-testid=note-done]
                   (only once docs/specs/web-mark-done.md is built)

## Database
One table:
notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)
created_at is an ISO-8601 UTC string. Migrations run on boot (`PRAGMA user_version` counts them).
The file is in WAL mode, so reading it while the dev server runs is safe.

## Setup macros (SETUP only)
pnpm db:reset          delete the file and migrate an empty one
pnpm db:seed           add three notes: "Buy milk", "Call the plumber", "Read chapter 3"

## Check probes (CHECKER only)
sqlite3 "$DATABASE_PATH" 'select id, title, body, done, created_at from notes order by id'
sqlite3 "$DATABASE_PATH" "select count(*) from notes where title = '<the submitted title>'"

A note on screen is not proof it was saved: always confirm the row.
