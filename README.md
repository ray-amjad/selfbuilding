# selfbuilding

Selfbuilding is a TypeScript library for dynamic workflows with sandboxes, run locally or handed to Trigger.dev.
A workflow is a plain async function that runs coding agents (Claude Code, Codex) in Docker, E2B or Impello
sandboxes, and every step is journaled, so a crashed or paused run resumes where it stopped.

**Status: 0.1, pre-1.0.** The API can still change between minor versions. See [docs/ROADMAP.md](docs/ROADMAP.md) for what
has been proven against real services and what has not.

## Quickstart

Requires Node 22.12 or later and a Docker daemon (or an E2B or Impello account).

```sh
npm i @selfbuilding/core @selfbuilding/agents @selfbuilding/harnesses @selfbuilding/sandbox-docker zod
npm i -D selfbuilding
```

Then:

```sh
npx selfbuilding init                          # asks for harness, provider, host, channel, example factory
cp .env.example .env                           # fill in the names it lists (secret manager or .env)
npx selfbuilding images build --provider docker --harness claude-code
npx selfbuilding doctor --env-file .env        # lists everything that is missing, all at once
```

`init` writes `selfbuilding.config.ts`, an example factory in `factories/review-pr.ts`, `.agents/skills/`,
`.env.example` and `.selfbuilding/.gitignore`. Pass the answers as flags to skip the questions:
`selfbuilding init --harness claude-code --provider docker --host node --channel none --template review-pr`.

Run the example factory locally. It reviews one pull request in a fresh sandbox and prints a typed result:

```sh
npx selfbuilding run factories/review-pr.ts --env-file .env \
  --input '{"url":"https://github.com/<owner>/<repo>/pull/<n>"}'
npx selfbuilding watch <runId>                 # from another shell: follow the run's events
npx selfbuilding resume <runId>                # after a crash: finished calls replay from the journal
```

The same factory on Trigger.dev: `selfbuilding init --host trigger` also writes `trigger/selfbuilding.ts`, which
exports the three tasks from `createTriggerHost`. Add a `trigger.config.ts` that points at that folder, then:

```sh
npm i @selfbuilding/host-trigger @trigger.dev/sdk   # before the release: npm i @trigger.dev/sdk (the tarballs have the rest)
npx trigger.dev@4 dev                          # runs the tasks on this machine
```

and start a run from your code with `tasks.trigger("selfbuilding.factory", { factory: "reviewPr", input: { url } })`.
Each agent call becomes its own `selfbuilding.agent` child run. Deploying, and the shared result store a deployed
project needs, are in [docs/guides/trigger-dev.md](docs/guides/trigger-dev.md).

## The pieces

Each example runs inside a `factory()` body. `claude` and `gpt` stand for your configured harness values, with
their credentials (see the [Claude Code](docs/guides/harness-claude-code.md) and [Codex](docs/guides/harness-codex.md)
guides); a call without `harness` uses `config.harness`.

**An agent.** Inline, with a prompt and a typed output:

```ts
import { agent, factory } from "@selfbuilding/core";
import { z } from "zod";

export const triage = factory({ name: "triage", input: z.object({ repo: z.string() }) }, async ({ repo }) => {
  const { result } = await agent({
    name: "triage",
    prompt: "List the three flakiest tests in this repository and why. Change nothing.",
    output: z.object({ tests: z.array(z.object({ file: z.string(), why: z.string() })) }),
    repo,
  });
  return result.tests;
});
```

Or from a skill folder (a `SKILL.md` plus optional scripts and references), which compiles to a typed function:

```ts
import { Agent } from "@selfbuilding/core";

export const Triage = await Agent.fromSkill(new URL("../.agents/skills/triage/", import.meta.url), {
  input: z.object({ task: z.string() }),
  output: z.object({ tests: z.array(z.string()) }),
});

const { result } = await Triage({ task: "find flaky tests" }, { repo });
```

**pipeline and parallel.** `parallel()` runs thunks at once; a failed item is `null`. `pipeline()` runs each item
through its stages, as many at once as the sandbox cap allows.

