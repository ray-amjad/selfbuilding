# Agent-launched workflows

An agent working in a sandbox can start a new durable run on the host: it writes a workflow script and calls the
`start_workflow` tool. The run is checked against the owner's caps, started on the host, and followed in Slack and
with `selfbuilding watch` like any other run. The contracts are in `docs/spec/demo-path.md` §8 (scripts) and §9
(this tool).

## Turning it on

Two switches, both off by default:

```ts
// selfbuilding.config.ts
export default defineConfig({
  secrets: fromEnv(),
  startWorkflow: {
    enabled: true,
    url: "https://hooks.example.com/start-workflow", // the public URL of the handler below
    allowedSizes: ["small", "medium"],
    maxBudgetUsd: 10,
  },
});

// In the factory: only this call gets the tool.
await agent({ name: "planner", prompt, output, startWorkflow: true, budget: { usd: 6 } });
```

Grants are signed with the secret `SELFBUILDING_START_SECRET` (rename it with `startWorkflow.secretName`). Put it in
your secret manager or `.env` with the other secrets; core resolves it through `config.secrets`. A call that passes
`startWorkflow: true` while `startWorkflow.enabled` is off, `url` is missing or the secret does not resolve fails
with `ConfigError` before the agent starts.

## The host side

Serve the handler next to the HITL handler:

```ts
import { r2ResultStoreFromEnv } from "@selfbuilding/artifacts-s3";
import { createStartWorkflowHandler } from "@selfbuilding/hooks";
import { realTriggerSdk, triggerWorkflowLauncher } from "@selfbuilding/host-trigger";
import { checkScript } from "@selfbuilding/script";

// Launches are recorded in a store every host process can reach (see trigger-dev.md).
const store = r2ResultStoreFromEnv(process.env, { prefix: "selfbuilding/launches" });
const launcher = triggerWorkflowLauncher({ trigger: realTriggerSdk(), store, config });

const handler = createStartWorkflowHandler({
  secret: process.env.SELFBUILDING_START_SECRET!,
  policy: config.startWorkflow ?? {},
  launcher,
  checkScript,
  notify: async (text) => console.log(text), // one message per launch; post it to Slack in production
});
```

- `POST` with `Authorization: Bearer <grant>` and a `StartWorkflowRequest` body launches. It answers the receipt,
  or the `WorkflowGuardError` (403, 401 for a bad grant) or `ScriptInvalidError` (400) as `{ error }`.
- `GET ?runId=<id>` with the same header answers the run's `WorkflowRunStatus`. A grant reads only runs its own run
  launched; a run launched locally, or with no recorded caller, is a 404 for every grant.
- Starting again with the same derived run id returns the existing run's receipt (`status: "exists"`) without
  launching it again or applying the new request's size, sandboxes or script.

Launchers:

| Launcher | Where the run goes | `active()` counts |
|---|---|---|
| `nodeWorkflowLauncher({ cwd, config })` (`import { nodeWorkflowLauncher } from "selfbuilding/launcher"`, behind `selfbuilding start`) | a detached `selfbuilding run` of the `run-script` factory, with the run id fixed up front | live script runs in `.selfbuilding/runs` and their live sandboxes, from the event files |
| `triggerWorkflowLauncher({ trigger, store, config })` (host-trigger) | `selfbuilding.factory` task with `factory: "run-script"`, tagged `selfbuilding:agent-launched` | launches recorded in `store` whose Trigger run is not terminal, each counted at its sandbox cap |

## What the agent sees

The tool appears only for calls staged with a grant:

```json
{ "name": "start_workflow", "arguments": { "name": "fix-flaky-test", "script": "export default async (input, sb) => { ... }", "size": "medium", "maxSandboxes": 2, "budgetUsd": 4 } }
```

It answers at once: `Started run ns_wf_... on node. Follow it with: selfbuilding watch ns_wf_...`. A refusal comes
back as an error result naming the rule, its limit and what the request needed, so the agent can ask for less.
`get_workflow_status({ runId })` returns the run's status, phase, agents (with their sizes and costs) and live
sandboxes as JSON.

The agent never sees the grant: core writes it root-only (0600) to `/run/selfbuilding/secrets/START_WORKFLOW_GRANT`,
the supervisor reads it and makes the HTTPS call (30 s timeout), and the runtime's redactor scrubs it from every log.
A sandbox with `deny-all` egress has no path to the host; the tool says so.

## The guards

Checked on the host in this order; the first refusal answers and nothing starts.

| Rule | Default | Refuses when |
|---|---|---|
| `disabled` | `enabled: false` | the policy is off |
| `grant` | | the HMAC is wrong or the grant expired (`grantTtl`, default 2 h) |
| `depth` | `maxDepth: 1` | a run that was itself agent-launched tries to launch (no grandchildren by default) |
| `script_bytes` | 262 144 | the source is larger |
| `size` | `allowedSizes: ["small"]` | the requested largest size is not in the list |
| `budget` | `maxBudgetUsd: 10` | the request asks for more, or for more than the calling agent's own budget slice |
| `sandboxes_per_run` | `maxSandboxesPerRun: 2` | the request asks for more |
| `concurrent_runs` | `maxConcurrentRuns: 2` | that many agent-launched runs are alive |
| `concurrent_sandboxes` | `maxConcurrentSandboxes: 4` | live sandboxes plus the requested ones would exceed it |

Then the script is compiled (`checkScript`), and the run starts with caps the script cannot exceed: its
`maxSandboxes`, its budget, and only the sizes no bigger than the requested one (in vCPU and memory). Every
breach inside the run is a `ScriptLimitError`.

A retried tool call converges on the same run: the run id is derived from the caller's run and call path and the
`idempotencyKey` (or the script and input), and an existing run answers `status: "exists"` even when the caps are
full.

## From a laptop

```sh
selfbuilding start scripts/nightly-fix.js --input '{"issue": 42}' --size medium --budget 5
selfbuilding start scripts/nightly-fix.js --detach --json   # prints the receipt and exits
selfbuilding watch ns_wf_...                                 # ends with phase, agents, sizes and costs
```

Local callers skip `disabled`, `grant` and `depth`; every other guard applies. `--host trigger` launches on
Trigger.dev through the project's own `@selfbuilding/host-trigger` (needs `TRIGGER_SECRET_KEY`).

`selfbuilding-mcp --standalone` serves only `start_workflow` to a local agent and runs
`selfbuilding start --detach --json` for each call.
