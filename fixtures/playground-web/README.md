# playground-web fixture

The source of the web app that the live Verify tests run against (demo-path §4.1). It is outside the pnpm
workspace on purpose, so its dependencies never join the root lockfile. This file is not published.

| Path | Published to the playground repo as |
|---|---|
| `web/` | `web/`: the Next.js Notes app (form + SQLite through `node:sqlite`) |
| `.selfbuilding/verify/README.md` | the same path: the project facts Verify reads first |
| `docs/specs/web-mark-done.md` | the same path: the new flow an agent builds ("mark a note done") |
| `web-broken-add.patch` | applied on top of `main` as branch `fixture/web-broken-add` |
| `publish.mjs` | not published: the script that does the above |

## The planted bug

`web-broken-add.patch` moves the redirect inside the database transaction. Next's `redirect()` works by throwing,
so the transaction rolls back and the row is never saved; the patch also makes the page render the new note from
the redirect's query string. In a browser everything looks right (flash, note in the list), `pnpm test` still
passes, and only reading the database shows the missing row. Verify must return `broken` for "add a note" there.

## Proving it locally

```sh
cp -R fixtures/playground-web/web /tmp/pw && cd /tmp/pw
pnpm install --frozen-lockfile        # or npm install
pnpm build && pnpm test && pnpm smoke # smoke: boots next start, submits the form, checks the row
```

For the broken variant, apply the patch from a directory that holds `web/` (`git apply web-broken-add.patch`),
rebuild, and `pnpm smoke` fails on exactly one check: "the database has row N with the submitted title".

To change the bug, edit a copy of `web/app` in a scratch git repository laid out as `web/...`, and write the
patch with `git diff > web-broken-add.patch`.

## Publishing

```sh
node fixtures/playground-web/publish.mjs                 # builds both branches in a temp clone; pushes nothing
node fixtures/playground-web/publish.mjs --push          # needs push access (token in SELFBUILDING_PLAYGROUND_TOKEN,
                                                         # GH_TOKEN or GITHUB_TOKEN, or git's own credentials)
node fixtures/playground-web/publish.mjs --remote /tmp/bare.git --push   # rehearse against a local bare repo
```

`main` keeps every file it already has; only `web/`, `.selfbuilding/verify/` and the spec are replaced.
`fixture/web-broken-add` is rebuilt from `main` and force-pushed. `SELFBUILDING_PLAYGROUND` and
`SELFBUILDING_PLAYGROUND_WEB_BROKEN` override the repository and the branch name.
