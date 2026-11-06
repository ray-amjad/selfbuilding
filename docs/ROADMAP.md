# Selfbuilding roadmap

Status as of 2026-11-05 (after the full live pass, preparing 0.1.0). The milestones and their weights come from the spec (§10.6, 20 weeks in total).
"Live" means it ran against the real service, not only against fakes and emulators.

## Where we are

| Milestone | Weeks | Done | Notes |
|---|---:|---:|---|
| Basic version (`docs/BASIC-SCOPE.md`) | — | **~98%** | All offline acceptance tests pass; the full live suite passed on 2026-11-05 (245 passed, 0 failed); not yet live: three Slack click-through cases, `start_workflow` over a public URL, Trigger deployed mode |
| M0: contracts | 2 | 88% | Done: CI on Node 22 and 24, the public-tree scan, publish metadata, `CONTRIBUTING`/`SECURITY`/`CODE_OF_CONDUCT`, setup guides. Missing: API report, golden stream, docs site |
| M1: one real agent, locally | 3 | 75% | Done: setup guides, Docker live. Missing: OpenCode, `skills build/check/validate`, parser-fixture refresh |
| M2: composition and durability | 4 | 92% | Live: agent calls as Trigger child tasks, `images build` without a registry, machine sizes, R2 artifacts, `runScript`, verifyFlows. Missing: Trigger deployed mode live, SQLite journal live, review dogfood |
| M3a: humans | 4 | 45% | Built offline: cold wait across a host restart. Missing: that live, GitHub comment channel, Inngest host, `skills add`, Slack thread replies |
| M3b: breadth | 4 | 12% | Done: E2B. Missing: Discord, Cloudflare Workflows, Daytona, Vercel, Modal, Cloudflare Sandbox |
| M4: v1.0 | 3 | 3% | Missing: Amp, Droid, Pi, Grok, API freeze, references, troubleshooting guide |
| **Full v1, weighted by weeks** | **20** | **~48%** | |

The basic version is finished and proven live. The 2026-11-05 live pass ran every live test on Impello, E2B and
Docker with Claude Code and Codex, plus the task-lifecycle example (build, PR, two review rounds on forks, find
flows, browser Verify of each flow, Slack ask) on a Next.js Kanban app. It found about 20 bugs, each now fixed with a
regression test (listed below). Measured against the whole v1 plan it is about half done, because the basic version
deliberately left out breadth: most providers, harnesses, hosts and channels.

## Done

### Primitives (all in `@selfbuilding/core`)

| Primitive | Offline | Live |
|---|:-:|:-:|
| `factory`, `run`, `Agent.fromSkill`, inline `agent()`, typed results through `submit_result` | ✅ | ✅ |
| Invalid result retried inside the run | ✅ | — |
| `pipeline()`, `parallel()`, `isPresent`, `step()`, `now/random/uuid` | ✅ | ✅ |
| `phase()`, `log()`, event envelope, stdout sink | ✅ | ✅ |
| Budget (USD + wall clock), sandbox cap, create-rate limiter | ✅ | ✅ |
| `callPath` + `stepKey`, file journal, journal-replay resume, epochs | ✅ | ✅ crash + resume on Impello |
| SQLite journal (`sqliteJournal`) and `selfbuilding journal import` | ✅ | — |
| `ask()` hot wait, cold wait, AFK policies | ✅ | ✅ hot and AFK with real Slack clicks (2026-11-02); cold wait and restart-during-wait not re-run |
| Sandbox placement: fresh, shared handle, `fork()`, `snapshot()`, branch handoff | ✅ | ✅ |
| Machine sizes: named presets (`small`/`medium`/`large`, custom via config), typed refusal naming the fix | ✅ | ✅ |
| `runArtifacts()`, `notify()`, evidence collected from `/selfbuilding/out/files` | ✅ | ✅ |
| Workflow scripts in a QuickJS isolate (`run-script`) | ✅ | ✅ |
| A run's PR from factories and scripts (`getPr`, `commentOnPr`, `updatePr`, `sb.pr`, `maxPrWrites`) | ✅ | ✅ (task-lifecycle) |
| `start_workflow` / `get_workflow_status` with grants, size and sandbox caps | ✅ | ⏳ (live 13 needs a public URL) |
| Per-call provider and harness (review on another provider) | ✅ | ✅ |
| Error registry, config loading, `reap()` | ✅ | — |

