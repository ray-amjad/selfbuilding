# The demo path: contracts for the parallel build

Date: 2026-11-02. Branch `build/demo-path`. This file fixes every name, shape and rule the twelve builders of
this batch share, so they can work without talking. Where it and `docs/spec/selfbuilding-v1-spec.md` disagree,
this file wins for the features below; `docs/BASIC-SCOPE.md` still wins for everything else.

The shared public types already exist on the branch (`packages/core/src/types/sizes.ts`, `workflow.ts`, and
additive fields elsewhere). Stubs throw `NotImplementedError` through each package's `not-implemented.ts`.
Ownership is in `docs/BUILD-MAP.md` §6. Section numbers below are referenced from code comments
(`demo-path §1.3`); keep them stable.

Owner decisions (final): named size presets; a size a provider cannot give fails with a typed error naming the fix
(no fallback, no build on demand); the Verify demo app is a small Next.js app with a form and a database; evidence
goes to Cloudflare R2; agent-written scripts run in a QuickJS (WASM) isolate that exposes only the primitives;
agent-launched runs are guarded by caps on concurrent sandboxes and allowed sizes; lead with durable sandboxed
runs, never market skills-as-functions.

---

## 1. Machine sizes (sizes-core, sizes-providers)

### 1.1 Config

```ts
import { BUILT_IN_SIZES } from "@selfbuilding/core"; // small {2, 4096}, medium {4, 8192}, large {8, 16384}

defineConfig({
  sizes: { xlarge: { vcpu: 16, memoryMiB: 32768 }, "big-disk": { vcpu: 4, memoryMiB: 8192, diskGiB: 100 } },
});
```

- `SelfbuildingConfig.sizes?: SizeTable` adds names. The table a run uses is `BUILT_IN_SIZES` merged with it
  (`sizeTable(config)`).
- Redefining `small`, `medium` or `large` with different numbers throws `ConfigError` at `defineConfig`/`loadConfig`
  time (templates are built and named per preset, so the numbers must never drift). Repeating identical numbers is
  allowed.
- Names match `SIZE_NAME_PATTERN` (`^[a-z][a-z0-9-]{0,23}$`); `vcpu` and `memoryMiB` are positive integers;
  otherwise `ConfigError`.

### 1.2 Calls and precedence

