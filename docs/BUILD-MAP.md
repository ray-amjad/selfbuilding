# Build map

How the basic version (`docs/BASIC-SCOPE.md`) is split between builders. Section 6 maps the second batch
(the demo path, `docs/spec/demo-path.md`) and section 7 the third (release prep, `docs/spec/release-prep.md`). Read with `AGENTS.md` and
`CONTEXT.md`. When the spec and BASIC-SCOPE.md disagree, BASIC-SCOPE.md wins.

## 1. Ownership

Each builder owns the listed paths and may change anything inside them. Shared files belong to the
foundation: builders may **add** to them (a new export, a new dependency, a new type field marked optional)
but never rename, remove or reshape what is there. Raise a conflict instead.

| Owner | Paths | Delivers |
|---|---|---|
| core-engine | `packages/core/src/{engine,journal,events,errors,budget,config}/` | `factory`, `run`, the primitives (`parallel`, `pipeline`, `isPresent`, `step`, `now`, `random`, `uuid`, `phase`, `log`), callPath and stepKey, the plain Node host's durable step layer, `fileJournal`, `fileArtifacts`, `stdoutSink`, budget, concurrency cap and create-rate limiter, `defineConfig`/`loadConfig`/`fromEnv`/`fromFile`/`envSecretSource`, the error registry |
| core-agent | `packages/core/src/{agent,sandbox,host-node,reap}/` | `Agent.fromSkill`, `agent()`, `.settled()`, `defineContract`, the agent call lifecycle (launch, wait, collect, accept), `sandbox()` handles with `exec`, `push`, `snapshot()`, `fork()`, `dispose`, `nodeHost`, `reap()` |
| core-ask | `packages/core/src/ask/` | `ask()`, hot and cold waits, AFK policies, the ask store over the journal |
| runtime | `packages/runtime/` | `selfbuilding-runtime.mjs` (verbs in §3 below) and `selfbuilding-mcp.mjs` |
| harness-claude | `packages/harnesses/src/claude-code/` | `claudeCode()`: install, auth, prepare, invoke, parser, fixtures |
| harness-codex | `packages/harnesses/src/codex/` | `codex()`: same, with the leased `auth.json` |
| agents | `packages/skills/`, `packages/agents/` | `loadSkill`/`loadSkills`; `ImplementSpec`, `CodeReview`, `Verify`, their schemas, `defaultPack`, `shipChange` |
| sandbox-docker | `packages/sandbox-docker/`, `packages/images/` | `docker()`, `defineImage` and the official image definitions |
| sandbox-e2b-impello | `packages/sandbox-e2b/`, `packages/sandbox-impello/` | `e2b()`, `impello()`, the shared E2B-shape adapter |
| host-trigger | `packages/host-trigger/` | `createTriggerHost()` |
| channel-slack-hooks | `packages/channel-slack/`, `packages/hooks/` | `slack()`, `createHitlHandler()`, `createCallbackHandler()` |
| channel-github | `packages/channel-github/` | `githubApp()`, `pat()`, PR open/update |
| cli | `packages/cli/` | the `selfbuilding` bin: `init`, `doctor`, `run`, `resume`, `watch`, `cancel`, `reap`, `answer` |
| test kit | `packages/testing/`, `packages/sandbox-conformance/` | `scriptedHarness`, `tmpdirProvider`, emulate setup, `describeSandboxProvider()`, `describePlacement()` |

Shared (foundation-owned, add-only): root configs, every `package.json` and `tsconfig.json`,
`packages/core/src/index.ts`, `packages/core/src/types/**`, `CONTEXT.md`, this file.

`packages/images/` has no builder of its own in the task list; sandbox-docker owns it because Docker is the
first provider that builds from it. The E2B and Impello builders add their template steps there.

## 2. Module boundaries

```
cli ──► core ◄── host-trigger, hooks, channel-*, sandbox-*, testing, sandbox-conformance, agents, images
         │                                         harnesses (types only)
         └──► skills
runtime ──► bundles core (types and constants only) + harness parsers; nothing at run time
```

- **Public types** live only in `packages/core/src/types/` and are exported from `@selfbuilding/core`.
  Packages implement those interfaces; they do not redeclare them. No third-party type appears in a public
  `.d.ts` (Trigger tasks are typed `unknown` on purpose).
