# Working in this app

A Next.js (App Router) board with three columns, cards stored in SQLite through Node's built-in `node:sqlite`.
Node 22.13 or newer; use pnpm.

```sh
pnpm install --frozen-lockfile                 # install (no native addons to compile)
export DATABASE_PATH=/tmp/kanban-$RANDOM.db    # a throwaway database; default is ./data/app.db
pnpm db:reset                                  # delete that file and create an empty schema
pnpm db:seed                                   # optional: three cards in "To do"
PORT=3100 pnpm dev                             # http://localhost:3100, bound to 0.0.0.0 (default port 3000)
curl -sf http://localhost:3100/api/health      # ready when it answers {"ok":true,"db":"ok"}
pnpm test                                      # node --test over lib/db.js; no server, no browser
pnpm build && PORT=3100 pnpm start             # production build and server
```

- Always set `DATABASE_PATH` to a fresh file for a run and pass the same value to every command.
- The schema is created on boot. Read rows with
  `sqlite3 "$DATABASE_PATH" 'select id, title, description, "column", position, created_at from cards order by id'`
  (WAL mode, so reading while the server runs is safe). `column` is an SQL keyword: quote it.
- All data access is in `lib/db.js` (plain JavaScript so tests load it without a build); the page is
  `app/page.tsx`, server actions are in `app/actions.ts`.
- Specs for work not built yet are in `docs/specs/`. Verifier facts (selectors, probes) are in
  `.selfbuilding/verify/README.md`.
- Node prints `ExperimentalWarning: SQLite is an experimental feature`; that line is noise.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
