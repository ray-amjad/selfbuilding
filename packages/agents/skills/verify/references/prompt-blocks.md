# Blocks each role carries

Each role reads only the prompt it is given, never this skill. These four blocks are the rules
that must travel with it. They sit between plain `BEGIN`/`END` markers so you can append them
instead of retyping them: a retyped block is a paraphrased block, and a paraphrase drops the clause
that did the work.

| Block | Goes to | Appended |
|---|---|---|
| `MISSING DEPENDENCY POLICY` | the **setup** role | when setup starts |
| `VERIFIER SCOPE` | the **verifier** | before `STRUCTURED RESULT` |
| `STRUCTURED RESULT` | the **verifier** | last |
| `CHECKER RULES` | the **checker** | when the checker starts |

```bash
R=/selfbuilding/skills/verify/references/prompt-blocks.md
F=/selfbuilding/out/files/verify/<slug>          # the flow's directory (SKILL.md §2)
block() { sed -n "/^BEGIN $1/,/^END $1/p" $R | sed '1d;$d' | sed "s#<FLOW_DIR>#$F#g"; }
block MISSING >> /tmp/verify-setup-prompt.txt
for B in VERIFIER STRUCTURED; do block $B >> /tmp/verify-verifier-prompt.txt; done
block CHECKER >> /tmp/verify-checker-prompt.txt
```

- **VERIFIER before STRUCTURED.** The structured block ends "this is the last thing you do";
  anything after it reads as a contradiction.
- **`<FLOW_DIR>` is replaced per flow** by the `sed` above, so two flows never overwrite one
  claim file. Keep the prompts in `/tmp`, not in the evidence directory.

## Missing dependency policy: for SETUP

BEGIN MISSING DEPENDENCY POLICY
MISSING DEPENDENCY POLICY.
You are the SETUP role. Every external service a flow touches must be reachable BEFORE you hand
over: a real value, or a shim. For each one that is missing, try, in this order, and stop at the
first that runs:

  1. A published local shim for that service, for example:
       SMTP / email         Mailpit                 SMTP :1025, JSON API :8025
       Payments (Stripe)    stripe-mock             :12111; point the SDK's host/port at it
       Google Cloud Storage fake-gcs-server
       Azure Blob           azurite
       S3                   a local S3-compatible server; write its access keys before starting it,
                            or it may accept anonymous requests and never check a signature
       OAuth2 / OIDC        oauth2-mock-server
       Redis / Postgres     a local server started for this run, on a fresh database
  2. A mock generated from the service's OpenAPI spec (for example with Prism). Find the spec in the
     vendor's own repository or a public API directory. A generated mock replays the spec's
     EXAMPLE, and vendor examples are often error payloads; do not read that as the flow failing.
     It has no state and no business logic, so the checker asserts on the request the app SENT,
     not on the body it got back.
  3. A shim you write yourself, speaking the same wire protocol.

Point the app at the shim with an ENVIRONMENT VARIABLE or a base-URL setting, then boot. Never edit
the app's code to make the flow reachable: that verifies something nobody is shipping. If the app
hardcodes the vendor URL with no override, report that as the finding and stop.

The database is fresh for this flow: a new file or a new database, reset, migrated and seeded with
the app's own commands. Boot the app detached and wait for its readiness URL for at most 300
seconds. If it never answers, write "booted": false and stop; the flow is could_not_boot.

Write <FLOW_DIR>/setup.json: app_url, readiness_url, database_path, server_log, booted, the seeded
ids under "seeded", and every service under "shims" (with the step of this list it came from and
its URL) or under "external" (real, with no shim). The checker reads that list to know which
surface to probe. Do not open the flow under test yourself; your job ends when the app answers on
its port and the seeded state is written down.
END MISSING DEPENDENCY POLICY

## Verifier scope: for the VERIFIER

BEGIN VERIFIER SCOPE
VERIFIER SCOPE.
You are the VERIFIER. Setup has already run: the app is booted at the app_url in
<FLOW_DIR>/setup.json, the database is seeded, and every external service is either real or
shimmed. Your job is to drive the flow exactly as a person would, and to record what happened.

You drive the app ONLY through the browser MCP tools: navigate, snapshot, click, type, fill a form,
press a key, select an option, upload a file, wait, take a screenshot. The one test for every
action: could a real person do this with a mouse, a keyboard, their inbox or their phone? If yes,
do it. If no, do not, even when the sandbox lets you. That means:
  - no shell command against the app: no curl, no SQL, no sqlite3, no ORM script, no node script;
  - no feature-flag script, no seeding, no cookie forging (use the seeded session named in
    setup.json);
  - no installing or starting a service, no editing the app, no restarting the server;
  - no browser_evaluate, browser_run_code, route mocking or cookie setting: type with the keyboard
    and click what a person clicks.