- **Errors**: every thrown error is a class in `packages/core/src/errors/classes.ts` with a row in
  `registry.ts`. Adapters throw core's classes (`SandboxUnavailableError`, `HarnessAuthError`, ...).
  `NotImplementedError` is scaffolding only and is not part of the registry.
- **skills does not depend on core** (core depends on skills). `loadSkill` throws plain `Error`s with a
  `code` of `"skill_invalid"` or `"skill_duplicate"`; core rethrows them as `SkillLoadError` /
  `DuplicateSkillError`.
- **harnesses** are pure: `install`, `auth`, `prepare` and `invoke` return plans; nothing executes.
  The parsers (`parser.parse`) have no imports beyond core types, because the runtime bundles them.
- **The host computes, the runtime executes.** Core runs the harness adapter on the host and stages the
  result as `RuntimeSpec.plan` (`HarnessRunPlan`). The runtime never imports a harness factory; it picks the
  bundled parser by `plan.streamFormat`.
- **Providers** implement `SandboxProvider` and pass `describeSandboxProvider()`. They never read env
  vars or config; credentials arrive as options. Impello reuses `createE2bShapeProvider` from
  `@selfbuilding/sandbox-e2b` (marked `@internal`).
- **Offline tests**: `tmpdirProvider` sets `SandboxProvider.fsRoot`. Core passes it to every runtime exec
  as `SELFBUILDING_FS_ROOT`; the runtime prefixes every path in `SANDBOX_PATHS` with it. Nothing else
  changes, so the same code path runs in tests and in real sandboxes.
- **Placement** (fork, snapshot, per-call provider and harness): `AgentCallOptions.sandbox` takes
  `"fresh"`, a `SandboxProvider` or a `SandboxHandle`; `AgentCallOptions.harness` takes any `Harness`.
  A reviewer runs on `handle.fork(1)` or on a different provider. `describePlacement()` covers it.

## 3. The runtime ↔ host contract

The typed source is `packages/core/src/types/runtime.ts` (`SANDBOX_PATHS`, `ATTEMPT_FILES`,
`RuntimeSpec`, `WaitResponse`, `LaunchProbe`, `Outcome`, ...). Below: the spec text it implements, quoted
from §6, then the details the spec left open and how they were fixed.

### 3.1 Process topology (spec §6.3)


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


### 3.2 Filesystem layout (spec §6.4)


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


### 3.3 Boot and readiness (spec §6.5)


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


### 3.4 Bridge to the host (spec §6.6)


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


### 3.5 Idempotency and reattach (spec §6.8)


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


### 3.6 Ask answers (spec §6.9)


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


### 3.7 Cancellation (spec §6.10)


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


### 3.8 Settling (spec §6.12)


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


### 3.9 Verbs and JSON shapes (fixed here; the spec leaves them open)

All verbs: `node /selfbuilding/bin/selfbuilding-runtime.mjs <verb> --call <stepKey> --attempt <n> [...]`.
Each prints exactly one JSON object on stdout and logs to `runtime.log`. Exit codes are `RUNTIME_EXIT`:
`0` ok, `75` transient (retry), `76` generation mismatch, `78` deterministic config failure (do not retry).

| Verb | Extra args | Effect | stdout |
|---|---|---|---|
| `launch` | `--launch <launchId>` | Idempotent probe-and-mark. Writes `state/launches/<launchId>.launched` atomically if absent; otherwise probes `call.lock` and `outcome.json`. Starts nothing. | `LaunchProbe`: `{action:"start"}` (host then spawns `supervise` detached), `{action:"reattached"}`, `{action:"interrupted", harnessStarted}`, `{action:"settled", outcome}` |
| `supervise` | `--launch <launchId>` | The long-lived supervisor + bridge + tool socket for one turn. Holds `call.lock` (flock) for the turn. Rewrites `state/launches/<launchId>.status` (`LaunchStatus`) on every state change. | none (detached; output to `runtime.log`) |
| `wait` | `--after <seq> --max <dur>` | Long-poll (§6.6). Returns as soon as events exist past `seq`, or after `--max` (≤ 25s). ≤ 256 KiB. | `WaitResponse`: `{events, lastSeq, state, pendingAsk?, outcome?, lock: "FREE"\|"BUSY"}` |
| `ack` | none | Writes `outcome.ack`. Nothing in the attempt dir is deleted before it exists. | `{acked: true}` |
| `quiesce` | `--timeout <dur>` | Confirms no harness process tree is left (before push, snapshot, fork). | `{quiescent: true}` or `{quiescent: false, reason}` |
| `answer` | `--ask <askId>` (body on stdin) | Writes `inbox/<askId>.json` (`InboxAnswer`) as the agent user, only while `inbox/.open` exists; a duplicate is a no-op. | `{written: boolean}` |

