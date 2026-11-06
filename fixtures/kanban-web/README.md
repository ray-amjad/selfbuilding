# Board

A small Next.js (App Router) app with one page: a board with three columns, "To do", "In progress" and "Done",
whose cards are stored in SQLite. A form at the top of "To do" adds a card. It exists so agents have a real web
app with a form and a database to extend and verify in a browser.

Needs Node 22.13 or newer (it uses the built-in `node:sqlite`, so there is no native dependency to compile).

```sh
pnpm install --frozen-lockfile
pnpm db:reset && pnpm db:seed     # a fresh database with three cards in "To do"
pnpm dev                          # http://localhost:3000 (PORT overrides)
```

| Script | What it does |
|---|---|
| `pnpm dev` | development server on `0.0.0.0:${PORT:-3000}` |
| `pnpm build` / `pnpm start` | production build and server |
| `pnpm db:reset` | delete the database file and create an empty one |
| `pnpm db:seed` | add three cards to "To do" |
| `pnpm test` | `node --test` over the database module (no browser, no server) |

The database file is `DATABASE_PATH` (default `./data/app.db`). The schema is created on boot.
`GET /api/health` answers `{"ok":true,"db":"ok"}` once the database responds.

Not built yet: moving cards, a work-in-progress limit and deleting cards. The spec is
`docs/specs/move-and-limit.md`. The facts an automated verifier needs are in `.selfbuilding/verify/README.md`.
