# Live Trigger.dev project

A minimal Trigger.dev v4 project for `tests/live/7-trigger.test.ts` (under `trigger.dev dev`) and
`tests/live/15-trigger-deployed.test.ts` (deployed). `src/selfbuilding.ts` exports the three tasks from
`createTriggerHost` (`selfbuilding.factory`, `selfbuilding.agent`, `selfbuilding.reaper`) and two factories: `hello`,
which makes two agent calls at once, and `run-script`, the factory `start_workflow` launches. Each call runs as its own `selfbuilding.agent` child run: launch in a
real sandbox, wait on a waitpoint token whose URL the sandbox POSTs to when the turn ends, collect. The parent
accepts each result. Nothing here is published; it uses the workspace packages through `tests/live/node_modules`.

## Run it

```sh
pnpm build                                  # from the repo root
cd tests/live/trigger
node prepare.mjs                            # embeds packages/runtime/dist in src/runtime-bundles.generated.ts
pnpm dlx trigger.dev@4.8.3 dev              # registers the tasks with your project and runs them on this machine
```

Then, from the repo root, in another shell:

```sh
SELFBUILDING_LIVE=1 SELFBUILDING_LIVE_TRIGGER=1 pnpm vitest run --project live tests/live/7-trigger.test.ts
```

Run both commands through your secret manager's `run` wrapper, so every variable below reaches them from there and
never from a command line.

## Variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `TRIGGER_PROJECT_REF` | `trigger.config.ts`, the test | The project ref (`proj_...`). |
| `TRIGGER_SECRET_KEY` | the dev CLI, the test | The environment's secret key (`tr_dev_...` for `dev`). |
| `SELFBUILDING_TRIGGER_PROVIDER` | the worker | `e2b` (default) or `impello`. |
| `E2B_API_KEY`, `E2B_TEMPLATE` | the worker | As in the live README; template default `selfbuilding-claude-code`. |
| `IMPELLO_API_KEY`, `IMPELLO_TEMPLATE` | the worker | Same, for Impello. |
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | the worker | Claude Code's credential. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the worker | Optional under `dev`, required deployed: artifacts and the result store go to R2 (`R2_BUCKET`, default `selfbuilding-artifacts`; results under `<deployment>/results/`). |
| `SELFBUILDING_TRIGGER_STORE` | the worker | Result store directory when the `R2_*` variables are not set. Default `.selfbuilding/trigger`. |
| `SELFBUILDING_DEPLOYMENT` | the worker | Labels the boxes. Default `live-trigger`. |

## What the test checks

The `hello` run completes with status `ok` and both results, and the platform lists one `selfbuilding.agent` run
per call (tagged with the run id), each completed.

## Deploying instead of `dev`

`pnpm dlx trigger.dev@4.8.3 deploy` builds the same tasks, with the worker variables set in the project's
environment (sync them there from your secret manager; never type them into the dashboard by hand). A deployed
run's tasks may land on different machines, so they need a result store they all share, with create-if-absent and
compare-and-set writes. With the `R2_*` variables set, `src/selfbuilding.ts` passes
`r2ResultStoreFromEnv(process.env)`; without them it falls back to the file store, which `createTriggerHost` refuses
in a deployed environment with a `ConfigError` that names the fix.

Then, from the repo root:

```sh
SELFBUILDING_LIVE=1 SELFBUILDING_LIVE_TRIGGER=1 SELFBUILDING_LIVE_TRIGGER_DEPLOYED=1 \
  pnpm vitest run --project live tests/live/15-trigger-deployed.test.ts
```

with `TRIGGER_SECRET_KEY` for the deployed environment and the same `R2_*` variables, so the test can read the
run's records back from the bucket.
