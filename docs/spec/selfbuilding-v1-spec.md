# Selfbuilding v1: technical spec (first draft)

Draft, 2026-11-01

## TL;DR

- **Selfbuilding is an MIT, library-first TypeScript project for building a software factory out of coding agents.** Every `SKILL.md` folder becomes a typed async `Agent` (`CodeReview()`, `ImplementSpec()`, `Retro()`, `ImproveCodebaseArchitecture()`) that returns a Zod-validated result plus its artifacts: branch, PR, diff and redacted transcript.
- **Results never come from scraped text.** The harness hands the result back by calling an injected `submit_result` MCP tool whose input schema is the agent's output schema. Bad shapes are retried inside the run, the host re-parses authoritatively, and done checks verify the work against protected files.
- **Composition is plain TypeScript.** `agent()`, `pipeline()` (no barrier), `parallel()` (barrier, failures become `null`), `step()`, `phase()`/`log()`, `ask()`, a shared budget, a sandbox concurrency cap and nested factories one level deep. Agent calls throw; `.settled()`, `parallel()` and `pipeline()` give the value form.
- **Any harness in any sandbox.** Claude Code, Codex and OpenCode are stable; Amp, Droid, Pi and Grok are experimental behind the same pure adapter interface. Docker, Impello/E2B, Daytona, Vercel Sandbox, Modal and Cloudflare Sandbox sit behind one provider contract with a public conformance suite. Placement is explicit: a fresh sandbox per agent by default, opt-in shared handles, `snapshot()`/`fork()`.
- **One durability system.** `run()` is stateless and resumable by run id. Plain Node replays from a local journal (file or SQLite); on Trigger.dev, Inngest and Cloudflare Workflows each agent call maps onto host steps. Interrupted turns are never silently re-run, and resumes after a terminal failure start a new epoch that never serves cached failures.
- **Humans in the loop, or none.** One `ask()` primitive (the `ask_human` tool inside the sandbox) posts to Slack, Discord and GitHub PR comments with hot and cold waits; AFK runs resolve every ask by a declared policy, and high-risk asks can only fall back to a safe choice.
- **The sandbox is the security boundary.** Secrets arrive only as 0600 files, the agent gets a read-only git token while the host pushes after the agent's processes have exited, exact-value scans guard snapshots and pushes, and a reaper sweeps leaked sandboxes on every host.
- **Build plan.** Milestones M0 to M4 over about 20 weeks, tested with a scripted harness, provider conformance, emulate.dev for GitHub and Slack, and capped live smoke runs. Every open question is collected in §11.

## Contents

1. [Overview, goals, non-goals and the public API](#1-overview-goals-non-goals-and-the-public-api)
2. [Skills to Agent(): compilation and the result contract](#2-skills-to-agent-compilation-and-the-result-contract)
3. [Orchestration: agent(), pipeline(), parallel(), journal and sandbox placement](#3-orchestration-agent-pipeline-parallel-journal-and-sandbox-placement)
4. [Harness adapters](#4-harness-adapters)
5. [Sandbox providers](#5-sandbox-providers)
6. [In-sandbox runtime and run lifecycle](#6-in-sandbox-runtime-and-run-lifecycle)
7. [Durability, hosts and deployment](#7-durability-hosts-and-deployment)
8. [Human in the loop and AFK](#8-human-in-the-loop-and-afk)
9. [Security, credentials, observability and failure modes](#9-security-credentials-observability-and-failure-modes)
10. [Repo layout, testing, milestones and docs](#10-repo-layout-testing-milestones-and-docs)
11. [Open questions](#11-open-questions)

## 1. Overview, goals, non-goals and the public API

This section holds the canonical public API. It owns four things:

- the package registry (§1.7)
- the API sheet and the canonical examples (§1.8)
- the configuration reference (§1.11)
- the CLI reference (§1.12)

Later sections define the behaviour behind these names. They must not introduce new package names, signatures or config keys. If they do, this section wins, and §1.14 lists the CI checks that enforce it. §1.16 records the reconciliation edits this draft applied to sections 2 to 10 so that they agree with this section.

### 1.1 Pitch

Selfbuilding is a TypeScript library for building a software factory out of coding agents.

You write a factory in plain TypeScript. It calls agents the way it would call any async function. Each agent comes from a skill (a `SKILL.md` folder). It runs inside a coding-agent CLI (the harness), and that CLI runs inside a sandbox you choose. Every agent returns a typed, validated result plus its artifacts: a branch, a PR, a diff and a transcript.

```ts
const review = await CodeReview({ target: { kind: "pr", url: "https://github.com/acme/api/pull/412" } });
if (review.result.verdict === "request_changes") { /* ... */ }
```

Selfbuilding owns the plumbing between agents:
- starting and stopping sandboxes
- installing harnesses and skills
- getting a typed result back out
- budgets and concurrency caps
- resuming after a crash
- asking a human on Slack, Discord or a GitHub PR, or running fully AFK

You own the infrastructure. Selfbuilding runs on accounts you already have: a sandbox provider, a durable host such as Trigger.dev, and your Slack or GitHub. It has no hosted service of its own.

### 1.2 Who it is for

- **Developers who already use coding agents by hand** and want them to run unattended: overnight, on a schedule, on a webhook, or fanned out across 30 issues.
- **Platform and DevEx engineers** building an internal factory, such as "every new issue labelled `agent` gets a spec, an implementation, a review and a PR".
- **Skill authors** who want their `SKILL.md` to work as a callable, typed unit and not only as a slash command.

You need to be comfortable writing TypeScript and running a Node process or a durable-host deployment. Selfbuilding is not a no-code tool.

### 1.3 Design principles

1. **Library first.** Everything in v1 is an npm import. A self-hosted control plane comes later. It is optional and is built on the same public API.
2. **Plain TypeScript is the workflow language.** Use `await`, `for`, `if`, `try` and `Promise.all`. There is no DSL, no YAML graph and no visual builder.
3. **Typed results, never scraped text.** A result leaves the harness through an injected `submit_result` tool. Its input schema is the agent's Zod output schema. A bad shape is rejected inside the run, and the model retries there (§2).
4. **One durability system.** On Trigger.dev, Inngest or Cloudflare Workflows, each agent call maps onto host steps (§7). On plain Node, a local journal provides the same replay. The two are never stacked.
5. **Placement is explicit.** Each agent gets a fresh sandbox by default. Sharing a working tree is an opt-in handle (§3.11).
6. **The sandbox is the security boundary.** Harnesses run with permissions bypassed inside it. Credentials are scoped and short-lived, and they fail closed (§9).
7. **Curated stable adapters, open interfaces.** Every harness, provider, host and channel implements a public interface. An adapter is marked stable only after it passes the verification bar (§1.10, §10.3).
8. **Unknown is not failure.** A provider timeout, a lost response or an unreachable control plane is reported as *unknown*. Selfbuilding never destroys a sandbox or re-runs a half-finished agent turn because of an unknown outcome.
9. **Nothing is implicit.** Library code never reads `process.env`, never finds a config file by itself and never resolves a path against `process.cwd()`. The CLI does these things for you. In library code you do them explicitly with `loadConfig()` and `fromEnv()`.

### 1.4 Goals for v1

| # | Goal | Done when |
|---|---|---|
| G1 | Any `SKILL.md` folder becomes a typed `Agent` | `await Agent.fromSkill(dir, { input, output })` returns a callable whose result type is inferred from the Zod schemas |
| G2 | A default agent pack | `@selfbuilding/agents` ships `CodeReview`, `ImplementSpec`, `Retro` and `ImproveCodebaseArchitecture` with the explicit schemas in §2.10.1 |
| G3 | Three first-class harnesses | Claude Code, Codex and OpenCode pass the live suite on Docker and Impello |
| G4 | Six sandbox providers | Docker, Impello/E2B, Daytona, Vercel Sandbox, Modal and Cloudflare Sandbox pass `@selfbuilding/sandbox-conformance` for every capability they declare |
| G5 | Composition primitives | `agent()`, `pipeline()`, `parallel()`, `step()`, `phase()`, `log()`, a shared budget, a sandbox concurrency cap, and nested factories one level deep |
| G6 | Resume by run id | `run(factory, input, { runId })` after a crash replays completed agents and runs the next one. This works on plain Node, Trigger.dev, Inngest and Cloudflare Workflows (§3.9, §7.6) |
| G7 | HITL and AFK | `ask()` works over Slack, Discord and GitHub PR comments. The same factory runs AFK with a declared timeout policy |
| G8 | Artifacts | Every agent can return a pushed branch, an opened PR, a diff and a redacted transcript |
| G9 | A CLI | Every command in §1.12 exists with the documented flags and exit codes: `init`, `run`, `resume`, `watch`, `cancel`, `answer`, `reap`, `doctor`, `skills add/build/check/validate/infer` and `images build` |
| G10 | Testable offline | `@selfbuilding/testing` provides a scripted harness, a tmpdir sandbox, emulated GitHub and Slack (via emulate.dev) and a Discord fake |
| G11 | A 10-minute quickstart | The quickstart in §1.8 runs on a clean machine with Node and Docker, with no build step and no undocumented command |

### 1.5 Non-goals for v1

- **No hosted service.** No Selfbuilding-run cloud, no accounts, no billing.
- **No control plane in v1.** The Cloudflare Workers + Durable Objects control plane is planned (§7.11). v1 keeps the run state, journal and channel webhooks reachable without it (§7).
- **No agent loop of our own.** Selfbuilding drives existing harness CLIs. It does not call model APIs to edit code itself. It makes its own model calls only for optional LLM-judge done checks (§2.7) and optional AFK auto-answers (§8.8).
- **No DSL, graph editor or YAML workflow format.**
- **No multi-repo sandboxes.** A sandbox holds one repository. Cross-repo work is several agents.
- **No pretend capabilities.** A provider without a capability does not emulate it silently. Each fork reports how it was made (`filesystem` or `git`, §3.11), and a fork that requires `memory` fails in v1 (§5.5).
- **No automatic merge or deploy.** Agents can open PRs. Merging is done by your code, or after an `ask()` marked `risk: "high"`.
- **No secret store.** Secrets come from your own secret manager through a `SecretSource` you pass in. Only names an agent declares reach a sandbox, and they arrive as files, not argv (§9.2).
- **No long tail of stable harnesses or providers.** Amp, Droid, Pi and Grok ship behind the same adapter interface at the experimental tier. Other harnesses and providers are user-written. Declined requests are recorded in `docs/out-of-scope/`.
- **No retry of model-provider errors inside a harness.** Rate limits and overloads are retried at the durable step layer, where retries are visible and budgeted (§4.12).
- **No Windows or macOS sandboxes.** Sandboxes are Linux (glibc).

### 1.6 Glossary

Each term has one meaning in code, docs and error messages. The "Avoid" column lists words that must not be used for the term.

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

### 1.7 Package registry

This table is the only list of package names. A name that is not in this table does not exist. Every import in the spec, the docs, the templates and the examples must use a name and subpath from this table, and CI enforces this (§1.14).

Shared rules:

- **Packaging:** every package is MIT, ESM only and requires `engines.node: ">=22.12"` (see §1.13).
- **Family forms:** each family has one form: `@selfbuilding/harnesses/<id>`, `@selfbuilding/sandbox-<id>`, `@selfbuilding/host-<id>`, `@selfbuilding/channel-<id>`.
- **The CLI package `selfbuilding` exports nothing.** It ships only the `selfbuilding` bin. Library APIs are never imported from it.
- **One owner per exported name.** A name such as `AgentResult` is declared in one package. Other packages re-export it only when the table says so.
- **No third-party types in public `.d.ts` files.** Public types never import a third-party framework type, and a build check enforces this (§10.1).

| Package | Subpath exports | Purpose | Depends on | Ships |
|---|---|---|---|---|
| `@selfbuilding/core` | `.` | `factory`, `run`, `agent`, `pipeline`, `parallel`, `isPresent`, `step`, `now`, `random`, `uuid`, `phase`, `log`, `ask`, `sandbox`, `reap`, `Agent` (with `Agent.fromSkill`), `defineContract`, `DefaultInput`, `DefaultResult`, `ReviewTarget`, `DEFAULT_PROTECTED`, `branchName`, `checkpointRef`, `defineConfig`, `loadConfig`, `fromEnv`, `fromFile`, `fileJournal`, `fileArtifacts`, `envSecretSource`. Also the shared types: `AgentResult`, `Artifacts`, `ArtifactRef`, `Usage`, `Duration`, `ErrorCode`, `SelfbuildingError` and subclasses, `Harness`, `SandboxProvider`, `JournalStore`, `ArtifactStore`, `AskStore`, `HitlChannel`, `EventSink`, `DurableHost`. The plain Node host is built in. `fileJournal` and `fileArtifacts` load `node:fs` lazily inside the call, so the module itself statically imports only `node:async_hooks` (§10.1). | `zod`, `@selfbuilding/skills` | M0 |
| `@selfbuilding/skills` | `.` | `SKILL.md` loader and validation (`loadSkill`, `loadSkills`), sidecar contracts, and the codegen used by `selfbuilding skills build`. Core uses it, and it is public for advanced use. | `zod`, a YAML parser | M1 |
| `@selfbuilding/agents` | `.`, `/skills/*` (the raw skill folders) | The default pack: `CodeReview`, `ImplementSpec`, `Retro`, `ImproveCodebaseArchitecture`, `defaultPack`, and their input and result schemas. Replaces the name `@selfbuilding/skills-default`. | `@selfbuilding/core` | M1 |
| `@selfbuilding/harnesses` | `/claude-code`, `/codex`, `/opencode`, `/amp`, `/droid`, `/pi`, `/grok` (no root export) | Harness adapters: command builders and stream parsers, with no SDK dependencies | `@selfbuilding/core` (types only) | M1 (first three), M4 (rest) |
| `@selfbuilding/runtime` | none. It ships `selfbuilding-runtime.mjs` and `selfbuilding-mcp.mjs` as files | The in-sandbox runtime and the `selfbuilding-mcp` tool server. Uploaded by core and never imported by users | nothing at run time (bundled) | M1 |
| `@selfbuilding/images` | `.` | `defineImage` and the official image definitions (§5.6) | `@selfbuilding/core` | M1 |
| `@selfbuilding/journal-sqlite` | `.` | `sqliteJournal(path)` | `@selfbuilding/core`, `better-sqlite3` | M2 |
| `@selfbuilding/artifacts-s3` | `.` | `s3Artifacts({ bucket, endpoint, credentials })` for any S3-compatible store, including R2 | `@selfbuilding/core`, `@aws-sdk/client-s3` | M2 |
| `@selfbuilding/sandbox-docker` | `.` | `docker()` | `dockerode` | M0 |
| `@selfbuilding/sandbox-impello` | `.` | `impello()` | `@impello/sdk`. Shares its E2B-shape code with `sandbox-e2b` | M2 |
| `@selfbuilding/sandbox-e2b` | `.` | `e2b()` | `e2b` | M3 |
| `@selfbuilding/sandbox-daytona` | `.` | `daytona()` | `@daytonaio/sdk` | M3 |
| `@selfbuilding/sandbox-vercel` | `.` | `vercel()` | `@vercel/sandbox` | M3 |
| `@selfbuilding/sandbox-modal` | `.` | `modal()` | `modal` | M3 |
| `@selfbuilding/sandbox-cloudflare` | `.`, `/worker` | `cloudflareSandbox()` client, plus the facade Worker and its `SelfbuildingSandbox` Durable Object class (§5.5) | `@cloudflare/sandbox` | M3 |
| `@selfbuilding/host-trigger` | `.` | `createTriggerHost()` | `@trigger.dev/sdk` (peer) | M2 |
| `@selfbuilding/host-inngest` | `.` | `createInngestHost()` | `inngest` (peer) | M3 |
| `@selfbuilding/host-cf-workflows` | `.` | `createCfWorkflowsHost()` | Workers runtime types | M3 |
| `@selfbuilding/channel-slack` | `.` | `slack()` | `@selfbuilding/core` | M3 |
| `@selfbuilding/channel-discord` | `.` | `discord()` | `@selfbuilding/core` | M3 |
| `@selfbuilding/channel-github` | `.` | `githubPr()`, the `githubApp()` and `pat()` git credential brokers, and `postReview()` (the post-only review helper used by the M2 dogfood, §10.5) | `@selfbuilding/core` | M2 (`postReview`, `githubApp`), M3 (rest) |
| `@selfbuilding/hooks` | `.` | Fetch handlers `createHitlHandler()` (channel webhooks, §8.6) and `createCallbackHandler()` (sandbox callbacks, §7.5.2) | `@selfbuilding/core` | M3 |
| `@selfbuilding/otel` | `.` | `otelSink()` (§9.7) | `@opentelemetry/api` (peer) | M3 |
| `@selfbuilding/testing` | `.`, `/discord` | `scriptedHarness`, `tmpdirProvider`, `describeHarness`, emulate.dev setup, the Discord emulator, the golden-stream normaliser | `@selfbuilding/core`, `emulate` (pinned) | M0 |
| `@selfbuilding/sandbox-conformance` | `.` | `describeSandboxProvider()` and the placement suite, for first- and third-party providers | `@selfbuilding/core`, `vitest` (peer) | M0 |
| `@selfbuilding/eslint-plugin` | `.` | The `no-nondeterminism` and `no-handle-across-concurrency` rules (§3.8) | `eslint` (peer) | M2 |
| `selfbuilding` | bin only | The CLI (§1.12) | `jiti`, plus whichever of the packages above the project has installed | M1 |

### 1.8 Public API and developer experience

#### The API sheet

These are the canonical signatures. The full contracts live in the sections noted. All primitives are module-level imports from `@selfbuilding/core`, and they find the current run through `AsyncLocalStorage`. No primitive takes a `ctx` parameter, and there is no `ctx` object anywhere in the API. A primitive called outside a running factory throws `NoActiveRunError` and names itself. The exceptions are calling an Agent and `sandbox()`, which both work standalone.

```ts
// @selfbuilding/core: the canonical shapes. Behaviour: §3 (primitives), §2 (agents), §8 (ask).
declare function factory<I extends z.ZodType, O extends z.ZodType = z.ZodUnknown>(
  opts: {
    name: string;
    input: I;
    output?: O;
    defaults?: { harness?: Harness; sandbox?: SandboxProvider; effort?: Effort };
    budget?: Budget;                                        // §9.6
    concurrency?: { sandboxes?: number; createsPerMinute?: number };   // §3.12
    hitl?: HitlOptions;                                     // §8.2
  },
  body: (input: z.infer<I>) => Promise<z.infer<O>>,
): Factory<z.infer<I>, z.infer<O>>;

declare function run<I, O>(f: Factory<I, O>, input: I, opts?: RunOptions): Promise<RunOutcome<O>>;

// Compiled Agents. Agent.fromSkill is the only public entry point; defineAgent is internal.
declare namespace Agent {
  function fromSkill<I = DefaultInput, O = DefaultResult>(
    dir: URL | string,                                      // absolute path or file URL; a relative string throws ConfigError
    contract?: ContractSpec<I, O>,                          // { input?, output?, done?, artifacts?, defaults? } (§2.4)
  ): Promise<Agent<I, O>>;
}
type Agent<I, O> = {
  (input: I, opts?: AgentCallOptions): Promise<AgentResult<O>>;        // throws SelfbuildingError
  settled(input: I, opts?: AgentCallOptions): Promise<Settled<AgentResult<O>>>;
  with(patch: AgentPatch<I, O>): Agent<I, O>;                          // §2.10.4
};

// Inline agents: one signature, only for prompts that have no skill folder.
declare function agent<O>(spec: {
  name: string; prompt: string; input?: unknown; output: z.ZodType<O>;
} & AgentCallOptions): Promise<AgentResult<O>>;                         // agent.settled(spec) gives the value form

declare function pipeline(...args: PipelineArgs): Promise<(unknown | null)[]>;     // §3.5
declare function parallel(thunks: ThunkList | ThunkRecord): Promise<unknown>;      // §3.6, failures → null
declare function isPresent<T>(v: T | null | undefined): v is T;                    // §3.6
declare function step<T>(name: string, fn: () => Promise<T>): Promise<T>;          // §3.7
declare function now(): number; declare function random(): number; declare function uuid(): string;  // §3.8
declare function phase(name: string): void;
declare function log(message: string, data?: Record<string, unknown>): void;
declare function ask<T>(spec: AskSpec<T>): Promise<AskResolution<T>>;              // §8.2
declare function sandbox(spec: { provider?: SandboxProvider; repo?: string; branch?: string;
                                 label?: string; from?: Snapshot | Checkpoint }): SandboxHandle;  // §3.11, lazy
```

Here are the rules that keep each job to one call:

- **To call a compiled Agent, call it.** `CodeReview(input, opts)` is the only form, and `agent(CodeReview, …)` does not exist.
- **The result schema key is always `output`.** This holds in `Agent.fromSkill`, `defineContract`, `agent()`, `factory()` and `.with()`. No API uses `schema` for it. (`AskSpec.schema` is a form schema for human answers, not a result schema.)
- **Harness, sandbox and journal slots take values, never strings.** Use `harness: codex({ model })`, `sandbox: impello({ template })` and `journal: sqliteJournal(path)`. `HarnessId` strings appear only in results, events and errors.
- **The model lives on the harness value.** To change the model for one call, pass `harness: claudeCode({ model: "…" })`. There is no separate `model` call option.
- **Durations follow one rule.** Public options take a `Duration` (`"45m"`, `"2h"` or a number of ms), and their keys have no unit suffix: `timeout`, `wallClock`. Wire and protocol types (`RuntimeSpec`, events, journal entries) use numeric `*Ms` fields.

`AgentCallOptions` keeps the same key names everywhere it appears. The full type is in §2.5.1, and it is the only per-call options type (§3.4 and §6.16 contribute fields to it). The main keys are `harness`, `sandbox` (`"fresh" | SandboxProvider | SandboxHandle`), `effort`, `repo`, `label`, `phase`, `budget`, `timeout`, `retries`, `pr`, `git`, `secrets`, `hitl`, `onDoneFailure`, `onInterrupted`, `signal` and `config`.

Each host package exports one constructor named `create<Host>Host`:

| Package | Export | Returns |
|---|---|---|
| `@selfbuilding/host-trigger` | `createTriggerHost({ config, factories })` | `{ factoryTask, agentTask, reaperTask }`. Export all three from your `trigger/` directory |
| `@selfbuilding/host-inngest` | `createInngestHost({ config, factories, client })` | `{ functions, callbackHandler }`. Pass `functions` to `serve()` |
| `@selfbuilding/host-cf-workflows` | `createCfWorkflowsHost({ config, factories })` | `{ worker, SelfbuildingWorkflow, RunDO, LeaseDO }`. Re-export all four from your Worker entry |

The default pack's schemas are defined in §2.10.1, and the examples below use them. Here is a summary:

| Agent | Input (main fields) | Result (main fields) | Branch |
|---|---|---|---|
| `CodeReview` | `target: { kind: "pr", url } \| { kind: "diff", base, head? }`, `focus?`, `maxFindings` | `verdict: "approve" \| "request_changes" \| "comment"`, `summary`, `findings[]` | forbidden |
| `ImplementSpec` | `spec: string \| { path }`, `testCommand?` | `status`, `summary`, `changes[]`, `tests?`, `followUps[]`, `prTitle`, `prBody` | required |
| `Retro` | `runId?`, `transcripts?`, `notes?` | `wentWell[]`, `wentBadly[]`, `actions[]` | forbidden |
| `ImproveCodebaseArchitecture` | `scope?`, `goals?`, `mode: "propose" \| "implement"`, `maxChanges`, `testCommand?` | `summary`, `proposals[]`, `spec` | forbidden in `propose`, required in `implement` |

Skill inputs carry only what the skill needs. Placement (`repo`, the working and base branch, sandbox, harness) is set in call options, never in the input (§2.4.3). A review `target` is task data: it names the code to read. For a `pr` target, the repo is taken from the URL.

#### Quickstart

This is the only quickstart. §7.12.1 and the docs site link here and do not repeat it. It needs Node 22.12+, a running Docker and an Anthropic API key. It reviews a pull request on a public repo, so no GitHub credential is needed.

```bash
npm i @selfbuilding/core @selfbuilding/agents @selfbuilding/harnesses @selfbuilding/sandbox-docker zod
npm i -D selfbuilding
npx selfbuilding init --harness claude-code --provider docker --host node
export ANTHROPIC_API_KEY=sk-ant-...            # or keep it in .env and pass --env-file .env
npx selfbuilding doctor                          # lists every missing credential or setting at once
npx selfbuilding run factories/review-pr.ts --input '{"url":"https://github.com/acme/api/pull/412"}'
```

There is no image build step. `docker()` pulls the prebuilt `selfbuilding/claude-code:<selfbuilding version>` image on first use. If you need a local image whose `agent` user matches your host UID (needed only for `mount: "worktree"`, §5.5), use `docker({ build: true })` or `npx selfbuilding images build --provider docker --harness claude-code`.

`selfbuilding init` asks for any value not given as a flag. It detects the package manager from `packageManager` or the lockfile, and it writes these files:

```
selfbuilding.config.ts        # harness, sandbox, journal, budget; read by the CLI
factories/review-pr.ts      # a working example factory
.agents/skills/             # empty; your SKILL.md folders go here (listed in skills.sources)
.env.example                # names of the variables the config reads with fromEnv(), no values
.selfbuilding/.gitignore      # ignores journal/ and artifacts/
```

Each interactive question has a matching flag: `--harness`, `--provider`, `--host`, `--channel` and `--template`. When stdin is not a TTY, `init` checks every flag before it writes anything. If any are missing, it fails with one error that lists them all, so a directory is never left half-written. If `selfbuilding.config.ts` exists, `init` refuses to run unless you pass `--force`.

```ts
// selfbuilding.config.ts
import { defineConfig, fileJournal, fromEnv } from "@selfbuilding/core";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { docker } from "@selfbuilding/sandbox-docker";

export default defineConfig({
  harness: claudeCode({
    model: "claude-opus-4-8",
    credentials: { kind: "api-key", value: fromEnv("ANTHROPIC_API_KEY") },
  }),
  sandbox: docker(),                              // image defaults to selfbuilding/<harness id>:<version>
  journal: fileJournal(".selfbuilding/journal"),    // or sqliteJournal(...) from @selfbuilding/journal-sqlite
  budget: { usd: 20, wallClock: "2h" },
  concurrency: { sandboxes: 4 },
  skills: { sources: [{ root: ".agents/skills" }] },   // the default pack is included unless skills.defaults is false
});
```

```ts
// factories/review-pr.ts
import { factory } from "@selfbuilding/core";
import { CodeReview } from "@selfbuilding/agents";
import { z } from "zod";

export default factory(
  { name: "review-pr", input: z.object({ url: z.url() }) },
  async ({ url }) => {
    const review = await CodeReview({ target: { kind: "pr", url } });
    return review.result;   // { verdict: "approve" | "request_changes" | "comment"; summary; findings }
  },
);
```

#### Calling an Agent from your own code

Outside the CLI, nothing is loaded for you. You pass the settings yourself, or load the same config file explicitly:

```ts
import { loadConfig } from "@selfbuilding/core";
import { CodeReview } from "@selfbuilding/agents";

const config = await loadConfig({ cwd: process.cwd() });   // same discovery rules as the CLI (§1.11)

const review = await CodeReview(
  { target: { kind: "pr", url: "https://github.com/acme/api/pull/412" }, focus: ["security"] },
  { config },
);
review.result.verdict;          // "approve" | "request_changes" | "comment"
review.result.findings[0].file; // string
review.artifacts.transcript;    // ArtifactRef to the redacted transcript
```

An Agent called outside a factory runs as a one-step Run with a fresh `runId`. It can be resumed only if the settings include a `journal`. If the call has no harness or no sandbox from any source, it throws before any sandbox exists:

```
ConfigError: CodeReview has no harness and no sandbox.
Pass them in call options, e.g. { harness: claudeCode({ model }), sandbox: docker() },
or pass { config: await loadConfig({ cwd }) }.
```

You can override any setting per call:

```ts
import { codex } from "@selfbuilding/harnesses/codex";
import { impello } from "@selfbuilding/sandbox-impello";

await CodeReview(
  { target: { kind: "pr", url: "https://github.com/acme/api/pull/412" } },
  {
    config,
    harness: codex({ model: "gpt-5.5-codex", effort: "high" }),
    sandbox: impello({ template: "selfbuilding-codex", timeout: "45m" }),
  },
);
```

Provider-specific options go inside the provider factory call, as in `impello({ template })` or `vercel({ vcpus: 4, ports: [3000] })`. Per-call options therefore never gain per-provider fields. The precedence rules are in §1.11.

#### Turn your own skill into an Agent

```ts
// agents/triage-issue.ts
import { Agent } from "@selfbuilding/core";
import { z } from "zod";

export const TriageIssue = await Agent.fromSkill(new URL("../.agents/skills/triage-issue/", import.meta.url), {
  input: z.object({ issue: z.number() }),
  output: z.object({
    kind: z.enum(["bug", "feature", "question", "duplicate"]),
    priority: z.enum(["p0", "p1", "p2", "p3"]),
    spec: z.string().describe("A spec ImplementSpec can act on, or empty"),
    duplicateOf: z.number().optional(),
  }),
  done: [
    {
      id: "duplicate-has-target",
      assert: (r) => r.kind !== "duplicate" || r.duplicateOf != null || "a duplicate needs duplicateOf",
    },
  ],
});

const t = await TriageIssue({ issue: 88 }, { repo: "github.com/acme/api", config });
//    ^? AgentResult<{ kind: ...; priority: ...; spec: string; duplicateOf?: number }>
```

`Agent.fromSkill` is async. It loads and validates the folder, so a broken skill fails at import time with `SkillLoadError` and not halfway through a run.

If no `output` is given, the Agent uses the default result shape (§2.4.4). Schemas can also come from a `selfbuilding.ts` sidecar in the skill folder, which keeps `SKILL.md` valid against the agentskills.io spec. `npx selfbuilding skills build` generates typed exports for every skill source. Section 2 covers loading, the sidecar, prompt assembly and the `submit_result` contract.

For one-off work, `agent()` takes an inline prompt:

```ts
import { agent } from "@selfbuilding/core";

const bump = await agent({
  name: "bump-deps",
  prompt: "Upgrade all patch-level dependencies, run the tests, commit.",
  output: z.object({ upgraded: z.array(z.string()), testsPassed: z.boolean() }),
});
```

#### Compose a factory

A factory is an async function. Agents are awaited like any other call.

```ts
// factories/ship-issues.ts
import { factory, pipeline, parallel, phase, log, ask } from "@selfbuilding/core";
import { ImplementSpec, CodeReview } from "@selfbuilding/agents";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { impello } from "@selfbuilding/sandbox-impello";
import { slack } from "@selfbuilding/channel-slack";
import { TriageIssue } from "../agents/triage-issue";
import { z } from "zod";

export default factory(
  {
    name: "ship-issues",
    input: z.object({ repo: z.string(), issues: z.array(z.number()).max(30) }),
    output: z.object({ prs: z.array(z.string()), labelled: z.boolean() }),
    defaults: {
      harness: claudeCode({ model: "claude-opus-4-8" }),
      sandbox: impello({ template: "selfbuilding-claude-code" }),
      effort: "high",
    },
    budget: { usd: 60, wallClock: "4h" },
    concurrency: { sandboxes: 6 },
    hitl: { channels: [slack({ channel: "#factory" })] },
  },
  async ({ repo, issues }) => {
    phase("triage");
    // parallel(): a barrier. A child that throws becomes null; the rest carry on.
    const triaged = await parallel(issues.map((issue) => () => TriageIssue({ issue }, { repo })));
    const work = issues.flatMap((issue, i) => {
      const t = triaged[i];
      return t && t.result.kind !== "duplicate" && t.result.spec ? [{ issue, spec: t.result.spec }] : [];
    });

    phase("implement + review");
    // pipeline(): each item moves to its next stage as soon as it is ready; no barrier.
    const shipped = await pipeline(
      { key: (w) => `issue-${w.issue}` },
      work,
      (w) => ImplementSpec({ spec: w.spec }, { repo, pr: { draft: true } }),
      async (impl, { item: w }) => {
        let current = impl;
        for (let round = 1; round <= 2; round++) {
          const review = await CodeReview(
            { target: { kind: "pr", url: current.artifacts.pr!.url } },
            { label: `review-${round}` },
          );
          if (review.result.verdict === "approve") return { impl: current, approved: true };
          current = await ImplementSpec(   // same branch, fresh sandbox; updates the open PR
            { spec: `Address this review of #${w.issue}:\n${review.result.summary}`, feedback: review.result.findings },
            { repo, git: { branch: current.artifacts.branch!.name }, pr: { draft: true }, label: `fix-${round}` },
          );
        }
        return { impl: current, approved: false };
      },
    );

    const prs = shipped.flatMap((s) => (s?.approved ? [s.impl.artifacts.pr!.url] : []));
    log(`${prs.length}/${work.length} PRs approved by review`);

    const go = await ask({
      title: "Label PRs ready-to-merge?",
      question: `${prs.length} of ${work.length} PRs passed review. Label them ready-to-merge?`,
      choices: [
        { id: "label", label: "Label them", style: "primary" },
        { id: "hold", label: "Hold", safe: true },
      ],
      timeout: "8h",
      onTimeout: "default",   // a high-risk ask can only fall back to its safe choice
      risk: "high",
    });

    return { prs, labelled: go.answer.kind === "choice" && go.answer.choiceId === "label" };
  },
);
```

How the primitives behave (section 3 has the full contract):

- `parallel(thunks)` waits for every child. A child that throws becomes `null`, and its error goes on the run's event stream.
- `pipeline(items, ...stages)` runs each item through the stages on its own, with no barrier between stages. An item whose stage throws or returns `null` becomes `null`.
- Every agent call draws from the shared `budget` and waits for a slot under `concurrency.sandboxes`. When the budget cannot cover a new agent's slice, new calls throw `BudgetExceededError { phase: "admission" }`. Each running agent is held to the slice it reserved at admission and is stopped when it crosses it, throwing `BudgetExceededError { phase: "running" }`. A live cutoff across agents that are already running arrives with the control plane (§9.6).
- `Promise.all` over agent calls works on every host. On Trigger.dev, each agent call is a child task that the parent waits on through one wake stream (§7.5.1), and a factory-side `ask()` is multiplexed on the same stream, so `ask()` may also run concurrently with agents there. Use `parallel()` instead of `Promise.all` when each concurrent closure makes more than one primitive call, because its call paths stay stable under replay (§3.6).
- A factory may call another factory, one level deep. Calling one more level down throws `NestingDepthError`.
- Code between primitive calls runs again on replay. Put I/O in `step()`, and use `now()`, `random()` and `uuid()` instead of `Date.now()`, `Math.random()` and `crypto.randomUUID()` (§3.8).

#### Run, resume and answer

```ts
import { run, loadConfig } from "@selfbuilding/core";
import { Retro } from "@selfbuilding/agents";
import shipIssues from "./factories/ship-issues";

const config = await loadConfig({ cwd: process.cwd() });
const input = { repo: "github.com/acme/api", issues: [88, 91, 102] };

const out = await run(shipIssues, input, { config, runId: "ship-2026-11-01" });
// After a crash, the same call with the same runId replays finished agents and continues.
if (out.status === "ok") await Retro({ runId: out.runId }, { config });
```

If you omit `runId`, Selfbuilding generates one in the form `ns_<ulid>`. A run id you supply must match `^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$` so that it is valid on every host (§7.2).

```bash
npx selfbuilding run factories/ship-issues.ts --input @input.json
npx selfbuilding resume ship-2026-11-01
npx selfbuilding answer ship-2026-11-01 '#1' hold      # answer an Ask without a channel
npx selfbuilding run factories/ship-issues.ts --input @input.json --afk   # every Ask resolves by its policy
```

On a durable host, you hand the factories to the host constructor. The host then owns run ids and retries:

```ts
// trigger/selfbuilding.ts
import { createTriggerHost } from "@selfbuilding/host-trigger";
import config from "../selfbuilding.config";
import shipIssues from "../factories/ship-issues";

export const { factoryTask, agentTask, reaperTask } = createTriggerHost({
  config,
  factories: { shipIssues },
});
```

#### Choose where agents run

By default, each agent gets a fresh sandbox, which is killed when the agent finishes. Information moves between sandboxes as a typed result, a git branch or a snapshot. To share one working tree, open a handle yourself:

```ts
import { sandbox } from "@selfbuilding/core";
import { ImplementSpec, ImproveCodebaseArchitecture } from "@selfbuilding/agents";

await using box = sandbox({
  provider: impello({ template: "selfbuilding-claude-code" }),
  repo: "github.com/acme/api",
  branch: "selfbuilding/refactor-billing",
  label: "work",
});

const plan = await ImproveCodebaseArchitecture({ scope: ["src/billing"], mode: "propose" }, { sandbox: box });
const tests = await box.exec("pnpm test");     // { exitCode, stdoutTail, stderrTail, truncated }; non-zero never throws
const top = plan.result.proposals[0];
const impl = await ImplementSpec(
  { spec: `${top.title}\n\n${top.change}`, testCommand: "pnpm test" },
  { sandbox: box },                            // same tree, same installed dependencies
);

const snap = await box.snapshot();             // Snapshot (§3.11)
const [a, b] = await box.fork(2);              // two handles (or null) from one state
```

A handle runs one agent at a time. A second concurrent call on a busy handle throws `SandboxBusyError`. It does not queue, because queuing would make the working tree depend on timing. Use `fork()` when you need concurrent work. Sections 3.11 and 5 cover placement rules and provider capabilities.

### 1.9 Results and failures

`AgentResult`, `Artifacts`, `Usage` and `ArtifactRef` are declared once, in §2.8. The error classes, the one `ErrorCode` union and the `recovery` shape are declared once, in §9.8. No other section redeclares them. This summary only lists the fields:

| `AgentResult<O>` field | Meaning |
|---|---|
| `result` | The value validated against the output schema |
| `runId`, `callPath`, `stepKey` | Where the call sits in the run. `callPath` is stable across replays (§3.2) |
| `attempts` | `{ submits, resumes, doneRetries }` (§2.6.6) |
| `replayed` | `true` when the value came from the journal |
| `usage` | `{ usd, inputTokens, outputTokens, turns, wallClockMs, sandboxMs }`. `usd` is `null` when unpriced |
| `artifacts` | `{ branch?: { name, base, baseSha, headSha, pushed, autoCommitted }, commits?, pr?: { url, number, draft }, diff?, transcript, files, logs, checkpoint? }`. Large payloads are `ArtifactRef`s |
| `checks`, `integrity` | Done-check outcomes (§2.7) and whether the result file was isolation-checked (§2.6.4) |
| `harness`, `skill` | The harness id, version, model and session id, and the skill name and hash |
| `doneFailed?` | Set only with `onDoneFailure: "return"` (§2.7.2) |

There is one reference type, `ArtifactRef`, and you read it with `ref.text()` (§2.8.1). The names `BlobRef`, `transcriptPath`, `transcriptUrl` and `readArtifact` are retired.

When a call throws and when it resolves is fixed by these rules:

1. **Agents throw.** Calling an Agent, or calling `agent()`, either resolves to `AgentResult<O>` or throws a subclass of `SelfbuildingError`. That covers no result, done checks exhausted, harness failure, timeout, budget, interruption and abort. An agent that honestly reports `status: "blocked" | "failed"` still resolves (§2.7.2).
2. **`.settled()` never throws for agent failures.** `CodeReview.settled(input, opts)` and `agent.settled(spec)` resolve `{ ok: true; value } | { ok: false; code; error }`. They throw only for usage errors (`SelfbuildingUsageError`, §3.1).
3. **`parallel()` and `pipeline()` turn agent-level throws into `null`.** They never reject for them. The error goes on the event stream.
4. **`run()` resolves for every agent-level outcome.** It resolves `RunOutcome { runId, status, output, usage, replayedUsd, events }`, where `status` is `"ok" | "partial" | "failed" | "budget_exhausted" | "aborted" | "needs_attention" | "waiting"`. It throws only for usage and config errors: `ConfigError`, `NestingDepthError`, `NonDeterminismError` in strict mode, `RunIdConflictError` and `JournalVersionError`.
5. **Every `SelfbuildingError` carries `code`, `retryable` and `recovery`.** `recovery` is `{ branch?, headSha?, commits?, sessionId?, sandbox?, snapshotId?, transcript?, lastValidResult?, skill? }`, so you can continue the work by hand.

The canonical error names are `BudgetExceededError`, `DoneCheckFailedError` and `AgentInterruptedError`. The names `BudgetExhaustedError`, `DoneCheckError`, `InterruptedError` and the class `AgentError` are retired. `FailureReason` and `AgentError.code` are replaced by the single `ErrorCode` union in §9.8. The runtime's `Outcome.reason` (§6.7) is typed as that union.

### 1.10 Support tiers

There are two tiers, `stable` and `experimental`. Every adapter value exposes its tier as `adapter.stability`.

- **Stable** means the adapter meets the verification bar in §10.3. For harnesses and providers, that is L2 conformance, 7 consecutive green L5 nights and a clean leak ledger. For hosts, it is green L3 on every PR. For channels, it is green emulator or fake flows on every PR plus a green nightly live drift check.
- **Experimental** means the adapter ships behind the same interface and is tested against recorded fixtures. It prints one warning per process, and its options may change in any minor release (§1.13).
- **The tier is not part of the import path.** There is no `/experimental` subpath. Promotion is a changelog line and needs no import change, so it is never a breaking change.

| Kind | Stable at v1.0 | Experimental at v1.0 |
|---|---|---|
| Harness | Claude Code, Codex, OpenCode | Amp, Droid, Pi, Grok |
| Provider | Docker, Impello, E2B | Daytona, Vercel Sandbox, Modal, Cloudflare Sandbox (each is promoted when it meets the bar) |
| Host | plain Node, Trigger.dev, Inngest, Cloudflare Workflows | none |
| Channel | Slack, Discord, GitHub PR comments | none |

The reference deployment the project tests against is Trigger.dev + Impello + Claude Code + Slack and GitHub.

### 1.11 Configuration reference

#### Where config comes from

- **Only the CLI and `loadConfig()` find config.** Both search from a starting directory upward until they reach a directory containing `.git`, or the filesystem root. The starting directory is the current directory for the CLI and `cwd` for `loadConfig()`. They load the first of `selfbuilding.config.ts`, `.mts`, `.js` or `.mjs`. Two of these files in one directory is a `ConfigError`.
- **The config file is TypeScript loaded with `jiti`,** so it needs no build step. Its default export must be the value returned by `defineConfig(...)`.
- **To skip discovery,** pass `--config <path>`, set `SELFBUILDING_CONFIG`, or call `loadConfig({ path })`.
- **Library calls never load config on their own.** You pass a `config` to `run()` or to an Agent call, or you pass the settings directly.
- **`defineConfig` is the only config builder.** There is no other builder. Git and secret settings are `defineConfig` keys (below), and harness auth is the `credentials` option on each harness value (§4.9).

#### `SelfbuildingConfig`

```ts
interface SelfbuildingConfig {
  deployment?: DeploymentId;
  harness?: Harness;
  sandbox?: SandboxProvider;
  effort?: Effort;
  journal?: JournalStore;
  artifacts?: ArtifactStore;
  budget?: Budget;
  concurrency?: { sandboxes?: number; createsPerMinute?: number };
  timeouts?: Partial<Timeouts>;
  skills?: { sources?: SkillSource[]; packs?: SkillPack[]; disable?: string[]; defaults?: boolean; strict?: boolean };
  harnessHold?: Partial<Record<HarnessId, string>>;
  secrets?: SecretSource;
  git?: GitCredentialBroker;
  egress?: EgressPolicy;
  hitl?: HitlOptions;
  notify?: NotifyOptions;
  events?: EventSink[];
  strict?: boolean;
  debug?: { rawEvents?: boolean };
  controlPlane?: { url: string; token: Secret };
}
```

| Key | Type | Default | Owner |
|---|---|---|---|
| `deployment` | `DeploymentId` (`^[a-z0-9-]{1,32}$`) | Plain Node: `local-<hostname>`. Hosted hosts require it and throw `ConfigError` at factory build when it is missing | §5.2 |
| `harness` | `Harness` | none. A call that needs one throws `ConfigError` | §4 |
| `sandbox` | `SandboxProvider` | none. Same as `harness` | §5 |
| `effort` | `Effort` | the harness default | §4.2 |
| `journal` | `JournalStore` | Library: none, so the run cannot be resumed and a warning is emitted once. CLI: `fileJournal(".selfbuilding/journal")` | §3.9 |
| `artifacts` | `ArtifactStore` | `fileArtifacts(".selfbuilding/artifacts")` on plain Node. Durable hosts require one | §2.8, §7.10 |
| `budget` | `{ usd?, tokens?, wallClock?: Duration, perAgent?: { usd?, wallClock?, maxTurns? }, minAgentUsd?, prices?, allowUnmetered? }` | no limit | §9.6 |
| `concurrency.sandboxes` | `number` | `min(4, provider limit)` | §3.12 |
| `concurrency.createsPerMinute` | `number` | the provider limit, otherwise 10 | §9.6 |
| `timeouts` | `{ boot, setup, start, idle, postSubmitGrace, cancelGrace }` as `Duration`s. The call-level limit is the per-call `timeout` option | §6.11 defaults | §6.11 |
| `skills.sources` | `SkillSource[]` | `[]`. `init` writes `[{ root: ".agents/skills" }]` | §2.2 |
| `skills.packs`, `.disable`, `.defaults`, `.strict` | as typed | `[]`, `[]`, `true`, `false` | §2.2, §2.10.3 |
| `harnessHold` | `{ [harnessId]: version }` | `{}` | §4.11 |
| `secrets` | `SecretSource` | none, so declared secrets throw `MissingSecretError` | §9.2 |
| `git` | `GitCredentialBroker`, e.g. `githubApp({...})` | none. Public clones only, and no push | §9.2 |
| `egress` | `EgressPolicy` | `"open"` | §9.5 |
| `hitl` | `HitlOptions` | `{ mode: "afk" }` when no channel is set | §8.2 |
| `notify` | `NotifyOptions` | `{ on: ["run.end", "run.failed"] }` | §8.9 |
| `events` | `EventSink[]` | CLI: a JSONL file per run. Library: none | §9.7 |
| `strict` | `boolean` | `false`. `@selfbuilding/testing` sets `true` | §3.8 |
| `debug.rawEvents` | `boolean` | `false` | §4.3 |
| `controlPlane` | `{ url, token }` | none (post-v1) | §7.11 |

Units follow one rule. Public durations are `Duration` values with no unit suffix in the key. Money is always `usd`. The concurrency cap is always `concurrency.sandboxes`. The names `maxSandboxes`, `maxConcurrentSandboxes`, `maxSandboxCreatesPerMinute`, `wallClockMs` and `timeoutMs` (in public options) are retired.

#### Precedence

There are two orders, one for execution settings and one for run-level limits.

- **Execution settings** (`harness`, `sandbox`, `effort`, `timeouts`), highest first:
  1. per-call options
  2. the Agent's own defaults (contract `defaults`, `.with()`)
  3. the factory's `defaults`
  4. `run()` options
  5. config
- **Run-level settings** (`journal`, `artifacts`, `budget`, `concurrency`, `hitl`, `notify`, `events`, `strict`), highest first:
  1. `run()` options
  2. the factory's options
  3. config

Objects are never deep-merged. A key set at a higher level replaces the whole value below it. For example, a factory `budget` replaces the config `budget` completely. The one exception is `hitl`, which is merged field by field (§8.2).

#### Environment variables

Library packages read no environment variables. `fromEnv(name)` reads one only when your own code calls it.

| Variable | Read by | Effect |
|---|---|---|
| `SELFBUILDING_CONFIG` | CLI | Path to the config file. Same as `--config` |
| `SELFBUILDING_STRICT` | CLI, `@selfbuilding/testing` | `1` sets `strict: true` |
| `SELFBUILDING_CI_BUDGET_USD` | Selfbuilding's own CI only (`ci.config.ts`, §10.3) | Not a product setting |

These variables are set by Selfbuilding inside the sandbox for your hooks to read: `SELFBUILDING_RUN_ID`, `SELFBUILDING_HOOK` (`setup` or `start`) and `SELFBUILDING_BOOT_MODE` (`fresh`, `reuse`, `restore`, `repo-image` or `build`). This is the one list of boot modes. §5.10 and §6.5 use it:

- `fresh`: a new box from a harness image; `setup.sh` then `start.sh` run.
- `reuse`: an existing box reopened with its filesystem intact after a reboot-style resume (for example a stopped Vercel sandbox or a Docker container restarted after a daemon restart); `setup.sh` is skipped when its stamp matches, `start.sh` runs.
- `restore`: a box rebuilt from a snapshot or a git checkpoint, a fork child, or a source box after quiescence (§5.8); `start.sh` runs.
- `repo-image`: a box booted from a prebuilt per-repo image (§5.7); `start.sh` runs.
- `build`: a per-repo image build (§5.7); `setup.sh` runs and is always fatal on failure.

### 1.12 CLI reference

The CLI loads factory files and the config with `jiti`. A factory file's default export is used unless you pass `--export <name>`.

Shared conventions:

- **`--input`** accepts inline JSON, `@path/to/file.json`, or `-` to read JSON from stdin.
- **`--json`** writes NDJSON events to stdout, one per line. The last line is the `RunOutcome` or the command result. Human-readable logs always go to stderr.
- **`--env-file <path>`** loads a dotenv file before the config is evaluated.

| Command | What it does | Main flags | Ships |
|---|---|---|---|
| `init` | Scaffolds the files in §1.8 | `--harness`, `--provider`, `--host`, `--channel`, `--template`, `--force` | M1 |
| `run <file>` | Starts a run | `--input`, `--export`, `--run-id`, `--afk`, `--config`, `--env-file`, `--json` | M1 |
| `doctor` | Checks the config and every credential, and reports everything missing at once (§9.9) | `--config`, `--json` | M1 |
| `skills build` | Generates typed exports for the skill sources (§2.5.2) | `--out` | M1 |
| `skills check` | Fails when the generated file is stale | none | M1 |
| `skills validate [dir]` | Validates skill folders (§2.2.2) and lists vendored skills with their licenses (§10.7) | `--strict` | M1 |
| `resume <runId>` | Resumes a run from its journal | `--interrupted <callPath>=fail\|resume-session\|restore-and-rerun\|skip`, `--json` | M2 |
| `watch <runId>` | Tails a run's events | `--from <seq>`, `--json` | M2 |
| `cancel <runId>` | Cancels a run and kills or parks its sandboxes. Reports counts, and says so when a provider listing failed | `--reason` | M2 |
| `reap` | Sweeps leaked sandboxes (§5.9), expires overdue asks and sends reminders on plain Node (§8.5, §8.8) | `--every <duration>`, `--provider`, `--dry-run`, `--json` | M2 |
| `images build` | Builds harness or per-repo images for a provider | `--provider`, `--harness`, `--repo`, `--uid` | M2 |
| `answer <runId> <askId\|#n> [answer]` | Answers an Ask without a channel | `--value @file.json` for schema asks | M3 |
| `skills add <git-url>#<sha>` | Vendors a skill into a project source, with its license (§10.7) | `--to <dir>`, `--allow-unlicensed` | M3 |
| `skills infer <dir>` | Drafts a sidecar contract for a human to review | none | M4 |

| Exit code | Meaning |
|---|---|
| 0 | Success. For `run` and `resume`, the status is `ok` |
| 1 | Run status `failed`. Also: `skills check` found a stale file, `doctor` found a problem, or `reap` could not list a provider |
| 2 | Usage or config error. Nothing ran |
| 3 | Run status `partial` |
| 4 | Run status `budget_exhausted` |
| 5 | Run status `needs_attention`. Resume with `--interrupted` |
| 6 | Run status `waiting`. The run is parked on an Ask, and the process exited (plain Node) |
| 7 | Run status `aborted` |
| 130 | Interrupted by SIGINT before the run settled. It can be resumed |

### 1.13 Versioning and compatibility

**Version lines.** All packages are versioned together (§10.1). One version number names one compatible set.

- **Before 1.0:** a minor release (0.N to 0.N+1) may break any surface below. Every break has a "Breaking" changelog entry with migration steps. Patch releases never break.
- **From 1.0:** semver applies, and a break needs a major release.

| Surface | Counts as breaking | Version marker |
|---|---|---|
| TypeScript API | Removing or renaming an export, narrowing a parameter, widening a result, changing a default's behaviour | API Extractor report (§10.1) |
| Config keys | Removing or renaming a key, or changing a default | `SelfbuildingConfig` |
| Event schema | Removing or renaming an event type or field, or changing what it means. A new optional field or a new event type is not breaking | `v` in the envelope (§9.7) |
| Journal format | Anything that makes an existing journal unreadable, or changes the key of an unchanged call | `journalFormat` in the journal header |
| Runtime protocol | Any change to `RuntimeSpec`, `wait` output, `outcome.json` or runtime exit codes | `RuntimeSpec.v`, runtime generation (§6.15) |
| CLI | Removing a command or flag, changing an exit code, or changing a `--json` field | the CLI reference above |
| Prompt preamble | Any text change, because it changes skill hashes | `preambleVersion` |
| Harness pins (`harness-versions.json`) | A pin bump is a patch when the adapter code is unchanged and the parse-contract probe is green. It is a minor when the adapter changed | none |
| Default images | Never breaking. Images are tagged with the Selfbuilding version, and a release never moves an older version's tag | image tag |

**Experimental adapters** may break in any minor release, including after 1.0, and the changelog lists each break. An experimental adapter is removed only after a deprecation warning that ships one minor release earlier.

**Resuming across an upgrade.**

- **Journal header.** Each journal header records `selfbuildingVersion`, `journalFormat` and `preambleVersion`.
- **Journal format.**
  - If the format is unchanged, resume works.
  - If the format is newer and a migration ships, `selfbuilding resume` copies the journal to `<journal>.bak-<format>` and then migrates it in place.
  - If no migration exists, resume throws `JournalVersionError { found, supported, lastVersionThatReads }`.
- **Preamble.** Core keeps every preamble version it has shipped. A run uses the `preambleVersion` recorded when it started for every call, so an upgrade in the middle of a run never invalidates its replay. New runs use the newest preamble.
- **Durable hosts.** Step values carry `v`, and core reads values written by the previous minor release. A deploy can therefore pick up runs that are in flight.
- **Runtime bundle.** Core always uploads the runtime bundle from its own release. A sandbox holding an older generation is re-provisioned (§6.15).

**Node support.**

- `engines.node` is `>=22.12` on every package.
- CI runs Node 22 and 24.
- Selfbuilding supports every Node LTS line that has not reached end of life. A line is dropped in the first minor release after its end of life.
- Official sandbox images ship Node 22, and the in-sandbox runtime requires Node 22 or later.
- Bun and Deno are best effort. On Cloudflare Workers, only `@selfbuilding/core` and the Cloudflare packages run, and they need `nodejs_compat` (§10.1).

### 1.14 Keeping the spec and the examples honest

These checks run in `ci.yml` on every PR:

1. **Every code block compiles.** Each fenced `ts` block in the spec, the docs and the templates is extracted into the `examples/spec` workspace package. It is wrapped as a module with a shared prelude (`docs/prelude.d.ts`, which declares free variables such as `repo`, `box`, `spec`, `config` and model-id constants) and typechecked with `tsc --noEmit` against the built `.d.ts` files. A block that is deliberately partial must be fenced as `ts nocheck` with a one-line reason, which is listed in the CI output. This check is `pnpm docs:check`; §2.10.2 adds a runtime parse of default-pack inputs to it.
2. **Package names come from the registry.** A script scans the docs, examples and templates for `@selfbuilding/…` specifiers. It fails on any package or subpath that is not in the registry in §1.7. The registry is generated from the workspace `package.json` `exports`.
3. **Each exported name has one owner.** Across all published `.d.ts` files, every exported name has exactly one declaration. Re-exports are allowed only where §1.7 lists them.
4. **The CLI package exports nothing.** The `selfbuilding` package has no `exports` field.
5. **The config table matches the type.** A test checks that every key of `SelfbuildingConfig` appears in the table in §1.11, and that the table has no extra keys.

§10.8 adds docs lint (section references, error names) on top of these checks.

### 1.15 Open questions

All open questions for this draft, including the ones raised by this section (npm scope, subscription auth, Trigger.dev fan-out cost), are collected in §11. Questions this section closed are listed in §11.8.

### 1.16 Reconciliation applied to sections 2 to 10

Sections 2 to 10 were drafted separately. This draft applied the following edits so that they agree with this section and with each other. Where a later section still disagrees with §1, §1 wins.

| Section | Edit applied |
|---|---|
| §2.2, §2.5, §2.10 | The default pack is imported from `@selfbuilding/agents`. `defineAgent` is internal behind `Agent.fromSkill`. Harness slots are `Harness` values. The `model` call option is removed. `DoneCheckError` is `DoneCheckFailedError`. §2.8 owns the merged `AgentResult` fields from §1.9. `CodeReview` takes its review `target` in the input; working branch and base move to `git`, and PR opening to `pr` |
| §2.4, §2.7 | `defaults.harness` and `judge.harness` take a `Harness`. `timeoutMs` is `timeout: Duration` |
| §2.9, §3.1, §3.4 | Agents throw (§1.9). `agent()` takes only inline prompts; `required` and the `agent(Agent, …)` form are removed. `AgentError` and `FailureReason` are replaced by `SelfbuildingError` and `ErrorCode` (§9.8). `AgentOptions`, `PlacementOptions` and `LifecycleOptions` are merged into `AgentCallOptions` (§2.5.1) |
| §3.3, §3.13 | `factory()` uses the signature from §1.8. `maxSandboxes` is `concurrency.sandboxes`. Imports are `@selfbuilding/harnesses/<id>` and `@selfbuilding/journal-sqlite`. Examples are rewritten against the §2.10 schemas |
| §3.11, §6.13 | `sandbox({ provider, repo, branch, label, from })`. A busy handle throws `SandboxBusyError` (no FIFO queue). One branch-naming function, `branchName()`, using the full run id. The provider-level handle is `ProviderSandbox` |
| §3.9, §7.5.4 | One `JournalStore` interface with a fenced lease. Hosted resume after a terminal failure uses epochs and the success cache on every host (§7.6) |
| §3.15, §6.8, §1.12 | The per-path `onInterrupted` override accepts `restore-and-rerun` and `skip` for shared-handle calls |
| §4.3, §9.7 | One `EventEnvelope`, owned by §9.7 |
| §4.9, §9.2 | The harness auth option is `credentials` (a single credential or a pool). The `selfbuilding({...})` builder is deleted |
| §5, §9.8 | Sandbox error classes end in `Error` (`SandboxUnavailableError`, …). §5.2 labels include `selfbuilding.step` and `selfbuilding.launch` |
| §5.5, §5.6, §5.10 | OCI images are `selfbuilding/<harness>:<version>`; provider templates are `selfbuilding-<harness>`. `selfbuilding images build`. The boot-mode list from §1.11 |
| §6.3, §6.4, §6.7, §6.11, §6.16 | Runtime requires Node 22 or later. `launchId` uses the §7.2 format. No write-it-yourself `submit.json` fallback. Recovery fields come from §9.8. Public timeouts are `Duration` values. "Runner" is "runtime" throughout |
| §6.6, §7.4.2 | One long wait per launch with re-arms; no per-wake token loop |
| §2.8.2, §3.11, §6.10, §6.12, §6.13, §9.2 | The agent holds a read-only git token. The host pushes in its collect step after the agent's processes have exited. Checkpoint and WIP commits exclude ignored files and the built-in exclude list (§9.3) |
| §7.3, §7.5, §7.12 | `ctx.step`, `ctx.now` and `ctx.uuid` are the module-level `step()`, `now()` and `uuid()`. The plain Node host id is `node`. Packages are `@selfbuilding/host-<id>` with `create<Host>Host` constructors. §7.12.1 links to the quickstart. `replay: "pin"` is not in v1 |
| §7.7, §6.11 | One timeout chain, defined in §6.11 |
| §8 | `selfbuilding sweep` is `selfbuilding reap`. `transcriptPath` is `artifacts.transcript`. `createHitlHandler` lives in `@selfbuilding/hooks`. `ParallelWaitError` is removed: on Trigger.dev factory-side asks share the parent's wake stream (§7.5.1). Live watching uses event sinks and `selfbuilding watch` |
| §9.2, §9.6, §9.8 | Concurrency settings move out of `Budget`. §9.8 owns the `ErrorCode` union, the error registry and the `recovery` shape. The live cross-agent budget cutoff is described as a control-plane feature everywhere |
| §10 | Layout names from §1.7. No `/experimental` subpath. `docs/out-of-scope/` instead of `.out-of-scope/`. Node 22 and 24 matrix. CLI milestones from §1.12. The checks in §1.14 run in `ci.yml` |
| all | Every open question moved to §11 |

## 2. Skills to Agent(): compilation and the result contract

This section explains how a SKILL.md folder becomes a typed async function, and what that function promises to return. It covers:
- discovery and loading
- the contract: input, result, workspace requirements and done checks
- prompt assembly
- the `submit_result` handoff
- validation and retries
- artifacts
- the failure contract
- the built-in default pack, with its canonical call shapes, and overrides

Other sections own these topics. This section only references them:
- The failure rules: §1.9. The error classes, `ErrorCode` and `recovery`: §9.8. This section fills `AgentResult`, `Artifacts`, `Usage` and `ArtifactRef` (§2.8) and never redeclares the error types.
- How Agent calls compose, and how they are journaled: §3.
- How each harness is launched and parsed: §4.
- Where the sandbox comes from: §5.
- The in-sandbox supervisor and tool server that serve `submit_result`: §6.
- How a call maps onto a host step: §7.
- `ask_human`: §8.
- Credentials, git pushes and redaction: §9.

### 2.1 Pipeline at a glance

```
SKILL.md folder ──load──▶ SkillDef ──+ contract──▶ Agent<I, O>
                                                     │  call(input, opts)
                                                     ▼
  check input + workspace options (host) ─▶ materialise skill into sandbox ─▶ assemble prompt
        ─▶ harness turn ─▶ selfbuilding MCP server must connect, or the call fails fast
        ─▶ submit_result (supervisor validates against JSON Schema, retries in the same turn)
        ─▶ host integrity check + Zod parse (authoritative) ─▶ done checks ─▶ collect artifacts
        ─▶ AgentResult<O>   (or a thrown SelfbuildingError; .settled() gives the value form, §2.9)
```

Six rules hold throughout.

1. **One code path for results.** Every harness returns its result through the injected `submit_result` tool. Nothing scrapes the result out of free text. No harness's native structured-output flag is used in v1. There is no fallback path.
2. **The runtime picks the terminal outcome once.** A harness adapter reports events. It never decides success (§4, §6).
3. **The host decides validity.** The sandbox is untrusted. The host reads only the file the supervisor wrote, checks who owns it, and parses it again with the full Zod schema.
4. **File templates are processed and programmatic strings are literal.** Text that arrives through `input` is never expanded, substituted or executed.
5. **Contracts are explicit, with a safe default.** A skill with no contract still compiles, using the inferred default contract (§2.4.5). Selfbuilding never infers a schema at run time.
6. **Where the work happens is never skill input.** `repo`, the working and base branch (`git`), `pr` and `sandbox` are call options (§2.5.1). The input schema describes only the task. A review agent's `target` is task data (it names the code to read), not placement.

### 2.2 Discovery and loading

#### 2.2.1 API

```ts
// @selfbuilding/skills
export function loadSkill(dir: string, opts?: LoadOptions): Promise<SkillDef>;
export function loadSkills(sources: SkillSource[], opts?: LoadOptions): Promise<SkillRegistry>;

type SkillSource =
  | { dir: string }                 // one skill folder
  | { root: string }                // a folder of skill folders, e.g. ".agents/skills"
  | { pack: SkillPack };            // an npm package export, e.g. defaultPack from @selfbuilding/agents

interface LoadOptions {
  strict?: boolean;                 // default false (lenient)
  cwd?: string;                     // relative paths resolve against this, never process.cwd() implicitly
}

interface SkillDef {
  name: string;                     // kebab, equals folder name
  description: string;
  body: string;                     // SKILL.md body, frontmatter stripped, unprocessed
  dir: string;                      // absolute path on the host
  files: SkillFile[];               // every file except the sidecar, with mode and size
  frontmatter: Record<string, unknown>;  // raw, including unknown keys
  allowedTools: string[];           // normalised from any of the three formats
  contract: ContractSource;         // "sidecar" | "metadata" | "frontmatter" | "inferred" | "inherited"
  hash: string;                     // sha256, see 2.2.4
  warnings: string[];
}
```

Sources are explicit. Selfbuilding scans only folders listed in `selfbuilding.config.ts` (`skills.sources`) or passed to `loadSkills`. `selfbuilding init` writes a config that lists `{ root: ".agents/skills" }`, and the default pack is included unless `skills.defaults: false`. The user can see that line and delete it.

Runtime sources in v1 are local folders and npm packs. Skills from git URLs are vendored into the repo with `selfbuilding skills add <git-url>#<sha>` (§10.7). That keeps runs free of network fetches and keeps the hash deterministic.

#### 2.2.2 Validation

| Check | Strict | Lenient (default) |
|---|---|---|
| `SKILL.md` present | error | error |
| `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, 1 to 64 chars | error | error |
| `name` equals folder name | error | warning; the folder name wins |
| `description` 1 to 1024 chars | error | error if empty, warning if over 1024 (it is truncated) |
| Unknown frontmatter keys | error, with the same wording as the spec validator ("Unexpected fields in frontmatter: …") | kept in `frontmatter`, no warning for known harness extensions (`argument-hint`, `model`, `effort`, `disable-model-invocation`, `user-invocable`, `version`, …) |
| `metadata` values not all strings | error | warning |
| Body over 500 lines / ~5000 tokens | warning | warning |
| Symlink resolving outside the folder | error | error |
| Executable file outside `scripts/` | error | warning |
| More than 200 files, any file over 1 MiB, or more than 8 MiB in total | error | error |
| Binary file outside `assets/` | warning | warning |

`allowed-tools` is accepted in three forms: a YAML list, a comma-separated string and a space-separated string. All three are normalised to `string[]`.

Within one source tier, two skills with the same `name` raise `DuplicateSkillError`. Across tiers, the precedence rules in §2.10.3 apply. Selfbuilding never merges two skills or quietly picks one.

#### 2.2.3 Trust

A skill folder from a vendored or third-party pack is treated as untrusted content. The loader reads it and never runs anything from it on the host. Its `scripts/` run only inside the sandbox.

The one exception is the TypeScript sidecar. The user imports it into their own program, so it runs with the user's trust, like any other import.

#### 2.2.4 Content hash

`hash = sha256(preambleVersion ‖ sorted[(relPath, mode, sha256(bytes))] ‖ contractFingerprint)`

- The hash covers the sidecar, so a schema change invalidates replay.
- `contractFingerprint` is made of:
  - the canonical JSON Schema of the input and the output;
  - the workspace requirements;
  - the protected-path list;
  - the serialised done-check list. A function check (`assert`, or a `cmd` derived from the input) contributes its `id`, not its code.
- The hash goes into the step key together with the input hash (§3.2). If the skill is edited, a resumed run re-executes that call instead of reusing a result from the old skill. The journal then logs `skip [replay-invalidated: skill-hash]`.

### 2.3 Turning the body into a prompt

#### 2.3.1 What the sandbox receives

The runtime (§6) materialises each skill that the call uses:
- **Copy.** The folder is copied to `/selfbuilding/skills/<name>/`, without the sidecar `selfbuilding.ts`. The agent sees the contract as JSON Schema in its preamble, not as code.
- **Links.** Symlinks to the copy are placed at `<workdir>/.claude/skills/<name>` and `<workdir>/.agents/skills/<name>`. Relative references, `scripts/` and nested skills then resolve on Claude Code, Codex and OpenCode. Pi gets `--skill <path>`. Amp and Droid get their own path settings (§4.6).
- **Shadowing.** Each harness runs with an isolated HOME (§4.1), so a Selfbuilding skill shadows any user-level skill with the same name.
- **Review diff.** For contracts with `workspace.target: "review"`, the runtime also writes `/selfbuilding/in/diff.patch`, the output of `git diff <baseSha>...<headSha>` for the resolved review target (§2.4.3).

Selfbuilding does not rely on harness auto-discovery to trigger the skill. Discovery is probabilistic, `--bare` and similar flags turn it off, and headless modes differ between harnesses. The body goes into the prompt directly.

#### 2.3.2 Prompt layout

````
[system / appended system prompt]   Selfbuilding preamble v1
  - you are running unattended inside a disposable sandbox at <workdir>
  - finish by calling submit_result exactly once; its schema is below
  - submit_result is the only way to return a result; files you write are never read as a result
  - result schema (JSON Schema, pretty-printed)
  - definition of done: the commands that will be run, artifact expectations, and the
    protected paths that are restored from the base commit when checks run (2.7.4)
  - ask_human usage and AFK policy (§8)
  - harness notes (e.g. "subagents must finish within this turn")
[user message]
  # Skill: <name>
  <SKILL.md body, after substitution and context expansion>
  # Workspace
  repo, base branch and baseSha, working branch, PR number and URL (if any).
  Rendered by Selfbuilding from the call options and git, never from input.
  # Input
  ```json
  <input, JSON.stringify(input, null, 2)>
  ```
````

There is no "if submit_result is unavailable, write the JSON to a file" instruction. The agent cannot write the result file (§6.4), and a write-it-yourself path would let it change a result after validation. If the tool is unavailable, the call fails fast (§2.6.2).

#### 2.3.3 Substitution (body only, never input values)

| Token in SKILL.md | Replaced with |
|---|---|
| `${CLAUDE_SKILL_DIR}`, `${SELFBUILDING_SKILL_DIR}` | `/selfbuilding/skills/<name>` |
| `${CLAUDE_PROJECT_DIR}`, `${SELFBUILDING_WORKDIR}` | the sandbox workdir |
| `${CLAUDE_SESSION_ID}` | the harness session id that Selfbuilding pre-assigns or captures (§4.7) |
| `$ARGUMENTS` | `input.args` if the input has a string `args`, otherwise the JSON input |
| `$ARGUMENTS[N]`, `$N` | the Nth whitespace-split token of `input.args` |
| `$name` (declared in frontmatter `arguments`) | `input[name]`, stringified |

Substitution makes one pass. A value inserted by substitution is not scanned again. An unknown `${…}` token is left as it is and produces a warning.

#### 2.3.4 Context expansion

Inline `` !`cmd` `` expressions in the body run in the sandbox after setup and before the turn, the same way Claude Code expands them in skills. The rules:
- Expressions run in parallel, with a 30 s timeout each.
- A non-zero exit or a timeout fails the call fast with `SkillContextError`.
- Expressions inside `<!-- -->` are inert.
- An expression that arrives through an input value is never run. Substitution happens after expansion, and expansion only scans the original file text.

#### 2.3.5 Claude-only constructs on other harnesses

| Construct in the body | Behaviour |
|---|---|
| `AskUserQuestion` | The preamble tells the agent to use `ask_human` instead (§8). On Claude Code, `AskUserQuestion` is disallowed so the agent cannot stall on it. |
| `Agent` / `Task` subagents | They work on Claude Code. Other harnesses get a preamble note that subagents are unavailable and the steps should be done in sequence. |
| `allowed-tools` | Advisory inside the sandbox. Harnesses run with permissions bypassed, because the sandbox is the boundary (§9). If `harnessPermissions: "enforce"` is set, it maps to `--allowedTools` (Claude), `permission` (OpenCode) and so on. Codex has no per-tool equivalent and logs a warning. |

### 2.4 The contract

A contract has six parts:
- the input schema
- the output (result) schema
- workspace requirements
- the done checks and protected paths
- artifact expectations
- run defaults

```ts
// @selfbuilding/core
export function defineContract<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(c: {
  input?: I;                         // default: DefaultInput
  output?: O;                        // default: DefaultResult
  workspace?: {
    repo?: "required" | "optional";             // default "required"
    target?: "none" | "review";                 // default "none"; see 2.4.3
  };
  testCommand?: string | ((input: z.input<I>) => string | undefined);   // the only test command checks will run
  done?: DoneCheck<z.input<I>, z.infer<O>>[];   // default: see 2.7.3
  protect?: { extra?: string[]; allow?: string[] };   // see 2.7.4
  artifacts?: {
    branch?: "required" | "optional" | "forbidden"
           | ((input: z.input<I>) => "required" | "optional" | "forbidden");   // default "optional"
    pr?: "required" | "optional" | "forbidden";       // default "optional"
  };
  defaults?: {
    harness?: Harness; effort?: Effort;   // Harness is a value, e.g. codex({...}) (§4); the model lives on it
    maxSubmitAttempts?: number; maxResumes?: number; maxDoneRetries?: number;
    timeout?: Duration;
  };
}): Contract<z.input<I>, z.infer<O>>;
```

#### 2.4.1 Where a contract lives, in order of precedence

1. **Sidecar `<skill>/selfbuilding.ts`** (recommended). It does `export default defineContract({...})`. The file passes the spec validator, which ignores files other than SKILL.md. It carries real TypeScript types and is excluded from what the agent sees.
2. **`metadata` pointers**, for repos that don't use TypeScript: `metadata: { selfbuilding-input: "schema/input.json", selfbuilding-output: "schema/output.json" }`.
   - The values are paths to JSON Schema files, which keeps `metadata` a string map.
   - A schema loaded from JSON is typed `unknown` unless codegen runs (§2.5.2).
3. **A top-level `selfbuilding:` frontmatter key**, read for compatibility. It fails strict spec validation. The loader warns about it in lenient mode and treats it as an error in strict mode.
4. **Inherited.** An override with no contract of its own takes the contract of the skill it replaces (§2.10.4).
5. **Inferred default** (§2.4.5).

Selfbuilding never asks a model to infer a contract at run time. `selfbuilding skills infer <dir>` drafts a sidecar for a human to review. It runs offline, once.

#### 2.4.2 Rules for the result schema

The result schema is also the input schema of an MCP tool, so it must be representable as JSON Schema.

- **The top level must be an object.** MCP tool inputs are objects. A non-object schema `T` is wrapped as `{ value: T }` on the wire and unwrapped before the caller sees it.
- **Generation.** The JSON Schema is generated with Zod v4 `z.toJSONSchema(schema, { target: "draft-7", io: "input" })`.
- **Unrepresentable constructs fail early.** `defineContract` throws `ContractError` at definition time for anything the generator cannot represent: functions, `z.custom` without a JSON Schema override, symbols, bigint, Map or Set. Dates must be ISO strings (`z.iso.datetime()`).
- **Transforms and refinements are allowed, at a cost.** They do not appear in the JSON Schema, so only the host parse enforces them (§2.6.4). A refinement failure costs a resume instead of an in-run retry. Wherever possible, put constraints in a form the schema can express (`min`, `max`, `regex`, `enum`, discriminated unions).
- **Recursive schemas** are allowed but produce a warning, because some harness tool layers flatten `$ref` poorly.
- **The serialised result is capped at 256 KiB.** The cap is configurable up to 1 MiB, the smallest step-payload limit among the hosts in §7. Anything larger belongs in files: declare a `z.array(z.string())` of paths in the result, and list them in `artifacts.files` (§2.8).

#### 2.4.3 Input schema and workspace options

- **Validated on the host.** The input is validated with Zod when the agent is called. An invalid input throws `AgentInputError` before any sandbox exists.
- **Input types.** The type parameter `I` is `z.input<typeof input>`, so fields that have `.default()` are optional at the call site.
- **Input is data.** The input is rendered into the prompt as JSON. Its strings are never substituted, expanded or run (§2.3).
- **Reserved keys.** The task goes in the input. Where it runs goes in the options: `repo`, `git` (working branch and base), `pr` and `sandbox` are `AgentCallOptions` (§2.5.1). Harness, budget and HITL channel are also options. `defineContract` throws `ContractError` if an input schema declares any of these top-level keys: `repo`, `base`, `branch`, `git`, `pr`, `sandbox`, `harness`, `model`. One name lives in one place.
- **Review targets.** A contract with `workspace.target: "review"` reads code it does not write. Its input declares a `target` field using the exported `ReviewTarget` schema: `{ kind: "pr", url } | { kind: "diff", base, head? }`. A `pr` target supplies the repo (from the URL), the base (the PR's base) and the head (the PR's head). A `diff` target compares `head` (default: the call's working branch) against `base`. On a shared handle, `target` may be omitted, and the handle's branch is reviewed against its base.
- **Workspace checks.** These run on the host before any sandbox exists, and a failure throws `AgentInputError`:
  - `workspace.repo: "required"`: a repo must come from the call, a `pr` review target, the factory defaults, the config file or a shared handle.
  - `workspace.target: "review"`: the input must carry a `target`, or the call must run on a shared handle.
  - Passing `repo` or `git.branch` that disagrees with a shared handle's own repo or branch, or with a `pr` target's repo.
  - A working branch whose PR head is in a fork, for agents that push. v1 does not push to forks.

#### 2.4.4 Inferred default contract

```ts
export const DefaultInput = z.object({
  task: z.string().describe("What to do, in plain language"),
  args: z.string().optional().describe("Free-form arguments, available as $ARGUMENTS"),
  context: z.record(z.string(), z.string()).optional(),
});

export const DefaultResult = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string().min(1).max(4000),
  findings: z.array(z.object({
    title: z.string(),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  })).optional(),
  nextSteps: z.array(z.string()).optional(),
});
```

#### 2.4.5 When the default applies

A skill with no sidecar, no `metadata` pointers, no `selfbuilding:` key and nothing to inherit from compiles with `DefaultInput`, `DefaultResult`, `workspace: { repo: "required", target: "none" }` and no done checks beyond the built-ins (§2.7.3).

### 2.5 The compiled Agent

#### 2.5.1 Type and call options

```ts
export type Agent<I, O> = {
  (input: I, opts?: AgentCallOptions): Promise<AgentResult<O>>;   // throws SelfbuildingError (§2.9)
  settled(input: I, opts?: AgentCallOptions): Promise<Settled<AgentResult<O>>>;
  readonly skill: SkillDef;
  readonly contract: Contract<I, O>;
  readonly inputJsonSchema: JSONSchema7;
  readonly outputJsonSchema: JSONSchema7;
  with(patch: AgentPatch<I, O>): Agent<I, O>;              // see 2.10.4
};
// Agent.fromSkill(dir, contract) (§1.8) is the only public constructor.

type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; error: SelfbuildingError | unknown };  // signal.reason when aborted

/** The one per-call options type. Every key is optional; factory defaults and config apply (§1.11). */
interface AgentCallOptions {
  config?: SelfbuildingConfig;             // explicit config for standalone calls (§1.8)

  // Where the work happens. Never skill input (2.4.3).
  repo?: string;                         // "github.com/acme/api"; default: review target, factory defaults, config
  sandbox?: "fresh" | SandboxProvider | SandboxHandle;   // §3.11; a handle supplies repo and branch
  git?: {                                // §6.13
    branch?: string;                     // working branch; default branchName(runId, callPath)
    baseBranch?: string;                 // default: the repo's default branch
    commitLeftovers?: boolean;           // default true
    identity?: "agent" | { mode: "attributed"; name: string; email: string };
    allowPushTo?: string[];              // refs outside refs/heads/selfbuilding/** and refs/selfbuilding/**
  };
  pr?: boolean | PrOptions;              // open or update a PR for the working branch (§6.13); default false

  // How it runs
  harness?: Harness; effort?: Effort;    // the model lives on the harness value
  label?: string;                        // replaces `Name#n` in the callPath (§3.2)
  phase?: string;                        // overrides the scope's current phase for this call
  budget?: { usd?: number; wallClock?: Duration };   // per call; defaults to budget.perAgent (§9.6)
  timeout?: Duration;                    // active-time limit for the whole call; default "2h" (§6.11)
  timeouts?: { idle?: Duration; boot?: Duration; setup?: Duration; start?: Duration;
               postSubmitGrace?: Duration; cancelGrace?: Duration };   // advanced (§6.11)
  retries?: number;                      // live re-runs after a turn that did work; default 0 (§3.4)
  checkpoint?: "git" | "snapshot" | "none";   // shared handles only (§3.11); default "git"
  secrets?: string[];                    // declared secret names (§9.2)
  hitl?: { risk?: "high"; timeout?: Duration; maxAsks?: number };   // may only tighten (§8.2)
  onDoneFailure?: "throw" | "return";    // default "throw"
  onInterrupted?: "fail" | "resume-session";   // default "fail" (§3.10, §6.8)
  maxSubmitAttempts?: number; maxResumes?: number; maxDoneRetries?: number;
  requireIsolation?: boolean;            // refuse "same-user" sandboxes (2.6.4); default false
  lifecycle?: { preserveOnCancel?: boolean; keepOnFailure?: false | `${number}${"m" | "h"}` };   // §6.10, §6.14
  signal?: AbortSignal;
}

interface PrOptions {                    // §6.13
  draft?: boolean;                       // default true
  base?: string;                         // default: the call's base branch
  title?: string | ((r: unknown) => string);
  body?: string | ((r: unknown, a: Artifacts) => string);
  labels?: string[];
}
```

How the working branch behaves:

| Agent kind | `git.branch: "x"` | no `git.branch` |
|---|---|---|
| Read-only (`artifacts.branch: "forbidden"`) | review target `diff` defaults its `head` to `x` | the review target alone decides what is checked out; no target is allowed only if `workspace.target` is `"none"` |
| Writes code | check out `x` (or create it from the base if it does not exist) and push to it. To continue an open PR, pass its head branch; `pr` then updates that PR instead of opening a new one | new branch `branchName(runId, callPath)` (§6.13) off the base |

An `Agent` is a plain function. Called outside a run, it is the same as a one-step `run()` with a fresh run id, journaled only if the settings include a `journal` (§1.8). Called inside `run()`, `pipeline()` or `parallel()`, it picks up the ambient run context and becomes one journaled step.

#### 2.5.2 Codegen

`selfbuilding skills build` writes `selfbuilding/skills.gen.ts`:

```ts nocheck generated file shown for shape only
// generated, do not edit
import { Agent } from "@selfbuilding/core";
import codeReviewContract from "../.agents/skills/code-review/selfbuilding.ts";
export const CodeReview = await Agent.fromSkill(new URL("../.agents/skills/code-review/", import.meta.url), codeReviewContract);
export const ImplementSpec = /* ... */;
// improve-codebase-architecture → ImproveCodebaseArchitecture
```

- Names convert from kebab-case to PascalCase. A collision after conversion is an error.
- For JSON-Schema-only contracts (§2.4.1, option 2), codegen emits TypeScript types from the schema, so those agents are typed as well.
- `selfbuilding skills check` fails CI when the generated file is stale. It compares the hashes recorded in the file header.

### 2.6 The result contract: `submit_result`

#### 2.6.1 Mechanism

The tool path has three parts (§6.3):
- `selfbuilding-mcp` is a stateless stdio MCP server that the harness spawns. Each harness starts it under the server name `selfbuilding`, so the tool is `mcp__selfbuilding__submit_result` on Claude Code, `selfbuilding_submit_result` on OpenCode, and so on. Pi has no MCP, so it gets the same tool as a Pi extension (§4.5).
- `selfbuilding-mcp` forwards every call over `/run/selfbuilding/tools.sock` to the supervisor.
- **Only the supervisor validates and writes.** The agent cannot write any file the host reads as a result.

```
$A = /selfbuilding/state/calls/<stepKey>/<attempt>/   root-owned (or the dedicated selfbuilding user), read-only to the agent (§6.4)
$A/spec.json                     includes resultSchema (draft-07), written by the host before the turn
$A/submissions/<n>.json          every call, valid or not, with its issues
$A/result.json                   last valid submission; written only by the supervisor (temp file + rename), mode 0644
```

How the supervisor handles each call:
1. It validates the arguments against `spec.json#resultSchema` with a draft-07 validator.
2. **If the arguments are invalid,** it returns `isError: true` with a numbered list of issues (JSON pointer, expected value, received value) and the line "Fix these and call submit_result again. Do not redo the work." The model retries in the same turn.
3. **If they are valid,** it records the submit-time tree state (§4.5.1), writes `$A/result.json` and returns "Accepted. Stop now; do not make further changes." The runtime then ends the turn (§2.6.3).
4. After `maxSubmitAttempts` invalid calls (default 3), the next call returns "Submission limit reached. Stop." The runtime ends the turn, and the call fails with `ResultValidationError`.
5. Every call emits a `result.submitted { attempt, valid, issues? }` event.

If the agent calls the tool more than once, the last valid submission wins. All calls stay in the transcript.

#### 2.6.2 The tool must be connected, on every harness

A run in which `submit_result` cannot be reached can only end in `no_result` after wasting a whole turn. So the supervisor checks that the tool is connected before it counts on it:

- When `selfbuilding-mcp` (or the Pi extension) starts, it sends `hello { pid }` over the tool socket. This is harness-agnostic.
- If no `hello` arrives within 60 s of the harness spawn, the supervisor stops the harness (SIGINT, then SIGKILL, §6.10). Some harnesses report MCP status at session start (Claude `system/init.mcp_servers`, §4.8). On those, any status other than `connected` triggers the stop at once.
- The call fails as `HarnessFailure { code: "harness_crash", message: "selfbuilding MCP server did not connect: <detail>" }` (§4.12). It surfaces as `HarnessStartError` (code `harness_start`). There is no resume and no fallback, because no work worth keeping can have happened. The usual cause is a broken image or a bad config, and the durable layer does not retry it.

#### 2.6.3 Ending the turn after a valid submission

Harnesses differ in whether they stop on their own. The details belong in the adapter (§4.5), but the contract is the same for all of them: once a valid `result.json` exists, the runtime brings the process to a stop that keeps the session. It never sends SIGTERM first.

| Harness | How the tool is injected | How the turn ends after a valid submit |
|---|---|---|
| Claude Code | `--mcp-config` + `--strict-mcp-config`. The tool is set to always load where the CLI supports it (§11, Q31). | A `PostToolUse` hook matched on the tool returns `{"continue": false}`. The process exits by itself. |
| Codex | `-c mcp_servers.selfbuilding...` plus `default_tools_approval_mode="approve"` (otherwise the call is refused under `approval_policy="never"`) | The model keeps going after the call. The runtime waits `timeouts.postSubmitGrace` (default 10 s) after the accepted submit, sends SIGINT, then SIGKILL after 5 s more. |
| OpenCode | `mcp` entry in an inline config | Runtime SIGINT after the grace window (v1 uses `opencode run`, §4.4). |
| Amp, Droid | `--mcp-config` / `mcp.json` | Runtime SIGINT, as for Codex. |
| Pi | Extension tool (`-e`) | Runtime SIGINT once the extension has written the result (§4.5). |
| Grok | MCP config | Runtime SIGINT. |

The session id is kept so that a done-check retry (§2.7) can resume the same conversation.

#### 2.6.4 Host integrity check and validation

When the harness exits, the host reads `$A/result.json` and nothing else. It never reads the event stream, any other path, or a file the agent named. Some harnesses report tool calls only after the fact, and the stream may be truncated.

1. **Integrity.** One `exec` of `stat` (§5.2) must show:
   - a regular file, not a symlink;
   - owned by the supervisor uid recorded in the `ready` event (§6.5);
   - no write bit for group or other;
   - an owner that is not the agent uid.

   Any mismatch fails the call with `ResultIntegrityError`. That error is not retryable, and the sandbox is kept for inspection.
2. **Same-user providers.** When `ready` reports `isolation: "same-user"` (§6.3), the agent could write the file itself, so the check above proves nothing. The host still schema-validates the result. It sets `integrity: "same-user"` on the `AgentResult` and emits a warning once per run. A call with `requireIsolation: true` fails at `ready`, before the turn starts, with `ResultIntegrityError`.
3. **Parse.** The host parses the file with the full Zod schema, including refinements and transforms.
   - **Valid:** the result goes on to the done checks.
   - **Invalid:** this can happen only through a refinement or a transform, because the supervisor has already applied the JSON Schema. The session resumes with the Zod issues as a new user message. This counts against `maxResumes`.
   - **File missing:** see §2.6.5.

The host never trusts the supervisor's verdict on its own. It re-validates every time.

#### 2.6.5 No submission

The harness exited and `$A/result.json` does not exist. That covers exit 0, a model that "finished" in prose, and a crash after the work was done.

1. If the session id is known and `maxResumes > 0` (default 1), the runtime resumes the session once with: "You ended without calling submit_result. Call it now with the result of the work you did. Do not start over."
2. If there is still no result, the call fails with `NoResultError`, carrying the recovery data from §9.8.

A turn that was interrupted (a timeout, a lost sandbox, a crash of the orchestrator) is never replayed silently. §3.10 and §7.6 decide whether to resume it or fail it. The resume here exists only to ask for the missing result. It never re-runs the task.

#### 2.6.6 Retry budget summary

| Loop | Where | What triggers it | Default | Counts against |
|---|---|---|---|---|
| Submit retry | in the turn, model-driven | `submit_result` arguments fail the JSON Schema | 3 calls | `maxSubmitAttempts` |
| Resume | new turn, same session | no result file, or the host Zod parse fails | 1 | `maxResumes` |
| Done retry | new turn, same session | a done check fails | 2 | `maxDoneRetries` |

All three share the run's budget and wall-clock limit (§9.6). If the budget runs out, the call fails with `BudgetExceededError`, whichever loop it was in.

### 2.7 Definition of done

A valid result is not the same as finished work. Done checks run after host validation, and only when the result claims success.

#### 2.7.1 Types

```ts
type DoneCheck<I, O> =
  | { id: string; cmd: string | ((input: I) => string | undefined);   // runs in the sandbox; resolved on the host
      cwd?: string; timeout?: Duration; expectExit?: number }
  | { id: string; assert: (r: O, ctx: DoneContext) => true | string | Promise<true | string> } // runs on the host
  | { id: string; judge: { rubric: string; harness?: Harness } };   // optional LLM judge, charged to the budget

interface DoneContext {
  sandbox: SandboxHandle;   // exec/readFile only (§3.11)
  git: { base: string; head: string; commitsAhead: number; dirty: boolean;
         changedPaths: string[]; remoteHasBranch(): Promise<boolean> };
  artifacts: Partial<Artifacts>;   // §2.8
}
```

A `cmd` given as a function is resolved on the host from the **caller's** input, before the turn starts. It is never resolved from anything the agent produced.

#### 2.7.2 Semantics

- **Gating on status.** Checks run only when the result has no `status` field or has `status === "done"`. A result with `status: "blocked" | "failed"` is the agent honestly reporting that it could not finish. It is returned to the caller as is, with no done retries, because retrying would not change the facts.
- **Order.** Checks run in declaration order and stop at the first failure.
- **When checks run.** The turn has ended and the harness process tree has been killed (§6.3), so nothing the agent started is still running.
- **What a failure feeds back.** A failed check resumes the session with this message:
  1. "Done check `<id>` failed: `<cmd>` exited `<code>`."
  2. The last 4 KiB of the check's output, redacted (§9.4).
  3. A note naming any protected path that was restored for the check (§2.7.4).
  4. "Fix the problem and call submit_result again."

  The agent must submit again, and the new submission replaces the old one.
- **After `maxDoneRetries`.** With `onDoneFailure: "throw"` (the default), the call fails with `DoneCheckFailedError`, which carries the last valid result and the check log. With `"return"`, the call resolves normally and `doneFailed: { id, output }` is set on the `AgentResult`.
- **Early submits.** An agent that submits before doing the work is caught here. Schema validation does not catch it.

#### 2.7.3 Built-in checks, added automatically

| Condition | Check |
|---|---|
| `artifacts.branch: "required"` | At least one commit ahead of base. After the host push (§2.8.2), `git ls-remote` confirms the pushed branch exists. This catches "said it pushed, didn't". |
| `artifacts.branch: "forbidden"` (read-only skills) | No new commits and a clean working tree. A violation is a hard `DoneCheckFailedError` with no retry, and the sandbox is kept for inspection. |
| `artifacts.pr: "required"` | The PR was opened (§2.8.2). |
| The contract resolves a `testCommand` | Check `tests` runs exactly that command. It must exit 0. |
| The result has `tests: { command, passed }` and a `testCommand` resolved | `tests.command` is compared with `testCommand` after whitespace normalisation. If they match, the agent's `passed` must agree with the exit of the `tests` check. If they differ, the agent's command is **never run**. Its claim is recorded as unverified, and only `testCommand` counts. |
| The result has `tests` and no `testCommand` resolved | Nothing runs. The claim is recorded in `checks` as `{ id: "tests", verified: false }`, and the preamble told the agent so. |

#### 2.7.4 Checks run only declared commands, against protected files

The agent controls the working tree, so the checks have to limit what it can change about them.

1. **Only declared commands run.** A `cmd` check runs a command from one of three places: the contract, a caller's `with()` patch, or a function of the caller's input. A command the agent reported is never run. That includes `tests.command`, a path in the result, and a script named in its summary.
2. **Protected paths are restored from the base commit for the duration of the checks.**
   - Before the first `cmd` check, the runtime copies the head version of every protected path that the diff touched into `$A/protected/`. It then writes the `baseSha` version of each one in place.
   - After the last check, it puts the head versions back. The agent's commits are not changed.
   - The default set (`DEFAULT_PROTECTED` in `@selfbuilding/core`):

   | Path | What is restored |
   |---|---|
   | `package.json` (each workspace package) | The keys `scripts`, `jest`, `vitest`, `mocha` and `ava` only. Every other key comes from head, so dependency changes still count. |
   | Test runner config: `vitest.config.*`, `vitest.workspace.*`, `jest.config.*`, `playwright.config.*`, `karma.conf.*`, `.mocharc*`, `pytest.ini`, `tox.ini`, root `conftest.py` | The whole file |
   | `pyproject.toml`, `setup.cfg` | The `[tool.pytest*]` / `[tool:pytest]` tables only |
   | `.selfbuilding/**`, `.github/workflows/**` | The whole file |

3. **Changing these paths.** `protect.extra` adds paths. `protect.allow` lets a contract change a protected path on purpose. Allowed paths are not restored, and they are listed in `checks[].protectedChanged` so a reviewer can see them.
4. **What this does not stop.** An agent can still delete a test or mark it skipped. Contracts that write code can set the `no-test-removal` check, which the default `ImplementSpec` uses (§2.10.1). It fails when the diff deletes a test file or adds `.only`, `.skip`, `xit` or `@pytest.mark.skip`.

   Done checks guard against honest mistakes and unverified claims. They are not an adversarial boundary, and a sandbox can always subvert a test it is allowed to edit. The adversarial boundary is review: `CodeReview` in a fresh sandbox, or a human.

### 2.8 Artifacts

#### 2.8.1 `AgentResult` and its fields

This is the one declaration of `AgentResult<O>`, `Artifacts`, `Usage` and `ArtifactRef` (§1.9 summarises it). The table lists every field and where each value comes from.

| Field | Value | Filled by |
|---|---|---|
| `result` | the Zod-parsed result | §2.6.4 |
| `runId`, `callPath`, `stepKey` | the call's identity | §3.2 |
| `replayed` | `true` when the value came from the journal | §3.9 |
| `artifacts.branch` | `{ name, base, baseSha, headSha, pushed, autoCommitted }` | §2.8.2 step 2 |
| `artifacts.commits` | `{ sha, message }[]` ahead of base | §2.8.2 step 2 |
| `artifacts.pr` | `{ url, number, draft }` | §2.8.2 step 4 |
| `artifacts.diff` | `{ stat: { files, insertions, deletions }, ref }`; the full patch is stored, not inlined | §2.8.2 step 3 |
| `artifacts.transcript` | `ArtifactRef` to `{ events, native? }`: normalised JSONL (§4.3) plus the harness session file | §2.8.2 step 5 |
| `artifacts.files` | `{ path, ref }[]` | §2.8.2 step 6 |
| `artifacts.logs` | runtime log, including setup and hook output | §6.12 |
| `artifacts.checkpoint?` | `Checkpoint`, the state of a shared sandbox after the call | §3.11 |
| `usage` | `{ usd, inputTokens, outputTokens, turns, wallClockMs, sandboxMs }` | §4.3 usage events, §9.6 |
| `attempts` | `{ submits, resumes, doneRetries }` | §2.6.6 |
| `checks` | `{ id, ok, verified, protectedChanged? }[]` | §2.7 |
| `doneFailed?` | `{ id, output }` when `onDoneFailure: "return"` | §2.7.2 |
| `integrity` | `"isolated" \| "same-user"` | §2.6.4 |
| `harness` | `{ id, version, model, sessionId }` | §4.7 |
| `skill` | `{ name, hash }` | §2.2.4 |

```ts
interface ArtifactRef {
  uri: string;                 // file://, s3:// or artifact:// in the configured ArtifactStore
  bytes: number;
  sha256: string;
  contentType: string;
  text(): Promise<string>;     // reads the payload back through the run's ArtifactStore
}
```

The `AgentResult` is plain JSON (an `ArtifactRef` serialises without its method and is rehydrated on read). It crosses host step boundaries (§7) without carrying large payloads. Diffs, transcripts and files go to the artifact store, which is configured next to the journal store (file or S3-compatible by default, §7.10).

#### 2.8.2 Collection

Artifacts are collected after the final accepted submission, in this order. Steps 1, 3 and 6 run in the sandbox runtime; steps 2 and 4 run on the host in its collect and accept steps (§7.4), because only the host holds write credentials (§9.2).

1. **Commit leftovers.** If the working tree has tracked or untracked changes that are not ignored, the runtime commits them as `selfbuilding: uncommitted changes from <skill>` and sets `autoCommitted: true`. The built-in exclude list (§9.3) applies, so `.env` files and keys are never committed. Work is never thrown away because the agent forgot to commit. This step is skipped for `branch: "forbidden"`, where a dirty tree fails the call (§2.7.3).
2. **Branch and push.**
   - The branch is `opts.git.branch`, or else `branchName(runId, callPath)` (§6.13). The default name is deterministic, so a replayed call targets the same branch.
   - The host pushes in its collect step, after confirming that the harness process tree has exited. It uses a short-lived write token scoped to that repository, minted by the git credential broker and deleted in the same exec (§9.2). The agent's processes never hold a credential that allows pushing.
3. **Diff.** `git diff --binary <baseSha>...<headSha>` goes to the store. The stat stays inline.
4. **PR.** This step runs if `opts.pr` is set or the contract requires a PR.
   - The **host** opens the PR through the GitHub integration, using the credentials the host holds (§8, §9). The agent never opens PRs.
   - The title and body come from `PrOptions` if given, else from the result's `prTitle` / `prBody` fields if the schema has them, otherwise from `summary`.
   - Selfbuilding appends a footer to the body with the run id and the transcript link.
   - If an open PR already exists for the same head branch, it is updated rather than duplicated.
5. **Transcript.** The normalised events and the native session file are redacted before they are written (§9.4). Redaction happens before any truncation.
6. **Files.** The runtime uploads every path the result names in a `files` field, plus anything under `/selfbuilding/out/files/`. A path outside the workdir or `/selfbuilding/out` is rejected with `ArtifactPathError`, because a path the sandbox reports is untrusted input.

If collection fails after a valid result (for example, the push is rejected), the call fails with `ArtifactError`. The result is attached to the error, and the sandbox is preserved according to the placement policy (§3.11). The caller can then retry collection without re-running the agent.

### 2.9 Failure contract and errors

The failure rules are stated once, in §1.9 and §3.1. In short:

- **`Agent(input, opts)` and `agent(spec)` resolve `AgentResult<O>` or throw** a `SelfbuildingError` subclass. The same applies inside a factory.
- **`.settled()`, `parallel()` and `pipeline()` give the value form.** `X.settled(input, opts)` returns `{ ok: false, code, error }`, so the reason is never lost. `parallel()` and `pipeline()` turn the error into `null` and put it on the event stream.
- **Usage errors throw from every form**, including `.settled()`, `parallel()` and `pipeline()`. The ones raised by this section are `SkillLoadError`, `DuplicateSkillError`, `ContractError` and `AgentInputError`. They extend `SelfbuildingUsageError` (§3.1) and are raised before any sandbox exists.

Every error carries the `recovery` fields from §9.8. This section fills two of them: `skill: { name, hash }` on every error, and `lastValidResult` on `DoneCheckFailedError` and `ArtifactError`.

The classes this section raises (the full registry is §9.8):

| Class | Kind | `code` | Raised when | Retryable by the outer layer |
|---|---|---|---|---|
| `SkillLoadError` | usage | `skill_load` | the folder is invalid (§2.2.2) | no |
| `DuplicateSkillError` | usage | `duplicate_skill` | the same name appears twice in one tier | no |
| `ContractError` | usage | `contract` | the schema is not representable, the input uses a reserved key, or an override is incompatible (§2.10.4) | no |
| `AgentInputError` | usage | `input_invalid` | the input fails its schema, or the workspace options fail §2.4.3 | no |
| `SkillContextError` | agent | `skill_context_failed` | a `` !`cmd` `` expansion failed or timed out | yes, once |
| `ResultValidationError` | agent | `result_invalid` | submit attempts are exhausted | no; the result is a model-quality miss |
| `NoResultError` | agent | `no_result` | no result after the resume nudge | no |
| `ResultIntegrityError` | agent | `result_integrity` | the result file failed the owner/mode check, or `requireIsolation` was not met (§2.6.4) | no |
| `DoneCheckFailedError` | agent | `done_check_failed` | done retries are exhausted (carries `lastValidResult`) | no |
| `ArtifactError` / `ArtifactPathError` | agent | `artifact_failed` | collection failed after a valid result | yes, collection only |
| `BudgetExceededError` | agent | `budget` | the shared budget or the call's slice ran out (§9.6) | no |

Failures of the harness, the sandbox or the host (authentication, rate limits, a selfbuilding MCP server that never connected, lost sandboxes, timeouts) are classified in §4, §5 and §7. They surface with the codes listed in §9.8. They are not result-contract errors.

### 2.10 The built-in default pack and overrides

#### 2.10.1 The pack

`@selfbuilding/agents` (§1.7) exports `defaultPack` and four typed agents. Each one is an ordinary skill folder with a sidecar. Users can read them, and they are replaced through the same mechanism as any other skill.

None of the four input schemas contains `repo`, `branch`, `base`, `git` or `pr`. Those are call options (§2.4.3). `CodeReview` names what to review with the `ReviewTarget` field `target`.

```ts
// code-review: read-only
export const CodeReviewFinding = z.object({
  title: z.string().max(200),
  severity: z.enum(["critical", "high", "medium", "low", "nit"]),
  file: z.string(), line: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(),
  body: z.string(), suggestion: z.string().optional(),
  confidence: z.number().min(0).max(1),
});
export const CodeReviewInput = z.object({
  target: ReviewTarget.optional(),                // { kind: "pr", url } | { kind: "diff", base, head? }; optional only on a shared handle
  focus: z.array(z.string()).optional(),          // e.g. ["security", "concurrency"]
  maxFindings: z.number().int().min(1).max(50).default(20),
  testsPassed: z.boolean().optional(),            // test status the caller observed, shown to the reviewer
  notes: z.string().max(4000).optional(),
});
export const CodeReviewResult = z.object({
  verdict: z.enum(["approve", "request_changes", "comment"]),   // GitHub's review events, lower-cased
  summary: z.string().max(4000),
  findings: z.array(CodeReviewFinding),
});
// contract: workspace.target = "review"; artifacts.branch = "forbidden";
//           done: every finding.file appears in /selfbuilding/in/diff.patch

// implement-spec: writes code
export const ImplementSpecInput = z.object({
  spec: z.union([z.string().min(1), z.object({ path: z.string() })]),
  feedback: z.array(CodeReviewFinding).optional(),   // findings to address, e.g. from CodeReview
  testCommand: z.string().optional(),
});
export const ImplementSpecResult = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string().max(4000),
  changes: z.array(z.object({ file: z.string(), why: z.string() })),
  tests: z.object({ command: z.string(), passed: z.boolean() }).optional(),
  followUps: z.array(z.string()),
  prTitle: z.string().max(120), prBody: z.string(),
});
// contract: artifacts.branch = "required"; testCommand = (i) => i.testCommand;
//           done: built-in "tests" (if testCommand) + "no-test-removal"

// retro: read-only, reads transcripts
export const RetroInput = z.object({
  runId: z.string().optional(),                   // default: the current run. Required outside a factory.
  transcripts: z.array(z.string()).optional(),    // or paths materialised into /selfbuilding/in/
  notes: z.string().optional(),
});
export const RetroResult = z.object({
  wentWell: z.array(z.string()), wentBadly: z.array(z.string()),
  actions: z.array(z.object({
    title: z.string(), kind: z.enum(["skill-edit", "code", "process"]),
    owner: z.enum(["human", "agent"]), detail: z.string(),
    skill: z.string().optional(),                 // for skill-edit
  })),
});
// contract: workspace.repo = "optional"; artifacts.branch = "forbidden";
//           AgentInputError outside a run when neither runId nor transcripts is given

// improve-codebase-architecture: proposes, optionally implements
export const ImproveArchInput = z.object({
  scope: z.array(z.string()).optional(),          // paths or globs, e.g. ["src/billing"]
  goals: z.array(z.string()).optional(),
  mode: z.enum(["propose", "implement"]).default("propose"),
  maxChanges: z.number().int().min(1).max(10).default(3),
  testCommand: z.string().optional(),
});
export const ImproveArchResult = z.object({
  summary: z.string(),
  proposals: z.array(z.object({
    title: z.string(), problem: z.string(), change: z.string(), files: z.array(z.string()),
    risk: z.enum(["low", "medium", "high"]), effort: z.enum(["s", "m", "l"]),
    implemented: z.boolean(),
  })),
  spec: z.string().describe("A spec for the selected proposals that ImplementSpec can act on directly"),
  prTitle: z.string().max(120).optional(), prBody: z.string().optional(),
});
// contract: artifacts.branch = (i) => i.mode === "implement" ? "required" : "forbidden";
//           testCommand = (i) => i.testCommand
```

`CodeReviewResult.verdict` maps one-to-one onto GitHub's `APPROVE`, `REQUEST_CHANGES` and `COMMENT`. The GitHub channel (§8) and `postReview()` (§10.5) can therefore post a review straight from the result with no mapping table.

The default pack is curated. It grows only when a skill passes the live smoke matrix on all three first-class harnesses (§10.3). Declined requests are recorded in `docs/out-of-scope/`, so the same request does not keep coming back.

#### 2.10.2 Canonical calls, checked in CI

These are the call shapes for the default pack. The examples in §1.1, §1.8 and §3.13 use them as written. In this block, `repo`, `box` and `config` are free variables, supplied by the docs prelude (§1.14).

```ts
import { CodeReview, ImplementSpec, ImproveCodebaseArchitecture, Retro } from "@selfbuilding/agents";

// Review an open PR
const review = await CodeReview({
  target: { kind: "pr", url: "https://github.com/acme/api/pull/412" },
  focus: ["security", "error handling"],
});
if (review.result.verdict === "request_changes") { /* ... */ }

// Implement a spec on a new branch and open a draft PR
const impl = await ImplementSpec(
  { spec: "Add rate limiting to POST /login", testCommand: "pnpm test" },
  { repo, pr: { draft: true } },
);
impl.artifacts.pr?.url;

// Review that branch, then address the findings on the same branch in a fresh sandbox
const r2 = await CodeReview(
  { target: { kind: "diff", base: "main", head: impl.artifacts.branch!.name }, testsPassed: true },
  { repo },
);
const fixed = await ImplementSpec(
  { spec: "Address the review findings.", feedback: r2.result.findings, testCommand: "pnpm test" },
  { repo, git: { branch: impl.artifacts.branch!.name }, pr: true },   // updates the open PR
);

// Propose, then implement in one shared working tree (box: a shared handle, §3.11)
const plan = await ImproveCodebaseArchitecture({ scope: ["src/billing"] }, { sandbox: box });
const refactor = await ImplementSpec({ spec: plan.result.spec }, { sandbox: box });

// Retro over the current run (inside a factory)
const retro = await Retro({ notes: "Two PRs needed a second review round." });
```

**The docs check.** The typecheck half is check 1 in §1.14 (`pnpm docs:check`). This section adds a runtime half: an L0 test (`agents/examples.test.ts`) parses every default-pack input used in the docs with its Zod input schema. This catches constraints a typecheck cannot see, such as `.min()`, `.max()` and refinements. Together they keep the examples from drifting from the schemas.

#### 2.10.3 Precedence

When two tiers provide the same skill name, the highest tier wins:

1. An `Agent` value passed directly in code (`Agent.fromSkill(...)` or `X.with(...)`).
2. Project sources listed in `skills.sources`, in list order. An earlier entry wins over a later one.
3. Packs listed in `skills.packs`.
4. `defaultPack`, unless `skills.disable` names the skill or `skills.defaults: false` is set.

Every shadowing is logged once per run, for example: `skill code-review: project .agents/skills overrides @selfbuilding/agents`. Nothing is shadowed silently.

#### 2.10.4 Three ways to override

- **Replace the prompt, keep the contract.** Put a `code-review/SKILL.md` with no sidecar in a project source. It inherits the default's contract (`contract: "inherited"`), so `CodeReview` keeps its types.
- **Replace both.** Add a sidecar. Codegen exports the agent under the same name only when both of these hold:
  - its input type extends the default's input, and its workspace requirements are no stricter;
  - its output type is assignable to the default's output.

  Otherwise codegen fails with `ContractError` and asks for a new name. Code written against `CodeReview` can never receive a result of the wrong shape.
- **Patch in code.**

  ```ts
  import { CodeReview } from "@selfbuilding/agents";
  import { codex } from "@selfbuilding/harnesses/codex";
  import { z } from "zod";

  const StrictReview = CodeReview.with({
    appendBody: "Treat any change to auth/ as at least high severity.",
    output: (base) => base.extend({ securityNotes: z.array(z.string()) }),  // must extend; replacing is a type error
    done: (base) => [...base, { id: "lint", cmd: "pnpm lint" }],
    protect: { extra: ["biome.json"] },
    defaults: { harness: codex({ model: "gpt-5.5" }) },
  });
  ```

  `with()` returns a new `Agent` with a new hash. The original is unchanged.

### 2.11 Decisions made in this section

| Topic | Decision |
|---|---|
| Contract location | TypeScript sidecar `selfbuilding.ts`. Frontmatter stays spec-valid. |
| Skill without a contract | Inferred default contract. Never run-time model inference. |
| `repo`, `git`, `pr`, `sandbox` | Always `AgentCallOptions`, never skill input. They (and `base`, `branch`, `harness`, `model`) are reserved input keys. Review targets are task data in the `target` input field. |
| Result transport | `submit_result` through `selfbuilding-mcp` to the supervisor, on every harness. No native structured-output flags and no write-it-yourself fallback in v1. |
| Tool not connected | Fail fast as `harness_crash` (surfacing as `HarnessStartError`) on every harness, detected by the `hello` handshake, or sooner where the harness reports MCP status. |
| Who validates | The supervisor validates with JSON Schema for in-run retries. The host checks the file's owner and mode, then runs its own Zod parse, which is authoritative. |
| Same-user sandboxes | Allowed, flagged `integrity: "same-user"`. `requireIsolation: true` refuses them. |
| Done-check commands | Only commands declared by the contract, a caller's patch or the caller's input. Agent-reported commands are never run. |
| Done-check tampering | Protected paths (package scripts, test config, CI, `.selfbuilding/`) are restored from base while checks run, unless the contract allows the change. |
| Failure surface | Agent calls throw a `SelfbuildingError`. `.settled()`, `parallel()` and `pipeline()` give the value form. Usage errors throw everywhere. |
| Result and artifact types | Declared once in §2.8.1 and summarised in §1.9. Errors are declared once in §9.8. |
| Who pushes and opens PRs | The host pushes in its collect step after the agent's processes have exited, and opens the PR. The agent holds no push or PR credentials. |
| Uncommitted work | Auto-committed and flagged (minus the built-in exclude list), except for read-only skills, where it is an error. |
| Agent-reported `blocked`/`failed` | Returned as a valid result. No done retries. |
| Done-check exhaustion | Throws `DoneCheckFailedError` with the last valid result by default. |
| Large payloads | Stored in the artifact store and referenced. Results are capped at 256 KiB. |
| Replay invalidation | The skill hash and contract fingerprint are part of the step key. |
| Example drift | `pnpm docs:check` typechecks every doc code block and parses every default-pack example input. |

### 2.12 Open questions

Moved to §11 (Q11 to Q18).

## 3. Orchestration: agent(), pipeline(), parallel(), journal and sandbox placement

This section defines the factory primitives. They are plain TypeScript functions. A factory is an ordinary async function that calls them. There is no DSL and no graph builder. Other sections cover the rest:

- Section 1 lists the public API surface.
- Section 2 defines how a SKILL.md becomes an `Agent`, the result contract and `AgentCallOptions`.
- Section 4 covers how harnesses run and stop.
- Section 5 covers what providers can do.
- Section 7 covers how the journal maps onto durable hosts.

This section covers how the pieces compose, how a run resumes, and where agents run.

### 3.1 Design rules

1. **Factories are code.** Loops, `if`, `try`, helper functions and closures all work. The only constraint is determinism (§3.8).
2. **One failure rule.** This is the only statement of the rule, and it matches §1.9. Sections 2, 6, 7 and 9 refer to it.

   | Call form | On an agent-level failure (including budget exhaustion, interruption and abort) |
   |---|---|
   | `CodeReview(input, opts)` (a compiled Agent) or `agent(spec)` (an inline prompt) | throws a typed `SelfbuildingError` subclass |
   | `CodeReview.settled(input, opts)` or `agent.settled(spec)` | resolves `Settled`, which carries the `code` and the error |
   | Inside `parallel()` / `pipeline()` | a thrown agent-level error becomes `null` for that child or item; the error goes on the event stream |

   Budget exhaustion is not special: it throws `BudgetExceededError` like any other agent-level failure. **Usage errors** are bugs in the factory, and they always throw, through every primitive including `.settled()`, `parallel()` and `pipeline()`. They all extend `SelfbuildingUsageError`: `ConfigError`, `NestingDepthError`, `NonDeterminismError`, `DuplicateLabelError`, `SandboxHandleScopeError`, `SandboxBusyError`, `NotOwnerError`, `SandboxCapDeadlockError`, `RunIdConflictError`, `NoActiveRunError`, plus the loading and input errors from §2.9 (§9.8 lists them all).
3. **Sandboxes are explicit.** Each agent gets a fresh sandbox by default. You get sharing only by passing a handle.
4. **One durability system.** On a durable host, the host's step memo (plus the result store, §7.10) is the journal. Locally, it is a file or SQLite store. It is never both.
5. **Interrupted work is never re-run silently.** §3.10 defines the single rule for what happens after a crash.

### 3.2 Identifiers: `callPath` and `stepKey`

Every primitive call has exactly two identifiers. Both terms are in the glossary (§1.6). No other name is used for either, in any section, type, event or error. `stepId`, `key`, `callId` (as a primary identifier) and `agentPath` are retired; §6 uses `callId = <runId>.<callPath>` only as a display string. `EventEnvelope`, `SelfbuildingError`, `recovery` and `JournalEntry` all carry `callPath` and, where relevant, `stepKey`.

| Name | What it is | Used for |
|---|---|---|
| `callPath` | The readable structural position of the call in the factory. The same on every replay | Logs, events, errors, progress UIs, `refresh`, `onInterrupted` overrides, branch names |
| `stepKey` | A 26-character hash of the call's identity and history | Journal keys, host step ids (via `HostKey`, §7.2), idempotency keys, sandbox labels, attempt directories (§6.4) |

**`callPath` format.** Segments are joined with `/`, and the root scope has no segment.

```
segment = Name "#" n      unlabelled agent, scope or sandbox op; n counts per (scope, Name) from 0
        | label           agent label, step() name or handle label: ^[a-z0-9][a-z0-9-]{0,47}$
        | "[" key "]"     a parallel() child (index or record key) or a pipeline() item (index or opts.key)
        | "stage#" s      a pipeline() stage
Name    = Agent name (PascalCase) | inline agent name | "parallel" | "pipeline" | "exec" | "fork" | factory name
```

Examples: `ImplementSpec#0`, `pipeline#0/[issue-412]/stage#1/ImplementSpec#0`, `parallel#0/[2]/review`, `review-panel#0/CodeReview#1`. Counters count per name, so adding a `CodeReview` call does not shift the paths of `ImplementSpec` calls. A label or step name must be unique in its scope; a duplicate throws `DuplicateLabelError`. A `callPath` is at most 512 characters.

**`stepKey` format.**

```ts
stepKey = base32lower(sha256(canonicalJson({
  v: 1,
  callPath,
  chain,       // the scope's chain head before this call (below)
  target,      // skill hash (§2.2.4) | sha256(prompt) | step name
  input,       // canonical JSON of the input
  schema,      // hash of the result JSON Schema
  exec,        // { harness id + version policy, model, effort }. Not label, phase or timeout
  sandbox,     // "fresh" + provider spec hash | { boxId, prevCheckpointStepKey }
  refresh,     // the resume id when this callPath matches `refresh`, else null (§3.9)
}))).slice(0, 26)
```

**Chain head.** Every scope has a chain head. It starts as the parent scope's chain head at the moment the child scope opens, and it is `""` at the root. After each call, the head becomes `sha256(stepKey + ":" + launchId)`, where `launchId` (§7.2) belongs to the execution whose value the call returned. A replayed call returns its stored value, so its stored `launchId` keeps the head the same as last time. A call that runs live gets a new `launchId`, so every later key in that scope and its child scopes changes. This makes the prefix rule (§3.9) hold on any store that is keyed by `stepKey`, including host memos.

Hosts derive their own ids from `stepKey` through `HostKey` and `LaunchId` (§7.2): Trigger idempotency keys, Inngest step ids and Cloudflare step names and event types.

**`runId`.** It must match `^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$`. When `run()` does not get one, it generates `ns_<ulid>`. The first journal write binds the `runId` to `sha256(factoryName + canonicalJson(input))`. A later `run()` with the same `runId` and a different factory or input throws `RunIdConflictError`. A `runId` therefore never reuses another run's branch names. Editing the factory's code under the same `runId` and input is allowed, because that is how you resume after an edit.

### 3.3 Defining and running a factory

```ts
import { factory, run } from "@selfbuilding/core";
import { sqliteJournal } from "@selfbuilding/journal-sqlite";
import { impello } from "@selfbuilding/sandbox-impello";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { z } from "zod";

export const ShipIssue = factory(
  {
    name: "ship-issue",
    input: z.object({ repo: z.string(), issue: z.number() }),
    output: z.object({ prUrl: z.string().nullable() }),
    defaults: {
      harness: claudeCode({ model: "claude-opus-4-8" }),
      sandbox: impello({ template: "selfbuilding-claude-code" }),
      effort: "high",
    },
  },
  async (input) => {
    // body uses Agent calls, agent(), pipeline(), parallel(), step(), phase(), log()
    return { prUrl: null };
  },
);

const out = await run(ShipIssue, { repo: "acme/api", issue: 412 }, {
  runId: "ship-412",                      // stable id = resumable
  journal: sqliteJournal(".selfbuilding/journal.db"),
  budget: { usd: 25, tokens: 20_000_000, wallClock: "4h", perAgent: { usd: 5 } },
  concurrency: { sandboxes: 6 },
  signal: AbortSignal.timeout(5 * 3600_000),
});
// out: RunOutcome (§1.9): { runId, status, output: T | null, usage, replayedUsd, events }
```

```ts
type Duration = `${number}${"s" | "m" | "h" | "d"}` | number;   // a number is milliseconds

type InterruptedPolicy = "fail" | "resume-session" | "restore-and-rerun" | "skip";

interface RunOptions {
  runId?: string;
  config?: SelfbuildingConfig;
  journal?: JournalStore;                  // ignored on durable hosts (§3.9)
  artifacts?: ArtifactStore;
  budget?: Budget;                         // §9.6
  concurrency?: { sandboxes?: number; createsPerMinute?: number };   // default: min(4, provider limits.maxConcurrent)
  hitl?: HitlOptions; notify?: NotifyOptions; events?: EventSink[]; strict?: boolean;
  refresh?: string[];                      // callPaths to force live (§3.9)
  onInterrupted?: "fail" | "resume-session"
    | Record<string /* callPath */, InterruptedPolicy>;   // default "fail"; per-callPath overrides (§3.10, §6.8)
  signal?: AbortSignal;
}
```

`Budget` is defined once, in §9.6. Every user-facing time option in Selfbuilding is a `Duration`. The provider's create rate is part of the provider adapter (`limits.createsPerMinute`, §5.2), and `concurrency.createsPerMinute` may lower it.

The primitives are module imports. They find the current run through `AsyncLocalStorage`. On Cloudflare Workers that needs `nodejs_compat`. A primitive called outside a running factory throws `NoActiveRunError`, and the message names the primitive.

### 3.4 Agent calls and `agent()`

There are two ways to run an agent, and both produce one journaled step:

- **A compiled Agent** (§2.5): `CodeReview(input, opts)`. It brings its own body, input schema, result schema and done checks.
- **An inline prompt**: `agent({ name, prompt, input?, output, ...opts })`. The prompt is a literal string, with no template expansion. `name` becomes the `Name` segment of its `callPath`.

```ts
function agent<O>(spec: { name: string; prompt: string; input?: unknown; output: z.ZodType<O> }
                  & AgentCallOptions): Promise<AgentResult<O>>;
agent.settled = <O>(spec) => Promise<Settled<AgentResult<O>>>;
```

Both take `AgentCallOptions` (§2.5.1). The placement-related keys behave as follows:

- `harness`, `effort`: default from the factory's `defaults`, then `run()` options, then config (§1.11).
- `sandbox`: `"fresh"` with the factory's provider by default; a `SandboxProvider` value for a fresh box on another provider; a `SandboxHandle` to share a working tree (§3.11).
- `label`: replaces `Name#n` in the `callPath`.
- `phase`: overrides the scope's current phase for this call.
- `budget`: per call; defaults to `budget.perAgent`; `wallClock` defaults to the call `timeout`, `"2h"`.
- `retries`: live re-runs after a turn that did work; default 0.
- `checkpoint`: only meaningful on a shared handle.
- `onInterrupted`: default `"fail"` (§3.10).

**Result.** `AgentResult<O>` is declared in §2.8.1. This section fills four of its fields: `callPath` and `stepKey` (§3.2); `replayed`, which is true when the value came from the journal; and `artifacts.checkpoint`, the state of a shared sandbox after the call (§3.11).

**Error codes.** The `code` on `Settled` and on the thrown error is an `ErrorCode` (§9.8). The ones an agent call commonly produces:

| `code` | Error class |
|---|---|
| `no_result` | `NoResultError` |
| `result_invalid` | `ResultValidationError` |
| `done_check_failed` | `DoneCheckFailedError` |
| `harness_start`, `harness_error`, `harness_protocol`, `harness_version_unavailable` | `HarnessStartError`, `HarnessStreamError`, `HarnessProtocolError`, `HarnessVersionUnavailableError` |
| `sandbox_unavailable`, `sandbox_not_found`, … | `SandboxUnavailableError` and the other sandbox classes (§5.3) |
| `timeout`, `idle_timeout`, `boot` | `CallTimeoutError`, `IdleTimeoutError`, `BootTimeoutError` / `HookTimeoutError` (§6.11) |
| `budget` | `BudgetExceededError` |
| `interrupted` | `AgentInterruptedError` |
| `aborted` | the call rejects with `signal.reason` |

**Structured hand-back.** The run injects a stdio MCP server into the sandbox that exposes `submit_result`. The tool's input schema is the result schema. An invalid call returns the issues as a tool error, and the model retries in the same turn, up to `maxSubmitAttempts` (default 3). A valid call writes the result file and ends the turn. Sections 2.6 and 4.5 cover how each harness stops. From the orchestrator's side there are three outcomes:

- A valid submission followed by passing done checks resolves to an `AgentResult`.
- If the harness exits without submitting, the session is resumed once with "call submit_result". If there is still no result, the call fails with `no_result`.
- If submissions stay invalid after the allowed attempts, the call fails with `result_invalid`. The transcript is attached to the error.

**Retries.** Infrastructure failures that happen *before the harness starts* are retried automatically: sandbox create, clone, setup and harness launch. There are up to 3 attempts with full-jitter backoff under one overall deadline. A turn that started and then failed is not re-run unless you set `retries`, because a re-run repeats side effects (§4.12 covers resume-with-nudge for model API errors). When `retries > 0` and the call is on a shared handle, the sandbox is restored to the pre-call checkpoint (§3.11) before the retry.

### 3.5 `pipeline()`

```ts
interface StageContext<T> { item: T; index: number; key: string }
type Stage<In, Out, T> = (prev: In, ctx: StageContext<T>) => Promise<Out | null>;

function pipeline<T, R1>(items: readonly T[], s1: Stage<T, R1, T>): Promise<(R1 | null)[]>;
function pipeline<T, R1>(opts: PipelineOptions<T>, items: readonly T[], s1: Stage<T, R1, T>): Promise<(R1 | null)[]>;
function pipeline<T, R1, R2>(items: readonly T[], s1: Stage<T, R1, T>, s2: Stage<R1, R2, T>): Promise<(R2 | null)[]>;
function pipeline<T, R1, R2>(opts: PipelineOptions<T>, items: readonly T[],
                             s1: Stage<T, R1, T>, s2: Stage<R1, R2, T>): Promise<(R2 | null)[]>;
// ... one overload per stage count up to 8, each with and without a leading opts object

interface PipelineOptions<T> {
  key?: (item: T) => string;   // the item's [key] segment; default: the index. Must be unique
  maxInFlight?: number;        // items active at once; default: limited only by concurrency.sandboxes
  label?: string;
}
```

- Each item moves through the stages on its own. There is **no barrier**: item 3 can be in stage 3 while item 9 is still in stage 1.
- The first stage receives the item as `prev`. Every stage also gets `{ item, index, key }`.
- `null` is removed from the type of `prev`. A stage that returns `null` stops its item, and later stages never see it. The next stage therefore never needs a `!`.
- If a stage **returns `null`**, the item's slot is `null` and later stages do not run for it.
- If a stage **throws** an agent-level error or any non-Selfbuilding error, the error is logged as an `item.dropped` event and the item becomes `null`. Other items are not affected. A `SelfbuildingUsageError` rejects the pipeline (§3.1).
- `pipeline()` resolves when every item has finished or dropped. Results are in input order.
- **Scheduling gives priority to depth.** When several calls wait for a sandbox slot, a later stage beats an earlier one, and ties go to the lower item index. Items therefore finish and free their slots instead of piling up in stage 1. The order is deterministic, which keeps event logs stable.
- Use `key` when the item list can change between runs, such as a GitHub issue list. With items keyed by `issue.number`, inserting a new issue does not shift the `callPath`s of the others.

### 3.6 `parallel()`

```ts
function parallel<T extends readonly (() => Promise<unknown>)[]>(thunks: T):
  Promise<{ [K in keyof T]: NonNullable<Awaited<ReturnType<T[K]>>> | null }>;
function parallel<T extends Record<string, () => Promise<unknown>>>(thunks: T):
  Promise<{ [K in keyof T]: NonNullable<Awaited<ReturnType<T[K]>>> | null }>;

function isPresent<T>(v: T | null | undefined): v is T;   // exported from @selfbuilding/core
```

- `parallel()` is an explicit barrier. It resolves once every thunk has settled.
- A thunk that throws an agent-level error, or resolves `null`, becomes `null`. A `SelfbuildingUsageError` rejects the call (§3.1).
- Each element is typed `T | null`, so `results.filter(isPresent)` narrows to `T[]` without `!`.
- Thunks start synchronously in index order (key order for the record form). Each gets its own child scope, `parallel#n/[i]`, so `callPath`s stay stable however the thunks interleave.
- To limit concurrency, use `concurrency.sandboxes`, not `parallel()`. The thunks only say what *may* run at the same time.

Do not use raw `Promise.all` over async closures that make more than one agent call each. Inside such a closure, the order of the second call depends on which first call finishes first, so its `callPath` is not stable. Strict mode detects this (§3.8) and points you to `parallel()`. A `Promise.all` over single agent calls is safe, because those calls are made synchronously, in order.

### 3.7 `step()`, `phase()`, `log()`, and nested factories

```ts
function step<T>(name: string, fn: () => Promise<T>): Promise<T>;   // journaled non-agent work; name is a label
function phase(name: string): void;                                 // sets the phase for the rest of the scope
function log(message: string, data?: Record<string, unknown>): void;
function log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
function now(): number; function random(): number; function uuid(): string;  // journaled, see §3.8
```

- **`step()`** runs and journals side-effecting or non-deterministic work that is not an agent: listing issues, calling an API, reading a file from the host. On replay it returns the stored value. Values must be JSON-serialisable and at most 256 KiB. Larger data goes to the artifact store, and the step returns an `ArtifactRef`. The step name is its `callPath` segment, so `refresh: ["list-issues"]` targets a root-level `step("list-issues", …)`.
- **`phase()` and `log()`** emit progress events: `{ type: "phase" | "log", callPath, name/message, data, ts, replayed }`. They are not journaled. A replayed run emits them again with `replayed: true`, so a progress UI can show the cached part dimmed. Section 9.7 owns the event schema, redaction and sinks.
- **Nested factories.** A factory can call another factory as a function: `await ReviewPanel({ branch })`. The child runs in a child scope (`review-panel#0`). It shares the parent's budget, sandbox cap, journal and abort signal, and its events carry the parent path. **Nesting is one level deep.** A nested factory that calls a factory throws `NestingDepthError` at the call site. Deeper trees belong in separate runs, which you start with `run()` from inside a `step()`.

### 3.8 Determinism rules

Replay re-executes the factory body from the top. Every primitive call must therefore get the same `callPath` as last time.

- **Forbidden in factory bodies:** `Date.now()`, `new Date()` with no argument, `Math.random()`, `crypto.randomUUID()`, environment reads that can change between runs, and direct I/O. Use `now()`, `random()` and `uuid()`, which are journaled per scope. Put I/O in `step()`.
- **Strict mode** is on by default in tests and under `SELFBUILDING_STRICT=1`. While factory code runs, it replaces those globals with versions that throw `NonDeterminismError`. Code inside `step()` and Selfbuilding's own internals is exempt. In production, strict mode only warns.
- **Lint.** `@selfbuilding/eslint-plugin` ships two rules:
  - `no-nondeterminism`, with the list above;
  - `no-handle-across-concurrency`, which flags a `SandboxHandle` captured by a `parallel()` thunk or a `pipeline()` stage that did not create it (§3.11).
- **Divergence check.** On hosted adapters, development mode compares each replayed call with the recorded one and throws `JournalDivergenceError` on a mismatch (§7.3).
- **Divergence report.** After a replay, journal entries that were never visited are listed as `orphaned` in the run summary. That is expected after an edit and suspicious otherwise. On hosted runs the orphan sweep (§7.3) also cancels their work.

### 3.9 Journal-replay resume

**Entry and store.** This is the one `JournalStore` interface. §7.5.4 uses it on plain Node.

```ts
interface JournalEntry {
  runId: string; stepKey: string; callPath: string;
  kind: "agent" | "step" | "exec" | "sandbox" | "clock" | "charge" | "run";
  status: "started" | "ok" | "failed";
  launchId: string;                // §7.2; feeds the chain head (§3.2)
  value?: unknown;                 // AgentResult (blobs by reference), step value, exec result
  sandbox?: { boxId: string; ref?: SandboxRef; harnessSessionId?: string; pid?: number };  // SandboxRef: §5.2
  harnessStartedAt?: string;       // set when the harness process launched
  checkpointAfter?: Checkpoint;    // shared-handle calls only
  charge?: { usd: number; tokens: number; turn: number; cumulative: true };  // kind "charge"
  attempt: number; startedAt: string; finishedAt?: string;
}

interface Lease { owner: string; leaseEpoch: number; expiresAt: string }   // leaseEpoch strictly increases per runId

interface JournalStore {
  get(runId: string, stepKey: string): Promise<JournalEntry | null>;
  list(runId: string): AsyncIterable<JournalEntry>;
  lease(runId: string, owner: string, ttl: Duration): Promise<Lease | null>;   // single writer
  renew(lease: Lease): Promise<Lease | null>;                                    // null: lost
  assertLease(lease: Lease): Promise<void>;                                      // throws LeaseLostError
  put(entry: JournalEntry,
      opts: { lease: Lease; expectStatus?: JournalEntry["status"] | null }): Promise<boolean>;   // CAS, fenced
}
```

The first entry of every run is `kind: "run"`. It holds the binding of `runId` to the factory and input hash (§3.2). `put` rejects any write whose `leaseEpoch` is not the current one, so a process that lost its lease cannot write (§7.5.4).

**Write-ahead.** A `started` entry is written before the sandbox or harness launches. It is updated with the provider `SandboxRef`, the harness session id, the pid and `harnessStartedAt` as soon as each is known. The completion is written only after the result has been validated and the artifacts have been uploaded.

**Replay rule: longest unchanged prefix, per sequential scope.** When `run()` is called with an existing `runId`, it takes the lease and runs the factory body again.

- **Cache hit.** A call whose `stepKey` matches an `ok` entry returns the stored value without starting anything, and sets `replayed: true`.
- **Miss.** The first miss in a scope runs live. A miss is an edited prompt, a changed input, a new call, a changed skill folder or a `failed` entry. Every later call in that scope, and in the child scopes it opens, also runs live. The reason is that later calls may depend on state the edited call changed, such as the shared working tree or the outside world, and Selfbuilding cannot see those dependencies. The chain head (§3.2) enforces this: after a live call, every later key in the scope is different.
- **Sibling scopes are independent prefixes.** The child scopes of `parallel()` and the item scopes of `pipeline()` each keep their own prefix. If you edit stage 3 of a 20-item pipeline, stage 3 and later stages re-run for every item, and stages 1 and 2 stay cached.
- **Failures are never cached.** `failed` entries, and failures caused by budget or abort, always re-run live.
- **`refresh: string[]`** forces matching calls live. Each entry is an exact `callPath`, or a prefix ending in `/`. A matching call's `stepKey` is salted with the current resume id, so it misses. The prefix rule then makes everything after it in its scope run live too. The resume id is journaled, so a host replay of the same resume reuses the salt and does not re-run the call a second time.

v1 has no other replay controls (see §3.15).

**Spend across resumes.** The budget ledger is journaled, so a resume never starts with a full budget again.

- Each agent attempt writes `charge` entries keyed by `(stepKey, launchId, turn)`. These carry cumulative totals and are written at each turn end and at most every 30 s.
- On resume, the remaining budget is `budget.usd` minus two things:
  - the `replayedUsd` of every replayed call;
  - the last cumulative charge of every attempt that did not complete, whether failed or interrupted.

  If the sandbox of an interrupted attempt is reachable, its event spool is read, and the higher of the spooled and journaled totals is used.
- Every admission reserves a slice, sized by the rule in §9.6. The harness's native cap is set to that slice (for example `--max-budget-usd`, §4.4). Spend that was never journaled is therefore bounded by one slice per attempt. When the attempt ends, the unused part of the slice is returned.
- If the remaining unreserved budget cannot cover a slice of at least `minAgentUsd` (§9.6), admission fails with `BudgetExceededError { phase: "admission" }`.

**Hosted runs (section 7).** On Trigger.dev, Inngest and Cloudflare Workflows, the host's memo is the journal inside one host run, and every host step is named from `stepKey`. No local journal is written. Resume after a terminal failure starts a new epoch, which reads successes only from the result store's cache (§7.6). What each host supports:

| Host | In-flight crash recovery | Resume after a terminal failure | Prefix rule and `refresh` | Budget ledger |
|---|---|---|---|---|
| Plain Node | Local journal | `run(…, { runId })` or `selfbuilding resume` | Yes | `charge` entries in the journal |
| Trigger.dev | Child idempotency keys plus parent re-execution (§7.5.1) | A new parent run at epoch + 1; successes come from the cache (§7.6) | Yes, because child keys are derived from `stepKey` | Each child gets a slice reserved by the parent when it is triggered, and its native cap equals that slice. The ledger is rebuilt on replay from child outputs, which carry usage for success and failure alike. A child that is still running holds its slice |
| Inngest | Step memo inside one function run | A new function run at epoch + 1; successes come from the cache (§7.6) | Yes, through the cache across epochs | `charge` values returned from `step.run` |
| Cloudflare Workflows | Step memo | A new instance `${runId}_e${epoch}`; successes come from the cache (§7.6). `instance.restart({ from })` is not used | Yes, because step names are derived from `stepKey` | `charge` values in the run DO |

G6 (§1.4) therefore means the following. Crash recovery of an in-flight run works on every host. Resume after a terminal failure, with the prefix rule, works on every host: through the local journal on plain Node, and through epochs plus the success cache on the hosted adapters.

### 3.10 Interrupted calls

A `started` entry with no completion means the previous process died during the call. This is the only rule for that case. Sections 6.8, 7.6 and 9.9 refer to it.

1. **Reattach first.** The run reopens the sandbox and probes the turn lock (§6.14).
   - If the harness is still running, the run waits for it as usual.
   - If the harness has finished and a valid result exists, the run settles it normally. That is not an interruption.
2. **Re-run only when no tool can have run.** The call runs again live from the start only when there is positive evidence that nothing happened. That means one of two things:
   - The journal shows the harness never launched (no `harnessStartedAt`).
   - The sandbox is reachable, the harness is dead, and the full event spool was read and contains no `tool.started` event.

   An agent can post a comment through `gh`, call an API or send `notify_human`, and none of those are idempotent. Deterministic branch names do not undo them, so "the sandbox is gone" is never enough to re-run.
3. **Otherwise apply `onInterrupted`.** The default is `"fail"` on every host and every placement.
   - `"fail"`: the call fails with `AgentInterruptedError` (code `interrupted`). The error's `recovery` carries `branch`, `headSha`, `sessionId`, `sandbox` and `snapshotId` where known. `run()` ends with status `needs_attention` while any interrupted call is unresolved.
   - `"resume-session"` (opt-in): the sandbox is reopened, or rebuilt from its snapshot or branch. The native session is then resumed once with the fixed message from §6.8. This counts as a new launch attempt.
4. **Deciding afterwards.** To continue a run that stopped with `needs_attention`, pass one of these:
   - `onInterrupted: { "<callPath>": "resume-session" }`;
   - `onInterrupted: { "<callPath>": "restore-and-rerun" | "skip" }` for calls on a shared handle (§6.8);
   - `refresh: ["<callPath>"]`, which re-runs the call from scratch as a deliberate, visible choice.

   The CLI equivalent is `selfbuilding resume <runId> --interrupted <callPath>=<policy>` (§1.12).

### 3.11 Sandbox placement

```ts
function sandbox(spec: {
  provider?: SandboxProvider;      // default: the factory's (or config's) sandbox provider
  repo?: string;                   // default: the factory's repo default, else required at first use
  branch?: string;                 // default: branchName(runId, label or "sandbox#n") (§6.13)
  label?: string;
  from?: Snapshot | Checkpoint;
}): SandboxHandle;                 // synchronous and lazy

interface SandboxHandle extends AsyncDisposable {
  readonly id: string;              // logical id, stable for the run: the label, or "sandbox#n"
  readonly callPath: string;        // where the handle was created
  readonly version: number;         // bumped by every mutation through the handle
  readonly forkedWith?: "filesystem" | "git";   // set on fork children
  exec(cmd: string, opts?: { cwd?: string; timeout?: Duration; checkpoint?: boolean }): Promise<ExecResult>;  // §5.2
  checkpoint(mode?: "git" | "snapshot"): Promise<Checkpoint>;
  push(): Promise<{ remote: string; name: string; sha: string }>;   // the handle's branch, pushed by the host (§9.2)
  snapshot(): Promise<Snapshot>;
  fork(n: number, opts?: { mode?: "best" | "filesystem" | "git" | "memory" }): Promise<(SandboxHandle | null)[]>;
  dispose(opts?: { mode?: "kill" | "pause" }): Promise<void>;
}

type Snapshot = { snapshotId: string; fidelity: "memory" | "filesystem"; expiresAt?: string };

type Checkpoint =
  | { kind: "git"; remote: string; ref: string; sha: string }   // checkpointRef(runId, boxId, version)
  | { kind: "snapshot"; snapshot: Snapshot; git: Checkpoint & { kind: "git" } };
```

`SandboxHandle` is the user-facing handle. The provider-level interface in §5.2 is `ProviderSandbox`. `ExecResult` is the §5.2 type: `{ exitCode, stdoutTail, stderrTail, truncated }`. A non-zero exit is returned, never thrown.

**Branch and ref names.** Every branch and ref comes from the two functions in §6.13:

| What | Ref |
|---|---|
| Fresh agent's branch | `refs/heads/` + `branchName(runId, callPath)` = `refs/heads/selfbuilding/<runId>/<callPathSlug>` |
| Shared handle's branch | `refs/heads/` + `branchName(runId, handle label or id)` |
| Checkpoints | `checkpointRef(runId, boxId, version)` = `refs/selfbuilding/<runId>/<boxId>/<version>` |
| Mid-turn WIP | `refs/selfbuilding/wip/<runId>/<stepKey>` (§5.8) |

- The full `runId` is always used. Together with the `runId` binding in §3.2, this means one run can never overwrite another run's branch.
- The runtime push guard (§6.13) and the recommended repository ruleset (§9.2) allow both `refs/heads/selfbuilding/*` and `refs/selfbuilding/*`.
- Pushes to these branches use `--force-with-lease`.

**Default: a fresh sandbox per agent call.** The sandbox is created from the factory's default provider, the repo is cloned at the requested branch, and the agent runs. On success its commits are pushed to its branch by the host, and the box is killed once the outcome is acknowledged (§5.8). A fresh box gives isolation, makes failures cheap, and is safe to replay, because a cached call creates no box at all.

**Opt-in sharing: `{ sandbox: box }`.** Agents and `exec`s on the same handle share one working tree.

- **Handles are lazy.** `sandbox()` returns at once. The provider box is created on the first live call that needs it, so a fully replayed prefix costs no sandbox.
- **One writer at a time.** A handle runs one mutation at a time.
  - **Busy handle.** A second call made while a mutation is running throws `SandboxBusyError` at once. It does not queue, because a queue would make the working tree depend on completion timing. Await the first call, or `fork()`.
  - **Across concurrent scopes.** Using a handle from a `parallel()` child or a `pipeline()` item that did not create it throws `SandboxHandleScopeError` at the call, every time, whatever the timing. Strict-mode lint catches it statically (§3.8). To run work concurrently, use `fork()`.
- **Ownership.**
  - The handle belongs to the scope that created it.
  - `await using box = sandbox(...)` disposes it when that scope ends. Without `using`, the run disposes every handle it owns in `finally` when the run ends.
  - A handle passed into a nested factory, or into a helper called sequentially, is *borrowed*. Calling `dispose()` on a borrowed handle throws `NotOwnerError`.
  - Disposal is `kill`. A handle whose owner has been idle for 5 minutes is parked (§5.8). Shared handles are hot-only for `ask()` (§8.4).
  - Boxes carry the labels from §5.2, including `selfbuilding.run=<runId>`, so the reaper can find leaks after a crash (§5.9).
- **Checkpoints.** Every agent call on a shared handle ends with a checkpoint (`checkpoint` option, default `"git"`):
  1. All changes, including uncommitted and untracked files but excluding ignored files and the built-in exclude list (§9.3), are committed onto `checkpointRef(runId, boxId, version)`.
  2. The host pushes that ref to the run's git remote at the call boundary, after scanning the outgoing objects (§9.2, §9.3).
  3. With `"snapshot"`, a provider snapshot is also taken when the provider supports one, after quiescence (§5.8). It captures `node_modules`, build output and caches as well.
  4. The checkpoint goes into the journal entry as `checkpointAfter`.

  `exec` does not checkpoint unless you pass `{ checkpoint: true }`.
- **Marker.** Each box holds `/selfbuilding/state/box.json` with `{ runId, boxId, version, generation, sandboxId }` (§6.4). It is rewritten after every checkpoint. A fork rewrites it at once with a new `boxId` and `generation`, so a fork can never be mistaken for its parent.

**How replay rebuilds a shared sandbox.** Cached calls are **never re-executed** to rebuild state. When the first live call on a box arrives, the box is *materialised* at the state of the last replayed checkpoint.

1. **Reuse the original box** only if all of these hold:
   - the provider box still exists;
   - no `started`-but-unfinished entry for this box comes after the last replayed checkpoint;
   - the turn lock is `FREE`;
   - the marker's `runId`, `boxId` and `version` equal the checkpoint's;
   - the marker's `generation` and `sandboxId` equal the provider's current id;
   - `git rev-parse HEAD` equals the checkpoint SHA;
   - `git status --porcelain --ignored=no` is empty;
   - `git stash list` is empty.
2. Otherwise, if the checkpoint is a snapshot that has not expired, create a box from the snapshot.
3. Otherwise, create a fresh box, clone, check out the checkpoint's git ref, and run the template's setup hooks.
4. If a `started`-but-unfinished entry exists, §3.10 applies before anything else. Under `"fail"`, the run stops with `needs_attention` instead of materialising.
5. Uncheckpointed `exec` calls recorded after the last checkpoint and before the first live call are **run again live**, in order. Write them to be idempotent (`pnpm install --frozen-lockfile`, `pnpm test`). Pass `checkpoint: true` to any exec whose effect is expensive or not idempotent.

External side effects of cached calls (pushes, PR comments, Slack posts) are not repeated, because those calls do not run.

**How journaled results refer to sandbox state.** Journal values hold only *durable* references:

- git refs with a SHA on a remote;
- snapshot ids with their expiry;
- `ArtifactRef`s in the artifact store.

A `SandboxRef` (§5.2) appears only as a hint for reattaching. Providers delete paused boxes and kill stuck ones, so every snapshot checkpoint also carries a git checkpoint, and a restore never depends on a box still existing.

**Passing information between sandboxes.**

| Mechanism | Carries | Use when |
|---|---|---|
| Typed result (`prev.result`) | values up to 256 KiB | a plan, verdict, findings or issue list feeds the next agent's input |
| Git branch (`artifacts.branch`) | committed code | an independent agent should see the code but not the environment (a reviewer, a PR) |
| `checkpoint()` then `sandbox({ provider, from })` | code, plus the environment with `"snapshot"` | resume a working tree in a new box, for example after a lifetime limit |
| `box.fork(n)` | the filesystem state at fork time | N agents must start from the same state and diverge (judges, alternative fixes) |
| Artifact files (`artifacts.files`) | blobs | logs, screenshots, coverage reports |

**`fork()`.**

- With `mode: "best"`, `fork()` uses the provider's native fork as a fast filesystem copy where it has one, otherwise a snapshot plus N creates, and otherwise a git checkpoint plus N fresh boxes (§5.5). The box is quiesced first (§5.8).
- It never pretends that processes carried over. Each fork handle reports `forkedWith: "filesystem" | "git"`. `mode: "memory"` throws `SandboxUnsupportedError { op: "fork.memory" }` in v1 (§5.5).
- A requested `mode` that the provider cannot meet fails that call. It is not silently downgraded.
- A fork that fails comes back as `null` in the array.
- Forks are owned by the scope that called `fork()`, and each fork counts as one sandbox. On replay they are materialised lazily from the parent's checkpoint at fork time.

### 3.12 Shared budget and the sandbox cap

**Budget.** `budget` (§9.6) covers the whole run, including nested factories and all resumes (§3.9).

- Agents are charged live from the harness's `usage` events (§4.3). When a harness reports tokens but no cost, a price table converts tokens to dollars (§9.6).
- Sandbox time is charged when the provider adapter reports a rate (§5).
- A per-call `budget.usd` caps one agent. It is passed to a native flag where one exists, and Selfbuilding's own meter enforces it everywhere.
- Every running agent is held to the slice it reserved at admission (§9.6). When it crosses that slice, its runtime sends SIGINT, waits a grace period, then SIGKILL, and the call throws `BudgetExceededError { phase: "running" }` (§3.1).
- When the run's unreserved budget cannot cover a new slice, new calls throw `BudgetExceededError { phase: "admission" }`, and `run()` ends with status `budget_exhausted`.
- On plain Node the meter sees usage as it streams. On durable hosts the orchestrator sees usage only when a child completes or on a reaper tick; each child stops itself at the end of its reserved slice. A live cutoff that stops running agents because siblings spent the budget arrives with the control plane (§7.11, §9.6).
- Replayed calls are not charged again. Their original cost is shown as `replayedUsd` and deducted from the remaining budget.
- Time spent waiting for a sandbox slot, or in a cold `ask()` wait (§8.4), does not count toward `wallClock`.

**Sandbox cap.** `concurrency.sandboxes` limits the number of *live sandboxes*, not the number of agents.

- A shared handle counts as one. Each fork counts as one. A paused box does not count.
- A fresh box takes a slot when it is created and releases it when it is killed. A shared handle takes a slot when its box is materialised and releases it when it is parked or disposed.
- The default is `min(4, provider.limits.maxConcurrent)`. That one default applies everywhere.
- The cap is `interface SandboxSlots { acquire(callPath, priority, n?): Promise<Slot[]> }`. In plain Node it is an in-process semaphore. On durable hosts it is enforced by the parent scheduler or a replay-stable semaphore (§7.5), because host concurrency settings do not count live sandboxes.
- **`fork(n)` takes its slots atomically.** It waits until all `n` slots are free at once. It never holds some slots while waiting for the rest. If `n` is greater than the cap, it throws `ConfigError` at once.
- **Deadlock detection.** The slot manager watches for a deadlock: every slot holder is idle (no turn, no exec), and at least one call waits in `acquire`. This happens, for example, when N parallel branches each own a shared handle and each then calls a fresh-box reviewer. When it detects one:
  1. It parks idle shared handles whose turn lock is `FREE`, at once and without the 5-minute idle rule, until the waiters can proceed.
  2. If nothing can be parked, it rejects the waiters with `SandboxCapDeadlockError`. The error names the holders' and waiters' `callPath`s. It is a usage error: raise the cap or restructure the factory.

  A scripted test covers this with a cap of 2 and two branches that each hold a shared handle and then call a fresh-box agent.

### 3.13 Examples

**Implement, review, fix: one shared sandbox plus an independent reviewer.**

```ts
import { factory, sandbox, agent, phase, log } from "@selfbuilding/core";
import { ImplementSpec, CodeReview } from "@selfbuilding/agents";
import { codex } from "@selfbuilding/harnesses/codex";
import { impello } from "@selfbuilding/sandbox-impello";
import { z } from "zod";

export const ImplementReviewFix = factory(
  { name: "implement-review-fix", input: z.object({ repo: z.string(), spec: z.string() }) },
  async ({ repo, spec }) => {
    await using box = sandbox({ provider: impello({ template: "selfbuilding-claude-code" }), repo, label: "work" });

    phase("implement");
    // A direct call: a failure throws and ends the factory, which is what we want here.
    await ImplementSpec({ spec }, { sandbox: box, label: "implement" });

    for (let round = 0; round < 3; round++) {
      phase(`review-${round}`);
      const tests = await box.exec("pnpm test", { timeout: "15m" });
      const branch = await box.push();          // selfbuilding/<runId>/work

      // Independent reviewer: fresh sandbox, sees only the pushed branch, different harness.
      const review = await CodeReview.settled(
        { target: { kind: "diff", base: "main", head: branch.name } },
        { repo, harness: codex({ model: "gpt-5.5-codex" }), label: `review-${round}` },
      );
      if (!review.ok) { log("warn", "review failed; stopping loop", { round, code: review.code }); break; }
      if (review.value.result.verdict === "approve" && tests.exitCode === 0) break;

      phase(`fix-${round}`);
      await agent({
        name: "fix",
        prompt: "Address every finding below. Keep the diff minimal. Run the tests before submitting.",
        input: { findings: review.value.result.findings, testTail: tests.stdoutTail.slice(-4000) },
        output: z.object({ summary: z.string() }),
        sandbox: box,
        label: `fix-${round}`,
      });
    }
    const final = await box.push();
    return { branch: final.name };
  },
);
```

If you edit the fix prompt and re-run with the same `runId`:

- `implement`, `review-0`, and the exec and push before them are served from the journal.
- The box is reused only if it passes every check in §3.11. Otherwise it is materialised from the `implement` checkpoint, and the uncheckpointed `pnpm test` runs again.
- `fix-0` and everything after it runs live.

Do not run this pattern inside `parallel()` with `concurrency.sandboxes` equal to the number of branches unless you accept that the shared handles will be parked to free slots for the reviewers (§3.12).

**A pipeline over 20 GitHub issues.**

```ts
export const Triage20 = factory(
  { name: "triage-20", input: z.object({ repo: z.string() }) },
  async ({ repo }) => {
    const issues = await step("list-issues", () => github.listIssues(repo, { label: "agent-ok", limit: 20 }));

    const prs = await pipeline(
      { key: (i) => `issue-${i.number}` },
      issues,
      // stage 1: plan (cheaper model, fresh sandbox, read-only). null drops the item
      async (issue) => {
        const p = await PlanIssue({ issue: issue.number }, { repo, harness: claudeCode({ model: CHEAP_MODEL }), effort: "medium" });
        return p.result.feasible ? p : null;
      },
      // stage 2: implement in its own fresh sandbox; the host pushes the branch
      (plan) => ImplementSpec({ spec: plan.result.spec }, { repo }),
      // stage 3: review the branch, then open a PR only on approval
      async (impl, { item }) => {
        const review = await CodeReview({ target: { kind: "diff", base: "main", head: impl.artifacts.branch!.name } }, { repo });
        if (review.result.verdict !== "approve") return null;
        return step(`open-pr-${item.number}`, () =>
          github.openPr({ repo, head: impl.artifacts.branch!.name, title: `Fix #${item.number}` }));
      },
    );

    const opened = prs.filter(isPresent);
    log("done", { opened: opened.length, dropped: prs.length - opened.length });
    return { prs: opened };
  },
);
```

How this run behaves:

- Up to `concurrency.sandboxes` agents run at once, and later stages are scheduled first.
- A stage that throws drops only its own issue.
- Re-running after a twenty-first issue is added replays the existing twenty, because they are keyed by issue number, and runs only the new one.
- `list-issues` is a `step()`, so a replay sees the same list. Pass `refresh: ["list-issues"]` to fetch it again. Every item whose stage inputs are unchanged still hits the cache, because item scopes are independent prefixes. A changed list changes only the items that differ.

**A judge panel on forks.**

```ts
export const JudgePanel = factory(
  { name: "judge-panel", input: z.object({ repo: z.string(), branch: z.string() }) },
  async ({ repo, branch }) => {
    await using box = sandbox({ provider: impello({ template: "selfbuilding-claude-code" }), repo, branch, label: "candidate" });
    await box.exec("pnpm install --frozen-lockfile && pnpm build", { checkpoint: true });

    const forks = await box.fork(3, { mode: "best" });   // 3 slots, taken atomically
    try {
      const harnesses = [claudeCode({ model: CLAUDE_MODEL }), codex({ model: CODEX_MODEL }), opencode({ model: OPENCODE_MODEL })];
      const verdicts = await parallel(forks.map((f, i) => () =>
        f ? Judge({ rubric: RUBRICS[i] }, { sandbox: f, label: `judge-${i}`, harness: harnesses[i] })
          : Promise.resolve(null)));
      const votes = verdicts.filter(isPresent);
      const pass = votes.length >= 2 && votes.filter((v) => v.result.pass).length * 2 > votes.length;
      return { pass, votes: votes.map((v) => v.result) };
    } finally {
      await Promise.all(forks.map((f) => f?.dispose()));
    }
  },
);
```

Each judge can run the tests and edit files in its own fork without affecting the others or the candidate. Each fork was created in the factory scope and is used by exactly one `parallel()` child, which the handle-scope rule allows: a fork handle passed to a single child is treated as created for that child.

### 3.14 Failure modes this section designs for

| Failure | Behaviour |
|---|---|
| Process crash mid-run | Re-run with the same `runId`. Completed calls replay. Interrupted calls reattach. A call is re-run live only if no tool can have run. Otherwise it fails with `interrupted` and the run ends `needs_attention` (§3.10) |
| Same `runId`, different input | `RunIdConflictError` before anything runs |
| Edited prompt or skill | Its `stepKey` changes, so it and the rest of its scope run live. Sibling scopes stay cached |
| Shared box left dirty by a crashed call | Not reused. It is restored from its checkpoint, or the run stops under §3.10 |
| A shared box was reaped or expired | Materialised from the last snapshot or git checkpoint. Never an error by itself |
| Repeated crash and resume | The journaled ledger deducts replayed and interrupted spend. Each attempt is capped by its reserved slice |
| Budget hit mid-agent | The agent is stopped at its slice and throws `BudgetExceededError`. The run ends `budget_exhausted` with partial results |
| Two calls on one handle at the same time | `SandboxBusyError` for the second call; from a concurrent scope that did not create the handle, `SandboxHandleScopeError`, deterministically. The fix is `fork()` |
| Every slot is held by a waiting branch | Idle shared handles are parked. If none can be parked, `SandboxCapDeadlockError` names the paths |
| The provider returns a fork error | That fork is `null`. The other forks proceed |
| Non-deterministic code in a factory | Strict mode throws `NonDeterminismError`. Otherwise orphaned journal entries are reported |

### 3.15 Left out of v1

Each item gets a file in `docs/out-of-scope/` with the reason, so the request does not come back unrecorded.

| Feature | Use instead |
|---|---|
| `replay: "content"` and `scope({ replay })`, which reuse any key match regardless of prefix | `refresh` and labels |
| `replay: "pin"`, which keeps a result after a skill edit | Revert the edit, or accept the re-run |
| `seedFrom`, which seeds a new hosted run from a finished run's exported journal | Epoch resume with the success cache (§7.6), scoped to one `runId` |
| Queuing calls on a busy handle (FIFO lock) | `SandboxBusyError`, sequential `await`, and `fork()` |
| `agent(CompiledAgent, …)` and `{ required: true }` | Call the Agent directly; use `.settled()` for the value form |

### 3.16 Open questions

Moved to §11 (Q21 to Q24; the Cloudflare `instance.restart` question is closed in §11.8).

## 4. Harness adapters

A harness is the coding-agent CLI that does the work inside a sandbox: Claude Code, Codex, OpenCode, Amp, Droid, Pi or Grok. A harness adapter is the only part of Selfbuilding that knows a vendor's flags, stream format, session files and auth. Everything above it sees one interface and one event schema.

Other sections cover the surrounding pieces:

- Section 2 covers how a skill becomes an `Agent` and the `submit_result` contract.
- Section 5 covers sandbox providers.
- Section 6 covers the in-sandbox runtime, which executes what an adapter plans. §6.4 holds the canonical filesystem layout.
- Section 7 covers durability.
- Section 8 covers human-in-the-loop (HITL) and AFK runs.
- Section 9 covers credential storage, egress, redaction and the event envelope.
- Section 10 covers the test matrix.

### 4.1 Design rules

1. **An adapter is pure.** It builds plans: files to write, an argv to run, env to set. It parses output lines into events. It never touches a sandbox, the network or a clock. The runtime (section 6) executes the plan. This split has three benefits:
   - any harness works with any sandbox;
   - adapters can be unit tested with recorded fixtures;
   - a plan can cross a durable step boundary as plain JSON.
2. **No shell strings.** Every invocation is an argv array. Prompts, system text and skill bodies are written to files inside the sandbox and are never interpolated into a command. Channel text and issue bodies are user-controlled and can contain `$(...)`.
3. **The prompt never goes in argv.** Linux limits a single argument to about 128 KiB, and argv shows up in process lists. If a harness reads stdin, the runtime redirects stdin from the prompt file and then closes it. If it does not, the adapter passes a short fixed argv instruction that points at the prompt file (see §4.6).
4. **Config is isolated on every run.** Each run gets its own `HOME` and the harness's config-dir variable, both under `{home}` (§4.2.1). User-level hooks, skills, MCP servers and memory from the image or from a developer machine must never leak into a run.
5. **The adapter observes. The runtime decides.** An adapter emits what it saw, such as `turn.ended` or `error`. It never declares that an agent succeeded or failed. The runtime (section 6) picks exactly one terminal outcome per agent call. It decides from the result file, the events and the exit status together.
6. **The exit code never decides success alone.** OpenCode and Droid exit 0 on failure. Codex exits 0 outside a git repo. Claude Code exits 143 on SIGTERM and records no result.
7. **stderr is for diagnostics only.** It is kept in the transcript but is never shown as "the error". Failures are read from the stream.
8. **Never use "continue last session" flags.** `--continue`, `-c` and `--last` resolve by directory or recency, so they leak across runs. Resume is always by an explicit session id.
9. **A turn that did work is never restarted from a blank session.** If a turn has taken an action with an effect, every later retry of it is a resume of the same session (§4.12). This applies to retries for rate limits, provider errors and credential failover.

### 4.2 The `Harness` interface

`Harness` is the only name for this interface. The scripted test harness implements it too, and `describeHarness()` in `@selfbuilding/testing` checks third-party implementations (§4.13).

```ts
// @selfbuilding/core
export type HarnessId =
  | 'claude-code' | 'codex' | 'opencode'      // first-class in v1
  | 'amp' | 'droid' | 'pi' | 'grok';          // experimental in v1

/** The one effort union. AgentCallOptions and contract defaults (§2) use this type. */
export type Effort = 'low' | 'medium' | 'high' | 'max';

export interface Harness {
  readonly id: HarnessId | (string & {});      // third-party adapters use their own id
  readonly stability: 'stable' | 'experimental';
  readonly capabilities: HarnessCapabilities;

  /** Commands that install the CLI at an exact version. Skipped when the image already has that version. */
  install(version: string): InstallPlan;
  /** Hosts the install plan needs to reach. Added to the egress allowlist when an install is planned (4.11). */
  installHosts(): string[];
  /** `<bin> --version`, run at the start of every agent call. The output is journaled. */
  versionCommand(): Command;
  parseVersion(stdout: string): string;

  /** Turns a credential into env vars and 0600 files. Never into argv. */
  auth(cred: HarnessCredential, ctx: AuthContext): AuthPlan;

  /** Config files for one agent call: MCP servers, hooks, skill links, instructions, settings. */
  prepare(ctx: PrepareContext): FilePlan;

  /** A fresh session. */
  invoke(ctx: InvokeContext): Invocation;
  /** Continue an existing session with a new user message. If absent, the harness cannot resume. */
  resume?(ctx: InvokeContext & { sessionId: string }): Invocation;
  /** Branch an existing session into a new one. If absent, the harness cannot fork. */
  fork?(ctx: InvokeContext & { sessionId: string }): Invocation;

  /** Move a session between sandboxes (see 4.7). If absent, resume works only in the same sandbox. */
  sessionArtifacts?(sessionId: string, ctx: PathsContext): SessionTransfer;

  /** One parser per process. Stateful, because some formats need lookback. */
  createParser(ctx: ParseContext): HarnessParser;

  /** Classify a failure seen in the stream or at exit. Only the adapter reads vendor text. */
  classify(signal: FailureSignal): HarnessFailure;

  /** The model-visible name of an MCP tool, used when rendering prompts. */
  toolName(server: string, tool: string): string;
}

export interface HarnessCapabilities {
  promptVia: 'stdin' | 'file-ref';
  preassignSessionId: boolean;       // the session id can be chosen before launch
  mcp: 'native' | 'bridge';          // bridge: Selfbuilding tools only, through a harness extension
  stopAfterSubmit: 'hook' | 'kill';  // how the run ends after a valid submit_result (4.5)
  usage: 'usd' | 'tokens' | 'none';
  nativeBudgetCap: boolean;          // e.g. --max-budget-usd
  effort: readonly Effort[];         // supported values, mapped per harness
  skillDirs: readonly string[];      // directories, relative to {workdir}, the harness discovers skills from
  subscriptionAuth: boolean;
  needsGlibc: boolean;
  mcpToolTimeoutMs?: number;         // a fixed per-call MCP tool timeout, when the harness cannot raise it (§6.11, §8.4)
}

export interface Invocation {
  argv: string[];                    // argv[0] is an absolute path, never a PATH lookup
  env: Record<string, string>;
  cwd: string;                       // always {workdir}
  stdinFile?: string;                // the runtime redirects stdin from this file, then closes it
  sessionId?: string;                // set when preassigned
}

export interface InvokeContext {
  runId: string;
  callPath: string;                  // stable position of this agent call (§3.2)
  attempt: number;
  model?: string;                    // the harness's own model id, taken from the harness value, passed through unchanged
  effort?: Effort;
  paths: PathsContext;               // 4.2.1
  promptFile: string;                // {in}/prompt.md
  systemFile?: string;               // {in}/system.md
  budgetUsd?: number;                // passed to the native cap if there is one, as a backstop
}

export interface HarnessParser {
  line(line: string): HarnessEvent[];          // one complete line, without its '\n'
  end(exit: { code: number | null; signal: string | null }): HarnessEvent[];
  sessionId(): string | undefined;
}
```

What a harness can do is shown by which methods it has: `resume`, `fork` and `sessionArtifacts`. There are no matching booleans in `HarnessCapabilities`. The core checks whether the method exists, the same rule section 5 uses for providers. The fields left in `HarnessCapabilities` describe how the harness behaves. They do not decide whether an operation exists.

**Model ids are not abstracted.** `model` is the harness's own string, set on the harness value: an Anthropic model id for Claude Code, an OpenAI model id for Codex, `<provider>/<model>` for OpenCode. Every cross-vendor model alias layer drifts, and users already know the ids they want.

**Effort is abstracted.** Every harness has this setting under a different flag, and there are only four values. If a harness does not support the requested effort, the adapter maps it to the nearest supported value and emits a `warning` event. There is no `xhigh`. A vendor level above `high` maps to `max`.

#### 4.2.1 Paths

Adapters never hard-code a path. They receive a `PathsContext` and refer to its entries by name. **The canonical values are defined once, in the §6.4 path table.** Sections 4, 5 and 9 refer to that table and do not restate it.

| Name | §6.4 path | What §4 uses it for |
|---|---|---|
| `{workdir}` | `/selfbuilding/work` | The repo working tree. `cwd` and `PWD` of every harness process. |
| `{home}` | `/selfbuilding/home` | `HOME`, and the parent of every harness config dir (`.claude`, `.codex`, `opencode.json`, ...). |
| `{in}` | `/selfbuilding/in` | `prompt.md` and `system.md` for the current attempt. |
| `{out}` | the attempt directory `/selfbuilding/state/calls/<stepKey>/<attempt>` | `result.json` and the submission log. |
| `{bin}` | `/selfbuilding/bin` | `selfbuilding-mcp` and other runtime binaries. |
| `{skills}` | `/selfbuilding/skills` | Materialised skill folders. |
| `{secrets}` | `/run/selfbuilding/secrets` | 0600 credential files. |
| `{state}` | `/selfbuilding/state` | Durable per-call state that survives pause and resume. |
| `{run}` | `/run/selfbuilding` | Files that only matter while a process is alive (locks, sockets). |

Three rules matter for harnesses:

- **`{workdir}` and `{home}` are the same constants on every provider and every box.** Claude Code stores sessions under `{home}/.claude/projects/<path-encoded {workdir}>/`. A session captured on one box therefore restores to the same path on another box with no rewriting. A provider that cannot put the tree at `{workdir}` fails conformance. Docker's `mount: "worktree"` mode mounts the host worktree at `{workdir}` too.
- **No harness state goes under `/tmp` or `{run}`.** Many providers wipe those on resume.
- **Conformance check:** for each first-class harness, a session started in one fresh sandbox is captured, restored into a second fresh sandbox on the same provider, and resumed there. The resumed turn must see the earlier conversation (§10.3, L2 and L4).

#### 4.2.2 Usage

Adapters ship as subpath exports, and each one is loaded only when imported: `@selfbuilding/harnesses/claude-code`, `/codex`, `/opencode`, `/amp`, `/droid`, `/pi`, `/grok`. Each is a factory that takes harness-specific options, so call options never grow per-vendor fields.

Docs examples should use named constants for model ids. A literal id in an example is a placeholder the reader replaces. Versions are never written into examples. They come from `harness-versions.json` through `'tested'` (§4.11).

```ts
import { claudeCode } from '@selfbuilding/harnesses/claude-code';
import { codex } from '@selfbuilding/harnesses/codex';

const CLAUDE_MODEL = '<anthropic-model-id>';   // placeholder: your model id
const CODEX_MODEL = '<openai-model-id>';       // placeholder: your model id

const review = await CodeReview(input, {
  harness: claudeCode({ model: CLAUDE_MODEL, effort: 'high' }),        // version defaults to 'tested'
});
const second = await CodeReview(input, {
  harness: codex({ model: CODEX_MODEL, effort: 'high', version: 'latest' }),
});
```

### 4.3 Normalised event schema

Every adapter turns native lines into `HarnessEvent`s. The runtime then:

1. adds the envelope fields (the one `EventEnvelope`, defined in §9.7);
2. redacts secrets (§9.4);
3. forwards the events to the journal, the progress stream (`phase()`/`log()`, §3.7) and HITL channels (section 8).

```ts
export type HarnessEvent =
  | { type: 'session.started'; sessionId: string; model?: string; tools?: string[];
      mcp?: { name: string; status: 'connected' | 'failed' | 'pending'; error?: string }[] }
  | { type: 'message.delta'; kind: 'text' | 'thinking'; text: string }   // opt-in; high volume
  | { type: 'message'; role: 'assistant'; text: string }                  // one complete step's text
  | { type: 'tool.started'; callId: string; name: string;
      source: 'builtin' | 'mcp' | 'skill' | 'subagent'; server?: string;
      effect: 'read' | 'effect';                                         // see "Tool effects" below
      input?: unknown; summary: string }
  | { type: 'tool.completed'; callId: string; name: string; ok: boolean;
      output?: string; truncatedBytes?: number; durationMs?: number }
  | { type: 'file.changed'; path: string; change: 'add' | 'modify' | 'delete' }
  | { type: 'retry'; attempt: number; delayMs?: number; cause: string }   // vendor-side API retry
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedInputTokens?: number;
      reasoningTokens?: number; costUsd?: number; cumulative: boolean }
  | { type: 'warning'; message: string }
  | { type: 'error'; failure: HarnessFailure }
  | { type: 'turn.ended'; reason: 'end_turn' | 'max_turns' | 'budget' | 'interrupted' | 'error' };

export interface HarnessFailure {
  code: 'auth' | 'quota' | 'rate_limit' | 'billing' | 'invalid_request' | 'context_overflow'
      | 'provider' | 'harness_crash' | 'unknown';
  retryable: boolean;
  retryAfterMs?: number;              // from the vendor, when it says
  message: string;                    // unwrapped from nested vendor JSON
}
```

On harness events the envelope also carries `sessionId` and `parentToolUseId` (subagent nesting inside the harness), and the runtime stamps `turnIndex` (§9.6).

`HarnessFailure.code` is the adapter-level classification. It surfaces to callers as an `ErrorCode` (§9.8) through the mapping in §4.12.

`result.submitted` and `post_submit_changes` (§4.5) are not harness events. The Selfbuilding runtime emits them from inside the sandbox, so they look the same on every harness. That includes harnesses that only report tool calls after they finish.

**Tool effects.** Every `tool.started` has an `effect`. The retry rules in §4.12 depend on it. The adapter sets it from a fixed allowlist of read-only tools. Anything not on the list is `'effect'`.

| Classified as `read` | Examples |
|---|---|
| Built-in tools that only read files or search | Claude `Read`, `Glob`, `Grep`, `LS`, `WebSearch`, `WebFetch`, `TodoWrite`. Codex `web_search`. OpenCode `read`, `glob`, `grep`, `list`. |
| Selfbuilding's `submit_result` | It writes only Selfbuilding's own result file. |

| Always classified as `effect` | Why |
|---|---|
| Any shell tool (Claude `Bash`, Codex `command_execution`, OpenCode `bash`) | `git push`, `gh pr comment` and `curl -X POST` look like any other command. Selfbuilding does not parse commands to guess intent. |
| File edits and writes | They change the tree. |
| `ask_human`, `notify_human` | They post to a channel. |
| Any other MCP tool, subagent or skill tool | Selfbuilding cannot see what it does. |
| Unknown tool names | Unknown means effect. |

A wrong `effect` only ever errs toward resuming instead of restarting. A resume costs a little context. Repeating a push or a comment does damage that cannot be undone.

The parser follows these rules. Every adapter must obey them, and the shared parser test suite in §10.3 checks them:

- Split on `\n` only. Node `readline` also splits on U+2028/U+2029 and corrupts JSONL.
- Lines longer than 4 MiB are dropped with a `warning`. Output is kept as a bounded rolling tail, never as one growing string.
- Non-JSON lines and unknown event types are dropped. When `debug.rawEvents` is on, they are kept as a redacted `raw` attachment.
- One native event produces zero or more normalised events. OpenCode reports each tool once, after it finishes, as a `tool_use` event. That one event produces both `tool.started` and `tool.completed`.
- `usage` events say whether they are cumulative, so that budget accounting (§9.6) is idempotent when an event is re-sent.
- A turn can end with no `turn.ended` event, for example on SIGINT or a crash. `end()` must still emit whatever the exit tells it.
- Item-level errors that do not end the turn are `warning`s. Codex emits `error` items on runs that still succeed.

How native events map onto the schema:

| Normalised | Claude Code | Codex | OpenCode | Amp | Droid | Pi | Grok |
|---|---|---|---|---|---|---|---|
| `session.started` | `system/init` | `thread.started` | first event's `sessionID` | `system/init` | `system` / `result.session_id` | header `type:"session"` | preassigned id |
| `message` | `assistant` text blocks | `item.completed` `agent_message` | `text` parts within a step | `assistant` text | `message` | `message_end` | text events |
| `tool.started` / `.completed` | `assistant.tool_use` / `user.tool_result` | `item.started` / `item.completed` | one `tool_use`, emitted as both | as Claude | `tool_call` / `tool_result` | `tool_execution_start` / `_end` | tool events |
| `usage` | `result.usage`, `total_cost_usd` | `turn.completed.usage` | `step_finish.tokens`, `.cost` | `result.usage` | `result.usage` | `message_update.usage` | `end.usage` |
| `retry` | `system/api_retry` | none | none | none | none | `agent_end.willRetry` | none |
| `turn.ended` | `result` | `turn.completed` | process exit (never `step_finish`) | `result` | `result` / `completion` | `agent_settled` | `end` |
| `error` | `result.is_error`, `api_retry.error` | `turn.failed`, top-level `error` | `error` event (exit is 0) | `result.is_error` | `is_error` | `assistantMessageEvent: error` | `error` |

### 4.4 Invocation per harness

All commands run with `cwd={workdir}`, `PWD={workdir}` and `HOME={home}`. Permission prompts are bypassed in every case, because the sandbox is the security boundary (§9.5 covers egress policy). Approval-style HITL goes through the `ask_human` tool (section 8), not through harness permission prompts. Bridging harness permission prompts to channels is post-v1 (§11, Q52).

**Claude Code**

```
{bin-claude} -p --output-format stream-json --verbose
       --model <m> [--effort <e>] [--max-budget-usd <usd>]
       --session-id <uuid> | --resume <uuid>
       --mcp-config {home}/mcp.json --strict-mcp-config
       --settings {home}/settings.json
       --append-system-prompt-file {in}/system.md
       --dangerously-skip-permissions
       -                                       # stdin ← {in}/prompt.md
```

- Env:
  - `CLAUDE_CONFIG_DIR={home}/.claude`
  - `DISABLE_AUTOUPDATER=1`
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
  - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, because subagents must finish within the turn
  - `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, so the agent call's wall-clock budget is the only limit on background work
  - `MCP_TOOL_TIMEOUT=<ms>`, always set explicitly (§6.11)
- `settings.json` turns off the harness's own commit and PR attribution, because attribution is Selfbuilding's job (§6.13). It also holds the `PostToolUse` hook from §4.5.
- `--bare` is not used. It disables OAuth and the project `CLAUDE.md`, and the repo's own instructions improve results. Isolation comes from the private config dir instead.

**Codex**

`resume` is a subcommand of `codex exec`. It comes straight after `exec`, before any option. If it were placed after the options, it would be parsed as the positional prompt "resume".

```
# fresh session
{bin-codex} exec [options] -

# resume
{bin-codex} exec resume <threadId> [options] -

options:
  --json --skip-git-repo-check --ignore-user-config
  -m <m> [-c model_reasoning_effort="<e>"]
  -s danger-full-access -c approval_policy="never"
  -c 'mcp_servers.selfbuilding.command="{bin}/selfbuilding-mcp"'
  -c 'mcp_servers.selfbuilding.default_tools_approval_mode="approve"'
  -c 'mcp_servers.selfbuilding.tool_timeout_sec=<s>'
# the trailing "-" reads the prompt from stdin ← prompt file; never an inherited stdin
```

- Env: `CODEX_HOME={home}/.codex`.
- The MCP server must be pre-approved. Otherwise `approval_policy="never"` refuses every MCP call with "MCP tool call requires approval".
- Codex's own sandbox fails to start inside container sandboxes, so `danger-full-access` is required.
- If Codex ever runs without the prompt on stdin, the runtime still attaches `/dev/null`. A non-TTY stdin left open hangs some versions forever.
- The parse-contract probe (§4.11) records a resume fixture for the Codex version pinned in `harness-versions.json` (0.164 at the time of writing). It asserts that every option above is accepted in the `exec resume` form. Until that fixture is green, the Codex resume argv counts as unverified (§11, Q34).

**OpenCode**

```
{bin-opencode} run --format json --auto -m <provider/model> [--variant <e>]
             [--session <id>]
             -f {in}/prompt.md
             "Follow the instructions in the attached file prompt.md."   # positional, last
```

- Env:
  - `OPENCODE_CONFIG={home}/opencode.json`
  - `OPENCODE_DISABLE_AUTOUPDATE=1`
  - `OPENCODE_DISABLE_CLAUDE_CODE=1`
  - `PWD={workdir}`
- Set `PWD` explicitly. OpenCode resolves its project from `PWD` before `cwd`, and a stale `PWD` gives "Session not found".
- v1 uses `opencode run`, not `opencode serve`, so all three first-class adapters share one process model. Server-mode features such as `prompt_async` and the abort endpoint are not available in v1. A server transport can be added later behind the same interface.

The experimental adapters are summarised in §4.10.

### 4.5 Result extraction and stopping

The result contract is defined in §2.6. In short:

- The in-sandbox `selfbuilding-mcp` stdio server exposes `submit_result`. Its input schema is the agent's result schema.
- It validates the input. Invalid input returns `isError` with the issues, and the model retries within the run.
- Valid input is written atomically to `{out}/result.json` by the supervisor.

**The result is read from that file, never from the event stream.** Some harnesses report tool calls only after they finish, and stream parsing differs per vendor. The file is the same for all of them.

The adapter decides how the process ends once a valid result exists:

| Strategy | Harnesses | Mechanism |
|---|---|---|
| `hook` | Claude Code | A `PostToolUse` hook matched on `mcp__selfbuilding__submit_result` prints `{"continue": false, "stopReason": "result submitted"}`. The CLI exits 0 straight after the call. Verified. |
| `kill` | Codex, OpenCode, Amp, Droid, Grok, Pi | The runtime watches for `result.json`. It waits `timeouts.postSubmitGrace` so the harness can flush its session file. It then sends SIGINT to the process group, and SIGKILL 5 s later. Codex keeps generating after a successful call (verified), so this step is required. |

**Pi** has no MCP. Its adapter ships a Selfbuilding extension (`-e {bin}/pi-submit.ts`) that registers `submit_result` and `ask_human` and forwards them to the same tool socket, so the supervisor writes the same `result.json`. The adapter runs `pi -p --mode json`, which has no RPC command channel. Pi therefore stops through the shared `kill` path once the result exists. Running Pi in `--mode rpc` is not part of v1.

**One grace setting.** `timeouts.postSubmitGrace` (default 10 s, §6.11) is the only setting for the wait between an accepted submit and SIGINT.

#### 4.5.1 Changes made after the submit

During the grace window the model can keep generating, and it can edit or commit files. The leftover auto-commit, the push and the done checks must run on the tree the accepted result describes. So the runtime records the state at the moment it accepts a submit:

1. **At acceptance.** The supervisor validates the submission. Before it replies "Accepted", it records `HEAD` and a tree hash of the working tree. The tree hash includes untracked, non-ignored files and is computed with a temporary index (`git add -A` into a scratch index, then `git write-tree`). The record is `{ headSha, treeSha, at }`, stored with the submission. A later valid submit replaces it.
2. **After the process stops.** The runtime computes the same pair again.
3. **If nothing changed,** settling proceeds as normal.
4. **If something changed,** the runtime:
   - saves the difference as an artifact, `post-submit.patch`, holding the binary diff from the submit-time tree to the current tree plus any commits made after the submit;
   - emits `post_submit_changes { files, commits, patch, tools, action }`, where `tools` lists the `tool.started` events after acceptance with `effect: 'effect'`;
   - applies `postSubmitChanges`:
     - **`'revert'` (default).** It resets `HEAD` to `headSha` and the working tree to `treeSha`, which removes files created after the submit. Settling then runs on exactly the state the result describes.
     - **`'keep'`.** It keeps the tree as it is and runs the done checks again on it before settling. A failed check follows the normal done-retry loop (§2.7).
5. **Effects outside the tree cannot be reverted.** A post-submit push or comment is not undone. It is reported through `tools`.

This check runs for every strategy, including `hook`. A Claude turn can run parallel tool calls in the same step as `submit_result`, and those can finish after the call.

Rules:

- **Use SIGINT, never SIGTERM first.** Claude Code on SIGTERM exits 143 and records no result for the turn. The session file can be truncated, which breaks the next resume.
- **No valid `result.json` when the process exits.** The runtime raises `NoResultError` and allows one resume with "You must call submit_result". §2.6.5 owns the retry budget. The adapter only supplies `resume()`.
- **Several valid submits.** The last one wins. Each submit is journaled.
- **Claude Code defers MCP tools behind tool search.** The adapter forces `submit_result` to always load if the CLI supports that. This is unverified (§11, Q31). If it is not supported, the prompt names the exact tool and one extra turn is accepted.
- **Native schema flags are not used in v1.** That covers `--json-schema`, `--output-schema` and OpenCode's `format`. They only apply at the end of the run, their strictness rules differ per vendor, and they would create a second result path (§11, Q11).

### 4.6 Prompt and skill loading

Section 2 builds the prompt for an agent call. It hands the prompt to the adapter as two files:

- `{in}/system.md` holds the Selfbuilding preamble:
  - the result contract;
  - the names of the `submit_result` and `ask_human` tools as returned by `toolName()`;
  - the AFK or HITL mode.
- `{in}/prompt.md` holds the skill body after substitution, followed by the input as JSON.

The skill body goes into the prompt directly. **Harness skill discovery is never the trigger.** Discovery is probabilistic, `claude -p` loads only the first slash-skill on a line, and several flags turn it off. The skill folder is still installed so that relative references, `scripts/` and nested skills resolve:

1. Copy the folder to `{skills}/<name>/`.
2. In `prepare()`, symlink it into each directory in `capabilities.skillDirs`, relative to `{workdir}`.

| Harness | Skill dirs linked | System text delivered by |
|---|---|---|
| Claude Code | `.claude/skills/<name>` | `--append-system-prompt-file` |
| Codex | `.agents/skills/<name>` | prepended to the prompt file (no verified flag) |
| OpenCode | `.agents/skills/<name>` (also reads `.claude/skills`) | `instructions` in `opencode.json` |
| Amp | `amp.skills.path` in the settings file | prepended to the prompt file |
| Droid | `.factory/skills/<name>` | `--append-system-prompt-file` |
| Pi | `--skill {skills}/<name>` | `--append-system-prompt <file>` |
| Grok | `.claude/skills/<name>` | `--rules` |

The links go under `{workdir}`, which is a git checkout, so they are added to `.git/info/exclude` and can never be committed.

The repo's own `CLAUDE.md` and `AGENTS.md` stay visible through each harness's project discovery. The user's home config is not visible, because `HOME` is isolated.

### 4.7 Sessions and resume

Every agent call records two things in the journal (section 7) **before** it waits on the process: the harness session id, and the exact harness version that created the session. A crash one second into the turn can still be resumed.

**Session ids.**

- **Preassigned ids** come from `uuidv5(runId + callPath + attempt)`. They are used where the harness supports them: Claude `--session-id`, Pi `--session-id`, and Grok `-s` (new conversations only). A durable host that replays a step derives the same id with no lookup.
- **Discovered ids** come from the first event:
  - Codex: `thread.started.thread_id`;
  - OpenCode: `sessionID`, which is on every event, including runs that only produce errors;
  - Amp and Droid: `session_id`.
- **Resume flags**:
  - Claude: `--resume <id>`
  - Codex: `exec resume <id>`, placed before the options (§4.4)
  - OpenCode: `--session <id>`
  - Pi: `--session <id>`
  - Grok: `-r <id>` (`-s` on an existing id is an error)
  - Droid: `-s <id>`
  - Amp: by thread id

**Resuming in a different sandbox.** The next turn can run on a new box for three reasons: fresh-per-agent placement, a sandbox that expired, or a cold HITL wait. `sessionArtifacts()` says how to move the session:

```ts
export interface SessionTransfer {
  capture: Command[];                 // run in the old sandbox; files land under {state}
  restore: Command[];                 // run in the new sandbox after install, before resume()
  files: string[];                    // paths captured, relative to {home}
}

/** Stored with every captured session. */
export interface SessionArtifact {
  harness: HarnessId | (string & {});
  harnessVersion: string;             // exact output of parseVersion() when the session was created
  sessionId: string;
  ref: ArtifactRef;                   // the captured files
}
```

| Harness | Capture | Restore |
|---|---|---|
| Claude Code | copy `{home}/.claude/projects/<encoded {workdir}>/<id>.jsonl` (and `<id>/subagents/`) | write it back to the same path |
| Codex | copy `{home}/.codex/sessions/**/rollout-*-<id>.jsonl` | write it back |
| OpenCode | `opencode export <id>` | `opencode import <file>` |
| Pi | copy the session file from the session dir | write it back |
| Amp, Droid, Grok | no `sessionArtifacts()`: server-side or not yet verified. Resume only within the same sandbox in v1. | none |

The path-encoded Claude project directory matches on every box because `{workdir}` and `{home}` are fixed constants (§4.2.1). The conformance check in §4.2.1 tests this.

Captured sessions are stored as run artifacts in the artifact store (§7.10), keyed by `runId/callPath/attempt`. They are never kept only on the box.

**A resume runs exactly the version that wrote the session.** A cold ask or an interrupted resume can happen days later, on a box built from a rebuilt image. A different CLI version reading an older session file fails in ways that are hard to diagnose. So:

1. Before a resume, the runtime installs `SessionArtifact.harnessVersion` exactly. This happens even in the same sandbox if the binary version no longer matches. A hold, `'latest'` and `'tested'` do not apply to a resume. If the session version is under a hold, the run emits a `warning` and still uses it.
2. If that version cannot be installed, the resume fails with `HarnessVersionUnavailableError { harness, version, cause }`. Possible causes: the registry cannot be reached, egress blocks it, or the version was unpublished. **The runtime never falls back to the version in the image for a resume.** The error carries the usual recovery data (branch, session id, transcript).
3. `versionCommand()` runs after the install. If its output differs from the session version, the error is the same.

Before every resume, the runtime repairs the session file. It drops a last line that does not parse, because a SIGKILL during a write leaves a truncated line that some CLIs refuse to load.

**What the adapter does not decide:** whether to resume. §3.10, §4.12 and §7.6 state that policy. The adapter only makes resume possible.

### 4.8 MCP configuration

Callers describe MCP servers once, in a neutral form. The adapter renders them into the harness's format.

```ts
export type McpServerSpec =
  | { name: string; type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; type: 'http'; url: string; headers?: Record<string, string> };
```

| Harness | Rendered into | Tool name seen by the model | Notes |
|---|---|---|---|
| Claude Code | `{home}/mcp.json` + `--mcp-config` + `--strict-mcp-config` | `mcp__<server>__<tool>` | Invalid entries are skipped silently. The adapter checks `system/init.mcp_servers` and fails the call if the `selfbuilding` server is not `connected`. |
| Codex | `-c mcp_servers.<name>.*` overrides | `<tool>` (`mcp_tool_call` names the server) | Every server gets `default_tools_approval_mode="approve"`. |
| OpenCode | `mcp` key in `{home}/opencode.json` | `<server>_<tool>` | |
| Amp | `--mcp-config '<json>'` | as Claude | Servers passed by flag need no `amp mcp approve`. |
| Droid | `.factory/mcp.json` in `{home}` | to verify | |
| Grok | `[mcp]` in `{home}/.grok/config.toml` | to verify | |
| Pi | none native | extension tools | `mcp: 'bridge'`: only Selfbuilding's own tools (`submit_result`, `ask_human`, `notify_human`) are available. A request for any other MCP server on Pi is rejected before the sandbox starts. |

Secrets in `env` and `headers` are written into config files with mode 0600 under `{home}`. They never go into argv. The `selfbuilding` server is always present and always first. Users cannot override or shadow it.

### 4.9 Authentication: API keys and subscription OAuth

**API keys are the default, and the only path Selfbuilding documents as production-ready.** They are scoped, can be spend-capped, need no refresh and are safe to use in parallel.

Subscription OAuth works through a CLI's own login token. It is supported, opt-in and labelled. It costs less for an individual developer, but it brings three problems:

1. **Terms of service.** At least one vendor restricts third-party products from offering subscription login. Selfbuilding does not advertise "bring your plan" until that has been checked (§11, Q2). The mechanism exists so that a user can choose it for their own account.
2. **A rotating refresh token can have only one holder.** If two sandboxes refresh the same chain, the vendor revokes the old refresh token, and the slower box loses its credential partway through a run.
   - The section 9 credential broker owns the refresh.
   - Where the harness accepts it, a sandbox gets an access token with an empty refresh token.
   - Where a harness needs a full refreshable file (Codex `auth.json`), the broker leases the file to one sandbox at a time and writes the refreshed file back when the lease ends. In that mode, each credential can serve only one sandbox at a time (§11, Q3).
3. **A status command can lie.** A login check can exit 0 on a token that expired days ago. Adapters check expiry from the token itself, for example the JWT `exp`, never from `login status`.

The harness factory option is `credentials`: one `HarnessCredential` or an array (a pool).

```ts
export type HarnessCredential =
  | { kind: 'api-key'; value: Secret }                 // Secret resolves on the orchestrator (§9.2)
  | { kind: 'oauth-token'; value: Secret }             // long-lived subscription token
  | { kind: 'auth-file'; value: Secret; leased: true } // refreshable credential file
  | { kind: 'provider-keys'; values: Record<string, Secret> }; // OpenCode/Pi: per-provider keys
```

| Harness | API key | Subscription |
|---|---|---|
| Claude Code | `ANTHROPIC_API_KEY` (also Bedrock/Vertex env) | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` |
| Codex | `CODEX_API_KEY` | `auth.json` in `CODEX_HOME`, leased |
| OpenCode | provider env keys (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, ...) | `auth.json` from `opencode auth login`, leased |
| Amp | `AMP_API_KEY` (`sgamp_` access token; the short-lived login session is rejected) | none |
| Droid | `FACTORY_API_KEY` | none |
| Pi | provider env keys | per provider, to verify |
| Grok | `XAI_API_KEY` (name to verify) | `grok login --device-auth`, to verify |

Rules:

- **Never set both modes.** An API key in the environment overrides an OAuth credential without any warning. `auth()` strips the variables that belong to the mode not in use:
  - for Claude Code: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` versus `CLAUDE_CODE_OAUTH_TOKEN`;
  - for Codex: `OPENAI_API_KEY` and `CODEX_API_KEY` versus `auth.json`.
- **Credentials go only to the harness process.** They are delivered as 0600 files and set as env only on the harness child (§9.2). They are not set in the env of hooks, `sandbox.exec()` or done checks. The agent can still read its own environment through Bash. Section 9 accepts and states that risk, and it is why keys should be scoped and spend-capped.
- **Credential pools.** `credentials: HarnessCredential[]` pins one credential per run, so prompt caches stay warm.
  - The pool moves to the next credential **only** on a `quota` or `auth` failure from `classify()`.
  - **Failover resumes the session. It never restarts it.** The next credential runs `resume()` on the same session id, with the nudge from §4.12. A fresh session on the new credential is allowed only if the failed turn had no effects (§4.12).
  - A bare 403 or `permission_error` is not an account failure, because tools produce those too.
  - Each adapter's matcher is fixture-tested on both sides. A matcher that is too broad moves the session from account to account for errors that are not account errors. A matcher that is too narrow stops on a dead account while other accounts still have capacity.
- **A dead secondary credential must not fail a primary run.** An example is a reviewer harness used as a tool. If its credential fails, that harness is marked unavailable for the run and a `warning` is emitted. The run fails only if the user explicitly required that harness.

### 4.10 Per-adapter reference

The first-class adapters block releases. Each is covered by the live harness × sandbox matrix in §10.3, on Docker and Impello at minimum.

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Binary | `/usr/local/bin/claude` (image) | `/usr/local/bin/codex`, npm `@openai/codex` | `/usr/local/bin/opencode`, npm `opencode-ai` (to verify) |
| Prompt via | stdin | stdin | file attachment + short argv |
| Stream | `--output-format stream-json --verbose` | `--json` | `--format json` |
| Session id | preassigned `--session-id` | `thread.started` | any event's `sessionID` |
| Resume / fork | `--resume` / `--fork-session` | `exec resume <id>` / `exec fork <id>` (subcommand first) | `--session` / `--fork` |
| Cross-sandbox transfer | yes | yes | yes (`export` / `import`) |
| Stop after submit | hook | kill | kill |
| Native budget cap | `--max-budget-usd` | none | none |
| Effort | `--effort` | `-c model_reasoning_effort` | `--variant` |
| Usage | USD + tokens | tokens | tokens + cost per step |
| Config isolation | `CLAUDE_CONFIG_DIR` | `CODEX_HOME`, `--ignore-user-config` | `OPENCODE_CONFIG`, `OPENCODE_DISABLE_CLAUDE_CODE` |
| Known traps | SIGTERM loses the result; MCP tools deferred | hangs on open stdin; keeps going after submit; `-o` not written on failure; nested JSON errors; `resume` must come before the options | exit 0 on failure; the answer is the last step's text, not all text; `PWD` must be set |

The experimental adapters ship and are fixture-tested. They get a nightly live run that does not block releases:

| | Amp | Droid | Pi | Grok |
|---|---|---|---|---|
| Headless | `amp -x --stream-json` | `droid exec -o stream-json` | `pi -p --mode json` | `grok -p --output-format streaming-json --no-leader` |
| Prompt via | stdin (`--stream-json-input`) | stdin / `-f` | file-ref | `--prompt-file` |
| Session id | `system/init.session_id` | `session_id` | header line, or preassigned `--session-id` | preassigned `-s` |
| Resume | thread id (CLI flag to verify) | `-s <id>` | `--session <id>` | `-r <id>` |
| Cross-sandbox transfer | no (v1) | no (v1) | yes | no (v1) |
| Terminal event | `result` | `result` | `agent_settled` (not `agent_end`) | `end` |
| MCP | native | native | bridge (extension) | native |
| Permissions bypass | to verify | `--skip-permissions-unsafe` | none (no sandboxing) | `--always-approve` |
| Stop after submit | kill | kill | kill (once the result exists) | kill |
| Notes | stream is Claude-shaped; reuses the Claude parser | glibc only; exit 0 means finished, not succeeded | strict LF framing; no RPC channel in `--mode json` | stream shape changed between versions; parser pinned to recorded fixtures |

`stability: 'experimental'` adapters print a warning once. Promotion to `stable` needs the bar in §1.10 and §10.3, including:

1. recorded fixtures for success, failure, tool error and resume;
2. a green live cell on two sandbox providers;
3. a parse-contract probe in the version job (§4.11).

### 4.11 Version policy

Agent CLIs ship several times a week, and one stream-format change breaks every run until someone reacts. Selfbuilding is a library, and a library should be reproducible by default.

```ts
/** The one version-policy type, set as the `version` option of a harness value. */
export type VersionSpec =
  | 'tested'      // default: the version in this release's harness-versions.json
  | 'latest'      // resolved from the registry when the agent call starts
  | string;       // an exact version
```

The rollback lever is the config key `harnessHold: Partial<Record<HarnessId, string>>` (§1.11), for example `{ codex: '<last-good-version>' }`. Changes take effect with no rebuild or redeploy.

**Which version an agent call runs**, highest priority first:

| Situation | Version |
|---|---|
| Resuming an existing session | `SessionArtifact.harnessVersion`, exactly (§4.7). Nothing else applies. |
| Fresh session, `version` is an exact string | That string |
| Fresh session, a `harnessHold` entry exists | The held version |
| Fresh session, `'latest'` | Resolved from the registry once, before `install()` |
| Fresh session, `'tested'` | From `harness-versions.json` |

The host resolves the policy to an exact version before the call starts and journals it. The runtime spec (§6.4) carries only that exact string, never a policy. A replay on a durable host reuses the journaled resolution, so one agent call never sees two versions.

Rules:

1. **The default is `'tested'`.** Each Selfbuilding release ships a `harness-versions.json` that pins the exact version of each harness that passed the release matrix. Users upgrade Selfbuilding, not the CLI underneath it. Docs and examples never hard-code a version. They refer to this file.
2. **Official images bake in the `'tested'` versions** where the CLI's license allows it (§10.7). Images are built from `harness-versions.json` (§5.6). The default path therefore needs no install and no registry egress for those harnesses.
3. **What happens when an install fails:**
   - **`'latest'`, fresh session:** the call continues on the version already in the image and emits a `warning`. A failed upgrade never fails a fresh run. The version that actually ran becomes the session's recorded version.
   - **Exact pin, hold or `'tested'`, fresh session:** the call fails with `HarnessVersionUnavailableError` before the harness starts. The retry before the harness starts (§3.4) applies when the cause is a network error.
   - **Resume:** the call fails with `HarnessVersionUnavailableError`, and there is never a fallback (§4.7).
4. **Egress for installs.** If the planned version is not in the image, the runtime needs the harness's install hosts (`installHosts()`, for example the npm registry).
   - `presets.agent` for a harness (§9.5) always includes `installHosts()`.
   - If the effective egress policy blocks those hosts and an install is needed, the call fails at plan time with `HarnessVersionUnavailableError { cause: 'egress' }`. It does not boot a box that cannot install.
   - For locked-down production, bake the pins into a custom image instead of opening egress.
5. **Hold.** The config `harnessHold` overrides `'tested'` and `'latest'` for fresh sessions. It is the rollback lever when a release breaks.
6. **Always record the actual version.** `versionCommand()` runs at the start of every agent call, and the result goes into the journal, the transcript, the `harness.version` event and the `SessionArtifact`. Images and sandbox templates can change underneath a pin when they are rebuilt.
7. **Turn off self-update** inside the sandbox (`DISABLE_AUTOUPDATER=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `AMP_SKIP_UPDATE_CHECK=1`, and so on). Two agent calls in one run must not update the binary under each other.
8. **Install hygiene.**
   - Install with an empty npmrc and an explicit `--prefix`, and run postinstall scripts explicitly. Inherited `ignore-scripts` or `min-release-age` settings cause broken installs or misleading "no matching version" errors.
   - Call binaries by absolute path, because user-local install dirs are often missing from `PATH` in non-login shells.
9. **Feature detection over version comparison.** Where a harness reports its capabilities (Claude `system/init`), adapters check those instead of comparing version strings.
10. **The parse-contract probe.** A nightly job (§10.3) runs each harness's newest release on its cheapest model against recorded expectations:
    - the event types it must emit;
    - the result fields;
    - every flag the adapter passes, in both the fresh and resume argv forms;
    - resume round-tripping the session id;
    - resume after cross-sandbox transfer;
    - the effective MCP tool timeout (§8.4).

    The job turns green or red per version and publishes the compatibility table. A new `'tested'` pin is proposed only from green versions, and only once the release is at least 3 days old. A version outside the tested set emits `harness.untested_version` at warn level (§9.9).

### 4.12 Failure classification and retries

Only `classify()` reads vendor error text. Everything above it switches on `HarnessFailure.code`.

| Code | Examples | Retryable | Who acts |
|---|---|---|---|
| `auth` | 401, revoked or expired OAuth, org disabled | no (on this credential) | credential pool failover (below), then fail |
| `quota` | usage limit with a reset time | no (on this credential) | credential pool failover (below), then fail |
| `rate_limit` | 429, overloaded | yes | the harness retries internally first, then the rules below |
| `billing` | out of credit | no | fail, naming the credential |
| `invalid_request` | bad model id, schema rejected | no | fail |
| `context_overflow` | prompt too long | no | fail; section 2 decides whether to trim |
| `provider` | 5xx | yes | the rules below |
| `harness_crash` | non-zero exit with no stream error, missing binary, MCP server failed to connect | no | fail, with the stderr tail attached |
| `unknown` | anything else | no | fail, with the raw message |

A failure that ends a call surfaces as `HarnessStartError` (code `harness_start`) when it happens before the first model turn, and as `HarnessStreamError` (code `harness_error`, carrying the `HarnessFailure`) otherwise (§9.8).

#### 4.12.1 Retries depend on whether the turn had effects

Rate limits, provider errors and auth or quota failures often arrive partway through a turn. By then the agent may already have pushed, commented on a PR or posted with `notify_human`. A retry from a blank session would repeat all of that. So the retry form depends on what the failed turn did.

A turn **had effects** if, before the failure, the runtime saw any of these:

- a `tool.started` with `effect: 'effect'` (§4.3);
- a `file.changed` event;
- a change to `HEAD` or the working tree compared with the start of the turn.

| Failure | Turn had no effects | Turn had effects |
|---|---|---|
| `rate_limit`, `provider` | **Fresh retry.** The durable step retries the call as a new attempt, with a new preassigned session id, after a full-jitter backoff that honours `retryAfterMs`. This is the same class of retry as the retry before the harness starts (§3.4), because nothing happened. | **Resume.** Inside the same attempt, the runtime waits out the backoff and calls `resume()` on the same session id with the nudge below. Each resume counts against `maxResumes`. |
| `auth`, `quota` with another credential in the pool | Fresh retry on the next credential | Resume the same session on the next credential, with the nudge. Counts against `maxResumes`. |
| Any of the above, and resume is impossible | — | **Fail** with `HarnessStreamError` and the full recovery data (branch, commits, session id, transcript). Resume is impossible when the adapter has no `resume()`, the session file cannot be repaired, the session version cannot be installed (§4.7), or `maxResumes` is used up. **Never** fall back to a fresh session. |

The resume nudge is fixed text:

> Your previous turn stopped because of a model API error (`<code>`). Your work so far is in this session and in the working tree. Check `git status`, `git log` and any external actions you already took before you continue. Do not repeat actions that already took effect. Continue the task and call submit_result when done.

How this fits with the rest of the spec:

- The rule in §3.4 stands: a turn that started and did work is never re-run unless the caller set `retries`. A resume with the nudge is not a re-run. The work so far stays in the session, and the model is told to check before it repeats anything.
- The `retries` option (§3.4) is the caller's explicit opt-in to a full re-run. On a shared handle it restores the pre-call checkpoint first. Nothing in this section uses it on the caller's behalf.
- The `retry` event (§4.3) records retries the vendor made inside the harness. Those happen before any of the rules above apply.

**Required test** (§10.3, L1 scripted harness). Each case asserts on the bare remote's reflog, the emulator's comment count and the journal:

1. **A rate limit after a push.** The script runs `git push` to the bare remote, then emits a `rate_limit` error. The test asserts that:
   - no new session id was created;
   - `resume()` was called once with the original session id and the nudge;
   - the remote received exactly one push;
   - `attempts.resumes` is 1.
2. **A rate limit before any tool call.** The test asserts that attempt 2 starts a fresh session.
3. **Quota after a `gh pr comment`.** With two credentials, the test asserts that the second credential resumes the same session and that the emulated PR has one comment.
4. **A rate limit after a push on a harness with no `resume()`.** The test asserts that the call fails with recovery data and no fresh attempt starts.

(The scripted harness's `git push` goes to a local bare remote with a test credential; in production the agent holds only a read token, §9.2.)

### 4.13 Adding an adapter

A third-party harness implements `Harness` and passes `describeHarness()` from `@selfbuilding/testing` (§10.3). The bar for a built-in adapter:

- a non-interactive mode with line-delimited JSON output;
- a way to deliver a long prompt without argv (stdin or a file flag);
- a model flag, and auth through env or a file;
- a session id that round-trips into an explicit resume flag;
- session state that is file-backed or can be exported;
- a way to load an MCP server, or an equivalent tool extension, for `submit_result`;
- tool events that name each tool, so that `effect` can be classified (§4.3);
- a permission-bypass mode, or no permission system at all;
- a Linux binary that runs as a non-root user.

Requests for harnesses that fail the bar are declined. The decision is recorded once in `docs/out-of-scope/`, so the question does not come back.

### 4.14 Open questions

Moved to §11 (Q2, Q3, Q31 to Q35).

## 5. Sandbox providers

A sandbox provider gives Selfbuilding an isolated Linux machine. On that machine Selfbuilding can run commands, move files, keep a process going after the orchestrator dies, and pause, resume, snapshot or fork the machine. This section covers:

- the provider contract, its labels, its invariants and its error taxonomy;
- the six v1 adapters and where each one falls short;
- harness images, per-repo images, snapshots, quiescence and warm starts;
- how a finished result survives when the orchestrator is down;
- the reaper;
- the `.selfbuilding/` lifecycle hooks.

Other sections own the rest:

- Where sandboxes are placed (fresh, shared handle, fork) and the concurrency cap: section 3.
- What runs inside the sandbox, including workspace sync, the detached runtime and outcome acknowledgement: section 6.
- Where sandbox refs are stored across host steps: section 7.
- Cold waits for humans: section 8.
- Credentials, the pre-snapshot secret scan and egress policy: section 9.
- The conformance suite: section 10.

### 5.1 Design rules

1. **The contract describes behaviour, not structure.** The core never checks which provider it is talking to. If a backend lacks something the contract requires, the adapter builds it internally, and the workaround stays inside the adapter. For example, Cloudflare has no detached exec, Daytona has no TTL extension, and Vercel runs no stdin unless the command is detached.
2. **The core branches on only two things.** One is whether an *optional* operation exists (`snapshot`, `fork`, `previewUrl`). The other is the `limits` record. That record holds numbers plus two facts about lifetime: whether it is guaranteed, and what an expiry keeps. No other capability booleans are scattered through the core. Every extra flag turns into an `if (provider === X)` somewhere, and those checks drift apart over time.
3. **Refs are plain JSON.** A `SandboxRef` or `ProcessRef` has to cross a Trigger.dev, Inngest or Workflows step boundary. It then has to be reopened by id in a different process, sometimes days later.
4. **Each adapter is a factory value on its own subpath export.** Users import it statically, for example `import { impello } from "@selfbuilding/sandbox-impello"`. There is no environment-variable selector and no dynamic `import()`. A selector is a stale-config trap, and bundlers can drop dynamically imported modules.
5. **Errors are classified once, at the adapter boundary.** Code above the adapter never reads an error message string.
6. **A deployment only touches its own sandboxes.** Several deployments often share one provider account: dev, prod, CI and a teammate's laptop. Every lookup, listing and reap is scoped to one deployment id.

### 5.2 The contract

```ts
// @selfbuilding/core: sandbox contract

/** Identity of a sandbox. Computed by the core, never by adapters. */
export interface SandboxKey {
  runId: string;
  scope: string; // agent call path ("root/2/review"), shared-handle name, or fork child ("box#0/fork[1]")
}
// sandboxName(key) = "ns-" + base32(sha256(`${runId}:${scope}`)).slice(0, 20)
// It lives in one core function. Adapters receive the name and never derive their own.

/** Which deployment owns a sandbox. Set once in config. */
export type DeploymentId = string; // ^[a-z0-9-]{1,32}$, e.g. "prod", "staging", "ci-12345", "local-rays-mbp"

export type SandboxState = "starting" | "running" | "paused" | "stopped" | "error" | "unknown";

export interface SandboxRef {
  provider: string;     // adapter id, e.g. "impello"
  id: string;           // vendor id
  name: string;         // sandboxName(key)
  key: SandboxKey;
  deployment: DeploymentId;
  state: SandboxState;  // "is the VM up", never "is a turn running"
  createdAt: string;    // ISO
  labels: Record<string, string>; // as read back from the vendor (see the label table)
  meta?: Record<string, string>;  // adapter-private, e.g. region, DO name
}

export interface SandboxSpec {
  image: ResolvedImage;                     // see 5.6
  env: Record<string, string>;              // non-secret only (invariant 18, section 9)
  lifetimeMs: number;                       // initial lifetime; extended by the host (section 6)
  onExpire: "pause" | "kill";               // no adapter default; the core passes "pause" for every placement (5.8)
  resources?: { vcpu: number; memoryMiB: number; diskGiB?: number };
  ports?: number[];                         // must be declared up front (Vercel, Modal)
  network?: NetworkPolicy;                  // full policy, never a patch (section 9)
  labels: Record<string, string>;           // set by the core; see the label table
}

export interface ProviderLimits {
  maxLifetimeMs: number;      // the plan's longest session; extendLifetime clamps to it
  maxConcurrent?: number;     // seeds the default for the shared cap (section 3)
  createsPerMinute?: number;  // feeds the create rate limiter
  lifetimeGuaranteed: boolean;                       // false: the box can vanish before its lifetime ends (Cloudflare)
  expireKeeps: "memory" | "filesystem" | "nothing";  // what onExpire "pause" actually keeps on this provider
}

export interface SandboxProvider {
  readonly id: string;
  readonly limits: ProviderLimits;

  /** Primary verb. Atomic where the vendor allows it. */
  openOrCreate(key: SandboxKey, spec: SandboxSpec, o?: { signal?: AbortSignal }):
    Promise<{ handle: SandboxHandle; created: boolean; rebuilt: boolean }>;
  /** Pure lookup, scoped to the configured deployment. Never wakes anything. */
  find(key: SandboxKey): Promise<SandboxRef | null>;
  /** Every sandbox of one deployment, including paused ones. Used by the reaper. `deployment` is required. */
  list(filter: { deployment: DeploymentId; runId?: string; states?: SandboxState[] }): AsyncIterable<SandboxRef>;
  /** Always returns a running box with a guest that answers. */
  open(ref: SandboxRef, o: { lifetimeMs: number; signal?: AbortSignal }): Promise<SandboxHandle>;
  /** By ref, never through a connected handle. Refusal is an outcome, not a throw. */
  pause(ref: SandboxRef): Promise<PauseOutcome>;
  /** Idempotent. */
  kill(ref: SandboxRef): Promise<{ path: "killed" | "already-gone" }>;

  // Optional. The core checks for the method, not a flag.
  // The core calls both only on a quiesced box (5.8). Adapters never call them on their own.
  snapshot?(ref: SandboxRef, o?: { name?: string }): Promise<SnapshotResult>;
  fork?(ref: SandboxRef, o: {
    children: { name: string; labels: Record<string, string> }[];   // identities computed by the core
    lifetimeMs: number;
  }): Promise<Array<SandboxHandle | SandboxError>>; // per-item errors, never one throw
}

export interface SandboxHandle {
  readonly ref: SandboxRef;
  exec(cmd: string, o?: ExecOpts): Promise<ExecResult>;
  /** Starts a process that outlives this client and the orchestrator. Never retried. */
  spawn(cmd: string, o?: SpawnOpts): Promise<ProcessRef>;
  /** Reattaches by ref, from any process, and resumes the log at an offset. */
  attach(p: ProcessRef, o: { fromOffset: number; onLine?: OnLine; signal?: AbortSignal }):
    Promise<{ state: "running" | "exited"; exitCode?: number; offset: number }>;
  readFile(path: string): Promise<Uint8Array>;                 // SandboxFileNotFoundError if absent
  writeFiles(files: { path: string; data: Uint8Array | string; mode?: number;
                      owner?: "agent" | "root" }[]): Promise<void>;
  /** Absolute target. The adapter converts it to its vendor's verb and clamps to limits. */
  extendLifetime(untilMs: number): Promise<{ untilMs: number; clamped: boolean }>;
  previewUrl?(port: number): Promise<{ url: string; headers: Record<string, string> }>;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;    // non-secret only; secrets arrive as files (invariant 18)
  user?: "agent" | "root";         // default "agent"; HOME is always set explicitly
  stdin?: string | Uint8Array;     // piped, then closed
  timeoutMs?: number;              // default 120_000; never the vendor's default
  onLine?: OnLine;                 // line-by-line, unbuffered
  idempotent?: boolean;            // allows retry on transient guest errors
  maxTailBytes?: number;           // default 65_536 per stream
}
export type OnLine = (stream: "stdout" | "stderr", line: string) => void;
export interface ExecResult { exitCode: number; stdoutTail: string; stderrTail: string; truncated: boolean }

export interface SpawnOpts { cwd?: string; env?: Record<string, string>; user?: "agent" | "root"; stdinFile?: string }
export interface ProcessRef {
  id: string; pgid?: number; vendorPid?: string;
  logPath: string;   // /selfbuilding/state/proc/<id>.log
  exitPath: string;  // /selfbuilding/state/proc/<id>.exit
  startedAt: string;
}

export type PauseOutcome =
  | { confirmed: true; kept: "memory" | "filesystem" }
  | { confirmed: false; reason: "refused" | "gone"; status?: number; message: string };

export interface SnapshotResult {
  snapshotId: string;
  fidelity: "memory" | "filesystem";             // what the provider captured; never live agent processes (5.8)
  sourceState: "running" | "paused" | "stopped"; // the source's state after the snapshot
  expiresAt?: string;
}
```

The contract has 12 required operations. Six are on the provider: `openOrCreate`, `find`, `list`, `open`, `pause` and `kill`. Six are on the handle: `exec`, `spawn`, `attach`, `readFile`, `writeFiles` and `extendLifetime`. Three are optional: `snapshot`, `fork` and `previewUrl`.

The contract has no "copy directory in" or "sync workspace" operation. Workspaces move through git and `writeFiles` (section 6), so this works the same on every adapter.

To stop a spawned process, the core uses `exec`: it sends `kill -INT "-$pgid"`, waits a 2 s grace period, then sends `-KILL`. No adapter needs a vendor-specific kill verb.

**Labels.** Each concept has exactly one label name. The core sets these labels, and adapters store them as metadata, labels or tags, or in the registry where the vendor has none.

| Label | Value | Set on | Used by |
|---|---|---|---|
| `selfbuilding.deployment` | `DeploymentId` | every box | `find`, `list` and the reaper all filter on it |
| `selfbuilding.run` | `runId` | every box | cancellation by run, journal join |
| `selfbuilding.name` | `sandboxName(key)` | every box | `find(key)`. This is the per-call lookup label that sections 6 and 7 rely on |
| `selfbuilding.step` | `stepKey` (§3.2) | every box created for an agent call | joins a box to its journal step and its outcome record (§6.8) |
| `selfbuilding.launch` | `LaunchId` (§7.2) | every box created for an agent call | joins a box to the host launch that created it; the reaper's disposition table (5.9) keys on it |
| `selfbuilding.hostRun` | host run id (Trigger run, Inngest run, Workflow instance) | every box on a hosted deployment | orphan detection (5.9) |
| `selfbuilding.parent` | parent vendor id | fork children | Daytona parent-before-child kill |
| `selfbuilding.expiresAt` | ISO time | Docker, Daytona | reaper-enforced lifetime |

No other label names are used. `selfbuilding.managed`, `selfbuilding.call`, `selfbuilding.nonce` and `selfbuilding.ci` do not exist. The deployment id comes from `defineConfig({ deployment })`. Every hosted host adapter requires it and throws `ConfigError` at factory build if it is missing. On plain Node the default is `local-<hostname>`. CI uses `selfbuilding.deployment=ci-<GITHUB_RUN_ID>`; there is no separate CI label. Two deployments must never share an id. That is the one rule that lets several of them use one provider account safely.

### 5.3 Error taxonomy

Adapters reject only with the classes below. All of them carry `provider`, `sandboxId?` and `cause`.

| Class | Meaning | Core reaction |
|---|---|---|
| `SandboxUnavailableError` | An outage, 5xx, network error, or unknown outcome | Retry within the operation deadline. Never treat it as absence. |
| `SandboxGuestGoneError` (extends `SandboxUnavailableError`) | The control plane answered, but the guest stayed silent for the whole open deadline | `openOrCreate` rebuilds. Every other caller treats it as an outage. |
| `SandboxNotFoundError` | A positive 404, meaning confirmed absence | Safe to rebuild or forget. |
| `SandboxFileNotFoundError { path }` | The box is fine but the file is missing | The caller decides. This is a separate class because "box gone" and "file missing" need opposite handling. |
| `SandboxCommandTimeoutError { mayStillBeRunning, cmd }` | `exec` exceeded `timeoutMs` | Retry only if `idempotent` and `!mayStillBeRunning`. |
| `SandboxQuotaError { retryAfterMs? }` | 429, starts-per-minute cap, concurrency cap | Back off and keep the cap slot (section 3). |
| `SandboxAuthError` | 401/402/403: credentials or billing, affecting the whole fleet | Fail the run loudly and never retry. Every sandbox on this provider is affected. |
| `SandboxWedgedError` | The vendor says paused, but the VM is still running | Deterministic, so never retry. Surface it to a human and offer `kill`. |
| `SandboxUnsupportedError { op }` | The backend refused an optional operation (for example, an E2B-compatible host without fork) | Treat it as if the method were absent, and fall back to git or a typed result (section 3). |

The core raises one more class itself. Adapters never raise it:

| Class | Meaning | Core reaction |
|---|---|---|
| `SandboxNotQuiescentError { reason, detail }` | A snapshot or fork was asked for on a box that is not at a clean boundary (5.8). `reason` is one of `"busy"`, `"unknown"`, `"unacked-outcome"`, `"process-survived"` or `"git-index-lock"`. | No provider call is made. `busy` and `unknown` are retryable after the current turn ends. The other reasons need the caller to act. |

A non-zero exit from `exec` is **not** an error. It is reported as `ExecResult.exitCode`. If an adapter's SDK throws on a non-zero exit, as E2B and Impello do with `CommandExitError`, the adapter catches it and returns a result.

### 5.4 Invariants

The conformance suite (section 10) checks every invariant. An adapter that cannot meet one is not built in.

| # | Invariant | Failure it prevents |
|---|---|---|
| 1 | **`find` and `list` never wake a sandbox.** They use the vendor's list or metadata API, never `connect`. Pause goes by id, never through a connected handle. The reaper never probes a paused box (5.9). | On E2B-style backends, `connect` resumes a paused box. Stop, park-on-failure and the reaper all call `find` first, so a lookup that wakes the box would undo each of them. |
| 2 | **An outage is not "not found".** `find` returns `null` only for a confirmed miss. Outages throw `SandboxUnavailableError`. `list` throws instead of yielding nothing. | A transient 5xx read as "no sandbox" makes the core create a duplicate or drop a run's state. A reaper that reads an unreachable API as "nothing running" reports a clean sweep. |
| 3 | **`open` returns a running box whose guest answers.** After resume, the adapter runs a no-op `true` with retries until it succeeds or the deadline passes. | A resume can report success in 10 ms while the in-guest agent answers nothing for seconds. The first real command then fails and wastes an agent turn. |
| 4 | **`pause` confirms or returns a typed refusal.** It polls until the state is terminal. 409 (already paused) counts as `confirmed`. 404 is `gone`. 401/402/403/429 are rethrown as fleet errors. Any other 4xx returns `{ confirmed: false, reason: "refused" }`. The core, not the adapter, logs each refusal at error level. | One plan-limit 400 thrown from pause was logged and ignored by every caller. Most of a fleet then stayed running for hours, filled the concurrency cap and blocked new creates. |
| 5 | **Only positive evidence authorises destruction.** Timeouts, 5xx, 409 and network errors mean UNKNOWN, and UNKNOWN never kills. A user's explicit `kill(ref)` is a separate path. | During a slow pause, some backends answer 404 for a box that is still alive. Reaping on that 404 turns a slow pause into data loss. |
| 6 | **Ghost refs converge.** If `open` gets `SandboxNotFoundError` or `SandboxGuestGoneError` for a ref that `find` returned, `openOrCreate` checks every ref for that key in rank order. It tries first with a short budget (20 s each), then with the full deadline. It creates a new box only when all of them are ghosts, and then returns `rebuilt: true`. | A listing row can outlive its VM. Without convergence, the run is stuck forever. If the dead row is preferred, every later step rebuilds. |
| 7 | **`openOrCreate` is idempotent per key.** It is atomic where the vendor supports a unique name. Otherwise, after creating, the adapter lists by key, keeps the **oldest** box and leaves the extra one alone for the reaper to collect later. | Two near-simultaneous step retries both create a box, and later lookups flip between them. |
| 8 | **A create whose response was lost is unknown, not failed.** The adapter tags the box with its labels *before* or *at* create time. On a lost response, it resolves the box through `find(key)` before creating again. | A timeout on create leads to a second create, and the first box leaks until its TTL runs out. |
| 9 | **If setup fails after create, the box is killed.** Anything that throws between "vendor returned an id" and "handle returned" kills the box in a `finally` before rethrowing. | The box keeps running and billing until the platform timeout. |
| 10 | **`exec` streams line by line and keeps only a bounded tail.** `onLine` fires once per line, split on `\n` only, with nothing buffered. The tails are capped at `maxTailBytes`. | Buffering breaks live progress and idle detection. Joining a full long stream crashes V8 with `Invalid string length`. |
| 11 | **Input goes through stdin or files, never by interpolating into argv.** `stdin` is piped and then closed. Prompts and user text are written with `writeFiles`. | Linux limits a single argument to about 128 KB, and user-editable text can carry `$(...)`. |
| 12 | **`spawn` survives the orchestrator, and `attach` works from any process.** Where the vendor has no reattach, the adapter uses one shim: `setsid nohup sh -c '<cmd>; echo $? > <exit>' > <log> 2>&1 &`. It reads the log by byte offset and polls the exit file. `spawn` is never retried. | A durable step replayed after a crash must reattach to the running harness. Starting it again doubles side effects, and a retried detached start can launch the process twice. |
| 13 | **Every operation has one deadline.** Retries use full-jitter backoff `rand × min(8 s, 1 s × 2^n)` within that deadline. Multiplying a per-attempt timeout by an attempt count is forbidden. | A 240 s request timeout with 3 attempts adds up to about 12 minutes against a 300 s budget. |
| 14 | **The adapter sets every vendor default that would kill an agent.** That covers command timeout, create lifetime, fork lifetime, auto-stop and expiry behaviour. | Vendor defaults include E2B `commands.run` at 60 s, E2B fork at 15 s, 5-minute create lifetimes, `onTimeout: "kill"`, and Daytona's 15-minute auto-stop when there is no API activity. Each one silently kills a long agent run or its result. |
| 15 | **`extendLifetime` takes an absolute target and returns the clamped value.** The heartbeat in section 6 calls it at the start of every agent step and every 5 minutes. | Vendors disagree on what extension means. E2B resets the deadline to now plus ms, which can shorten it. Vercel adds time. Daytona counts activity. Mixing these up shortens a live run. |
| 16 | **`state` is normalised.** Unknown vendor states map to `"unknown"`, never a throw. `state` never claims to know whether a turn is running. | Some backends report `idle` while a detached process is working. Any decision that freezes or kills a box must ask the in-box turn lock (section 6), not `state`. |
| 17 | **After `snapshot` or `fork`, the core treats every existing stream and handle as stale and reopens them.** `SnapshotResult.sourceState` reports what happened to the source. | E2B snapshots drop every command stream. Vercel `snapshot()` stops the sandbox. Modal's memory snapshot terminates it. |
| 18 | **No secret goes in `SandboxSpec.env` or `ExecOpts.env`.** Secrets reach the box only as 0600 files written with `writeFiles`, and they are delivered again after every `open`. This holds on every provider, and it is enforced on E2B and Impello, where "create-time env" is not an acceptable substitute either. | E2B-family envd logs per-command env values to logs the whole team can see. On those backends, create-time env also does not survive `connect`. |
| 19 | **`snapshot` and `fork` run only on a quiesced box (5.8).** The core holds the box's mutation lock, sees the turn lock `FREE`, has acked every outcome and killed every agent process, has run `sync`, and finds no `.git/index.lock`. Every fork child gets a new identity. | A memory fork clones the supervisor, the heartbeat, `tools.sock`, `call.lock`, background servers that hold model keys, and callbacks still due with the same `(callId, attempt)`. Fencing cannot tell the copies apart. A filesystem snapshot taken mid-write can capture a torn git index or SQLite file. |
| 20 | **`list` and `find` are scoped to one deployment.** Adapters filter by `selfbuilding.deployment` in the vendor query where possible, and in memory otherwise. They never return another deployment's boxes. | Dev, prod, CI and a laptop that share one account each see the others' boxes as orphans with no journal row, and kill them. |
| 21 | **A disposable box is not destroyed before its outcome is acknowledged.** Expiry pauses it where the provider can. Where it cannot, the outcome is escrowed off-box first (5.8). | The disk of a finished turn is the only copy of its result. If the orchestrator is down past the lifetime margin, `onTimeout: "kill"` deletes a result that succeeded. |

### 5.5 v1 adapters

| | Docker (local) | Impello / E2B | Daytona | Vercel Sandbox | Modal | Cloudflare Sandbox |
|---|---|---|---|---|---|---|
| Package / SDK | `@selfbuilding/sandbox-docker` / `dockerode` | `@selfbuilding/sandbox-e2b` (one adapter, two clients) / `@impello/sdk`, `e2b` | `@selfbuilding/sandbox-daytona` / `@daytonaio/sdk` | `@selfbuilding/sandbox-vercel` / `@vercel/sandbox` ≥ 3 | `@selfbuilding/sandbox-modal` / `modal` | `@selfbuilding/sandbox-cloudflare` + facade Worker / `@cloudflare/sandbox` 1.0 |
| `find` / `list` | Label filter | `list({query:{metadata}})`, includes paused | `list({labels})` | `name` lookup; one-tag filter on `selfbuilding.deployment` | `list({tags})`; `fromName` finds running only | Emulated: index in the facade's DO storage |
| `pause` keeps | Memory (freezer), lost on daemon restart | Memory | Memory on VM sandboxes, filesystem (stop) on container sandboxes | Filesystem (`stop` on a persistent sandbox) | Nothing native. Emulated as filesystem snapshot + terminate | Filesystem (snapshot + destroy) |
| `snapshot` | `commit` (filesystem) | Memory, keeps id, drops streams | Filesystem; memory via REST on VMs | Filesystem; **stops the source** | Filesystem; source keeps running | Filesystem (beta, 30 d) |
| `fork` | No (core helper uses snapshot) | Native, ≤ 20 per call. Memory transport, quiesced first, children reset (5.8) | Native on VMs only. Memory transport, quiesced first, children reset | Native, filesystem from last snapshot | No (core helper) | No (core helper) |
| Detached exec / reattach | Shim | Native `background` + `commands.connect(pid)` | Native sessions + `runAsync` + `cmdId` | Native `detached` + `cmdId` | Shim (reattach after a client crash is unverified) | Shim (no native detached exec) |
| `extendLifetime` | Emulated: `expiresAt` label + reaper | Native `setTimeout` (absolute) | Emulated: `autoStopInterval: 0` + reaper | Native `extendTimeout` (relative) | **Not possible**: lifetime fixed at create | `setInactivityTimeout` ≤ 6 h + alarm keep-alive, not guaranteed |
| Max session | Unbounded | Impello 1/12/24 h by tier; E2B 1 h Hobby / 24 h Pro | Activity-based | 45 min Hobby / 24 h Pro | 24 h | Not guaranteed |
| `lifetimeGuaranteed` | yes | yes | yes | yes | yes (up to the fixed timeout) | **no** |
| `expireKeeps` (what `onExpire: "pause"` keeps) | filesystem (the reaper stops the container) | memory (`lifecycle.onTimeout: "pause"`) | memory on VMs, filesystem on containers (via the reaper) | filesystem (a persistent sandbox stops at its timeout) | **nothing** (terminated at the fixed timeout) | **nothing** |
| Ports | Host port mapping | Any; `getHost` | Any but 22222; token header | **Declared at create** | **Declared at create** | Worker fetcher via facade |
| Egress control | `none`, or proxy sidecar | Domain allowlist | CIDR only, ≤ 10; tiers 1–2 can't change it | Domain allowlist; header injection on Pro | CIDR + domain | Outbound interception (credential injection) |

What "Max session" means in practice: a run longer than the session limit must checkpoint to a git branch or a snapshot and continue on a new box. The core plans this from `limits.maxLifetimeMs`. When `expireKeeps` is `"nothing"`, outcome escrow is mandatory. When `lifetimeGuaranteed` is false, WIP pushes are on by default. Both are described in 5.8.

#### Docker (local)

- **Use it for** development, CI and the L1/L2 test tiers. It is the reference adapter.
- **Shape.** The container runs `sleep infinity`, detached, with the labels from 5.2. Exec uses `Tty: false` and splits stdout from stderr with `demuxStream`. With a TTY the stream is not multiplexed, and demuxing it corrupts the output. Files move as tar streams (`putArchive`/`getArchive`).
- **User and permissions.** The image creates user `agent` with a UID and GID that are passed as build args to match the host user. There is no runtime `chown`. `user: "root"` runs as container root, so the image needs no `sudo`.
- **Workspace.** By default the box is isolated and the workspace arrives through section 6, the same as in the cloud. `docker({ mount: "worktree" })` is opt-in and bind-mounts a host worktree for fast local loops. In that mode, `.git/config`, `.git/hooks` and `.git/info` are mounted read-only. Host-side git also ignores repo hooks and any config that names a program. A sandboxed agent must not be able to plant code that later runs on the host.
- **Gaps.**
  - There is no TTL. The reaper (5.9) enforces `expiresAt`. On expiry it stops the container, which keeps the filesystem, and it never removes a container whose outcome has not been acknowledged.
  - Pause with memory is lost on a daemon restart. In that case `open` falls back to `start`, which keeps only the filesystem, and reports `rebuilt: false` with a warning event.
  - CRIU checkpointing is not used.
  - A domain allowlist needs the optional proxy sidecar.

#### Impello and E2B

- **One adapter, two client bindings:** `impello({ apiKey, template, domain? })` and `e2b({ apiKey, template, domain? })`.
  - Impello **must** use `@impello/sdk` (`new Impello({...}).Sandbox`). The stock `e2b` JS client rejects `imp_` keys before any request leaves the machine.
  - Both bindings take credentials explicitly and never read the process environment, so one process can drive several accounts.
- **Templates.** Use only the Selfbuilding templates `selfbuilding-claude-code`, `selfbuilding-codex`, `selfbuilding-opencode`, `selfbuilding-all` and so on (5.6), for example `impello({ template: "selfbuilding-claude-code" })`. Impello's stock `claude`, `codex`, `opencode` and `claude-code` templates are not supported. They are built on ubuntu:25.04 or python-bookworm, run as user `user`, and put binaries in `~/.local/bin` or the npm global prefix. That breaks the absolute-path argv rule (section 4), the `agent` user and the HOME layout. A template that lacks the Selfbuilding image manifest fails the `runtime` boot phase with exit 78 and a message that names the matching `selfbuilding-*` template. Examples elsewhere in this spec that say `template: "claude"` or `"claude-code"` mean `"selfbuilding-claude-code"`.
- **How the operations map:**

  | Operation | Implementation |
  |---|---|
  | `create` | `Sandbox.create(template, { metadata: { "selfbuilding.deployment", "selfbuilding.run", "selfbuilding.name", "selfbuilding.hostRun"? }, timeoutMs, lifecycle: { onTimeout } })` |
  | `find` | `Sandbox.list({ query: { metadata: { "selfbuilding.deployment", "selfbuilding.name" }, state: ["running", "paused"] } })`, tie-break oldest |
  | `list` | `Sandbox.list({ query: { metadata: { "selfbuilding.deployment" }, state } })`, paginated to the end; a failed page throws |
  | `open` | `Sandbox.connect(id, { timeoutMs })`, the only resume verb, then the `true` probe, then credential re-delivery by the runtime |
  | `pause` | By id |
  | `kill` | `kill()` (returns `false` on 404, so it is idempotent) |
  | `snapshot` | `createSnapshot()`; boot from it with `create(snapshotId)`. Called only after quiescence (5.8) |
  | `fork` | `fork({ count })`, called only after quiescence. Call `setTimeout` on each fork immediately, because the default fork lifetime is 15 s. Then set each child's metadata and run the child reset (5.8) |

- **Settings the adapter must pass:**
  - `onExpire` always passes `lifecycle.onTimeout` explicitly. The core asks for `"pause"` for every placement, disposable boxes included (5.8). The vendor default is `kill`, which destroys the transcript and any outcome that has not been acknowledged.
  - Every `connect` passes `timeoutMs`. Without it, the lifetime resets to 300 s.
  - `exec` always passes `timeoutMs`. `spawn` uses `background: true` with `timeoutMs: 0` and keeps the pid for `commands.connect`.
  - Every exec passes `user: "agent"` and an explicit `HOME`, because envd may default to root.
  - Harness binaries are called by absolute path (`/usr/local/bin/<bin>`). A non-login shell may not source `~/.bashrc`.
  - `writeFiles` sets the owner on parent directories too.
- **Secrets.** Secrets are delivered as 0600 files with `files.write`, under `/run/selfbuilding/secrets/` (section 9.2). They are written again after every `connect`, because neither files under `/run` nor create-time env reliably survive a resume. Never pass secrets as `envs`, at create time or per command. envd logs `Process/Start` env values to logs the whole team can see. Never use network header transforms for secrets either (see the limits below). The Trigger.dev + Impello deployment guide (§7.12.2) follows this rule: secrets go in as 0600 files written with `files.write`, re-delivered after every connect, never in `envs` (§9.2).
- **Error mapping:**
  - `RateLimitError` → `SandboxQuotaError`.
  - `ServiceBusyError` (503, while a node finishes an earlier snapshot) → `SandboxUnavailableError` with retry.
  - A 409 while the box is pausing → retry within the deadline.
- **Impello-specific limits:**
  - If a pause's background upload never completes, the platform kills the box after an hour. Paused sandboxes may also be deleted after 14 days. The adapter therefore treats a failed `connect` on an old ref as a ghost (invariant 6). The journal (section 7) must always hold a branch, WIP ref or snapshot fallback for a sandbox it can no longer resume.
  - `limits` comes from the account tier: concurrency 2/20/100/300, session 1/12/24/24 h, starts per minute 5/12/30/65.
  - Do not use `mcp`, `lifecycle.autoResume`, `volumeMounts`, `network.maskRequestHost`, `network.rules[].transform` or `iam`. They are unsupported, or they are stored and never applied.
- **Generic E2B-compatible hosts.** On the first call the adapter probes `snapshot`, `fork` and metadata filtering. A 404 or 501 is cached, and from then on the method rejects with `SandboxUnsupportedError`. If metadata filtering is unsupported, the adapter has no safe way to scope `list` to a deployment (invariant 20), so it is not offered as built-in on that host.

#### Daytona

- **Exec.** `spawn` uses sessions: `createSession` → `executeSessionCommand({ runAsync: true })` → `cmdId`. `attach` uses `getSessionCommandLogs`. The `ProcessRef` stores the session and command ids. Plain `exec` uses `executeCommand`.
- **Lifetime.** Daytona counts SDK and preview traffic as activity, but not processes inside the box. A silent 40-minute agent run would be auto-stopped. The adapter therefore creates sandboxes with `autoStopInterval: 0` and relies on the reaper. `extendLifetime` moves the `expiresAt` label and calls `refreshActivity()`. On expiry the reaper pauses VMs and stops containers. It deletes them only after the outcome is acknowledged.
- **Sandbox kind.** The default is **VM sandboxes** (`daytona({ kind: "vm" })`), because only VMs pause with memory and fork. Container sandboxes are allowed. On them, `pause` means `stop` and returns `kept: "filesystem"`, and `fork` is absent (`SandboxUnsupportedError`).
- **Gaps.**
  - A parent cannot be deleted while it has live fork children, so `kill` kills the children first. It finds them through the `selfbuilding.parent` label.
  - Egress is a CIDR list of at most 10 entries, and organisations on tiers 1 and 2 cannot change it. A domain allowlist is rejected at `openOrCreate` with `SandboxUnsupportedError { op: "network.domains" }`. It fails closed rather than silently allowing all traffic.

#### Vercel Sandbox

- **Identity.** `name = sandboxName(key)` is unique per project. The adapter creates with that name, and on a name conflict calls `Sandbox.get({ name })`. `list` filters by one tag only, so that tag is `selfbuilding.deployment`. `find` uses the name, and the run id and other labels live in the registry.
- **Persistence.** Sandboxes are created `persistent: true`. `pause` is `stop()`, which returns `kept: "filesystem"`. `open` runs `get({ name, resume: true })`. Each resume starts a new session from the last filesystem snapshot. Processes and memory are gone, so a `spawn`ed harness does not survive a pause, and the core resumes the harness session instead (section 4). A persistent sandbox that reaches its timeout stops the same way, which is what `onExpire: "pause"` maps to.
- **stdin.** `runCommand` gets no stdin unless the command is detached. The adapter writes the stdin to a temp file with `writeFiles` and runs `{ rm -f F; CMD; } < F`.
- **Snapshots.** `snapshot()` stops the source, so `sourceState` is `"stopped"`. `fork` copies the filesystem as of the last snapshot, not the live state, so the core quiesces and snapshots first.
- **Ports** must be listed in `spec.ports`, because `domain(port)` throws for an undeclared port.
- **Images.** There are no custom images. The harness image becomes a named base snapshot (5.6).
- **Gaps.** Sessions last 45 minutes on Hobby. Treat Hobby as a development-only plan.

#### Modal

- **Lifetime.** `timeoutMs` is fixed at create and cannot be extended, so `extendLifetime` always returns `clamped: true`. Before creating, the core computes the lifetime from the agent's wall-clock budget plus the lifetime margin, capped at 24 h. Runs that need longer checkpoint to a branch and continue on a new box. When the fixed timeout fires, Modal terminates the box and nothing is kept (`expireKeeps: "nothing"`), so outcome escrow (5.8) is mandatory on Modal.
- **Pause.** There is no native pause. `pause` runs `snapshotFilesystem()` and then `terminate()`, stores the image id in `ref.meta`, and returns `kept: "filesystem"`. `open` on a terminated ref creates a new box from that image under the same key.
- **Spawn.** `spawn` uses the shim, because reattaching to a `ContainerProcess` after the client crashes is unverified. A memory snapshot cannot be taken while an `exec` is running, so `snapshot` always uses `snapshotFilesystem`.
- **Gaps.**
  - There is no API to list snapshots. The registry (section 7) holds the ids.
  - `fromName` finds only running sandboxes, so `find` uses `list({ tags })`.
  - Ports must be declared at create.

#### Cloudflare Sandbox

- **Shape.** A sandbox is a Durable Object that owns a container, and the adapter can only run inside a Worker that has the DO binding. Selfbuilding therefore ships `@selfbuilding/sandbox-cloudflare/worker`, a facade Worker that you deploy once. It exposes the contract over HTTPS, with requests HMAC-signed per account (section 9). On Node or Trigger.dev, the adapter is a thin client to that facade. When the orchestrator itself runs in a Worker, it uses an RPC service binding instead.
- **Find and list.** There is no provider-side list. The facade keeps an index from key to DO name in a registry DO, with the labels from 5.2, and serves `find` and `list` from it, filtered by deployment.
- **Exec.**
  - Exec runs without a shell, so the adapter wraps commands in `sh -c`.
  - Exec has no timeout, so the facade enforces one.
  - `output()` buffers everything in DO memory, so the facade always uses the spawn shim and returns log reads by offset.
  - `start()` env is not inherited, so env is passed on every call.
  - `start()` returns before the container is ready, so `open` polls `exec(["true"])`.
- **Lifetime.**
  - `setInactivityTimeout` is capped at 6 h and must be set again after a DO restart.
  - Work inside the container does not count as activity. While a `ProcessRef` is running, a DO alarm pings the container.
  - Cloudflare does not guarantee how long an instance runs. When it stops, disk, memory and processes are lost (`lifetimeGuaranteed: false`, `expireKeeps: "nothing"`). WIP pushes and outcome escrow (5.8) are therefore on by default.
- **Snapshots and pause.** `snapshot` uses `snapshotContainer` (filesystem, beta, 30-day expiry). `pause` is snapshot + destroy.
- **Instance size.** The minimum is `standard-2`. Images must be `linux/amd64`.
- **Egress.** This is Cloudflare's strength. Outbound interception lets the facade inject credentials, so the sandbox never holds them. Section 9 uses this.
- **Gaps.** Moving a DO class onto container scheduling is one-way, so the facade uses a dedicated class name. There is no fork.

#### Fork in v1

**No fork carries live processes in v1.** This matches section 9.3: a memory fork of a live harness is not offered.

- `fork(mode: "best")` works in three ways, depending on the provider:
  - Where the provider has native fork (Impello, E2B, Daytona VMs, Vercel), the core quiesces the box and calls it. Native fork is used as a fast copy, not to carry processes.
  - Otherwise, where the provider has `snapshot`, it uses `forkViaSnapshot(provider, ref, n)`. That helper quiesces the box, takes a snapshot, and creates `n` boxes from it under derived keys.
  - Otherwise it uses a git checkpoint and `n` fresh boxes.
- `fork(mode: "filesystem")` requires native fork or `snapshot` and throws `SandboxUnsupportedError` when neither exists. `fork(mode: "git")` always uses a git checkpoint and fresh boxes. The modes are `"best" | "filesystem" | "git" | "memory"` (§3.11).
- `fork(mode: "memory")` throws `SandboxUnsupportedError { op: "fork.memory" }` in v1.
- Every child reports `forkedWith: "filesystem"` (or `"git"`), even when the provider's transport copied memory. Quiescence killed every agent process first, and the child reset kills anything left.
- Agents share state through the filesystem, git branches or typed results (section 3).

### 5.6 Harness images and templates

One declarative definition builds the image format for every provider:

```ts
// @selfbuilding/images
export const claudeCode = defineImage({
  name: "selfbuilding-claude-code",        // ^[a-z0-9][a-z0-9-]*$
  from: baseImage,                       // selfbuilding-base
  resources: { vcpu: 2, memoryMiB: 4096 },
  steps: [
    run(["npm i -g --prefix /usr/local @anthropic-ai/claude-code@${version}"]),
    verify("/usr/local/bin/claude --version"),
  ],
});
```

**Base image `selfbuilding-base`.**

- Debian bookworm, glibc, `linux/amd64`, plus `arm64` for local Docker only.
- git, `gh`, curl, jq, ripgrep, build-essential, unzip, ca-certificates, Python 3, Node 22, pnpm, yarn and bun.
- User `agent` with HOME at `/home/agent`. The UID is 1000 by default and can be overridden at build time for Docker.
- The Selfbuilding in-sandbox runtime in `/opt/selfbuilding`, and the `selfbuilding-mcp` stdio server (section 6) on PATH.
- The image manifest `/opt/selfbuilding/image-manifest.json`, which holds `{ image, version, user, binaries }`. The runtime's `runtime` boot phase (section 6) refuses to start without it.
- glibc is required, because Droid does not run on musl.

**Per-harness images.**

| Image | Adds | Binary |
|---|---|---|
| `selfbuilding-claude-code` | Claude Code | `/usr/local/bin/claude` |
| `selfbuilding-codex` | `@openai/codex` | `/usr/local/bin/codex` |
| `selfbuilding-opencode` | OpenCode | `/usr/local/bin/opencode` |
| `selfbuilding-amp` | Amp CLI | `/usr/local/bin/amp` |
| `selfbuilding-droid` | Droid | `/usr/local/bin/droid` |
| `selfbuilding-pi` | Pi coding agent | `/usr/local/bin/pi` |
| `selfbuilding-grok` | Grok CLI | `/usr/local/bin/grok` |
| `selfbuilding-all` | Claude Code, Codex, OpenCode | as above |

Build rules:

- Every binary is installed or symlinked into `/usr/local/bin`. The adapter calls it by absolute path, and nothing depends on `~/.bashrc`. A vendor installer that picks its own path gets a symlink.
- Install with an empty npmrc and run postinstall scripts. An inherited `ignore-scripts` or `min-release-age` setting produces a broken binary or a false "no matching version" error.
- The final step of every image is `<binary> --version`. A build that cannot print a version fails.
- Images contain **no** credentials, config or auth files. Sections 4 and 9 inject those at run time.
- Images are tagged `<version>` and `<yyyy-mm-dd>`. The alias that callers resolve (`default`) moves only after a successful build. On Impello, a build without the `default` tag cannot be reached by name.
- A failed build step is retried once with the cache skipped, but only on a 5xx or "internal error". Any other failure fails the build immediately.
- Harness versions follow the per-harness policy in section 4. Images are rebuilt weekly and whenever that policy changes. The runtime records `<binary> --version` at the start of every run, because the image can change underneath a long-lived factory.

**How each provider resolves an image (`ResolvedImage`).**

| Provider | Built as | Referenced by |
|---|---|---|
| Docker | Dockerfile from `defineImage` → local image, or a pull of the published OCI image | `selfbuilding/claude-code:<version>` (OCI images are always named `selfbuilding/<harness>:<version>`) |
| Impello / E2B | Template SDK (`Template().fromImage(...)`) from the published OCI image | Template alias `selfbuilding-<harness>`. Size is fixed per template, so a bigger box needs its own template (`selfbuilding-<harness>-<size>`) |
| Daytona | `Image` builder → named snapshot | Snapshot name |
| Vercel | Create from `universal`, run the steps, `snapshot({ expiration: 0 })` | Base snapshot id under a deterministic name |
| Modal | `images.fromRegistry` of the published OCI image | Image id |
| Cloudflare | Published OCI image (amd64) in the facade's container config | Image name |

Where each image lives:

- **Docker, Modal and Cloudflare.** Official images are published to a public registry as `selfbuilding/<harness>:<version>`. Template names on Impello and E2B are `selfbuilding-<harness>`.
- **Impello.** Selfbuilding publishes the same images as public templates under the `selfbuilding-*` aliases. This is the reference deployment's default. If public templates are not available to an account, `selfbuilding images build --provider impello` builds the same aliases into the team's own account.
- **E2B, Daytona and Vercel.** `selfbuilding images build --provider <p>` builds the images into the user's own account.

Vendor stock templates are never used. A custom repo template on Impello or E2B starts from a Selfbuilding template, for example `fromTemplate("selfbuilding-claude-code")`, so it keeps the user, paths and manifest.

### 5.7 Prebuilt per-repo images

Cloning a repo and installing its dependencies is the slowest part of a cold start. A per-repo image does that work ahead of time.

- **Build.** `selfbuilding images build --repo <owner/name> --harness <h> --provider <p>` runs these steps:
  1. Start from the harness image.
  2. Clone the default branch, using a one-shot clone token that expires within the hour (section 9).
  3. Run `.selfbuilding/setup.sh` in `build` mode.
  4. Write `/selfbuilding/state/image.json`.
  5. Store the result as the provider's image, template or snapshot.
- **Key.** The key is `{ repo, baseSha, harnessImageDigest, setupHash, runtimeVersion }`. The image is reused only when `harnessImageDigest`, `setupHash` and `runtimeVersion` all match. A stale `baseSha` is fine, because boot fast-forwards (below).
- **Rebuild trigger.** A scheduled task on the durable host (section 7) rebuilds the image in two cases: the default branch has moved and the last build is more than 30 minutes old, or `setup.sh` has changed, in which case it rebuilds immediately. Builds for one repo are serialised.
- **Boot from a repo image.**
  1. `git fetch` the target branch, then `reset --hard` to its head.
  2. Skip `setup.sh`.
  3. Run `start.sh`.
- **Missing image.**
  - On `ImageUnavailableError` (permanent), the image is retired and the run falls back to the harness image plus a fresh setup. A warning event is emitted.
  - On `ImageActivationPendingError` (transient), the image stays in rotation and this run falls back to a fresh setup.
  - A missing repo image never fails a run.

### 5.8 Snapshots, quiescence, parking, result safety and warm starts

**Snapshot registry.** Every `SnapshotResult` is written to the journal store (section 7), together with the key, the `runtimeVersion`, an expiry and the result of the section 9.3 clean scan. Cloudflare and Modal have no snapshot list, so the registry is the only way to find their snapshots again.

**Compatibility floor.** Each snapshot is stamped with the in-sandbox runtime generation. The runtime manifest declares a `minimumRestoreGeneration`. A snapshot below that floor is never restored silently into a clean filesystem. Instead, the core falls back to the agent's last pushed branch or WIP ref and emits a `sandbox.restore_refused` event. Retained user state is never quietly swapped for a fresh box.

**When snapshots happen.**

- Never during boot, and never after a failed boot.
- At an `agent()` boundary, and only in these cases:
  - the next step is a cold HITL wait (section 8);
  - the caller asked for `snapshot()` or `fork()` (section 3);
  - the sandbox is about to hit `limits.maxLifetimeMs`.
- Never mid-turn. A turn that would outlive the box ends at its turn cap (section 6) and continues on a new box.
- Not after every agent. On most providers a snapshot pauses the box or drops its streams, and the cost adds up.

**Quiescence (required for every snapshot and fork).** The core runs `quiesce(box)` before any `snapshot` or `fork` call, including the snapshot inside `forkViaSnapshot`. Each step either passes or throws `SandboxNotQuiescentError`, and no provider call is made until all of them have passed.

1. **Hold the box's mutation lock.** For a shared handle, this is the handle mutex from section 3. For a fresh box parked for a cold wait, the agent call that owns the box holds it. No new turn or `exec` can start while the lock is held.
2. **Probe the turn lock** (`flock -n /run/selfbuilding/call.lock`, read BUSY-first, section 6). Only `FREE` passes. `BUSY` gives `reason: "busy"`. An exec error or garbled output gives `reason: "unknown"`.
3. **Check for unacknowledged outcomes.** Every `outcome.json` under `/selfbuilding/state/calls/` must be acknowledged (section 6.12). Otherwise the result is `reason: "unacked-outcome"`. A call that is suspended for a cold wait has no outcome yet, so it passes.
4. **Kill every agent process.** `selfbuilding-runtime quiesce` sends SIGINT, then SIGKILL after 2 s, to every `ns-reap` tree left by earlier calls, every hook process group and anything else started through `exec`. It then checks that no process owned by the agent user is left (`pgrep -u agent` is empty). A survivor gives `reason: "process-survived"`. Processes are killed, not SIGSTOPped. A stopped process still holds its environment, which can include model keys, and its sockets, and a memory transport would clone it.
5. **Flush and check the repo.** Run `sync`. If `<workdir>/.git/index.lock` exists, the result is `reason: "git-index-lock"` with the path. Selfbuilding never deletes the lock on its own, because the index may be torn. The caller decides what to do.
6. **Remove credentials and scan** (section 9.3). Delete the secret files and the git token, remove the credential-helper entry and harness auth files, and run the exact-value scan. A hit throws `SnapshotNotCleanError`.

After the provider call:

- **The source** gets fresh credentials delivered again, re-runs `start.sh` in `restore` mode to bring back the services that quiescence killed, and only then releases its mutation lock.
- **Every fork child** is reset on its first `open`, before anything else runs on it:
  1. Kill every agent-user process again. This guards against a memory transport.
  2. Wipe `/run/selfbuilding`, which holds `tools.sock`, `call.lock`, `supervisor.pid` and the cancel sentinel.
  3. Empty `/selfbuilding/state/calls`, so that no callback or outcome from the parent's calls can be sent again.
  4. Write a new `~/.selfbuilding/box.json` that holds the child's own `boxId` and its new generation, which is the child's own sandbox id.
  5. Set the child's labels, including its own `selfbuilding.name` and `selfbuilding.parent`.
  6. Mint and deliver fresh credentials for the child. This includes a new git token, never the parent's.
  7. Run `start.sh` in `restore` mode.
- **A box restored from a snapshot of the same logical box** (materialisation in section 3, or a cold-wait resume) gets steps 1, 2, 4, 6 and 7. It keeps `/selfbuilding/state/calls`, because a suspended call continues there. Its new generation fences out anything the old generation still sends.

Fencing (section 6.7) uses the generation, so even if a copy were missed, its callbacks would be recorded as `late_outcome` and ignored.

**Credentials never enter a snapshot.** They live in memory or under `/run/selfbuilding`, which is tmpfs, and they are delivered again after every `open` (section 9).

**Durable versus ephemeral paths.** On most providers a resume is a reboot.

- Anything a later step reads goes under `/selfbuilding/state/` or `/selfbuilding/state/`. That covers process logs, exit files, the spool and version stamps.
- `/tmp` and `/run` hold only state that is meaningless once its process dies, such as locks, pid files and temporary secret files.

**Parking (shared handles only).** A shared sandbox is paused once its owner has been idle for 5 minutes, not when a step ends. Pausing at the end of every step would make each follow-up pay for a resume.

- Before pausing, the core asks the in-box turn lock (section 6). Only `FREE` may pause. `BUSY` and `UNKNOWN` keep the box running.
- A wrong `FREE` freezes a live turn, and nothing wakes it. A wrong `BUSY` only costs one more sweep interval.
- The pause is sent under the same per-key lock that admission uses, and the lock is released once the pause *starts*. A new step can then never connect a moment before the pause lands.
- Parking is a pause in place, not a snapshot. It does not need quiescence. Section 9.3 covers its credential rules.

**Disposable sandboxes and result safety.** A sandbox owned by one `agent()` call is killed, never parked, once the host has acknowledged its outcome (section 6.12, step 6). It is not killed when the turn settles, and it is not killed when the artifacts are pushed. Until the acknowledgement, the box's disk can be the only copy of the result, the transcript and any artifacts that were not pushed.

- **Expiry pauses.** Disposable boxes are created with `onExpire: "pause"`, the same as shared boxes. Suppose the orchestrator, the host or the provider API stays unreachable for longer than the lifetime margin after the turn settles. On a provider whose `expireKeeps` is `"memory"` or `"filesystem"`, the box then pauses instead of dying. When contact returns, collect opens it, reads the outcome, acknowledges it, and then kills the box.
- **The reaper finishes the job.** The reaper (5.9) kills paused disposable boxes once their outcome is acknowledged, or once their run is terminal. They do not sit there holding paused caps or waiting for a 14-day sweep.
- **Outcome escrow.** The runtime spec (section 6) carries `escrow: { url, expiresAt }`. This is a pre-signed PUT URL for one object, `escrow/<runId>/<callId>/<attempt>/outcome.json`, in the run's artifact store, valid until the dead-run closer deadline. When `outcome.json` has been written and no acknowledgement has arrived within `escrowAfterMs` (default 2 min), the runtime does two things:
  1. It makes sure the latest work is committed (the settle leftover commit, or a WIP commit). The runtime holds no push credential, so the commit is pushed by the host or the reaper, as for mid-turn WIP below.
  2. It uploads the redacted outcome to the escrow URL, with the redacted transcript as a second object under the same prefix.

  The escrow URL is a bearer capability scoped to one object. It is stored in a 0600 file and redacted from every sink. Collect reads the escrow only after a probe has found the box positively gone or unknown. The host still re-validates the escrowed result, as it would for one read from disk.
- **Where escrow is required.** Escrow is mandatory where `limits.expireKeeps === "nothing"` (Modal, Cloudflare). It is on by default everywhere egress reaches the artifact store. If a provider with `expireKeeps: "nothing"` runs under a policy that blocks the artifact host, the core emits a warning at plan time that names the risk.

**Mid-turn WIP pushes.** A provider with `lifetimeGuaranteed: false` can lose its disk partway through a turn. Pushes at the call boundary (§6.12, §6.13) do not help when the container disappears 90 minutes in. The runtime therefore has the option `wipPushIntervalMs`. The runtime builds the WIP commit; the push itself is done from outside the agent's turn by the host or the reaper, because the agent holds only a read token (§9.2):

- The default is 10 minutes when `limits.lifetimeGuaranteed` is false, and `0` (off) otherwise. Any call can set it explicitly.
- The supervisor's timer runs only while a turn is in flight. On each tick it does the following:
  1. It skips the tick if the tree has not changed since the last WIP commit.
  2. It builds a commit with a private index (`GIT_INDEX_FILE=/run/selfbuilding/wip.index`, `git add -A`, `git write-tree`, `git commit-tree -p HEAD`). The agent's own index, `HEAD` and branch are untouched, and ignored files are excluded.
  3. It runs the exact-value secret scan (§9.3) over the WIP diff against the base. A hit means no push, a `wip.blocked { paths }` warning, and another try on the next tick.
  4. It records `{ sha, at }` in `state.json` and emits `wip.ready`.
- The next reaper sweep (§7.8), or the host when it reconciles, pushes `<sha>:refs/selfbuilding/wip/<runId>/<stepKey>`, forced, through the same hooks-disabled, fixed-helper exec as the collect push (§9.2), with a write token that exists only for that one exec. Only Selfbuilding writes that ref. It then records `{ ref, sha, at }` and emits `wip.pushed`, which goes into the journal. Unlike the collect push, this one happens while agent processes are alive; on providers where the agent user can read the token file during that exec, this is an accepted, open risk (§11, Q49).
- If a call is interrupted, its resume restores from the WIP ref when that ref's commit is newer than the call branch's head. This applies to `resume-session` in section 7.6 and to box materialisation in section 3.
- The ref is deleted after the outcome is acknowledged and the call branch is pushed.

**Warm starts in v1.**

- *Pre-create on enqueue.* When a run is admitted, the core issues `openOrCreate` for the first agent's sandbox in parallel with orchestration setup, so cold-start latency overlaps with planning.
- *Pre-resume on answer.* When a HITL answer arrives for a cold wait, the channel webhook calls `open` before the resume step is scheduled (section 8).
- *Fork as a warm start.* A `fork()` from a sandbox that has finished `setup.sh` skips setup for every child. Children still run `start.sh` (above).
- A standing pool of pre-created boxes is not in v1 (see open questions).

### 5.9 Leaks and the reaper

This subsection is the one definition of what the reaper decides for each box. §6.14 owns disposition after a call, parking and the turn-lock probe rules. §7.8 owns the host-side duties: how the reaper is scheduled on each host and how it repairs waits.

Every sandbox carries the labels from 5.2. The reaper reads `selfbuilding.deployment`, `selfbuilding.run`, `selfbuilding.name`, `selfbuilding.step`, `selfbuilding.launch` and, on hosted deployments, `selfbuilding.hostRun`.

```ts
// @selfbuilding/core
export function reap(opts: {
  providers: SandboxProvider[];   // every provider the deployment uses
  journal: JournalStore;          // or the host memo reader on hosted deployments
  asks: AskStore;                 // open asks hold their boxes (section 8)
  host?: DurableHost;             // required on hosted deployments
  deployment: DeploymentId;
  dryRun?: boolean;               // report decisions, change nothing
}): Promise<ReapReport>;
```

Every host template (section 7) schedules `reap()` every 2 minutes, and `selfbuilding reap` (`--every 2m` to loop) runs it on plain Node. It decides from the world, not from events. A missed event, a duplicate event, or a process that dies between scheduling and firing all leave timers that never fire. A sweep also catches boxes created by paths nobody remembers.

**Step 1: list.** Call `list({ deployment })` on every provider, or read the registry for providers with no list API. The reaper never sees another deployment's boxes. If a list throws, the sweep reports "unavailable", not "nothing running".

**Step 2: find the owner's state** for each box, and join it with the ask store.

| Deployment | Owner state comes from | Possible answers |
|---|---|---|
| Plain Node | The journal intent row for `(selfbuilding.run, selfbuilding.name)`, which is written before `create` (section 6.14) | live, terminal (with ack status), no row |
| Hosted (Trigger.dev, Inngest, CF Workflows) | `host.runStatus(selfbuilding.hostRun)`, then the journal or host memo for the call | running or waiting, terminal, positively not found |
| Either | A journal read error, a host API error or timeout, or a missing `selfbuilding.hostRun` label on a hosted box | **unknown** |

There is no Selfbuilding journal on Trigger.dev or Inngest. On those hosts, "no journal row" is never evidence of anything. The host run status is the evidence.

**Step 3: probe before destroying.** Before killing or pausing a running box, the reaper probes the turn lock (§6.14). Only `FREE` permits action, and `BUSY` or `UNKNOWN` always hold. A failed probe exec counts as `UNKNOWN`. Paused boxes are never probed, because probing would wake them (invariant 1). A paused box cannot be running a turn, so it can be killed on positive owner evidence alone.

**Step 4: act.** The table is evaluated top to bottom. The first matching row applies.

| Owner state | Box | Action |
|---|---|---|
| unknown | any | hold; `skip [owner-unknown]` |
| call `waiting` or `suspended`, ask open, before `expiresAt` + 1 h | any | **hold. Never kill, pause or rebuild.** If the call is `waiting` and the box is running, extend its lifetime. If it is `suspended`, leave the parked box alone; it holds the session. |
| call `waiting` or `suspended`, past `expiresAt` + 1 h, ask still open | any | journal `failed{reason:'lost'}` (the ask's timeout handling never ran), notify the run's channel, then apply the failure disposition (§6.14). The session file was captured at suspend (section 8.4). |
| live, outcome not yet acknowledged | any | hold. Extend the lifetime when the deadline allows (section 7.8) |
| call `running`, `booting` or `settling`, past the dead-run closer (§6.11) | running, probe ≠ `BUSY` | journal `failed{reason:'lost'}`, notify the run's channel, then kill |
| live, call terminal and acknowledged | disposable | kill if paused, or if running and `FREE` |
| live | shared handle, owner idle > `idleParkMs` (default 5 min), no open ask | pause if `FREE`; handle the `PauseOutcome` (below) |
| live | Docker or Daytona box past `expiresAt` | pause (VM) or stop (container) if `FREE`. Never delete before the acknowledgement |
| run terminal | anything except a kept shared handle | kill if paused, or if running and `FREE` |
| orphan, older than **15 min** | any | kill if paused, or if running and `FREE` |
| several boxes for one key | the non-oldest | kill each one only when paused or `FREE`; keep the oldest |
| any | running, probe `BUSY` or `UNKNOWN` | hold; check again next sweep |

A box is an **orphan** only on positive evidence:

- On a hosted deployment, the host says the `selfbuilding.hostRun` run is terminal or positively not found.
- On plain Node, the journal is readable and has no intent row.

The orphan age is 15 minutes everywhere. Boxes from a lost-response create end up here if `find(key)` never claimed them. Once a run is terminal, nothing will ever acknowledge its outcomes, so an unacknowledged outcome no longer holds the box.

Section 8.11 must include the scenario "a cold ask open for longer than the dead-run closer of a running call (for example 6 h), with the reaper sweeping throughout". The test asserts that the call stays `suspended`, the parked box is not killed, and the answer resumes the session.

**Rules.**

- `SandboxUnavailableError`, an unknown owner and an `UNKNOWN` or `BUSY` probe never lead to destruction (invariants 5 and 20).
- The reaper logs a `skip [reason]` line for every box it leaves alone.
- On `PauseOutcome { confirmed: false, reason: "refused" }`, the reaper raises an alert on every sweep while the condition lasts, not only when it first appears.

When a durable host cancels a run (an Inngest `cancelOn`, a Trigger.dev cancel, a Workflows terminate), the sandbox is not stopped by the host. The host template registers a cancellation handler that kills the run's sandboxes by `selfbuilding.deployment` and `selfbuilding.run`, applying the same `FREE` probe (section 7).

### 5.10 Lifecycle hooks: `.selfbuilding/`

A repo can include:

```
.selfbuilding/
  setup.sh     # provisioning: install deps, build caches
  start.sh     # per-boot: start services, write .env files, migrate test DB
  image.ts     # optional: extra defineImage() steps for this repo's image
```

| Hook | Runs on | Failure | Default timeout |
|---|---|---|---|
| `setup.sh` | Fresh boot, repo-image build | **Fatal.** `hooks.setup.allowFailure: true` downgrades it to a warning on fresh boots; it stays fatal in builds. | 20 min |
| `start.sh` | Every boot: fresh, restore, repo image, fork child, and the source after a snapshot or fork | Fatal | 5 min |

Fatal by default is a deliberate choice: an agent working in a half-provisioned environment burns budget and produces wrong results.

Rules:

- **How hooks run.**
  - Each hook runs as `bash <script>` with `cwd` set to the repo root and user `agent`.
  - It runs in its own process group, which is killed on timeout or abort.
  - It gets `SELFBUILDING_BOOT_MODE=fresh|restore|repo-image|build`, `SELFBUILDING_RUN_ID` and `SELFBUILDING_HOOK=setup|start`. Fork children, and sources after quiescence, boot in `restore` mode.
  - Hooks run only inside the sandbox, never on the orchestrator host.
- **Output is captured.** stdout and stderr go to `/selfbuilding/state/logs/hooks/<hook>-<boot>.log`. The last 64 KiB is redacted and attached to the `sandbox.hook` event, and failure events include it. Discarded hook output is a known debugging dead end.
- **Hooks must be idempotent.** `setup.sh` can run again after a partial provision, and `start.sh` runs again after every quiescence. The runtime writes its completion stamp *last*, so an interrupted setup runs again.
- **Code can override hooks.** `agent(..., { sandbox: { hooks: { setup, start } } })` takes `{ command, timeoutMs?, allowFailure? }`. Hooks supplied in code replace the files for that agent.
- **Multi-repo.** Not in v1. One repo per sandbox (section 1 non-goals).
- **Secrets.** Hooks get the same declared-only environment as the agent (section 9). Secret values never appear in hook argv.

### 5.11 Open questions

Moved to §11 (Q37 to Q45).

## 6. In-sandbox runtime and run lifecycle

This section covers four things:

- What Selfbuilding runs inside a sandbox, and where every file lives.
- How one `agent()` call moves from "planned" to a terminal state.
- The single timeout table that every other section references.
- What happens to the git work and the sandbox afterwards.

Other sections cover the rest of an agent call:

- How a skill becomes a prompt and a result schema: section 2.
- How calls are composed and placed, and the `AgentCallOptions` type: section 3.
- How each harness CLI is driven and parsed: section 4.
- The provider contract the runtime sits on: section 5.
- How the host maps a call onto a durable step: section 7.
- How `ask()` reaches a human: section 8.
- Credentials and redaction: section 9.

Three things are defined only in this section. Other sections reference them and do not restate them:

- the filesystem layout (6.4);
- the timeout table (6.11);
- the branch and ref naming functions (6.13).

### 6.1 Terms

| Term | Meaning |
|---|---|
| **Run** | One invocation of a factory, identified by `runId`. It owns a journal (section 3). |
| **Agent call** | One `agent()` invocation inside a run. It is identified by `callId = <runId>.<callPath>`, where `callPath` is the call's deterministic position in the factory (section 3). On disk the call's directory is named by its `stepKey` (section 7.2), which is filename-safe. |
| **Attempt** | A numbered try at one agent call (`attempt = 1, 2, …`). Each attempt has its own state directory. Stale attempts are fenced out. |
| **Turn** | One harness process invocation, from prompt to exit. An attempt usually has one turn. Done-check feedback, the missing-result nudge, an interrupted-turn resume and a cold-ask resume each add another turn on the same harness session. |
| **Runtime** | The Selfbuilding program inside the sandbox. It contains the supervisor, the bridge and the tool server. |
| **Host** | Whatever runs `run()`: plain Node, a Trigger.dev task, an Inngest function or a Cloudflare Workflow. |
| **Generation** | One live incarnation of a sandbox, identified by `sandboxId`. A sandbox recreated from a snapshot or a branch is a new generation. |
| **Active time** | Wall-clock time of a call, excluding time in the `waiting` and `suspended` states (6.7). Every call-level timeout counts active time. |

### 6.2 Design rules

Every later subsection follows from these rules.

1. **The sandbox is the durable worker for a turn.** The host only launches and observes. A turn keeps running after the host process dies, and the host reattaches by `callId`.
2. **Disk is the source of truth.** Every fact the host needs is a file in the sandbox's durable state directory: state, events, result, outcome and launch marker. Callbacks only wake the host. They are never the only copy.
3. **Durable means it survives pause and resume.** Anything a later turn, a later reattach or a later boot reads lives under `/selfbuilding/state/`. `/run` and `/tmp` hold only things that are meaningless once their process has died. Many providers clear `/run` and `/tmp` on resume.
4. **Exactly one owner settles the outcome.** The harness adapter reports events. The supervisor writes the terminal outcome once. The host accepts the first outcome per `(callId, attempt)`.
5. **Unknown is not failure.** A provider timeout, a 5xx response or a lost response means the outcome is unknown. An unknown outcome never destroys anything. Only positive evidence does.
6. **A half-executed turn is never silently re-run.** Restoring files cannot undo a push or a posted comment. The default for an interrupted turn is to fail with recovery data.
7. **A waiting call is not a dead call.** A call blocked on a human is in the `waiting` or `suspended` state. No idle timer, call timer, dead-run closer or reaper may treat it as stuck before its ask has expired.
8. **Error paths must not depend on the network.** The runtime logs to a durable file before it tries to report.
9. **Everything the sandbox reports is untrusted.** The host checks schemas, sizes and paths again.

### 6.3 Process topology

```
sandbox
├── ns-reap                         (subreaper; tiny static helper)
│   └── selfbuilding-runtime supervise --call <stepKey> --attempt <n>
│       ├── Supervisor   boot phases, harness child, timeouts, settle, outcome
│       ├── Bridge       events spool, heartbeats, wake callbacks, inbox, cancel sentinel
│       ├── Tool socket  /run/selfbuilding/tools.sock (submit_result, ask_human, notify_human)
│       └── harness process group  (claude | codex | opencode | …)
│           └── selfbuilding-mcp (stdio, spawned by the harness, talks to tools.sock)
```

**One runtime process with three roles.** The supervisor, the bridge and the tool socket live in one Node process, for two reasons:
- The runtime never holds a long-lived socket that needs restarting. The host connects by exec, and optionally by outbound HTTP (6.6).
- One process means one log, one crash handler and one place that writes the outcome.

**Supervisor.**
- Owns the boot order (6.5).
- Spawns the harness in its own session and process group under `ns-reap`.
- Enforces every in-sandbox timeout (6.11), and pauses the active-time clocks while the call is `waiting`.
- Watches the harness's normalised event stream through the adapter's parser (section 4).
- Drives settling (6.12) and writes `outcome.json`.

**Bridge.**
- Appends normalised, redacted events to `events.jsonl` with a monotonic `seq`.
- Writes a heartbeat to `state.json` every 15 s.
- Serves the long-poll `wait` verb (6.6).
- Sends wake callbacks to the host's current wake target (6.6).
- Watches `inbox/` for ask answers (6.9) and watches the cancel sentinel (6.10).

**Tool server.**
- `selfbuilding-mcp` is a small stdio MCP server that the harness spawns from its MCP config (section 4). It holds no state and no credentials.
- It forwards each tool call (`submit_result`, `ask_human`, `notify_human`) over a Unix socket to the supervisor.
- The supervisor validates `submit_result` against the result schema (section 2). It answers with `isError` and the issues, or with "accepted, stop now".
- Only the supervisor writes `result.json`. The agent cannot write it.
- Pi has no MCP. It reaches the same socket through a Pi extension tool (section 4).

**Subreaper.**
- Agent tools start long-lived children such as dev servers, MCP servers and `gh`. Some of them call `setsid`, which escapes a process-group kill.
- `ns-reap` is a static helper of about 1 MB, built for amd64 and arm64. It sets `PR_SET_CHILD_SUBREAPER`, adopts orphans, forwards signals and kills the whole tree on demand.
- If the image lacks it, the runtime falls back to a process-group kill and logs a `warning{scope:"containment"}` event.

**Runtime delivery.**
- The runtime is one ESM bundle, `selfbuilding-runtime.mjs`, plus `selfbuilding-mcp.mjs`. Both need Node 20 or later in the image. The provider conformance suite checks this (section 10).
- At boot the host writes both files with `writeFiles`. It skips the write when `/selfbuilding/runtime-version` already holds the same SHA-256.
- The stamp is written last, so a partial write is retried on the next boot.
- Nothing is installed with npm inside the sandbox.

**Users.**
- The supervisor runs as root, or as a dedicated `selfbuilding` user where the provider allows it.
- The harness runs as the agent user, with `HOME=/selfbuilding/home` and `PWD=/selfbuilding/work` set explicitly on every spawn.
- Some providers give only one user (some Modal and Cloudflare images). There the runtime runs as that user and records `isolation:"same-user"` in the `ready` event. The schema check still applies. What is lost is the guarantee that the agent cannot write runtime files.

### 6.4 Filesystem layout (canonical)

This table is the only definition of sandbox paths in the spec. Sections 2, 3, 4, 5, 7, 8 and 9 refer to these paths by name and do not define their own. The paths are fixed. They are identical on every provider, every generation and every box, so harness session files restore to the same location without any rewriting.

| Path | Owner | Survives pause/resume | Contents |
|---|---|---|---|
| `/selfbuilding/bin/` | root, read-only to agent | yes | `selfbuilding-runtime.mjs`, `selfbuilding-mcp.mjs`, `ns-reap` |
| `/selfbuilding/runtime-version` | root | yes | SHA-256 of the runtime bundle, written last |
| `/selfbuilding/skills/<name>/` | root, read-only | yes | Materialised skills (section 2) |
| `/selfbuilding/contract/result.schema.json` | root, read-only | yes | Draft-07 result schema for the current attempt (section 2) |
| `/selfbuilding/in/` | root, read-only | yes | `prompt.md` and `system.md` for the current turn, plus materialised inputs such as transcripts (section 2) |
| `/selfbuilding/work/` | agent | yes | **The workdir.** The one repository working tree. |
| `/selfbuilding/home/` | agent | yes | **The isolated `HOME`.** Harness config dirs (`.claude`, `.codex`, `opencode.json`, …) and native session files. For example, Claude sessions are at `/selfbuilding/home/.claude/projects/-selfbuilding-work/<id>.jsonl`. |
| `/selfbuilding/out/` | agent | yes | Agent drop box. `files/**` holds exports (section 2). There is no file-based result fallback: results arrive only through `submit_result` (§2.6). The host never reads this directory directly. |
| `/selfbuilding/state/` | root | **yes** | **The durable state directory.** Everything below. |
| `  state/box.json` | root | yes | `{runId, boxId, version}` box marker (§3.11) |
| `  state/image.json` | root | yes | Repo-image stamp (section 5.7) |
| `  state/setup.done` | root | yes | Setup completion stamp. Written last, so an interrupted setup runs again. |
| `  state/launches/<launchId>.launched` | root | yes | **Launch marker** (6.8, section 7.4). Written atomically before the harness is started. |
| `  state/proc/<id>.log`, `<id>.exit` | root | yes | Detached-spawn shim output (section 5.2 `ProcessRef`) |
| `  state/calls/<stepKey>/<attempt>/` | root | yes | **The attempt directory.** Everything below. |
| `    spec.json` | host | yes | `RuntimeSpec`, staged atomically |
| `    state.json` | supervisor | yes | Phase, pids, `sessionId`, `lastSeq`, heartbeat, clock state |
| `    events.jsonl` | bridge | yes | Normalised, redacted, `seq`-numbered events |
| `    submissions/<n>.json` | supervisor | yes | Every `submit_result` call, valid or not, with issues |
| `    result.json` | supervisor | yes | **The result.** The last valid submission. This is the only result file the host reads. |
| `    outcome.json` | supervisor | yes | Terminal outcome, created once with `O_EXCL` |
| `    cancel` | host | yes | Cancel sentinel (6.10) |
| `    wake.json` | host | yes | Current wake target `{launchId, rearm, target}` (6.6) |
| `    inbox/` | agent-writable dir | yes | Ask answers (6.9) |
| `    runtime.log` | supervisor | yes | Supervisor log, including `FATAL` lines |
| `    harness.stderr.log` | supervisor | yes | Diagnostics only. Never shown as "the error". |
| `    hooks/<hook>-<bootMode>.log` | supervisor | yes | Hook stdout and stderr, captured rather than discarded |
| `/run/selfbuilding/` (else `/tmp/selfbuilding/`) | root | **no** (tmpfs) | Process lifetime only: `call.lock` (flock held for the duration of a turn), `supervisor.pid`, `tools.sock`, `secrets/`, and `bin/git-credential-selfbuilding` (section 9) |

Placement rules:
- **Nothing a later step reads goes under `/run` or `/tmp`.** The launch marker, the cancel sentinel, the result and every log are durable. If a launch marker were lost on resume, an idempotent launch would start a second harness. If a cancel sentinel were lost, a cancel would be dropped.
- **Locks and secrets go under `/run`, deliberately.** A turn lock that disappears on resume is correct, because the process that held it is gone. Secrets must not survive into a paused or snapshotted disk (section 9.3).
- **One path per thing.** The result is always `<attemptDir>/result.json`. Launch files are always `/selfbuilding/state/launches/<launchId>.*`. There is no `/workspace/<repo>`; the workdir is `/selfbuilding/work`.

**Conformance test (section 10, required for every provider with `pause`).** The test does the following:
1. Launch a scripted harness call.
2. Pause the box, then resume it with `open`.
3. Call launch again with the same `launchId`.
4. Assert that launch returns `{reattached: true}` and that no second harness process exists.

On providers whose pause keeps only the filesystem, the harness is gone after resume. There, launch must report the call as `interrupted` (6.8), and must not start a fresh harness.

**Spec handoff.**
- The host stages `spec.json` and the `/selfbuilding/in/` files at `…/<attempt>.tmp/`, then `mv`s them into place in one exec. Readers skip `*.tmp`.
- Prompts, system prompts and inputs are always files or stdin. They are never interpolated into a shell string, because issue bodies and channel text are user-controlled.

```ts
interface RuntimeSpec {
  v: 1;
  runId: string;
  callId: string;
  stepKey: string;                          // directory name under state/calls/
  attempt: number;
  launchId: string;                         // `${HostKey}_l${n}`, where HostKey = `${StepKey}_e${Epoch}` (§7.2)
  harness: HarnessId;                       // section 4
  harnessVersion: string;                   // exact version; the host resolves the policy first (§4.11)
  sessionId?: string;                       // pre-assigned where the harness allows (6.8)
  resumeSessionId?: string;                 // set on resume and follow-up turns
  resultSchema: JsonSchema;                 // section 2; also written to /selfbuilding/contract/
  maxResultBytes: number;                   // default 262_144 (256 KiB), configurable up to 1 MiB
  git: GitSpec;                             // 6.13
  timeouts: ResolvedTimeouts;               // 6.11
  hotWaitMs: number;                        // effective hot wait for this call (section 8.4)
  callbackToken?: string;                   // HMAC key for wake callbacks (6.6, section 9)
  env: { declared: string[] };              // names only; values arrive as files (section 9)
}
```

### 6.5 Boot and readiness

The supervisor runs these phases in order. It appends each phase's start, completion or failure to `events.jsonl` as `boot{phase, status, elapsedMs, detail}`.

| Phase | Work | Failure is |
|---|---|---|
| `runtime` | Verify the runtime stamp, the Node version and `ns-reap`. | fatal |
| `sync` | Clone or fetch the repo into `/selfbuilding/work` and check out the call branch (6.13). | fatal |
| `setup` | Run the `setup` hook. Runs in boot modes `fresh` and `build` only. It is skipped when `state/setup.done` matches the current setup hash. | fatal by default. `hooks.setup.allowFailure: true` makes it a warning on `fresh` boots. It stays fatal in `build`. |
| `start` | Run the `start` hook. Runs on every boot. | fatal |
| `skills` | Materialise skills and link them into harness discovery paths (section 2). | fatal |
| `harness` | Check or install the harness version (6.8). Stage the isolated config dir and the MCP config, including the MCP tool timeout (6.11). Repair the session file. | fatal. Deterministic causes exit 78 (6.15). |
| `ready` | Emit `ready{runtimeVersion, harness, harnessVersion, isolation, baseSha, bootMode}`. | none |

Rules:

- **Readiness is the `ready` event.** It is not "create returned" and not "exec answered". After a resume, a provider can accept connections and still answer nothing for a while. The host's first probe after any `open` is a no-op exec, retried within the open deadline (section 5).
- **Boot mode.** Hooks receive `SELFBUILDING_BOOT_MODE=fresh|restore|repo-image|build`, plus `SELFBUILDING_RUN_ID` and `SELFBUILDING_HOOK=setup|start`. This is the one enum. Section 5.10 uses it too.
  - Reattaching to a box that is already running is not a boot. No hooks run.
  - `restore` means the box came from a snapshot, a filesystem pause or a git checkpoint.
- **Hook execution.**
  - Each hook runs as `bash <script>` with `cwd=/selfbuilding/work` as the agent user.
  - It runs in its own process group, which is killed on timeout or cancel.
  - Its timeout is `timeouts.setup` or `timeouts.start` (6.11).
  - Code-supplied hooks use the same shape as section 5.10: `{ command, timeoutMs?, allowFailure? }`.
- **Hook output is captured** to `hooks/<hook>-<bootMode>.log`. The last 4 KiB, redacted, goes into the failure event. Discarded hook output makes boot failures impossible to debug.
- **No snapshot during boot.** No snapshot is ever taken while a boot is in progress or after a boot failure.

### 6.6 Bridge to the host: polling first, callbacks as wake-ups

The host must be able to observe a call on every provider, with no inbound port, and whether or not the sandbox has egress. Polling over the provider's exec channel is therefore the base. Callbacks are an optimisation that only wakes the host.

**Long-poll over exec (always available).**

```
selfbuilding-runtime wait --call <stepKey> --attempt <n> --after <seq> --max 25s
→ { events: RuntimeEvent[], lastSeq, state, pendingAsk?: AskSpec, outcome?: Outcome }
```

- The command returns as soon as new events exist, or after `--max`.
- 25 s stays under every provider gateway's call ceiling.
- Each response is capped at 256 KiB, and the host loops.
- `events.jsonl` is append-only, so the host's cursor (`lastSeq`) is all the delivery state it needs.
- Re-reading is idempotent, keyed by `(callId, attempt, seq)`.

**Wake callbacks (optional, when egress allows).**

- The bridge POSTs to the callback target in `wake.json`. The host writes that file in the `register` step of `waitForCallback` (§7.3), before the wait begins.
- Each request is HMAC-signed over `kind + body` with the call's `callbackToken` (section 9). `kind` is a domain separator, so a body signed for one route cannot be replayed on another.
- The body is the `AgentCallback` from §7.4: `{ v: 1, runId, stepKey, launchId, status, source: 'runtime', at }`, plus `rearm`. `status` is the outcome status, or `ask` when the agent called `ask_human` (section 8), or `failed` with `boot` detail on a boot failure. The host never trusts the body for the result. It always reconciles from disk with one `wait` exec.
- **Only critical events wake the host.** These are the outcome, `ask` (section 8) and boot failure. Critical wakes are retried with full-jitter backoff under a 10 min overall deadline until the host answers 2xx.
- Progress events never use callbacks. The host reads them through `wait` when it reconciles.
- **One wake per armed wait.** `wake.json` holds `{ launchId, rearm, target }`. The bridge sends at most one successful wake to each `(launchId, rearm)`. It records `wake.<launchId>.w<rearm>.sent` in the attempt directory, which makes the send idempotent across runtime restarts.
  - If a critical event happens while the current target is already spent, or before any `wake.json` exists, the bridge marks a pending wake.
  - It sends that pending wake as soon as the host writes a `wake.json` with a higher `rearm` or a new `launchId`.
- The sandbox keeps `outcome.json` until the host acknowledges it (6.12).

**How the host waits.** §7.4.2 is the one definition: every host waits **once per launch**, keyed on `launchId`, with a timeout of the call's `timeout` plus 30 min (§7.7). There are no reconcile ticks inside the wait. A wake is a hint; on every wake the host reconciles from disk with one `wait` exec and then does one of three things:

| Reconciled state | Host action |
|---|---|
| `outcome.json` exists for this `launchId` | collect (§7.4.3) |
| `pendingAsk` is set | handle the ask (section 8.4), then re-arm the same launch's wait with `rearm + 1` |
| turn lock `BUSY` or `UNKNOWN`, no outcome, no ask | premature or stale wake: re-arm with `rearm + 1` and the remaining timeout |
| turn lock `FREE`, no outcome | the turn is interrupted (6.8, §7.6) |

Premature re-arms are capped at 3 per launch (§7.4.2). Re-arms for asks do not count against that cap, because each one follows a real event.

| Host | Wait primitive | Wake target |
|---|---|---|
| Plain Node | `selfbuilding-runtime wait` long-poll loop over exec | none needed |
| Trigger.dev | `wait.forToken` on one token per `(launchId, rearm)` (§7.5.1) | the token's `url` |
| Inngest | `step.waitForEvent` keyed on `launchId` and `rearm` | callback relay sends `selfbuilding/agent.callback` |
| CF Workflows | `step.waitForEvent` keyed on `launchId` and `rearm` | Worker, then `instance.sendEvent` |

**Trigger.dev tokens.** A Trigger waitpoint token completes once and cannot be reused, so each armed wait creates its own token with `idempotencyKey: ns:${runId}:${launchId}:done:w${rearm}`. The timeout is set on `createToken`, not on `forToken`.

- **Why tokens and not an input stream.** Sending to an input stream needs a Trigger API key, and the sandbox must never hold one. A token URL is a bearer capability scoped to one armed wait. It is written to `wake.json` with mode 0600 and redacted (section 9).
- **Replay safety.** A child retry re-derives the same `(launchId, rearm)` sequence from replayed values. The idempotency keys return the same tokens, and a token that already completed returns at once.
- **Hot asks.** A run may have only one wait open at a time. During a hot ask the child waits on the ask's own token (`idempotencyKey: askId`, section 8.5) instead of a wake token. When the ask resolves, it re-arms the launch wait.
- **Lifetime.** Each reconcile also extends the sandbox lifetime (6.11).
- A missed or duplicated wake costs at most one reaper sweep (2 minutes) of latency, because the reaper sends a synthetic `finished` for an unacknowledged outcome (§7.8). It never costs a lost result.
- Section 7 owns how each wait maps onto host steps.

### 6.7 Agent call state machine

The host journal holds the authoritative state. The runtime's `state.json` mirrors the part inside the sandbox.

```ts
type CallState =
  | 'planned'       // journal row written; nothing remote yet
  | 'provisioning'  // sandbox create/open in flight; intent persisted first
  | 'booting'       // runtime launched; boot phases running
  | 'running'       // a harness turn is in flight
  | 'waiting'       // hot ask: harness blocked on ask_human; active-time clocks paused (section 8)
  | 'suspended'     // cold ask: session saved, sandbox parked, host waiting; clocks paused (section 8)
  | 'settling'      // result accepted or harness exited; done checks, commit, push, artifacts
  | 'unknown'       // contact lost; reconcile pending
  | 'interrupted'   // runtime found a dead turn with no outcome
  | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';   // terminal
```

| From | To | Trigger |
|---|---|---|
| planned | provisioning | The host writes the sandbox intent `{callId, attempt, provider, labels}`, then calls `openOrCreate`. |
| provisioning | booting | The sandbox is open and the runtime has been launched detached. |
| provisioning | unknown | Create timed out or its response was lost. Resolved by label lookup (6.14). |
| booting | running | `ready` event, and the harness has been spawned. |
| booting | failed | A boot phase failed fatally. The error names the phase. |
| running | waiting | `ask_human` was called and the hot wait began (section 8.4). The idle and call clocks stop. |
| waiting | suspended | The hot wait expired without an answer and the session was saved and parked (section 8.4). |
| waiting / suspended | running | The answer was delivered. The clocks restart. |
| running | settling | Valid `submit_result`, or the harness exited. |
| running | interrupted | Reattach finds `call.lock` FREE, no `outcome.json`, and `state.json` saying `running`. |
| interrupted | running | `onInterrupted: 'resume-session'` (6.8). |
| interrupted | failed | `onInterrupted: 'fail'` (the default), or there is no resumable session. |
| settling | succeeded / failed | Done checks (section 2), push verification and artifact upload. |
| any non-terminal | cancelled | 6.10 |
| running, booting, settling | timed_out | 6.11 |
| unknown | any | Reconcile reads the sandbox and adopts its state, or fails as `lost` after the dead-run closer (6.11, 6.14). |

**Fencing.**
- Every exec, callback and file the host reads carries `(callId, attempt)`.
- A callback or outcome from an older attempt or a replaced generation is recorded as `late_outcome` and ignored. The branch it pushed is kept and listed in the event.
- Once the journal marks a call terminal, nothing changes it.

**Outcome.**

```ts
interface Outcome {
  callId: string; attempt: number;
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  reason?: ErrorCode;               // the one union, §9.8 (for example 'no_result', 'done_check', 'idle_timeout', 'lost', 'interrupted')
  result?: unknown;                 // re-validated on the host before use
  sessionId?: string;
  git: { branch?: string; baseSha?: string; headSha?: string; pushed: boolean };
  usage?: Usage;
  harnessVersion: string;
  message?: string;                 // redacted, actionable
}
```

Every Selfbuilding error thrown from `agent()` carries the recovery fields from `Outcome` in the §9.8 `recovery` shape: `branch`, `headSha`, `sessionId`, `sandbox` (when preserved) and `transcript`. The caller, or a later `agent()` call, can then continue the work instead of starting again.

### 6.8 Idempotency and reattach

Every action that can be retried has a key, so a retry finds the earlier attempt instead of duplicating it.

| Action | Key | Repeat behaviour |
|---|---|---|
| Sandbox create | Labels `selfbuilding.run=<runId>`, `selfbuilding.step=<stepKey>` and `selfbuilding.launch=<launchId>` (or `selfbuilding.name` with the handle id for shared sandboxes), plus a registry row written before create | Uses `openOrCreate`, so a second create finds the first. If two exist, the oldest wins and the other is left for the reaper. |
| Runtime launch | `launchId` | `selfbuilding-runtime launch` first checks `state/launches/<launchId>.launched`, which is durable. If the marker exists, it takes `call.lock` without blocking. If the lock is held, it exits `0 {reattached:true}` and starts nothing. If the lock is free, the turn died and the call goes to `interrupted`. A new harness is never started over an existing marker. |
| Harness session | `sessionId = uuidv5(runId + callPath + attempt)` (§4.7) | Pre-assigned where the harness supports it (Claude `--session-id`, Pi `--session-id`). Otherwise the first `session.started` event is persisted to `state.json` before anything else (section 4). "Continue last session" flags are never used. |
| Result | `(callId, attempt)` | Each valid submit overwrites `result.json`, so the last valid one wins. `outcome.json` is created with `O_EXCL`. |
| Wake callback | `(launchId, rearm)` | At most one successful send per armed wait (6.6). |
| Push | `branchName()` (6.13) | Re-pushing the same SHA is a no-op. A push is retried only when the remote ref has been verified not to equal local `HEAD`. |
| PR | Head branch | Look up an open PR for the head branch before creating one. |
| Ask answer | `askId` | The inbox file name is `<askId>.json`. A duplicate write is a no-op. |

**Detached launch.**
- The host writes the launch marker atomically. It then starts the runtime with the provider's detached exec: `background:true` on E2B and Impello, `detached` on Vercel, session `runAsync` on Daytona. On other providers it uses the shim `setsid nohup … > runtime.log 2>&1 &`.
- The host never retries a detached launch blindly. A launch that may have succeeded is the one case where a retry doubles the work. On an ambiguous launch error, the host probes the marker, `call.lock` and `state.json` instead.
- The launch call always passes an explicit command timeout. It never uses the provider's default, which is 60 s on E2B-compatible providers.

**Interrupted turns.**

A turn is interrupted when a reattach finds the marker present, the lock FREE, no outcome, and phase `running`. The runtime then applies `onInterrupted`. This is the only interrupted-turn option in the spec. Section 7.6 uses the same option. It is set per agent in `AgentCallOptions` (§2.5.1) and defaulted per factory.

```ts
onInterrupted?: 'fail' | 'resume-session';   // default 'fail'
```

- **`'fail'`** (default). The call ends `failed{reason:'interrupted'}` and throws `AgentInterruptedError` with recovery data. Inside `parallel()` it becomes `null`.
- **`'resume-session'`.** The runtime resumes the same harness session with this fixed message: "Your previous turn was interrupted at <time>. Inspect `git status`, `git log` and the state of any external actions before continuing. Do not repeat actions that already took effect. Call submit_result when done."
  - It resumes in place if the sandbox is alive. Otherwise it follows the section 7.6 order: snapshot, then a fresh box at the agent's branch.
  - It happens at most once per call, unless `maxResumes` is raised.
  - It needs a harness that supports resume and a session file that is intact. If either is missing, the call fails as for `'fail'`.
  - Before every resume, the runtime repairs a JSONL session whose last line was truncated by a kill.
  - The original prompt is never re-run from a blank session.
- **Shared handles.** If reattach on a shared handle fails, the run stops with `needs_attention` (§3.10). The per-path override uses the same option name and the same values, plus two values that only make sense for a shared working tree:

  ```ts
  run(factory, input, { runId, onInterrupted: { "<callPath>": 'fail' | 'resume-session' | 'restore-and-rerun' | 'skip' } });
  ```

  `'restore-and-rerun'` restores the pre-call checkpoint and runs the call again live. `'skip'` resolves the call to `null`. Both are rejected on calls that do not use a shared handle.

**Harness version.**
- The host resolves the version policy (`'tested'`, `'latest'`, an exact pin or a `harnessHold`) before the call starts, journals it, and passes only the exact string in `RuntimeSpec.harnessVersion` (§4.11). A resume always uses the version recorded with the session (§4.7).
- The runtime installs that exact version within a 60 s budget if the image has a different one. The fallback rules on a failed install are in §4.11.
- The version that actually ran is recorded in `ready` and in `Outcome`, because images change underneath long-lived sandboxes.

### 6.9 Ask answers and the inbox

In v1 the only messages delivered into a running call are answers to the agent's own `ask_human` calls (section 8). Unsolicited mid-run messages (`startAgent()`, `CallHandle.send()`, `interrupt`, live folding into a running turn) are deferred past v1 (§11, Q19 and Q35). HITL replies already reach the agent through `ask_human`. Any other follow-up is a new `agent()` call on the same branch and session.

**Hot ask flow (inside the sandbox).**
1. The agent calls `ask_human`. The supervisor records the ask in `state.json` and sets the call to `waiting`. It stops the idle and call clocks and sends an `ask` wake (6.6).
2. The host reads `pendingAsk` through `wait`, creates the ask record and waitpoint, and posts to the channels (section 8.4).
3. When the answer arrives, the host writes `inbox/<askId>.json` in one exec, as the agent user, and only while `inbox/.open` exists. Writing as root would follow a symlink the agent planted.
4. The supervisor renames the file to `<askId>.taken`. It returns the answer as the tool result, sets the call back to `running`, and restarts the clocks.
5. If the hot wait expires first, the host moves the call to a cold wait (section 8.4). The answer then arrives as the first user message of a resumed turn, not through the inbox.

**Delivery safety.**
- An answer counts as consumed only when the tool result has been returned, or when the resumed turn has started, and the turn that received it then succeeds. If that turn fails, is killed or times out, the answer stays pending and is delivered again on resume.
- A race can produce a duplicate answer. It never loses one.
- An answer for an ask that is not open in `state.json` is ignored with `skip [ask-not-open]`.

### 6.10 Cancellation

Cancellation can come from:
- an `AbortSignal` passed to `agent()` or `run()`;
- `selfbuilding cancel <runId>`;
- the host's own cancel (Inngest `cancelOn`, a Trigger run cancel, CF `terminate`).

**Sequence.**

1. The host writes `cancel_requested{callId, reason, at}` to the journal before any remote action, so a crash during the cancel still ends in `cancelled`.
2. The host writes the cancel sentinel (`<attemptDir>/cancel`, which is durable) with one exec. It is durable so that a cancel issued while a box is paused takes effect on resume.
3. The supervisor stops the harness:
   - It calls the harness's abort API when one exists (section 4). Otherwise it sends SIGINT to the process group.
   - It waits `timeouts.cancelGrace` (6.11). SIGINT goes first because some harnesses record nothing on SIGTERM (Claude exits 143 with no result).
   - It then sends SIGKILL to the whole tree through `ns-reap`.
4. The supervisor preserves the work. If the working tree differs from `HEAD`, it makes a WIP commit (6.13). If the call has a branch, the host pushes it once the harness tree has exited (§9.2). This is on by default. Turn it off with `lifecycle.preserveOnCancel: false`.
5. The supervisor writes `outcome{status:'cancelled', reason}`.
6. The host disposes of the sandbox according to its placement (6.14).

A call in `suspended` has no running harness. The host cancels its waitpoint and ask (section 8.5), marks the call `cancelled`, and applies disposition. It does not wake the box just to write the sentinel.

**Rules.**

- Cancel is idempotent. Cancelling a terminal call is a no-op that returns the existing outcome.
- When an `AbortSignal` caused the cancel, the promise rejects with `signal.reason`. There is no separate abort error class. The rejection carries the recovery fields from 6.7.
- Signals are accepted only on operations (`agent()`, `run()`), never on sandbox handle factories.
- Cancelling a durable host run does not stop a sandbox by itself. A running step is not interrupted, and some hosts never call cleanup on a hard timeout. Selfbuilding therefore does three things:
  - It registers a host-level cancel hook that kills by the `selfbuilding.run` label (templates in section 7).
  - It writes the cancel to the journal.
  - It relies on the reaper (6.14) as the backstop.
- The supervisor writes no "Stopping…" message or cancelled event until the signal has been delivered. A failed kill is logged with its stderr, and the cancel is retried on the next reconcile.

### 6.11 Timeouts (canonical)

This is the only timeout table in the spec. Sections 2.5.1, 3.4, 5.10, 7.7 and 8.4 reference it.

**One user-facing option.** Most users set only `timeout` in `AgentCallOptions` (§2.5.1). It replaces `timeoutMs` there. It is the active-time limit for the whole call, across all turns, and its default is `"2h"`. Factory defaults can set it too. Every other row is either derived from `timeout` or is an advanced override in the `timeouts` group.

| Timer | Option | Default | Counts | On expiry |
|---|---|---|---|---|
| Call | `timeout` | 2 h | active time (excludes `waiting`/`suspended`), all turns | interrupt, then `timed_out{reason:'timeout'}` with a WIP commit and the session id |
| Idle | `timeouts.idle` | `max(15 min, effective hotWait + 5 min)` | no harness output (events or bytes) during a turn. **Stopped while `waiting`.** | interrupt, then `timed_out{reason:'idle'}` |
| Setup hook | `timeouts.setup` | 20 min | the `setup` hook | `failed{reason:'boot'}`, naming the hook |
| Start hook | `timeouts.start` | 5 min | the `start` hook | `failed{reason:'boot'}`, naming the hook |
| Boot | `timeouts.boot` | 30 min | create to `ready` | `failed{reason:'boot'}`, naming the phase |
| Post-submit grace | `timeouts.postSubmitGrace` | 10 s, then SIGINT, then SIGKILL after 5 s (§4.5) | after a valid `submit_result` until the harness exits | stop the harness; status is still decided by the result |
| Exit quiet | (internal) | 60 s | harness exited but descendants hold stdout | kill the tree; outcome unaffected |
| Cancel grace | `timeouts.cancelGrace` | 10 s | SIGINT to SIGKILL on cancel or interrupt | SIGKILL |
| MCP tool call | (derived) | effective hotWait + 2 min | one `ask_human` call inside the harness | set in the harness config so the harness never abandons a hot wait |
| Sandbox lifetime | (derived) | `timeout` + 15 min | provider-side backstop. **Extended by the host on every reconcile and by the reaper on every sweep while the call is `waiting`** (§7.8), and by elapsed wait time. | provider pauses (preferred) or kills |
| Host wait | (derived, section 7) | `timeout` + 30 min | the host's wait on the call | collect probes once (§7.4.2) |
| Dead-run closer | (derived) | `running`, `booting`, `settling`: `timeout` + 1 h of active time, with no heartbeat for 10 min. `waiting`, `suspended`: `AskRecord.expiresAt` + 1 h. | reaper (6.14) | journal `failed{reason:'lost'}` and notify |

"Effective hotWait" is the call's hot-wait limit from section 8.4: `hitl.hotWait` (default 10 min), or for a call on a shared handle, the ask timeout capped at 30 min.

**Clocks pause while waiting.** When the call enters `waiting`, the supervisor stops the idle and call clocks. They restart when the answer is delivered. In `suspended` no harness runs, so nothing inside the sandbox counts. The host's derived deadlines (sandbox lifetime, host wait, dead-run closer) are shifted by the time spent waiting. Hot-wait time still counts toward the USD and sandbox budget (section 8.4). That is accounting, not a timeout.

**MCP tool timeout per harness.** The adapter sets the harness's own MCP tool-call timeout to effective hotWait + 2 min in the config it writes during the `harness` boot phase:

| Harness | Setting |
|---|---|
| Claude Code | `MCP_TOOL_TIMEOUT=<ms>` in the harness env, always set explicitly |
| Codex | `-c mcp_servers.selfbuilding.tool_timeout_sec=<s>` (the default is 60 s) |
| OpenCode | the `timeout` field of the `selfbuilding` MCP entry in `opencode.json` (to verify, §11, Q34) |
| Amp, Droid, Grok | the adapter's equivalent, or `mcpToolTimeoutMs: <fixed ms>` declared in its capabilities (§4.2) |
| Pi | none needed (extension tool, no MCP timeout) |

**`resolveTimeouts()` checks the chain** when the factory is built and again when each call is admitted. It throws `TimeoutOrderError` (a subclass of `ConfigError`), naming the two values, if any check fails:

1. `setup + start < boot`.
2. `postSubmitGrace < idle`.
3. `idle > effective hotWait`. Idle is stopped during waits, so this is defence in depth: a lost state transition must not let the idle timer kill a hot ask.
4. The harness's MCP tool timeout is greater than the effective hotWait. If an adapter declares a fixed timeout that is too low, hot waits for that harness are capped below it with a warning. If the harness also cannot resume, so it cannot use cold waits, the call is rejected.
5. `timeout + 15 min ≤ provider.limits.maxLifetimeMs`, unless the provider supports `extendLifetime`. Otherwise `run()` fails at plan time with an error naming the provider limit (section 7.7). The timeout is never clamped silently.

**Notes.**

- **Status after a submit.** A turn that hits post-submit grace after a valid submit still succeeds. Many harnesses keep talking after the result: Codex ignores a stop hint, and a background child can hold stdout.
- **Timed out is not failed.** `timed_out` keeps the session id, the branch and the WIP commit. The caller can continue with a new `agent()` call on the same branch, using the error's `recovery` data (§9.8).
- **Provider lifetime.**
  - At launch the host sets the provider lifetime to `timeout + 15 min` in one call (E2B `setTimeout`, Vercel `extendTimeout`, and so on; section 5).
  - The host extends it on every reconcile, and the reaper on every sweep (§7.8), while heartbeats are less than 60 s old or the call is `waiting`.
  - The sandbox cannot extend its own lifetime, because it holds no provider credential.
- **Host limits are separate.** A host's own limits (Trigger `maxDuration`, Workflow step CPU) bound the orchestrator, not the agent.
- **Pause on expiry.** Sandboxes that may be resumed (shared handles, and calls that can cold-ask) are created with `onTimeout: 'pause'` where the provider supports it. A provider default of `kill` destroys the session transcript.
- **Typed errors.** Each timer raises its own error: `HookTimeoutError{hook}`, `BootTimeoutError{phase}`, `IdleTimeoutError`, `CallTimeoutError`. The durable layer (section 7) can then retry boot failures and leave call timeouts alone.
- **Required test (section 10).** A scripted-harness test runs a 10-minute hot wait under fake timers, with default settings. It asserts four things:
  - no idle interrupt fires;
  - the call stays `waiting`, and its active time does not advance;
  - the harness's configured MCP tool timeout is above 10 minutes;
  - the answer returns as the tool result.

  A second case does the same on a shared handle with a 30-minute hot wait.

### 6.12 Settling and artifacts

Settling starts when a turn ends, with or without a valid result.

1. **Result check.**
   - If no valid result exists, the supervisor resumes the session once with "You must call submit_result" (section 2). If there is still no result, the outcome is `failed{reason:'no_result'}`.
   - A stream `error` event fails the turn even when the CLI exits 0.
2. **Done checks** run (section 2). A failed check feeds back as a new turn, bounded by `maxDoneRetries`.
3. **Leftover commit** (6.13). The supervisor does not push. The host pushes in its collect step, after the harness process tree has exited (§7.4.3, §9.2).
4. **Artifacts.** These are uploaded to the host's artifact store (section 7) before the sandbox is disposed of, because a disposable sandbox's disk is the only copy.
   - `diff`: the `--stat` inline in the result, and the full patch as an artifact, capped at 5 MiB, with any truncation stated.
   - `transcript`: the redacted `events.jsonl` plus the harness's native session file (section 4). Both are redacted before upload (section 9).
   - `logs`: `runtime.log`, `hooks/*.log`, and the tail of `harness.stderr.log`.
   - `git`: `{branch, baseSha, headSha, pushed}`. The host fills `pushed` after its push, and `pr?: { url, number, draft }` after accept opens the PR (§7.4.4).
   - `usage`, `harnessVersion`, the `sandboxId` and the generation.
5. **Outcome.** The supervisor writes `outcome.json` and sends the `outcome` wake.
6. **Acknowledgement.** On reconcile, the host stores the outcome under a unique `(callId, attempt)` key and then runs `selfbuilding-runtime ack --call … --attempt …`. The runtime deletes nothing before the ack. An unacknowledged outcome triggers a wake again on the next contact.
7. The host applies the disposition (6.14).

**Size caps.**
- The host re-validates `result` against the Zod schema.
- The serialised result is capped at **256 KiB** by default. `maxResultBytes` can raise it to at most 1 MiB. This is the same cap as section 2.4.2.
- Event lines are capped at 16 KiB.
- Paths reported by the sandbox are never used to write on the host without containment checks.

### 6.13 Git strategy

**Transport.**

| Mode | When | In | Out |
|---|---|---|---|
| `remote` (default) | every cloud provider, and Docker when the repo has a remote | `git clone --filter=blob:none` or `fetch` into `/selfbuilding/work`, using a short-lived, read-only, repo-scoped token from the credential helper (section 9) | the host's `git push` of the call branch, run in collect (§9.2) |
| `local` | Docker with `source: { localPath }`, for unpushed local work | Host runs `git bundle create --all`; the bundle is copied in and cloned | Sandbox runs `format-patch base..HEAD`. The patches are saved to `.selfbuilding/patches/<stepKey>/` on the host first, then applied with `git am --3way` onto the call branch in a host worktree. |

Rules for `local` mode:

- Host-side git runs with hooks disabled (`core.hooksPath=/dev/null`). It also ignores repo config that names a program: fsmonitor, filters, diff and merge drivers, and credential helpers.
- Every patch path is checked to stay inside the worktree and outside `.git`.
- A failed apply keeps the patch directory and prints the commands to recover.
- The sandbox keeps the local-only ref `refs/selfbuilding/local/base` and moves it forward after each successful sync-out, because `git am` rewrites SHAs. This ref is never pushed.

**Names: one function in core.** Every branch and ref Selfbuilding creates comes from these two functions in `@selfbuilding/core`. Sections 2.8.2, 3.9, 3.10 and 3.11 call them and do not spell out names of their own. Both use the **full** run id (`ns_` plus a 26-character ULID), so names from runs started close together never collide.

```ts
export function branchName(runId: string, scope: string): string;
//   → `selfbuilding/<runId>/<scope-slug>`
//   scope: the callPath for a fresh-per-agent call, or the handle label / boxId for a shared handle.
//   slug: lowercase, every run of [^a-z0-9] → "-", trimmed, "root/" prefix dropped.
//   Longer than 60 chars → first 53 chars + "-" + 6 hex chars of sha256(scope).
//   e.g. runId "ns_01jb7k…q4x9m2ra", callPath "pipeline#0/[issue-412]/stage#1/ImplementSpec#0"
//        → "selfbuilding/ns_01jb7k…q4x9m2ra/pipeline-0-issue-412-stage-1-implementspec-0"

export function checkpointRef(runId: string, boxId: string, version: number): string;
//   → `refs/selfbuilding/<runId>/<boxId-slug>/<version>`
//   The mid-turn WIP ref is `refs/selfbuilding/wip/<runId>/<stepKey>` (§3.11, §5.8).
```

**Branch per call.**

- The name is `branchName(runId, callPath)`. It is deterministic, so a retry, a resume or a replay reuses the same branch. A shared handle uses `branchName(runId, handleLabel)` for all its calls.
- `git.branch` overrides the name. A custom name must still be inside the push allowlist below, or listed in `git.allowPushTo`.
- `box.push()` with no argument has the host push the handle's `branchName` at the call boundary (§3.11).
- The base is `git.baseBranch`. If that is unset, it is the parent's branch when the factory passes one (section 3). Otherwise it is the repo's default branch. `baseSha` is recorded at checkout.
- Calls on a shared handle are serialised by `call.lock`. A second concurrent call is rejected with `SandboxBusyError` (§3.11).

**Push allowlist.**
- The host's push exec pushes only to `refs/heads/selfbuilding/**` (branches from `branchName`) and `refs/selfbuilding/**` (checkpoints from `checkpointRef`), plus any ref named in `git.allowPushTo`. It refuses everything else before contacting the remote.
- It never force-pushes a branch it did not create. It uses `--force-with-lease` on its own branches.
- The repository ruleset recommended in section 9.2 allows agent branch pushes to `selfbuilding/**`. GitHub branch rulesets do not apply to non-branch refs, so `refs/selfbuilding/**` is guarded by this in-sandbox allowlist, together with the token scoped to one repository.

**Who commits.**

- The agent commits as it works.
- At settle, the supervisor commits any leftover tracked or untracked changes, excluding ignored files, as one commit: `selfbuilding: uncommitted changes from <agent>`. Turn this off with `git.commitLeftovers: false`.
- On cancel or timeout, the same kind of commit is made with the subject `selfbuilding: WIP (<reason>) from <agent>`.

**Attribution.**

- The identity is set through the `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` env vars on the harness process. Env vars override repo config, global config and `-c`, so an agent cannot invent an author.

  | `git.identity` | Author | Committer | Default for |
  |---|---|---|---|
  | `'agent'` | bot identity | bot identity | AFK runs |
  | `{ mode: 'attributed', name, email }` | the human who started or approved the run | bot identity | runs started from a human message |

- The supervisor adds trailers to every commit it makes. A `prepare-commit-msg` hook, which the runtime installs in a read-only hooks dir, adds them to the agent's commits:

  ```
  Selfbuilding-Run: <runId>
  Selfbuilding-Call: <callId>
  Selfbuilding-Agent: <AgentName>
  ```

- The harness's own attribution text is disabled (Claude settings `attribution: { commit: "", pr: "" }`), so commits look the same on every harness.
- Commit signing is optional and is done by a host-side signer (section 9). The key never enters the sandbox.
- `GIT_TERMINAL_PROMPT=0` is always set.

**Push verification.** After pushing, the host runs `git ls-remote origin <branch>`. It records `pushed: true` only if the remote SHA equals local `HEAD`. A result that claims a branch that was not pushed fails the default done check (section 2).

**Pull requests.** PRs are opened by the host in accept (§7.4.4), never inside the sandbox. The per-call option is `pr: boolean | PrOptions` in `AgentCallOptions`, and `PrOptions` is defined once, in §2.5.1. The defaults: no PR for `agent()`, a draft PR in the default pack's `ImplementSpec`; the title defaults to `prTitle` from the result, else `${agentName}: ${r.summary.slice(0, 72)}`; the body defaults to `prBody` or the summary, the diff stat, the run link and the trailers.

- The order of operations is: verify the push, look up an existing open PR for the head branch, create or update it, then record `pr: { url, number, draft }` in the artifacts.
- In v1, PRs are authored by the configured GitHub App. Unattended work belongs to the bot, and a human can approve it.
- The agent can still use `gh` for reading, through its read-only credential (section 9). Review comments are posted by the host (`postReview()` in `@selfbuilding/channel-github`), never by the agent.

### 6.14 Disposition, parking and the reaper

A sandbox leaks whenever a process dies between "created" and "disposed". Selfbuilding ships leak handling in v1.

**Disposition after a call.**

| Placement (section 3) | Success | Failure, cancel or timeout |
|---|---|---|
| Fresh per agent (default) | `kill` | `kill` after artifacts are uploaded. `lifecycle.keepOnFailure: '1h'` parks instead, for debugging. |
| Shared handle | keep; parked by the idle rule below | keep |
| Cold ask (section 8) | `park` while `suspended`, never kill | n/a |
| Fork or child sandbox | `kill`, never park | `kill` |

**Create path.**

- The registry row (journal store, section 3) is written before `create`.
- Everything after `create` is wrapped, so that a setup failure kills a fresh sandbox instead of leaving it running and billing until the provider timeout.
- A create whose response was lost is resolved by label lookup, not by a second create.

**Parking.**

- Shared handles are parked when their owner has been quiet for `idleParkMs` (default 5 min). They are not parked at the end of each turn, because then every follow-up would pay for a resume.
- Cold-ask sandboxes are parked when the call enters `suspended` (section 8.4).
- The pause is sent by id, never through a connected handle, because connecting resumes a paused sandbox on several providers.

**Reaper.**

`reap()` is exported from `@selfbuilding/core`. Section 7 ships a scheduled template per host: a Trigger schedule, an Inngest cron, a CF cron trigger, and `selfbuilding reap --every 2m` for local use. Each sweep scans the world instead of reacting to events. The per-box decision table, including the rules that hold boxes for `waiting` and `suspended` calls and the dead-run closer, is defined once in §5.9. The host-side duties (lifetime extension, repairing lost callbacks, cancel sentinels for stale launches) are in §7.8. The rules below govern how any of them may pause or destroy a box.

**Rules.**

- **The lock tracks the turn.** The only signal that may freeze a sandbox is the in-sandbox turn lock:

  ```
  if flock -n /run/selfbuilding/call.lock true; then echo FREE; else echo BUSY; fi
  ```

  BUSY is checked before FREE, so garbled output resolves to BUSY. Observability tables, last-event timestamps and the provider's `state` never decide a pause. A wrong FREE loses a turn. A wrong BUSY only leaks for one more sweep. A hot ask holds the lock, because the harness is still in its turn, so the probe reads BUSY.
- **Pause is serialised against new work.** The reaper takes the same per-owner lease that admission takes (section 7). It re-checks quiescence, sends the pause, and releases the lease once the pause has started.
- **Destroy needs positive evidence.** A sandbox is killed only in two cases:
  - The journal says the call is terminal, or lost by the closer rule above, and the sandbox is owned by this deployment.
  - The sandbox is a confirmed orphan.

  A provider timeout, a 5xx, a 409 or "listing failed" means unknown, and unknown never kills.
- **An outage is not "nothing running".** `list()` rethrows `SandboxUnavailableError`, and the sweep reports itself as failed instead of clean.
- **A pause refusal is a typed outcome.** Pause returns `{confirmed, reason}` (section 5). A refused pause is logged at error level on every sweep while it persists. The reaper may shorten the provider TTL to 60 s only with an evidence token: the sandbox id has just probed FREE, the probe is less than 10 s old, and the status is on the allowlist.
- **Alarms repeat.** The metrics `selfbuilding.sandboxes.{running,parked,leaked}` and a `reaper.leak` event are emitted on every sweep while the condition holds, not only when it first appears.
- **The concurrency cap counts what the provider bills.** The sandbox concurrency cap (section 3) counts provider `running` sandboxes from the registry, not active agent calls. A sandbox stuck running after a refused pause still holds a slot until the reaper clears it.

### 6.15 Runtime failure handling

- **Crash handlers.**
  - `uncaughtException` and `unhandledRejection` handlers are installed before any other module code runs.
  - They write one `FATAL` line to `runtime.log`, then try to write `outcome{status:'failed', reason:'harness_error'}`, then exit.
  - The reporter cannot throw.
- **Exit codes.**

  | Code | Meaning |
  |---|---|
  | `0` | settled, or reattached (6.8) |
  | `75` | transient infrastructure failure; the host may retry boot |
  | `76` | runtime generation mismatch; the host re-provisions the runtime bundle |
  | `78` | deterministic configuration failure (missing harness binary, auth absent, invalid spec, `TimeoutOrderError`); the host does not retry and surfaces the cause |

- **Harness restarts.** The supervisor does not restart a harness that crashes mid-turn. The turn becomes `interrupted` and `onInterrupted` applies (6.8), so side effects are never repeated behind the caller's back.
- **Liveness.** The supervisor's timer writes the heartbeat, not the harness, so a heartbeat proves the runtime is alive. Harness liveness is the idle timer.
- **Testing.** The runtime is smoke-tested in CI in a throwaway HOME, with the same credential files and env shape that real sandboxes get (section 10). Code paths that only real sandboxes reach are where silent failures hide.

### 6.16 Public surface added by this section

There is one options type per call: `AgentCallOptions`, defined once in §2.5.1. `CodeReview(input, opts)` and `agent({ ..., ...opts })` both take it. This section owns the behaviour of these fields of it:

| Field | Behaviour |
|---|---|
| `timeout`, `timeouts` | 6.11. `timeout` defaults to `"2h"` of active time; `timeouts` holds `{ boot, setup, start, idle, postSubmitGrace, cancelGrace }` |
| `signal` | 6.10 |
| `onInterrupted` | 6.8. Per call: `'fail'` (default) or `'resume-session'` |
| `git` | 6.13. `{ branch, baseBranch, commitLeftovers, identity, allowPushTo }` |
| `pr` | 6.13. `boolean | PrOptions` |
| `lifecycle` | 6.10, 6.14. `{ preserveOnCancel (default true), keepOnFailure (default false) }` |

The run-level `onInterrupted` in `RunOptions` (§3.3) also accepts a per-`callPath` record of `InterruptedPolicy`, where `'restore-and-rerun'` and `'skip'` are valid only for calls on shared handles (6.8).

The core exports `branchName()` and `checkpointRef()` (6.13) and `reap()` (signature in §5.9). `reap()` resolves a `ReapReport { killed, parked, held, leaked, errors }`; "0 killed" with errors is reported as such.

`startAgent()`, `CallHandle`, `send()` and `interrupt` are not in v1 (§11, Q19 and Q35).

### 6.17 Open questions

Moved to §11 (Q16, Q34, Q35, Q46, Q47, Q48).

## 7. Durability, hosts and deployment

This section explains how a Selfbuilding run survives crashes, deploys and long waits. It covers:
- the adapters for Trigger.dev, Inngest and Cloudflare Workflows;
- how one `agent()` call maps onto durable steps and one wait for a callback;
- how a run resumes after a terminal failure;
- the thin control plane planned for later;
- three deployment guides.

Other sections own the neighbouring pieces:
- §3 defines the step key, the journal entry, the replay prefix rule and the local journal store.
- §5 defines the sandbox provider contract.
- §6 defines the in-sandbox runtime and the timeout chain (§6.11). The runtime writes `outcome.json` and sends the completion callback.
- §8 defines `ask()` and the channel adapters.
- §9 covers credentials, redaction and failure observability.

This section owns host mechanics. Where §3, §6 or §8 describe how a host waits, batches or retries, they refer here. Timeout defaults live only in §6.11.

### 7.1 Principles

1. **Each replay question has exactly one owner.** Two questions come up, and each has its own owner.
   - **Inside one host run,** the host decides what replays. On Inngest and Cloudflare Workflows that is the step memo. On Trigger.dev it is the child-run idempotency keys plus the run's result store (§7.10). Trigger.dev has no in-run memo for anything that is not a child run.
   - **Across host runs,** meaning a resume after a terminal failure (§7.6), the result store decides. It serves successes only.
   - On plain Node, the local journal from §3 answers both questions.
   - Selfbuilding never stacks two systems on the same question.
2. **`run()` is stateless.** Everything needed to continue lives in the host (or the local journal), the result store, the sandbox provider, git remotes and the artifact store. A redeploy, crash or new process continues from the run id.
3. **The sandbox is the worker; the orchestrator only waits.** An agent turn can run for hours, and no orchestrator process stays busy while it runs. The orchestrator starts the harness detached, suspends on one host wait, and wakes on a callback.
4. **Persist intent before every remote call.** A provider timeout or a lost response means the outcome is unknown, not that it failed. An unknown outcome never destroys anything and never triggers a blind relaunch.
5. **Never silently replay an interrupted agent turn.** Restoring files cannot roll back a push, a PR comment or a Slack message. Replay returns only completed results. A turn cut off in the middle surfaces as an error that carries its recovery data. It is resumed only if the caller opted in (§7.6).
6. **Failures are values inside a run and are never cached across runs.** Within one host run, a failed agent call replays as the same `{ ok: false }` value, because the factory has already branched on it. A resume starts a new epoch (§7.6), and every call that did not succeed runs live again. This is how hosted runs meet §3.9's rule that failures are never cached.
7. **Only the current generation may act.** Every launch of a step gets a fence record (§7.4.5). Push credentials, PR updates and outcome acceptance all go only to the launch the fence names.
8. **Do not trust timers alone.** A timer acts on an event, and a missed or duplicated event leaves a sandbox that nobody cleans up. Every deployment also runs a reaper that scans the actual state of the world (§7.8).

### 7.2 Identifiers

These formats are legal on every host. Cloudflare's rules for instance ids and event types are the strictest: at most 100 characters matching `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. No identifier below contains `.` or `:`, except the Trigger idempotency keys, which have no such limit.

```ts
type RunId    = `ns_${string}`;   // "ns_" + lowercase ULID, 29 chars. Valid CF instance id.
type Epoch    = number;           // 0 on the first host run; +1 per resume after a terminal failure (§7.6)
type StepKey  = string;           // base32(sha256(callPath | skillHash | inputHash)).slice(0, 26), see §3
type HostKey  = `${StepKey}_e${Epoch}`;                 // what host step ids and idempotency keys are built from
type LaunchId = `${HostKey}_l${number}`;                // one launch attempt; written into the sandbox before exec
type CallPath = string;           // structural, e.g. "pipeline#0/[issue-412]/stage#1/ImplementSpec#0" (§3.2)
```

Rules:
- The call path comes from program structure: the item index, and a counter local to each branch. It never comes from completion order. If it did, two concurrent branches that finish in a different order on replay would swap keys.
- `skillHash` is part of the step key (§2), so editing a skill invalidates the cached result for that call. There is no option to pin old results across a skill edit in v1.
- The launch attempt counter goes up for each new turn of the same call that needs its own sandbox wait. That covers a session resume, a host-side check retry (§7.4.4), a continuation onto a new box (§7.7) and a cold-ask relaunch (§8). The counter is derived from replayed values only, so replay reproduces it.
- Wherever a host limits a key's size or alphabet, Selfbuilding derives that key from `HostKey` or `LaunchId`. This applies to a CF event type, a Trigger idempotency key and an Inngest step id.

### 7.3 The host adapter contract

```ts
export interface DurableHost {
  readonly id: "node" | "trigger" | "inngest" | "cloudflare-workflows";
  readonly limits: HostLimits;
  readonly epoch: Epoch;

  /** Run fn at most once to completion per key within this epoch. On replay, return the stored value. */
  step<T extends Json>(key: string, fn: () => Promise<T>, opts?: StepOpts): Promise<T>;

  /**
   * Suspend until a callback for `launchId` arrives or `timeoutMs` passes.
   * `register` receives a host-specific target (URL, event type, token) and must
   * hand it to the sandbox before the wait begins. `rearm` is 0 for the first wait
   * and +1 for each re-arm after a premature wake (§7.4.2).
   */
  waitForCallback<T extends Json>(
    launchId: LaunchId,
    opts: { timeoutMs: number; rearm: number; register: (target: CallbackTarget) => Promise<void> },
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" }>;

  sleep(key: string, ms: number): Promise<void>;

  /** Run independent branches concurrently. Plain Promise.all works on every host (§7.5.1). */
  all<T>(branches: Array<() => Promise<T>>): Promise<T[]>;

  /** Nested factory (one level deep, §3) as a child run on the host. Never a blocking wait in the parent. */
  child<I, O>(key: string, factory: FactoryRef<I, O>, input: I): Promise<O>;
}

export interface HostLimits {
  maxStepOutputBytes: number;   // larger values go to the artifact store by reference
  maxStepsPerRun?: number;      // checked at plan time with the estimator in §7.5.2
  maxWaitMs?: number;
  parallelWaits: boolean;       // false on Trigger.dev; the parent scheduler multiplexes (§7.5.1)
}

export type CallbackTarget =
  | { kind: "url"; url: string; headers?: Record<string, string> }  // Trigger token URL, control plane, local listener
  | { kind: "event"; endpoint: string; eventKey: string; token: string }; // Inngest / CF via a Selfbuilding handler
```

Factory authors never touch `DurableHost`. `agent()`, `pipeline()`, `parallel()`, `phase()` and `log()` (§3) call it. The core primitives `step()`, `now()`, `random()` and `uuid()` (§3.7) are the public way to record side effects that are not agents:

```ts
import { step, now, uuid } from "@selfbuilding/core";

const sha = await step("resolve-base", () => git.revParse("origin/main"));
const at  = now();     // replay-stable clock
const id  = uuid();    // replay-stable id
```

How each host stores these values:

| Primitive | Plain Node | Trigger.dev | Inngest | CF Workflows |
|---|---|---|---|---|
| `step()`, `exec` on a shared handle, checkpoints | local journal | result store, written with CAS (§7.5.1) | `step.run` memo, plus a success copy in the result store | `step.do` memo, plus a success copy in the result store |
| `now()`, `random()`, `uuid()` | local journal | result store, as `clock` records | inside a `step.run` | inside a `step.do` |

The success copies on Inngest and Cloudflare are read only when a new epoch starts (§7.6). Inside one host run, the memo decides.

**Determinism rule.** On every hosted adapter, the factory code between durable calls runs again on replay. Calling `Date.now()`, `Math.random()`, `fetch` or the filesystem directly in a factory is therefore a bug. In development mode Selfbuilding checks each replayed call against the recorded one. A mismatch in call path or input hash raises `JournalDivergenceError`, which shows the recorded call and the new call side by side.

**Orphan sweep.** Replay after a code edit or a non-deterministic bug can leave launched work that the new replay never visits. The sweep runs at two points: when the factory body settles (returns, throws or is cancelled), and before a new epoch starts. It does three things:
1. It cancels every registered child run (Trigger) whose host key was not visited.
2. It writes the cancel sentinel (§6.10) into every sandbox labelled with this run whose host key was not visited.
3. It kills those sandboxes once their turn lock reads `FREE`, or once they are positively gone.

The sweep emits `orphan.cancelled { hostKey, childRunId?, sandboxId? }` for each one. A report alone is not enough, because orphans keep billing.

### 7.4 How one `agent()` call becomes durable

Every `agent()` call becomes the same four-part group on every host.

```
launch  (host step)  ── check outcome records, advance the fence, acquire sandbox,
   │                    stage skill + input, start harness detached → LaunchRecord
wait    (host wait)  ── one long wait keyed on launchId (or timeout)
   │
collect (host step)  ── serialisable work only: read outcome.json + result.json, re-check the
   │                    JSON Schema and size caps, upload artifacts, write the outcome record → RawOutcome
accept  (host side)  ── work that needs the factory's closures: authoritative Zod parse (refinements,
                        transforms), `assert` done checks, Agent.with() patches, PrOptions title/body,
                        open or update the PR, write the final record, then dispose the sandbox → AgentOutcome
```

On Inngest and Cloudflare Workflows, accept runs inside the collect step, because the factory's closures are in scope there. On Trigger.dev, collect runs in the child task and accept runs in the parent (§7.5.1). On plain Node both run in-process.

```ts
interface LaunchRecord {
  launchId: LaunchId;
  sandbox: SandboxRef;            // plain JSON, reopenable by id (§5)
  process: { pid?: number; cmdId?: string };
  sessionId?: string;       // pre-assigned where the harness allows it (§4)
  deadline: string;               // ISO wall-clock deadline for this turn
}

interface AgentCallback {
  v: 1;
  runId: RunId;
  stepKey: StepKey;
  launchId: LaunchId;
  status: "submitted" | "no_result" | "failed" | "timeout" | "stopped" | "lost" | "finished" | "ask";
  rearm: number;                  // the armed wait this callback answers (§7.4.2)
  source: "runtime" | "reaper" | "cancel";
  at: string;
}

/** What collect returns. Serialisable; no closure has run yet. */
type RawOutcome =
  | { ok: true; launchId: LaunchId; result: unknown; artifacts: AgentArtifacts; usage: Usage; sessionId?: string }
  | { ok: false; launchId: LaunchId; error: SerializedSelfbuildingError };

type AgentOutcome<O> =
  | { ok: true; result: O; artifacts: AgentArtifacts; usage: Usage }
  | { ok: false; error: SerializedSelfbuildingError };   // carries branch, commits, sessionId, sandbox, snapshot
```

#### 7.4.1 Launch is idempotent

Launch can run more than once: after a host retry, after a Trigger child retry, or after a crash between starting the harness and returning. It goes through these steps in order:

1. **Check the lease** (plain Node only, §3.9, §7.5.4). Abort if the `leaseEpoch` is stale.
2. **Check for a recorded outcome.** Read `outcomes/<runId>/<launchId>.json` from the result store. If it exists, return it straight to accept. Do not create or start anything.
3. **Advance the fence** if this is a new launch attempt (§7.4.5).
4. **Look up the sandbox** by the label `selfbuilding.step=<hostKey>`. Labelling is described in §5. Cloudflare has no listing, so it uses the registry instead (§7.10).
5. **If a sandbox is found,** read its markers:
   - If `/selfbuilding/state/launches/<launchId>.collected` exists, an earlier collect got past its outcome write. Go to collect, which finds the record or rebuilds it idempotently from the sandbox.
   - If `/selfbuilding/state/launches/<launchId>.launched` exists, reattach to the running process and return the stored `LaunchRecord`. Do not start a second harness.
6. **If the lookup is a positive not-found and there is no outcome record,** create a sandbox. Placement rules are in §3. The new sandbox carries the labels `selfbuilding.run`, `selfbuilding.step`, `selfbuilding.launch` and `selfbuilding.hostRun`.
7. **Start the harness.** Write the `.launched` marker atomically, then start the harness through the detached-exec path from §6.

Launch never retries a detached start whose outcome is unknown. If the provider call that starts the process times out, launch re-probes for the marker. It does not exec again. An unknown lookup result (a timeout, a 5xx) is never treated as not-found.

#### 7.4.2 Wait: one long wait per launch

Every host waits once per launch. The wait is keyed on `launchId`, never on `stepKey`. A completed wait from an earlier launch of the same step therefore can never release a later launch.

| Host | Wait | Key |
|---|---|---|
| Trigger.dev (child) | `wait.forToken(token, { timeout })` | token `idempotencyKey: ns:${runId}:${launchId}:done:w${rearm}` |
| Inngest | `step.waitForEvent` | step id `wait:${launchId}:w${rearm}`, match on `async.data.launchId` |
| CF Workflows | `step.waitForEvent` | step name `wait:${launchId}:w${rearm}`, event type `cb-${launchId}-w${rearm}` |
| Plain Node | `selfbuilding-runtime wait` long-poll over exec (§6.6), which reads `/selfbuilding/state/launches/<launchId>.status` | `launchId` |

The timeout is the call's `timeout` plus 30 min (§6.11, §7.7). A callback with status `ask` releases the wait so the host can handle the ask (§8.4); the host then re-arms with `rearm + 1`, and ask re-arms do not count against the cap below. A callback can come from three places:
- The in-sandbox runtime (§6). It sends the callback once `outcome.json` is written for the launch. It retries with backoff until it gets a 2xx.
- The reaper (§7.8). It sends `lost` when the sandbox is positively gone. It sends a synthetic `finished` when it finds `outcome.json` for a launch whose wait is still open, which means the runtime's callback was lost.
- Cancellation (§7.9).

There are no reconcile ticks inside the wait. A lost callback is repaired by the reaper within one sweep (2 minutes), not by polling from the host.

**The callback is a hint.** Before collecting, collect checks the sandbox:
- `outcome.json` exists for this `launchId`: collect.
- The turn lock is `FREE` and there is no `outcome.json`: the turn is interrupted (§7.6).
- The lock is `BUSY` or `UNKNOWN`: the wake was premature or stale. Re-arm with `rearm + 1` and the remaining timeout.

Premature re-arms are capped at 3 per launch. A fourth premature wake is treated like a wait timeout.

If the wait times out, collect probes the sandbox once:
- **Turn finished but the callback was lost:** collect normally.
- **Still running:** stop the harness through the cancel sentinel, wait for `outcome.json` (status `timed_out`), then collect it.
- **Probe result unknown:** return `AgentInterruptedError` and leave the sandbox alone. A later relaunch goes through the fence (§7.4.5).

#### 7.4.3 Collect writes its outcome before anything is released

Collect must be safe to run twice, including after a crash at any point. It runs in this order:

1. If `outcomes/<runId>/<launchId>.json` exists, return it.
2. Read `outcome.json` and `result.json`. Re-check the JSON Schema and the size caps (§6.12). Done checks of the `cmd` and `judge` kinds have already run in the sandbox (§6.12). They are strings and rubrics, so they serialise.
3. Upload the transcript, diff, logs and large results to the artifact store. Keys are content-addressed, so a second upload is a no-op.
4. Write the outcome record `outcomes/<runId>/<launchId>.json` with create-if-absent (CAS). If the CAS loses, return the stored record.
5. Write the `/selfbuilding/state/launches/<launchId>.collected` marker and send the runtime `ack` (§6.12).

Collect never kills, parks or releases a sandbox. Disposal belongs to accept, after the final record is durable. A failure in step 3 or 4 is an infrastructure fault: it throws, and the host retries the step. A failure in step 5 is logged and does not throw, because the outcome record already exists.

If the outcome is larger than `limits.maxStepOutputBytes`, it is stored by reference: `{ ref: "artifact://..." }`. The cut-off is 256 KiB inline on every host, so behaviour does not change when you move between hosts.

#### 7.4.4 Accept runs the closures

Accept runs where the factory's code is loaded. It works through these steps:

1. Parse `result` with the agent's full Zod schema, including refinements and transforms (§2.6.3).
2. Run `assert` done checks (§2.7.1), including those added by `Agent.with()` patches.
3. **If a host-side check fails and retries remain** (`maxResumes` for a parse failure, `maxDoneRetries` for an assert), start a new launch attempt. It uses the same sandbox and resumes the native session with the feedback message from §2. The sandbox is still alive, because collect did not dispose of it.
4. **If everything passes,** or retries are exhausted, build the `AgentOutcome`. Render `PrOptions.title` and `body` (§6.13). Open or update the PR, but only if this launch is the current fence.
5. Write the final record:
   - every outcome, `ok` or not, goes to the epoch-scoped accept record `runs/<runId>/e<epoch>/accepted/<stepKey>.json`;
   - successes also go to the cross-epoch cache `runs/<runId>/cache/<stepKey>.json`.
6. Only then, dispose of the sandbox according to placement (§6.14).

On Inngest and Cloudflare, the step memo makes step 5 redundant inside one run. The success copy is still written, because a later epoch needs it.

**Agent-level failures are values, not host failures.** Accept returns `{ ok: false }` for a failed done check, a missing `submit_result`, an interrupted turn or a budget stop. The host step succeeds, so the host never retries a turn that ran and failed, which would repeat its side effects. Only infrastructure faults throw and get retried by the host: a provider 5xx, a rate limit (429), or a failed write to the artifact or result store.

Failure values are scoped to the current epoch. They never enter the cross-epoch cache, and a resume re-runs them live (§7.6).

#### 7.4.5 Fencing launch generations

Two launches of the same step can be alive at once. For example, an unknown probe result leaves the old turn running, and `resume-session` or a new box starts another one. Both would push to the same deterministic branch. The fence makes sure only the newest launch can act.

```ts
interface FenceRecord {
  hostKey: HostKey;
  current: LaunchId;               // the only launch allowed to push or be accepted
  branch: string;
  expectSha: string | null;        // remote head when the fence advanced; the push lease expectation
  superseded: LaunchId[];
}
```

1. **Advance before launching.** Before every new launch attempt, launch writes the fence with CAS: `fences/<runId>/<hostKey>.json` on hosted runs, or the journal on plain Node. It records the new `launchId` and the branch's current remote SHA.
2. **Push credentials follow the fence.** The git credential broker (§9.2) mints and refreshes a push token only for the `launchId` the fence names. When the fence advances, the host revokes the superseded launch's installation token. Revocation is immediate on GitHub, so the old token cannot outlive the hour it was minted for.
3. **The push lease uses the fence.** The runtime pushes with `--force-with-lease=<branch>:<expectSha>`. A stale launch that still holds a token loses the lease once the current launch has pushed.
4. **Accept follows the fence.** Accept opens or updates a PR only for the current launch. An outcome from a superseded launch is recorded as `late_outcome` (§6.7) and ignored. Any branch it managed to push is listed in the event.
5. **The old box is told to stop.** The reaper writes the cancel sentinel into every sandbox labelled with a superseded `launchId` as soon as that box is reachable. It keeps trying until the box is reachable or positively gone.

### 7.5 Host adapters

#### 7.5.1 Trigger.dev v4 (`@selfbuilding/host-trigger`), first and the dogfood host

Trigger.dev keeps a run durable by checkpointing and restoring the process at waits. A crash or a task retry between waits starts a new attempt that runs the task from the top. Trigger.dev has three properties that shape this adapter:
- Child runs are memoized through idempotency keys.
- There is no in-run `step.run` memo.
- A run may hold only one wait at a time. A `Promise.all` over `wait.*` or `triggerAndWait` throws.

This is the only Trigger design: **fire-and-forget children, one wake input stream, and reconciliation through `runs.retrieve`.** No batch API is used. Batching would break `pipeline()`'s no-barrier contract, because a batch wait returns only when the whole batch is done.

**Parent task `selfbuilding.factory`.**

- **No `agent()` call is a wait in the parent.** `agent()` triggers its child and returns a promise held by an in-process scheduler. Plain `Promise.all` over `agent()` calls, `parallel()`, `pipeline()` and any other concurrency the factory writes therefore all work on Trigger.
- **The scheduler holds the parent's single wait.** Whenever every pending promise is blocked, it suspends on one input stream (SDK 4.4.2 or later):

  ```ts
  type Wake =
    | { kind: "child"; hostKey: string; childRunId: string }  // agent or nested factory finished
    | { kind: "ask"; askId: string }                          // factory-side ask() answered (§8)
    | { kind: "tick" };                                       // sent by the reaper after it repairs something

  const wake = streams.input<Wake>({ id: "selfbuilding.wake" });
  await wake.wait({ timeout: min("10m", nextSleepDeadline) });
  ```

  After every wake or timeout, the scheduler reconciles. It checks `runs.retrieve(childRunId)` for every child in flight and `AskStore.get(askId)` for every open ask. The child status and the ask record are the truth; the wake is only a hint. A lost wake costs at most one 10-minute delay. Trigger waits do not count toward any step limit, so this reconcile timeout is free.
- **Every parent-side suspension goes through this one stream.**
  - `agent()`: the child sends `{ kind: "child" }` to its parent run id when it finishes.
  - **Nested factories:** the parent triggers `selfbuilding.factory` without waiting and registers it as a child. It never uses `triggerAndWait`.
  - **Factory-side `ask()`:** the channel handler writes the resolution to the `AskStore` first (§8.5), then sends `{ kind: "ask", askId }` on the parent's stream. It does not complete a separate waitpoint token in the parent, so concurrent factory-side asks work on Trigger.
  - **`sleep()`:** a scheduler deadline, folded into the wait timeout.
- **Child idempotency key:** `idempotencyKeys.create(\`ns:${runId}:${stepKey}:e${epoch}\`, { scope: "global" })`. The TTL is the run retention, 30 days by default.
  - Global scope is deliberate. If the parent task is retried as a new attempt, or a new parent run starts in the same epoch, it reattaches to the children that exist.
  - The epoch suffix means a child that failed is never served again after a resume (§7.6).
- **Child registry.** After `trigger` returns, the parent writes `runs/<runId>/e<epoch>/children/<stepKey>.json = { childRunId }`. A crash before that write is harmless, because re-triggering with the same key returns the same run id. The orphan sweep (§7.3) reads this registry.
- **`step()`, clocks, `exec` and checkpoints.** These are stored in the result store at `runs/<runId>/cache/<key>.json`, written with create-if-absent (CAS: S3 `If-None-Match: *`, R2 `onlyIf`).
  - On replay, the parent reads the record before running `fn`. If two attempts race, the first write wins and both use its value.
  - `now()`, `random()` and `uuid()` are `clock` records. Writes are batched per scope and flushed before the next durable call.
  - This is a second store on Trigger, and the spec says so plainly. It holds only values the host cannot memoize. Agent replay still goes through child idempotency keys.
  - Replay of these records follows §3.9's longest-unchanged-prefix rule.
  - A `step()` whose `fn` throws writes nothing, so it re-runs.
- **Accept runs in the parent** (§7.4.4). The parent holds the closures. It writes the epoch-scoped accept record, then the success cache, then disposes of the sandbox through the provider. It holds the provider key, as the orchestrator zone allows (§9.1). A host-side check failure triggers a follow-up child for the next launch attempt.
- **Per-run sandbox concurrency cap.** The parent is the only code that starts children, so it enforces the cap from §3 directly: never more than N children in flight. Trigger's queue `concurrencyLimit` cannot do this, because a run waiting on a token gives up its slot about 60 s after it is checkpointed.

**Child task `selfbuilding.agent`.**

- **Payload.** Only serialisable data:
  - a skill reference (path and hash), or the inline prompt text;
  - the input, and the result JSON Schema;
  - `cmd` and `judge` done checks;
  - harness, model, placement, budget slice, epoch, launch attempt and resume message.
  
  Zod refinements, transforms, `assert` checks, `with()` closures and PR functions never cross. Inline agents such as `agent("prompt", { output: z.object(...) })` work, because their closures run in accept in the parent.
- **Launch** (§7.4.1) runs as a plain function. The child's own retries (`maxAttempts: 3`) are safe because launch checks the outcome record and markers first.
- **Wait** is `wait.forToken` on the launch-scoped token (§7.4.2). Its `timeout` is always set, because the Trigger default is never.
  - `register` hands the sandbox `token.url` as the callback URL. That URL is a bearer capability scoped to one token. It is written to a mode-0600 file and redacted (§9).
  - Server-to-server POSTs to `token.url` need no CORS, so a Trigger-only deployment needs no inbound HTTP endpoint.
  - The reaper repairs a lost callback with `wait.completeToken`.
- **Collect** (§7.4.3) runs as a plain function and returns a `RawOutcome`. The child never disposes of the sandbox.
- **Cold `ask_human`** (§8.4). The launch ends in `suspended`. The child waits on the ask's token, which is its only wait at that moment. It then relaunches with the answer as the next launch attempt.

**Both tasks.**

- **Machine:** `small-1x`. The tasks only orchestrate.
- **`maxDuration`:** 300 s of CPU. Waits do not count toward it. The agent's wall-clock budget is Selfbuilding's own (§7.7).
- **Streams:** transcript streams that stay quiet through a long wait can be garbage-collected. The parent writes a heartbeat chunk every 20 minutes, or closes the stream before waiting and reopens it after.

#### 7.5.2 Inngest (`@selfbuilding/host-inngest`)

Inngest memoizes steps by id and allows parallel steps, so the adapter maps the group directly. Accept runs inside the collect step.

```ts
const launch  = await step.run(`launch:${launchId}`, () => launchAgent(call, launchId));
const cb      = await step.waitForEvent(`wait:${launchId}:w${rearm}`, {
  event: "selfbuilding/agent.callback",
  if: `async.data.launchId == '${launchId}' && async.data.runId == '${runId}'`,
  timeout: ms(callTimeoutMs + 30 * 60_000),   // the call's `timeout` (§6.11) + 30 min
});
const outcome = await step.run(`collect:${launchId}`, () => collectAgent(launch, cb).then(accept));
```

- **One long wait per launch.** There is no tick loop. A lost callback is repaired by the reaper's synthetic `finished` or `lost` event (§7.8).
- **`host.all`** is `Promise.all` over step groups. The per-run cap uses an in-process semaphore. On replay it rebuilds in the same order, because acquisition depends only on memoized results.
- **Callback path.** The sandbox POSTs to `createCallbackHandler()` from `@selfbuilding/hooks`, a fetch handler mounted next to `serve()`. The handler:
  1. verifies the per-launch HMAC (§9);
  2. writes the callback to `callbacks/<runId>/<launchId>.json`;
  3. calls `inngest.send(...)`.
- **The early-event race.** An event that arrives before the wait is registered is not matched. Launch therefore checks the callback record *before* waiting, and collect checks it again after a timeout. A turn that finishes in seconds is never lost.
- **Plan-time step estimate.** Inngest allows 1,000 steps per run. Selfbuilding estimates each agent call at its worst case:

  ```
  steps(agent) = 3                                        // launch, wait, collect
               + 3 × (maxResumes + maxDoneRetries)        // each extra launch attempt
               + 4 × maxAsksPerAgent                      // ask wait + relaunch, wait, collect
               + 2                                        // re-arm reserve
  ```

  - With the defaults (`maxResumes` 1, `maxDoneRetries` 2) and the Inngest default of `maxAsksPerAgent: 3`, this is 26 steps per agent.
  - `step()` and clock calls add 1 each.
  - The planner fails with `HostStepLimitError` when the static fan-out would go past 900. The error names the count and suggests nested factories (`step.invoke`), which each get their own 1,000 steps.
  - At run time a counter tracks steps used. Once 950 are used, new `agent()` calls throw `HostStepLimitError` (which becomes `null` inside `parallel()` and `pipeline()`, §1.9) and emit `host.step_limit`.
- **Other limits:**
  - 4 MiB per step and 32 MiB of run state. This is why the 256 KiB inline rule exists.
  - `waitForEvent` time counts toward the plan's maximum run length.
- **Cancellation.** `cancelOn` takes effect only between steps. A function on `inngest/function.cancelled` kills the run's sandboxes, and the reaper is the backstop.

#### 7.5.3 Cloudflare Workflows (`@selfbuilding/host-cf-workflows`)

```ts
export class SelfbuildingWorkflow extends WorkflowEntrypoint<Env, FactoryParams> {
  async run(event: WorkflowEvent<FactoryParams>, step: WorkflowStep) {
    return runFactory(event.payload, cloudflareHost(step, this.env));
  }
}
```

- **Instance id.** It is `runId` for epoch 0 and `${runId}_e${epoch}` for later epochs (§7.6).
- **Each agent call maps to three steps:**
  - `step.do("launch:"+launchId, { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" })`
  - `step.waitForEvent("wait:"+launchId+":w"+rearm, { type: "cb-"+launchId+"-w"+rearm, timeout })`. This is one long wait with no tick loop.
  - `step.do("collect:"+launchId, ...)`, with accept inside it.
- **CPU limits.** `step.do` bounds CPU, not wall clock. Launch and collect are short and spend most of their time waiting on network, so they fit the 30 s default CPU. Collect needs a raised `limits.cpu_ms` when `assert` checks are heavy.
- **Callback path.** The sandbox calls a Worker route. The Worker passes it to the run's Durable Object, which verifies the HMAC, records the callback and fans it out to viewers. The DO then calls `env.SELFBUILDING_WF.get(instanceId).sendEvent(...)`.
  - It is unverified whether events sent before the wait are buffered. The adapter therefore does the same store-first check as on Inngest. Here the store is the run DO.
- **Step limit.** If the platform declares `maxStepsPerRun`, the §7.5.2 estimator runs against it.
- **Timeouts.** The `waitForEvent` timeout is always passed explicitly. The 24 h default is shorter than many HITL waits.
- **Limits.** Step results are capped at 1 MB and event payloads at 1 MiB. Large values go to R2 by reference.
- **Resume after terminal failure.** Resume starts a new instance at the next epoch (§7.6). `instance.restart({ from })` is not used, because it would serve stored failure values.

#### 7.5.4 Plain Node (the built-in `node` host in `@selfbuilding/core`)

- **Journal.** `step` reads and writes the local journal (§3; file or SQLite).
- **Waiting.** `waitForCallback` does not open an inbound port. It polls the sandbox status file `/selfbuilding/state/launches/<launchId>.status` over `exec`: every 1 s at first, backing off to 5 s. This works the same for Docker on Linux and macOS, with no `host.docker.internal` setup.
- **Exit and resume.** The process may exit at any point. `selfbuilding resume <runId>` replays from the journal and reattaches to sandboxes that are still running.
- **The lease is fenced.** A laptop that sleeps past the lease TTL must not keep launching after `selfbuilding resume` takes over. The `JournalStore` lease is defined once, in §3.9: `lease()` returns a `Lease` whose `leaseEpoch` strictly increases per run id, and every `put` carries it.
  - `put` rejects any write whose `leaseEpoch` is not the current one.
  - The host calls `assertLease` right before every sandbox create and every harness launch. That is one round trip to the file lock or the SQLite row.
  - A holder that loses the lease throws `LeaseLostError` on its next journal operation. It aborts before doing anything remote. Its in-flight sandboxes are left to the new holder, which reattaches through the launch markers.

#### 7.5.5 Comparison

| | Plain Node | Trigger.dev | Inngest | CF Workflows |
|---|---|---|---|---|
| In-run replay of `agent()` | local journal | child idempotency keys (`:e<epoch>`) | step memo | step memo |
| In-run replay of `step()` and clocks | local journal | result store (CAS); a second store, by design | step memo | step memo |
| Across-epoch reuse | local journal (failures re-run) | success cache | success cache | success cache |
| `agent()` becomes | journal step group | child task `selfbuilding.agent`; accept in parent | `step.run` + `waitForEvent` + `step.run` | `step.do` + `waitForEvent` + `step.do` |
| Wait | `selfbuilding-runtime wait` long-poll over exec | child: one token per launch; parent: one wake stream, 10-min reconcile | one `waitForEvent` per launch | one `waitForEvent` per launch |
| Callback target | none; the status file is read over exec | `token.url` (no endpoint needed) | Selfbuilding handler, then `inngest.send` | Worker, then run DO, then `sendEvent` |
| Fan-out | in-process | trigger N children, one wake stream | parallel steps | parallel steps |
| Per-run sandbox cap | in-process semaphore | parent scheduler | replay-stable semaphore | replay-stable semaphore |
| Limits that bite | none | one wait per run; stream GC on long waits | 4 MiB/step, 1,000 steps, run length per plan | 1 MB/step, CPU per step, id regex |
| Resume after terminal failure | `selfbuilding resume` | new parent run at epoch + 1 | new function run at epoch + 1 | new instance `${runId}_e${n}` |
| Cancel kills sandbox via | `SIGINT` handler, then reaper | cleanup hooks, then reaper | `function.cancelled`, then reaper | DO alarm, then reaper |

### 7.6 Replay, resume and interrupted turns

**Within one host run,** what happens to an agent call depends on how far it got:

| State on replay | What happens |
|---|---|
| Accept completed | The stored `AgentOutcome` is returned, `ok` or not. The harness is not called again. |
| Outcome record written, accept not done | Accept runs from the outcome record. |
| Launched, wait still pending | Wait again on the same `launchId` target. The sandbox keeps working the whole time. |
| Launched, sandbox alive, turn finished, callback lost | The reaper's synthetic `finished`, or the timeout probe, wakes the wait. Collect then runs normally. |
| Launched, sandbox positively gone or harness dead mid-turn | `AgentInterruptedError` with `{ branch, commits, sessionId, sandbox, snapshotId? }`. |
| Launch outcome unknown | Probe for the outcome record and the launch marker. Reattach if the marker is present. Launch only if a positive lookup shows there is no sandbox, no marker and no outcome record. |

**Across host runs: epochs.** A resume after a terminal failure works like this. It happens when you call `run(factory, input, { runId })` on a run whose host run has ended, or run `selfbuilding resume` on a hosted run.

1. The run record `runs/<runId>/run.json` is updated with CAS. `epoch` goes up by one and the previous host run id is recorded. If the previous host run is still live, `run()` attaches to it instead and does not bump the epoch.
2. The orphan sweep (§7.3) cancels children and sandboxes still in flight from the previous epoch.
3. A new host run starts at the new epoch.
4. Each `agent()`, `step()` and clock call first reads `runs/<runId>/cache/<key>.json`, using §3.9's longest-unchanged-prefix rule per scope.
   - On a hit, it returns the stored success with `replayed: true`.
   - Anything else runs live under the new epoch's keys. That includes failures from the earlier epoch, budget stops, interruptions and calls that never ran.

The cache holds successes only. Failed outcomes stay in the epoch-scoped accept records and the launch-scoped outcome records. No path serves them across epochs. So after you fix a skill bug or raise a budget, a resume re-runs the failed agent, on every host.

All hosted adapters share the same success cache, written by accept and read only when a new epoch starts. It is scoped to one `runId`. (Seeding a new run from another run's journal, `seedFrom`, is left out of v1; see §3.15.)

**Interrupted turns** are handled according to `onInterrupted` (§6.8), set on each agent and defaulted at the factory level. Per call it is `"fail"` (default) or `"resume-session"`. The run-level record in `RunOptions` (§3.3) can also name `"restore-and-rerun"` or `"skip"` for calls on shared handles.

- `"fail"`: the call throws `AgentInterruptedError` with its recovery data. Inside `parallel()` and `pipeline()` that becomes `null` (§1.9). On hosted adapters the accept step records the failure as a value, so the host never retries the turn (§7.4.4).
- `"resume-session"`: Selfbuilding advances the fence (§7.4.5), then reopens or recreates the sandbox in this order of preference:
  1. the sandbox itself;
  2. the last snapshot;
  3. a new sandbox checked out at the agent's branch.

  It then resumes the native session (§4) with a fixed message: *"Your previous turn was interrupted. Inspect the working tree and remote state before repeating any action, then continue."* This is a new launch attempt with its own `launchId` and wait. It never happens more than once per call unless `maxResumes` is raised.

The same fence-then-relaunch path applies after an unknown probe result. The old turn may still be running. The fence stops it from pushing or being accepted, and the reaper delivers its cancel sentinel.

### 7.7 Budgets and the timeout chain

The orchestrator's CPU limits are not agent budgets. Trigger's `maxDuration` and Workflows' `cpu_ms` do not bound the time a sandbox is billed. Selfbuilding enforces wall-clock time itself.

**The chain and its defaults are defined once, in §6.11.** This section adds only the host wait and the plan-time rule:

```
timeout  (per call, active time, default 2 h; §6.11)
  < host wait timeout   (timeout + 30 min, per launch; §7.4.2)
  < sandbox lifetime    (timeout + 15 min, extended while waiting, clamped to the provider maximum)
  < dead-run closer     (timeout + 1 h of active time; reaper marks the call failed{reason:'lost'} and notifies)
```

The host wait is per launch and the lifetime is per box, so both are measured from the launch or box creation. Time spent `waiting` or `suspended` shifts all three derived deadlines (§6.11).

- **Who extends lifetimes.** The host and the reaper extend sandbox lifetimes through the provider API (§5 `extendLifetime`). The sandbox never extends its own lifetime, because it holds no provider credential. Extension can never go past the provider's session maximum (`limits.maxLifetimeMs`).
- **When `timeout + 15 min` is longer than the provider's session maximum,** the call runs with continuation. At a turn boundary before the maximum, the host does three things:
  1. It commits WIP and pushes it from the host (§9.2), or takes a snapshot.
  2. It captures the session (§4.7).
  3. It continues on a new box as a new launch attempt, behind the fence.

  This needs a harness whose sessions can move between boxes (Claude Code, Codex, OpenCode, Pi) and a placement that can move (fresh, or a shared handle with checkpoints). If either is missing, or if one turn cannot fit inside the session maximum with 15 min to spare, `run()` fails at plan time with `ProviderLifetimeError` (a `ConfigError`). The error names the provider limit and the timeout that broke it. Examples of session maximums: 1 h on E2B Hobby or Impello Trial, 45 min on Vercel Hobby.
- **Budget.** The shared USD budget (§3.12, §9.6) is charged from `usage` events. While a sandbox is paused for a cold wait (§8), it accrues nothing.

### 7.8 The reaper

The reaper is `reap()` from `@selfbuilding/core`, scheduled in every deployment every 2 minutes. Its per-box decisions (hold, park, kill, orphan, dead-run closer) are defined once in §5.9, and its pause and destroy rules in §6.14. This subsection covers only what it does for hosts. In total it does six things:
- extends sandbox lifetimes;
- repairs waits whose callback was lost (synthetic `finished`);
- completes waits for sandboxes that died (`lost`);
- delivers cancel sentinels to superseded and orphaned launches;
- parks idle sandboxes;
- kills orphans.

It is the backstop for everything that event-driven cleanup misses.

| Host | How it runs | How it wakes a wait |
|---|---|---|
| Trigger.dev | `schedules.task({ cron: "*/2 * * * *" })` | `wait.completeToken` on the child's launch token, then a `tick` on the parent's wake stream |
| Inngest | cron function | `inngest.send` of a `selfbuilding/agent.callback` with `source: "reaper"` |
| CF | Worker cron trigger, fanned out to run DOs | run DO calls `sendEvent` |
| Local | runs inside `selfbuilding resume` and `selfbuilding reap` | writes the status file |

For each sandbox labelled `selfbuilding.run` (or each registry row on Cloudflare), after the §5.9 decision and with the same lock probe (only `FREE` may pause or kill):

1. **Extend lifetimes.** If the host run is waiting on the box, extend the sandbox lifetime when the deadline allows it.
2. **Repair lost callbacks.** If the host is waiting on a launch, and `outcome.json` exists for that `launchId` with no ack, send a synthetic `finished` callback.
3. **Report positive losses.** If the host is waiting on a launch whose sandbox gives a positive not-found, send `lost`. Timeouts, 5xx responses and 409s mean unknown. An unknown result never sends `lost` and never destroys anything.
4. **Stop stale launches.** If the sandbox's `selfbuilding.launch` is superseded by the fence, or its host key was swept as an orphan (§7.3), write the cancel sentinel. Kill the box once its lock reads `FREE`.
5. **Close dead runs.** If the dead-run closer deadline has passed, close the call as failed and post to the run's channel (§8). This is the §5.9 row, applied through the host so the open wait is released.

Every skip logs `skip [reason]`. A state that stays bad raises the alarm again on every sweep, not only when it first appears.

### 7.9 Cancellation

Cancelling a host run does not stop a sandbox. Each adapter wires a best-effort cleanup that sends a `cancel` callback, stops the harness, and kills or parks the sandbox:

| Host | Cleanup trigger |
|---|---|
| Trigger.dev | task failure or cancel hooks; the parent also cancels its registered children |
| Inngest | `inngest/function.cancelled` |
| CF | `terminate()` caught by the run DO's alarm |
| Local | `SIGINT` |

The reaper guarantees cleanup if the hook never runs. `selfbuilding cancel <runId>` does both and reports counts. If the provider listing failed, it says so instead of reporting "0 killed".

### 7.10 Stores the host does not provide

A few things need storage the host does not give. Each has a narrow job.

| Store | Purpose | Local | Trigger / Inngest | All-Cloudflare |
|---|---|---|---|---|
| `ArtifactStore` | transcripts, diffs, large results, callback records | `.selfbuilding/artifacts/` | any S3-compatible bucket | R2 |
| `ResultStore` | run record (epoch), success cache, launch outcome records, epoch accept records, fences, Trigger step and clock records, Trigger child registry | journal | same bucket, CAS writes | R2 (CAS) plus run DO for fences |
| `SandboxRegistry` | find sandboxes on providers without a listing (Cloudflare) and snapshots without a listing (Modal, Cloudflare) | journal | provider labels (none needed for Impello/E2B, Daytona, Vercel, Docker) | run DO + D1 |
| `LeaseStore` (optional) | a sandbox cap across runs, e.g. the provider tier limit | SQLite | not in v1 (rely on provider 429 and backoff) | a `LeaseDO` per factory |

`ResultStore` layout:

```
runs/<runId>/run.json                          { epoch, hostRunIds[], status }          CAS
runs/<runId>/cache/<key>.json                  successes only: agent outcomes, step/clock/exec values
runs/<runId>/e<epoch>/accepted/<stepKey>.json  every accept result in this epoch (ok or not)
runs/<runId>/e<epoch>/children/<stepKey>.json  Trigger child run ids
runs/<runId>/outcomes/<launchId>.json          collect journal-ahead record (ok or not)
runs/<runId>/fences/<hostKey>.json             current launch generation (§7.4.5)
```

Rules:
- Every `ResultStore` write is create-if-absent or compare-and-set, and must succeed before the step that writes it returns. A failed write is an infrastructure fault, and the host retries it.
- Inside one host run, Inngest and Cloudflare read only `outcomes/` and `fences/`. `cache/` is read only when a new epoch starts.
- `ArtifactStore` writes outside collect are fail-soft.

### 7.11 The control plane (later, optional)

The control plane is a thin service on Cloudflare Workers and Durable Objects. It never schedules work; the host still runs every step. It gives a deployment four things it otherwise lacks:
1. per-run state that a person can read;
2. event fan-out to viewers;
3. one HTTP front door for callbacks and channel webhooks;
4. a web view.

**Shape**
- **`RunDO`:** one per `runId` (`idFromName(runId)`). It has SQLite tables `run`, `steps` (a write-only mirror of journal states), `events` (`seq` unique per launch), `asks`, `sandboxes` and `artifacts`.
  - Viewers attach over hibernatable WebSockets (`ctx.acceptWebSocket`).
  - New viewers receive a full snapshot, then live events. There is no delta log.
- **`LeaseDO`:** one per factory. It provides the cross-run sandbox cap with TTL leases that the host renews while it sees runtime heartbeats.
- **D1** holds the cross-run index (runs by factory, repo and status) and the registry index. **R2** holds artifacts and the result store.
- A Worker cron runs the reaper (§7.8).

**Routes**

```
POST /v1/runs/:runId/launches/:launchId/callback  sandbox → DO → host wake   (per-launch HMAC)
POST /v1/runs/:runId/events                       batched runtime events, idempotent on (launchId, seq)
GET  /v1/runs/:runId                              snapshot (JSON)
GET  /v1/runs/:runId/ws                           live viewer socket
POST /v1/hooks/slack | /discord | /github         channel webhooks (§8); ack first, then process in waitUntil
GET  /                                            web view: run tree, phases, live transcripts, artifacts, pending asks
```

**Wiring.** Pass `controlPlane: { url, token }` to `run()`. Three things change:
- Callback targets point at the control plane.
- Runtime events stream to it.
- The host adapters send their wakes through it: `sendEvent` for CF, `inngest.send` for Inngest, and on Trigger `wait.completeToken` for the child's launch token plus a send on the parent's `selfbuilding.wake` stream.

**Rules**
- **Event delivery.** Critical events (`callback`, `error`, `ask`) are acked and replayed until acked. Every other event is at-most-once. Cumulative fields such as cost and token counts are idempotent when an event is sent again.
- **Generations.** Each event carries `launchId`. Events from a launch the fence has superseded are recorded as late and are never published into the current launch.
- **Web view auth.** A session cookie from GitHub OAuth or Cloudflare Access. Links never carry credentials.
- **Portability.** The DO code sits behind a small platform seam (socket host, storage, alarms), so a Node container build can follow later. v1 ships Cloudflare only.

### 7.12 Deployment guides

#### 7.12.1 Local: Node, Docker and a SQLite journal

Start with the quickstart in §1.8. It is the only quickstart, and this guide does not repeat it. It sets up the plain Node host (`--host node`), Docker and the file journal.

To use SQLite instead of the file journal, which is better when several local processes resume and reap the same runs, install the SQLite store and swap one line of the config:

```bash
npm i @selfbuilding/journal-sqlite
```

```ts
// selfbuilding.config.ts (only the changed lines)
import { sqliteJournal } from "@selfbuilding/journal-sqlite";

export default defineConfig({
  // ...everything else as in the §1.8 quickstart
  journal: sqliteJournal(".selfbuilding/journal.db"),
});
```

Day-to-day commands:

```bash
npx selfbuilding run factories/review-pr.ts --input '{"url":"https://github.com/acme/api/pull/412"}'   # prints ns_… run id
npx selfbuilding resume ns_01jb…        # after a crash or Ctrl-C; takes a new lease epoch (§3.9)
npx selfbuilding reap                   # cleans up leaked containers (§5.9)
```

#### 7.12.2 Trigger.dev and Impello (reference and dogfood)

1. **Impello.** Use the per-harness templates `selfbuilding-claude-code`, `selfbuilding-codex` and `selfbuilding-opencode` (§5.6). If a repo needs its dependencies baked in, build a custom template with `fromTemplate("selfbuilding-<harness>")`. The adapter uses `@impello/sdk`, never `e2b`, because the E2B client rejects `imp_` keys. It always passes these settings:
   - `lifecycle: { onTimeout: "pause" }` for resumable agents and `"kill"` for disposable ones;
   - an explicit `timeoutMs` on `create`, `connect` and every `commands.run`;
   - `background: true` for the harness launch, keeping the pid so a retried launch can reattach with `commands.connect(pid)`.

2. **Secrets.** Secrets reach the sandbox only as mode-0600 files written with `files.write`, re-delivered after every connect. They never go in `envs`, per-command env or network header transforms (§5.5, §9.2). On the orchestrator side, put `TRIGGER_SECRET_KEY`, `IMPELLO_API_KEY`, the harness keys and the artifact bucket credentials in your secret manager, and sync them to the Trigger.dev project environment. Set them in one place only.
3. **Code.**

```ts
// trigger.config.ts
import { defineConfig } from "@trigger.dev/sdk";
export default defineConfig({
  project: "proj_…",
  dirs: ["./trigger"],
  machine: "small-1x",
  maxDuration: 300,
  // Safe for selfbuilding.agent: launch checks outcome records and markers, collect writes its record first (§7.4).
  retries: { enabledInDev: false, default: { maxAttempts: 3, factor: 2, minTimeoutInMs: 2_000 } },
});
```

```ts
// selfbuilding.config.ts
import { defineConfig, fromEnv } from "@selfbuilding/core";
import { impello } from "@selfbuilding/sandbox-impello";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { s3Artifacts } from "@selfbuilding/artifacts-s3";

const CLAUDE_MODEL = "<anthropic-model-id>";   // placeholder: your model id

export default defineConfig({
  deployment: "prod",             // required on hosted hosts (§5.2)
  harness: claudeCode({
    model: CLAUDE_MODEL,
    credentials: { kind: "api-key", value: fromEnv("ANTHROPIC_API_KEY") },
  }),
  sandbox: impello({ apiKey: fromEnv("IMPELLO_API_KEY"), template: "selfbuilding-claude-code" }),
  artifacts: s3Artifacts({ bucket: "selfbuilding-artifacts", endpoint: fromEnv("S3_ENDPOINT") }), // also the result store
  concurrency: { sandboxes: 8 },  // per run; keep it under the Impello tier cap
});
```

```ts
// trigger/selfbuilding.ts
import { createTriggerHost } from "@selfbuilding/host-trigger";
import config from "../selfbuilding.config";
import review from "../factories/review-pr";

// The reaper task runs reap() on a */2 cron (§5.9, §7.8).
export const { factoryTask, agentTask, reaperTask } = createTriggerHost({ config, factories: { review } });
```

```ts
// anywhere on your backend
import { tasks } from "@trigger.dev/sdk";
await tasks.trigger("selfbuilding.factory", { factory: "review", input: { branch: "feat/x" } });
```

4. **Bucket.** The bucket must support conditional writes (`If-None-Match: *`). S3, R2 and most S3-compatible stores do. `createTriggerHost` probes for this at startup and refuses to start without it.
5. **Deploy:** `npx trigger.dev@latest deploy`. Run `npx trigger.dev@latest dev` for local iteration. Sandboxes still run on Impello.
6. **HITL.** Trigger.dev has no inbound HTTP. Slack, Discord and GitHub webhooks (§8) need a receiver: either the control plane, or the `@selfbuilding/hooks` fetch handler deployed on any edge runtime. The handler sends factory-side answers on the parent's wake stream. AFK-only factories need neither.
7. **Watch these limits:**
   - Impello's starts-per-minute and concurrency caps. The adapter backs off on `RateLimitError`.
   - The tier's maximum session length. Calls longer than that need continuation (§7.7).
   - Paused sandboxes are deleted after 14 days. A run resumed later than that rebuilds from the agent's branch or snapshot.

#### 7.12.3 All-Cloudflare

This deployment uses Workflows as the host and Cloudflare Sandbox 1.0 (DO containers) as the provider. The control plane provides callbacks, the web view and webhooks, with D1 and R2 behind it.

```jsonc
// wrangler.jsonc (abridged)
{
  "name": "selfbuilding",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "workflows": [{ "name": "selfbuilding-run", "binding": "SELFBUILDING_WF", "class_name": "SelfbuildingWorkflow" }],
  "durable_objects": { "bindings": [
    { "name": "RUN", "class_name": "RunDO" },
    { "name": "LEASE", "class_name": "LeaseDO" },
    { "name": "SANDBOX", "class_name": "SelfbuildingSandbox" }
  ]},
  "containers": [{ "class_name": "SelfbuildingSandbox", "image": "./images/claude-code.Dockerfile", "instance_type": "standard-2" }],
  "d1_databases": [{ "binding": "DB", "database_name": "selfbuilding" }],
  "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "selfbuilding-artifacts" }],
  "triggers": { "crons": ["*/2 * * * *"] }
}
```

```ts
// src/index.ts
import { createCfWorkflowsHost } from "@selfbuilding/host-cf-workflows";
import config from "./selfbuilding.config";          // defineConfig({ deployment, sandbox: cloudflareSandbox(...), ... })
import review from "./factories/review-pr";

const host = createCfWorkflowsHost({ config, factories: { review } });
export const { SelfbuildingWorkflow, RunDO, LeaseDO } = host;
export { SelfbuildingSandbox } from "@selfbuilding/sandbox-cloudflare/worker";   // the sandbox DO class (§5.5)
export default host.worker;                         // routes from §7.11 + cron reaper
```

Constraints:
- **Instance size.** Use `standard-2` or larger. Smaller instances cannot run a coding agent.
- **Container lifetime.**
  - Cloudflare does not guarantee how long a container stays up. The inactivity timeout is at most 6 h and counts only traffic that reaches the DO.
  - The sandbox DO keeps the container alive with an alarm while a launch is active.
  - The host pushes the agent's branch at every call boundary and checkpoint (§6.13, §9.2), because a lost container takes its disk with it.
- **Pausing** is `snapshotContainer` followed by `destroy`. It keeps the filesystem only. Snapshot ids are recorded in the run DO, because there is no list API.
- **Migration.** Moving the container class to `scheduling_policy: "durable_object"` cannot be undone. Deploy the new class name first.
- **Images** must be `linux/amd64`.
- **Using another host.** The Cloudflare Sandbox adapter only works from inside this Worker. To use it from Trigger.dev or Node, deploy the facade Worker from `@selfbuilding/sandbox-cloudflare/worker` and use the client provider `cloudflareSandbox({ url, token })` (§5.5).

### 7.13 Failure modes this section designs for

| Failure | Handling |
|---|---|
| Orchestrator crashes after starting the harness | Launch is idempotent through the outcome record, label and markers; replay reattaches |
| Trigger child retries after collect killed the box and then threw | Collect writes the outcome record before any disposal, and disposal belongs to accept. A retried launch finds the record and never creates a box |
| Trigger parent task retries from the top | `step()`, clock, exec and checkpoint values come from the result store; children reattach by idempotency key |
| Completion callback lost | Reaper's synthetic `finished`, plus the wait-timeout probe |
| Stale callback from an earlier launch of the same step | Waits are keyed on `launchId`; collect checks `outcome.json` for that launch or a `FREE` lock, otherwise it re-arms |
| Callback arrives before the wait is registered | Store-first check in launch and collect (Inngest, CF) |
| Old turn keeps running after an unknown probe and a relaunch | Fence record, token revocation, push lease on `expectSha`, cancel sentinel from the reaper |
| Local lease expires while the original process is alive | Lease epoch on every `put`, and `assertLease` before every create or launch |
| Resume after fixing a skill or raising a budget | New epoch; failures are never served across epochs; successes come from the cache |
| Sandbox dies mid-turn | `AgentInterruptedError` with recovery data; resumed only on opt-in |
| Provider outage during a lookup | Classified unknown; holds; never destroys or rebuilds |
| Host cancel leaves the sandbox running | Adapter cleanup hook, reaper backstop |
| Trigger one-wait limit | All parent suspensions (agents, nested factories, asks, sleeps) multiplexed on one wake stream; children each hold one wait |
| Replay visits different keys after an edit | Orphan sweep cancels unvisited children and sandboxes |
| Inngest step limit | Worst-case estimator at plan time; runtime counter stops new agents at 950 steps |
| Step output over the host limit | 256 KiB inline cap; references to the artifact store |
| Skill edited between attempts | `skillHash` in the step key invalidates the cache |
| Non-deterministic factory code | `JournalDivergenceError` in development mode, with a call diff |
| Call longer than the provider session maximum | Continuation onto a new box at a turn boundary, or a plan-time `ProviderLifetimeError` |

L3 tests (§10) that this section requires:
- **Collect throws after the kill.** On Trigger, inject a throw into collect after the outcome record is written and the sandbox has been disposed. Assert that the harness runs exactly once.
- **Ask overlaps an agent.** On Trigger, a factory-side `ask()` is answered while a sibling agent is in flight. Assert that both resolve and no parallel-wait error occurs.
- **Stale token cannot release a new launch.** A completed token from launch `l0` must not release launch `l1`.
- **Failure re-runs on resume.** A failed agent at epoch 0 re-runs at epoch 1 on each hosted host, while successful siblings replay.
- **Lost lease.** A process holding a lost lease launches nothing after `selfbuilding resume` takes over.

### 7.14 Open questions

Moved to §11 (Q25 to Q30).

## 8. Human in the loop and AFK

This section covers the full path of a question to a person:
- how a running agent asks it;
- how the question becomes a durable wait plus a message on Slack, Discord or a GitHub PR;
- how answers come back;
- what happens when nobody is there.

It also covers completion notifications and watching a live run.

Out of scope here, with the section that owns each:
- How `ask_human` is injected into each harness: section 4.
- The in-sandbox bridge that carries asks out of the sandbox: section 6.
- Host step mapping and the journal: sections 3 and 7.
- What `run()` returns (`RunOutcome`): §1.9 and §3.3.
- Token handling and redaction: section 9.

### 8.1 Design rules

1. **There is one primitive, `ask()`.** An agent calls it inside the sandbox as the `ask_human` tool. Factory code calls it between agents as `ask()`. Both produce the same ask record, the same channel messages and the same resolution type.
2. **The in-sandbox tool is always called `ask_human`.** Its FYI sibling is always `notify_human`. Sections 2, 4, 6 and 10, the Pi extension and the preamble all use these names. The model sees the harness-specific form that `toolName("selfbuilding", "ask_human")` returns, for example `mcp__selfbuilding__ask_human` on Claude Code.
3. **The host's durable wait is the only source of truth for an answer.** A channel webhook never talks to a sandbox. It resolves the waitpoint by `askId`, and the run picks up the answer from there.
4. **One ask gets one answer.** The first valid answer wins through an atomic compare-and-set on the ask record. Anyone who clicks, replies or delivers later is told who already answered.
5. **An answer belongs to the question that was asked.** An ask id is never reused for a different question or a different launch of an agent. An old answer is never handed to a new turn (8.3).
6. **The sandbox sends a spec, not platform markup.** Selfbuilding builds every Slack block, Discord component and GitHub comment itself, and escapes every string. A sandbox cannot forge an "Approved" banner, a link button or a mention.
7. **AFK is a policy, not a special code path.** The same `ask()` runs with and without a person. The policy decides how it resolves: auto-answer, default after a timeout, or fail.
8. **No ask waits silently.** If no channel can deliver the ask, it resolves at once under the AFK policy and records `ask.undeliverable`. Otherwise a question nobody was told about would wait forever.
9. **Every guard logs why it skipped.** Ignored clicks, replies and webhooks each emit a `skip [reason]` line. A silent `return` looks the same as a working no-op.

### 8.2 The API

```ts
// @selfbuilding/core
// Duration is defined once, in §3.3.

interface AskChoice<C extends string = string> {
  id: C;                      // [a-z0-9-]{1,20}; what the caller gets back
  label: string;              // ≤ 75 chars (Slack button limit)
  style?: "primary" | "danger";
  safe?: boolean;             // the choice that is safe to take without a human
}

interface AskSpec<T = unknown, C extends string = string> {
  question: string;           // ≤ 2,000 chars, plain text plus *bold*, _italic_, `code`
  title?: string;             // ≤ 120 chars; card heading
  context?: string;           // ≤ 4,000 chars; shown collapsed / below the fold
  choices?: readonly (C | AskChoice<C>)[];   // 0–5; a string is shorthand for { id: s, label: s }
  freeText?: boolean;         // default: true if no choices, else false
  schema?: StandardSchema<T>; // flat object form; see 8.6
  default?: C | T;            // a choice id, or a schema-valid value
  timeout?: Duration;         // overrides the run default
  onTimeout?: "default" | "auto" | "fail";
  risk?: "low" | "high";      // default "low"; see 8.8
  dedupeKey?: string;         // a re-ask with the same key replaces the open card
  anchor?: { path: string; line: number }; // GitHub: post as a review comment on this line
}

type AskAnswer<T, C extends string = string> =
  | { kind: "choice"; choiceId: C }
  | { kind: "text"; text: string }
  | { kind: "value"; value: T };

type AnsweredBy =
  | { kind: "human"; channel: "slack" | "discord" | "github" | "cli"; userId: string; displayName: string }
  | { kind: "default"; reason: "timeout" | "afk" | "undeliverable" }
  | { kind: "auto"; model: string; rationale: string };

interface AskResolution<T = unknown, C extends string = string> {
  askId: string;
  answer: AskAnswer<T, C>;
  choiceId: C | null;          // shortcut: answer.choiceId when kind is "choice", else null
  answeredBy: AnsweredBy;
  answeredAt: string;          // ISO
}

// Factory-side, between agents. Throws AskTimeoutError / AskCancelledError.
declare function ask<T = unknown, const C extends string = string>(
  spec: AskSpec<T, C>,
): Promise<AskResolution<T, C>>;
```

**Choice shorthand.** `choices: ["yes", "no"]` means the same as `[{ id: "yes", label: "yes" }, { id: "no", label: "no" }]`. Thanks to the `const` type parameter, `choiceId` narrows to `"yes" | "no"`, so a typo like `go.choiceId === "yse"` is a compile error. Each shorthand string must satisfy the `id` rule (`[a-z0-9-]{1,20}`). A string that breaks the rule throws `AskSpecError` when the ask is created, and the error names the object form as the fix. Shorthand choices cannot carry `safe` or `style`. When you need those, use the object form.

**Where HITL configuration lives.** HITL settings use the same precedence as harness and sandbox (section 1.8). From highest to lowest:
1. `run(..., { hitl })`;
2. `factory({ hitl })`;
3. `hitl` in `selfbuilding.config.ts`.

Each layer is merged field by field into the layer below. A per-agent `hitl` option can only tighten what the layers above set (`risk`, `timeout`, `maxAsks`). It cannot add channels or approvers. There is no singular `channel` key. `channels` is always an array.

```ts
interface HitlOptions {
  mode?: "interactive" | "afk";            // default "interactive" if any channel is set, else "afk"
  channels?: HitlChannel[];                // posted to in parallel; first answer wins
  approvers?: Approver[];                  // default: the run's requester, if known (see 8.7 rule 5)
  timeout?: Duration;                      // default "4h"
  onTimeout?: "default" | "auto" | "fail"; // default "fail"
  hotWait?: Duration;                      // default "10m"; capped per harness, see 8.4
  autoAnswer?: { model: string; maxUsd?: number }; // required for "auto"
  maxAsksPerAgent?: number;                // default 10
  maxOpenAsks?: number;                    // default 3 per run
}

type Approver =
  | { slack: string } | { discord: string } | { github: string }      // user ids / logins
  | { githubPermission: "write" | "maintain" | "admin" };            // anyone with at least this on the repo
```

A factory with an approval gate looks like this:

```ts
import { factory, ask } from "@selfbuilding/core";
import { slack } from "@selfbuilding/channel-slack";

export default factory(
  {
    name: "ship-issues",
    input: z.object({ repo: z.string(), issues: z.array(z.number()).max(30) }),
    hitl: {
      channels: [slack({ channel: "#factory" })],
      approvers: [{ slack: "U0123ALICE" }, { githubPermission: "maintain" }],
    },
  },
  async ({ repo, issues }) => {
    // ...
    const go = await ask({
      question: `Label ${ready.length} PRs ready-to-merge?`,
      choices: ["yes", "no"],
      timeout: "8h",
      onTimeout: "fail",       // a high-risk ask may never default to "yes"
      risk: "high",
    });
    return { approved: go.choiceId === "yes" };   // go.choiceId: "yes" | "no" | null
  },
);
```

With the object form, the safe choice is marked on the choice itself:

```ts
const ok = await ask({
  title: "Merge?",
  question: `PR ${impl.artifacts.pr?.url} passed review. Merge to main?`,
  choices: [{ id: "merge", label: "Merge", style: "primary" }, { id: "hold", label: "Hold", safe: true }],
  risk: "high",
});
if (ok.choiceId === "merge") await mergePr(impl);
```

Inside the sandbox the agent sees two tools from the Selfbuilding MCP server (section 4):

| Tool | Blocking | Purpose |
|---|---|---|
| `ask_human` | Yes (hot or cold wait, 8.4) | A question whose answer changes what the agent does next |
| `notify_human` | No | An FYI posted into the run thread, for example "found a second bug, filing it separately". It is rate limited the same way |

The input schema of `ask_human` is `AskSpec`, with `schema` given as JSON Schema and `choices` accepting both forms. The tool returns text the model can read:

```
Answer from @alice via Slack: choice "hold" (Hold).
```

On a timeout it returns `No human answered within 4h; proceeding with the default: "hold".` The skill loader (section 2) rewrites the Claude-only `AskUserQuestion` to `ask_human`, so existing skills work on every harness.

### 8.3 Ask identity and the ask record

An `askId` must meet two needs that pull against each other:
- A replayed factory step must find its earlier ask again, not create a second one.
- A new turn must never pick up an answer that was given to an earlier turn.

Agent asks and factory asks therefore get different keys:

```ts
specHash = sha256(canonicalJson(omit(validatedSpec, ["timeout", "onTimeout", "dedupeKey"])))

// ask_human from inside an agent: bound to one launch of that agent
askId = "ask_" + base32(sha256(`${runId}|${callPath}|${launchId}|${askSeq}|${specHash}`)).slice(0, 20)

// ask() in factory code: replay-stable, because the factory path is deterministic (section 3.8)
askId = "ask_" + base32(sha256(`${runId}|${callPath}|factory|${askSeq}|${specHash}`)).slice(0, 20)
```

- `callPath` is the call's position in the factory (section 3).
- `launchId` is `${HostKey}_l${n}`, where `HostKey` is `${StepKey}_e${Epoch}` (§7.2). These events all produce a new `launchId`:
  - a host retry;
  - `retries > 0`;
  - `onInterrupted: "resume-session"`;
  - a fresh run with the same `runId` after the previous launch died.

  An edited skill changes `stepKey` (through `skillHash`), so it also produces a new id. A cold resume (8.4) is also a new launch attempt (§7.2), but it continues the same session. The answered ask stays bound to the launch that asked it, and `askSeq` carries over in `state.json`, so a later ask in the resumed session never reuses an earlier id.
- `askSeq` counts distinct asks within one launch, or within one factory scope for factory asks. For agent asks, the runtime persists it in the attempt's `state.json`, and the state file travels with the session file across a park (section 6).
- The id is 24 characters of `[a-z0-9_]`. That fits Cloudflare Workflows event types (`^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, ≤100), Discord `custom_id` (≤100) and Slack `value`. A GitHub check-run `identifier` allows only 20 characters, so GitHub carries the id in `external_id` instead.

**Matching rules on create.** `AskStore.create` returns the existing record when the id is already taken. The core then decides what to do with it:
1. If the stored `specHash` and `launchId` both equal the new ones, it is the same ask. For example, a replayed factory step, or the harness re-sending a tool call after its own timeout. The core reuses the record. If the record is already answered, it returns that resolution at once.
2. If either one differs, it is a collision. The core emits `skip [ask-id-collision]`, derives a new id by appending `|1`, `|2`, ... to the hash input, and creates a new ask. **It never returns the old record's resolution.**
3. If an `ask_human` call's `specHash` matches an ask that is still *open* in the same launch, the call attaches to that ask and does not post a second card. This covers a harness that retries a tool call.

Each person also sees a short ordinal per run (`#1`, `#2`, ...) to use when typing replies.

The ask record lives in an `AskStore`. The store is pluggable. By default it uses the same backing store as the journal: file or SQLite locally, the host's storage in hosted mode (section 7).

```ts
interface AskRecord {
  askId: string; runId: string; ordinal: number; callPath: string;
  origin: { kind: "agent"; launchId: string; askSeq: number } | { kind: "factory"; askSeq: number };
  specHash: string;
  spec: AskSpec;                          // after validation and redaction
  status: "open" | "answered" | "expired" | "cancelled";
  resolution?: AskResolution;
  waitpoint: { host: HostId; ref: string };  // e.g. Trigger token id
  messages: ChannelMessageRef[];          // every card posted, so all of them can be edited
  reconciledAt?: string;                  // last GitHub reconcile (8.6)
  createdAt: string; expiresAt: string;
}

interface AskStore {
  create(r: AskRecord): Promise<{ status: "created" } | { status: "exists"; record: AskRecord }>;
  get(askId: string): Promise<AskRecord | null>;
  resolve(askId: string, res: AskResolution): Promise<{ won: true } | { won: false; current: AskRecord }>; // CAS on status=open
  openForThread(thread: ThreadKey): Promise<AskRecord[]>;
  open(filter: { channel?: string; runId?: string }): AsyncIterable<AskRecord>;   // used by reconcile and reminders
  setStatus(askId: string, s: "expired" | "cancelled"): Promise<void>;
}
```

`resolve` is one atomic statement. A click and a reply that arrive within seconds of each other must not both answer.

### 8.4 From tool call to durable wait

There are two wait modes. Selfbuilding picks between them, and the agent never chooses.

**The hot-wait limit depends on the harness.** A hot wait blocks one MCP tool call, and every harness enforces its own tool-call timeout. If that timeout fires first, the harness reports the ask as a failed tool call. Each adapter's `prepare()` (section 4) therefore returns the timeout it configured:

```ts
interface FilePlan {
  // ...
  mcpToolTimeoutMs: number | null;   // the per-call MCP tool timeout this adapter set; null = no limit
}
```

| Harness | How the adapter raises the limit | Verified by |
|---|---|---|
| Claude Code | `MCP_TOOL_TIMEOUT=<ms>` on the harness env | probe |
| Codex | `-c mcp_servers.selfbuilding.tool_timeout_sec=<s>` (the default is 60 s) | probe |
| OpenCode | `mcp.selfbuilding.timeout: <ms>` in `opencode.json` (the config default is 30 s; the key is unverified, §11, Q34) | probe |
| Pi | extension tool, no tool timeout | probe (`null`) |
| Amp, Droid, Grok | to verify. Until a probe passes, the adapter declares 30 s | probe |

The adapter sets the harness limit to effective hotWait + 2 min (§6.11), or to the harness's maximum if that is lower. The parse-contract probe (section 4.11, section 10) checks the value for every pinned harness version. It calls a probe tool that sleeps for `mcpToolTimeoutMs − 30 s` and asserts that the call returns normally.

The effective hot-wait limit is:

```ts
hotLimitMs = min(hotWait, mcpToolTimeoutMs - 15_000)   // mcpToolTimeoutMs null → hotWait
```

If `hotLimitMs` comes out under 30 s, the ask skips the hot wait and goes cold at once. If the harness cannot resume either, the `onTimeout` policy applies at once.

**Hot wait.** The sandbox stays up and the `ask_human` tool call blocks.
1. The MCP server hands the ask to the in-sandbox runtime. The runtime surfaces it to the orchestrator on its control channel (section 6). The sandbox needs no inbound port.
2. The orchestrator validates the spec and computes the id (8.3). It then creates the record and the host waitpoint, posts to the channels and records `ask.posted`.
3. The orchestrator waits on the waitpoint for up to `hotLimitMs`. When an answer arrives, it goes back through the runtime and the tool call returns.
4. When `hotLimitMs` passes, the MCP server returns `suspended` before the harness's own timeout can fire, and the ask moves to a cold wait.

**Cold wait.** It starts in three cases:
- `hotLimitMs` passes without an answer;
- the ask's timeout is longer than 2 hours;
- `hotLimitMs` is under 30 s.

The steps are:
1. The tool returns `suspended`: "Your question #2 is waiting for a human. End your turn now. Do not make further changes. You will be resumed with the answer." If the harness does not stop by itself, the runtime ends it through the same stop path it uses after `submit_result` (section 4).
2. The runtime persists the harness's native session id, `askSeq` and the session file (section 6).
3. The sandbox is parked with the strongest operation the provider declares (section 5):

   | Provider capability | Park | Resume |
   |---|---|---|
   | Memory pause (Impello/E2B, Daytona VM, Docker) | `pause()` | `open()` (connect), then the harness resumes its session |
   | Filesystem snapshot only (Vercel, Modal, Cloudflare, Daytona container) | `snapshot()`, then kill | create from the snapshot, restore the session file |
   | Neither | commit the work in progress to the agent's branch, have the host push it (§9.2), then kill | clone the branch into a fresh sandbox, restore the session file |

4. The call moves to `suspended` (§6.7). The host's own durable wait (8.5) takes over, and the orchestrator's compute is freed.
5. When the answer arrives, a new host step reopens or recreates the sandbox. It runs the harness's resume command (section 4: Claude `--resume <id>`, Codex `exec resume <id>`, OpenCode `--session <id>`). The next user message is `Answer to your question #2 from @alice via Slack: ...`. The resume is a new launch attempt (§7.2) that continues the same session.
6. A harness whose adapter has no `resume()` method (§4.2) gets hot waits only. When `hotLimitMs` runs out, the `onTimeout` policy applies.

Cold waits follow these rules:
- **Shared sandbox handles are hot-only.** Parking a shared sandbox would stall the sibling agents that work in it. For an agent on a shared handle, the hot-wait limit is the ask timeout, capped at 30 minutes and at the harness limit above. After that, `onTimeout` applies. To ask a long question from a shared tree, `fork()` first (section 3).
- **A cold resume never replays the interrupted turn.** It always resumes the session with the answer as a new message. Work the agent did before asking stays in the session and the filesystem and is not re-run.
- **Budget.** Hot-wait time counts toward the run's sandbox budget. Cold-wait time does not. The run's wall-clock budget (section 3) excludes cold waits, and the ask's own timeout bounds them.
- **Lifetime.** The sandbox lifetime is extended when a hot wait starts (`extendLifetime`, section 5). A memory-paused sandbox can disappear: providers delete long-paused sandboxes (Impello after 14 days) and reap stuck pauses. If the sandbox is gone when the answer arrives, the resume falls back to the snapshot or the branch. Selfbuilding never assumes a parked sandbox still exists.

### 8.5 Durable wait per host

The waitpoint is created before anything is posted. An answer therefore always finds something to resolve. Every host gets an explicit timeout.

| Host | Create and wait | Resolve (from the channel handler) | On timeout |
|---|---|---|---|
| Trigger.dev | Agent asks, in the child task: `wait.createToken({ idempotencyKey: askId, timeout, tags: [runId] })`, then `wait.forToken(token)`. Factory-side asks: a scheduler deadline on the parent's one wake stream (§7.5.1) | Agent asks: `wait.completeToken(tokenId, resolution)`. Factory-side asks: send `{ kind: "ask", askId }` on the parent's wake stream | `{ ok: false }`, then the policy (8.8) |
| Inngest | `step.waitForEvent(askId, { event: "selfbuilding/ask.answered", if: "async.data.askId == '<askId>'", timeout })` | `inngest.send({ name: "selfbuilding/ask.answered", data: { askId, resolution } })` | `null`, then the policy |
| Cloudflare Workflows | `step.waitForEvent(askId, { type: askId, timeout })` | Worker, then `env.WF.get(runId).sendEvent({ type: askId, payload: resolution })` | throws, then the policy |
| Plain Node | journal entry `{ askId, status: "waiting" }`; the process may exit | the handler writes the store; `run(runId)` resumes (via the `selfbuilding answer` CLI or a watcher) | checked on resume and by `selfbuilding reap` |

The Trigger.dev idempotency key is the full `askId`. Because the id includes `launchId` and `specHash` (8.3), a new launch never reuses an earlier launch's completed token.

Host-specific rules:
- **Store first, then wait.** The handler always writes the resolution to the `AskStore` before it resolves the waitpoint. The run reads the store before any wait starts and again after it returns. This closes two races: on Inngest, an event sent before `waitForEvent` registered is not matched, and plain Node has an equivalent one.
- **Parallel asks on Trigger.dev.** Trigger.dev rejects concurrent waits in one run, and Selfbuilding never issues them. Each `agent()` runs in its own child task and waits on its own token. Factory-side `ask()` calls are multiplexed on the parent's one wake stream (§7.5.1), so `Promise.all` over `ask()` calls works there too.
- **Cancellation does not stop sandboxes on Inngest or Trigger.dev.** When a run is cancelled, a registered cleanup marks open asks `cancelled`, edits their cards, and kills or parks the sandboxes by id (section 7.9).
- **Defaults to override.** Cloudflare's default `waitForEvent` timeout is 24 h, and Trigger.dev's is "never". Both are replaced with the ask timeout. On Inngest, the plan's maximum run length caps the ask timeout. If that cap is lower than the requested timeout, `ask()` throws when the ask is created.

### 8.6 Channels

A channel adapter turns an ask into a message, and an inbound request into an answer. It owns rendering and platform quirks. The core owns identity, authorisation, compare-and-set and waitpoint resolution.

```ts
interface HitlChannel {
  id: "slack" | "discord" | "github" | string;
  // Called once per run, lazily, at the first post.
  openThread(run: RunInfo): Promise<ThreadKey>;
  post(ask: AskRecord, thread: ThreadKey): Promise<ChannelMessageRef>;
  update(ref: ChannelMessageRef, view: AskView): Promise<void>;   // answered / expired / cancelled
  notify(thread: ThreadKey, n: Notification): Promise<ChannelMessageRef>;
  // Inbound: verify the raw request, then map to a typed event. null = not ours.
  verify(req: Request, rawBody: Uint8Array): Promise<boolean>;
  parse(req: Request, rawBody: Uint8Array): Promise<InboundEvent | null>;
  ack(ev: InboundEvent): Response;                                 // must be cheap; see deadlines below
  // Optional: pull answers that a missed webhook would have carried. See "GitHub reconcile".
  reconcile?(ask: AskRecord, since: string): AsyncIterable<InboundEvent>;
}

type InboundEvent =
  | { kind: "choice"; askId: string; choiceId: string; actor: Actor; deliveryId: string }
  | { kind: "text"; thread: ThreadKey; ordinal?: number; text: string; actor: Actor; deliveryId: string }
  | { kind: "form"; askId: string; value: unknown; actor: Actor; deliveryId: string }
  | { kind: "stop"; runId: string; actor: Actor; deliveryId: string };
```

Selfbuilding ships one fetch handler, `createHitlHandler({ channels, store, host })`, with the signature `(req: Request) => Promise<Response>`. It mounts in a Worker, Hono, Next.js or a plain Node server. Each request goes through the same steps:
1. Verify the signature.
2. Dedupe by delivery id.
3. Ack within the platform's deadline.
4. In the background (`waitUntil` on Workers): authorise the actor, resolve via compare-and-set, resolve the waitpoint and edit every card for that ask.
5. Tell a losing actor who answered first.

In v1 the handler runs in the user's own app. The later control plane (section 7) mounts the same handler. Reconciled events (below) go through steps 2, 4 and 5 of the same pipeline.

The three v1 channels compare as follows:

| | Slack | Discord | GitHub PR |
|---|---|---|---|
| Setup | Bot token, signing secret, channel id | Application id, public key, bot token, channel id | GitHub App (checks write, issues and PR write, webhook secret) |
| Run thread | Root message in the channel; asks are thread replies with `reply_broadcast: true` | Root bot message; asks go in a thread started from it | The PR's conversation; asks are issue comments (or review comments when `anchor` is set) |
| Choice buttons | Block Kit buttons, `action_id: "ns_choice"`, `value: "<askId>:<choiceId>"` | Buttons (≤5 per row), `custom_id: "ns:<askId>:<choiceId>"` | For ≤3 choices, a check run with `conclusion: "action_required"`, `external_id: askId`, one action per choice (`identifier` = choice id). Otherwise a command reply (below) |
| Free text | Thread reply (Events API `message` with matching `thread_ts`), or the "Reply" button, which opens a modal | The "Reply" button, which opens a modal (callback type 9). Thread messages are not read in v1 | `/selfbuilding <answer>` or `/selfbuilding #2 <answer>` as an issue comment, or a reply in the anchored review thread |
| Schema forms | Modal with one input per field | Modal (≤5 text inputs) | Not supported; the ask fails over to the other channels or to text (JSON) |
| Inbound auth | `X-Slack-Signature` HMAC v0 over the raw body, timestamp ≤5 minutes old | Ed25519 over timestamp + raw body | `the GitHub webhook HMAC signature header` HMAC-SHA256 over the raw body |
| Ack deadline | 200 within 3 s | Response within 3 s (type 6, deferred update) | 2xx within 10 s |
| Dedupe key | `action_ts` + user, or `event_id` | interaction id | `X-GitHub-Delivery` for webhooks; comment id for comments (also used by reconcile) |
| Missed deliveries | Events API retries up to 3 times; interactions are not retried, so the user clicks again | Interaction fails visibly in the client; the user retries | **Not retried by GitHub.** Covered by reconcile (below) |
| Later edits | `chat.update(channel, ts)`. Never `response_url`, which expires after 30 minutes and 5 uses | Bot-token `PATCH /channels/{id}/messages/{id}`. Never the interaction token (15 minutes) | Edit the comment; update the check run conclusion |
| Local development | Socket Mode (`xapp-` token); no public URL needed | Needs a public URL (a tunnel) | Needs a public URL (a tunnel), or a webhook relay |

Channel-specific rules:
- **Slack modals.** A `trigger_id` lives for 3 seconds and works once. `views.open` is therefore called inside the ack window, before the handler returns. It is the only work allowed there.
- **Slack updates.** Every `chat.update` rebuilds the full block set. Blocks that are not re-sent are dropped, and so is message `metadata`.
- **Discord free text.** Reading thread messages needs a gateway connection and the `MESSAGE_CONTENT` intent. That is a long-lived socket, which fits serverless poorly, so v1 collects free text only through the modal.
- **GitHub actions.** Check-run action clicks reach only the App that owns the check run. The GitHub channel therefore requires a GitHub App. A personal token is not enough.
- **GitHub without a PR.** The GitHub channel targets the PR or issue the run is attached to (`githubPr({ repo, number })`, or derived from the trigger). If the run has no PR or issue yet when an ask is posted, the channel is skipped with a warning and the other channels carry the ask.
- **Schema forms.** A `schema` must be a flat object of `string | number | boolean | enum`, with at most 5 fields. Any other schema is rejected when the ask is created. The agent gets a tool error that says so, and it can re-ask with `freeText`.

**GitHub reconcile.** GitHub does not retry a failed webhook delivery. A deploy, a cold start or a 5xx while someone answers would lose the answer, and the ask would later time out under `onTimeout`. Under the default `"fail"`, that kills the agent. The GitHub adapter therefore implements `reconcile()`, and the reaper (section 7.8) calls it for every open GitHub ask on every sweep:

1. **Comments.** List issue comments on the target since `max(ask.createdAt, ask.reconciledAt − 2 min)`. For anchored asks, also list review comments. Map each comment through the same `parse()` rules as a webhook (8.7). The comment id is the dedupe key, so a comment already seen through the webhook is a no-op.
2. **Check-run actions.** The REST API cannot list check-run clicks. The adapter instead lists the App's webhook deliveries since the same timestamp (`GET /app/hook/deliveries`). For each failed `check_run.requested_action` delivery, it requests a redelivery (`POST /app/hook/deliveries/{id}/attempts`). The redelivery arrives with the same `X-GitHub-Delivery`, so a delivery that had in fact been processed is deduplicated.
3. Set `reconciledAt` on the record. Each step emits `skip [reason]` for every item it ignores.

Reconcile runs only while the ask is open, at most once per ask per sweep, and it shares the App's rate-limit budget. If the reconcile call itself fails, the error is logged and the call is retried on the next sweep. A failed reconcile never resolves or expires an ask.

### 8.7 Addressing rules in threads

Each run has one thread per channel. Every ask, every FYI notification and the final summary go into it. These rules decide which message answers which ask:

1. **Buttons and forms name their ask.** The ask is decoded from the button's own value or `custom_id`, never from the text of the post.
2. **Free text is ambiguous, so it is resolved strictly:**
   - If exactly one free-text ask is open in the thread, a reply from an approver answers it.
   - If several are open, the reply must start with the ordinal (`#2 use the v2 endpoint`). Otherwise the bot replies once, listing the open asks, and nothing is answered.
   - If none are open, the reply is ignored (`skip [no-open-ask]`).
3. **Chatter is allowed.** An approver's reply that starts with `//` is never treated as an answer. Replies from people who are not approvers never count as answers. A click from someone who is not an approver gets a refusal that names who can answer ("only @alice or repo maintainers can answer this"). On Slack and Discord the refusal is ephemeral. On GitHub it is a log line.
4. **Bots never answer.** Events with a bot id, with `sender.type === "Bot"`, or from Selfbuilding's own user are dropped. So are GitHub `edited` and `deleted` comment events. Only `created` counts.
5. **Approvers resolve per channel.** Each channel's user ids are matched against `approvers`. `{ githubPermission: "write" }` is checked through the collaborator-permission API, and the result is cached for the life of the run.
   - The CLI (`selfbuilding answer`) always counts as an approver, because it needs direct access to the ask store.
   - If a run has at least one channel but no approvers and no known requester, it fails at start with `HitlConfigError`, and no ask is ever posted. An unanswerable card is worse than none. The error names the fix: "add `hitl.approvers` to the factory or to `run()`".
   - A run started from the CLI with no channels needs no approvers. It is AFK, or it is answered through `selfbuilding answer`.
6. **A re-ask replaces the old card.** If a re-ask uses the same `dedupeKey` while the earlier ask is open, the old card is marked "superseded by #3", and its waitpoint moves to the new ask. A redelivered webhook is a no-op because of the delivery-id dedupe.
7. **Answers are not editable.** Once an ask is resolved, its card shows "Answered by @alice: Hold". Edits and later replies get "already answered". To change course, the person uses the Stop button (8.10) or answers the agent's next question.

### 8.8 Timeouts and AFK policies

Each ask resolves in exactly one way:

| Situation | Resolution | `answeredBy` |
|---|---|---|
| A human answers in time | the answer | `human` |
| `mode: "afk"` | the policy applies at once, nothing is posted | `default` (`afk`) or `auto` |
| No channel can deliver | the policy applies at once | `default` (`undeliverable`) or `auto` |
| The timeout passes, `onTimeout: "default"` | `spec.default` | `default` (`timeout`) |
| The timeout passes, `onTimeout: "auto"` | an auto-answer | `auto` |
| The timeout passes, `onTimeout: "fail"` | `AskTimeoutError` | (none) |

For GitHub asks, an ask is declared timed out only after a final reconcile (8.6) has run. An answer that a webhook missed then still counts if it was given in time.

**Auto-answer.**
- It is a single model call that runs outside the sandbox with the run's credentials (section 9). The model sees:
  - the ask spec;
  - the agent's skill name and description;
  - the run inputs;
  - the last 20 transcript events, after redaction.
- It must return a valid choice id, text, or a schema-valid value, plus a one-line rationale. The cost is charged to the run budget and capped by `autoAnswer.maxUsd`, which defaults to $0.05 per ask.
- If the call fails or returns something invalid, the ask falls back to `default`, and then to `fail`.
- The agent is shown the rationale ("No human was available. An automatic reviewer chose 'hold' because ..."). It is also posted in the thread when the run has channels.

**Defaults and validation.**
- `onTimeout: "default"` requires a `default` or exactly one choice with `safe: true`, which is then used. This is checked when the ask is created. An invalid ask is a tool error to the agent at once, never a surprise hours later.
- The run defaults are `timeout: "4h"` and `onTimeout: "fail"`. Failing loudly is the right default for a library. A factory author who wants progress while nobody is there says so.

**High-risk asks.**
- An ask with `risk: "high"` is one about a merge, a deploy, a delete or spending above budget. Without a human, it can only resolve to a `safe: true` choice. Under AFK, timeout or auto, it resolves to the safe choice if there is one, and fails otherwise.
- `autoAnswer` never runs for high-risk asks.
- The agent cannot lower a risk that the factory set. A factory can force `risk: "high"` on every ask from an agent: `agent(Deploy, { hitl: { risk: "high" } })`.

**Failures and reminders.**
- **What a failure becomes.** `AskTimeoutError` fails the `agent()` call with recovery data: `askId`, `sessionId` and branch (§9.8). Inside `parallel()` and `pipeline()` the failed call becomes `null` (§1.9).
- **Reminders.** When the timeout is at least 1 hour, one reminder is posted in the thread at 75% of the timeout, mentioning the approvers. It runs as a separate delayed host job: a Trigger.dev delayed task, `step.sleep` in a sibling Inngest function, a Durable Object alarm, or `selfbuilding reap` on plain Node. It is never a parallel wait inside the run. Reminders are best-effort and never block resolution.
- **Late answers.** An answer that arrives after expiry or cancellation gets a reply saying what the run did instead ("expired at 14:02; the run proceeded with 'hold'"). It never completes the waitpoint.

**Limits.**
- At most 10 asks per agent call and 3 open asks per run, both configurable. Past either limit, `ask_human` returns a tool error that tells the agent to decide for itself.
- The limits are counted in the store, never in the prompt. They exist because a looping agent can flood a channel.

### 8.9 Notifications on completion

Every run posts a final summary to each channel thread it opened. If no ask was ever posted, the run posts to the configured channels only when `notify` asks for it.

```ts
interface NotifyOptions {
  on?: Array<"run.end" | "run.failed" | "agent.end" | "ask.expired">; // default ["run.end", "run.failed"]
  channels?: HitlChannel[];  // default: hitl.channels
  mention?: "approvers" | "none" | "on-failure"; // default "on-failure"
}
```

The summary contains:
- the status, the `RunOutcome.status` from §1.9 (`ok | partial | failed | budget_exhausted | aborted | needs_attention`);
- the factory and skill names;
- the duration and cost;
- the typed result's `summary` field if the schema has one, otherwise the first 500 characters of the result as JSON;
- the artifacts (PR URL, branch);
- the number of asks and who answered them;
- for failures, the error class, a recovery hint and the preserved branch or session id (section 9);
- a link to the transcript viewer, if one is configured.

Rules:
- **The summary is a new message.** After it has posted, the root card is edited to show the final status. If the root were edited in place to carry the summary, a late progress update could overwrite it.
- **Redact, then truncate.** All outbound text goes through the redactor first (section 9). Truncating first can publish a readable prefix of a secret. Slack section text is cut at 3,000 characters, Discord content at 2,000, and GitHub comments at 60,000.
- **GitHub uses one sticky comment.** It is found by the marker `<!-- selfbuilding:run=<runId> -->` and edited on each update. The run's check run is set to `success | failure | cancelled | timed_out`.
- **Delivery failures do not fail the run.** They are retried 3 times with backoff, then recorded as `notify.failed` in the run's events.

### 8.10 Watching a live run

Every run produces one ordered stream of normalised events. It contains the harness events from section 4 plus these run events: `phase`, `log`, `agent.start/end`, `sandbox.*`, `budget.charge`, `ask.created/posted/answered/expired/cancelled`, `ask.reconciled` and `run.end`. Every event carries the envelope from §9.7, including `seq`, which increases monotonically within its scope (§9.7).

| Consumer | How |
|---|---|
| In process | event sinks (§9.7) passed as `events` in `run(..., { events })` or `defineConfig({ events })` receive every event in order. `run()` resolves the `RunOutcome` (§1.9). Pass your own `runId` in `RunOptions` to know it before the run ends |
| Another process, plain Node | `selfbuilding watch <runId> [--from <seq>]` tails the journal store |
| Trigger.dev | a `streams.define<SelfbuildingEvent>({ id: "events" })` output stream; `selfbuilding watch` reads it with `startIndex` |
| Cloudflare | a Durable Object per run; viewers connect over hibernatable WebSockets, and events fan out from there |
| Terminal | `selfbuilding watch <runId>` renders tool calls, asks and costs live on every host |
| Slack / Discord | a throttled status line on the root card (below) |

Stream rules:
- **Watching never changes behaviour.** The event stream is write-only observability. No decision may read it: not parking, not cancelling, not deciding that a turn is idle. Writes to it fail soft.
- **Redaction and caps apply at ingest.** Each string field is capped at 8 KiB, and each batch at 200 events. Re-sends are idempotent on the event's `seq` key (§9.7).
- **No streaming handle in v1.** A library-level `watch()` and a streaming run handle are not in v1 (§11, Q19). Event sinks and `selfbuilding watch` cover the same needs.
- **Long cold waits need a heartbeat.** A Trigger.dev stream that stays empty for about an hour can be garbage-collected. During cold waits Selfbuilding writes a `heartbeat` event to the stream every 20 minutes.
- **Viewers resume by cursor.** SSE viewers send `Last-Event-ID`. The server advances the cursor only after a frame is written. It closes cleanly with `end{cursor}` before the host's request limit, so reconnecting is the normal path.
- **The transcript is sealed at the end.** It is stored as one gzipped JSONL artifact (`AgentResult.artifacts.transcript`, section 2.8). The viewer can serve it after the live stream has expired.

Chat status line:
- On Slack and Discord the root card shows the current phase, the active agents, the step count, the elapsed time and the cost. It is updated at most every 15 seconds per run (Slack `chat.update` is Tier 3), and each update rebuilds all blocks.
- The card carries a **Stop** button. A click from an approver cancels the run through the host (section 7). A click from anyone else gets the ephemeral refusal. The card says "Stopping..." only after the cancel call returns.
- GitHub gets no live line. The check run's `output.summary` is updated at phase boundaries only.

### 8.11 Testing

Section 10 owns the test layout. The HITL-specific cases are listed here. Seeds use neutral identities (`user-1`, `user-2`, `selfbuilding-bot`).

- **Slack.** The emulate.dev Slack emulator, seeded with `signing_secret` and `interactivity_url`.
  - Clicks are driven by `POST /_slack/simulate/block-actions` and forms by `/_slack/simulate/view-submission`.
  - Thread replies are posted as a seeded user.
  - Set `view_trigger_ttl_seconds` above 3, or slow CI runs flake.
- **GitHub.** The emulate.dev GitHub emulator with an App and a `webhook_secret`. Comments posted as the reviewer arrive as signed `issue_comment` webhooks.
- **Discord.** A fake built with emulate's `defineEmulator`, using an Ed25519 test keypair and a `/_discord/simulate/button` route.
- **Bad signatures.** These cases are built by hand, because the emulators always sign correctly.
- **Required scenarios, all run with the scripted harness:**
  - a click answer, and a free-text answer;
  - choice shorthand: `choices: ["yes", "no"]` posts two buttons, and the resolution has `choiceId: "yes"`;
  - an ambiguous reply with two open asks;
  - a click from someone who is not an approver;
  - a double answer: a click and a reply, plus a redelivered webhook;
  - a timeout under each policy, with fake timers;
  - a high-risk ask under AFK;
  - an undeliverable ask;
  - a channel configured with no approvers and no requester, which fails at start with `HitlConfigError`;
  - a cold wait: the process is killed while waiting, the answer is delivered, and the session resumes;
  - a late answer after expiry;
  - a shared-handle ask forced to hot-only;
  - **ask-id isolation.** Attempt 1 asks "merge?" and gets "merge". The call fails, attempt 2 asks a different first question, and a new card is posted with no answer carried over. The same check runs for `retries > 0`, for `onInterrupted: "resume-session"` and for a replay after a skill edit;
  - **replay stability.** A replayed factory-side `ask()` with an unchanged spec returns the stored answer and posts nothing;
  - **harness tool timeout.** For each harness, a hot wait of `hotLimitMs − 5 s` returns normally. A wait past `hotLimitMs` returns `suspended`, not a harness tool error;
  - **GitHub missed webhook.** A comment answer is posted while the webhook handler returns 500. The next reaper sweep resolves the ask from reconcile. A webhook replayed afterwards is a no-op.

### 8.12 Open questions

Moved to §11 (Q36 and Q50 to Q55).

## 9. Security, credentials, observability and failure modes

This section covers:
- the trust boundaries
- how credentials reach a sandbox
- who holds git write access
- egress policy
- cost caps
- the event stream
- how errors are named
- the failure modes Selfbuilding is built to prevent

Other sections own the result contract (§2), the orchestration primitives (§3), the harness adapters (§4), the provider contract (§5), the in-sandbox runtime (§6), durability hosts (§7) and HITL channels (§8). This section refers to them by number.

### 9.1 Trust boundaries

The sandbox is the isolation boundary. Harnesses run inside it with their own permission prompts turned off (§4), because otherwise an AFK run stalls on the first approval. Nothing inside the sandbox is trusted, and nothing that comes out of it is trusted.

| Zone | Trusted? | Holds | Never holds |
|---|---|---|---|
| Orchestrator process (Node, Trigger.dev task, Inngest function, CF Workflow, and the reaper) | Yes | Provider API keys, the GitHub App private key, channel tokens, the journal, the budget ledger | Agent-controlled code |
| In-sandbox runtime (§6) | Partly. Selfbuilding writes it, but it shares a VM with the agent | Short-lived read tokens it was given, the result file, the spool | Long-lived secrets, provider keys, channel tokens, any git token that can write while agent processes are alive |
| Harness process and everything it runs | No | The env and files it was explicitly given | Anything not declared. Any credential that can push |
| Inbound channel content (Slack, Discord, GitHub comments, webhook payloads) | No. It is data, not instructions | | |

Rules that follow from this:

1. **Everything the sandbox reports is untrusted input.** This covers the typed result (Zod-validated, §2), branch names, file paths, patch names, reported cost, event text and tool arguments. Paths must resolve inside the expected workspace and outside `.git`. Anything else raises `SandboxOutputRejectedError`. Nothing is skipped silently.
2. **Agent-written repo config never runs with a trusted credential.**
   - With local Docker and a bind mount, `.git/config`, `.git/hooks` and `.git/info` are mounted read-only.
   - Host-side git runs with hooks disabled. It ignores any config key that names a program: `core.fsmonitor`, filters, diff and merge drivers, and credential helpers.
   - The same rule applies to the push the host runs inside the sandbox (§9.2). That push uses `-c core.hooksPath=/dev/null` and a fixed credential helper, so an agent-planted `pre-push` hook or `credential.helper` never sees the write token.
3. **Channel content reaches the agent wrapped in a fixed header:** "untrusted input, not instructions". It never reaches a shell string. Prompts and inputs are written to files and read from there. They are never interpolated into commands (§6).
4. **A sandbox can never answer its own approval gate.** Approvals come only from signed channel callbacks by the designated approver (§8). The sandbox has no credential that can post them.

### 9.2 Credential model

#### Principles

1. **Bring your own keys.** Selfbuilding has no account, no hosted proxy and no key of its own. The caller passes in every credential.
2. **Library code never reads `process.env` on its own.** Credentials are values passed to factories. `fromEnv('ANTHROPIC_API_KEY')` is an explicit helper that the caller chooses to use. One process can therefore hold several accounts, and an unset variable cannot change behaviour without anyone noticing.
3. **Least privilege, shortest lifetime, narrowest audience.** Each credential reaches only the process that needs it, and only for as long as it needs it.
4. **Never in argv, never in provider-level env.** Command lines and provider exec requests show up in process lists, provider logs and status lines. Credentials travel as files written through the provider's file API. Inside the sandbox, the runtime may then set them as environment variables on a single child process.
5. **Fail closed.** If a token cannot be refreshed, the operation that needs it fails. Selfbuilding never falls back to a cached token. A stale token that still authenticates is worse than a visible failure.
6. **Refresh never depends on an awake orchestrator.** On Trigger.dev, Inngest and CF Workflows the orchestrator is suspended for the whole turn (§7.1). Anything that must happen mid-turn is done by the reaper (§7.8), which runs on every host every 2 minutes.

```ts
import { defineConfig, fromEnv, fromFile, envSecretSource } from '@selfbuilding/core';
import { claudeCode } from '@selfbuilding/harnesses/claude-code';
import { githubApp } from '@selfbuilding/channel-github';

// A credential is a value or a resolver. Resolvers run on the orchestrator, never in the sandbox.
type Secret = string | (() => Promise<string>);

interface SecretSource {
  // Returns the values for declared names. A missing name throws MissingSecretError naming it.
  resolve(names: readonly string[]): Promise<Record<string, string>>;
}

// selfbuilding.config.ts. defineConfig is the only config builder (§1.11).
export default defineConfig({
  harness: claudeCode({
    model: CLAUDE_MODEL,
    credentials: { kind: 'api-key', value: fromEnv('ANTHROPIC_API_KEY') },   // §4.9
  }),
  git: githubApp({
    appId: 123,
    privateKey: fromFile('./app.pem'),
    // The agent's token. Read-only; write permissions here are a ConfigError.
    agentPermissions: { contents: 'read' },     // optional: pull_requests: 'read', issues: 'read'
    requireRuleset: true,                        // default; see "Branch protection" below
  }),
  secrets: envSecretSource(),        // or a user-written SecretSource backed by their secret manager
});

// A second harness for one call takes its own credentials:
//   codex({ model: CODEX_MODEL, credentials: { kind: 'api-key', value: fromEnv('CODEX_API_KEY') } })

const Fix = ImplementSpec.with({
  secrets: ['DATABASE_URL_TEST'],    // declared names only. Nothing else passes through.
});
```

#### Credential classes

| Credential | Lives in | Reaches the sandbox? | How | Lifetime |
|---|---|---|---|---|
| Sandbox provider API key (`imp_…`, Daytona, Vercel, Modal, CF) | Orchestrator | **Never** | | Long-lived, held by the caller |
| Durable host keys (Trigger.dev, Inngest, CF) | Orchestrator | **Never** | | Long-lived |
| HITL channel tokens (Slack bot, Discord bot, GitHub App private key) | Orchestrator | **Never**. `ask()` goes from the runtime to the orchestrator (§8) | | Long-lived |
| Model API key for the harness | Orchestrator | Yes, to the harness process only | Secret file, then env on the harness child (below). Or egress header injection where the provider supports it (§9.5) | Per agent call |
| Agent git token (read) | Minted per agent call | Yes | Credential helper reading a token file | ≤ 1 h. Rewritten by the host when it reconciles, or by the reaper |
| Push token (write) | Minted by the host in the collect step (§7.4) | Only after the harness process tree has exited, for the length of one `git push` | Token file that a fixed helper reads. Deleted straight after the push | ≤ 1 h. In use for seconds |
| PR and review token | Orchestrator | **Never** | The host opens PRs and posts reviews from typed results (§2 artifacts) | ≤ 1 h |
| Declared user secrets (test DB URL and so on) | `SecretSource` | Yes, if declared | Secret file, then env on the harness child | Per agent call |
| Subscription auth files (Codex `auth.json`, Claude OAuth token) | Caller | Yes, if configured | File, mode 0600 | §4.9; §11, Q2 and Q3 |

#### How a secret enters a sandbox

Every provider uses the same delivery path:

1. The host writes secrets as files under `/run/selfbuilding/secrets/<name>` with the provider's `writeFiles`. The files are mode 0600 and owned by the agent user. A secret never goes through a command line, `SandboxSpec.env` or `ExecOpts.env`.
2. The command that launches the runtime carries no secret env. The runtime reads the files and sets the values **only on the harness child's environment**, through its own in-VM `spawn`. Provider exec calls never see the values.
   - Hooks and the caller's `sandbox.exec()` calls do not inherit model keys.
   - Declared user secrets are visible to the harness and to the commands it runs, because the code under test needs them.
   - This risk is accepted and stated plainly: anything the agent can run can read what the agent has.
3. Secrets are delivered again after every `open`, resume or reconnect. Some providers do not keep create-time env across a resume, and `/run` is cleared on reboot-style resumes. Re-delivery also means that rotated credentials take effect on the next agent call.

Provider-specific rules:

- **On E2B-compatible providers, including Impello, secrets go only as 0600 files through `writeFiles`, and they are delivered again after every `open`.** They never go in `envs` at create time or per command. The in-VM daemon logs process-start requests, including env values, to logs the whole team can see.
  - §5.5 and the §7.12.2 guide state the same rule. Passing secrets as `envs` would leak model keys into Impello logs.
- **Adapters reject secrets in env.**
  - Each provider adapter throws `SecretInEnvError` for any `SandboxSpec.env` or `ExecOpts.env` entry whose name matches the secret pattern (§9.4).
  - It throws the same error for any value equal to a secret delivered in this run.
  - The conformance suite (§10) asserts this rejection for every adapter.
- **Never use Impello's `network.rules[].transform` or `iam` for credentials.** They are stored but never applied. The adapter declares `egress.inject: false`.
- Some providers reject certain env names outright (for example `NODE_PATH`). For those names the runtime sets the value on the child process, not at sandbox level.

#### Git credentials: one model

**The agent can read and never push. The host pushes after the agent's processes are gone.** This makes §2.8.2's claim true on every host: "the agent's process never holds a credential that allows pushing".

- **Agent token (read).**
  - The `GitCredentialBroker` mints a GitHub App installation token scoped to **one repository**, with `contents: read` and `metadata: read`.
  - The caller can add `pull_requests: read` and `issues: read`, so the agent can read PR context with `gh`.
  - Any write permission in `agentPermissions` is a `ConfigError`.
  - The agent commits locally, and the runtime never asks it to push.
- **Review comments.** The agent never posts to GitHub. A skill that reviews code returns findings in its typed result. The host then posts them as a PR review with its own token (`CodeReview`, §2.10). §6.13 states the same rule.
- **Push token (write) and the push itself.** The push is not part of in-sandbox settling (§6.12, §6.13). It happens in the host-side collect step (§7.4.3). The host is awake there on every host, and it can mint a token. The collect step:
  1. waits for the outcome and for done checks to finish. Done checks run repo code, so no write token may exist while they run.
  2. confirms through `ns-reap` (§6) that the harness process tree and every agent-started descendant have exited. If any is alive, it kills the tree and confirms again. If it still cannot confirm, the push is not attempted, and the call fails with `push_failed` and recovery data.
  3. mints a token with `contents: write` for the one repository. The token has no `workflows`, `pull_requests` or `administration` permission, so changes to `.github/workflows/` are rejected by GitHub.
  4. runs the exact-value scan over the objects about to be pushed (§9.3). On a hit it stops with `SnapshotNotCleanError { target: 'push' }`.
  5. writes the token to `/run/selfbuilding/secrets/git-push-token` and runs, in one exec: `git -c core.hooksPath=/dev/null -c credential.helper= -c credential.helper=/selfbuilding/bin/git-credential-selfbuilding-push push --force-with-lease origin <refs>`.
  6. deletes the token file in the same exec, whether the push worked or not, then verifies with `ls-remote` (§6.13).

  The same path carries the WIP push on cancel (§6.10) and shared-handle git checkpoints (§3.11). Both happen at an agent-call boundary, where the host is awake.
- **Refresh of the read token.** No orchestrator stays attached to a stream, so refresh never depends on one.
  - The reaper (every 2 min, §7.8) and the host, whenever it reconciles a wake (§6.6), both hold the App key, and both already exec into sandboxes. Each one rewrites `/run/selfbuilding/secrets/git-token` in any **running** sandbox whose token expires within 15 minutes.
  - The token's expiry is written next to it, in `git-token.exp`.
  - Paused sandboxes are skipped, because a refresh must not wake a box. They get a fresh token on `open`.
  - On plain Node the wait loop does the same check on each poll.
- **Fail closed.** If the read token expires and no refresh landed, the helper exits non-zero, `git fetch` fails with an auth error, and the runtime emits `credential.refresh_failed`. The push does not depend on the read token, so a long turn can still push.
- **L3 test (§10).** On each durable host, a scripted turn runs with the token TTL set shorter than the turn. The test asserts that mid-turn fetches still succeed after the original expiry and that the final push succeeds.
- **Credential helper.** `/run/selfbuilding/bin/git-credential-selfbuilding` reads the read-token file. It answers only for `protocol=https` with `host` equal to the configured git host. That blocks exfiltration through a malicious submodule or `git ls-remote https://attacker`. `gh` authenticates through a shim that reads the same file.
- **Branch protection is required.** A GitHub token cannot be limited to a branch prefix. The App installation has write access, so it needs a repository ruleset that blocks the App from creating, updating or deleting any ref outside `refs/heads/selfbuilding/*` and `refs/selfbuilding/*`.
  - `selfbuilding doctor` **fails**, and does not just warn, when the App can write to the repo and no such ruleset applies.
  - The broker checks the same thing at the first write mint of each run and throws `UnprotectedRepoError`.
  - `githubApp({ requireRuleset: false })` turns the check off for throwaway repos and emits `credential.unprotected` on every push.
  - The runtime-side refusal to push outside `selfbuilding/*` (§6.13) stays as a second layer.
- **Fine-grained PATs.** These are accepted for local Docker and for repos where the caller has no GitHub App. Pass them as `pat({ read, push })`.
  - With a separate read PAT, the agent gets it the same way it would get an App read token.
  - With only one PAT, it is used for the clone before the harness starts and for the host push afterwards. It is deleted before the harness launches, so the agent gets no git token.
  - Every agent call emits `credential.long_lived` as a warning.
  - A PAT is never written into a snapshot (§9.3).
- **Identity.** The runtime sets `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` on the harness env. These override every git config layer. The default is the App's bot identity. Without an explicit identity, agents make one up.
- `GIT_TERMINAL_PROMPT=0` is always set, so a missing credential fails at once instead of hanging.
- **A later option.** When the control plane exists (§7.11), a `refresh: 'pull'` mode lets the helper fetch read tokens itself. It authenticates with a run-scoped HMAC bearer derived from `runId + callPath`, and the broker recomputes the HMAC from the target the request acts on. v1 ships refresh by the reaper and the host only.

#### Harness configuration isolation

Every harness runs with its own `HOME`, plus `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `OPENCODE_CONFIG`, all under `/selfbuilding/home` (§4.4, §6.4). This keeps hooks, skills, MCP servers and keys from the image or from a developer's machine out of the run (§4).

It matters for credentials for one specific reason. An `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` left in the environment overrides file-based or OAuth auth. The runtime therefore strips the variables that belong to the auth mode that is not in use.

### 9.3 Secrets never leave the sandbox in snapshots, images, checkpoints or pushes

There are two rules:
- Nothing that leaves the sandbox may contain a credential. That covers snapshots, forks, images, checkpoint refs and pushed branches.
- Snapshots happen only at a clean boundary.

1. **Templates and images carry no auth.** Selfbuilding's image builders refuse a build arg or `setEnvs` value whose name matches the secret pattern (§9.4). The error is `ImageSecretError`.
2. **`snapshot()` and `fork()` (§3, §5) need a quiescent sandbox.** They are valid only between agent calls.
   - The runtime asks `ns-reap` for every process still alive under it. If any process that the harness or an agent tool started is alive, the snapshot is refused with `SnapshotNotCleanError { target: 'snapshot', reason: 'live_process', pids }`. Processes started by hooks are allowed, but their environment is scanned (below).
   - Before the provider call, the runtime:
     1. deletes `/run/selfbuilding/secrets/` and both git token files.
     2. removes the credential helper entry from `~/.gitconfig`, plus any harness auth files it wrote, such as `auth.json` and MCP configs that carry headers.
     3. runs the **exact-value scan** (below) over the whole sandbox.
     4. throws `SnapshotNotCleanError { target: 'snapshot', locations }` on any hit, and does not snapshot.

   v1 does not offer a memory fork of a live harness. Agents share state through the filesystem, branches and typed results (§3), because process memory would carry keys into the fork.
3. **The exact-value scan.** Selfbuilding knows every secret value it delivered to the sandbox. The scan looks for each value, and for its base64 and URL-encoded forms, as raw bytes. It reads binary files byte for byte, so SQLite databases and other binary caches are covered. It scans:
   - `$HOME`, the workspace including ignored files, `/tmp`, `/var/tmp` and `/run`.
   - shell history files anywhere on disk (`/root`, `/home/*`, `$HISTFILE`).
   - every git object, loose or packed, reachable or not: `git cat-file --batch-all-objects --batch`. Plain grep cannot see zlib-compressed objects or packfiles, and that is exactly where an agent's `git commit` of a `.env` lands. Reflogs and stashes are covered too.
   - `/proc/*/environ` and `/proc/*/cmdline` of every process still alive.
   - `.gz`, `.tgz` and `.zip` files under `$HOME` and the workspace, decompressed up to 64 MiB each.

   Other compressed or encrypted formats are not opened. That residual risk is stated here and covered by short token lifetimes.

   A hit reports the path, git object id, or pid. The error message names the fix: remove the file, and for a git hit, rewrite the commit and run `git gc --prune=now`.
4. **Checkpoints and pushes are scanned before they leave.**
   - The shared-handle git checkpoint (§3.11) and the leftover and WIP commits (§6.13) stage tracked and untracked files **excluding ignored files**.
   - Before staging, the runtime also writes a built-in exclude list into `.git/info/exclude`: `.env`, `.env.*`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `.git-credentials`. A `.env` written by `start.sh` (§5.10) is therefore never committed, even when the repo does not ignore it. §3.11 applies the same narrowing to its checkpoints.
   - Before any push, the host scans the objects being pushed: `git rev-list --objects <refs> --not --remotes`, fed to `git cat-file --batch`. A hit fails with `SnapshotNotCleanError { target: 'checkpoint' | 'push', locations }`. Nothing is pushed, the sandbox is kept for inspection, and Selfbuilding never rewrites history automatically.
5. **Pausing a sandbox in place is allowed while a harness is idle.** Examples are the cold `ask()` wait (§8) and an expired timeout with `onTimeout: 'pause'`. The pause stays with the same sandbox and the same owner, and it is never exported.
   - Secret files are deleted before the pause and delivered again on resume.
   - The only git credential that can be in a paused sandbox's memory is the read token, which expires within an hour.
6. **Snapshots outlive sandboxes.** The journal (§7) records every snapshot id and checkpoint ref it created, together with the clean-scan result, so a later audit can confirm each one.

### 9.4 Redaction

Every sink is redacted:
- the event stream
- journal entries
- transcript artifacts
- HITL messages
- PR bodies and comments
- error messages
- `phase` details
- logs

How redaction works:

- **Layer 1 matches exact values.** The values are every secret Selfbuilding delivered or resolved for the run, which it holds in memory. They also include env values whose name matches `/key|token|secret|password|credential|auth|cookie|dsn|private/i`. Names ending in `_url`, `_path` or `_id` are excluded. A value must be 12 to 4096 characters long with no whitespace. Values are replaced longest first. Adapters use the same name pattern for `SecretInEnvError` (§9.2).
- **Layer 2 matches patterns.** It catches `Bearer …`, `sk-…`, `ghp_…`/`ghs_…`/`github_pat_…`, `xox[abpr]-…`, `imp_…`, `sgamp_…`, PEM blocks and JWTs.
- **Redact before truncating.** If text is truncated first, a readable prefix of a secret gets published.
- **The redactor is a pure function with no I/O,** so it cannot fail at run time. Tool inputs and tool outputs are redacted too. Leaks most often happen through a diagnostic command whose output is echoed back in a tool result.
- **A canary test checks the result.** The conformance suite (§10) puts a canary secret into a run. It asserts that:
  - the canary appears in no sink and in no pushed object;
  - an undeclared canary env variable never reaches the sandbox.

### 9.5 Egress

```ts
type EgressPolicy =
  | 'open'
  | 'deny-all'
  | { allow: string[] /* domains with *. wildcards, or CIDRs */; inject?: EgressInject[] };

interface EgressInject { host: string; headers: Record<string, Secret> } // applied outside the sandbox
```

**The default is `'open'`.** Coding agents install packages from registries nobody can list in advance, and three of the six providers cannot filter by domain natively. The effective policy is recorded on `sandbox.created`.

**Recommended for production AFK runs:** `{ allow: [...presets.agent, ...presets.npm, 'github.com'] }`. `presets.agent` covers the model provider hosts for the chosen harness.

Rules:

1. **Never weaken a policy without saying so.** If the provider cannot enforce the requested policy exactly, sandbox creation throws `EgressPolicyUnsupportedError {provider, requested, supported}`. A domain allowlist on Daytona fails this way, for example.
2. **Always send the whole policy.** On E2B/Impello, Vercel and Daytona, a runtime update replaces the rules rather than merging them. Adapters therefore always send the full policy.
3. **Block cloud metadata.** `169.254.169.254` and `metadata.google.internal` are denied wherever the provider supports deny rules.
4. **No inbound traffic by default.** The runtime only connects outbound. Preview ports are declared up front in `create({ ports })` (§5) and are private unless `public: true`.
5. **Injected credentials stay out of the sandbox.** Where `inject` is supported, model API keys are added at the egress layer and never enter the sandbox. Use it wherever it is available.

| Provider | `deny-all` | Domain allowlist | CIDR allowlist | `inject` |
|---|---|---|---|---|
| Docker (local) | Yes (`NetworkMode: none`) | Yes, through the Selfbuilding egress proxy sidecar | Yes, through the proxy | Yes, through the proxy (v1.1) |
| Impello / E2B | Yes | Yes (`allowOut` plus deny-all) | Yes | **No.** The adapter declares it unsupported |
| Daytona | Yes (`networkBlockAll`) | **No** → throws | Yes (≤ 10, IPv4; runtime change only on tier 3+) | No |
| Vercel Sandbox | Yes (also blocks DNS) | Yes | Yes | Yes (Pro/Enterprise) |
| Modal | Yes | Yes | Yes | No |
| Cloudflare Sandbox | Yes (`enableInternet: false`) | Yes, enforced in the Selfbuilding facade Worker's outbound interceptors | No | Yes |

### 9.6 Cost and resource caps

A run has one `Budget`. Every agent in the run tree shares it (§3), including nested factories.

```ts
// The one Budget type. Concurrency is not part of it: see `concurrency` in RunOptions (§3.3, §3.12).
interface Budget {
  usd?: number;                       // model spend plus estimated sandbox spend
  tokens?: number;                    // total input + output tokens across the run
  wallClock?: Duration;               // whole run, excluding cold ask() waits (§8)
  perAgent?: { usd?: number; wallClock?: Duration; maxTurns?: number };
  minAgentUsd?: number;               // smallest slice worth launching; default min(perAgent.usd, 10% of usd)
  prices?: Record<string, ModelPrice>;// overrides or additions to the built-in price table
  allowUnmetered?: boolean;
}
```

How spend is measured:

| Source | Harness or provider | Measured as |
|---|---|---|
| Native cost | Claude Code (`total_cost_usd`), OpenCode (`step_finish.cost`), Amp, Droid | The reported USD, cumulative within one harness process |
| Tokens × price | Codex, Pi, Grok | Usage events × the price table |
| Sandbox time | All providers | Running seconds × vCPU × the adapter's published rate. This is an estimate and events label it as one |

**How the shared budget is enforced.** It is enforced at admission and through per-agent hard caps, not by a live cutoff across agents.

On Trigger.dev, Inngest and CF Workflows, the orchestrator is suspended during turns. It sees usage only when a child completes, when it reconciles a wake, or on a reaper sweep, and each runtime sees only its own agent. A promise to stop every agent the moment the shared total runs out would therefore be false, and a run with N concurrent agents could overshoot by up to N times the per-agent spend. Reservations close that gap.

1. **Admission reserves a slice.** When an agent launches, the host computes:

   `unreserved = usd − charged − Σ(reservations of in-flight agents)`

   `slice = min(perAgent.usd ?? usd / concurrency.sandboxes, unreserved)`

   - If `slice < minAgentUsd`, the agent does not start. The call throws `BudgetExceededError {phase: 'admission'}`, and `parallel()` and `pipeline()` turn that into `null` (§1.9).
   - Otherwise the slice is reserved in the journal and passed to the runtime as that agent's hard cap.
   - When the agent ends, the reservation is released and replaced by the actual charge.
   - The sum of slices never exceeds `usd`. Overshoot is therefore bounded by each runtime's metering lag, not by N.
2. **Each runtime enforces its own slice.** The runtime meters every usage event against its slice. When the slice is crossed, it sends SIGINT to the harness process group, waits 5 s, then sends SIGKILL.
   - The agent ends with `BudgetExceededError {phase: 'running'}`. The error carries the branch, local commits (the host still pushes them in collect), the transcript and `sessionId`, so the caller can resume with a bigger budget.
   - A second, native fence is set where the harness has one. Claude Code gets `--max-budget-usd` equal to the remaining part of the slice.
3. **A live cross-agent cutoff is a control-plane feature.** Reducing in-flight slices when the shared total moves, and stopping agents mid-turn because siblings spent the budget, need an always-awake coordinator. That arrives with the control plane (§7.11).
   - On durable hosts, `budget.charged` events reach the orchestrator when it reconciles a wake or on a reaper sweep.
   - §1.8, §3.12 and §8.10 describe the same limit: in v1, running agents are bounded by their own slices, not stopped by siblings' spend, and on durable hosts the chat status line updates when the host reconciles or the reaper sweeps.
4. **Unknown prices fail loudly.** A token-metered harness on a model that is missing from the price table throws `UnknownModelPriceError {model}` at admission. The caller can supply a price, or pass `budget.allowUnmetered: true`, which emits a warning on every agent call.
5. **Charges are idempotent and summed across turns.** One attempt can have several harness processes: done-check retries, the `no_result` nudge, interrupted resumes, and turn-boundary messages. Cumulative counters such as Claude's `total_cost_usd` reset with each process.
   - The runtime assigns a `turnIndex`, stores it in `state.json`, and stamps it on every usage event. The index is monotonic per attempt, including across launches. A new sandbox starts from the base the host passes in the spec.
   - The ledger charges `Σ over turnIndex of max(cumulative seen)` for each `(callPath, attempt, turnIndex)`. Non-cumulative usage events are summed, with duplicates removed by `(runId, callPath, launchId, seq)`.
   - Resent events never double-count, and a replayed agent (§7) is never charged again.
   - If an agent crashes mid-turn, that turn is charged its last cumulative value, and the charge is marked `estimated: true`.
6. **Wall clock is Selfbuilding's own clock.** Trigger.dev's `maxDuration` limits orchestrator CPU, not sandbox time, so Selfbuilding does not rely on it.
7. **Timeouts form an ordered chain, checked when config is built.** The order must be: per-call `timeout` < sandbox provider lifetime < dead-run closer (§6.11, §7.7). Breaking the order throws `TimeoutOrderError`, a `ConfigError` (§9.8). If the order is inverted, the provider freezes or kills a sandbox before the runtime can stop the harness cleanly and before the host can push the work.
8. **The concurrency cap is a semaphore over sandboxes, not agents.**
   - A shared sandbox handle counts once.
   - Host-level concurrency (Inngest, Trigger.dev) does not count live sandboxes, because waiting steps release their slot. Selfbuilding therefore keeps its own semaphore in the journal store, or in a Durable Object on the control plane.
   - Rate-limit responses (429, `RateLimitError`, E2B `ServiceBusyError`) back off with full jitter **on create only**. Exec is never retried.

### 9.7 Telemetry and events

#### Envelope

Every event from every layer shares one envelope. Harness events are normalised in §4.3. Orchestration events (`phase`, `log`) are defined in §3.7. This is the one `EventEnvelope`, and it defines the `seq` scope for the whole spec. §4.3, §6.6, §7.11 and §8.10 use the same tuple.

```ts
interface EventEnvelope {
  v: 1;
  runId: string;
  callPath: string;        // agent call path, stable across replay (§3); "run" for run-level events
  launchId: string;        // §7.2 for agent events; `epoch-<processEpoch>` for run-level events
  attempt: number;
  turnIndex?: number;      // set by the runtime on harness events (§9.6)
  sessionId?: string;      // harness events: the harness session (§4.3)
  parentToolUseId?: string;// harness events: subagent nesting inside the harness (§4.3)
  seq: number;             // monotonic per (runId, callPath, launchId); never reused
  ts: string;              // ISO 8601
  traceId: string;         // equal to runId unless the caller passes one
  type: string;            // e.g. "sandbox.created", "harness.tool.started"
  level: 'debug' | 'info' | 'warn' | 'error';
}
```

- **Agent events.** The runtime numbers events per launch and persists `lastSeq` in `state.json`, so a runtime restart continues the sequence. A new launch has a new `launchId` and starts again at 0 with no collision.
- **Run-level events.** `processEpoch` is a ULID minted whenever an orchestrator process or host invocation starts running the factory body. Sequence numbers restart per epoch. A resumed process therefore never reuses a `(launchId, seq)` pair, and ingest never drops post-resume events as duplicates.
- **Ingest** is idempotent on `(runId, callPath, launchId, seq)`.

Event families defined by this section:

- `credential.minted` / `refreshed` / `refresh_failed` / `long_lived` / `unprotected`. These carry names, permissions and expiry only, never values.
- `egress.applied`
- `budget.reserved` / `budget.charged` / `budget.warning` (at 80%) / `budget.exceeded`
- `sandbox.created` / `paused` / `pause_refused` / `rebuilt` / `killed` / `reaped`
- `scan.clean` / `scan.hit` (locations only, never values)
- `harness.version`
- `skip {reason}`
- `error {code, retryable}`
- `telemetry.dropped {count}`

Every agent start records:

- the harness and its `--version` output
- the provider, template or image id, and SDK versions
- the skill hash (§2)
- the effective egress policy, budget slice and git token permissions

Templates are rebuilt underneath you, so the version you planned against is not always the one that ran.

#### Sinks

- An `EventSink` callback (`events` in `RunOptions` or `defineConfig`): synchronous and fail-soft.
- A JSONL file per run: the default for plain Node.
- An OpenTelemetry exporter (`@selfbuilding/otel`): one span per run, one per agent, and one per sandbox operation.
- Host adapters (§7) mirror progress into Trigger.dev run metadata and streams, Inngest step output, or a CF Durable Object. On durable hosts this happens whenever the host reconciles a wake.

#### Rules

1. **Observability is write-only.** No behaviour may depend on reading the event store. Park, reap, retry and budget decisions read the journal and the in-sandbox turn lock (§6), never telemetry. A sink that nothing writes to must not be able to freeze a live agent.
2. **Sink failures are fail-soft and counted.** Dropped events add to a counter that is reported once per agent as `telemetry.dropped`. A failing sink never fails a run.
3. **Size limits are a security boundary.** Strings are capped at 8 KiB and events at 16 KiB, after redaction. Larger payloads become artifacts (transcript, diff) referenced by URL or path.
4. **Critical events are acknowledged and replayed** between runtime and orchestrator. These are `result.submitted`, the terminal agent event, `push.completed` (now emitted by the host's collect step) and `ask.created`. Everything else is at-most-once with a bounded buffer (§6).
5. **Nothing phones home.** Selfbuilding sends no telemetry anywhere unless the caller configures a sink.
6. **In-sandbox logs survive resume.**
   - The runtime writes to `/selfbuilding/state/logs/`, never `/tmp`, which several providers wipe on resume.
   - It captures hook stdout and stderr instead of discarding them.
   - It installs `uncaughtException` and `unhandledRejection` handlers before any module-body code runs. A crash in a detached process therefore writes one FATAL line and reports a failed agent rather than nothing.

### 9.8 Loud, named errors

**Rule: a failure is either a typed error that tells you what to do next, or a `skip` event with a reason. Nothing disappears quietly.**

This subsection is the only error registry in the spec. It owns the `SelfbuildingError` base class, the one `ErrorCode` union and the `recovery` shape. Other sections list the classes they raise and point here.

```ts
// @selfbuilding/core
abstract class SelfbuildingError extends Error {
  abstract readonly code: ErrorCode;   // stable, documented, safe to switch on
  abstract readonly retryable: boolean;
  readonly kind: 'usage' | 'agent';    // usage errors extend SelfbuildingUsageError and always throw (§1.9, §3.1)
  readonly runId?: string;
  readonly callPath?: string;
  readonly recovery?: Recovery;
}

abstract class SelfbuildingUsageError extends SelfbuildingError {}   // kind: 'usage'

/** Everything needed to pick up the pieces by hand. Every field is optional. */
interface Recovery {
  branch?: string;                  // the call's branch, pushed or local
  headSha?: string;
  commits?: string[];
  sessionId?: string;               // the harness session, resumable with the same harness version (§4.7)
  sandbox?: SandboxRef;             // when the box was kept
  snapshotId?: string;
  transcript?: ArtifactRef;         // read with ref.text() (§2.8.1)
  lastValidResult?: unknown;        // DoneCheckFailedError, ArtifactError
  skill?: { name: string; hash: string };
}

type ErrorCode =
  // usage and configuration
  | 'config' | 'timeout_order' | 'provider_lifetime' | 'nesting_depth' | 'non_determinism'
  | 'duplicate_label' | 'sandbox_handle_scope' | 'sandbox_busy' | 'not_owner' | 'sandbox_cap_deadlock'
  | 'run_id_conflict' | 'no_active_run' | 'journal_version' | 'skill_load' | 'duplicate_skill'
  | 'contract' | 'input_invalid' | 'hitl_config' | 'ask_spec'
  // credentials, secrets and policy
  | 'secret_missing' | 'credential_missing' | 'credential_refresh' | 'repo_unprotected'
  | 'secret_in_env' | 'egress_unsupported' | 'image_secret' | 'price_unknown'
  // result contract
  | 'no_result' | 'result_invalid' | 'result_integrity' | 'done_check_failed'
  | 'skill_context_failed' | 'artifact_failed'
  // harness
  | 'harness_start' | 'harness_protocol' | 'harness_error' | 'harness_version_unavailable'
  // sandbox
  | 'sandbox_unavailable' | 'sandbox_guest_gone' | 'sandbox_not_found' | 'sandbox_file_not_found'
  | 'exec_timeout' | 'sandbox_quota' | 'sandbox_auth' | 'sandbox_wedged' | 'sandbox_unsupported'
  | 'sandbox_not_quiescent' | 'sandbox_output' | 'snapshot_unclean' | 'image_unavailable'
  | 'image_activation_pending'
  // lifecycle and budget
  | 'budget' | 'timeout' | 'idle_timeout' | 'boot' | 'interrupted' | 'lost' | 'push_failed'
  | 'host_step_limit' | 'aborted'
  // durability
  | 'journal_conflict' | 'journal_divergence' | 'lease_lost'
  // HITL
  | 'ask_timeout' | 'ask_cancelled' | 'channel_delivery' | 'webhook_signature';
```

The runtime's `Outcome.reason` (§6.7) and the `code` on `Settled` (§1.9) are typed as `ErrorCode`. `aborted` has no class: when an `AbortSignal` cancels a call, the promise rejects with `signal.reason`, and `.settled()` reports `code: 'aborted'` (§6.10).

1. **Errors are classified once, at the adapter boundary.** Above the adapters, nothing reads `error.message`. The adapter maps HTTP statuses and SDK error classes to Selfbuilding classes (§4, §5).
2. **Every guard that drops work logs `skip [reason]`.** Examples are a duplicate webhook, a click from someone who is not an approver, an inbound message for an unknown run, and an ask answered after it expired. A bare `return` in a guard is a lint error in the Selfbuilding repo (§10).
3. **A typed outcome still gets logged.** When an operation returns an outcome instead of throwing, such as `pause()` returning `{confirmed: false}`, the adapter emits an error-level event itself. Turning a throw into a return value removes the log line that every `catch` used to write.
4. **Messages say what to do next.** For example: `MissingSecretError: DATABASE_URL_TEST is declared by agent "fix/0" but SecretSource returned nothing. Add it to your secret store or remove it from secrets: [...]`.
5. **Import-time code never throws.** An unknown provider or harness name fails when the factory is built, not when the module is imported. Otherwise an import-time throw on a webhook route becomes a silent 500.
6. **Deterministic failures are not retried.** Retrying them only burns time and budget. Each class declares `retryable`, and hosts (§7) use it to decide.
7. **Every class name ends in `Error`.** Retired names (`AgentError`, `FailureReason`, `DoneCheckError`, `InterruptedError`, `BudgetExhaustedError`, `ParallelWaitError`, and the suffix-less sandbox names) do not exist.

**Usage errors** (`kind: 'usage'`, extend `SelfbuildingUsageError`, never retried, thrown through every primitive including `.settled()`):

| Error | `code` | Raised when |
|---|---|---|
| `ConfigError` | `config` | Invalid options, write permissions in `agentPermissions`, a missing `deployment` on a hosted host (§5.2) |
| `TimeoutOrderError` (extends `ConfigError`) | `timeout_order` | The §6.11 timeout chain is broken. Names the two values |
| `ProviderLifetimeError` (extends `ConfigError`) | `provider_lifetime` | A call cannot fit the provider's session maximum, even with continuation (§7.7) |
| `NestingDepthError` | `nesting_depth` | A nested factory goes deeper than one level (§3.7) |
| `NonDeterminismError` | `non_determinism` | Strict mode found non-deterministic factory code (§3.8) |
| `DuplicateLabelError` | `duplicate_label` | Two calls or handles in one scope share a label (§3.2) |
| `SandboxHandleScopeError` | `sandbox_handle_scope` | A shared handle used outside the scope that owns it (§3.11) |
| `SandboxBusyError` | `sandbox_busy` | A second concurrent call on a shared handle (§3.11) |
| `NotOwnerError` | `not_owner` | An operation on a handle owned by another run (§3.11) |
| `SandboxCapDeadlockError` | `sandbox_cap_deadlock` | The sandbox cap can never admit the waiting calls (§3.12) |
| `RunIdConflictError` | `run_id_conflict` | A `runId` reused with a different factory or input (§3.2) |
| `NoActiveRunError` | `no_active_run` | A primitive called outside a running factory (§1.8) |
| `JournalVersionError` | `journal_version` | The journal was written by an incompatible Selfbuilding version (§3.9) |
| `SkillLoadError` / `DuplicateSkillError` / `ContractError` / `AgentInputError` | `skill_load` / `duplicate_skill` / `contract` / `input_invalid` | Skill loading and input validation (§2.9) |
| `HitlConfigError` | `hitl_config` | Channels configured with no approvers and no requester (§8.7) |
| `AskSpecError` | `ask_spec` | An invalid `AskSpec`, for example a bad choice id (§8.2) |
| `HostStepLimitError` | `host_step_limit` | The plan-time step estimate exceeds the host limit (§7.5.2). At run time the same class is raised as an agent-level error once the step counter is nearly spent |

**Credential, secret and policy errors:**

| Error | `code` | Retryable | Raised when |
|---|---|---|---|
| `MissingSecretError` | `secret_missing` | No | A declared secret was not resolved. Names the variable and the agent |
| `MissingCredentialError` | `credential_missing` | No | A harness, channel, provider or git credential is absent. Names the consumer |
| `CredentialRefreshError` | `credential_refresh` | Yes, once | A token could not be minted or refreshed. Never falls back to a cached token |
| `UnprotectedRepoError` | `repo_unprotected` | No | The App can write to the repo and no ruleset limits it to `selfbuilding/*`. Names the repo and the ruleset to add |
| `SecretInEnvError` | `secret_in_env` | No | An adapter was given a secret-named or known secret value in `SandboxSpec.env` or `ExecOpts.env` |
| `EgressPolicyUnsupportedError` | `egress_unsupported` | No | The provider cannot enforce the requested policy (§9.5) |
| `ImageSecretError` | `image_secret` | No | An image build arg or env value matches the secret pattern (§9.3) |
| `UnknownModelPriceError` | `price_unknown` | No | A token-metered model is not in the price table (§9.6) |

**Agent-level errors** (`kind: 'agent'`; thrown by agent calls, turned into `null` by `parallel()` and `pipeline()`, reported as `{ ok: false, code }` by `.settled()`):

| Error | `code` | Retryable | Raised when |
|---|---|---|---|
| `NoResultError` | `no_result` | No | No `submit_result` after the resume nudge (§2.6.5) |
| `ResultValidationError` | `result_invalid` | No | Submit attempts exhausted, or the host re-parse failed (§2.6.4) |
| `ResultIntegrityError` | `result_integrity` | No | The result file failed the owner/mode check, or `requireIsolation` was not met (§2.6.4) |
| `DoneCheckFailedError` | `done_check_failed` | No | Done retries exhausted. Carries `lastValidResult` (§2.7) |
| `SkillContextError` | `skill_context_failed` | Yes, once | A `` !`cmd` `` expansion failed or timed out (§2.3.4) |
| `ArtifactError` / `ArtifactPathError` | `artifact_failed` | Collection only | Collection failed after a valid result (§2.8.2) |
| `BudgetExceededError` | `budget` | No | Admission or the per-agent slice limit was reached. `phase: 'admission' \| 'running'` (§9.6) |
| `HarnessStartError` | `harness_start` | No | Binary missing, auth rejected at start, bad flags, the `selfbuilding` MCP server never connected (§4.12) |
| `HarnessProtocolError` | `harness_protocol` | No | The stream broke the adapter's parse contract (§9.9, CLI drift) |
| `HarnessStreamError` | `harness_error` | Depends on the cause (`rate_limit` yes, `auth` no) | The harness reported an error event, even if it exited 0. Carries the `HarnessFailure` (§4.12) |
| `HarnessVersionUnavailableError` | `harness_version_unavailable` | Network causes only, before the harness starts | The planned or session version cannot be installed (§4.7, §4.11) |
| `SandboxUnavailableError` | `sandbox_unavailable` | Yes | Network error, 5xx, timeout or unknown outcome from the provider (§5.3) |
| `SandboxGuestGoneError` (extends `SandboxUnavailableError`) | `sandbox_guest_gone` | Treated as a ghost (§9.9) | Connected, but the guest stayed silent for the whole open deadline |
| `SandboxNotFoundError` | `sandbox_not_found` | No | A **positive** not-found (404) |
| `SandboxFileNotFoundError` | `sandbox_file_not_found` | No | The box is fine but the file is missing |
| `SandboxCommandTimeoutError` | `exec_timeout` | Only if the command is `idempotent` | The exec deadline passed. Carries `mayStillBeRunning` |
| `SandboxQuotaError` | `sandbox_quota` | Yes, with backoff | 429, concurrency cap or start-rate cap |
| `SandboxAuthError` | `sandbox_auth` | No | 401/402/403 from the provider. Affects the whole fleet |
| `SandboxWedgedError` | `sandbox_wedged` | No | The provider says paused while the VM is running. Needs a human |
| `SandboxUnsupportedError` | `sandbox_unsupported` | No | The backend refused an optional operation (§5.3) |
| `SandboxNotQuiescentError` | `sandbox_not_quiescent` | `busy` and `unknown` only, after the turn ends | A snapshot or fork on a box that is not at a clean boundary (§5.8) |
| `SandboxOutputRejectedError` | `sandbox_output` | No | An untrusted path, ref or artifact failed validation (§9.1) |
| `SnapshotNotCleanError` | `snapshot_unclean` | No | The exact-value scan found a secret, or a live agent process blocked a snapshot. `target: 'snapshot' \| 'checkpoint' \| 'push'` |
| `ImageUnavailableError` | `image_unavailable` | No; falls back to the harness image (§5.7) | A repo image was retired or cannot be resolved |
| `ImageActivationPendingError` | `image_activation_pending` | Yes | A freshly built image is not yet resolvable (§5.7) |
| `CallTimeoutError` | `timeout` | No | The call's active-time `timeout` passed (§6.11) |
| `IdleTimeoutError` | `idle_timeout` | No | No harness output for `timeouts.idle` (§6.11) |
| `BootTimeoutError` / `HookTimeoutError` | `boot` | Yes, boot only | A boot phase or hook exceeded its timeout (§6.5, §6.11) |
| `AgentInterruptedError` | `interrupted` | No | A turn died with no outcome and `onInterrupted` is `fail`, or resume was impossible (§3.10, §6.8) |
| `AgentLostError` (extends `AgentInterruptedError`) | `lost` | No | The reaper's dead-run closer marked the call lost (§5.9, §6.11) |
| `PushFailedError` | `push_failed` | Yes, once, when the remote was verified not to have the commit | The host push failed, or the harness tree could not be confirmed exited (§9.2) |
| `AskTimeoutError` | `ask_timeout` | No | An ask timed out under `onTimeout: "fail"` (§8.8) |
| `AskCancelledError` | `ask_cancelled` | No | The ask was cancelled with its run (§8.5) |

**Durability and channel errors** (infrastructure; hosts retry them by `retryable`):

| Error | `code` | Retryable | Raised when |
|---|---|---|---|
| `JournalConflictError` | `journal_conflict` | No | Two writers claimed the same run step (§7) |
| `JournalDivergenceError` | `journal_divergence` | No | Replay found a different call at a recorded position (§7.3) |
| `LeaseLostError` | `lease_lost` | No | The local journal lease was taken over (§3.9, §7.5.4) |
| `ChannelDeliveryError` | `channel_delivery` | Yes | A channel post or update failed after retries (§8.9) |
| `WebhookSignatureError` | `webhook_signature` | No | An inbound channel request failed verification (§8.6) |

### 9.9 Known failure modes and the mechanism that prevents each

Each entry names a mechanism that runs in code, not a convention. Each mechanism has a test in the conformance, scripted-harness or host suites (§10).

Some channel tests depend on emulator features that are not yet confirmed in `emulate@0.13.0`: `/check-runs` and `check_run.requested_action`, Slack thread `message` delivery, and `views.open`. Until a probe confirms each one, those tests drive the adapter's handler directly with hand-signed payloads, or use a `defineEmulator` extension, as the Discord fake does. A missing emulator feature therefore never leaves a mechanism untested.

#### Leaked running sandboxes

A sandbox keeps running, and billing, after its agent is gone. Causes include:
- a setup failure after create
- an orchestrator crash
- host-side cancellation
- a refused pause
- a lost create response

Leaked sandboxes fill the concurrency cap, and then new runs cannot start.

1. **Intent is recorded before the remote call.** The journal records `sandbox.creating {runId, callPath, launchId}` before `create()`. Every sandbox carries the §5.2 labels, including `selfbuilding.run`, `selfbuilding.step` and `selfbuilding.launch`. If the create response is lost, the adapter looks the sandbox up by tag before retrying, so a retry never creates a second sandbox.
2. **Every sandbox gets a finite provider lifetime.** It is derived from the budget and is never infinite. Disposable agents use `onTimeout: 'kill'` explicitly, and HITL-capable agents use `'pause'`. The host, when it reconciles, and the reaper extend lifetimes (§6.11, §7.8).
3. **Cleanup is scoped.** Fresh-per-agent sandboxes are closed in `finally` (`await using` on handles, §3). A setup failure after `create()` kills the sandbox before rethrowing.
4. **Host cancellation kills sandboxes.** Trigger.dev and Inngest cancellation does not interrupt a running step. Host adapters (§7) therefore register a cancel handler that kills the run's sandboxes by tag.
5. **A refused pause is a typed outcome, not a throw:** `{confirmed: false, reason}`.
   - 408 means the pause actually succeeded on the server.
   - 409 means the box is already paused.
   - 401, 402, 403 and 429 are account-wide faults and are rethrown loudly.
   - For a disposable sandbox, a refusal falls back to `kill()`. For a resumable one, it falls back to a short provider TTL. Either way, `sandbox.pause_refused` is emitted at error level.
6. **`reap()` sweeps the world, not events.**
   - It also runs as `selfbuilding reap` and as a scheduled task template for each host.
   - It lists running sandboxes by tag from the provider. On Cloudflare and Modal, which cannot list, it reads Selfbuilding's own registry.
   - It closes sandboxes whose run is terminal or whose lease has expired, following the per-box table in §5.9, and it refreshes read tokens that are close to expiry (§9.2).
   - No per-sandbox timer is used, because a missed or duplicated event leaves a sandbox that nobody parks.
7. **Freezing asks the in-sandbox turn lock, never a database row.**
   - The probe is `flock -n` on the turn lock (§6), read BUSY-first. `BUSY` holds the sandbox, `UNKNOWN` also holds it, and only `FREE` permits a pause or kill.
   - A wrong FREE loses an agent's work. A wrong BUSY only leaks for one more sweep.
   - While a leak persists, the reaper raises the alarm on every sweep, not only when the state first changes.

#### An outage read as "not found"

A transient 5xx or timeout during a lookup gets treated as "no sandbox". The orchestrator then rebuilds over a live disk or drops a message as "not ours", or a reaper reports "nothing running" during an outage.

1. `find()` and `list()` return `null` or `[]` **only** for a genuine miss. Every other failure throws `SandboxUnavailableError`. Each adapter enforces this by error class. The conformance suite injects 503s and timeouts and asserts that they throw.
2. **Only explicit kills and positive 404s destroy anything.** A timeout, 5xx, 409 or network error means *unknown*, and unknown never destroys. The reaper never kills a sandbox it could not confirm.
3. **`find()` never wakes anything.** Pausing, parking, cancellation and token refresh all call it first, so a lookup that resumed sandboxes would undo every one of them. Adapters pause by id and never through a connected handle, because on E2B-compatible providers `connect()` resumes.
4. **Retries use one overall deadline** with full-jitter backoff (`rand × min(8 s, 1 s × 2^n)`). They never use a per-attempt timeout multiplied by a count.

#### Ghost refs

The journal, the registry or the provider listing says a sandbox exists and is paused, but the VM is gone. Causes include Impello deleting sandboxes after 14 days paused, a stuck pause killed by provider housekeeping, or an expired snapshot. A naive `open()` throws on every resume, so the run is bricked.

1. **Every ref is tried before a rebuild.** When `open(ref)` gets `SandboxNotFoundError` for a ref that `find()` returned, it walks **all** refs for that key in rank order before giving up. It uses a two-pass budget: about 20 s per ref first, then the full deadline. It creates a fresh sandbox only when every ref is a ghost.
2. **`SandboxGuestGoneError` needs the full deadline.** It is raised only after the **full resume deadline** passes. A count of fast failed attempts is not enough, because instant `Unavailable` replies during a short outage are not proof of death. A plain `SandboxUnavailableError` propagates and never triggers a rebuild.
3. **A rebuild is loud and recovers from a durable source.**
   - It returns `{rebuilt: true}` and emits `sandbox.rebuilt` at warn level.
   - The workspace is recovered from the agent's last pushed branch or its last clean snapshot. To make that possible, the journal (§7) always keeps one of the two for every resumable agent.
   - If neither exists, the agent fails with `SandboxNotFoundError`, with recovery data attached. It never restarts silently from an empty tree.

#### CLI drift

A harness CLI release changes its stream format, flags or exit behaviour. Templates on hosted providers are rebuilt without pins, so the version can change underneath a run. The symptom is often misleading, for example "no result" when the real cause is a renamed event.

1. **Each harness has a version policy** (§4.11): `'tested'` (the default, from the release's `harness-versions.json`), `'latest'`, or an exact version, with the config key `harnessHold` as the fleet-wide rollback.
   - If the image has a different version from the one planned, the runtime installs the planned one itself, using an empty npmrc and running postinstall explicitly.
   - The hold is runtime config, not a rebuild. A resume always uses the session's recorded version (§4.7).
2. **`harness.version` is recorded at every agent start.** A version outside the tested set emits `harness.untested_version` at warn level.
3. **Each adapter declares a parse contract:** the event types it requires, the session-id source, the terminal event and the failure events. If a stream ends without a session id or a terminal event, the error is `HarnessProtocolError {version, missing}`, not `NoResultError`. Unknown event types are kept as `raw` and are never fatal.
4. **Exit codes are never trusted on their own.** OpenCode and Droid exit 0 on failure. Failures are read from the stream, and stderr is treated as diagnostics only (§4).
5. **CI probes new releases nightly (§10).** Each new release of every first-class harness runs against the parse contract and the recorded golden streams. A failure opens an issue and proposes a hold.

#### Dropped mid-run messages

A human replies, comments or clicks while an agent is mid-turn or between steps, and the message gets lost. It was delivered to a process that then died, deleted before the answer was reported, or acked before it was stored.

1. **Store before ack.** Every inbound channel message is written to the run's durable inbox in the journal (§7). It is deduped by platform delivery id (`X-GitHub-Delivery`, Slack `event_id`, Discord interaction id). Only then is the platform acked, within its 3 s or 10 s window.
2. **Messages never go straight into a sandbox.** The orchestrator delivers them. In v1 the only messages delivered into a running call are answers to its own `ask_human` calls (§6.9, §8). Mid-turn folding of other messages is not in v1 (§11, Q35).
3. **A message is consumed only by a successful turn.**
   - It is marked consumed only after the turn that received it reports success. Kill, stop, timeout and failure leave it pending.
   - The safety property is that a race can cost a duplicate answer, never a lost message.
   - The test sweeps arrival time across the end of a turn and asserts that a message is marked consumed if and only if it was answered.
4. **Runtime spool entries are deleted only after the orchestrator acks the report** (§6). A computed reply that was not delivered is cached and re-sent with `retry: true`, instead of running the agent again.
5. **Late answers are recorded.** An answer that arrives after an ask timed out is still stored and gets an "expired" reply in the channel. It never completes a waitpoint that has already settled (§8).

#### One missing token silences everything

Credentials that only some features need get resolved as one set. If the first failure aborts the whole set, every channel, bot or agent goes quiet, often with no log line, and it looks the same as "nothing to do".

1. **Credentials are resolved per consumer.** Each harness, channel, provider and git target resolves its own credentials when it first needs them. A missing Slack token fails only Slack asks, with `MissingCredentialError {consumer: 'channel:slack', variable}`. Those asks are still posted on the other configured channels, which receive every ask in parallel (§8.2), and every other path keeps working.
2. **`selfbuilding doctor` checks everything up front.**
   - The same checks run at factory construction in non-TTY mode.
   - It reports **every** missing or malformed credential at once. The factory then starts with the features that do work. A list of everything missing beats a series of single failures.
   - Missing branch protection is the exception. It makes `doctor` fail (§9.2) and is not degraded.
3. **Optional credentials degrade.** If a secondary credential fails, for example a reviewer harness's, a run that did not name that harness carries on with a warning. A run that did name it fails.
4. **Liveness is checked by expiry, not exit code.** "Logged in" commands can exit 0 on expired tokens. The broker reads token expiry (JWT `exp` or the API's response) itself.
5. **Webhook entrypoints need a post-deploy probe.** It sends an unauthenticated POST and expects `401`, not `500`. That catches import-time and config failures before a real event arrives.

#### A git token that expires mid-turn on a durable host

GitHub installation tokens last at most 1 hour, and the default turn cap is 2 hours. If refresh depended on an orchestrator attached to the turn, every durable host would lose git access partway through a long turn, and the final push would have no fresh token.

1. **The push needs no token from turn start.** The host mints the write token in collect, while it is awake (§9.2).
2. **The read token is refreshed by the reaper or by the host when it reconciles.** Each refreshes any running sandbox whose token expires within 15 minutes.
3. **An L3 test covers it.** The test runs a turn longer than the token TTL on Trigger.dev, Inngest and CF Workflows.

#### Other failure modes

| Failure | Mechanism |
|---|---|
| A secret leaks into a transcript, PR comment or status line | Exact-value plus pattern redaction on every sink, redaction before truncation, and the canary test (§9.4) |
| A secret is committed and pushed (`.env` from `start.sh`, a key the agent echoed into a file) | Built-in exclude list and ignored files excluded from leftover, WIP and checkpoint commits. Exact-value scan over the outgoing git objects before every push, ending in `SnapshotNotCleanError` (§9.3) |
| The agent pushes to `main`, or deletes branches or tags | The agent token is read-only. The host pushes only `selfbuilding/*` refs. `doctor` and the broker require a ruleset (§9.2) |
| Secrets show up in E2B or Impello team logs | Files only. Adapters reject secret-named or known secret values in env, and conformance asserts it (§9.2) |
| A stale token keeps authenticating | No fallback to a cached token. The credential helper is scoped to one host and protocol. Expiry ≤ 1 h (§9.2) |
| Budget overshoot with many concurrent agents on a durable host | Slices are reserved at admission and enforced per runtime. A live cross-agent cutoff waits for the control plane (§9.6) |
| Cost under-counted across turns of one attempt | Usage keyed by `(attempt, turnIndex)` and summed (§9.6) |
| Events dropped as duplicates after a resume | `seq` scoped per `(runId, callPath, launchId)`, with `processEpoch` for run-level events (§9.7) |
| A half-executed agent is silently re-run after a crash | The journal replays only completed `agent()` calls. An interrupted call is a terminal `interrupted` outcome, and continuing it needs an explicit `onInterrupted` choice, because external effects cannot be rolled back (§3.10, §7.6) |
| A wedged sandbox (the control plane says paused, the VM is burning CPU) | `SandboxWedgedError`, never retried. The reaper reports it on every sweep until a human resets it |
| The harness keeps stdout open after submitting its result | After `submit_result`, the runtime waits `timeouts.postSubmitGrace`, then sends SIGINT, waits 5 s, then sends SIGKILL to the process group (§4.5). A subreaper contains `setsid` escapes (§6) |
| A detached runtime crashes with no stderr | Crash handlers write to a durable log before reporting. The reaper treats a sandbox whose lease expired and whose lock is FREE as a failed agent and closes it |
| Codex or another CLI hangs waiting on stdin | Every headless call gets stdin closed or `</dev/null` (§4) |
| A truncated session file breaks resume | The runtime drops an unparsable last line before every native resume (§6) |
| Parallel waits rejected on Trigger.dev | Each agent runs in its own child task with one wait, and every parent-side suspension is multiplexed on one wake stream. No batch API is used (§7.5.1) |
| Duplicate HITL answers | The first answer per `askId` wins through an atomic claim. Later answers get "already answered" (§8) |
| A snapshot captures credentials | Snapshot refused while agent processes are alive. Full exact-value scan, covering git objects, `/proc/*/environ`, history files and binary caches (§9.3) |

### 9.10 Open questions

Moved to §11 (Q2, Q3, Q22, Q56 to Q59).

## 10. Repo layout, testing, milestones and docs

This section covers how the code is organised, licensed, documented and tested, and the order it gets built in. The questions the owner still needs to answer are collected in §11. It does not restate any interface. Each interface is defined in the section cited next to it. Cross-references use the form `§N.M`, and every `N` matches a heading number in this spec (§10.8 enforces this).

### 10.1 Tooling

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22.12 or later (`engines.node: ">=22.12"`), ESM only. CI runs Node 22 and 24 (§1.13). | Trigger.dev, Inngest and the provider SDKs all target Node. ESM-only removes the dual-package bugs that show up in serverless loaders. |
| Other runtimes | Bun and Deno are best effort. Cloudflare Workers run the `@selfbuilding/core` main entry and the Cloudflare packages under `nodejs_compat`. See "Workers rules" below. | Core has to load inside a Workflow step (§7.5.3). |
| Package manager | pnpm workspaces with `workspace:*` protocol | Strict dependency resolution catches packages that use dependencies they never declared. |
| Task runner | Turborepo | Cached `build`, `typecheck` and `test` across about 30 packages. |
| Build | `tsdown`, with ESM output plus `.d.ts`. One entry per subpath export. | Fast. Types are bundled per package. |
| Types | TypeScript 5.x `strict`, project references, `isolatedDeclarations` | Builds `.d.ts` in parallel and keeps public types explicit. |
| Public API guard | API Extractor reports in `api-report/*.api.md`, checked in | Any change to the public surface shows up as a reviewable diff. The same reports feed the API reference (§10.8). |
| Lint and format | Biome | One tool, quick, very little config. |
| Tests | Vitest with `projects` (unit, scripted, conformance, emulate, workers, live) | One runner for every layer, and it has built-in snapshot support for the golden files. |
| Schemas | Zod v4 (`z.toJSONSchema`) | This is the result contract in §2.4. |
| Releases | Changesets, all packages versioned together, npm provenance | A single version number means users never have to work out which packages are compatible. |
| Internals | Plain TypeScript. No effect system. | Contributors should be able to read the code without learning a framework. A CI script fails the build if any `dist/**/*.d.ts` imports something other than `zod`, Node built-ins or `@selfbuilding/*`. |

**Workers rules.**

- The `@selfbuilding/core` main entry may import only `node:async_hooks`, which Workers provide under `nodejs_compat`. Core needs it for `AsyncLocalStorage` (§3.2). A CI check fails the build if the main entry imports any other `node:` module.
- There is no `/node` subpath in v1 (§11, Q20). `fileJournal` and `fileArtifacts` are exported from the core main entry, and they load `node:fs` lazily with a dynamic `import()` inside the call, never at module scope. A Worker that imports core therefore never loads `node:fs`. Calling `fileJournal()` on Workers throws `ConfigError` naming the fix (use the host's own storage). Anything that needs `node:child_process` or `node:net` lives outside core. The SQLite journal stays in `@selfbuilding/journal-sqlite`.
- **The Cloudflare Workflows host supports only the Cloudflare Sandbox provider, plus providers whose adapter talks to the vendor over `fetch` alone.** A provider SDK counts as Workers-capable only after it passes the Workers smoke test (§10.3, L2). Until then, `createCfWorkflowsHost()` rejects that provider at factory build time with `ConfigError` naming the provider. In v1 this is expected to exclude `@impello/sdk`, `e2b`, `dockerode` and `modal`. To reach those from Cloudflare, run the factory on Trigger.dev or Node, or wait for a fetch-only client (§11, Q28). The all-Cloudflare guide in §7.12.3 states this restriction. Using the Cloudflare Sandbox facade from other hosts is not affected.

### 10.2 Monorepo layout

```text
selfbuilding/
├─ LICENSE                       MIT
├─ CONTRIBUTING.md               setup, test layers, how to add an adapter, changesets, DCO sign-off
├─ CODE_OF_CONDUCT.md            Contributor Covenant 2.1
├─ SECURITY.md                   private disclosure process (10.7)
├─ packages/
│  ├─ core/                    @selfbuilding/core          run(), agent(), pipeline(), parallel(), phase(), log(),
│  │                                                     budget, sandbox cap, journal interface, event schema,
│  │                                                     error registry, Harness and SandboxProvider
│  │                                                     interfaces (§1, §3, §4, §5, §9.8); fileJournal and
│  │                                                     fileArtifacts load node:fs lazily (no /node subpath)
│  ├─ journal-sqlite/          @selfbuilding/journal-sqlite   SQLite journal store (native dependency kept out of core)
│  ├─ skills/                  @selfbuilding/skills        SKILL.md loader, sidecar contract, codegen,
│  │                                                     `skills add` vendoring with license capture (§2, 10.7)
│  ├─ agents/                  @selfbuilding/agents        the default pack: CodeReview, ImplementSpec, Retro,
│  │                                                     ImproveCodebaseArchitecture (§2.10)
│  ├─ runtime/                 @selfbuilding/runtime       in-sandbox runtime + selfbuilding-mcp stdio server
│  │                                                     (submit_result, ask), shipped as one bundled file (§6)
│  ├─ harnesses/               @selfbuilding/harnesses     one subpath per harness: /claude-code, /codex, /opencode,
│  │                                                     /amp, /droid, /pi, /grok. Command builders + parsers, no SDK deps
│  ├─ images/                  @selfbuilding/images        defineImage and the official image definitions (§5.6)
│  ├─ artifacts-s3/            @selfbuilding/artifacts-s3  S3-compatible artifact and result store (§7.10)
│  ├─ sandbox-docker/          @selfbuilding/sandbox-docker      dockerode
│  ├─ sandbox-e2b/             @selfbuilding/sandbox-e2b         e2b SDK; shared E2B-shape adapter code lives here
│  ├─ sandbox-impello/         @selfbuilding/sandbox-impello     @impello/sdk; reuses the E2B-shape code from sandbox-e2b
│  ├─ sandbox-daytona/         @selfbuilding/sandbox-daytona
│  ├─ sandbox-vercel/          @selfbuilding/sandbox-vercel
│  ├─ sandbox-modal/           @selfbuilding/sandbox-modal
│  ├─ sandbox-cloudflare/      @selfbuilding/sandbox-cloudflare  client + facade Worker (§5.5)
│  ├─ host-trigger/            @selfbuilding/host-trigger        Trigger.dev v4 adapter (§7.5.1)
│  ├─ host-inngest/            @selfbuilding/host-inngest
│  ├─ host-cf-workflows/       @selfbuilding/host-cf-workflows
│  ├─ channel-slack/           @selfbuilding/channel-slack       (§8)
│  ├─ channel-discord/         @selfbuilding/channel-discord
│  ├─ channel-github/          @selfbuilding/channel-github      PR comments, check-run actions, githubApp()/pat()
│  │                                                     brokers, postReview() (root export, used from M2)
│  ├─ hooks/                   @selfbuilding/hooks               createHitlHandler(), createCallbackHandler()
│  ├─ otel/                    @selfbuilding/otel                otelSink() (§9.7)
│  ├─ eslint-plugin/           @selfbuilding/eslint-plugin       determinism and handle-scope rules (§3.8)
│  ├─ cli/                     selfbuilding (bin only)           the commands in §1.12
│  ├─ testing/                 @selfbuilding/testing             scriptedHarness, tmpdir provider, describeHarness(),
│  │                                                     Discord emulator (/discord), golden normaliser, emulate seeds
│  └─ sandbox-conformance/     @selfbuilding/sandbox-conformance  describeSandboxProvider(), placement suite
├─ tools/
│  ├─ ns-reap/                 subreaper source (C, ~300 lines), built in release.yml (10.7)
│  ├─ docs-lint/               § reference, package-name and error-name checks (10.8)
│  └─ notices/                 THIRD_PARTY_NOTICES generator (10.7)
├─ examples/                   pnpm workspace; one runnable factory per host and per primitive (10.8)
│  ├─ hosts/{node,trigger-dev,inngest,cloudflare-workflows}/
│  └─ primitives/{agent,pipeline,parallel,ask,sandbox-shared,fork,nested-factory,budget}/
├─ templates/                  copied verbatim by `selfbuilding init`; each imports only public packages
│  ├─ plain-node/
│  ├─ trigger-dev/
│  ├─ inngest/
│  └─ cloudflare-workflows/
├─ apps/
│  ├─ docs/                    docs site (10.8)
│  └─ control-plane/           later (post-v1): Workers + Durable Objects, not published in v1
├─ fixtures/
│  ├─ repos/                   tiny fixture repos used by scripted and live tests
│  ├─ skills/                  real-world SKILL.md corpus for lenient-mode loader tests (each with its LICENSE)
│  └─ streams/<harness>/<version>/*.jsonl   recorded harness output for parser tests
├─ .selfbuilding/                dogfood factory: this repo's own Selfbuilding config (10.5)
└─ docs/
   ├─ spec/                    01-overview.md … 11-open-questions.md; the file number equals the heading number
   ├─ adr/                     one file per decision, with the options that were considered
   ├─ out-of-scope/            one file per declined feature request, with the reason (§4.13)
   └─ CONTEXT.md               glossary: each term, its meaning, and "Avoid:" synonyms (§1.6)
```

`THIRD_PARTY_NOTICES` is not checked in. `release.yml` generates it and puts it in every npm tarball, image and runtime bundle (§10.7).

Layout rules:

- **Core depends on nothing heavy.** Its only runtime dependency is `zod`. A provider SDK, a host SDK and a chat SDK each live in their own package. Installing `@selfbuilding/core` with `@selfbuilding/sandbox-docker` must not pull in `@vercel/sandbox`.
- **Harnesses share one package.** Harnesses are pure command builders and line parsers with no dependencies (§4.1), so separate packages would only add release overhead. Subpath exports keep tree-shaking working.
- **Providers each get their own package.** Their SDKs are large, and several pin Node ranges.
- **Every provider is a named, static import.** There is no string registry and no dynamic `import()`. Bundlers can trace static imports, and a mistyped provider name becomes a compile error rather than a runtime 500.
- **Templates share no code.** If a template needs a helper, the helper either goes into a public package or gets duplicated. Duplicating code between templates is fine.
- **Examples import only public packages**, the same way templates do. Each one is a test (§10.8).
- **`@selfbuilding/runtime` is the only TypeScript that runs inside the sandbox.** It is built as a single self-contained JavaScript file plus a version stamp, and the provider adapters upload it (§6.3). Its version is checked against core at the start of a run. `ns-reap` is the only native binary that runs there.
- **Spec files are numbered by heading.** `docs/spec/NN-*.md` holds `## NN.`. Renaming or reordering a file is a docs-lint failure until every reference is updated.

### 10.3 Testing strategy

There are six layers. The first three run on every pull request, are free, and give the same result every time. The last three cost money or need external services, so they run on a schedule.

| Layer | What | Runs | Cost |
|---|---|---|---|
| L0 unit | Pure functions, error registry, docs lint | Every PR | Free |
| L1 scripted | Full `run()` with the scripted harness and the Docker or tmpdir provider, plus every `examples/` factory | Every PR | Free |
| L2 conformance and integration | Provider conformance on Docker, emulate.dev, the Discord fake, golden streams, Workers smoke | Every PR | Free |
| L3 hosts | The same scripted factories on the Trigger.dev, Inngest and Workflows dev servers | Every PR (path-filtered) and nightly | Free |
| L4 cloud conformance | Conformance suite against real cloud sandboxes | Nightly and on `main` | Sandbox minutes |
| L5 live smoke | Real harness CLIs on cheap models | Nightly and manual dispatch | Capped USD |

#### L0: unit

These are plain Vitest tests next to the code. They cover:

- The skill loader. Strict mode must produce the exact spec error strings. Lenient mode runs over the `fixtures/skills/` corpus. The tests also cover `allowed-tools` in all three formats (YAML list, comma-separated, space-separated) and the substitution rules (§2.3.3).
- Converting a Zod schema to JSON Schema, in both the draft-07 form and the OpenAI-strict form.
- Journal keys: `(runId, callPath, skillHash, inputHash)`. Editing a skill must change the key.
- The budget meter and the sandbox-concurrency semaphore.
- NDJSON framing: split on `\n` only. Test inputs include U+2028 inside a string, a partial last line and non-JSON noise lines.
- The redactor. It must redact before it truncates, and it uses exact-value matching first, longest value first.
- **The error registry.** The §9.8 table is the only error registry. In code it is `packages/core/src/errors/registry.ts`, with one row per class: class name, `code` (an `ErrorCode`), `kind`, `retryable`. The test asserts four things:
  1. Every class exported from any `@selfbuilding/*` package extends `SelfbuildingError` and has a row.
  2. Every class name ends in `Error`.
  3. Every `ErrorCode` member is used by at least one row, and only the documented shared codes (for example `boot`, `artifact_failed`) appear on more than one class.
  4. The registry matches the §9.8 table in `docs/spec/09-security.md` row for row.

  A class that is thrown but not registered fails the build. The registry also generates the error-code reference page (§10.8).
- **`skills add` license capture** (§10.7): a folder with a `LICENSE` is vendored together with it, a folder without one is refused, and `--allow-unlicensed` records the override.

#### L1: scripted fake harness

`@selfbuilding/testing` exports a harness that implements the real `Harness` interface (§4.2). It plays back a script instead of calling a model.

```ts
import { scriptedHarness } from "@selfbuilding/testing";

const harness = scriptedHarness([
  { sh: "git checkout -b selfbuilding/test/fix && echo x > a.ts && git commit -qam x" },
  { tool: "ask_human", input: { question: "Ship it?", choices: ["yes", "no"] } },
  { submit: { status: "bogus" } },               // must be rejected and retried in-run
  { submit: { status: "done", summary: "ok" } },
  { crash: "SIGKILL", when: "after-submit" },    // exercise journal replay
]);
```

- Shell steps run in a real sandbox (Docker, or a tmpdir provider for speed), so git, diff and artifact capture are real.
- `submit` steps go through the real `selfbuilding-mcp` server, so the validation-retry path from §2.6 is exercised end to end.
- The script player also emits events in the native stream format of a real harness (`format: "claude-code" | "codex" | "opencode"`), so the real parsers are tested in the same pass.
- Every test sets its own `HOME`, `GIT_CONFIG_GLOBAL` and `TMPDIR`, so the developer's own config never affects a result.

The scripted suite covers:

- `pipeline()` with no barrier, and `parallel()` with failures coming back as `null`.
- Budget exhaustion (`BudgetExceededError`), the sandbox-concurrency cap, and a nested factory at depth 2 rejected with `NestingDepthError` (§9.8).
- `NoResultError`, running out of submit retries (`ResultValidationError`), and the done-check feedback loop ending in `DoneCheckFailedError`.
- **Crash and resume.** The test kills the process after agent *k* and calls `run({ runId })` again. It then checks that the call counter shows agents 1..*k* were not invoked again, and that agent *k+1* runs. This is repeated on the file journal and the SQLite journal. A half-executed turn must never be replayed silently (§7.6).
- **Sandbox placement** (§3.11). There is one test for each mode:
  1. With a fresh sandbox per agent, B cannot see A's uncommitted file.
  2. With a shared handle, B sees A's working tree. Two concurrent `agent()` calls on one handle behave as §3.11 specifies: the second throws `SandboxBusyError`.
  3. Handoff by typed result: B receives `A.result`.
  4. Handoff by git branch: B checks out `A.artifacts.branch` from a shared bare remote.
  5. `snapshot()`/`fork()`: B starts from A's snapshot, and writes A makes later do not show up in B.
- **Examples.** Every factory under `examples/` is type-checked and run against the scripted harness and the tmpdir provider (§10.8).

#### L2: provider conformance suite

Third parties can run this suite against their own providers.

```ts
import { describeSandboxProvider } from "@selfbuilding/sandbox-conformance";
import { docker } from "@selfbuilding/sandbox-docker";

describeSandboxProvider("docker", () => docker({ image: "selfbuilding/base:test" }), {
  timeoutMs: 120_000,
  label: `ci-${process.env.GITHUB_RUN_ID}`,
});
```

The suite checks which optional operations the provider implements (`snapshot`, `fork`, `previewUrl`) and reads its `limits` (§5.1, §5.2). It skips cases for operations the provider does not have. A skipped case is printed with its reason and never counts as a pass. Each case maps to one of the invariants in §5.4.

| Group | Cases |
|---|---|
| Lifecycle | create, find by label (must not wake a paused box), open (returns a running box), pause (confirmed or a typed refusal), kill is idempotent, an outage throws `SandboxUnavailableError` and is not reported as not-found |
| Exec | exit codes (non-zero is returned, not thrown), line-by-line streaming, stdin over 128 KiB, a timeout raising `SandboxCommandTimeoutError` with `mayStillBeRunning`, detached exec plus reattach, bounded output tail |
| Files | binary round trip, a 10 MB file, a missing file raises `SandboxFileNotFoundError` and not `SandboxNotFoundError` |
| Env | declared variables pass through; an undeclared canary variable is never visible in the sandbox |
| Network | egress allowed or blocked as configured; an unsupported policy raises `EgressPolicyUnsupportedError` |
| State | snapshot, restore, fork; `sourceState` is reported correctly |
| Runtime | `@selfbuilding/runtime` uploads and starts; the `selfbuilding-mcp` stdio server answers; `ns-reap` checksum matches the release manifest |
| Images | every harness CLI in the default image prints `--version`; install-at-boot images install it within the boot budget |
| Load | 5 parallel creates; a 429 raises `SandboxQuotaError`, and only create is retried, never exec |

Error names follow the §9.8 registry. Docker runs the suite on every PR. The cloud providers run it nightly (L4).

#### L2: Workers smoke

A `workerd` test project (through `@cloudflare/vitest-pool-workers`) with `nodejs_compat` does three things:

- Imports the `@selfbuilding/core` main entry, `@selfbuilding/host-cf-workflows` and `@selfbuilding/sandbox-cloudflare`, and runs a scripted two-agent factory inside a Workflow step.
- Imports each provider package in turn and calls `find()` against a stub `fetch`. A provider that fails to load or call is marked "not Workers-capable" in a generated `workers-support.json`. `createCfWorkflowsHost()` reads that file to decide what to reject (§10.1).
- Asserts that no `node:` module other than `node:async_hooks` is statically imported into the Worker bundle, and that `node:fs` is never loaded during the run.

#### L2: GitHub and Slack on emulate.dev

- The `emulate` version is pinned exactly, because it is 0.x and changes quickly. Version bumps come through an automated dependency-update bot, and the HITL suite runs on each bump.
- Vitest `globalSetup` starts one GitHub emulator and one Slack emulator per worker, on port `4001 + workerId * 20`. `afterEach` calls `reset()`. Persistence is turned off, because it has no cross-process locking.
- **The Slack seed contains:** a `signing_secret`, users `user-1` and `selfbuilding-bot`, a channel `#factory` with the bot as a member, `oauth_apps[].interactivity_url` pointing at the channel adapter's local handler, and `view_trigger_ttl_seconds: 30` so a slow CI machine does not miss the 3 s trigger window.
- **The GitHub seed contains:** an org, a repo with `auto_init`, an App with a `webhook_secret`, and the reviewer and bot tokens.

The emulate tests cover these flows:

| Flow | How it is driven |
|---|---|
| Slack approve | Agent calls `ask_human` → adapter posts buttons → test reads the message `ts` → `POST /_slack/simulate/block-actions` → run resumes with `approve` |
| Slack free text | Reply in the thread via `chat.postMessage` with `thread_ts`, or a modal through `/_slack/simulate/view-submission` |
| GitHub PR comment | Create the PR, post a reviewer comment → the emulator delivers a signed `issue_comment` → the agent's next turn contains the comment |
| GitHub approval | Check run with `action_required` → `check_run.requested_action` webhook |
| GitHub review post (M2) | `@selfbuilding/channel-github` posts a typed `CodeReview` result as one review with line comments plus one `neutral` check run |
| Duplicate answers | Click twice and reply once. The first answer wins, and later ones get "already answered". |
| AFK | `ask()` with no channel resolves at once according to the policy, and the decision is recorded as an event |
| Timeout | Fake timers. `onTimeout` is applied, and `AskTimeoutError` is raised under `"fail"`. High-risk asks never default to yes. |
| Durable wait | Kill the process while it waits, deliver the answer, check that the run resumes from the journal |

Two emulator gaps change how the tests are built:

1. **No git smart HTTP.** An agent cannot `git push` to the emulated GitHub. PR tests use a local bare repo as the git remote. A test helper then mirrors pushed refs into the emulator through the `git/refs` REST endpoint before calling `pulls.create`.
2. **Unknown GitHub tokens fall back to a default user.** Auth-failure tests and bad-signature tests therefore do not rely on the emulator. Bad signatures are built by hand and fed to Selfbuilding's own verifier, which must raise `WebhookSignatureError`. A nightly job also runs against real GitHub, using a fine-grained token on a throwaway repo.

#### L2: Discord fake

emulate has no Discord emulator. `@selfbuilding/testing/discord` builds one with emulate's `defineEmulator`, which brings reset, snapshot and the inspector along for free.

- REST routes: post and list channel messages (with components), start a thread, the interaction callback, and `PATCH /webhooks/:app/:token/messages/@original`.
- A test-only route, `POST /_discord/simulate/button` with `{ message_id, custom_id, user_id }`, sends an Ed25519-signed `MESSAGE_COMPONENT` interaction to the adapter. A matching route exists for modal submits.
- The gateway (`MESSAGE_CREATE`) is not emulated. v1 Discord HITL uses interactions only (§8.6).
- **Drift check:** a nightly job runs the same flows against a real test guild and compares response shapes field by field. The bot token comes from Infisical.

#### L2: golden event streams

- Every scripted run writes its normalised event stream (§4.3) to `__golden__/<test>.jsonl`.
- Values that change between runs are replaced with placeholders that preserve references: run, sandbox and session ids, timestamps, ports and USD amounts. The first sandbox id seen becomes `<sandbox:1>` everywhere it appears.
- Golden files are updated with `vitest -u`. The diff is reviewed in the PR like any other code.
- **Parser fixtures:** `fixtures/streams/<harness>/<cli-version>/` holds recorded real output for each harness: success, failure, resume, tool error and `submit_result`. Each parser is tested against every recorded version. The live smoke job (L5) records new fixtures whenever a CLI version changes, and opens a PR to add them.

#### L3: durable hosts

The same scripted factories run on the Trigger.dev, Inngest and Cloudflare Workflows local dev servers. Each test checks four things:

- Each `agent()` produces exactly one host step group (§7.4). The test counts the step records.
- No journal entries are written twice (one durability system, §7.1).
- `parallel()` on Trigger.dev is lowered to child tasks with one wake stream (§7.5.1). N concurrent in-process waits are rejected by Trigger.dev.
- Cancelling a run on the host kills its sandboxes.

On the Workflows dev server, only providers marked Workers-capable in `workers-support.json` are used.

#### L4 and L5: live tests with cost caps

**The matrix.** Nightly, it runs `{claude-code, codex, opencode} × {docker, impello}`. Weekly, it adds the other providers with Claude Code only, and the other harnesses on Docker only.

**The task.** It uses a fixture repo with the emulated GitHub and a local bare remote. The prompt is "add `add(a, b)` with a test, open a PR". The run passes only if all three of these hold:

- The result passes Zod validation.
- The done check `pnpm test` passes in the sandbox.
- The PR exists in the emulator.

**The caps.** They are enforced by Selfbuilding, not by CI:

| Cap | Value |
|---|---|
| Per cell | `budget.usd = 0.50`. Claude also gets `--max-budget-usd 0.50` as a second guard. |
| Wall clock per cell | 10 min |
| Whole nightly job | `SELFBUILDING_CI_BUDGET_USD = 10`. A `budget.charged` event that would go over the cap aborts every remaining cell. |
| Models | The cheapest model of each vendor, set in `ci.config.ts` |
| Keys | One API key per harness, so spend is reported separately |

**The leak ledger.** A ledger check runs after every live cell. Any finding fails the job, even if the cell itself passed. It looks for:

- Sandboxes labelled `selfbuilding.deployment=ci-<GITHUB_RUN_ID>` that are still running, or that are older than one hour.
- Paused sandboxes the cell never recorded.
- Leftover remote branches or refs.
- The env canary variable visible in any sandbox.
- Orphaned journal entries in `running` state.

**Verdicts.** Each cell reports `VERIFIED`, `FAILED` or `UNVERIFIABLE`. `UNVERIFIABLE` means a secret is missing. A stand-in harness is never allowed. A cell is retried once. Model-quality misses are reported as a pass-rate trend. Only adapter errors (bad parse, wrong flags, leaks) block a release.

**Harness version probe.** A nightly job installs the latest release of each first-class harness CLI and runs its parse-contract fixtures. If the latest release fails and the previous one passes, the bot opens a PR that adds a `harnessHold` entry for that harness (§4.11).

**Secrets.** CI secrets are authored in Infisical and synced to CI. Nobody runs `gh secret set` by hand.

#### When a provider or harness counts as "built-in"

A provider or harness can be documented as built-in only when all three of these are true:

1. It passes L2 conformance on every operation it implements.
2. Its L5 cell has been `VERIFIED` for 7 consecutive nights.
3. Its leak ledger has been clean for the same 7 nights.

Anything else is published as experimental: harness adapters with `stability: 'experimental'`, and providers at the "adapter" tier (§1.10). There is no `/experimental` subpath.

### 10.4 CI layout

| Workflow | Trigger | Jobs |
|---|---|---|
| `ci.yml` | Every PR and push | build, typecheck, Biome, API report diff, public-type dependency check, core `node:` import check, error-registry check, docs lint, docs site build, `examples/` typecheck and run, L0–L2 (including Workers smoke), L3 (path-filtered) |
| `nightly.yml` | Cron, 02:00 UTC | L3 full, L4 cloud conformance, L5 live smoke, Discord and GitHub drift checks, harness version probe, leak ledger |
| `release.yml` | Changesets merge | Generate `THIRD_PARTY_NOTICES`. Build `ns-reap` from source with checksums, SBOM and provenance. Check the harness license gate before pushing each image. Publish npm packages with provenance, the default sandbox images and the runtime bundle. Deploy the docs site. |
| `selfbuilding-review.yml` | `pull_request` | Dogfood review (§10.5) |

### 10.5 Dogfooding

Selfbuilding reviews its own pull requests from M2 onwards. It accepts `/selfbuilding` commands and implements its own specs from M3a.

**M2: review only.**

- The factory lives in `.selfbuilding/review.ts`. It runs `CodeReview()` from `@selfbuilding/agents`, using Claude Code in a fresh Impello sandbox, orchestrated by a Trigger.dev task. The GitHub Action only triggers the task and exits, so CI minutes are not spent waiting.
- At the end of the task, `postReview()` from `@selfbuilding/channel-github` posts the typed result. This is a minimal, post-only App helper. It mints an installation token, posts one PR review with line comments built from the `CodeReview` result, and sets one check run. It has no webhook handler, no inbound commands and no `ask()`.
- The check run is `neutral` and does not block merges.

**M3a: interactive.** The full GitHub channel (§8.6) replaces the helper's posting path and adds inbound commands:

- A reviewer can reply `/selfbuilding dismiss <id>` or `/selfbuilding fix <id>`. The `fix` reply starts an `ImplementSpec()` run on a branch off the PR.
- `ImplementSpec()` runs can also be started from the `#selfbuilding-factory` Slack channel.

**M4: gating.** Once the false-positive rate has been measured, the check run becomes a required check.

**Who it acts as.** It acts as a GitHub App in every phase. Every review is authored by the bot, so maintainers can approve or reject it like any other review. Events the App sent itself are ignored, which prevents loops.

**Limits.**

| Limit | Value |
|---|---|
| Spend per PR review | $2 |
| Spend per day | $20 |
| Sandboxes at once | 3 |
| PRs from forks | Skipped. Untrusted code never runs with secrets. |

**Feedback loop.** Every review emits its events to the run journal. A weekly `Retro()` run reads the last week's reviews and the maintainers' dismissals, then opens a PR that changes the review skill's prompt or done checks. A human merges it. Retro starts in M2, reading the reviews alone, and adds dismissals once M3a ships them. This shows that the Retro agent works on real data.

**Exit signal.** Dogfooding counts as working when 30 consecutive PRs have been reviewed without an adapter error or a leaked sandbox.

### 10.6 Milestones

Each milestone ends when every exit criterion is met, as checked by a CI job or a recorded run. Elapsed-time estimates assume one full-time maintainer plus agents. The total is 20 weeks.

| Milestone | Scope | Exit criteria | Estimate |
|---|---|---|---|
| **M0: contracts** | Monorepo, tooling (§10.1), and the core interfaces: `Harness`, `SandboxProvider`, journal store, event schema, error registry (§9.8). File journal (lazy `node:fs`, §10.1), Docker provider, tmpdir provider, scripted harness, golden harness, `CONTEXT.md`, the first ADRs. `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`. Docs site skeleton, spec files numbered by heading. | 1. A scripted `agent()` runs end to end in Docker and writes a golden stream.<br>2. Docker passes the lifecycle, exec and files groups of conformance.<br>3. The API report, public-type dependency check, core `node:` import check and error-registry check run in CI.<br>4. **Docs:** docs lint passes on the whole spec. The error-code reference is generated from the registry. `SECURITY.md` names a working private reporting channel. | 2 wk |
| **M1: one real agent, locally** | Claude Code, Codex and OpenCode adapters. `selfbuilding-mcp` with `submit_result`. In-sandbox runtime and `ns-reap` built from source. Skill loader, sidecar contract and codegen. The default skill pack. CLI `init`, `run`, `doctor`, `skills build`, `skills check`, `skills validate` (§1.12). | 1. The L5 cells `{claude-code, codex, opencode} × docker` are `VERIFIED`.<br>2. `CodeReview()` returns a typed result on a real repo.<br>3. An invalid submit is retried inside the run.<br>4. Parser fixtures exist for every harness.<br>5. A license review is recorded for each of the three harness CLIs (§10.7).<br>6. **Docs:** a local quick start, the skill author guide, the harness adapter guide, and `examples/primitives/agent` running in L1. | 3 wk |
| **M2: composition and durability** | `pipeline()`, `parallel()`, `phase()`/`log()`, budget, sandbox cap, nested factories, shared handle, `snapshot()`/`fork()`. SQLite journal and resume by run id. Impello provider. Trigger.dev host and template. CLI `resume`, `watch`, `cancel`, `reap`, `images build`. Review-only dogfood with the `postReview()` helper (§10.5). | 1. Crash and resume tests pass on file, SQLite and Trigger.dev.<br>2. All five placement tests pass on Docker and Impello.<br>3. Impello passes full conformance nightly.<br>4. The review-only dogfood posts a review and a `neutral` check run on every non-fork PR.<br>5. **Docs:** the factory author guide, concept pages for every primitive, the provider adapter guide, the Trigger.dev + Impello deployment guide (§7.12.2), and `examples/` for every primitive shipped so far plus `hosts/node` and `hosts/trigger-dev`. | 4 wk |
| **M3a: humans** | `ask()` with hot and cold waits. AFK policies. Slack and GitHub channels, including `/selfbuilding dismiss` and `fix`. Inngest host and template. CLI `answer`, `skills add` with license capture. | 1. Every Slack and GitHub emulate flow in §10.3 passes.<br>2. A cold wait survives a process kill on Node, Trigger.dev and Inngest.<br>3. Dogfood: an `ImplementSpec()` started from Slack opens a PR on this repo, and `/selfbuilding fix` opens a fix branch.<br>4. **Docs:** the HITL and AFK guide, the channel adapter guide, the Inngest deployment guide, and `examples/primitives/ask` plus `hosts/inngest`. | 4 wk |
| **M3b: breadth** | Discord channel. Cloudflare Workflows host and template, limited to Workers-capable providers (§10.1). Providers: E2B, Daytona, Vercel Sandbox, Modal, and Cloudflare Sandbox with the facade Worker. | 1. Every Discord-fake flow passes.<br>2. A cold wait survives a process kill on Cloudflare Workflows.<br>3. Each provider passes conformance for the operations it implements.<br>4. The Workers smoke test passes, and `workers-support.json` is published.<br>5. **Docs:** the host adapter guide, the all-Cloudflare deployment guide (§7.12.3) with its provider restriction, one page per provider, and `examples/hosts/cloudflare-workflows`.<br>**Slip rule:** if M3b runs past 4 weeks, Modal and Cloudflare Sandbox ship as experimental ("adapter" tier, §1.10) in v1, and M4 starts (§11, Q10). | 4 wk |
| **M4: v1.0** | Amp, Droid, Pi and Grok adapters (experimental). The `harnessHold` mechanism. CLI `skills infer`. API reference. CLI reference. Troubleshooting guide. `init` validates every flag up front when not on a TTY. API freeze. | 1. Every built-in cell has met the built-in bar in §10.3.<br>2. API reports are frozen, and a semver policy is published.<br>3. The dogfood check run is promoted to a required check.<br>4. Quick start on a clean machine works with no undocumented steps.<br>5. **Docs:** API reference and CLI reference are generated and complete. Every `code` in the registry has a troubleshooting entry. | 3 wk |
| *Later: control plane* | `apps/control-plane` on Workers and Durable Objects: run index, live transcript view, central HITL routing, reaper. | Not part of v1. It gets its own spec once M4 has shipped. | |

What each milestone deliberately leaves out:

- **M1** has no durability. A crash loses the run.
- **M2** has no HITL. `ask()` throws `ConfigError` with the message "ask() is not available before M3a". The dogfood review accepts no commands.
- **M3a** has no Discord, no Cloudflare host and no cloud provider other than Impello.
- **M3b** may ship any provider or harness that has not yet met the built-in bar as experimental (§1.10).

### 10.7 Licensing and security policy

Selfbuilding is MIT. Its releases also ship things it does not own: harness CLIs inside images, vendored skills, and a native helper. Each one has a rule.

**Project files.**

- `LICENSE` (MIT) sits at the repo root and is copied into every published package.
- `THIRD_PARTY_NOTICES` is generated in `release.yml` by `tools/notices`. It covers the production dependency tree of every npm package, the runtime bundle, `ns-reap`, and every OS and npm package inside each published image. A dependency whose license is not on the allowlist (MIT, ISC, BSD-2/3, Apache-2.0, 0BSD, BlueOak-1.0) fails the release until someone approves it in `docs/adr/`.

**Harness CLIs in published images (§5.6).**

- Before an image that contains a harness CLI is published, someone does a license review of that CLI's terms and records the outcome in `docs/adr/harness-licenses.md`: redistribution allowed, not allowed, or unclear. `release.yml` reads that file. It refuses to push an image whose CLI is not marked "allowed".
- **Fallback: install-at-boot images.** For any CLI that is not cleared, the published image contains everything except the CLI. On first boot the runtime installs the pinned version from the vendor's own registry, with the same install rules as §4.11, and records the version. The user downloads the CLI from the vendor, so Selfbuilding never redistributes it. This adds about 10–30 s to a cold start. Per-repo images (§5.7) and images built with `selfbuilding images build` into the user's own account still bake the CLI in, because the user builds them.
- Until a review says otherwise, assume that Claude Code, Amp, Droid and Grok need install-at-boot images, and that Codex (Apache-2.0) and OpenCode (MIT) can be baked in.

**Vendored skills.**

- `selfbuilding skills add <git-url>#<sha>` copies the upstream `LICENSE` (or `LICENSE.*`, `COPYING`) into the vendored folder. It writes `source.json` with the URL, SHA and SPDX id.
- If the folder and its repo root have no license file, the command refuses. `--allow-unlicensed` overrides this and records `"license": "NOASSERTION"` in `source.json`. Strict mode in the loader then warns on every load.
- `selfbuilding skills validate` lists every vendored skill with its license, so a team can review them.
- The default pack is MIT. The skills in `fixtures/skills/` keep their own licenses next to them.

**`ns-reap` (§6.3).**

- The source lives in `tools/ns-reap/`: about 300 lines of C, built as a static binary with `zig cc` against musl for `linux/amd64` and `linux/arm64`. It is MIT.
- `release.yml` builds it from the tagged source. It publishes SHA-256 checksums, a CycloneDX SBOM, and a SLSA provenance attestation through GitHub artifact attestations. The runtime checks the checksum before it uses the binary, and falls back to process-group kill on a mismatch (§6.3).

**`SECURITY.md`.** Selfbuilding brokers credentials (§9.2), so it needs a real disclosure process:

- Reports go through GitHub private vulnerability reporting on the repo, with a security email as the backup.
- Acknowledgement within 3 business days. A fix or mitigation plan within 30 days. Coordinated disclosure after 90 days at most.
- In scope: credential leaks through sinks, sandbox-to-host escapes through Selfbuilding code (git config, patch application), webhook signature bypass, and approval-gate forgery.
- Out of scope: vendor sandbox or harness CLI bugs. Selfbuilding forwards those to the vendor.
- Fixes ship as GitHub Security Advisories with a CVE where one applies.

### 10.8 Docs plan

The docs are built in `apps/docs` and deployed by `release.yml`. Each milestone adds pages for what it ships (§10.6). Nothing is left for a final writing sprint.

**Site structure.**

| Section | Contents | Source |
|---|---|---|
| Quick start | Local (Node + Docker), then Trigger.dev + Impello | Hand-written. Every code block comes from `examples/` |
| Concepts | Glossary (§1.6), agents and skills, factories and primitives, placement, durability, HITL and AFK, security model | Hand-written. The glossary is generated from `CONTEXT.md` |
| Guides: skill authors | Writing a skill, sidecar contracts, done checks, overriding the default pack, `skills add` and licensing | Hand-written |
| Guides: factory authors | Composition patterns, budgets, determinism rules (§3.8), resume, testing with `@selfbuilding/testing` | Hand-written |
| Guides: adapter authors | Harness, provider, host and channel adapters, each with its conformance or fixture suite and the built-in bar | Hand-written |
| Deployment | Local, Trigger.dev + Impello, all-Cloudflare (§7.12), Inngest | Hand-written, from `examples/hosts/*` |
| Reference: API | Every public export | Generated by `api-documenter` from the API Extractor reports |
| Reference: errors | One entry per row of the §9.8 registry: class, `code`, `kind`, `retryable`, causes, what to do | Generated from `errors/registry.ts`, with hand-written "what to do" text that is required per row |
| Reference: CLI | Every command and flag | Generated from the CLI's command definitions |
| Troubleshooting | Grouped by symptom ("no result", "sandbox leaked", "webhook 500"), linking to error entries | Hand-written |
| Spec | `docs/spec/01` … `11` | Rendered as is |

**`examples/` workspace.**

- `examples/hosts/` holds one runnable factory per host: node, trigger-dev, inngest and cloudflare-workflows. `examples/primitives/` holds one per primitive: `agent`, `pipeline`, `parallel`, `ask`, shared sandbox, `fork`, nested factory, budget.
- Each example has a `README.md` and a `test.ts`. In L1 it is type-checked and run against the scripted harness and the tmpdir provider. The host examples also run in L3.
- Docs pages embed example code by file path and region marker. A snippet in the docs cannot drift from code that compiles.

**Docs lint (`tools/docs-lint`, run in `ci.yml`).**

- Every `§N` or `§N.M` in `docs/` and in TSDoc comments must resolve to an existing heading in `docs/spec/`. A dangling reference fails the build. (One example the lint catches: a field such as `AgentResult.artifacts.transcriptPath` cited in a section that does not define it.)
- Every `@selfbuilding/*` import in docs and examples must resolve to a workspace package and a real subpath export.
- Every error class name in docs must exist in the registry. Every registry row must have its reference text.
- Spec file numbers must match their `## N.` headings.

### 10.9 Open questions for the owner

Moved to §11 (Q1, Q2, Q4 to Q10, Q42 and Q50; the harness version default and the second-tier harness question are closed in §11.8).

## 11. Open questions

Every open question from sections 1 to 10 is collected here, numbered once. Each one comes with a recommendation. Work goes ahead on the recommendation unless the owner says otherwise. Sections that raised a question point here by number, in the form "(§11, Qn)". Questions that earlier drafts listed as open but that are now decided are in §11.8.

### 11.1 Product and project

- **Q1. npm scope.** Is `@selfbuilding` free on npm, or can it be bought? *Recommendation:* check this week and claim it before the first publish. If it is taken, use `@selfbuilding-dev/*`. The CLI package stays `selfbuilding` if that name is free, and otherwise becomes `@selfbuilding-dev/cli`, still with the bin name `selfbuilding`. The decision is needed before M0 ends, because every import path depends on it.
- **Q2. Subscription auth and vendor terms.** Should Selfbuilding document "bring your Claude or ChatGPT subscription" (Claude OAuth tokens from `claude setup-token`, a ChatGPT-plan Codex `auth.json`), given that at least one vendor restricts third-party products from offering subscription login (§4.9, §9.2)? *Recommendation:* support the mechanism as an undocumented `credentials` kind, accept subscription files as user-supplied files without advertising them, and default all docs and templates to API keys until there is a legal answer before v1.0.
- **Q3. Codex auth-file leasing.** A refreshable Codex `auth.json` needs a single-holder lease per file and a copy-back after each agent call (§4.9). That limits each ChatGPT-plan credential to one concurrent sandbox. Is that acceptable for v1, or should Selfbuilding wait for a mode that uses only an access token? *Recommendation:* ship the lease. Parallel factories should use API keys.
- **Q4. Live CI budget.** The proposal is $10 per night plus $20 per day for the dogfood review, about $900 a month in total (§10.3, §10.5). Is that acceptable, or should the nightly matrix shrink to Claude Code only? *Recommendation:* accept it through M4, and revisit once the pass-rate trend is stable.
- **Q5. Impello access for contributors.** Outside contributors cannot run Impello conformance without a key. *Recommendation:* conformance runs only in CI using the owner's key, and the docs point contributors to the E2B adapter as the public path. Open part: is a free contributor tier on Impello planned?
- **Q6. Telemetry.** Should Selfbuilding send anonymous usage data? *Recommendation:* no telemetry in v1. Events go only to sinks the user configures (§9.7).
- **Q7. Dogfood identity.** Which GitHub App and Slack workspace should the dogfood factory use, and who answers its `ask()` messages? *Recommendation:* a dedicated `selfbuilding-bot` App, plus a `#selfbuilding-factory` channel where only maintainers can answer.
- **Q8. Default skill pack license and community packs.** Should the pack be MIT like the rest of the project, and should community skill packs be accepted into the monorepo? *Recommendation:* MIT. Only the four default skills live in the repo. Community packs are published on their own and listed on a docs page.
- **Q9. Harness CLI redistribution review.** Who does the license review of the harness CLIs before M1 ends (§10.7)? *Recommendation:* the owner, with a lawyer only for the CLIs marked "unclear". Until the review is done, publish install-at-boot images for every proprietary CLI.
- **Q10. M3b scope if it slips.** Is shipping Modal and Cloudflare Sandbox as experimental ("adapter" tier, §1.10) acceptable for v1.0? *Recommendation:* yes. Both are already "adapter" tier, and v1.0 should not wait on them.

### 11.2 API and results

- **Q11. Native structured output as an opt-in.** Claude Code `--json-schema`, OpenCode's SDK `format` and Grok `--json-schema` give built-in retries without MCP (§2.6, §4.5). *Recommendation:* keep v1 to the single `submit_result` path. Revisit if one harness's MCP support turns out to be unreliable in the conformance runs.
- **Q12. Grace period after submit on Codex.** A fixed `timeouts.postSubmitGrace` of 10 s before SIGINT may cut off a model that is still committing. An alternative is to wait for the next `item.completed` that is not a tool call. *Recommendation:* measure this in the L4 smoke runs (§10.3) before freezing the default.
- **Q13. Running `assert` done checks on Cloudflare.** They run in the user's process. That is right for Node, but it complicates CF Workflows, where host code must be serialisable step work. *Recommendation:* allow them everywhere, and document that on CF they run inside the same `step.do` as the collect step (§7.5.3).
- **Q14. Default `maxDoneRetries` of 2.** It is a guess. *Recommendation:* keep it and tune it from data once real runs exist.
- **Q15. Wire format for `metadata`-pointer contracts.** Draft-07 JSON Schema files are proposed (§2.4.1). *Recommendation:* confirm with users who do not write TypeScript that they want this rather than a YAML schema before M1 ends.
- **Q16. PR authorship.** In v1, PRs are always opened by the GitHub App (§6.13). Should a run started by a human open its PR with that human's OAuth token? That makes the human the PR author, so they cannot approve their own PR. *Recommendation:* App-only in v1. Add a `pr.author: 'initiator'` option once the control plane (§7.11) can hold user OAuth tokens.
- **Q17. The `hello` timeout.** 60 s covers a cold start of the `selfbuilding` MCP server on every harness measured so far (§2.6.2). *Recommendation:* keep it, make it configurable per harness adapter, and tighten it once the L5 runs give p99 MCP start times.
- **Q18. Protected-path coverage beyond JS and Python.** `DEFAULT_PROTECTED` covers Node and Python test runners (§2.7.4). *Recommendation:* ship those in v1. Add Go (`go test` flags in `Makefile`), Rust (`Cargo.toml [profile.test]`) and JVM build files only when a user reports a gap. Contracts can always add paths with `protect.extra`.
- **Q19. A streaming run handle, `watch()` and `startAgent()`.** v1 has no `RunHandle` with `events()`, no library-level `watch()`, and no `startAgent()` returning a `CallHandle` with `send()` and `cancel()` (§6.16, §8.10). Event sinks, a caller-chosen `runId` and `selfbuilding watch` cover observation. *Recommendation:* keep them out of v1. Design a streaming handle together with mid-run messages (Q35) in v1.1, on top of the existing inbox (§6.9) and event envelope (§9.7).
- **Q20. A `/node` subpath for core.** v1 keeps `fileJournal` and `fileArtifacts` in the core main entry with a lazy `node:fs` import (§1.7, §10.1). The alternative is a `@selfbuilding/core/node` subpath, which makes the Workers rule structural instead of a lint check. *Recommendation:* no subpath in v1. Keep the CI import check and the Workers smoke test, and add a subpath only if a bundler is found that hoists the dynamic import.

### 11.3 Orchestration and durability

- **Q21. Default checkpoint mode.** The recommendation is `"git"`, because it works on every provider. `"snapshot"` restores faster where the provider supports it (§3.11). Should the default be `"snapshot"` on providers that declare cheap filesystem snapshots? *Recommendation:* `"git"` everywhere in v1; measure restore times in L4 before changing it.
- **Q22. Budget slice size, top-up and the default per-agent slice.** A slice is `min(remaining, perAgent.usd ?? usd / concurrency.sandboxes)`, with the unused part returned when the attempt ends (§3.12, §9.6). Two parts are open:
  - Should a running agent be able to top up its slice mid-turn when the run has headroom? *Recommendation:* not in v1. A turn that runs out of slice fails with `budget`, and the caller can resume it with a bigger budget.
  - When `perAgent.usd` is unset, `usd / concurrency.sandboxes` is safe but tight for runs that use one agent at a time. *Recommendation:* keep it for v1, document `perAgent.usd` prominently, and tune it from real run data.
- **Q23. Nesting depth.** One level is the decision for v1 (§3.7). *Recommendation:* revisit only if real factories need a third level instead of a separate run.
- **Q24. Cost of one child task per agent on Trigger.dev.** One child task per `agent()` adds per-task overhead and dashboard noise (§7.5.1). The alternative is to run the agent inside the parent task and lower only `parallel()` and `pipeline()` to children, which would also lose per-child budget slices. *Recommendation:* keep one child per agent in v1, and measure the overhead during M2 dogfooding.
- **Q25. Trigger input-stream buffering and senders.** If a wake is sent while the parent is not waiting, is it buffered for the next `wait()`? Can a webhook handler outside the run send on it with only a secret key? Reconciliation makes the first question matter only for latency. *Recommendation:* verify both in the L3 tests (§10.3). If wakes are buffered, raise the parent's reconcile interval from 10 minutes to 30.
- **Q26. Global idempotency scope on Trigger.dev.** Does `trigger` with an existing global key return the in-progress child run, or only completed ones? The design assumes it returns the in-progress run (§7.5.1). *Recommendation:* verify before v1.
- **Q27. Cross-run sandbox cap without the control plane.** v1 relies on provider 429s and backoff on Trigger and Inngest (§7.10). Should v1 ship a SQL `LeaseStore` (libSQL or Postgres) for teams that hit tier caps before the control plane exists? *Recommendation:* not in v1 unless dogfooding hits the cap.
- **Q28. `@impello/sdk` on Workers.** Its dependencies (undici, connectrpc) may not run in the Workers runtime (§7.12.3, §10.1). If they don't, an all-Cloudflare deployment cannot use Impello without a fetch-only client. *Recommendation:* let the Workers smoke test decide; until it passes, the Cloudflare Workflows host rejects Impello with a `ConfigError` that names Trigger.dev or Node as the alternative.
- **Q29. Pipeline isolation on Inngest.** The worst-case step estimator caps a single Inngest run at about 34 default agents (§7.5.2). Should `pipeline()` on Inngest run each item as a nested factory (`step.invoke`) automatically when the estimate goes past the limit? *Recommendation:* no automatic change in v1. Fail at plan time with `HostStepLimitError` and the fix in the message, and revisit once there is data from real factories.
- **Q30. Continuation on by default.** Continuation across boxes (§7.7) makes long calls work on short-session tiers, at the cost of one session move per boundary. *Recommendation:* on by default for harnesses that can move sessions, with `continuation: false` to fail at plan time instead.

### 11.4 Harnesses

- **Q31. Forcing MCP tools to load in Claude Code from the CLI.** The Agent SDK has `alwaysLoad`. No CLI flag or env equivalent has been verified (§2.6, §4.5). *Recommendation:* use it if a probe confirms it. Otherwise accept the one extra turn, and consider moving Claude onto the Agent SDK transport later.
- **Q32. Classifying shell commands as reads.** Every shell tool counts as an effect today, so a rate limit after only `git status` causes a resume rather than a fresh retry (§4.3, §4.12). *Recommendation:* keep it that way in v1. A resume is cheap, and a parser that guesses intent from shell text would eventually call a push a read.
- **Q33. The default for `postSubmitChanges`.** *Recommendation:* `'revert'` (§4.5.1). The accepted result is what the model claimed was finished, and post-submit edits are usually unplanned. The patch is kept, so nothing is lost.
- **Q34. Facts to verify before v1 GA.** Each one becomes a recorded fixture or a probe assertion. An experimental adapter stays experimental until its items are settled.
  - Codex `exec resume <id>` accepting every option in §4.4 (recorded fixture for the pinned version);
  - Codex `PostToolUse` hooks firing for MCP tools (this would replace `kill`);
  - OpenCode reading the prompt from stdin;
  - the OpenCode MCP tool timeout key (`timeout` on the MCP entry). If it does not exist, OpenCode declares a fixed `mcpToolTimeoutMs`, and `resolveTimeouts()` caps its hot waits below that value (§6.11);
  - Amp's resume flag and permission-bypass flag;
  - Droid's stream-json fields and skills path;
  - Grok's current `streaming-json` shape and API key variable name;
  - the current npm package names for OpenCode and Pi.
- **Q35. Steering a turn and mid-run messages.** Claude Code `--input-format stream-json`, Amp `steer`, Pi `steer` and Droid `add_user_message` can take messages during a turn. OpenCode live folding would need server mode (`prompt_async`), and Pi steering would need `--mode rpc`. Codex and Grok would get turn-boundary delivery only. All of this is left out of v1, so that every adapter shares one turn model (§4.4, §6.9). *Recommendation:* design mid-run messages in v1.1 on top of the existing inbox (§6.9), together with Q19. Ship turn-boundary delivery first, and gate live folding behind the parse-contract probe (§4.11).
- **Q36. Upper bounds on harness tool timeouts.** Some harnesses may clamp `MCP_TOOL_TIMEOUT` or `tool_timeout_sec` below effective hotWait + 2 min (§6.11, §8.4). *Recommendation:* let the probe record the effective maximum per harness version. Where it is lower, the hot wait shrinks to fit. Hot waits are not stretched past what the harness allows.

### 11.5 Sandboxes and runtime

- **Q37. Warm pool.** Should v1 ship a standing pool of `N` pre-created, paused sandboxes per `(provider, image)`? *Recommendation:* no. Pre-create on enqueue plus repo images covers most of the latency, and a pool adds a leak surface. Revisit after measuring p50 time to first agent token per provider.
- **Q38. Default provider for `run()` when none is given.** *Recommendation:* none. `sandbox` is required, and the error message names `docker()` for local use and `impello({ template: "selfbuilding-claude-code" })` for cloud.
- **Q39. Daytona VM vs container default.** The design assumes VM sandboxes are generally available on all paid tiers (§5.5). *Recommendation:* confirm before release.
- **Q40. Vercel on Hobby.** Its 45-minute sessions and concurrency of 10 make it unfit for factory workloads. Should the adapter refuse Hobby accounts, or only warn? *Recommendation:* warn once per process.
- **Q41. Impello unverified behaviour.** Confirm four things against the live API:
  - whether `timeoutMs: 0` means "no timeout" on `commands.run`;
  - whether `setTimeout` above the tier maximum is clamped or rejected;
  - whether the 14-day sweep of paused sandboxes is enforced;
  - whether Selfbuilding can publish public templates under `selfbuilding-*` aliases that any account can resolve.

  *Recommendation:* the adapter is written to be safe either way. It always passes explicit values, clamps to `limits`, treats old refs as possible ghosts, and falls back to `selfbuilding images build --provider impello` when public templates are not available.
- **Q42. Cloudflare facade auth and deployment.** Two parts:
  - Should the facade Worker use HMAC-signed requests with a key from the secret manager (§9), or Cloudflare Access service tokens? *Recommendation:* HMAC, so the facade has no dependency on Access.
  - Should `selfbuilding init` deploy the facade Worker, or should the docs describe a manual `wrangler deploy`? *Recommendation:* add an `init --provider cloudflare` template that includes the Worker, and keep deployment manual.
- **Q43. Docker `mount: "worktree"` in v1.** It is the fastest local loop, but it is the only mode in which the agent can touch host files. *Recommendation:* ship it behind an explicit option that carries the git hardening in §5.5 and §9.1, and do not make it the default.
- **Q44. Vercel persistent-sandbox timeout.** The design assumes that a persistent sandbox reaching its timeout stops and keeps its filesystem, the same as `stop()`. *Recommendation:* confirm this in the L4 conformance run. If it does not, set Vercel's `expireKeeps` to `"nothing"`, which makes escrow mandatory there.
- **Q45. Memory fork after v1.** A real memory fork, one that keeps a warm dev server across forks, would need per-child re-keying of every in-memory credential and process identity. *Recommendation:* keep it out until a factory shows a measured need. Quiescence plus `start.sh` covers the warm-start case.
- **Q46. `ns-reap` as a native helper.** It is the only artifact that is not TypeScript. The alternative is to rely on process groups and accept leaked `setsid` descendants. *Recommendation:* ship the helper, prebuilt for amd64 and arm64 and checksummed, and keep the process-group fallback (§10.7).
- **Q47. Progress before the control plane exists.** On Trigger.dev a launch token wakes the child but carries no progress. *Recommendation:* forward progress from the `wait` exec to Trigger realtime streams whenever the host reconciles, and accept coarse progress on durable hosts in v1.
- **Q48. Default `keepOnFailure`.** Killing failed sandboxes saves money. Parking them for an hour makes debugging easier. *Recommendation:* kill by default, and turn on `'1h'` automatically when the run is not AFK.
- **Q49. The write credential for mid-turn WIP pushes.** The mid-turn WIP push (§5.8) is done by the host or the reaper while agent processes are still alive. On providers where the host's exec runs as the same user as the agent, the agent could read the short-lived write token during that one exec. *Recommendation:* in v1, run the WIP push exec as root where the provider allows it (token file 0600 root), and on same-user providers copy the WIP commit out as a git bundle with `readFile` and push it from the orchestrator, so no write token enters the sandbox. Decide before M3b, when the first `lifetimeGuaranteed: false` provider ships.

### 11.6 Human in the loop

- **Q50. Discord free text in threads.** v1 supports buttons and modals only (§8.6). A gateway worker for thread replies would need a long-lived process. *Recommendation:* defer until the control plane exists, and run it there. Record the decision in `docs/out-of-scope/` for v1.
- **Q51. Default `hotWait`.** At 10 minutes, a quick answer is cheap, and a slow one costs one park and resume. Answer times are known to have a median of about a quarter of an hour and a long tail. *Recommendation:* keep 10 minutes and revisit with real run data.
- **Q52. Harness permission prompts as asks.** Claude Code's `--permission-prompt-tool`, OpenCode's permission endpoint and Droid's `request_permission` could route tool approvals through `ask()`. v1 bypasses permissions inside the sandbox (§4.4, §9.1). *Recommendation:* v1.1, behind an opt-in.
- **Q53. Escalation.** An `onTimeout: "escalate"` policy would re-ask on a second channel or approver set, with a new timeout. *Recommendation:* leave it out of v1. Posting to all channels at once covers most needs.
- **Q54. Slack app distribution.** A public Marketplace app forbids Socket Mode and needs OAuth installation flows. *Recommendation:* v1 documents "create your own Slack app from this manifest" and ships no hosted app.
- **Q55. Reconcile for Slack interactions.** Slack does not retry block actions, and no API lists missed clicks. *Recommendation:* rely on the user clicking again, which works because the card stays live until it is resolved. Revisit if the `skip [signature]` or 5xx rates show lost clicks in practice.

### 11.7 Security

- **Q56. Default egress.** The current default is `'open'` plus a recommended production preset (§9.5). The alternative is to default AFK runs to `presets.agent + presets.registries` on providers that can enforce allowlists, and accept occasional install failures. *Recommendation:* the owner chooses; the spec assumes `'open'` until then.
- **Q57. Memory pause of a sandbox that holds key material.** v1 allows in-place pauses (§9.3). The paused memory never leaves the sandbox, and the only git credential in it is a read token that expires within an hour. A stricter option would stop the harness before every pause, at the cost of a native resume on every cold `ask()`. *Recommendation:* keep in-place pauses in v1.
- **Q58. E2B header injection.** It is not confirmed whether hosted E2B, as opposed to Impello, applies `network.rules[].transform`. *Recommendation:* until a conformance probe confirms it, the adapter declares `inject: false`.
- **Q59. Who creates the ruleset.** `selfbuilding doctor` fails without a repository ruleset (§9.2). *Recommendation:* `selfbuilding init --github-ruleset` offers to create it using the caller's own `gh` login, which needs admin on the repo. It stores no admin token, and otherwise prints the ruleset JSON for manual setup.

### 11.8 Closed

These were open in earlier drafts and are now decided. They are listed so the questions do not come back.

| Question | Decision |
|---|---|
| Fan-out on Trigger.dev | One child task per agent call, one wake stream for every parent-side suspension, reconciliation through `runs.retrieve`, no batch API (§7.5.1). Factory-side asks inside `Promise.all` work. Q24 to Q26 keep the measurable parts open |
| Side effects in the factory body | `step()`, `now()`, `random()` and `uuid()` are module-level primitives (§3.7). The lint rule is `@selfbuilding/eslint-plugin`'s `no-nondeterminism` (§3.8) |
| Default-pack verdicts | `CodeReview` uses GitHub's review model: `approve`, `request_changes`, `comment` (§2.10.1) |
| Agents throw or resolve `null` | Agent calls throw. `.settled()`, `parallel()` and `pipeline()` give the value form (§1.9) |
| Cloudflare `instance.restart({ from })` | Not used. Resume after a terminal failure starts a new epoch, and failures are never served across epochs (§7.6) |
| Harness CLI version default | `'tested'`: the versions in each release's `harness-versions.json`, with `'latest'` as an opt-in and `harnessHold` as the rollback (§4.11) |
| Second-tier harnesses (Amp, Droid, Pi, Grok) | Shipped as experimental and promoted one by one when each meets the built-in bar (§1.10, §10.3) |

