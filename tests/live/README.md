# Live acceptance suite

The live versions of the six acceptance tests in `docs/BASIC-SCOPE.md`. They use real sandboxes (Impello, E2B,
Docker), real Claude Code and Codex, the real GitHub playground repo and a real Slack workspace. Every case
skips, printing its reason, unless the variables it needs are set. With none set, `pnpm test` runs this
project and skips all of it.

The offline versions live in `tests/acceptance/` and always run.

## Running

```sh
pnpm build
SELFBUILDING_LIVE=1 IMPELLO_API_KEY=... CLAUDE_CODE_OAUTH_TOKEN=... pnpm vitest run --project live
```

Pass values through your secret manager's `run` wrapper or an env file. Never put them in a command line that is
saved. The suite reads each credential only when a call needs it, and never prints one.

## Variables

| Variable | Needed by | Meaning |
| --- | --- | --- |
| `SELFBUILDING_LIVE` | all | `1` turns the suite on. Without it every case skips, whatever else is set. |
| `SELFBUILDING_LIVE_BUDGET_USD` | 1, 2 | The run budget in USD. Default 5. |
| `SELFBUILDING_LIVE_CONCURRENCY` | 6 | Create-path calls (`openOrCreate`, `fork`, `snapshot`) the conformance suite keeps in flight on E2B and Impello. Default 2, to stay under the vendors' create rate limits. Docker is not limited. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code cases | Subscription token. Tried first. |
| `ANTHROPIC_API_KEY` | Claude Code cases | API key. The fallback. |
| `CODEX_AUTH_FILE` | Codex cases | Path to the `auth.json` that `codex login` wrote. Tried first. |
| `OPENAI_API_KEY` | Codex cases | API key. The fallback. |
| `IMPELLO_API_KEY` | Impello cases | Impello API key. |
| `IMPELLO_TEMPLATE`, `IMPELLO_CODEX_TEMPLATE` | Impello cases | Templates for the Claude Code and Codex images. Defaults `selfbuilding-claude-code`, `selfbuilding-codex`. |
| `E2B_API_KEY` | E2B cases | E2B API key. |
| `E2B_TEMPLATE`, `E2B_CODEX_TEMPLATE` | E2B cases | As for Impello. |
| `SELFBUILDING_E2E_DOCKER` | Docker cases | `1` when a Docker daemon is reachable. The images are built locally on first use. |
| `SELFBUILDING_DOCKER_SOCKET` | Docker cases | Optional socket path. |
| `E2B_SIZES`, `IMPELLO_SIZES` | 9, 10, 11 | Comma-separated sizes whose templates are built (default `small`). Build them with `selfbuilding images build --provider e2b --size medium`, which replaces the hand-run template script. |
| `E2B_PLAN` | 11 | `pro` when the E2B account is on Pro. Default Hobby, which refuses `large`. |
| `SELFBUILDING_IMAGE_REGISTRY` | `images build`, 14 | Optional: where published selfbuilding images live (e.g. `ghcr.io/acme`); template builds start from them. Unset, templates are built from a generated Dockerfile. 14 needs it unset. |
| `SELFBUILDING_PLAYGROUND` | 1, 2 | The playground repo. Default `github.com/ray-amjad/selfbuilding-playground`. |
| `SELFBUILDING_PLAYGROUND_REVIEW_BASE`, `SELFBUILDING_PLAYGROUND_REVIEW_HEAD` | 1 | The review fixture's refs. Defaults `main` and `fixture/multiply-bug`. The head must add a bug to `src/math.js`. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE` | 1, 2 | The GitHub App and the path to its PEM key. The App needs an active branch ruleset on the playground: include `~ALL`, exclude both `refs/heads/selfbuilding/**` and `refs/heads/selfbuilding/**/*` (GitHub needs the second for nested branches), rules creation, update and deletion, with only the repository admin role as a bypass actor. |
| `GITHUB_APP_INSTALLATION_ID` | 1, 2 | Optional; looked up per repo when absent. |
| `GITHUB_PUSH_TOKEN`, `GITHUB_READ_TOKEN` | 1, 2 | Fine-grained PATs, used only when the App variables are absent. |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL` | 2, 4 | The Slack App's bot token and signing secret, and the channel id or `#name` it is in. |
| `SELFBUILDING_LIVE_SLACK_HUMAN` | 2, 4 | `1` when a person will click the buttons. Without it, test 2 runs AFK and test 4 runs only its AFK case. |
| `SELFBUILDING_LIVE_APPROVER` | 2, 4 | The Slack user id of that person. |
| `SELFBUILDING_LIVE_HOOKS_PORT` | 2, 4 | Local port of the HITL handler. Default 8787. Point the Slack App's interactivity URL at a tunnel to it. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | 8 | Cloudflare R2 S3 API credentials (an R2 API token with read and write on the bucket). Authored in Infisical. |
| `R2_BUCKET` | 8 | Optional; default `selfbuilding-artifacts`. Each run writes under `selfbuilding-live/<date>/<uuid>/`. |
| `SELFBUILDING_LIVE_FLOWS_PROVIDER`, `SELFBUILDING_LIVE_FLOWS_SIZE` | 10 | Where verifyFlows builds (`impello`, `e2b` or `docker`; default `e2b`) and the build box size (default `medium`; its template must be built). |
| `SELFBUILDING_LIVE_TRIGGER` | 7 | `1` when the Trigger.dev project in `trigger/` is running (`trigger.dev dev`) or deployed. See `trigger/README.md`. |
| `TRIGGER_SECRET_KEY`, `TRIGGER_PROJECT_REF` | 7, 15 | The Trigger.dev environment's secret key and the project ref. For 15, the key of the environment the project is deployed to. |
| `SELFBUILDING_LIVE_TRIGGER_DEPLOYED` | 15 | `1` when `trigger/` is deployed (`trigger.dev deploy`) with the `R2_*` variables set in its environment, so its result store is in R2. 15 also needs `SELFBUILDING_LIVE_TRIGGER=1` and the same `R2_*` variables locally, to read the run's records back. |
| (restart case of 4) | 4 | Uses the same Slack variables plus `SELFBUILDING_LIVE_SLACK_HUMAN=1`. It kills the host while the ask is cold, prints when to answer, and needs about two minutes after the click: the killed host's journal lease lives 60 s. |
| `SELFBUILDING_START_SECRET` | 13 | The key start grants are signed with. Authored in Infisical. |
| `SELFBUILDING_LIVE_START_URL`, `SELFBUILDING_LIVE_START_PORT` | 13 | The public tunnel URL of the start-workflow handler this suite serves on the port (default 8788). |
| `SELFBUILDING_PLAYGROUND_WEB_BROKEN` | 9 | The planted-bug branch of the web app. Default `fixture/web-broken-add`. |
| `SELFBUILDING_VERIFY_SIZE` | 9 | Overrides Verify's `medium`. |