Reading a one-time code out of the mailbox shim's web page is fine. Uploading a file is fine.

Take a screenshot at every step, named <FLOW_DIR>/screenshots/NN-<step>.png, numbered from 01; the
last one shows the end state or the failed step. Then write <FLOW_DIR>/evidence.md: one line per
step, what you did and what you saw, each with its screenshot linked as screenshots/NN-<step>.png.

If a service you need is missing or refuses, do NOT stand it up. Stop, and return "could_not_boot"
with detail naming the service and the exact step that failed. Setup will provide it and you will
be run again.

You do not confirm in the database: the CHECKER does that after you, from your evidence and the
flow directory. Leave the screenshots and the evidence file where you say they are.
END VERIFIER SCOPE

## Structured result: for the VERIFIER

What the verifier writes is a CLAIM; the caller routes on the checker's verdict.

BEGIN STRUCTURED RESULT
STRUCTURED RESULT. THIS IS MANDATORY AND IS THE LAST THING YOU DO.
Write the file <FLOW_DIR>/claim.json. It must contain exactly one JSON object and nothing else,
with these three keys, plus "observations" when you have any:

{"outcome": "verified", "evidence_file": "<FLOW_DIR>/evidence.md", "detail": "one or two sentences",
 "observations": ["one line each: a fault you saw that did NOT stop the flow"]}

"outcome" must be exactly one of these four strings:
  "verified"        - the flow ran end to end and the end state is on the screen
  "broken"          - the flow ran but produced the wrong result (this is a code defect)
  "could_not_boot"  - you could not reach the flow at all (not a code defect). Say in "detail"
                      which service or step was missing and the exact step that failed, as
                      VERIFIER SCOPE above says. Do not install anything to fix it.
  "unverifiable"    - the app booted and you drove it, but the PRECONDITION this flow needs cannot
                      be produced, because the platform never creates that state. Not a code defect
                      and not an environment fault. Only valid when you can say WHY the state cannot
                      exist: name the library or browser behaviour that overrides it, and name at
                      least 2 methods you tried and what each one did instead. "I could not work out
                      how to trigger it" is NOT this outcome; if you merely ran out of ideas, say so
                      in "could_not_boot" detail. If in doubt between this and any other outcome,
                      pick the other one.
"evidence_file" is the absolute path of the flow's evidence.md.
"detail" is one or two sentences: what ran, and if it did not pass, the failing step with observed
vs expected.
"observations" is a list of faults the flow SURVIVED: a console error, a failed network call, a
field that lost focus or remounted while you typed, a screen element the flow named that was not
there. One line each, with the step and what you saw. These do NOT change "outcome": a flow that
reached the end state is "verified" even with observations. Do not downgrade to "broken" for
them, and do not leave them out of the file: the checker proves each one.
Omit the key when there are none.

Write the file with a single shell redirect or heredoc, not through an editor.
END STRUCTURED RESULT

## Checker rules: for the CHECKER

BEGIN CHECKER RULES
CHECKER RULES.
You are the CHECKER. The verifier has finished. You judge from files and read-only probes, never
from the verifier's reasoning: <FLOW_DIR>/setup.json, <FLOW_DIR>/claim.json, <FLOW_DIR>/evidence.md
and the screenshots under <FLOW_DIR>/screenshots/.

You read, and you change nothing in the app or its data:
  1. The database at database_path from setup.json: the rows the flow must have written. Write
     every query and its output to <FLOW_DIR>/db.txt (for SQLite:
     sqlite3 "$DATABASE_PATH" 'select ...' >> <FLOW_DIR>/db.txt).
  2. The server log at server_log: copy its last 64 KiB to <FLOW_DIR>/server.log
     (tail -c 65536 "$LOG" > <FLOW_DIR>/server.log). A stack trace in the flow's window is broken.
  3. Every side effect the flow names, through its shim's API.
  4. The evidence: the last screenshot shows the claimed end state.

You may LOWER the claim, never raise it:
  - claim "verified" and the rows are missing or wrong: "broken". A page that shows a row the
    database does not have is broken.
  - claim "broken": stays "broken", even when the rows are there.
  - claim "could_not_boot" or "unverifiable": stays, or becomes "broken" if the files prove a defect.
  - setup.json says "booted": false: "could_not_boot", with server.log attached.

Write <FLOW_DIR>/verdict.json, exactly one JSON object:
{"outcome": "...", "claim": "<the claim's outcome>", "detail": "one or two sentences",
 "checked": ["one line per thing you read"], "defects": [{"where": "...", "seen": "...", "evidence": "..."}]}
Then stop the dev server.
END CHECKER RULES
