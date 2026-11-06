# Release prep: contracts for the parallel build

Date: 2026-11-04. Branch `build/release-prep`, cut from `build/demo-path` at `10336a2`. This file fixes every name,
shape and rule the seven builders of this batch share, so they can work without talking. Where it and
`docs/spec/demo-path.md` or `docs/spec/selfbuilding-v1-spec.md` disagree, this file wins for the features below;
`docs/BASIC-SCOPE.md` still wins for everything else. Ownership is in `docs/BUILD-MAP.md` §7. Section numbers are
referenced from code comments (`release-prep §2.2`); keep them stable.

The shared public types and the new error class already exist on the branch (§8). New exports are stubbed through
each package's `not-implemented.ts`; delete that file when its last stub is gone.

Owner decisions (final):

- Positioning is low-key. Lead with "dynamic workflows with sandboxes, run locally or handed to Trigger.dev". Skills
  becoming agents is one way to define an agent, never the headline. No marketing language.
- Never name or mention any product, repo or person the design was inspired by. Describe Selfbuilding only.
- Secrets are authored in one secret manager. Docs say "put these in your secret manager or `.env`" and never show
  a real value. Tests and docs use obviously fake values (`sk-ant-test-…`, `xoxb-test-…`).
- The repo will go public. Files this batch adds must carry nothing private: no tailnet hostnames, account or
  workspace ids, personal paths (`/Users/<name>`, `/home/<name>`), Slack user or channel ids.
- No new LICENSE decision. The scaffold's MIT `LICENSE` stays as it is; `docs/RELEASE-CHECKLIST.md` carries the
  owner's TODO.
- Every thrown error is a `SelfbuildingError` subclass with a registry row. `pnpm check` must pass offline.
- Nobody in this batch runs live tests (`SELFBUILDING_LIVE`), starts a real sandbox or reads a credential. Live
  cases may be written, gated, and listed in `tests/live/README.md`; the owner runs them.

---

## 1. SQLite journal (sqlite-journal)

### 1.1 API

```ts
import { sqliteJournal } from "@selfbuilding/core";

defineConfig({ journal: sqliteJournal(".selfbuilding/journal.db", { busyTimeoutMs: 5000 }) });
```

- `sqliteJournal(path: string, opts?: SqliteJournalOptions): JournalStore` in `packages/core/src/journal/sqlite-journal.ts`
  (stub present, exported from `@selfbuilding/core`). `SqliteJournalOptions` is in `types/orchestration.ts`:
  `{ busyTimeoutMs?: number }` (default 5000).
- The returned store implements every member of `JournalStore`, including `release`, and the two companion stores
  in the same file: `asks` (every `AskStore` member, optional ones included: `patch`, `list`, `markCold`) and
  `results` (`ResultStore`). Same observable semantics as `fileJournal`: one live lease per run, `leaseEpoch`
  strictly increasing per run, `put` fenced by the lease and compare-and-set on `expectStatus` (`null` = must not
  exist), `list` in the same order `fileJournal` returns, `resolve` CAS on `status = "open"`.
- `node:sqlite` (`DatabaseSync`) is imported lazily on the first call (`await import("node:sqlite")`), so the core
  main entry keeps only its current static imports (`packages/core/src/index.test.ts` checks this). The factory
  itself is synchronous and does no I/O. If the import fails (Node below 22.13 without `--experimental-sqlite`),
  the first call throws `ConfigError` naming the fix: "sqliteJournal needs node:sqlite (Node 22.13 or later). Use
  fileJournal, or upgrade Node."
- Parent directories are created. The file is opened with `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout =
  <busyTimeoutMs>`, `PRAGMA synchronous = NORMAL`, `PRAGMA foreign_keys = ON`.

### 1.2 Storage

| Table | Columns | Notes |
|---|---|---|
| `meta` | `key TEXT PRIMARY KEY, value TEXT` | `format` = `JOURNAL_FORMAT`; a different stored value throws `JournalVersionError` (same rule as `fileJournal`) |
| `entries` | `run_id, step_key, seq INTEGER, status, json TEXT`; primary key `(run_id, step_key)` | `seq` fixes `list` order; `json` is the whole `JournalEntry` |
| `leases` | `run_id PRIMARY KEY, owner, epoch INTEGER, expires_at TEXT` | |
| `asks` | `ask_id PRIMARY KEY, run_id, status, channel, thread TEXT, json TEXT` | indexes on `run_id` and `thread` |
| `results` | `key PRIMARY KEY, json TEXT, version INTEGER` | `version` is the `getVersioned` token, as a string |

- Every write that reads before it writes (`lease`, `renew`, `put`, `resolve`, `markCold`, `replace`,
  `createIfAbsent`) runs in one `BEGIN IMMEDIATE` transaction, and `put` re-checks the lease inside that same
  transaction, so a writer that lost its lease between `assertLease` and `put` still fails with `LeaseLostError`.
- `SQLITE_BUSY` after the busy timeout throws `JournalConflictError` with a message naming the file and the timeout.
- Values are JSON text. No column holds a secret: the journal holds what `fileJournal` holds.
- Several processes on one machine may share the file. Network filesystems are not supported (say so in the guide).

### 1.3 CLI

```
selfbuilding journal import <file-journal-dir> <db> [--json]
```

- New command file `packages/cli/src/commands/journal.ts`, registered in `main.ts` (hunk: one entry in the command
  table and one line of top-level help).
- Copies every run's entries (keeping each run's order), asks and result records from a `fileJournal` directory
  into a SQLite file (created if missing). Leases are not copied: an imported run is resumed with a fresh lease.
