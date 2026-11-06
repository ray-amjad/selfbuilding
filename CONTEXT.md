# Glossary

Each term has one meaning in code, docs and error messages. The "Avoid" column lists words that must not be
used for the term. Source: spec §1.6.

| Term | Meaning | Avoid |
|---|---|---|
| **Skill** | A folder containing `SKILL.md` (agentskills.io format) plus optional `scripts/`, `references/` and `assets/`. Plain data with no behaviour. | prompt pack, recipe |
| **Agent** | A typed async function `(input, opts?) => Promise<AgentResult<O>>`, compiled from a Skill plus an input schema, an output schema and optional done checks. Named in PascalCase: `CodeReview`. An inline prompt run with `agent()` behaves the same way. | bot, worker, task. Do not use "task" as a name for this concept. The default input field `task` (§2.4.4) is still allowed. |
| **Harness** | The coding-agent CLI that executes an Agent turn: Claude Code, Codex, OpenCode, Amp, Droid, Pi or Grok. In code it is always a value, such as `claudeCode({ model })`. `HarnessId` (`"claude-code"`, …) is only an identifier in events, journals and errors. | engine, model |
| **Provider** | A sandbox provider: where the harness runs. Docker, Impello, E2B, Daytona, Vercel Sandbox, Modal or Cloudflare Sandbox. In code it is a value, such as `impello({ template })`. | backend, box, VM (in API names) |
| **Sandbox** | One live instance created by a Provider. Referred to by a serialisable `SandboxRef` (§5.2). In factory code you hold a `SandboxHandle` (§3.11); adapters hold a `ProviderSandbox` (§5.2). | container (unless it is Docker) |
| **Runtime** | The Selfbuilding program inside a sandbox: supervisor, bridge and tool server (§6). | runner, daemon |
| **Host** | What executes the factory and supplies durability: plain Node, Trigger.dev, Inngest or Cloudflare Workflows. | runner, platform, scheduler |
| **Factory** | A plain async TypeScript function, wrapped by `factory()`, that composes Agents. The unit you deploy and `run()`. | workflow (reserved for the host concept), pipeline (a primitive) |
| **Run** | One execution of a Factory, identified by a `runId`. Stateless in memory and resumable from its journal. | job, session |
| **Call path** | The stable, readable position of a primitive call inside a Run, derived from program structure (§3.2). | step id, stage id, agent path |
| **Step key** | A 26-character hash of a call's identity and history, used as journal key and host step id (§3.2). | key, call id |
| **Step** | One journaled unit inside a Run: an agent call, a `step()` or a sandbox mutation. On durable hosts an agent call becomes a host step group (§7.4). | activity |
| **Journal** | The append-only record of completed steps for a Run, keyed by run id and step key. Stored in a file or SQLite locally, or in host state. | log, history |
| **Ask** | A question from a Factory or an Agent to a human. It is routed to one or more Channels and has a timeout and an AFK policy. | prompt, approval (an approval is one kind of Ask) |
| **Channel** | Where an Ask is delivered and answered: Slack, Discord or a GitHub PR. | integration, notifier |
| **Artifact** | A durable output of an Agent: branch, PR, diff, transcript, logs or a file. Large ones are stored by reference as an `ArtifactRef`. | output (reserved for the typed result) |
| **AFK** | A run mode with no human. Every Ask resolves through its declared policy without being posted. | headless, unattended (in API names) |
| **Tier** | An adapter's support level: `stable` or `experimental` (§1.10). | built-in, adapter (as tier names) |

Also used in this repo:

| Term | Meaning |
|---|---|
| **Handle** | A `SandboxHandle`: a sandbox held in factory code and shared by several agent calls (§3.11). |
| **Fork** | A copy of a handle's sandbox made by `handle.fork(n)`, from a snapshot or a git checkpoint, so a reviewer can work without touching the original. |
| **Launch** | One start of the runtime for one turn of one call, identified by `launchId` (§7.2). |
| **Attempt directory** | `/selfbuilding/state/calls/<stepKey>/<attempt>/`, where one attempt's spec, events, result and outcome live (§6.4). |
