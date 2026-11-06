# Worked example: the task lifecycle as a workflow script

`lifecycle.mjs` takes a spec to a reviewed, verified pull request and stops before any merge. It is a workflow
script (see `docs/guides/writing-a-workflow-script.md`), run by this folder's own `run-script` factory so the
script can use the project's harness logins by name. It runs against real services; nothing here runs in
`pnpm test`.

## What each phase does

| Phase | What happens |
|---|---|
| `build` | One `ImplementSpec` on Claude Code in one `medium` box (`sb.sandbox({ label: "build" })`), on a new branch, with a draft PR. A build that is not `done` ends the run with `build_incomplete`. The branch is pushed |
| `review-N` | The box is forked twice, then a Claude Code and a Codex `CodeReview` read the same diff in `sb.parallel`, each on its own fork. Confirmed findings of severity critical, high or medium are fixed now; the rest are carried |
| `fix-N` | `ImplementSpec` fixes the findings on the same box and branch, and pushes. Up to `maxReviewRounds` rounds (default 2); a round with nothing to fix ends the loop |
| `find-flows` | `FindFlows` reads the diff on a fork and returns at most `maxFlows` (default 3) user flows |
| `verify` | One fork per flow, forked before the pipeline; `Verify` on Codex drives each flow in the browser and checks the database |
| `verify-fix`, `reverify` | When a flow is `broken`: one `ImplementSpec` fix round with the defects, a push, then fresh verifiers for those flows only |
| `confirm` | One question (`merge` or `hold`, 24 h timeout) with the PR, the rounds, the carried findings and a ✅ or ❌ line per flow. The script returns; it never merges |

The return value has `status` (`verified` when every flow verified, else `needs_attention`), the PR, the branch,
the build summary, follow-ups and open questions, each round, the carried findings, every flow's verdict with its
evidence uris, and the decision.

## The PR is the record

Through `sb.pr`, the script keeps the run's state on the PR itself:

1. After each review round, one comment with the merged findings (reviewer, severity, verdict, `file:line`,
   summary; the findings to fix first, then the carried ones). It ends with the line
   `<!-- task-lifecycle-round:N stage:reviewed -->`.
2. After that round's fixes are pushed, one comment summarising the result, ending with
   `<!-- task-lifecycle-round:N stage:complete head:<sha> -->`, where `<sha>` is the PR's head after the push
   (`(await sb.pr.get(pr)).headSha`).
3. The PR body keeps three sections, each replaced in place with `sb.pr.update({ pr, section })`:
   - `## What changed and why`, after the build, from the build's summary and follow-ups;
   - `## Verified`, after verification, one line per flow, `- <✅|❌> <flow>: <outcome>, <detail>`, then its
     evidence links;
   - `## Source`, the spec the run was given, as given, in a fenced block, cut at 8,000 characters.

A resumed run never posts a comment twice: each `sb.pr` call is journaled, and comments carry a dedupe marker.
Without a PR (`build.artifacts.pr` absent) the script logs once and skips every `sb.pr` call. The markers let a
later run, or a person, find where the last run stopped by reading the PR.

## The config

`selfbuilding.config.ts` sets up:

- **Provider:** Impello, template `selfbuilding-codex`, sizes `small` and `medium` (build the medium template
  first: `selfbuilding images build --provider impello --harness codex --size medium`). Every box is a fork of the
  build box, so builder, reviewers and verifiers share its image. That image carries Codex and the browser but no
  Claude Code binary; switch the template to `selfbuilding-all-harnesses` once that template is built
  (`selfbuilding images build --provider impello --all-harnesses --size small,medium`).
- **Harnesses** (exported as `harnesses`, registered by name for the script): `claude-code` with the subscription
  token, `codex` with the leased login file `~/.codex/auth.json`.
- **GitHub:** the App broker (`docs/guides/github-app.md`), with its ruleset on the target repository.
- **Artifacts:** R2 (`docs/guides/artifacts-r2-s3.md`), so evidence links work in Slack and on the PR.
- **Journal:** `fileJournal(".selfbuilding/journal")`. Budget 30 USD and 3 h; 4 boxes at once.
- **Slack:** questions go to `SLACK_CHANNEL` (default `#factory`), timeout 24 h.
- **Script caps:** sizes `small` and `medium`, 30 agent calls, 4 sandboxes.

## Variables

Put these in your secret manager or `.env` (never committed; `.env.example` lists the names). `selfbuilding doctor`
reports any that are missing.

| Variable | Read for |
|---|---|
| `IMPELLO_API_KEY` | the provider |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code (the config uses the subscription token only) |
| `GITHUB_APP_ID` | the GitHub App |
| `GITHUB_APP_PRIVATE_KEY_FILE` | optional: path to the App's `.pem` (default `~/.config/selfbuilding/github-app.pem`) |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | the Slack channel |
| `SLACK_CHANNEL` | optional: channel id or `#name` |
| `SELFBUILDING_APPROVER` | optional: the Slack member id allowed to answer |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the artifact store |
| `R2_BUCKET` | optional: default `selfbuilding-artifacts` |

Codex reads its login from `~/.codex/auth.json` (written by `codex login`), not from a variable.

## Input

```json
{ "repo": "github.com/<owner>/<repo>", "base": "main", "spec": "<the spec text>",
  "testCommand": "pnpm test", "appNotes": "<boot facts, if the repo has no .selfbuilding/verify/README.md>",
  "maxReviewRounds": 2, "maxFlows": 3 }
```

`repo`, `base` and `spec` are required. The repository needs a runnable web app for the verify phases; the
playground fixture in `fixtures/playground-web/` is one.

## How to run it

From the repository root, `pnpm build`. Then, in this folder:

```sh
# The run-script factory takes the script source as a string: wrap it with its input.
node -e '
  const fs = require("node:fs");
  const input = { repo: "github.com/<owner>/<repo>", base: "main", spec: fs.readFileSync("spec.md", "utf8") };
  fs.writeFileSync("input.json", JSON.stringify({ name: "task-lifecycle", source: fs.readFileSync("lifecycle.mjs", "utf8"), input }));
'

../node_modules/.bin/selfbuilding doctor --env-file .env
../node_modules/.bin/selfbuilding run factories/task-lifecycle.ts --env-file .env --input @input.json
../node_modules/.bin/selfbuilding watch <runId>        # from another shell
```

Serve the hooks handler and point the Slack app at it (`docs/guides/slack-app.md`) to answer the final question
with a button, or answer from the terminal with `selfbuilding answer <runId>`. The run exits with code 6
(`waiting`) if the question goes cold; `selfbuilding resume <runId>` picks it up after the answer. `input.json` and
`.env` are git-ignored.