- Refuses (exit 1, nothing written for that run) a run whose lease in the source is still live, naming it.
- Idempotent: a row that already exists with identical JSON is skipped; a row that exists with different JSON is a
  conflict, reported per run, exit 1. Each run is imported in its own transaction.
- Output: one line per run, `ok   <runId>  <n> entries  <n> asks  <n> results` or
  `fail <runId>  <reason>`; `--json` prints one object per run. Exit 0 all imported or skipped, 1 any conflict or
  refusal, 2 usage error.

### 1.4 init and docs

`selfbuilding init` keeps `fileJournal(".selfbuilding/journal")` as the default. The generated config gains one
comment line under the journal: `// Several processes on one machine? journal: sqliteJournal(".selfbuilding/journal.db")`
(`packages/cli/src/templates.ts`, the config template hunk only). `.selfbuilding/.gitignore` from init also ignores
`journal.db*`.

### 1.5 Tests (offline)

- `packages/core/src/journal/journal.test.ts`: add `["sqliteJournal", () => sqliteJournal(join(dir, "j.db"))]` to
  the `stores` table, so every shared case runs on it; port the `fileJournal on disk` and `fileJournal asks` blocks
  to a `describe.each` over both on-disk stores where they test behaviour rather than file layout.
- `packages/core/src/journal/sqlite-journal.test.ts`: format mismatch → `JournalVersionError`; two stores on one
  file (two connections, the same locking as two processes) racing `lease` and `put`: exactly one wins; a real
  child process (`node:child_process`, an inline `node --input-type=module -e` script using `node:sqlite` directly)
  holds `BEGIN IMMEDIATE` past the busy timeout → `JournalConflictError`, then succeeds once it commits; the ask
  store CAS and `markCold` under the same race; `results` create-if-absent and replace on version.
- `packages/cli/src/commands/journal.test.ts`: import a file journal with two runs, re-import (skipped), a changed
  row (conflict, exit 1), a live lease (refused).
- `tests/acceptance/14-sqlite-journal.test.ts`: acceptance 3 on `sqliteJournal`: reuse
  `tests/acceptance/support/crash-scenarios.ts` (`machineDiesThenPromptEdit`, `hostDiesMidCall`) by adding an
  optional `journal: "file" | "sqlite"` field to their options (default `"file"`, additive). The host is killed
  with SIGKILL; the resume replays from the SQLite file.

---

## 2. Workflow scripts on their PR (script-pr)

### 2.1 Git broker PR API

`PullRequestApi` (`types/security.ts`) gains three optional members, implemented in
`packages/channel-github/src/pulls.ts` for both `githubApp()` and `pat()`:

| Member | REST call | Returns |
|---|---|---|
| `get(repo, number)` | `GET /repos/{o}/{r}/pulls/{n}` | `PullRequestInfo` (`repo`, `url`, `number`, `draft`, `title`, `body`, `state` with `merged` when `merged_at` is set, `head`, `base`, `headSha`) |
| `update(repo, number, { title?, body? })` | `PATCH /repos/{o}/{r}/pulls/{n}` | `PullRequestInfo` as stored afterwards; title and body clamped as `openOrUpdate` does |
| `comment(repo, number, body, { dedupeKey? })` | `POST /repos/{o}/{r}/issues/{n}/comments` | `PullRequestComment { id, url, created }` |

- With `dedupeKey`, the posted body ends with `\n\n<!-- selfbuilding:comment:<dedupeKey> -->`. Before posting, the
  API lists the PR's comments (`GET …/issues/{n}/comments?per_page=100`, following `Link` pages) and returns the
  first comment whose body carries that marker, with `created: false`.
- Failures map like `openOrUpdate`: unreachable or 5xx → `ChannelDeliveryError`; 4xx → `ConfigError` naming the
  permission to check (`pull_requests: write` for update, `issues: write` for comment on a GitHub App).
- Comment bodies over 65,536 characters are cut with the same note `clampBody` uses.

### 2.2 Core helpers

In `packages/core/src/pr/index.ts` (stubs present, exported from `@selfbuilding/core`):

```ts
parsePrTarget(target: PrTarget, host?: string): { repo: string; number: number };
replacePrSection(body: string, heading: string, content: string): string;
getPr(pr: PrTarget): Promise<PullRequestInfo>;
commentOnPr(pr: PrTarget, body: string, opts?: { dedupeKey?: string }): Promise<PullRequestComment>;
updatePr(pr: PrTarget, patch: PrUpdate): Promise<PullRequestInfo>;
```

- `PrTarget = string | { url: string } | { repo: string; number: number }`. An agent result's `artifacts.pr`
  (`{ url, number, draft }`) is a valid target. A string must be a PR URL `https://<host>/<owner>/<repo>/pull/<n>`;
  `repo` comes back as `<host>/<owner>/<repo>` (the form `PullRequestApi` takes), `host` defaults to the run's git
  broker host, else `github.com`. Anything else throws `PrTargetError` (new, `pr_target`, usage).
- `replacePrSection` is pure. A section is a line that is exactly `## <heading>` (trailing spaces ignored, case
  sensitive) and every line after it up to, not including, the next line starting with `## ` or the Selfbuilding
  trailer block (a `---` line followed within three lines by a `Selfbuilding-Run:` line), or the end. The block
  becomes `## <heading>\n\n<content trimmed>\n\n`. A missing section is inserted before the trailer block, else
  appended after one blank line. `###` and deeper headings inside `content` are kept as they are. A heading
  containing a newline throws `ConfigError("A PR section heading is one line.")`.
- `getPr`, `commentOnPr` and `updatePr` run inside a run only (else `NoActiveRunError`), use
  `ctx.config.git.pullRequests`, and throw `ConfigError` naming the fix when it or the needed member is missing
  ("Configure a git broker that can open PRs (githubApp or pat) to use sb.pr / commentOnPr"). Each is one journaled
  step (`kind: "step"`, call path label `pr.get` / `pr.comment` / `pr.update`), so a resume returns the recorded
  value and never repeats the write.
