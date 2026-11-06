# Trigger.dev

The same factories that run with `selfbuilding run` can be handed to Trigger.dev v4, which keeps them running off
your machine, retries them, and holds long waits (agent turns, questions to a person) without burning compute.

```sh
npm i @selfbuilding/host-trigger @trigger.dev/sdk
```

## The tasks

`createTriggerHost` turns your config and factories into three tasks. Export all three from a file in a folder
your `trigger.config.ts` lists (`selfbuilding init --host trigger` writes `trigger/selfbuilding.ts`):

```ts
// trigger/selfbuilding.ts
import { createTriggerHost } from "@selfbuilding/host-trigger";
import { createScriptFactory } from "@selfbuilding/script";
import { r2ResultStoreFromEnv } from "@selfbuilding/artifacts-s3";
import reviewPr from "../factories/review-pr";
import config from "../selfbuilding.config";

export const { factoryTask, agentTask, reaperTask } = createTriggerHost({
  config, // needs config.deployment, e.g. "prod": hosted runs label and reap boxes by deployment
  factories: { reviewPr, "run-script": createScriptFactory({ config }) },
  store: r2ResultStoreFromEnv(process.env), // see "Deploying" below
});
```

```ts
// trigger.config.ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./trigger"],
  runtime: "node",
  maxDuration: 3600, // waits are not compute time, so this bounds the work between waits
  retries: { enabledInDev: true, default: { maxAttempts: 3 } },
});
```

| Task | What it does |
|---|---|
| `selfbuilding.factory` | Runs the factory body. Each agent call is dispatched as a child run, and the body suspends on one wait until a child, an answer or the clock moves it on |
| `selfbuilding.agent` | One agent call: launch in a sandbox, wait on a waitpoint token whose URL the sandbox calls when the turn ends, collect. Accepting the result (done checks, the PR, the journal entry) happens in the parent |
| `selfbuilding.reaper` | Runs `reap()` every two minutes: leaked boxes, overdue asks, lost callbacks |

## Running it

```sh
npx trigger.dev@4 login
npx trigger.dev@4 dev          # registers the tasks and runs them on this machine
```

Start a run from any code that has `TRIGGER_SECRET_KEY`:

```ts
import { tasks } from "@trigger.dev/sdk";

await tasks.trigger("selfbuilding.factory", { factory: "reviewPr", input: { url }, runId: "ns_review_42" });
```

`runId` is optional. Trigger the same `runId` again after the run ended to resume it at the next epoch: finished
calls replay, as `selfbuilding resume` does locally. Workflow scripts start the same way through the `run-script`
factory, or with `selfbuilding start <script> --host trigger` (it needs `TRIGGER_SECRET_KEY` and the project's own
`@selfbuilding/host-trigger`).

## What runs as a child task

- **An agent call on a fresh box** runs as its own `selfbuilding.agent` child (idempotency key
  `ns:<runId>:<stepKey>:e<epoch>`), so `parallel()` and `pipeline()` fan out across Trigger.dev runs.
- **An agent call on a shared handle** (`sandbox()` or a fork) runs in the parent task, not as a child
  (`docs/decisions/0002-shared-handles-on-trigger.md`). The first such call in a run logs one line saying so. Its
  wait is a long poll inside the parent, so it counts against the parent's `maxDuration` (300 s per attempt); use a
  fresh box for calls that can take longer. Box time on that path counts towards `sandboxVcpuMs`.
- **`step()`, `ask()` from the body, sandbox mutations and the PR** run in the parent.

The child rebuilds each call from plain JSON. Providers and harnesses are found by id: `config.sandbox`,
`config.harness`, then `createTriggerHost({ registry: { providers, harnesses } })`. Skills are found by name in
`createTriggerHost({ agents })`, else in the folder the parent loaded them from. A missing id is a `ConfigError`
naming the registration; a skill whose files changed between parent and child is a `NonDeterminismError`.

## Deploying

```sh
npx trigger.dev@4 deploy
```

A deployed run's tasks can land on different machines, so they need a result store every machine can reach,
honouring create-if-absent and compare-and-set writes. Pass one to `createTriggerHost({ store })`:

- `r2ResultStoreFromEnv(process.env)` reads `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
  optionally `R2_BUCKET`, the same names as the artifact store.
- `s3ResultStore({ bucket, endpoint, region, accessKeyId, secretAccessKey, prefix })` for any S3-compatible bucket
  that honours `If-None-Match` and `If-Match` (prefix default `selfbuilding/results`).

The local `fileResultStore` (the default, under `.selfbuilding/trigger`) and `memoryResultStore` are refused in a
deployed environment with a `ConfigError` that names this fix; `trigger.dev dev`, where every task runs on one
machine, keeps working with the file store. A bucket that ignores conditional headers is caught by a probe before
the first task runs.

Set the worker's variables (provider and harness keys, `R2_*`, Slack) in the Trigger.dev project's environment,
synced from your secret manager. They reach a value only on the next deploy.

The sandbox runtime ships as files in `@selfbuilding/runtime`. If your deployed bundle does not include them, the
first agent call fails with a `ConfigError` saying so; the live project in `tests/live/trigger/` embeds them with
`prepare.mjs` and registers them with `setRuntimeBundles()`.

## Questions on Trigger.dev

An agent's question waits on a waitpoint token keyed by the ask id, and the answer is written to the ask store
first. In the hooks handler, wake the waiter with `createTriggerAskResolver({ trigger, store })`:

```ts
const resolver = createTriggerAskResolver({ trigger: realTriggerSdk(), store });
createHitlHandler({ channels, store: resultStoreAsks(store), approvers, resolveWaitpoint: (r) => resolver.wake(r) });
```

A worker restart or a redeploy during a wait resumes from the checkpoint and re-reads the store. AFK runs launched
through `start_workflow` carry `afk` into the factory task, so their asks resolve by policy on Trigger.dev as they
do locally.

## Cancelling

Cancelling a factory run cancels its children, marks its open asks cancelled and kills its sandboxes by the
`selfbuilding.run` label.

## Testing offline

`createLocalTrigger()` is an in-process stand-in for the platform (runs, idempotency keys, waitpoint tokens,
retries, schedules, a virtual clock, `crash()` and `restart()`). Pass it as `createTriggerHost({ trigger })` with
`memoryResultStore()`. The live project and its test are in `tests/live/trigger/`.