```ts
import { parallel, pipeline } from "@selfbuilding/core";

const [security, style] = await parallel([
  () => CodeReview({ target, focus: ["security"] }),
  () => CodeReview({ target, focus: ["style"] }),
]);
const fixes = await pipeline({ key: (f) => f.file }, findings, (f) => fixOne(f));
```

**sandbox() and fork.** A fresh sandbox per agent call is the default. A handle shares one box across calls, and
`fork(n)` copies it, so reviewers work on the builder's tree without touching it:

```ts
import { sandbox } from "@selfbuilding/core";

await using box = sandbox({ repo, label: "build", size: "medium" });
await ImplementSpec({ spec }, { sandbox: box, harness: claude });
const [a, b] = await box.fork(2);            // fork first, then hand the copies to parallel()
const reviews = await parallel([
  () => CodeReview({ target }, { sandbox: a ?? "fresh", harness: claude }),
  () => CodeReview({ target }, { sandbox: b ?? "fresh", harness: gpt }),
]);
```

**ask.** A question to a person, over Slack or `selfbuilding answer`. With nobody around (`--afk`) it resolves by
its policy:

```ts
import { ask } from "@selfbuilding/core";

const answer = await ask({ question: "Merge PR #12?", choices: ["merge", "hold"], default: "hold", timeout: "24h" });
if (answer.choiceId === "merge") { /* ... */ }
```

**Sizes.** `small` (2 vCPU, 4 GiB), `medium` (4, 8) and `large` (8, 16), plus your own in the config. A size a
provider cannot give fails with `SizeUnavailableError`, whose message names the fix.

```ts
await Verify({ change, flows }, { size: "medium", harness: gpt });
```

**Workflow scripts and start_workflow.** A workflow can also be a plain ES module that runs in a QuickJS isolate,
with only the primitives in reach. An agent can write one and start it as a new run with the `start_workflow` tool,
within caps you set.

```js
// nightly.mjs: selfbuilding start nightly.mjs --input '{"repo":"github.com/acme/api","spec":"..."}' --size medium
export default async function main(input, sb) {
  const box = sb.sandbox({ label: "build", size: "medium", repo: input.repo });
  const build = await sb.agents.ImplementSpec({ spec: input.spec }, { sandbox: box, harness: "claude-code" });
  const [copy] = await box.fork(1);
  const review = await sb.agents.CodeReview({ target: { kind: "diff", base: "main" } }, { sandbox: copy });
  return { build: build.result.status, verdict: review.result.verdict };
}
```

## Guides

Start with [docs/guides/README.md](docs/guides/README.md). In short:

- Setup: [Docker](docs/guides/providers-docker.md), [E2B](docs/guides/providers-e2b.md),
  [Impello](docs/guides/providers-impello.md), [Claude Code](docs/guides/harness-claude-code.md),
  [Codex](docs/guides/harness-codex.md), [GitHub App](docs/guides/github-app.md), [Slack app](docs/guides/slack-app.md),
  [Trigger.dev](docs/guides/trigger-dev.md), [R2 and S3](docs/guides/artifacts-r2-s3.md)
- Concepts: [sizes and templates](docs/guides/sizes-and-templates.md), [journals](docs/guides/journals.md)
- Writing: [a factory](docs/guides/writing-a-factory.md), [a workflow script](docs/guides/writing-a-workflow-script.md),
  [agent-launched workflows](docs/guides/agent-launched-workflows.md), [verifying flows](docs/guides/verifying-flows.md)
- A worked example: [tests/live/task-lifecycle](tests/live/task-lifecycle/README.md)

The design lives in `docs/spec/`, the glossary in `CONTEXT.md`, and progress in `docs/ROADMAP.md`.

## Develop

```sh
pnpm install
pnpm build       # tsup (JS) + tsc -b (declarations), every package
pnpm check       # biome check, typecheck, tests
```

Tests that need Docker, network services or real credentials are gated by env vars and skip when they are absent.
See [CONTRIBUTING.md](CONTRIBUTING.md) and, for security reports, [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE). One exception: the CodeReview prompt bodies in `@selfbuilding/agents` are
reproduced verbatim from Anthropic's Claude Code review prompts and credited to Anthropic; see [NOTICE](NOTICE).
