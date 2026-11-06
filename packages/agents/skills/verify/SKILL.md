---
name: verify
description: Prove a web-app change actually runs for a real user, against a real isolated database and a real browser, instead of reading the diff or trusting unit tests. Three roles in a row (setup boots and seeds, the verifier drives each flow as a user, the checker reads the database, logs and evidence and writes the verdict), one evidence file per flow, and one of four outcomes per flow.
---

# Verify a change end to end

**Goal:** for every flow, one evidence file that proves the change runs for a real user, plus a
checker's verdict in one of four outcomes the caller routes on: `verified`, `broken`,
`could_not_boot` or `unverifiable`.

**This skill is for a web app.** It boots the app in this sandbox on a fresh database, drives it
through the `browser` MCP tools (headless Chromium) and confirms the result in the app's own
database. Never call unit tests "verified", and never report a flow you did not drive.

**This is a read-only task for the repository.** Never edit, commit or stage tracked files, not even
to make a flow reachable. Point the app at a service with an environment variable instead. Put
everything you produce under `/selfbuilding/out/files/verify/`. Before you submit, restore any
tracked file the boot changed (`git checkout -- <path>`) and remove untracked files it left that
are not ignored, so `git status --porcelain` is empty.

## 1. Read the project's own facts first

```bash
cat .selfbuilding/verify/README.md     # app dir, install, boot, port, readiness URL, reset/seed, selectors, DB probe
```

Say in `summary` which branch you took: *using the repo's verify facts*, or *no verify facts here,
discovered the boot myself*. A silent fallback hides a broken contract. `references/project-facts.md`
has the folder's contract; when it is absent, include a draft of it in your evidence directory.

## 2. The flows, and where each one's files go

The input's `flows` name what to prove. Each flow names the **end state** the user reaches, the
**rows** the app must write, and the **side effects** outside the app (an email, a webhook, a queued
job). A named side effect that is missing is a failure unless it is marked `optional`.

With no `flows` in the input, derive them from the diff (`git diff <base>...HEAD`): one flow for the
changed behaviour, plus the nearest flow the change could break. If the change has no runnable
surface (docs, CI config, types only, a pure refactor), say so in `summary`, submit an empty
`flows` list, and stop.

**Every flow has its own directory**, named by its slug: the flow's name lowercased, every run of
characters other than `a-z0-9` replaced by one `-`, trimmed of `-`, at most 48 characters.
"Add a note" is `add-a-note`. Compute it, never improvise it:

```bash
slug() { tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-48 | sed -E 's/-+$//'; }
F=/selfbuilding/out/files/verify/$(printf '%s' "add a note" | slug); mkdir -p "$F/screenshots"
```

```
/selfbuilding/out/files/verify/<slug>/
  setup.json            setup's facts: app_url, readiness_url, database_path, server_log, booted, seeded ids
  claim.json            the verifier's claim
  verdict.json          the checker's verdict
  evidence.md           THE evidence file: steps, what was seen, links to the files below
  screenshots/NN-<step>.png
  db.txt                the checker's queries and the rows they returned
  server.log            the last 64 KiB of the dev server log
  trace.zip             optional
```

The result's `evidence` is the flow's `evidence.md`; `evidenceFiles` lists every other file above
that exists; `files` lists all of them. Everything under `/selfbuilding/out/files/` is collected
and stored with the run.

## 3. Three roles, and a door between each

| Role | Scripts? | Owns | Writes |
|---|---|---|---|
| **Setup** | **yes**: writes state through app internals | a fresh database, shims for external services, the boot, the seed | `setup.json` |
| **Verifier** | **no**: only the `browser` MCP tools | the clicks, keystrokes, screenshots | `claim.json` (a **claim**), the screenshots and `evidence.md` |
| **Checker** | **yes**, read-only | the judgement: database, server log, side effects, evidence | `db.txt`, `server.log`, `verdict.json` (the **verdict**) |