- `commentOnPr` passes `dedupeKey ?? "<runId>.<callPath>"` to the API, so a crash between the post and the journal
  write still posts once.
- `updatePr` with `section`: reads the PR (`get`), applies `replacePrSection` to `patch.body ?? current.body`, and
  writes `{ title?, body }`. Section edits to one PR are serialised within the process (one promise chain per
  `repo#number`), so `sb.parallel` branches editing different sections do not lose each other's edit. There is
  no cross-process guarantee (GitHub has no conditional PATCH); say so in the guide.
- Text from agents is posted as given: no redaction beyond what the run's event redactor applies to values that
  pass through `redactForRun` (call it on `body` before posting).

### 2.3 Script API

`sb.pr` crosses into the isolate (`packages/script/src/prelude.ts` and `runner.ts`):

| Member | Maps to | Counts toward |
|---|---|---|
| `sb.pr.get(pr)` | `getPr(pr)` | nothing |
| `sb.pr.comment({ pr, body, dedupeKey? })` | `commentOnPr(pr, body, { dedupeKey })` | `maxPrWrites` |
| `sb.pr.update({ pr, title?, body?, section?: { heading, content } })` | `updatePr(pr, { title, body, section })` | `maxPrWrites` |

- New cap `ScriptCaps.maxPrWrites` (default 20, already in `DEFAULT_SCRIPT_CAPS`, `caps.ts` and the input schema).
  The 21st write throws `ScriptLimitError { limit: "pr_writes" }` (the `ScriptLimit` member exists) before any
  request is sent. It does not count toward `maxAgentCalls`.
- Option checking follows the existing `#options` pattern: unknown keys, a non-string `body`, `heading` or
  `content`, or a `pr` that is not a string or an object with `url` or `repo` + `number` are `ScriptInvalidError`.
  A `PrTargetError` from core surfaces as `ScriptInvalidError` with its message.
- Calls are numbered at issue time like every other primitive, so callPaths stay stable on replay.

### 2.4 The worked example

`tests/live/task-lifecycle/lifecycle.mjs` uses `sb.pr` to keep the PR the record of the run:

1. After each review round, one comment with the merged findings (reviewer, severity, verdict, `file:line`,
   summary; findings to fix first, then carried ones), ending with the line
   `<!-- task-lifecycle-round:N stage:reviewed -->`.
2. After that round's fixes are pushed, one comment summarising the fix result, ending with
   `<!-- task-lifecycle-round:N stage:complete head:<sha> -->`, where `<sha>` is `(await sb.pr.get(pr)).headSha`
   read after `box.push()`.
3. The PR body keeps three sections, written with `sb.pr.update({ pr, section })`: `## What changed and why`
   (after the build, from the build result's summary and follow-ups), `## Verified` (after verification: one line
   per flow, `- <✅|❌> <flow>: <outcome>, <detail>`, then its evidence links), and `## Source` (the spec the run
   was given, as given, inside a fenced block, cut at 8,000 characters).
4. Without a PR (`build.artifacts.pr` absent) the script logs once and skips every `sb.pr` call.

Keep the diff to `lifecycle.mjs` small and additive: the owner edits this file in the main checkout during live
testing, and the two will be merged.

### 2.5 Tests (offline)

- `packages/channel-github/src/pulls.test.ts`: `get`, `update`, `comment` against the emulated GitHub
  (`@selfbuilding/testing` emulate, which serves `issues/{n}/comments`); dedupe finds an existing marker across two
  pages; error mapping.
- `packages/core/src/pr/pr.test.ts`: `parsePrTarget` (URL, ref object, repo + number, refusals);
  `replacePrSection` table (replace middle, replace last, insert before trailer, append, heading with trailing
  spaces, `###` kept); journaled replay posts once; crash between post and journal write posts once (dedupe);
  two parallel section edits both land.
- `packages/script/src/pr.test.ts`: the `sb.pr` members, option errors, `pr_writes` cap.
- `tests/acceptance/15-script-pr.test.ts`: a script on the scripted harness and tmpdir provider builds, opens a PR
  on emulated GitHub, posts the round markers and writes the three sections; a resume after a crash adds no
  comment.
- `tests/live/task-lifecycle` gets no new test; its README (docs builder) documents the markers.

---

## 3. Trigger.dev, deployed (trigger-deployed)

### 3.1 A result store every machine can reach

In `@selfbuilding/artifacts-s3` (`src/results.ts`, stubs present):

```ts
s3ResultStore(opts: S3ResultStoreOptions): ResultStore;   // S3ArtifactsOptions without urlTtl, prefix default "selfbuilding/results"
r2ResultStore(opts: R2ResultStoreOptions): ResultStore;
r2ResultStoreFromEnv(env, opts?: { bucket?; prefix?; fetch? }): ResultStore;  // same R2_* names as r2ArtifactsFromEnv
```

- Object key: `<prefix>/<key>` with each `/`-separated segment of the store key percent-encoded; `list(prefix)`
  decodes them back (ListObjectsV2, `prefix`, paginated with `continuation-token`).
- `createIfAbsent` → `PUT` with `If-None-Match: *`; 412 → `false`. `getVersioned` → `GET`, version = the `ETag`.
  `replace(key, v, null)` → `If-None-Match: *`; `replace(key, v, etag)` → `If-Match: <etag>`; 412 → `false`.
  404 on get → `null`. Bodies are JSON with `content-type: application/json`.