### Plug-ins

| Kind | Built | Live |
|---|---|---|
| Hosts | plain Node ✅, Trigger.dev ✅ (agent calls as `selfbuilding.agent` child tasks; deployed runs on a shared S3/R2 result store) | Node ✅, Trigger.dev ✅ dev worker (deployed: live 15 not run) |
| Harnesses | Claude Code ✅, Codex ✅ (auth-file fix) | Claude Code ✅ (subscription token), Codex ✅ |
| Providers | Impello ✅, E2B ✅ (quota backoff, opt-in `verifyEgress`), Docker ✅ (sizes, sized forks), tmpdir (tests) ✅ | Impello ✅, E2B ✅, Docker ✅ |
| Artifact and result stores | local ✅, S3/R2 artifacts ✅ (signed GET URLs, retried uploads), S3/R2 result store ✅ | R2 ✅ |
| Images | `selfbuilding images build` for Docker, E2B, Impello ✅, also without a registry (from a generated Dockerfile) ✅; `selfbuilding-all-harnesses` ✅; Chromium + Playwright + browser MCP in the Codex image ✅ | ✅ medium templates on Impello and E2B from Dockerfiles; base images not yet published |
| Channels | Slack ✅, hooks handlers ✅ | Slack ✅ |
| GitHub | App broker ✅, PAT fallback ✅, PR open ✅ | App ✅ (`selfbuilding-bot`, playground) |
| Agents | ImplementSpec, CodeReview, Verify (browser, web app), FindFlows, `shipChange`, `verifyFlows` + run summary page ✅ | all ✅ (Verify returns `verified` and `broken` correctly in Chromium) |
| CLI | `init`, `doctor`, `run`, `resume`, `watch`, `cancel`, `reap`, `answer`, `start`, `images build`, `journal import` ✅; `nodeWorkflowLauncher` at `selfbuilding/launcher` ✅ | — |
| Release | CI (`ci.yml`, Node 22 and 24), `scripts/check-public.mjs`, publish metadata and order, README, guides, `CONTRIBUTING`/`SECURITY`/`CODE_OF_CONDUCT`, `docs/RELEASE-CHECKLIST.md` ✅ | — |

### Found by live runs and fixed

1. Image build: npm refused `/dev/null` as both user and global config.
2. Claude Code credential: core and the harness used different key names.
3. Runtime git: "dubious ownership" when root ran git in the agent's workspace.
4. Conformance: the 0600 check ran as the wrong user (test bug).
5. Agent calls never got a GitHub read token for the boot clone.
6. Partial clones fetched contents lazily, without a token.
7. AFK mode demanded an approver.
8. A Slack answer that arrived while a box was still pausing failed the run (409).
9. Codex in the box ignored the leased `auth.json` (401): the file was not staged for the agent user. Fixed offline.
10. `shipChange` checkout: "dubious ownership" on the root-owned scratch repo; agent-side git now trusts that path.
11. E2B rate limits in the live suite: create paths back off on quota; `SELFBUILDING_LIVE_CONCURRENCY` (default 2).
12. A shared box built from `main` instead of the run's base branch; `sb.sandbox` and handles now carry `baseBranch`.
13. The GitHub ruleset check passed a ruleset that still blocked nested agent branches; it now probes a nested ref.
14. Opening a PR failed with "not all refs are readable"; the PR token now has `contents: read`. GitHub 422s show their reasons.
15. Resume tried to continue an agent session from a box that no longer existed.
16. Snapshot and pause of large E2B boxes timed out.
17. A harness missing from the image was never installed; it now installs on exit 127 at its tested version.
18. Verify had no browser: the MCP env file was root-only and the Playwright cache was read-only.
19. Agents on a fresh box could not edit repo files: the checkout is now owned by the agent user.
20. Docker: a missing file was reported as a missing sandbox, execs failed during a fork's pause, and the spawn
    helper's umask made files unreadable.
21. E2B: its listing lags its own writes, which caused duplicate boxes and leaked boxes in conformance.
22. R2 gzips large objects and returns weak ETags, which broke the deployed result store's compare-and-set.

