# Writing a factory

A factory is a plain async TypeScript function wrapped by `factory()`. Inside it you call agents, run steps and
make sandboxes; Selfbuilding journals each of those calls, so the run can stop at any point and resume later.

```ts
// factories/fix-issue.ts
import { CodeReview, ImplementSpec } from "@selfbuilding/agents";
import { ask, factory, phase, sandbox } from "@selfbuilding/core";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { codex } from "@selfbuilding/harnesses/codex";
import { z } from "zod";

const claude = claudeCode({ credentials: [/* see harness-claude-code.md */] });
const gpt = codex({ credentials: [/* see harness-codex.md */] });

export default factory(
  {
    name: "fix-issue",
    input: z.object({ repo: z.string(), spec: z.string() }),
    defaults: { size: "medium" },
    budget: { usd: 15, wallClock: "2h", perAgent: { usd: 5 } },
  },
  async ({ repo, spec }) => {
    phase("build");
    await using box = sandbox({ repo, label: "build" });
    const build = await ImplementSpec(
      { spec },
      { sandbox: box, harness: claude, label: "implement", pr: { draft: true } },
    );
    if (build.result.status !== "done") return { status: "blocked", summary: build.result.summary };

    phase("review");
    const [copy] = await box.fork(1);
    const review = await CodeReview(
      { target: { kind: "diff", base: "main" } },
      { sandbox: copy ?? "fresh", harness: gpt },
    );

    const answer = await ask({
      question: `PR ${build.artifacts.pr?.url}: review says ${review.result.verdict}. Merge?`,
      choices: ["merge", "hold"],
      default: "hold",
    });
    return { status: "done", verdict: review.result.verdict, decision: answer.choiceId };
  },
);
```

Run it with `selfbuilding run factories/fix-issue.ts --input '{"repo":"github.com/acme/api","spec":"..."}'`, or
from code with `run(fixIssue, input, { config })`. `selfbuilding watch <runId>` follows it.

## Factory options

| Option | Meaning |
|---|---|
| `name`, `input`, `output` | The name, and zod schemas for the input and (optionally) the output |
| `defaults` | `harness`, `sandbox` (a provider), `effort`, `repo`, `timeout`, `size` for every call in the body |
| `budget` | `usd`, `tokens`, `wallClock`, `perAgent: { usd, wallClock, maxTurns }`; replaces `config.budget` for this run |
| `concurrency` | `sandboxes` (live boxes at once), `createsPerMinute` |
| `hitl` | Asks: `channels`, `approvers`, `timeout`, `onTimeout`, `mode` |

The config file (`selfbuilding.config.ts`) holds what is shared by every factory: the default harness and provider,
the journal, artifacts, secrets, git broker, Slack, sizes and script caps.

## Agents

- **Built-in agents** from `@selfbuilding/agents`: `ImplementSpec` (builds a spec on a new branch, with
  implementation notes), `CodeReview` (a medium or high tier review with typed findings), `FindFlows` (the user
  flows a diff touches) and `Verify` (drives a web app as a user and checks the database). `ImplementSpec`,
  `FindFlows` and `Verify` carry a default harness without credentials, so pass `harness` on each call.
- **Inline:** `agent({ name, prompt, output, ...callOptions })`. The prompt is a literal string.
- **From a skill folder:** `await Agent.fromSkill(dir, { input, output, done, defaults })`, where `dir` is an
  absolute path or `new URL("./skill/", import.meta.url)`. The folder is a `SKILL.md` plus optional `scripts/`,
  `references/` and `assets/`. This is one way to define an agent; it compiles to the same typed function.

Every agent call resolves to an `AgentResult`: `result` (validated against the output schema), `artifacts` (branch,
PR, diff, transcript, files), `usage`, `callPath` and `replayed` (true when it came from the journal). The agent
reports its result through the `submit_result` tool; an invalid result is sent back to it and retried inside the
run. A call that fails throws; `X.settled(input, opts)` returns `{ ok: true, value }` or `{ ok: false, code, error }`
instead.

## Placement

Where each call runs is a call option, never part of the agent:

| `sandbox` option | Meaning |
|---|---|
| omitted or `"fresh"` | A new box from the default provider, disposed after the call |
| a provider (`docker()`, `e2b({...})`) | A new box from that provider, e.g. a reviewer on another vendor |
| a handle from `sandbox()` | The shared box; it supplies the repo and branch. One call at a time (`SandboxBusyError` otherwise) |
| a fork from `box.fork(n)` | A copy of the shared box, from a snapshot or a git checkpoint |

`harness` is per call too, so two reviewers on two harnesses can read the same diff. A handle has `exec(cmd)`,
`push()`, `snapshot()`, `checkpoint()`, `fork(n, { size })` and `dispose()`; `await using` disposes it when the
scope ends. `fork(n)` resolves to a list where a child that could not be made is `null`.

Fork before you fan out. A handle belongs to the scope that created it, so calling `box.fork()` inside a
`parallel()` thunk or a `pipeline()` stage throws `SandboxHandleScopeError`. Make the forks first and hand each one
to its thunk:

```ts
const [a, b] = await box.fork(2);
const [r1, r2] = await parallel([
  () => CodeReview({ target }, { sandbox: a ?? "fresh", harness: claude }),
  () => CodeReview({ target }, { sandbox: b ?? "fresh", harness: gpt }),
]);
```

A fork handed to a thunk is claimed by it. `parallel()` returns `null` for a failed item and `pipeline()` does the
same per item, so one failure does not stop the others.

## Pull requests

`pr: true` (or `{ draft, base, title, body, labels }`) on an agent call opens or updates a PR for its working
branch, as the git broker (the GitHub App). Agents never push or open PRs themselves: the host pushes
`selfbuilding/*` branches after the call. From a factory you can also read and edit the run's PR with `getPr`,
`commentOnPr(pr, body, { dedupeKey })` and `updatePr(pr, { title, body, section: { heading, content } })` from
`@selfbuilding/core`; each is one journaled step, so a resume never posts twice.

## Determinism

The body is replayed on resume, so everything that differs between runs must go through a primitive: `now()`,
`random()` and `uuid()` instead of `Date.now()`, `Math.random()` and `crypto.randomUUID()`, and `step(name, fn)` for
any other side effect or read (an HTTP call, a file). Each call gets a call path from its position in the program
(`CodeReview#0`, `parallel#0/[1]/review`; a `label` replaces the `Name#n` part), and the journal key depends on
the call and what came before it. Editing a prompt or input makes that call and everything after it run live on
resume; the calls before it replay.

## Budget and caps

The run stops starting new work when the USD budget (model spend plus estimated sandbox time) or the wall clock
is spent, and ends with status `budget_exhausted` (exit code 4). Each agent call gets a slice
(`budget.perAgent`, or the call's own `budget: { usd }`). `concurrency.sandboxes` caps live boxes; a call waits for
a slot rather than failing.

## Resume

```sh
npx selfbuilding resume <runId>
npx selfbuilding resume <runId> --interrupted implement=resume-session
```

Finished calls replay from the journal. A call that was running when the process died is never re-run silently:
choose `fail` (the default), `resume-session` (continue the harness session), `restore-and-rerun` or `skip` per call
path. A run waiting on a question exits with code 6 (`waiting`) and resumes once it is answered.

## Exit codes

0 ok, 1 failed, 2 usage or config error, 3 partial, 4 budget exhausted, 5 needs attention, 6 waiting on an ask,
7 aborted, 130 interrupted.
