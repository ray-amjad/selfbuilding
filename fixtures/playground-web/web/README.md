# Notes

A small Next.js (App Router) app with one page: a list of notes stored in SQLite and a form that adds one.
It exists so agents have a real web app with a form and a database to build on and verify.

Needs Node 22.13 or newer (it uses the built-in `node:sqlite`, so there is no native dependency to compile).

```sh
pnpm install --frozen-lockfile
pnpm db:reset && pnpm db:seed     # a fresh database with three notes
pnpm dev                          # http://localhost:3000 (PORT overrides)
```

| Script | What it does |
|---|---|
| `pnpm dev` | development server on `0.0.0.0:${PORT:-3000}` |
| `pnpm build` / `pnpm start` | production build and server |
| `pnpm db:reset` | delete the database file and migrate an empty one |
| `pnpm db:seed` | add three notes |
| `pnpm test` | `node --test` over the database module (no browser, no server) |
| `pnpm smoke` | after `pnpm build`: boots `next start` on a fresh database, checks the health route, submits the form, checks the row |

The database file is `DATABASE_PATH` (default `./data/app.db`). Migrations run on boot. `GET /api/health`
answers `{"ok":true,"db":"ok"}` once the database responds.

The facts an automated verifier needs (selectors, probes) are in `../.selfbuilding/verify/README.md`.