## What each file needs

| File | Runs with |
| --- | --- |
| `1-review-pr.test.ts` | GitHub, plus each provider × harness pair (Impello, E2B × Claude Code, Codex) that is configured |
| `2-ship-change.test.ts` | Impello, E2B, Claude Code, Codex and GitHub; Slack optional |
| `3-crash-resume.test.ts` | Each configured provider × harness pair |
| `4-slack-ask.test.ts` | Slack (AFK case); plus one pair and a human for the hot and cold cases |
| `5-placement.test.ts` | Each configured pair of providers |
| `6-conformance.test.ts` | Each configured provider, once per harness image |
| `7-trigger.test.ts` | Trigger.dev, with the `trigger/` project running against one provider and Claude Code |
| `8-artifacts-r2.test.ts` | Cloudflare R2 (the three `R2_*` variables) |
| `9-verify-web.test.ts` | Codex and GitHub, once per configured provider (Impello, E2B, Docker); the playground's `web/` app on `main` and on `SELFBUILDING_PLAYGROUND_WEB_BROKEN` |
| `10-verify-flows.test.ts` | One provider (`SELFBUILDING_LIVE_FLOWS_PROVIDER`, default `e2b`) with its Codex template built at `SELFBUILDING_LIVE_FLOWS_SIZE` (default `medium`), Claude Code, Codex and GitHub; Slack (with `SELFBUILDING_LIVE_APPROVER`) and R2 optional |
| `11-sizes.test.ts` | Each configured provider (Docker, E2B, Impello) with the sizes it lists in `E2B_SIZES` / `IMPELLO_SIZES` built; checks the guest vCPUs and memory and that over-limit sizes are refused |
| `12-run-script.test.ts` | GitHub, plus each provider × harness pair that is configured: a workflow script in the QuickJS isolate, then a full replay |
| `13-start-workflow.test.ts` | One configured pair, `SELFBUILDING_START_SECRET` and a tunnel to the start-workflow handler |
| `14-images-dockerfile.test.ts` | `E2B_API_KEY` and/or `IMPELLO_API_KEY` with `SELFBUILDING_IMAGE_REGISTRY` unset: builds `selfbuilding-all-harnesses` at small from its standalone Dockerfile (moving its `default` tag), then checks both harnesses, the manifest, the wrappers and a Chromium launch in a box |
| `15-trigger-deployed.test.ts` | The `trigger/` project deployed with its result store in R2: the `hello` run's parent and children on separate machines, every record read back from the bucket, and a workflow script through the deployed `run-script` factory |
| `support/egress-probe.mjs` | Not a test. `SELFBUILDING_LIVE=1` plus `E2B_API_KEY` and/or `IMPELLO_API_KEY`; run with `node`. Probes each vendor's egress enforcement through its own SDK (docs/decisions/0001-egress-enforcement.md). |

## The browser in the Codex image

The Codex image carries headless Chromium, Playwright, the browser MCP server (`/usr/local/bin/playwright-mcp`) and
`sqlite3`. Ask for at least the `medium` size for any call that drives the browser: Chromium next to a dev server
does not fit in `small`. `packages/images/src/browser.docker.test.ts` launches the browser in a locally built
`selfbuilding/codex:<version>` and drives one page through the MCP server; it runs with `SELFBUILDING_E2E_DOCKER=1`
once that image exists (`SELFBUILDING_BROWSER_IMAGE` points it at another reference). For a cloud box, run
`BROWSER_LAUNCH_CHECK` from `@selfbuilding/images` through `box.exec` as the agent user; exit 0 means it works.

Verify (9) runs at `medium` on a fresh box. On E2B and Impello build the medium Codex template first and list it,
e.g. `E2B_SIZES=small,medium`; or set `SELFBUILDING_VERIFY_SIZE=small` to run on the existing template.