Files the host writes: `spec.json` (`RuntimeSpec`, staged at `<attempt>.tmp/` then `mv`d), `wake.json`
(`WakeFile` `{launchId, rearm, target}`, mode 0600), `cancel` (`CancelSentinel` `{reason, at}`).
Files the runtime writes: `state.json` (`RuntimeState`), `events.jsonl` (`RuntimeEvent`, one per line,
≤ 16 KiB), `submissions/<n>.json`, `result.json`, `outcome.json` (`Outcome`, `O_EXCL`), the `.status` file,
`wake.<launchId>.w<rearm>.sent`.

**Tool socket** (`/run/selfbuilding/tools.sock`): NDJSON, one request per line from `selfbuilding-mcp`:
`{id, kind:"hello", pid}` then `{id, kind:"tool", tool:"submit_result"|"ask_human"|"notify_human", input}`.
The supervisor answers `{id, content, isError, suspended?}`. `content` is the text the model sees.

**RuntimeSpec extensions** beyond the §6.4 listing (all in `runtime.ts`): `agentName`, `bootMode`,
`plan: HarnessRunPlan` (argv, env, stdin, prompt files, resume template with `{sessionId}` / `{promptFile}`,
`streamFormat`), `maxSubmitAttempts`, `maxResumes`, `maxDoneRetries`, `doneChecks`, `protect`,
`artifactsBranch`, `budgetUsd`, `postSubmitChanges`, `wipPushIntervalMs`, `escrow`, `hooks`, `skills`,
`requireIsolation`, `turnIndexBase`. They exist so the runtime needs no host code at run time.

## 4. Conventions

- **Imports**: relative imports end in `.js`; packages import each other by name (`@selfbuilding/core`),
  never by path. Type-only imports use `import type`.
- **Build**: `tsup` emits JS (keepNames on, so error class names survive), `tsc -b` emits `.d.ts` into
  `dist/`. Add a dependency between workspace packages in both `package.json` (`workspace:*`) and the
  `references` of `tsconfig.json`.
- **Tests**: colocated `src/**/*.test.ts`, or `test/`. vitest projects are `packages/*`. Gate anything
  non-offline: `SELFBUILDING_E2E_DOCKER=1`, `SELFBUILDING_E2E_E2B=1` (with `E2B_API_KEY`),
  `SELFBUILDING_E2E_IMPELLO=1` (with `IMPELLO_API_KEY`), `SELFBUILDING_E2E_HARNESS=1` (with model
  credentials). Use `describe.skipIf(...)` so skipped suites print why.
- **Stubs**: `notImplemented("name")` from the package's internal `not-implemented.ts` throws an `Error`
  named `NotImplementedError` naming the owner. Never export it.
- **Errors**: construct with the class's fields and an optional `{message, runId, callPath, recovery, cause}`.
  `toJSON()` gives `SerializedSelfbuildingError`, which is what crosses hosts and journals.
- **Changesets**: every user-facing change to a package adds one (`pnpm changeset`). All packages version
  together.
- **Never** name any product the design was inspired by; never copy from `ref/`.

## 5. Spec ambiguities resolved by the foundation