- Reuses the artifact store's signing (`aws4fetch`) and retry rules (network errors, 429, 5xx; full jitter). A 412
  is never retried. Exhausted retries → `ArtifactError` naming the bucket and status. A bucket that ignores
  conditional headers is caught by host-trigger's existing `probeConditionalWrites` → `ConfigError`.
- `createTriggerHost` refuses the local `fileResultStore` (and `memoryResultStore`) when a task runs in a deployed
  environment (`ctx.environment.type !== "DEVELOPMENT"` through the SDK seam in `sdk.ts`), with `ConfigError`: "A
  deployed Trigger.dev run needs a result store every machine can reach. Pass store: r2ResultStoreFromEnv(process.env)
  (or s3ResultStore) to createTriggerHost." `trigger.dev dev` keeps working with the file store.
- The live Trigger project (`tests/live/trigger/src/selfbuilding.ts`) uses `r2ResultStoreFromEnv(process.env)` when
  `R2_ACCOUNT_ID` is set, else the file store.

### 3.2 Known Trigger gaps from PR #2

1. **Calls on a shared handle.** Preferred: dispatch them as `selfbuilding.agent` child tasks with placement
   `{ kind: "handle", ref, version }` (already in `HostAgentCall`): the child attaches to the box by ref, runs the
   call, and returns the checkpoint; the parent's handle takes the new version, and the handle stays busy for the
   call's duration (`SandboxBusyError` rules unchanged). If the box state the parent handle keeps (git sync,
   checkpoint, lease) cannot cross the boundary safely, keep them in-process and make it explicit: one
   `log("info", "shared-handle call runs in the parent task: …")` per run, a paragraph in
   `packages/host-trigger/README.md`, and a test that pins the behaviour. Record the choice in
   `docs/decisions/0002-shared-handles-on-trigger.md`.
2. **Cold marker.** `resultStoreAsks(store)` implements `markCold` (CAS on `status = "open"`, as the file ask store
   does), so a Trigger restart reads `record.cold` exactly as plain Node does (demo-path §6).
3. **run-script in the live project.** `tests/live/trigger/src/selfbuilding.ts` registers
   `"run-script": createScriptFactory({ config })`; add `@selfbuilding/script` to that project's dependencies.
4. **afk on Trigger-launched runs.** `triggerWorkflowLauncher` puts `afk` into `FactoryTaskPayload` (new optional
   field `afk?: boolean` in host-trigger's own type) and the parent passes it to `run()` exactly as the node
   launcher does; `get_workflow_status` reports it.
5. **Redaction across child tasks.** The parent task registers with the run's redactor every secret value a child
   can be handed (harness credentials, provider API keys, declared `config.secrets` names, git tokens it mints),
   so `redactForRun` in the parent scrubs them, not only token shapes. Values are resolved on the orchestrator as
   today and never logged.
6. **Review finding: dispatched calls report no sandbox time** (`packages/core/src/agent/call.ts:160`): the child
   returns `sandboxMs` and `sandboxVcpuMs` in `RawOutcome.usage`, and the parent's `addUsage` sums them.
7. **Review finding: grants on Trigger stop at depth 2** (`packages/core/src/agent/start-grant.ts:204`): the child
   task receives the parent run's launch depth in `AgentTaskPayload` and mints the grant with it.
8. **Review finding: a failed waitpoint completion after an answer is only logged** (`packages/hooks/src/hitl.ts:214`):
   retry the completion with backoff (3 attempts), and give `wakeAnswered()` a production caller: the Trigger
   agent child re-reads the ask store after each `wait.forToken` timeout slice and wakes itself when it finds an
   answer, so a lost completion costs at most one slice.

### 3.3 Tests (offline)

- `packages/artifacts-s3/src/results.test.ts`: a fake S3 (`fetch` stub honouring `If-None-Match` / `If-Match`,
  ETags, pagination); the shared `ResultStore` behaviour cases the file and memory stores pass (move them into a
  reusable helper in `packages/host-trigger/src/store.test.ts` or copy the cases; do not import test files across
  packages); 412 never retried; 5xx retried then `ArtifactError`.
- `packages/host-trigger`: deployed-environment refusal of the file store; `markCold` CAS; afk payload; parent-side
  redaction of a child's credential; the shared-handle choice; usage sums.
- `tests/acceptance/16-trigger-deployed.test.ts`: acceptance 12 with `createLocalTrigger()` where the parent and
  each child get their own store instance over one fake S3 bucket (no shared memory), including a crash and resume
  of the parent and a cold ask.
- Live (written, gated, not run): `tests/live/15-trigger-deployed.test.ts` behind `SELFBUILDING_LIVE_TRIGGER=1`,
  `SELFBUILDING_LIVE_TRIGGER_DEPLOYED=1` and the `R2_*` keys, against a deployed `tests/live/trigger` project.

---

## 4. Templates without a registry (images-dockerfile)

### 4.1 Standalone Dockerfiles

In `@selfbuilding/images` (`src/standalone.ts`, stub present):

```ts
toStandaloneDockerfile(def: ImageDefinition, opts?: { version?: string; agentUid?: number; agentGid?: number }): string;
```

- Walks `def.from` to the root and emits one Dockerfile: `FROM <root base>`, then every ancestor's steps
  root-first, then `def`'s, with one `USER root` / `SHELL` preamble, the manifest of `def` (not an ancestor's), every
  ancestor's verify step kept as a `RUN`, and the final `WORKDIR` and `LABEL`. No `ARG`: `$AGENT_UID` and
  `$AGENT_GID` in commands are replaced by `opts.agentUid ?? 1000` and `opts.agentGid ?? 1000`.
