# Verifying flows

Tests passing is not the same as a change working for a user. `Verify` boots the app on a fresh database, drives a
flow in a headless browser the way a user would, then checks the database, the server log and the evidence before
it writes a verdict. `FindFlows` works out which flows a diff touches, and `verifyFlows` puts the two together with
a build and a review.

All three come from `@selfbuilding/agents`. Verify needs the browser, which lives in the Codex image (and the
all-harnesses image), at size `medium` or larger.

## FindFlows

```ts
const found = await FindFlows(
  { change: build.result.summary, maxFlows: 4, target: { kind: "diff", base: "main" } },
  { sandbox: fork, harness: claude },
);
```

It reads the diff (written to `/selfbuilding/in/diff.patch`), changes nothing, and returns at most `maxFlows`
(default 6, at most 10) flows: new ones first, then changed ones, then the nearest regression. Each flow has a
`name`, the `endState` a user reaches, the `rows` the app must write, its `kind` (`new`, `changed`, `regression`),
the `entry` where a user starts and `why` it is affected. A diff with nothing to run gives an empty list and
`noRunnableSurface: true`. `target` is optional on a shared handle or a fork, where the handle's branch is read
against its base.

## Verify

```ts
const v = await Verify(
  { change: "Notes can be marked done.", flows: [{ name: "mark a note done", endState: "the note shows struck through after a reload", rows: ["notes.done = 1"] }] },
  { sandbox: fork, harness: gpt },
);
```

Three roles run in turn. **Setup** boots the app on a fresh database and waits (bounded) for it to answer.
**The verifier** drives each flow only through the browser tools, as a user: no curl, no SQL, no scripts.
**The checker** reads the database, the server log and the evidence, and writes the verdict. The checker can lower
the verifier's claim, never raise it; callers route on `outcome`, never on the claim.

Verify reads `.selfbuilding/verify/README.md` in the repository first (app folder, install and boot commands,
port, readiness URL, reset and seed commands, selectors, how to query the database). Pass `appNotes` when the
repository has none. Its defaults are harness Codex, size `medium` and the browser MCP server; the size applies to
a fresh box only, and a fork keeps its parent's size.

### The four outcomes

| Outcome | Means |
|---|---|
| `verified` | The end state is visible to the user and the expected rows exist |
| `broken` | The app booted but the flow failed, or the rows are wrong, even if the page looked right |
| `could_not_boot` | No readiness within five minutes; the server log is attached |
| `unverifiable` | Nothing runnable, or a dependency that cannot be faked |

`defects` lists what was seen and where, with the evidence for each.

### Evidence

Each flow writes to `/selfbuilding/out/files/verify/<slug>/` (the slug is the name lowercased, with runs of other
characters turned into `-`, at most 48 characters):

```
setup.json        setup's facts (db path, url, seeded ids)
claim.json        the verifier's claim
verdict.json      the checker's verdict
evidence.md       the evidence file: steps, what was seen, links to the files below
screenshots/NN-<step>.png
db.txt            the checker's queries and rows
server.log        the last 64 KiB of the dev server log
trace.zip         optional
```

`evidence` in the result is the path of `evidence.md`; `evidenceFiles` lists the rest. Everything under
`/selfbuilding/out/files/` is collected into the result's `artifacts.files` and stored in the run's artifact store
(R2 or S3 in production; see [artifacts-r2-s3.md](artifacts-r2-s3.md)).

## verifyFlows

```ts
import { createVerifyFlows, CodeReview, FindFlows, ImplementSpec, Verify } from "@selfbuilding/agents";

export const verifyFlows = createVerifyFlows({
  agents: { ImplementSpec, CodeReview, FindFlows, Verify },
  builder: { harness: claude, size: "medium" },
  reviewer: { harness: claude },
  finder: { harness: claude },
  verifier: { harness: gpt },
  pullRequests: config.git?.pullRequests, // open the PR and write the summary into it
});
```

The factory, named `verify-flows`:

1. Builds the spec with `ImplementSpec` in a shared box (size `medium` by default). It stops with
   `build_incomplete` unless the build is done.
2. Runs `CodeReview` and `FindFlows` in parallel, each on its own fork of the build box. A failed review or flow
   search does not stop the run.
3. Verifies each flow (`input.flows`, else what FindFlows found) in a pipeline, each on its own fork, so every
   verifier starts from the built tree. A failed Verify call becomes an `unverifiable` verdict with its `error`.
4. Renders the summary, stores it, posts it, and writes it into the PR.

Input: `repo`, `spec` (text or `{ path }`), and optionally `baseBranch`, `testCommand`, `appNotes`, `flows` and
`maxFlows`. Output `status`: `all_verified` (at least one flow, all verified), `some_failed`, `no_flows` or
`build_incomplete`, with the branch, the PR, the build, the review and one verdict per flow.

## The summary page

`renderRunSummary(input)` is pure and returns three renderings of one table, one row per flow with ✅ (verified),
❌ (broken) or ⚠️ (could not boot, unverifiable) and links to its evidence:

- `markdown`, which verifyFlows writes into the PR body as the `## Verification` section;
- `slack`, Slack blocks posted to the run's notify channels with a link to the page, also in AFK mode (AFK means
  no one answers questions, not silence);
- `html`, one self-contained page (inline CSS, no script) with each flow's detail, its `evidence.md` and its
  screenshots embedded up to 512 KiB each, stored as `runs/<runId>/summary.html` in the artifact store.

Links are signed when the message is posted (7 days for the page) and never stored.

## Testing it

`tests/acceptance/11-verify-flows.test.ts` runs the whole factory offline on a scripted harness.
`tests/live/9-verify-web.test.ts` runs Verify against the playground's Notes app: `verified` on `main`, `broken`
on a branch with a planted bug where the page looks right but no row is written. `tests/live/10-verify-flows.test.ts`
runs verifyFlows end to end.