| Gap | Resolution |
|---|---|
| Spec mentions tsdown and Turborepo | tsup + `pnpm -r`, per the task. `isolatedDeclarations` deferred. |
| Two meanings of "sandbox handle" | Provider-level handle is `ProviderSandbox`; factory-level is `SandboxHandle` (§1.6). |
| `find`/`list` need the deployment | `SandboxKey` gains `deployment`, so providers never read config. |
| Offline runtime tests with absolute paths | `SandboxProvider.fsRoot` + `SELFBUILDING_FS_ROOT`. |
| Scripted harness must exercise real parsers | `HarnessCapabilities.streamFormat`; the scripted harness emits a real format. `Harness.options` added. |
| Runtime must not import adapters | Host precomputes `RuntimeSpec.plan` and the other extensions above. |
| §6.6 long-poll vs §7.5.4 status file | Both: the runtime rewrites `launches/<launchId>.status`; `wait` and plain Node read it. |
| `launch` verb shape | Idempotent probe-and-mark returning `LaunchProbe`; the host spawns `supervise` detached. |
| `ack`, inbox, cancel, wake shapes undefined | `outcome.ack`, `InboxAnswer`, `CancelSentinel`, `WakeFile`; NDJSON tool socket. |
| Where asks are stored | `JournalStore.asks` (optional): asks default to the journal's storage (§8.3). |
| `ArtifactStore`, `ResultStore`, `GitCredentialBroker` not spelled out | Defined in `types/artifacts.ts`, `types/host.ts`, `types/security.ts` (broker includes the PR API). |
| StandardSchema / JSON Schema types | Declared locally in `types/common.ts`; no third-party types in public `.d.ts`. |
| Error `kind` for non-usage classes | Credential, agent, durability and channel errors are `kind: "agent"`; `HostStepLimitError` follows its phase. |
| Default agents | BASIC-SCOPE.md's `ImplementSpec`, `CodeReview`, `Verify`, `shipChange` replace the spec's four-agent pack. |
| `boot` and `artifact_failed` codes | Shared by several classes, as the spec lists; `aborted` has no class (rejects with `signal.reason`). |

## 6. Batch 2: the demo path (branch `build/demo-path`)

Contracts: `docs/spec/demo-path.md`. The design step already added the shared types, error registry rows,
package skeletons, stubs, dependencies and the seams listed in demo-path §11; builders fill them in. The §1 rule
still holds: shared files (root configs, every `package.json` and `tsconfig.json`, `biome.json`,
`packages/core/src/index.ts`, `packages/core/src/types/**`, `CONTEXT.md`, this file) take additions only. Paths
marked *hunk* are shared hot files where the builder may change only the named part. Delete a package's
`not-implemented.ts` once its last stub is gone.