- **ENV quoting (the known bug).** Vendor Dockerfile parsers keep quotes in `ENV` values (`ENV A="/x"` sets the
  literal `"/x"`). Both `toDockerfile` and `toStandaloneDockerfile` write `KEY=value` unquoted when the value matches
  `^[A-Za-z0-9_./:@%+,=-]*$`. Otherwise `toDockerfile` keeps the JSON-quoted form (real Docker reads it correctly)
  and `toStandaloneDockerfile` throws `ConfigError` naming the variable and the fix ("use a value without spaces,
  quotes, `$` or backslashes"). The official images' values are all safe; a test pins that.

### 4.2 Building from the Dockerfile

- `E2bTemplateDefinition` gains `dockerfile?: string` (sandbox-e2b's own type). `templateImageBuilder` sets it from
  `toStandaloneDockerfile(<official image for the harness>, { version })` when its `registry` option is unset, and
  leaves `fromImage` as it is when a registry is given (unchanged path).
- The E2B binding (`packages/sandbox-e2b/src/index.ts`) and the Impello binding (`packages/sandbox-impello/src/build.ts`)
  call the SDK's `Template().fromDockerfile(content)` when `def.dockerfile` is set, then the same
  `setUser` / `setWorkdir` / verify chain. Check the Impello SDK exposes `fromDockerfile`; if it does not, Impello
  refuses with `ImageUnavailableError` naming `SELFBUILDING_IMAGE_REGISTRY` as the fix.
- `selfbuilding images build --provider e2b|impello` therefore works with `SELFBUILDING_IMAGE_REGISTRY` unset. The
  CLI prints one line per build saying which path it took (`from Dockerfile` or `from <registry>/…`). Update
  `IMAGES_HELP`.

### 4.3 One template with both harnesses

- `ImageHarness` gains `"all-harnesses"` (done). New `allHarnessesImage` in `@selfbuilding/images`:
  `name: "selfbuilding-all-harnesses"`, from `baseImage`, Claude Code and Codex at their pinned versions, the browser
  steps (`browserSteps`), `binaries: ["/usr/local/bin/claude", "/usr/local/bin/codex"]`, `browser: BROWSER_MANIFEST`,
  final verify checks both binaries and the browser. Added to `officialImages` as `"all-harnesses"`
  (`selfbuilding/all-harnesses:<version>`), and `docker/all-harnesses/Dockerfile` generated like the others.
- `IMAGE_HARNESSES` stays `["claude-code", "codex"]`: `--harness all` keeps meaning "each harness, separately".
- CLI: `--all-harnesses` builds only the combined image or template unless `--harness` is also given (then both).
  `--harness all-harnesses` is the same thing. Template names follow the rule: `selfbuilding-all-harnesses`,
  `selfbuilding-all-harnesses-medium`. The sizes hint after a build names `template: "selfbuilding-all-harnesses"`.
- `e2bTemplate` knows `"selfbuilding-all-harnesses"` (both binaries in `binaries` and `verify`). Docker builds it
  once like the others.
- Do not edit `tests/live/task-lifecycle/selfbuilding.config.ts`; report in your summary that its single template
  (`selfbuilding-codex`) carries no Claude Code binary and should become `selfbuilding-all-harnesses` once built.

### 4.4 Tests (offline)

- `packages/images/src/standalone.test.ts`: one `FROM`, no `ARG`, steps in root-first order, uid/gid inlined, the
  manifest is the leaf's, unsafe ENV refused, the official images' ENV all unquoted; snapshot of the codex and
  all-harnesses output.
- `packages/images/src/index.test.ts`: `toDockerfile` writes safe ENV unquoted and unsafe ENV JSON-quoted.
- `packages/sandbox-e2b` and `packages/sandbox-impello` build tests: with no registry the fake SDK receives
  `fromDockerfile(<content>)`; with a registry, `fromImage` as before.
- `packages/cli/src/commands/images.test.ts`: `--all-harnesses`, `--harness all-harnesses`, the path line, and
  no registry no longer an error.
- Live (written, gated, not run): `tests/live/14-images-dockerfile.test.ts` behind `SELFBUILDING_LIVE=1` and
  `E2B_API_KEY` / `IMPELLO_API_KEY`, `SELFBUILDING_IMAGE_REGISTRY` unset.

---

## 5. Docs (docs)

Every option name, flag, env var and export in the docs is checked against the source on this branch. Features of
this batch that other builders are still writing (§1 to §4, §7) are documented from this file's signatures; list
each such statement in your final report so the integration pass re-checks it against the merged code.

| File | Content |
|---|---|
| `README.md` | What it is, in two sentences, led by "dynamic workflows with sandboxes, run locally or handed to Trigger.dev". A 5-minute quickstart: install, `selfbuilding init`, `selfbuilding doctor`, run a factory locally, the same factory on Trigger.dev. The primitives with one short example each: `agent` (inline and `Agent.fromSkill`), `pipeline`, `parallel`, `sandbox()` + `fork`, `ask`, sizes, workflow scripts + `start_workflow`. Links to the guides. Status line: pre-release. No badges that point at nothing. |
| `docs/guides/README.md` | Index of the guides, in reading order |
| `docs/guides/providers-impello.md`, `providers-e2b.md`, `providers-docker.md` | Setup per provider: account and key, templates (`selfbuilding images build`, with and without a registry, `--all-harnesses`), sizes, egress caveat (link `docs/decisions/0001-egress-enforcement.md`) |
| `docs/guides/harness-claude-code.md`, `harness-codex.md` | Claude Code: subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) and API key fallback; Codex: login file (`auth.json`, leased) and API key. The credential pool order, and that users are responsible for their plan's terms |
| `docs/guides/github-app.md` | Creating the GitHub App (permissions: contents, pull requests, issues, metadata), installing it, `githubApp()` options, the `pat()` fallback, branch protection for `selfbuilding/*` |
| `docs/guides/slack-app.md` | Creating the Slack app from `packages/channel-slack/slack-app-manifest.json`, the signing secret, the hooks handler URL, approvers |
| `docs/guides/trigger-dev.md` | `createTriggerHost`, `trigger.dev dev`, deploying, the shared result store (§3.1), what runs as child tasks (§3.2.1) |
| `docs/guides/artifacts-r2-s3.md` | `r2ArtifactsFromEnv`, `s3Artifacts`, signed URLs, a bucket lifecycle rule |
| `docs/guides/sizes-and-templates.md` | Presets, custom sizes, per-size templates, the typed refusal and its fix |
| `docs/guides/journals.md` | `fileJournal` default, `sqliteJournal` (§1), `selfbuilding journal import` |
| `docs/guides/writing-a-factory.md` | `factory`, agents, placement, budget, resume |
| `docs/guides/writing-a-workflow-script.md` | The script API (demo-path §8.2 plus `sb.pr`, §2.3), caps, determinism rules, `selfbuilding start`; correct the forking example (no `fork` inside `sb.parallel`: fork first, then run the thunks) |
| `docs/guides/verifying-flows.md` | `FindFlows`, `Verify`, `verifyFlows`, the four outcomes, evidence, the summary page |
| `docs/guides/agent-launched-workflows.md` | Exists; check it against the code, keep it |
| `tests/live/task-lifecycle/README.md` | The worked example: what each phase does, the PR markers and sections (§2.4), the config, the env vars it needs (names only), how to run it |
| `CONTRIBUTING.md` | pnpm only, `pnpm check` before a commit, module ownership, the error registry rule, offline-first tests and env-gated live tests, commit style |
| `SECURITY.md` | How to report a vulnerability privately (GitHub private vulnerability reporting), what is in scope (sandbox escape paths through Selfbuilding, secret handling, grant forgery), the 0600 secret-file model |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1, contact through the repository's private reporting channel (no personal email) |
| `docs/RELEASE-CHECKLIST.md` | License TODO (the owner decides; the scaffold `LICENSE` is MIT and `docs/LICENSING-TODO.md` lists the prompts to clear), rotate every credential used during development, git-history secret scan (`gitleaks detect --log-opts=--all` or equivalent) and `node scripts/check-public.mjs --strict`, untrack `.infisical.json`, flip `"private": true` off per package, publish images (`selfbuilding images build --provider docker` then push to the registry), npm publish order (§6.3), tag and release notes |

Also: correct `docs/spec/demo-path.md` §8.2's example the same way (fork before `sb.parallel`); fix
`docs/decisions/0001-egress-enforcement.md:58` only if the findings builder has not (coordinate through BUILD-MAP:
it is the findings builder's file); update `docs/ROADMAP.md` (tick what this batch finishes, keep the positioning
section low-key). Do not touch `docs/spec/selfbuilding-v1-spec.md`.

Tests: none of its own; `pnpm check` and `node scripts/check-public.mjs` must pass on its files.

---

## 6. CI and publish metadata (ci)

### 6.1 Workflow

`.github/workflows/ci.yml`:

- Triggers: `push` to `main`, `pull_request`. `permissions: contents: read`. `concurrency` cancels superseded runs
  per ref.
- Matrix `node: [22, 24]` on `ubuntu-latest`. Steps: checkout, `pnpm/action-setup` (version from `packageManager`),
  `actions/setup-node` with `cache: pnpm`, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm check`,
  `node scripts/check-public.mjs`.
- No secrets, no `env` that enables live or Docker tests. A job-level guard step fails if `SELFBUILDING_LIVE` or
  `SELFBUILDING_E2E_DOCKER` is set.
- Pin third-party actions to a major tag. No other workflows in this batch.

### 6.2 `scripts/check-public.mjs`

A dependency-free Node script (`scripts/` is outside the workspace). It reads `git ls-files` (never untracked or
ignored files, never `ref/`), skips binaries, and fails (exit 1, one line per hit: `path:line rule`) on:

| Rule | Pattern (case-insensitive unless noted) |
|---|---|
| `personal-path` | `/Users/<name>/`, `/home/<name>/` (except `/home/agent/`, the sandbox user) |
| `tailnet-host` | `\.ts\.net\b` with a hostname before it, and `tail[0-9a-f]{6}` |
| `slack-token` | `xox[abpr]-` followed by 10 or more token characters, unless the token contains `test`, `fake` or `example` |
| `anthropic-key` | `sk-ant-` followed by 20 or more token characters, same exemption |
| `impello-key` | `\bimp_[A-Za-z0-9]{16,}`, same exemption |
| `e2b-key` | `\be2b_[A-Za-z0-9]{16,}`, same exemption |
| `slack-id` | `\b[UCW]0[A-Z0-9]{8,10}\b` (case-sensitive) |
| `banned-name` | a word or word pair whose hash is in the built-in list (below) |

- Banned names must not appear in the tracked script either, not even encoded. The script holds only SHA-256
  hashes of the lowercased banned words and two-word phrases (the builder brief carries the list; the spec does
  not), hashes every word and adjacent word pair of each tracked text file, and reports a hit on a match. It also
  reads extra regexes, one per line, from the file named by `$SELFBUILDING_PUBLIC_DENYLIST` when set (an untracked
  local file for strings like account ids). Hits print the rule name and location, never the match.
- Exceptions: `scripts/check-public.allow`, one `path-glob<TAB>rule<TAB>reason` per line. Start it with only the
  entries the current tree needs (expected: `.infisical.json` until the owner untracks it; any test fixture whose
  fake token does not carry an exemption word). `--strict` ignores the allow file (release checklist).
- Make the current tree pass: fix the hits in tracked files outside test fixtures (known: the personal path in
  `docs/BASIC-SCOPE.md` line 49; replace it with "the owner's own implement skill"). Test fixtures with fake
  tokens are left alone if the exemption covers them; otherwise add them to the allow file with a reason.
- The script exports nothing and has a `--self-test` flag that runs its rule table against built-in positive and
  negative samples (vitest does not see `scripts/`); CI runs `node scripts/check-public.mjs --self-test` before the
  scan.

### 6.3 Package metadata and release order

- Every package under `packages/` gets, additively: `repository` (`{ "type": "git", "url":
  "git+https://github.com/ray-amjad/selfbuilding.git", "directory": "packages/<dir>" }`), `homepage`
  (`https://github.com/ray-amjad/selfbuilding/tree/main/packages/<dir>#readme`), `bugs`
  (`https://github.com/ray-amjad/selfbuilding/issues`), `publishConfig: { "access": "public", "provenance": true }`,
  `keywords` (a few, factual), and `files` checked to include `dist` plus anything the package reads at run time
  (skill folders, Dockerfiles, the Slack manifest, runtime bundles). `engines.node` stays `>=22.12`.
- `"private": true` stays on every package in this batch: flipping it is a release-checklist step for the owner.
  `tests/*` and `fixtures/*` packages stay private for good.
- Changesets: `.changeset/config.json` exists and `@changesets/cli` is already a dev dependency. Set `"access":
  "public"` there (the one allowed edit to that file). Add no new dependency and do not touch `pnpm-lock.yaml`. If
  anything would need a lockfile change, document instead.
- Document the publish order in `docs/RELEASE-CHECKLIST.md` (and `CONTRIBUTING.md`'s release section): the
  dependency order from the workspace graph, computed by the script `scripts/publish-order.mjs` (dependency-free;
  prints package names leaves first) rather than written by hand. Expected start: `@selfbuilding/skills`,
  `@selfbuilding/core`, then the packages that depend only on core, ending with `selfbuilding` (the CLI).
- Each package with a public entry gets a `README.md` of a few lines (what it is, install, a link to the guide) if it
  has none. The docs builder owns the content of guides; the ci builder owns these package READMEs.

### 6.4 Tests

`node scripts/check-public.mjs --self-test`, `node scripts/check-public.mjs`, `node scripts/publish-order.mjs`
exit 0 on the branch. `tests/acceptance/package-meta.test.ts` reads every `packages/*/package.json` and checks the metadata keys,
`files` includes `dist`, and that every path a package reads at run time is inside `files`.

---

## 7. Review findings and smaller gaps (findings)

Each item gets a regression test that fails before the fix. The Trigger-specific findings (dispatched sandbox time,
grant depth on Trigger, waitpoint completion) are §3.2 items 6 to 8, and the two script-layer gaps go to script-pr
(§7.3), so each package keeps one owner.

### 7.1 The low-severity review findings from PR #2

| # | Where | Fix |
|---|---|---|
| 1 | `packages/hooks/src/start-workflow.ts:100` | `get_workflow_status` reads a run only when `status.launchedBy` is an agent caller with the grant's `runId`; runs launched locally or with no `launchedBy` are 404 for every grant |
| 2 | `packages/hooks/src/start-workflow.ts:123` | When a record exists for the derived run id, return its receipt (`status: "exists"`) without calling `launcher.start` again and without applying the new request's size, sandboxes or script; `triggerWorkflowLauncher` is never re-triggered |
| 3 | `packages/sandbox-e2b/src/provider.ts:529` | A probe that could not run (429, timeout, connect error, the probe's own exit code) is not a leak: retry it with backoff up to 3 times, then fail the create with `SandboxUnavailableError` (retryable) and kill only a box this call created, never one `openOrCreate` converged onto |
| 4 | `packages/sandbox-e2b/src/provider.ts:515` | Pick the probe target by coverage: parse the allowlist into hostnames, IPs and CIDRs and choose the first probe address no entry covers (exact host, IP equality, CIDR containment); `8.8.8.80` no longer skips `8.8.8.8` |
| 5 | `docs/decisions/0001-egress-enforcement.md:58` | Say `verifyEgress` is accepted by `e2b()`, `impello()` and `createE2bShapeProvider` |
| 6 | `docs/spec/demo-path.md` §8.2 | The example forks inside `sb.parallel`, which core refuses: fork before `sb.parallel` (the docs builder fixes the guide copy; this builder fixes the spec text) |

### 7.2 Smaller known gaps

1. **verifyFlows Slack summary shows raw Markdown** (`packages/agents/src/flows/summary.ts`, `verify-flows.ts`): post
   `renderRunSummary(...).slack` (mrkdwn: `*bold*`, `<url|text>` links, no `#` headings or `[text](url)`) instead
   of the Markdown body.
2. **AFK summary not posted**: in AFK mode verifyFlows still posts the summary as a `notify()` FYI (AFK means no
   human answers asks, not silence).
3. **Redundant evidence copy**: verifyFlows stops reading evidence off the fork when the runtime already collected
   it into the attempt (`/selfbuilding/out/files`); it reads only files the attempt did not collect (failed calls).
4. **`nodeWorkflowLauncher` not exported publicly**: add a `./launcher` entry to `packages/cli/package.json`
   `exports` (and `tsup.config.ts`) exporting `nodeWorkflowLauncher`, `NodeWorkflowLauncherOptions`; keep the bin.
5. **Leased `auth.json` read back as root, following symlinks** (`returnLeasedFile` in
   `packages/core/src/agent/lifecycle.ts`, hunk): read it with a command that refuses a symlink or non-regular file
   (`test -f "$p" && test ! -L "$p"`, then read as the agent user), capped at 64 KiB; a refused copy is dropped with
   a `warn` event and the original stays in the pool.
6. **No acceptance test for `ContractDefaults.size`**: `tests/acceptance/17-contract-size.test.ts`: an agent whose
   contract sets `defaults.size: "medium"` gets a medium box on tmpdir; a call option overrides it; a provider that
   cannot give it refuses with `SizeUnavailableError` naming the fix.
7. **Shared-handle box time missing from `sandboxVcpuMs`** (`lifecycle.ts` usage hunk around `sandboxVcpuMs`): calls on
   a shared handle add `sandboxMs × handle vCPU` for the call's duration, using the handle's size.
8. **Verify's browser server copy unchecked** against `@selfbuilding/images`: a test that the `BROWSER_MCP_SERVER`
   Verify uses deep-equals the one `@selfbuilding/images` exports.
9. **Load flake**: `packages/script/src/caps.test.ts` "memory: an allocation past memoryBytes" takes about 5.8 s
   under a full parallel run and hits the 5 s default timeout (seen on this branch). script-pr gives it an explicit
   timeout (§7.3).

### 7.3 Moved to script-pr (it owns `packages/script`)

- The script layer counts live `sb.sandbox()` boxes itself: `sandbox.create` checks live handles + 1 against
  `maxSandboxes` (and `fork(n)` checks live + n) and throws `ScriptLimitError { limit: "sandboxes" }`; dispose
  frees a slot.
- `sb.sandbox()` with no size is checked: it resolves to the provider's default size and that size must be in
  `allowedSizes`, else `ScriptLimitError { limit: "size" }`.
- The caps memory test gets `{ timeout: 20_000 }`.

---

## 8. Shared additions already on the branch

| File | Addition |
|---|---|
| `packages/core/src/types/security.ts` | `PullRequestInfo`, `PullRequestComment`, `PullRequestPatch`, `PrSection`, `PrUpdate`, `PrTarget`; optional `get`, `update`, `comment` on `PullRequestApi` |
| `packages/core/src/types/workflow.ts` | `ScriptCaps.maxPrWrites` |
| `packages/core/src/types/orchestration.ts` | `SqliteJournalOptions` |
| `packages/core/src/types/sizes.ts` | `ImageHarness` member `"all-harnesses"` |
| `packages/core/src/errors/*` | `PrTargetError` (`pr_target`, usage, not retryable, registry row `release-prep §2.2`); `ScriptLimit` member `"pr_writes"` |
| `packages/core/src/index.ts` | `sqliteJournal`, `parsePrTarget`, `replacePrSection`, `getPr`, `commentOnPr`, `updatePr` and the new types |
| `packages/core/src/journal/sqlite-journal.ts`, `packages/core/src/pr/index.ts` | stubs (`packages/core/src/not-implemented.ts`) |
| `packages/script/src/{index,caps}.ts` | `maxPrWrites: 20` in `DEFAULT_SCRIPT_CAPS`, the caps key list and the input schema |
| `packages/images/src/standalone.ts` | `toStandaloneDockerfile`, `StandaloneDockerfileOptions` stub, exported from the index |
| `packages/artifacts-s3/src/results.ts` | `s3ResultStore`, `r2ResultStore`, `r2ResultStoreFromEnv` and their option types, stubs, exported |
| `tests/live/task-lifecycle/*` | `biome check --write` formatting only, so `pnpm check` passes on the branch |

## 9. Cross-builder rules for this batch

- **Shared files are add-only**: `packages/core/src/types/**`, `packages/core/src/index.ts`, every `package.json`,
  `tsconfig*.json`, `biome.json`, `vitest.config.ts`, `CONTEXT.md`, `docs/BUILD-MAP.md`. Exceptions named above:
  ci sets `.changeset/config.json` `access`; ci adds metadata keys to every `package.json`; findings adds the
  `./launcher` export to `packages/cli/package.json`; trigger-deployed adds `@selfbuilding/script` to
  `tests/live/trigger/package.json`.
- **Hot files** (edit only your hunk): `packages/core/src/agent/lifecycle.ts` (findings: `returnLeasedFile` and the
  `sandboxVcpuMs` usage lines; trigger-deployed: the dispatch branch), `packages/core/src/agent/call.ts`
  (trigger-deployed only), `packages/cli/src/main.ts` (sqlite-journal: the `journal` command entry and help line),
  `packages/cli/src/templates.ts` (sqlite-journal: the journal comment and `.gitignore` line),
  `tests/acceptance/support/crash-scenarios.ts` (sqlite-journal: the optional `journal` field),
  `tests/live/README.md` (each builder its own rows), `docs/ROADMAP.md` (docs only).
- **Numbering.** Acceptance: 14 sqlite-journal, 15 script-pr, 16 trigger-deployed, 17 contract-size (findings).
  Live: 14 images-dockerfile, 15 trigger-deployed. Live helpers in `tests/live/support/<builder>.ts`.
- **New tests go in new files** unless this file names an existing one.
- **Offline first.** No network, Docker, R2, Trigger.dev, E2B or Impello in any test that runs by default.
- **Secrets.** No new variables besides `SELFBUILDING_LIVE_TRIGGER_DEPLOYED` (live 15) and
  `SELFBUILDING_PUBLIC_DENYLIST` (the scan). Names only in docs; never a value.
- **Public tree.** Run `node scripts/check-public.mjs` (once ci lands it) on your files before you finish.
- Run `pnpm build` and `pnpm check` before every commit. Commit messages end with the two attribution lines from
  `AGENTS.md`'s commit rule as given in the batch brief. Never push.
