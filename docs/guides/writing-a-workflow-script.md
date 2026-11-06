# Writing a workflow script

A workflow script is a factory written as a plain ES module. It runs inside a QuickJS (WASM) isolate that can
reach only the Selfbuilding primitives, under caps you set: no file system, no network, no imports. That makes it
safe to run a script an agent wrote, and quick to write one yourself. Every primitive call is journaled exactly as
in a TypeScript factory, so a script run resumes the same way.

```js
// review-and-verify.mjs
export default async function main(input, sb) {
  sb.phase("build");
  const build = sb.sandbox({ label: "build", size: "medium", repo: input.repo });
  const impl = await sb.agents.ImplementSpec(
    { spec: input.spec },
    { sandbox: build, harness: "claude-code", pr: { draft: true } },
  );
  if (impl.result.status !== "done") {
    await build.dispose();
    return { status: "build_incomplete" };
  }

  // At most two live boxes, the default --max-sandboxes: the build box and one copy of it.
  // Fork first, then hand the copy to sb.parallel. Never fork inside a thunk.
  sb.phase("review");
  const [forReview] = await build.fork(1);
  const [review, found] = await sb.parallel([
    () => sb.agents.CodeReview({ target: { kind: "diff", base: "main" } }, { sandbox: forReview ?? "fresh" }),
    () => sb.agents.FindFlows({ change: impl.result.summary }, { sandbox: build }),
  ]);
  await forReview?.dispose();

  // One copy per flow, disposed before the next fork. A failed FindFlows (null) or no flows skips this.
  sb.phase("verify");
  const outcomes = [];
  for (const flow of found?.result.flows ?? []) {
    const [box] = await build.fork(1);
    const verdict = await sb.agents.Verify.settled(
      { change: impl.result.summary, flows: [flow] },
      { sandbox: box ?? "fresh", harness: "codex" },
    );
    await box?.dispose();
    outcomes.push(verdict.ok ? (verdict.value.result.flows[0]?.outcome ?? null) : null);
  }
  await build.dispose();
  return { review: review?.result.verdict ?? null, flows: outcomes };
}
```

The default export is called once with the run's input and `sb`. It returns JSON. Every live handle (from
`sb.sandbox()` or `fork()`) counts against `--max-sandboxes` until you `dispose()` it, and a fork that asks for more
than the cap leaves is refused with `ScriptLimitError`, so dispose a copy before you fork the next one. A fork child
can be `null` (that copy failed); pass `?? "fresh"` rather than `null` as `sandbox`.

## Running a script

```sh
npx selfbuilding start review-and-verify.mjs --input '{"repo":"github.com/acme/api","spec":"..."}' --size medium
npx selfbuilding start review-and-verify.mjs --detach --json   # print the receipt and exit
npx selfbuilding watch <runId>
```

`selfbuilding start` runs the script as the `run-script` factory, through the same guards an agent-launched run
gets (size, budget, sandboxes; see [agent-launched-workflows.md](agent-launched-workflows.md)). Flags: `--name`,
`--input <json|@file>`, `--host node|trigger`, `--size` (the largest size the script may ask for, default `small`),
`--max-sandboxes` (default 2), `--budget` (USD, default 10), `--afk`, `--idempotency-key`, `--detach`, `--config`,
`--env-file`, `--json`.

To give the script your own agents, harness logins or providers by name, deploy the factory yourself:

```ts
// factories/run-script.ts
import { createScriptFactory } from "@selfbuilding/script";
import config, { harnesses } from "../selfbuilding.config";

export default createScriptFactory({ config, harnesses /* , agents, providers, caps */ });
```

and run it with `selfbuilding run factories/run-script.ts --input @input.json`, where `input.json` is
`{ "name": "review-and-verify", "source": "<the module text>", "input": { ... } }` (`ScriptRunInput`; `caps` may
tighten further). Register the same factory with each host: `createTriggerHost({ factories: { "run-script":
createScriptFactory({ config }) } })`. Without a registry, scripts see the four built-in agents
(`ImplementSpec`, `CodeReview`, `Verify`, `FindFlows`), the harnesses `claude-code` and `codex` with no logins of
their own, and only the run's default provider.

`runScript(source, input, opts)` runs a script inside a factory you already have; `checkScript(source, caps?)`
compiles one without running it.

## The `sb` object

Only `sb` crosses into the isolate.