| Builder | Owns | Delivers |
|---|---|---|
| fix-live | `packages/harnesses/src/codex/**`; `packages/core/src/sandbox/git.ts`; `packages/core/src/agent/credentials.ts`; `packages/runtime/src/git.ts`; `packages/sandbox-e2b/src/{provider,client,errors,util,binding}.ts` and their tests, `packages/sandbox-e2b/test/**`; `packages/sandbox-conformance/src/**`; `tests/live/6-conformance.test.ts`, `tests/live/support/{live,hooks}.ts`, `tests/live/support/egress-probe.mjs`; `docs/decisions/**`; *hunk*: credential and git staging in `packages/core/src/agent/lifecycle.ts` | demo-path §10: Codex auth fix, safe.directory, egress decision and opt-in probe, quota backoff and live concurrency, each with a regression test |
| sizes-core | `packages/core/src/sizes/**`; `packages/core/src/sandbox/{spec,handle,names}.ts`; `packages/core/src/agent/plan.ts` (size only); `packages/core/src/config/**` (the `sizes` key's validation only); `packages/testing/src/tmpdir/**` (sizing); `tests/acceptance/7-sizes.test.ts`; *hunk*: the fresh-box spec call and `sandbox.created` data in `lifecycle.ts` | demo-path §1.1, §1.2, §1.5, §1.6: `sizeTable`, `resolveSize`, `checkSize`, `sizeForSpec`, handle and fork sizes, events, labels, journal, `sandboxVcpuMs` |
| sizes-providers | `packages/sandbox-e2b/src/{sizes,build,templates,index}.ts` (new `sizes.ts`, `build.ts`); `packages/sandbox-impello/src/**`; `packages/sandbox-docker/src/**`, `packages/sandbox-docker/test/**`; `packages/images/src/build/**` and size exports in `packages/images/src/index.ts`; `packages/cli/src/commands/images.ts`; `tests/live/11-sizes.test.ts` | demo-path §1.3, §1.4, §2: `templateSizing`, provider `sizing` and options, `e2bImageBuilder`, `impelloImageBuilder`, `dockerImageBuilder`, `selfbuilding images build` |
| browser-image | `packages/images/src/browser.ts` (new); the `codexImage` block and browser exports in `packages/images/src/index.ts`; `packages/images/docker/codex/**`; `packages/images/src/index.test.ts` (browser cases) | demo-path §3: Chromium, Playwright, `playwright-mcp`, `sqlite3`, pins, manifest, `BROWSER_MCP_SERVER` |
| playground-web | `fixtures/playground-web/**` (the app, `publish.mjs`, the verify facts file and the `web-mark-done` spec it publishes) | demo-path §4.1: the Next.js Notes app, the `main` and `fixture/web-broken-add` contents |
| verify-agent | `packages/agents/skills/verify/**`; the Verify parts of `packages/agents/src/{schemas,contracts,checks}.ts` and their tests; *hunk*: the `Verify` export in `packages/agents/src/index.ts`; `tests/live/9-verify-web.test.ts` | demo-path §4.2: Verify runnable on a real web app with the browser, evidence layout, live verified and broken proofs |
| verify-flows | `packages/agents/src/flows/**`; `packages/agents/skills/find-flows/**` (new); FindFlows parts of `contracts.ts`; *hunk*: FindFlows and verifyFlows exports in `packages/agents/src/index.ts`; `tests/acceptance/11-verify-flows.test.ts`, `tests/live/10-verify-flows.test.ts` | demo-path §4.3, §4.4: `FindFlows`, `findFlowsContract`, `createVerifyFlows`, `verifyFlows`, `renderRunSummary`, posting |
| artifacts-r2 | `packages/artifacts-s3/**`; `tests/live/8-artifacts-r2.test.ts` | demo-path §7: `s3Artifacts`, `r2Artifacts`, `r2ArtifactsFromEnv`, signed URLs |
| trigger-children | `packages/host-trigger/**` except `src/asks.ts` and `src/launcher.ts`; `packages/core/src/agent/driver.ts` (new) and its export; `packages/core/src/agent/call.ts`; *hunk*: the dispatch branch in `lifecycle.ts`; `tests/acceptance/12-trigger-children.test.ts`, `tests/acceptance/3-crash-resume-trigger.test.ts`; `tests/live/7-trigger.test.ts`, `tests/live/trigger/**` | demo-path §5: `agentCallDriver`, dispatch through `host.dispatchAgent`, the child-task mapping, a real Trigger.dev project |
| cold-restart | `packages/core/src/ask/**`; `packages/hooks/src/{hitl,callback,dedupe}.ts` and tests; `packages/host-trigger/src/asks.ts`; `packages/cli/src/commands/{answer,resume}.ts`; `tests/acceptance/10-cold-restart.test.ts`; the restart case in `tests/live/4-slack-ask.test.ts` | demo-path §6: the ask store as the only truth, `AskRecord.cold`, resume after a restart on Node and Trigger |
| run-script | `packages/script/**`; `tests/acceptance/8-run-script.test.ts`, `tests/live/12-run-script.test.ts` | demo-path §8: `runScript`, `checkScript`, `createScriptFactory`, caps, determinism |
| start-workflow | `packages/hooks/src/start-workflow.ts`; `packages/runtime/src/{mcp-server,mcp,supervisor,tool-socket}.ts` (the `start_workflow` tool only) and tests; `packages/core/src/agent/start-grant.ts` (new); *hunk*: grant staging in `lifecycle.ts`; `packages/cli/src/commands/start.ts`, `packages/cli/src/launcher.ts` (new); `packages/host-trigger/src/launcher.ts` (new) and its export; `tests/acceptance/9-start-workflow.test.ts`, `tests/live/13-start-workflow.test.ts` | demo-path §9: the tool, grants, guards, `createStartWorkflowHandler`, `signStartGrant`, both launchers, `selfbuilding start`, `selfbuilding-mcp --standalone` |

Every builder may add rows to `tests/live/README.md` and add its own helpers under `tests/live/support/<builder>.ts`.
Conflicts between rows are raised, not resolved by editing another builder's paths.

## 7. Batch 3: release prep (branch `build/release-prep`)

Contracts: `docs/spec/release-prep.md`. The design step added the shared types, the `PrTargetError` registry row,
the `pr_writes` script limit and `maxPrWrites` cap, and stubs for `sqliteJournal`, the PR helpers,
`toStandaloneDockerfile` and the S3 result store (release-prep §8). The §1 and §6 rules still hold: shared files take
additions only, *hunk* paths may change only the named part, and conflicts are raised, not resolved by editing
another builder's paths. Nobody in this batch runs live tests or reads credentials.

| Builder | Owns | Delivers |
|---|---|---|
| sqlite-journal | `packages/core/src/journal/sqlite-journal.ts` (+ tests), the sqlite cases in `packages/core/src/journal/journal.test.ts`; `packages/cli/src/commands/journal.ts` (+ test); *hunk*: the `journal` entry and help line in `packages/cli/src/main.ts`, the journal comment and `.gitignore` line in `packages/cli/src/templates.ts`, the optional `journal` field in `tests/acceptance/support/crash-scenarios.ts`; `tests/acceptance/14-sqlite-journal.test.ts` | release-prep §1: `sqliteJournal` (entries, leases, asks, results; WAL, busy timeout, transactional CAS), `selfbuilding journal import`, init comment |
| script-pr | `packages/core/src/pr/**`; `packages/channel-github/src/pulls.ts` and its tests (`get`, `update`, `comment`); `packages/script/**`; `tests/live/task-lifecycle/lifecycle.mjs`; `tests/acceptance/15-script-pr.test.ts` | release-prep §2 and §7.3: `parsePrTarget`, `replacePrSection`, `getPr`, `commentOnPr`, `updatePr`, `sb.pr`, the `maxPrWrites` cap, the lifecycle markers and PR sections, script-layer sandbox counting, the unsized `sb.sandbox()` check |
| trigger-deployed | `packages/host-trigger/**`; `packages/artifacts-s3/src/results.ts` (+ tests) and its exports; `packages/core/src/agent/call.ts`; `packages/core/src/agent/start-grant.ts` (Trigger depth only); `packages/hooks/src/hitl.ts` (waitpoint completion retry only); *hunk*: the dispatch branch in `lifecycle.ts`; `tests/live/trigger/**`; `tests/acceptance/16-trigger-deployed.test.ts`, `tests/live/15-trigger-deployed.test.ts`; `docs/decisions/0002-shared-handles-on-trigger.md` (new) | release-prep §3: `s3ResultStore`, `r2ResultStore`, `r2ResultStoreFromEnv`, the deployed-store refusal, shared-handle calls, `markCold`, run-script in the live project, afk, redaction, findings on dispatched usage, grant depth and waitpoint completion |
| images-dockerfile | `packages/images/**` (except `src/browser.ts`); `packages/sandbox-e2b/src/{build,templates,index}.ts` and their tests; `packages/sandbox-impello/src/build.ts` and its tests; `packages/cli/src/commands/images.ts` (+ test); `tests/live/14-images-dockerfile.test.ts` | release-prep §4: `toStandaloneDockerfile`, unquoted ENV, `fromDockerfile` builds with no registry, `allHarnessesImage` and `--all-harnesses` |
| docs | `README.md`, `docs/guides/**`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `docs/RELEASE-CHECKLIST.md`, `tests/live/task-lifecycle/README.md`, `docs/ROADMAP.md` | release-prep §5: the README, setup guides per provider, harness, GitHub App, Slack app, Trigger.dev, R2/S3, sizes, journals, factories, scripts, verifying flows, the worked example, the community files and the release checklist |
| ci | `.github/**`; `scripts/**`; `.changeset/config.json` (`access` only); the metadata keys of every `packages/*/package.json`; `packages/*/README.md` (new ones only); `tests/acceptance/package-meta.test.ts`; *hunk*: line 49 of `docs/BASIC-SCOPE.md` (the personal path) and any other tracked-file hit the scan finds outside other builders' paths (raise the rest) | release-prep §6: `ci.yml` on Node 22 and 24, `scripts/check-public.mjs` with `--self-test` and `--strict`, `scripts/check-public.allow`, `scripts/publish-order.mjs`, publish metadata |
| findings | `packages/hooks/src/start-workflow.ts` (+ tests); `packages/sandbox-e2b/src/provider.ts` (probe only) and its tests; `docs/decisions/0001-egress-enforcement.md`; `docs/spec/demo-path.md` §8.2; `packages/agents/src/flows/**`; `packages/agents/skills/verify/**` and the Verify browser check; `packages/cli/src/launcher.ts`, the `./launcher` export in `packages/cli/package.json` and `packages/cli/tsup.config.ts`; *hunk*: `returnLeasedFile` and the `sandboxVcpuMs` usage lines in `lifecycle.ts`; `tests/acceptance/17-contract-size.test.ts` | release-prep §7.1, §7.2: the six review findings and the eight smaller gaps, each with a regression test |

Every builder may add rows to `tests/live/README.md` and helpers under `tests/live/support/<builder>.ts`.