Run them in this order, per flow: setup, verifier, checker. **The door is one question: could a
real person do this with a mouse, a keyboard, their inbox or their phone?** Reading a one-time code
from a mailbox and uploading a file are fine. SQL, `curl`, a script, a forged cookie, or a direct
API call with no UI in between are not: they belong to setup or the checker. A verifier with setup
powers produces a pass that looks exactly like a real one.

**Keep the roles apart.** Where your harness has a subagent tool, run setup and the checker as
fresh subagents, and give the checker only the files (`setup.json`, `claim.json`, the evidence and
the screenshots), never the verifier's reasoning, so it judges instead of agreeing. Where it has
none, play the roles in order, and as the checker re-read the files from disk rather than trusting
what you remember. The three prompt blocks in `references/prompt-blocks.md` are the rules each role
carries; paste them, never paraphrase them.

### 3a. Setup: scripts allowed, the flow forbidden

1. **A fresh, isolated database per flow.** For an app on an embedded database (SQLite), the
   database is a file: `DATABASE_PATH=/tmp/verify-<slug>.db`. Delete it if it exists, then run the
   app's own reset, migrate and seed commands against it. For a database server, start one for this
   run and create an empty database. Never point a flow at a shared or production database.
2. **Every external service a flow touches gets a real value or a shim, before the boot.** Work the
   ladder in the `MISSING DEPENDENCY POLICY` block (`references/prompt-blocks.md`).
3. **Install, then boot detached, with a bounded wait** on the readiness URL, so a dead boot fails
   in five minutes instead of hanging:

   ```bash
   S=$(printf '%s' "add a note" | slug)            # the flow's slug
   cd web && pnpm install --frozen-lockfile        # the app dir and installer from the facts file
   export DATABASE_PATH=/tmp/verify-$S.db PORT=3000
   rm -f "$DATABASE_PATH" && pnpm db:reset && pnpm db:seed   # the facts file's reset and seed commands
   setsid nohup pnpm dev > /tmp/verify-$S.server.log 2>&1 < /dev/null &
   timeout 300 bash -c 'until curl -sf http://127.0.0.1:3000/api/health; do sleep 3; done' \
     && BOOTED=true || BOOTED=false
   ```

   No answer within 300 seconds is `could_not_boot`: copy the log's tail to `server.log`
   (`tail -c 65536`), write `setup.json` with `"booted": false`, and go straight to the checker.
4. Write `setup.json`, the only thing the next two roles learn from setup:

   ```json
   {"app_url": "http://127.0.0.1:3000", "readiness_url": "http://127.0.0.1:3000/api/health",
    "database_path": "/tmp/verify-add-a-note.db", "server_log": "/tmp/verify-add-a-note.server.log",
    "booted": true, "seeded": {"notes": [1, 2, 3]}, "shims": [], "external": []}
   ```

Setup never touches the flow, not even to "just check" a button: the evidence would then start from
a state no user reached. Between flows that must not share data, stop the server (kill it by its
port and confirm the port is free), and boot again on the next flow's own database.

### 3b. Verifier: a user, with the browser and nothing else

Drive the flow only through the `browser` MCP tools, exactly as a person would, following
`VERIFIER SCOPE` and then `STRUCTURED RESULT` from `references/prompt-blocks.md`.
`references/browser-flow.md` has the tool list, the traps and the screenshot rule.

- Open `app_url` from `setup.json`. Read the page with a snapshot, click and type what a person
  would, and wait for the destination the flow names.
- **A screenshot per step**, named `<slug>/screenshots/NN-<step>.png` (`01-open`, `02-filled`,
  `03-submitted`), with the end state or the failed step last. **A failed step is the most valuable
  frame.**
- Write `evidence.md`: one line per step, what you did, what you saw, and its screenshot as a
  relative link (`![submitted](screenshots/03-submitted.png)`). Then write `claim.json`.
- **A service missing mid-flow is `could_not_boot`, naming the service.** The verifier installs
  nothing. Send setup back for the shim, then drive the flow once more. One extra round, no more.