| Member | Maps to | Notes |
|---|---|---|
| `sb.input` | the run's `input` | Same as the first argument |
| `sb.agents.<Name>(input, opts?)`, `.settled(...)` | the registered agent | Resolves to `{ result, callPath, replayed, usage, artifacts: { branch?, pr?, files: [{ path, uri }] } }` |
| `sb.agent({ name, prompt, output, input? }, opts?)` | inline `agent()` | `output` is a JSON Schema |
| `sb.parallel(thunks[] \| record)` | `parallel()` | Failed items are `null` |
| `sb.pipeline(items, ...stages)`, `sb.pipeline(opts, items, ...stages)` | `pipeline()` | `opts`: `key`, `maxInFlight`, `label` |
| `sb.step(name, fn)` | `step()` | `fn` returns JSON |
| `sb.sandbox({ label?, size?, provider?, repo? })` | `sandbox()` | A handle: `id`, `exec(cmd, { cwd?, timeout? })`, `fork(n, { size? })`, `push()`, `dispose()`. Pass it as `opts.sandbox` |
| `sb.ask({ question, ... })` | `ask()` | Keys: `question`, `title`, `context`, `choices`, `freeText`, `default`, `timeout`, `onTimeout`, `risk`, `dedupeKey` |
| `sb.pr.get(pr)` | `getPr()` | The PR's `title`, `body`, `state`, `head`, `base`, `headSha`, `draft` |
| `sb.pr.comment({ pr, body, dedupeKey? })` | `commentOnPr()` | Counts toward `maxPrWrites` |
| `sb.pr.update({ pr, title?, body?, section? })` | `updatePr()` | `section: { heading, content }` replaces one `## heading` section of the body. Counts toward `maxPrWrites` |
| `sb.phase(name)`, `sb.log(msg, level?)` | `phase()`, `log()` | `console.log` maps to `sb.log` |
| `sb.now()`, `sb.random()`, `sb.uuid()` | `now()`, `random()`, `uuid()` | Journaled |

Call options a script may pass to an agent: `sandbox` (a handle or `"fresh"`), `harness` and `provider` (registry
names), `size`, `label`, `phase`, `timeout`, `budget: { usd }`, `effort`, `pr` (`true` or
`{ draft, base, title, body, labels }`), `repo`, `git: { branch, baseBranch }`. Anything else is
`ScriptInvalidError`. Values crossing the boundary are JSON only, at most 1 MiB per crossing.

There is no per-ask AFK option: start the run with `--afk` (or `afk: true` in `start_workflow`) and every ask
resolves by its policy.

### Pull requests from a script

A `pr` is a PR URL, `{ url }`, or `{ repo, number }`; an agent result's `artifacts.pr` works as it is. `sb.pr` reaches
only the PRs this run's agent calls opened (the ones their results carry as `artifacts.pr`); any other target is
`ScriptInvalidError`, so a script cannot read or edit other PRs the host identity can see. The git broker in the
config (the GitHub App or `pat()`) does the work; without one, `sb.pr` fails naming that fix.

```js
const pr = build.artifacts.pr;
if (pr) {
  await sb.pr.comment({ pr, body: "Review round 1: 2 findings to fix.", dedupeKey: "round-1" });
  await sb.pr.update({ pr, section: { heading: "Verified", content: "- ✅ add a note: verified" } });
}
```

Each call is one journaled step, so a resume returns the recorded value and never posts again. A comment carries a
hidden marker for its `dedupeKey` (default: derived from the run and call path), so a crash between the post and the
journal write still posts once. Only a marker in a comment the host identity wrote counts, so a copied marker in
someone else's comment does not stop the post. Section edits to one PR are serialised within the process, so two
`sb.parallel` branches editing different sections both land; there is no such guarantee across processes, because
GitHub has no conditional edit.

## Caps

The caps a run gets are `DEFAULT_SCRIPT_CAPS`, tightened by the config's `scripts`, then by the run's own `caps`
(each value the minimum, `allowedSizes` the intersection). A script can never loosen them. Every breach throws
`ScriptLimitError` with the limit and its maximum.

| Cap | Default | Enforced as |
|---|---|---|
| `memoryBytes` | 64 MiB | The isolate's heap limit |
| `stackBytes` | 1 MiB | The isolate's stack limit |
| `cpuSliceMs` | 1000 | Synchronous time between two host calls before the isolate is interrupted |
| `maxAgentCalls` | 50 | Agent calls over the whole run |
| `maxSandboxes` | 4 | Live sandboxes at once, counting `sb.sandbox()` boxes and forks |
| `allowedSizes` | `["small", "medium"]` | Sizes a call, `sb.sandbox()` or `fork()` may ask for; an unsized `sb.sandbox()` is checked at the provider's default size |
| `budgetUsd` | 20 | The run's budget |
| `wallClock` | `"4h"` | The run's wall clock |
| `maxOutputBytes` | 256 KiB | The serialised return value |
| `maxSourceBytes` | 256 KiB | The source |
| `maxPrWrites` | 20 | `sb.pr.comment` and `sb.pr.update` calls over the run; the next one is refused before any request is sent |

## Determinism

The isolate has no `Date.now()` or argument-less `new Date()` (use `sb.now()`), no `Math.random()` (use
`sb.random()`), no `eval`, no `Function` constructor, no timers, no `fetch` and no imports. Each throws
`ScriptInvalidError` naming the replacement. A primitive call is numbered when the script makes it, so call paths
follow the source: `Promise.all` over agent calls is fine, and `sb.parallel` is the documented form.

The source and input are part of the run input, so a resume replays the same script and finished calls come from
the journal. Forking inside a `sb.parallel` thunk or a `sb.pipeline` stage fails, as it does in a TypeScript
factory: fork first, then pass the copies in, as in the example above.

## Errors

| Error | When |
|---|---|
| `ScriptInvalidError` (`script_invalid`) | A compile error, no default export, a banned global, an unknown option, agent, harness or provider name, a bad PR target |
| `ScriptFailedError` (`script_failed`) | The script threw; `scriptStack` is the isolate's stack, never a host stack |
| `ScriptLimitError` (`script_limit`) | Any cap above |
