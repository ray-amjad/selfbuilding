# Verifying this app

app dir            .                                      (pnpm; the lockfile is pnpm-lock.yaml)
install            pnpm install --frozen-lockfile
fresh database     export DATABASE_PATH=/tmp/verify-<slug>.db && pnpm db:reset && pnpm db:seed
dev command        DATABASE_PATH=$DATABASE_PATH pnpm dev   (listens on 0.0.0.0, port 3000; PORT overrides)
boot wait          curl -sf http://localhost:3000/api/health   → {"ok":true,"db":"ok"}
typical boot       a few seconds after install; the first page request compiles it (another few seconds)

Nothing here needs network once `pnpm install` has run: no auth, no external APIs, no keys.

## Environment
DATABASE_PATH      the SQLite file; default ./data/app.db. Always set it to a fresh file per run.
PORT               default 3000

Node prints `ExperimentalWarning: SQLite is an experimental feature`; that line is noise.

## The app
One page, `/`, titled "Board", with three columns in order: "To do", "In progress", "Done".
- each column is a region named by its heading, e.g. "To do (3)"; cards are listed top to bottom by position;
- a form "Add card" at the top of "To do": Title required, at most 80 characters; Description optional, at most 1000;
- submitting redirects to `/?added=<id>`, which shows the flash "Card added" and the card at the bottom of "To do";
- an invalid submission redirects to `/?error=<message>` and shows the message.

## Selectors
by role/label      getByRole("region", { name: /^To do/ }), getByLabel("Title"), getByLabel("Description"),
                   getByRole("button", { name: "Add card" }), getByRole("listitem", { name: "<card title>" })
board / column     [data-testid=board] / [data-testid=column] (each has data-column=todo|in_progress|done)
form               [data-testid=card-form]
title / desc       [data-testid=card-title] / [data-testid=card-description]
submit             [data-testid=card-submit]
one card           [data-testid=card]   (each has data-card-id=<id>; its accessible name is the title)
flash              [data-testid=flash]
form error         [data-testid=form-error]
move, limit, delete: see docs/specs/move-and-limit.md (only once it is built)

## Database
One table:
cards(id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      "column" TEXT NOT NULL DEFAULT 'todo' CHECK ("column" IN ('todo','in_progress','done')),
      position INTEGER NOT NULL, created_at TEXT NOT NULL)
position orders cards within a column (new cards get max + 1). created_at is an ISO-8601 UTC string.
Migrations run on boot (`PRAGMA user_version` counts them). The file is in WAL mode, so reading it while the
server runs is safe.

## Setup macros (SETUP only)
pnpm db:reset          delete the file and create an empty schema
pnpm db:seed           add three cards to "To do", positions 1-3: "Write the onboarding email",
                       "Fix the login timeout", "Plan the team offsite"

## Check probes (CHECKER only)
sqlite3 "$DATABASE_PATH" 'select id, title, description, "column", position, created_at from cards order by id'
sqlite3 "$DATABASE_PATH" "select \"column\", position from cards where title = '<the card title>'"

A card on screen is not proof it was saved: always confirm the row.