### 3c. Checker: read-only, and it may only lower a claim

It reads, in order, and records each query with its output in `db.txt`:

1. **The database**: the row the flow should have written, with the app's own database tool
   (`sqlite3 "$DATABASE_PATH" 'select id, title, done from notes order by id desc limit 5'`).
   A page can show what the database never stored; the row cannot lie.
2. **The server log** over the flow's window: copy its last 64 KiB to `server.log`. A 200 over a
   stack trace is `broken`.
3. **Each side effect the flow names**, through its shim's API (mailbox, queue, webhook log). Missing
   and not `optional` is `broken`; missing and `optional` is a `defects` entry. A side effect the
   flow did not name is not judged; say so in `checked`.
4. **The evidence**: the last screenshot shows the claimed state; a failed step is captured.
5. **The sandbox's health at the end**, after the flow, never during it. Then stop the server.

**The checker may lower a claim, never raise one.** A `verified` claim with no row is `broken`; a
`broken` claim stays `broken` even when the row is there. It writes `verdict.json`:

```json
{"outcome": "broken", "claim": "verified", "detail": "The page showed the note, but notes has no row titled 'Buy milk'.",
 "checked": ["notes rows after submit (db.txt)", "server.log: no errors", "03-submitted.png shows the note"],
 "defects": []}
```

`defects` holds what the flow survived (a console error, a failed call, a field that remounts while
typing). Keep an entry only with proof (a log line or a frame). A defect never changes the outcome.

## 4. The four outcomes, and what a pass is

| Outcome | Means |
|---|---|
| `verified` | the user reached the end state, it is visible on screen, the rows are in the promised shape, and every named side effect happened |
| `broken` | the app booted but the flow did the wrong thing: an error, wrong output, a page that shows a row the database does not have. **The only product defect** |
| `could_not_boot` | the flow was never reached: no readiness within five minutes (log attached), a missing service, credential or environment value. Not a code defect |
| `unverifiable` | no runnable surface, or the flow needs a dependency the shim ladder cannot fake, or a state the platform never creates |

`unverifiable` carries a burden of proof: name what cannot be produced, and at least two methods you
tried and what each did instead. Running out of ideas is `could_not_boot`.

## 5. Evidence: one flow, one file

- **A user-facing flow:** `evidence.md` in the flow's directory, each step with its screenshot and
  a caption, ending on the end state or on the failed step. A changed screen is user-facing, even
  when an API call would test it faster.
- **A flow with no UI** (a webhook, a cron job, a queue drain, an API or MCP server):
  `references/no-ui.md`. Still `evidence.md`, with the real request, the response and the database
  rows, in the order they ran.
- **Always:** an independent database read in `db.txt` showing the data landed, not only a page.

A flow described only in prose is a claim, not evidence. One evidence file per flow; never merge two
flows into one.

## 6. Hard rules

- **Never patch the app to make a flow pass.** A hardcoded vendor URL with no override is a finding,
  not a licence to edit.
- **Copy or layout change: read it rendered**, including the error, empty and signed-out states.
- **Say what you reached.** "I could not verify it" is an honest floor; a pass you did not get is not.
- Never use a real person's name, email or payment details. Use the seeded test data.

## 7. The result

Call `submit_result` once. A done check reads `claim.json` and `verdict.json` back and rejects a
result that disagrees with them, so copy, never restate:

- `flows`: one entry per flow, with `name`; `outcome` exactly as in `verdict.json`; `claim` exactly
  as in `claim.json` (omit it only when the verifier never ran); a one-or-two-sentence `detail` (for
  a failure: the failing step, observed against expected); `evidence`, the absolute path of the
  flow's `evidence.md`; `evidenceFiles`, the absolute paths of the flow's other files; what the
  checker read in `checked`; and its `defects`.
- `files`: every evidence path, `evidence.md` and the `evidenceFiles` of every flow.
- `summary`: which facts branch you took, then one line per flow in its outcome word.