### Reported upstream

- Impello does not enforce `allowInternetAccess: false`: the box still reaches the internet. E2B shows the same in the
  live run; `tests/live/support/egress-probe.mjs` reproduces it per vendor. Providers can opt in to a post-create
  probe (`verifyEgress`); see `docs/decisions/0001-egress-enforcement.md`.

## Next, in order

### 1. Finish the live pass

- [x] Full live suite on Impello, E2B and Docker × Claude Code and Codex (2026-11-05: 245 passed, 0 failed).
- [x] Medium templates (`claude-code`, `codex`, `all-harnesses`) built with `selfbuilding images build` on Impello and
      E2B.
- [x] `tests/live/task-lifecycle` end to end on the Kanban fixture, all flows `verified` in a real browser.
- [x] Verify live, including a planted-bug `broken` verdict (live 9) and verifyFlows (live 10).
- [ ] Slack click-through cases (hot, cold, restart during a cold wait) re-run after the demo-path changes.
- [ ] `start_workflow` over a public URL (live 13).
- [ ] Trigger.dev deployed mode (live 15).
- [ ] Publish the `base` and `codex` images to a public registry (`claude-code` and `all-harnesses` stay build-it-yourself).

### 2. Hardening (known gaps from the basic build)

- [ ] Reaper records a failure for calls whose box it paused.
- [ ] An open ask extends its box's deadline; ask wait time does not count against the wall-clock budget.
- [ ] Credential pool records the credential it used and picks login files per harness.
- [ ] Escape Slack fallback text (no `@channel` or disguised links from agent text).
- [ ] Fork children get unique provider keys across forks of one box.
- [x] Look up a PR from its URL (`parsePrTarget`, `getPr`).
- [ ] Regression tests for the 13 review fixes that have none.
- [x] License: MIT; the CodeReview prompts are credited to Anthropic in `NOTICE`.
- [x] Demo-path review findings, each with a regression test: `get_workflow_status` lets any grant read locally launched runs; a
      repeated `start_workflow` for an existing run id skips its guards but re-triggers on Trigger; Trigger grants
      stop at depth 2; dispatched calls report no sandbox time; a failed waitpoint completion after an answer is
      only logged; `verifyEgress` treats a failed probe as a leak and its target check is a substring match.
- [x] Count live `sb.sandbox()` boxes in the script layer itself, and check `sb.sandbox()` with no size.
- [x] `redactForRun` on Trigger knows only token shapes, not the secrets handed to child tasks.
- [x] Read back a leased `auth.json` without following symlinks.
- [x] Keep Verify's browser server and the one in `@selfbuilding/images` in sync by a check; add an acceptance test
      for `ContractDefaults.size`.
- [ ] The built-in `ImplementSpec`, `FindFlows` and `Verify` carry a default harness with no credentials, which wins
      over `config.harness`, so every call must pass `harness`. Fall back to the config's credentials (or drop the
      default) and test it.
- [x] Correct the spec's §8.2 example, which forks inside `sb.parallel` (core refuses that).
- [x] Fix `docs/decisions/0001-egress-enforcement.md`: `e2b()` and `impello()` already accept `verifyEgress`.

### 3. Toward v1 (milestones M0–M4)

- [x] CI (`ci.yml`), changesets config, publish metadata and order.
- [ ] API report, public-type checks.
- [x] SQLite journal.
- [ ] GitHub comment channel; Inngest host; Discord channel; Cloudflare Workflows host.
- [ ] Providers: Daytona, Vercel Sandbox, Modal, Cloudflare Sandbox.
- [ ] Harnesses: OpenCode, then Amp, Droid, Pi, Grok as experimental.
- [ ] CLI: `skills build/check/validate/add/infer`.
- [x] Setup and writing guides (`docs/guides/`).
- [ ] Docs site and generated references; `examples/` per primitive and host.
- [ ] First public release (0.1.0), following `docs/RELEASE-CHECKLIST.md`.
- [ ] Optional later: the control plane on Workers + Durable Objects.

## Positioning

Lead with dynamic workflows with sandboxes, run locally or handed to Trigger.dev. Skills becoming agents is one way
to define an agent, not the headline. Describe what it does, factually; no marketing language and no promotion
before the first release.