| Where | Option | Applies to |
|---|---|---|
| `agent()`, `X(input, opts)` | `AgentCallOptions.size` | a **fresh** box only. With a shared handle or a fork the box already exists, so the option is ignored (and a `log` warning is emitted once per callPath when it differs from the box's size). |
| Contract | `ContractDefaults.size` | fresh boxes of that agent |
| `factory({ defaults: { size } })` | `FactoryOptions.defaults.size` | every fresh box and every `sandbox()` handle in the factory |
| `sandbox({ size })` | `SandboxOptions.size` | that handle's box |
| `handle.fork(n, { size })` | fork option | the children; default: the parent's size |

Precedence for a fresh agent box: call `size` > contract default > factory default > none. **None** means
`SandboxSpec.size` is absent and the provider default is used (exactly today's behaviour; on template providers the
unsuffixed template is `small`). Nothing in core defaults a size when nobody asked for one.

Resolution happens at box creation, in this order, before a concurrency slot is taken:
1. `resolveSize(config, name)`: unknown name → `SizeUnknownError` (usage: throws through `.settled()` and
   `parallel()`).
2. `checkSize(provider, size, { fork?, baseTemplate? })` against `provider.sizing` (pure; no vendor call):
   refusal → emit `sandbox.size_refused`, throw `SizeUnavailableError` (agent kind: `parallel()` yields `null`,
   `.settled()` yields `{ ok: false, code: "size_unavailable" }`).
3. `SandboxSpec.size` = the `ResolvedSize`, `SandboxSpec.resources` = the same numbers, label `selfbuilding.size`.

The seam is already wired: `sandboxSpecFor(ctx, { provider, size })` in `packages/core/src/sandbox/spec.ts` calls
`sizeForSpec()` in `packages/core/src/sizes/index.ts`, which returns `undefined` when no size was asked for. The
fresh-box call site in `lifecycle.ts` passes `plan.size`. `CallPlan.size` comes from `resolvePlan` in `plan.ts`.
sizes-core implements `sizeTable`, `resolveSize`, `checkSize`, `sizeForSpec`, and the handle and fork paths in
`handle.ts`.

### 1.3 Provider sizing capability

`SandboxProvider.sizing?: ProviderSizing` (types in `packages/core/src/types/sizes.ts`):

- `{ kind: "template", forkSize: "inherit", resize: false, available, limits, templateFor(base, size) }`:
  E2B and Impello. Size is fixed per template at build (`Template.build` `cpuCount`, `memoryMB`, `minFreeDiskMb`);
  `Sandbox.create` takes no size; fork children inherit; no resize. `available` lists the size names whose template
  the user built, from the provider option `sizes` (default `["small"]`).
- `{ kind: "create" | "start", forkSize: "inherit" | "override", resize, limits }`: Docker (`create`, `override`:
  a fork commits a snapshot image and starts a new container at any size; `resize: false`), the tmpdir test
  provider (`create`, `override`, no limits; it records the size and enforces nothing). Future: Daytona (`create`
  from an image, `inherit`, `resize: true`), Vercel Sandbox (`create`, `override`, `memoryPerVcpuMiB: 2048`),
  Modal (`create`, no fork), Cloudflare (`start`).
- No `sizing` at all: the provider takes no sizes; any requested size is refused with `not-sizable`.

`checkSize` rules, first match wins:

| Condition | Reason | Fix text (exact form, names filled in) |
|---|---|---|
| provider has no `sizing` | `not-sizable` | `Provider "<id>" takes no sizes. Drop the size option, or run this call on a provider that sizes boxes (docker, e2b, impello).` |
| fork child, `forkSize: "inherit"`, size ≠ parent's | `fork-inherits` | `Forks on "<id>" keep the parent's size (<parent>). Create the parent at "<size>", or run this call on a fresh box.` |
| `vcpu > limits.maxVcpu` or `memoryMiB > limits.maxMemoryMiB` or disk over | `over-limit` | provider-specific, see below |
| `vcpuChoices` misses it, or memory ≠ `vcpu × memoryPerVcpuMiB` | `invalid-shape` | `"<id>" offers <choices>. Define a size with one of them in the config's sizes table.` |
| template kind, size not in `available` | `not-built` | `Build it: selfbuilding images build --provider <id> --harness <harness|all> --size <size>, then add "<size>" to <id>({ sizes }).` |

Limits per provider value:

| Provider | `limits` | Over-limit fix |
|---|---|---|
| `e2b({ plan: "hobby" })` (default) | `maxVcpu: 8, maxMemoryMiB: 8192` | `E2B Hobby allows 8 vCPU and 8 GiB per sandbox. Use medium, upgrade the plan and pass e2b({ plan: "pro" }), or run this size on Docker.` |
| `e2b({ plan: "pro" })` | `maxVcpu: 8` (memory unset until verified) | as above, naming the pro limit |
| `impello()` | `maxVcpu: 4` (no 8 vCPU pool yet) | `Impello has no 8 vCPU pool yet. Use medium, or run this size on Docker or E2B.` |
| `docker()` | unset; option `maxVcpu?`/`maxMemoryMiB?` | `Docker host limit set in docker({ maxVcpu, maxMemoryMiB }).` |

Provider options added (sizes-providers): `e2b({ sizes?: string[]; plan?: "hobby" | "pro"; sizeLimits?: SizeLimits })`,
`impello({ sizes?: string[]; sizeLimits?: SizeLimits })`, `docker({ maxVcpu?: number; maxMemoryMiB?: number })`.
`templateSizing({ available, limits })` in `packages/sandbox-e2b/src/sizes.ts` builds the template descriptor;
`createE2bShapeProvider({ sizing })` already accepts it and `#templateFor(image, spec.size)` already calls
`sizing.templateFor` (wired in `provider.ts`). Docker reads `spec.size ?? spec.resources` at create (it already
honours `resources`). A provider that receives a size it cannot give anyway (defence in depth) throws
`SizeUnavailableError`; it never silently creates another size.

### 1.4 Template and image naming per size

- `templateFor(base, "small") === base` (the existing `selfbuilding-claude-code` / `selfbuilding-codex` templates are
  2 vCPU / 4 GiB and stay valid).
- Any other size: `${base}-${size}`, e.g. `selfbuilding-codex-medium`, `selfbuilding-claude-code-large`,
  `selfbuilding-codex-xlarge`.
- Docker images are not per size (`selfbuilding/<harness>:<version>`); Docker sizes at create.
- `ImageBuilder.nameFor(harness, size)` must equal `sizing.templateFor("selfbuilding-" + harness, size)`.

### 1.5 Errors

| Class | Code | Kind | Retryable | Fields |
|---|---|---|---|---|
| `SizeUnknownError` (extends `ConfigError`) | `size_unknown` | usage | no | `size`, `known[]` |
| `SizeUnavailableError` | `size_unavailable` | agent | no | `provider`, `size`, `vcpu`, `memoryMiB`, `reason: SizeRefusal`, `fix` |

Both are registered (`registry.ts`). The message always ends with the `fix` sentence.

### 1.6 Events, labels, journal, usage

- Label `selfbuilding.size=<name>` (`SELFBUILDING_LABELS.size`) on every sized box; providers read it back into
  `SandboxRef.size`.
- `sandbox.created` event `data` gains `size?`, `vcpu?`, `memoryMiB?`, `template?` (template providers).
- New event `sandbox.size_refused` (level `error`) with `data: { provider, size, vcpu, memoryMiB, reason, fix }`,
  emitted once before the throw.
- `JournalEntry.sandbox.size?: string` on agent and sandbox entries, so a resume recreates a box at the same size.
- `Usage.sandboxVcpuMs?`: `sandboxMs` weighted by the box's vCPU, summed like `sandboxMs`; absent when no box in
  the call had a known size.

---

## 2. `selfbuilding images build` (sizes-providers)

```
selfbuilding images build --provider <docker|e2b|impello> [--provider …] [--harness claude-code|codex|all]
                          [--size <name>|all] [--size …] [--tag <version>] [--dry-run] [--json]
                          [--config <path>] [--env-file <path>]
```

- Defaults: `--harness all`, `--size small`, `--tag` = the selfbuilding version (`IMAGE_VERSION`). `--size all` means
  every name in the size table.
- Credentials: `E2B_API_KEY`, `IMPELLO_API_KEY` read from the environment (after `--env-file`), passed to the
  builder as options, never printed. A missing key fails that provider with `MissingSecretError` naming the variable.
- Each provider package exports one builder factory returning core's `ImageBuilder`:
  `dockerImageBuilder({ socketPath? })` (sandbox-docker), `e2bImageBuilder({ apiKey, plan? })` (sandbox-e2b),
  `impelloImageBuilder({ apiKey })` (sandbox-impello). The CLI imports them dynamically (they are dependencies of
  the CLI package already).
- Before any build, every (provider, harness, size) is checked with `checkSize` against `builder.sizing.limits`
  (availability is ignored: building makes it available). A refusal is printed with its fix and the pair is skipped;
  the rest still build. Docker builds once per harness and prints `docker sizes at create; built once`.
- Template builds start from the published OCI image (`e2bTemplate()` in `templates.ts`) with `cpuCount = vcpu`,
  `memoryMB = memoryMiB`, and `minFreeDiskMb = diskGiB × 1024` when the size sets a disk. Tags: version, date,
  `default` (moved only after a successful build).
- Builds run one at a time per provider (vendor rate limits); providers run one after another.
- Output, one line per pair: `ok   e2b      codex        medium  selfbuilding-codex-medium  4 vCPU 8192 MiB  312s`
  or `fail impello  codex        large   selfbuilding-codex-large   size_unavailable: <message>`. `--json` prints one
  `ImageBuildResult` per line.
- Exit codes: 0 all built (or all dry-run), 1 any build failed or was refused, 2 usage/config error.
- After a build the CLI prints the provider option to add, e.g. `Add "medium" to e2b({ sizes })`.
- Replaces the hand-run template script; the live suite's README points at it.

---

## 3. Browser in the Codex image (browser-image)

What Verify (and any Codex call) can rely on in `selfbuilding-codex` images and templates of every size:

| Thing | Contract |
|---|---|
| Browser | Chromium installed by Playwright with its OS dependencies, at `PLAYWRIGHT_BROWSERS_PATH=/opt/selfbuilding/browsers` (root-owned, world-readable) |
| Playwright | `playwright@<PLAYWRIGHT_VERSION>` installed globally; `NODE_PATH=/usr/local/lib/node_modules`, so `node -e 'require("playwright")'` and `import("playwright")` from a script under `/selfbuilding/out` work |
| Browser MCP server | `@playwright/mcp@<PLAYWRIGHT_MCP_VERSION>` at `/usr/local/bin/playwright-mcp` (absolute path, like harness binaries) |
| DB inspection | the `sqlite3` CLI (Debian package) |
| Pins | `PLAYWRIGHT_VERSION` and `PLAYWRIGHT_MCP_VERSION` exported from `@selfbuilding/images` (next to `HARNESS_VERSIONS`) |
| Manifest | `/opt/selfbuilding/image-manifest.json` gains `browser: { engine: "chromium", playwright, mcp: "/usr/local/bin/playwright-mcp", browsersPath }` |
| Verify step | the image's final verify runs `playwright-mcp --version` and launches headless Chromium once (`chromium.launch()` then close) as the agent user |
| Agent user | Chromium runs headless as the agent user. `--no-sandbox` is passed only in `BROWSER_MCP_SERVER` args (and by scripts that launch Chromium themselves), never set image-wide |
| Exported value | `BROWSER_MCP_SERVER: McpServerSpec` from `@selfbuilding/images`: `{ name: "browser", type: "stdio", command: "/usr/local/bin/playwright-mcp", args: ["--headless", "--isolated", "--browser", "chromium", "--no-sandbox", "--output-dir", "/selfbuilding/out/files/verify"] }` |

The browser lives in `packages/images/src/browser.ts` (steps and pins) and is added to `codexImage` and
`docker/codex/Dockerfile`. Image size grows; Verify runs at `medium` (§4.2). The Claude Code image does not get a
browser in this batch.

A call adds the server with `AgentCallOptions.mcpServers` or `ContractDefaults.mcpServers` (wired: `lifecycle.ts`
appends them after the `selfbuilding` server, which cannot be shadowed). Harness adapters already render every
server in `PrepareContext.mcpServers`.

---

## 4. Verify for a real web app

### 4.1 The playground web app (playground-web)

- **Source of truth:** `fixtures/playground-web/` in this repo (outside the pnpm workspace, so it never joins the
  lockfile; install it with `pnpm install --ignore-workspace` inside the folder). Biome ignores its `.next/`.
- **Published to** `github.com/ray-amjad/selfbuilding-playground` by `fixtures/playground-web/publish.mjs` (run by
  hand with a push token from the environment; never from a test). It writes the app under `web/`, keeping the
  existing root files (`src/math.js` etc., used by the review fixture).
- **Branches:**
  - `main`: `web/` app; `.selfbuilding/verify/README.md` at the repo root; the new-flow spec
    `docs/specs/web-mark-done.md`.
  - `fixture/web-broken-add`: `main` plus one planted bug (below). Env override in the live suite:
    `SELFBUILDING_PLAYGROUND_WEB_BROKEN` (default `fixture/web-broken-add`).
- **App:** Next.js (App Router, TypeScript), one page "Notes":
  - `/` lists notes newest first and has a form "Add note" (`title` required, ≤ 80 chars; `body` ≤ 2000).
    Submitting runs a server action that inserts a row and redirects to `/?added=<id>`, which shows a flash
    "Note added" and the note in the list.
  - Database: SQLite through Node's built-in `node:sqlite` (no native dependency). File path from
    `DATABASE_PATH` (default `./data/app.db`). Migrations run on boot. Table
    `notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`.
  - Scripts (in `web/package.json`): `dev` = `next dev -H 0.0.0.0 -p ${PORT:-3000}`, `db:reset` (delete and
    migrate), `db:seed` (three notes), `test` (`node --test` over the db module; no browser).
  - Readiness: `GET /api/health` → `200 {"ok":true,"db":"ok"}` once the database answers.
  - Selectors: `data-testid` = `note-form`, `note-title`, `note-body`, `note-submit`, `note-list`, `note-item`,
    `flash`, and (after the spec is built) `note-done-button`, `note-done`.
- **Planted bug** (`fixture/web-broken-add`): the action redirects with the flash and the page renders the submitted
  note from the redirect's query string, but the insert is never committed. A screenshot looks right; the checker
  reading the database finds no row. Verify must return `broken` for "add a note".
- **New-flow spec** `docs/specs/web-mark-done.md`: each note gets a "Mark done" button; clicking it sets `done = 1`,
  the note renders struck through with `data-testid="note-done"`, and the state survives a reload. findFlows should
  return "mark a note done" (new) and "add a note" (regression).
- **`.selfbuilding/verify/README.md`** (the project facts Verify reads first): app dir `web/`, install
  `pnpm install --frozen-lockfile`, boot `DATABASE_PATH=<fresh file> pnpm dev`, port 3000, readiness URL, reset and
  seed commands, selectors, and the DB probe (`sqlite3 "$DATABASE_PATH" 'select … from notes'`).

### 4.2 Verify, ready for a real app (verify-agent)

Input and output schemas stay as they are, plus the optional `VerifyFlowResult.evidenceFiles` (already added).

- **Placement:** `verifyContract.defaults` gains `size: "medium"` and `mcpServers: [BROWSER_MCP_SERVER]`, harness
  Codex. The size applies only to fresh boxes; on a fork or a handle the box's size wins (§1.2).
- **Roles** (unchanged names, now runnable): setup boots the app on a fresh database
  (`DATABASE_PATH=/tmp/verify-<slug>.db`, reset, migrate, seed), detached, with a bounded wait on the readiness URL;
  the verifier drives the flow only through the `browser` MCP tools (no curl, no SQL, no scripts); the checker reads
  the database with `sqlite3`, the server log and the evidence, and writes the verdict. The checker may lower the
  verifier's claim, never raise it.
- **Evidence layout**, per flow, `slug` = name lowercased, runs of non `[a-z0-9]` → `-`, trimmed, ≤ 48 chars:

  ```
  /selfbuilding/out/files/verify/<slug>/
    setup.json        setup's facts (db path, url, seeded ids)
    claim.json        the verifier's claim
    verdict.json      the checker's verdict
    evidence.md       THE evidence file (VerifyFlowResult.evidence): steps, what was seen, links to the files below
    screenshots/NN-<step>.png
    db.txt            the checker's queries and rows
    server.log        last 64 KiB of the dev server log
    trace.zip         optional
  ```

  `evidenceFiles` lists every file above except `evidence.md`. Everything under `/selfbuilding/out/files/` is
  collected into `Artifacts.files` by the existing settle step and stored in the run's ArtifactStore (R2 in the demo).
- **Outcomes:** `verified` (the end state is visible to the user and the rows exist), `broken` (the app booted but
  the flow fails or the rows are wrong), `could_not_boot` (no readiness within 5 min, log attached), `unverifiable`
  (no runnable surface, or a dependency the shim ladder cannot fake).
- **Live:** `tests/live/9-verify-web.test.ts`: Verify on `main` for "add a note" → `verified`; on
  `fixture/web-broken-add` → `broken`.

### 4.3 findFlows and verifyFlows (verify-flows)

`@selfbuilding/agents` exports (schemas already on the branch in `src/flows/schemas.ts`):

- `FindFlows: Agent<FindFlowsInput, FindFlowsResult>`: skill `packages/agents/skills/find-flows/`, contract
  `findFlowsContract` with `workspace.target: "review"` (it reads the diff at `/selfbuilding/in/diff.patch`), read-only,
  default harness Claude Code. Returns at most `maxFlows` (default 6) `FoundFlow`s: new flows first, then changed,
  then the nearest regression. `noRunnableSurface: true` with an empty list for diffs with nothing to run.
- `createVerifyFlows(opts: VerifyFlowsOptions)` and a default `verifyFlows` value (Claude Code builder, Codex
  verifier). The factory, named `verify-flows`:

  ```
  build    = sandbox({ label: "build", size: builder.size ?? "medium" })
  impl     = ImplementSpec(spec, { sandbox: build })                       → stop with build_incomplete unless done
  [rv, ff] = parallel([ CodeReview on build.fork(1), FindFlows on build.fork(1) ])   // forks: one per call
  flows    = input.flows ?? ff.result.flows (sliced to maxFlows)            → stop with no_flows when empty
  verdicts = pipeline(flows, { key: slug }, (flow) => Verify({ change, flows: [flow] }, { sandbox: <own fork of build> }))
  summary  = renderRunSummary(...); stored; posted; written into the PR
  ```

  A failed review or findFlows call does not stop the run (`.settled()`); a failed Verify call becomes a
  `FlowVerdict` with `outcome: "unverifiable"` and `error`. Every Verify runs on its own fork of the build box, so
  forks inherit the build box's size (`medium` by default, which the Verify defaults expect).
- Output `VerifyFlowsOutput.status`: `all_verified` (≥ 1 flow, all `verified`), `some_failed`, `no_flows`,
  `build_incomplete`.

### 4.4 The summary page (verify-flows)

`renderRunSummary(input: RunSummaryInput): { markdown, html }`, pure and deterministic (`generatedAt` is passed in).

- **Markdown** (Slack and PR body):

  ```
  ## Verification
  Run `<runId>` · branch `<branch>` · PR #<n>
  | | Flow | Kind | Outcome | Evidence |
  |---|---|---|---|---|
  | ✅ | add a note | regression | verified | [evidence](<url>) · [screenshots](<url>) |
  | ❌ | mark a note done | new | broken | [evidence](<url>) |
  Review: request_changes, 3 findings.
  ```

  ✅ only for `verified`, ❌ for `broken`, ⚠️ for `could_not_boot` and `unverifiable`. Links come from
  `input.links` (uri → signed URL); without one the uri is shown as code.
- **HTML**: one self-contained page (inline CSS, no script, no external fetch): header, the same table, then per flow
  its detail, `evidence.md` rendered as preformatted text, and screenshots embedded as data URIs when each is
  ≤ 512 KiB (others linked); the whole page ≤ 8 MiB. Stored with
  `artifacts.put("runs/<runId>/summary.html", html, { contentType: "text/html; charset=utf-8" })`.
- **Posting:** one notify message to the run's notify channels (Slack) with the Markdown table and a signed link to
  the HTML page (`expiresIn: "7d"`); the PR body section `## Verification` is replaced with
  `replaceSection(body, "Verification", markdown)` through `pullRequests` when given. Signed URLs are made at post
  time and never journaled.

---

## 5. Trigger: agent calls as child tasks (trigger-children)

- **core** exports `agentCallDriver(deps: AgentCallDriverDeps): AgentCallDriver` (new file
  `packages/core/src/agent/driver.ts`), the serialisable launch/registerWake/probe/collect/stop/interrupted/ask steps
  the host-trigger child already calls. The host looks it up by that export name.
- **core**'s agent call path honours `ctx.host.dispatchAgent`: when present, the call is serialised into
  `HostAgentCall` (`spec` is core-owned JSON: agent `{ kind: "skill", name, hash } | { kind: "inline", name, prompt,
  outputJsonSchema }`, the parsed input, the plan's serialisable fields including `size`, `mcpServers`, harness
  `{ id, options }`, provider id, placement `{ kind: "fresh" } | { kind: "handle", ref, version }`), dispatched,
  and accept (closures: `assert` checks, PR opening, journal) runs in the parent on the returned `RawOutcome`.
- **Mapping:** each agent call → one `selfbuilding.agent` child run, idempotency key
  `ns:<runId>:<stepKey>:e<epoch>` (global scope), payload `AgentTaskPayload`. The child runs launch → (register wake
  → `wait.forToken` → probe)* → collect, handles hot asks on the ask's own token, and stores the `RawOutcome` under
  `runs/<runId>/e<epoch>/outcomes/<stepKey>` before returning. The parent never blocks on a child; the scheduler
  holds the run's one wait (README of host-trigger).
- **Rebuilding values in the child:** providers and harnesses are resolved by id from
  `createTriggerHost({ registry?: { providers?: SandboxProvider[]; harnesses?: Harness[] } })` plus the config's
  defaults. An unknown id fails with `ConfigError` naming the missing registration. Agents are resolved by skill
  name from the deployed factories' agents (`createTriggerHost({ agents? })`); a hash mismatch is
  `NonDeterminismError`.
- **Live:** a real Trigger.dev project under `tests/live/trigger/` (`trigger.config.ts`, tasks from
  `createTriggerHost`), deployed by hand; `tests/live/7-trigger.test.ts` gated by `SELFBUILDING_LIVE_TRIGGER=1`,
  `TRIGGER_SECRET_KEY`, `TRIGGER_PROJECT_REF`. Offline: `tests/acceptance/12-trigger-children.test.ts` with
  `createLocalTrigger()`.

---

## 6. Cold waits that survive a host restart (cold-restart)

Persistence model: **the ask store is the only truth; nothing about an answer lives only in memory.**

1. When a hot wait expires, the call goes cold: the box is paused (or killed per placement), the harness session id is
   kept, and the ask record gets `cold: { since, sandbox, sessionId, launch }` by compare-and-set **before** the run
   reports `waiting`.
2. An answer from any channel (Slack button, thread reply, `selfbuilding answer`, the hooks handler) is written to the
   ask store first (`resolve`, CAS on `open`), then a wake is sent. A losing answer changes nothing.
3. **Plain Node:** the run process may exit (status `waiting`, exit code 6) or be killed. `selfbuilding resume
   <runId>` (or a fresh `run()` with the same id) replays the journal; at the ask it reads the record: answered →
   resumes the session as the next launch with the answer as the first message; still open → re-enters the wait
   without re-posting (messages are in the record); expired → applies the AFK policy. Optional: the hooks handler's
   `onResolved(record)` callback lets a deployment start the resume automatically.
4. **Trigger.dev:** the agent child waits on a token with `idempotencyKey: askId`; `record.waitpoint.ref` holds the
   token id, so any process with the store and the Trigger key completes it (`createTriggerAskResolver`). A worker
   restart or redeploy resumes from the checkpoint and re-reads the store after the wait.
5. A host restart **during a hot wait** behaves like 3: the open record is found, not re-posted, and the wait resumes
   with the remaining timeout.

Tests: `tests/acceptance/10-cold-restart.test.ts` (kill the Node process during a cold wait, answer through the
store, resume; and the Trigger version with `crash()`/`restart()`), live case added to `4-slack-ask.test.ts`
behind `SELFBUILDING_LIVE_SLACK_HUMAN=1`.

---

## 7. R2 / S3 artifact store (artifacts-r2)

### 7.1 Package

`@selfbuilding/artifacts-s3` (`packages/artifacts-s3`), signing with `aws4fetch`, no AWS SDK:

```ts
s3Artifacts({ bucket, endpoint, region?: "auto", accessKeyId, secretAccessKey, prefix?: "selfbuilding", fetch?, urlTtl?: "1d" })
r2Artifacts({ accountId, bucket, accessKeyId, secretAccessKey, prefix?, fetch?, urlTtl? })   // endpoint https://<accountId>.r2.cloudflarestorage.com
r2ArtifactsFromEnv(env, { bucket?, prefix?, fetch? })   // R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
DEFAULT_R2_BUCKET = "selfbuilding-artifacts"            // account f2821033c1667dab67b5f3f891dc6123
```

All return `SignedArtifactStore` (an `ArtifactStore` whose optional `signedUrl` is present). `accessKeyId` and
`secretAccessKey` are `Secret` (string or resolver), resolved once, never logged or put in an error message.

### 7.2 Layout and semantics

- Content-addressed like `fileArtifacts`: object key `<prefix>/sha256/<aa>/<sha256>`, uri
  `s3://<bucket>/<prefix>/sha256/<aa>/<sha256>`. The `put` key is stored as metadata `x-amz-meta-selfbuilding-key`;
  `Content-Type` is the given content type.
- `put`: `HEAD` first; if the object exists with the same length, no upload. Otherwise one `PUT` (bodies are capped
  by core at 5 MiB per diff and similar; no multipart in this batch; a body over 100 MiB throws `ArtifactError`).
- `read(uri)`: `GET`; a uri for another bucket or prefix, or a non-2xx, throws `ArtifactError` (retryable code
  `artifact_failed`). `hydrate` makes `text()` work again.
- Retries: 3 attempts with full-jitter backoff on network errors, 429 and 5xx; never on 4xx other than 429.
- `r2ArtifactsFromEnv` throws `MissingSecretError` listing every missing name at once.

### 7.3 Signed URLs

- `signedUrl(uri, { expiresIn?, downloadAs? })`: a SigV4 presigned **GET** only (never PUT). Default `"1d"`, at most
  `"7d"` (SigV4 maximum); longer throws `ConfigError`. `downloadAs` sets
  `response-content-disposition=attachment; filename="<name>"`; default inline.
- URLs are made when posting (Slack, PR, summary) and never stored in journals, outcomes or step values.

### 7.4 Wiring

Set `config.artifacts = r2ArtifactsFromEnv(process.env, { prefix: deployment })` in a config file. Evidence from
every sandbox then lands in R2 through the existing settle step. Credentials are authored in Infisical only and
reach processes through the secret manager's run wrapper. Live: `tests/live/8-artifacts-r2.test.ts` gated by
`SELFBUILDING_LIVE=1` and the three R2 variables (put, read, idempotent put, signed URL fetch, expiry bound).

---

## 8. runScript in a QuickJS isolate (run-script)

### 8.1 Package

`@selfbuilding/script` (`packages/script`), dependency `quickjs-emscripten` **release-sync** variant. Exports:
`runScript(source, input, opts?)`, `checkScript(source, caps?)`, `createScriptFactory(opts?)`,
`SCRIPT_FACTORY_NAME = "run-script"`, `DEFAULT_SCRIPT_CAPS`, and the `ScriptRegistry` / `RunScriptOptions` types.
The deployed factory: `createScriptFactory()` returns a factory named `run-script` with input `ScriptRunInput`
(`{ source, input?, name, caps?, launchedBy? }`) and output the script's JSON return value. Register it with each
host (`createTriggerHost({ factories: { "run-script": createScriptFactory() } })`).

Use the sync variant with host-created promises (`context.newPromise()`, settle from the host, then
`runtime.executePendingJobs()`). The asyncify variant is not allowed: it serialises concurrent host calls, so
`sb.parallel` would run one agent at a time.

### 8.2 Script API

A script is an ES module; its default export is called once:

```js
export default async function main(input, sb) {
  sb.phase("build");
  const build = sb.sandbox({ label: "build", size: "medium" });
  const impl = await sb.agents.ImplementSpec({ spec: input.spec }, { sandbox: build });
  // Fork first, then fan out: forking an outer handle inside sb.parallel or sb.pipeline is SandboxHandleScopeError.
  const [forReview, forFinder] = await build.fork(2);
  const [review, found] = await sb.parallel([
    () => sb.agents.CodeReview({ task: "review" }, { sandbox: forReview }),
    () => sb.agents.FindFlows({ change: impl.result.summary }, { sandbox: forFinder }),
  ]);
  const flows = found?.result.flows ?? [];
  const boxes = await build.fork(flows.length);
  const verdicts = await sb.pipeline(flows.map((flow, i) => ({ flow, i })), async ({ flow, i }) =>
    sb.agents.Verify({ change: impl.result.summary, flows: [flow] }, { sandbox: boxes[i] }));
  return { review: review?.result.verdict ?? null, flows: verdicts.map((v) => v?.result.flows[0]?.outcome ?? null) };
}
```

Each `fork(n)` call runs on the parent handle on its own, before the branches that use its children start. A
child is claimed by the first branch that uses it, so hand each branch its own.

`sb` (and nothing else) crosses into the isolate:

| Member | Maps to | Notes |
|---|---|---|
| `sb.input` | the run input's `input` | same as the first argument |
| `sb.agents.<Name>(input, opts?)`, `.settled(…)` | the registered `Agent` | resolves to `{ result, callPath, replayed, usage, artifacts: { branch?, pr?, files: [{ path, uri }] } }` |
| `sb.agent({ name, prompt, output, input? }, opts?)` | inline `agent()` | `output` is a JSON Schema; converted to Zod on the host |
| `sb.parallel(thunks[] \| record)` | `parallel()` | failed items are `null` |
| `sb.pipeline(items, ...stages)` / `sb.pipeline(opts, items, ...stages)` | `pipeline()` | |
| `sb.step(name, fn)` | `step()` | `fn` returns JSON |
| `sb.sandbox({ label?, size?, provider? })` | `sandbox()` | returns a handle proxy `{ id, exec(cmd), fork(n, { size? }), push(), dispose() }`; pass it as `opts.sandbox` |
| `sb.ask({ question, choices?, timeout?, afk? })` | `ask()` | |
| `sb.phase(name)`, `sb.log(msg, level?)` | `phase()`, `log()` | `console.log` maps to `sb.log` |
| `sb.now()`, `sb.random()`, `sb.uuid()` | `now()`, `random()`, `uuid()` | journaled |

Call options a script may pass: `sandbox` (a handle proxy or `"fresh"`), `harness` (a registry name: `"claude-code"`,
`"codex"`), `provider` (a registry name), `size`, `label`, `phase`, `timeout`, `budget: { usd }`, `effort`, `pr`,
`repo`, `git: { branch, baseBranch }`. Anything else is `ScriptInvalidError`. Values crossing the boundary are JSON
only (≤ 1 MiB per crossing).

### 8.3 Caps

Effective caps = `DEFAULT_SCRIPT_CAPS`, tightened by `config.scripts`, tightened again by `input.caps` (each value
is the minimum; `allowedSizes` the intersection). Enforcement: `memoryBytes` → `runtime.setMemoryLimit`;
`stackBytes` → `setMaxStackSize`; `cpuSliceMs` → interrupt handler measuring synchronous time since the isolate
last yielded to the host; `maxAgentCalls`, `allowedSizes` → checked before each call; `maxSandboxes` → the run's
`concurrency.sandboxes`; `budgetUsd`, `wallClock` → the run's budget; `maxOutputBytes`, `maxSourceBytes` → checked
on the return value and source. Every breach is `ScriptLimitError { limit, max }`.

### 8.4 Determinism

- No `Date` (`Date.now()`, `new Date()` without an argument throw: use `sb.now()`), no `Math.random` (use
  `sb.random()`), no `eval`, no `Function` constructor, no `setTimeout`/`setInterval`, no `fetch`, no imports.
  Each throws `ScriptInvalidError` naming the replacement.
- A primitive call is issued synchronously when the script calls it, so call order, and therefore callPaths, follow
  the source. `Promise.all` over agent calls is allowed (calls are numbered at issue time); `sb.parallel` is the
  documented form.
- The source and input are part of the run input, so a resume replays the same script; finished calls come from the
  journal exactly as for a TypeScript factory. A host error never leaks a host stack into the isolate.

### 8.5 Errors

| Class | Code | Kind | When |
|---|---|---|---|
| `ScriptInvalidError` | `script_invalid` | usage | compile error, no default export, a banned global, an unknown option or agent name |
| `ScriptFailedError` | `script_failed` | agent | the script threw; `scriptStack` is the isolate's stack |
| `ScriptLimitError` | `script_limit` | agent | any cap in §8.3 |

Offline: `tests/acceptance/8-run-script.test.ts` (scripted harness + tmpdir: the §8.2 script end to end, resume
after a crash replays, every cap trips).

---

## 9. start_workflow (start-workflow)

### 9.1 The tool

Offered by `selfbuilding-mcp` only when the call's `RuntimeSpec.startWorkflow` is set:

```json
{
  "name": "start_workflow",
  "description": "Start a workflow script as a new durable run on the host. Returns at once with the run id; the run is followed in Slack and with `selfbuilding watch <runId>`.",
  "inputSchema": {
    "type": "object",
    "required": ["name", "script"],
    "additionalProperties": false,
    "properties": {
      "name": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,47}$" },
      "script": { "type": "string", "minLength": 1, "maxLength": 262144, "description": "ES module source; default export async (input, sb) => JSON" },
      "input": { "type": "object" },
      "size": { "type": "string", "description": "Largest size the script will ask for. Default small." },
      "maxSandboxes": { "type": "integer", "minimum": 1 },
      "budgetUsd": { "type": "number", "exclusiveMinimum": 0 },
      "afk": { "type": "boolean" },
      "idempotencyKey": { "type": "string", "maxLength": 128 }
    }
  }
}
```

Tool result text: `Started run <runId> on <host>. Follow it with: selfbuilding watch <runId>` (plus the URL when
there is one), or `isError: true` with the `WorkflowGuardError` / `ScriptInvalidError` message.

### 9.2 Flow

harness → `selfbuilding-mcp` → tool socket (`tool: "start_workflow"`) → supervisor → HTTPS `POST <url>` with
`Authorization: Bearer <grant>` and the `StartWorkflowRequest` body → host handler → launcher → receipt back the
same way. The agent never sees the grant.

### 9.3 Grants and transport

- `config.startWorkflow` (`StartWorkflowPolicy`) must have `enabled: true`; the call must pass
  `startWorkflow: true` (`AgentCallOptions`, wired into `CallPlan.startWorkflow`).
- Core then mints a grant with `signStartGrant(secret, { runId, callPath, depth, exp })`
  (`<base64url(payload)>.<base64url(HMAC-SHA256)>`; `exp` = now + `grantTtl`, default 2 h; secret is the declared
  secret `SELFBUILDING_START_SECRET` from `config.secrets`), writes it root-only 0600 to
  `SANDBOX_PATHS.startGrant` (`/run/selfbuilding/secrets/START_WORKFLOW_GRANT`), and sets
  `RuntimeSpec.startWorkflow = { url }` (from `StartWorkflowPolicy.url`, the handler's public URL; missing →
  `ConfigError`).
- `depth` = the current run's launch depth + 1. A run started by start_workflow records its caller in
  `ScriptRunInput.launchedBy`, so grants minted inside it carry the right depth.
- The supervisor reads the grant, POSTs with a 30 s timeout, and returns the receipt. With `deny-all` egress the tool
  answers `isError` ("this sandbox has no network path to the host").
- Laptop use: `selfbuilding-mcp --standalone` serves only `start_workflow` and runs `selfbuilding start --detach
  --json` for each call (caller `{ kind: "local" }`).

### 9.4 Guards (host side)

`createStartWorkflowHandler({ secret, launcher, policy, now? })` in `@selfbuilding/hooks`, checks in this order and
refuses with `WorkflowGuardError { rule, limit, requested }` (HTTP 403 for guard rules, 401 for `grant`, 400 for
`ScriptInvalidError`):

| Rule | Default | Check |
|---|---|---|
| `disabled` | `enabled: false` | policy enabled |
| `grant` | | HMAC valid, not expired |
| `depth` | `maxDepth: 1` | caller depth ≤ max |
| `script_bytes` | 262 144 | source length |
| `size` | `allowedSizes: ["small"]` | requested `size` in the list |
| `budget` | `maxBudgetUsd: 10` | requested ≤ max |
| `sandboxes_per_run` | `maxSandboxesPerRun: 2` | requested ≤ max |
| `concurrent_runs` | `maxConcurrentRuns: 2` | `launcher.active().runs` < max |
| `concurrent_sandboxes` | `maxConcurrentSandboxes: 4` | `active().sandboxes` + requested ≤ max |

Then `checkScript(source)`, then `launcher.start(request, caller)`. The launched run gets caps
`{ maxSandboxes, allowedSizes: sizes ≤ requested size, budgetUsd }` so the script cannot exceed what was approved.
The run id is `ns_wf_` + base32(sha256(caller.runId + callPath + (idempotencyKey ?? sha256(script + input))))
truncated to 26: a retried tool call converges on the same run (`status: "exists"`). Every launch posts one notify
message (name, caller run and callPath, size, budget, watch command).

Launchers (`WorkflowLauncher`): `nodeWorkflowLauncher({ cwd, config })` in the CLI package (starts the `run-script`
factory detached through the same path as `selfbuilding run`, with the run id fixed up front, tagged
`launchedBy=agent`), `triggerWorkflowLauncher({ trigger, store })` in host-trigger (new file `src/launcher.ts`:
`tasks.trigger("selfbuilding.factory", { factory: "run-script", input, runId }, { idempotencyKey: runId, tags:
["selfbuilding:agent-launched"] })`). `active()` counts runs with that tag and their live sandboxes.

### 9.5 CLI

`selfbuilding start <script> [--name] [--input <json|@file>] [--host node|trigger] [--size] [--max-sandboxes]
[--budget] [--afk] [--detach] [--config] [--env-file] [--json]` (help text in `commands/start.ts`). Local callers
skip `disabled`, `grant` and `depth` but every other guard applies. Without `--detach` it follows the run like
`watch` and exits with the run's exit code.

Offline: `tests/acceptance/9-start-workflow.test.ts` (an agent in a scripted call launches a workflow through the
tool socket and an in-process handler; each guard refuses once; idempotent retry).

---

## 10. Live-run fixes (fix-live)

1. **Codex auth file.** Find why Codex in the box ignores the leased ChatGPT-login `auth.json` (where `CODEX_HOME`
   points, the file path, owner and mode, env stripping, the auth mode in `config.toml`, whether the agent user can
   read it), fix it, and add a regression test in `packages/harnesses/src/codex/` that asserts the planned file path,
   owner `agent`, mode 0600 and the env/config that make Codex read it.
2. **Dubious ownership.** Every agent-side git that touches the root-owned scratch repo
   (`/tmp/selfbuilding-git.*/s.git`, `syncWorkdir` in `packages/core/src/sandbox/git.ts`) passes
   `-c safe.directory=<that exact path>`; test it.
3. **Egress.** Re-read `#networkOpts` in `packages/sandbox-e2b/src/provider.ts` and the SDK create path; add
   `tests/live/support/egress-probe.mjs` (direct SDK probe per provider, gated, not run in CI). If the adapter is
   right, implement the opt-in `SandboxProvider.probeEgress` (type already present) behind a provider option
   (`verifyEgress: true`), make the conformance case expect detection, and record the decision in
   `docs/decisions/0001-egress-enforcement.md`.
4. **E2B rate limits.** Backoff with full jitter on `SandboxQuotaError` (honouring `retryAfterMs`) in every create
   path (create, fork, snapshot restore); live conformance concurrency from `SELFBUILDING_LIVE_CONCURRENCY`
   (default 2 for E2B); re-check `openOrCreate` convergence under injected 429s with a fake-client test.

---

## 11. Cross-builder rules for this batch

- **Wired seams (do not re-wire, only fill in):** `sandboxSpecFor({ provider, size })` → `sizeForSpec`;
  `CallPlan.size`, `CallPlan.mcpServers`, `CallPlan.startWorkflow`; extra MCP servers in `lifecycle.ts`;
  `E2bShapeProviderOptions.sizing` and `#templateFor(image, size)`; CLI `images` and `start` commands registered in
  `main.ts`; `selfbuilding.size` label.
- **Shared files are add-only.** `packages/core/src/types/**`, `packages/core/src/index.ts`, every `package.json`,
  `tsconfig.json`, `biome.json`. If a needed field is missing, add it optional, never reshape.
- **Hot files with more than one owner** (edit only your hunk, keep diffs small):
  `packages/core/src/agent/lifecycle.ts` (sizes-core: the fresh-box spec call and `sandbox.created` data;
  trigger-children: the dispatch branch; start-workflow: grant staging through a call into
  `packages/core/src/agent/start-grant.ts`; fix-live: credential and git staging),
  `packages/agents/src/index.ts` and `contracts.ts` (verify-agent: Verify; verify-flows: FindFlows and verifyFlows),
  `packages/images/src/index.ts` (browser-image: `codexImage` and browser exports; sizes-providers: size and build
  exports), `packages/runtime/src/mcp-server.ts` and `supervisor.ts` (start-workflow only),
  `tests/live/README.md` (each builder adds its own rows).
- **New tests go in new files.** Acceptance numbering: 7 sizes, 8 run-script, 9 start-workflow, 10 cold-restart,
  11 verify-flows, 12 trigger-children. Live numbering: 7 trigger, 8 artifacts-r2, 9 verify-web, 10 verify-flows,
  11 sizes, 12 run-script, 13 start-workflow. Live helpers go in `tests/live/support/<builder>.ts`.
- **Offline first.** Everything above has an offline test with `scriptedHarness`, `tmpdirProvider` and fakes. Network,
  Docker, R2, Trigger.dev, E2B and Impello cases live in `tests/live/` and skip cleanly without their variables.
- **Secrets.** Never read or print credentials. New variables (`R2_*`, `TRIGGER_SECRET_KEY`,
  `SELFBUILDING_START_SECRET`) are authored in Infisical only; tests read them from the environment.

## 12. New environment variables (live suite)

| Variable | Used by |
|---|---|
| `SELFBUILDING_LIVE_CONCURRENCY` | live conformance; default 2 on E2B |
| `SELFBUILDING_PLAYGROUND_WEB_BROKEN` | 9, 10; default `fixture/web-broken-add` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | 8, and any live run that sets `config.artifacts` |
| `SELFBUILDING_LIVE_TRIGGER`, `TRIGGER_SECRET_KEY`, `TRIGGER_PROJECT_REF` | 7, 13 (trigger launcher) |
| `SELFBUILDING_START_SECRET` | 13 |
| `E2B_SIZES`, `IMPELLO_SIZES` | 11: comma-separated sizes whose templates are built (default `small`) |
