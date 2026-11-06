# @selfbuilding/host-trigger

The Trigger.dev v4 host (spec §7.5.1, §7.12.2).

```ts
// trigger/selfbuilding.ts
import { createTriggerHost } from "@selfbuilding/host-trigger";
import config from "../selfbuilding.config";
import review from "../factories/review-pr";

export const { factoryTask, agentTask, reaperTask } = createTriggerHost({ config, factories: { review } });
```

Start a run with `tasks.trigger("selfbuilding.factory", { factory: "review", input, runId? })`. Trigger the same
`runId` again after the run ended to resume it at the next epoch. Pass `afk: true` in the payload to run with nobody
to ask: every ask resolves by its AFK policy, in the parent and in its agent children, as `selfbuilding run --afk`
does on plain Node. `triggerWorkflowLauncher` sets it for a `start_workflow` request with `afk: true`, and
`get_workflow_status` reports it.

## A result store every machine can reach

A deployed run's tasks land on different machines, so the run record, step values, outcomes, fences, the child
registry and asks must live somewhere they all reach, with create-if-absent and compare-and-set writes. Use an
S3-compatible bucket:

```ts
import { r2ResultStoreFromEnv } from "@selfbuilding/artifacts-s3";

export const { factoryTask, agentTask, reaperTask } = createTriggerHost({
  config,
  factories: { review },
  store: r2ResultStoreFromEnv(process.env, { prefix: "prod/results" }), // or s3ResultStore({ bucket, endpoint, ... })
});
```

`r2ResultStoreFromEnv` reads `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and optionally `R2_BUCKET`.
Put them in your secret manager or `.env` and sync them to the Trigger.dev environment from there. Before the first
task runs, the host checks that the bucket honours `If-None-Match: *`; a bucket that does not is refused with a
`ConfigError`.

The default `fileResultStore(".selfbuilding/trigger")` and `memoryResultStore()` only work where every task runs on
one machine: `trigger.dev dev` and tests. In a deployed environment (`ctx.environment.type` other than
`DEVELOPMENT`) every task refuses them with a `ConfigError` that says to pass `r2ResultStoreFromEnv(process.env)` or
`s3ResultStore`.

## How a run maps onto Trigger.dev

- **`selfbuilding.factory`** runs the factory body. No `agent()` call is a wait in the parent: each one triggers a
  `selfbuilding.agent` child (idempotency key `ns:<runId>:<stepKey>:e<epoch>`, global scope) and registers a waiter
  with an in-process scheduler. When the body can make no progress, the scheduler holds the run's one wait, on the
  `selfbuilding.wake` input stream, then reconciles every waiter from the truth: the child's result record, the run
  status, the ask record, the clock. `Promise.all`, `parallel()` and `pipeline()` therefore work unchanged.
- **`selfbuilding.agent`** runs launch → wait → collect. The wait is `wait.forToken` on one token per armed wait
  (`ns:<runId>:<launchId>:done:w<rearm>`), whose URL is handed to the sandbox as its wake target. Accept runs in the
  parent. Agent asks wait on the ask's own token (idempotency key: the ask id) in slices of `askSliceMs` (default
  10 minutes). After each slice the child re-reads the ask store, so an answer whose token completion got lost costs
  at most one slice. Each later slice gets its own token (`<askId>:s<n>`), and the open ask's waitpoint moves to it.
  When the turn ends waiting, the child marks the ask `cold` in the store (compare-and-set on `open`), and the answer
  resumes the session as the next launch.
- **Across the task boundary** the child gets the parent run's `start_workflow` launch depth, so the grants it mints
  carry depth + 1. It reports the box time of each launch (`usage.sandboxMs` and `sandboxVcpuMs`), which the parent
  adds up. Before the first dispatch, the parent registers the call's harness credentials and declared secrets with
  the run's redactor, so `redactForRun` in the parent scrubs them too.
- **`selfbuilding.reaper`** runs `reap()` on `*/2 * * * *`. Its host repairs a lost callback by completing the
  launch's token and ticking the parent.
- **One durability system.** Step, clock and agent-accept values live in the result store (`ResultStore`), written
  create-if-absent: epoch records under `runs/<runId>/e<epoch>/accepted/`, successes also under `runs/<runId>/cache/`.
  `resultStoreJournal()` reads the same records as a `JournalStore`, so the reaper and `run()` see no second journal.
- **Cancellation** cancels the run's children, marks its open asks cancelled and kills its sandboxes by the
  `selfbuilding.run` label (an agent child kills only its step's boxes).

## Contract with core

- `run(factory, input, { runId, host, journal })` honours `RunOptions.host`: on a host with `dispatchAgent`, each
  agent call on a fresh box is sent there as plain JSON (`HostAgentCall`), and accept (done checks, follow-up turns,
  the pull request, the journal entry, disposing of the box) runs in the parent on the returned `RawOutcome`. Calls
  on a shared handle stay in the parent, whose handle holds the box.
- The agent child drives core's `agentCallDriver({ config, store, asks, registry, agents })`. It rebuilds the call
  from the JSON plus this worker's values: providers and harnesses by id (`config.sandbox`, `config.harness`, then
  `createTriggerHost({ registry: { providers, harnesses } })`), skills by name (`createTriggerHost({ agents })`, else
  the folder the parent loaded them from). A missing id is a `ConfigError` naming the registration; a skill whose
  files changed is a `NonDeterminismError`. Pass `createTriggerHost({ driver })` to replace it.

## Calls on a shared handle

A call on a `sandbox()` handle (or a fork, or a box restored from a snapshot) runs in the `selfbuilding.factory`
task, not in a child. The handle keeps the box's busy lock, its working tree, its checkpoint chain and the
credential files staged in it, and those cannot be split across two processes safely
(`docs/decisions/0002-shared-handles-on-trigger.md`). The first such call in a run logs
`shared-handle call runs in the parent task: …` at `info`, once. The call waits by long-polling the box from the
parent, so that time counts against the parent's `maxDuration` (300 s per attempt). Put long work on fresh boxes,
which wait on waitpoint tokens and use no compute while they wait.

## Testing offline

`createLocalTrigger()` is an in-process stand-in for the platform: runs, idempotency keys, waitpoint tokens, input
streams, retries and schedules, on a virtual clock. Token URLs are served on 127.0.0.1, so a box on this machine
POSTs its wake to them as it would to Trigger.dev (`serveTokens: false` turns that off). `crash()` kills every executing attempt while the server state
survives; `restart()` re-runs each unfinished run from the top, as a Trigger.dev retry does. It enforces one wait per
run. Pass it as `createTriggerHost({ trigger })`, with `memoryResultStore()` as the store.
`createLocalTrigger({ environment: "PRODUCTION" })` plays a deployed project, so the host refuses the local stores
there as it would on Trigger.dev.
