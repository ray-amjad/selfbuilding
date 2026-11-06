# Selfbuilding: basic version scope (the build contract)

Date: 2026-11-01. This file is the source of truth for the first build. Where it and
`docs/spec/selfbuilding-v1-spec.md` disagree, this file wins. Where this file is silent,
follow the spec. The spec was written under an earlier working name; every name is now
`selfbuilding` (packages `@selfbuilding/*`, CLI `selfbuilding`, MCP server `selfbuilding-mcp`,
runtime `selfbuilding-runtime`, labels `selfbuilding.*`, branch prefix `selfbuilding/`, project
folder `.selfbuilding/`, image names `selfbuilding/<harness>`).

## Product

Selfbuilding is an MIT, library-first TypeScript toolkit for building a software factory.
Every `SKILL.md` folder becomes a typed `Agent`. Factories compose agents in plain TypeScript and
run them on coding-agent harnesses inside sandboxes, on a durable host, with humans asked over
Slack when needed. The repo is private for now (`ray-amjad/selfbuilding`). Never mention any
other product or repo this design was inspired by, in code, comments, docs or commit messages.

## In scope for the basic version

| Area | In |
|---|---|
| Tooling | pnpm workspaces, Node >= 22.12, TypeScript strict, ESM only, tsup, vitest, Biome, changesets |
| Core | `factory`, `run`, `Agent.fromSkill`, inline `agent()`, `.settled()`, `pipeline()`, `parallel()`, `isPresent`, `step()`, `now/random/uuid`, `phase()`, `log()`, `ask()`, `sandbox()` handles (fresh default, shared opt-in, `exec`, `push`, `snapshot()`, `fork()`, `dispose`, `await using`), budget (USD + wall clock, per-agent slices), sandbox concurrency cap and create-rate limiter, `callPath` + `stepKey`, file journal with journal-replay resume and epochs, event envelope + stdout sink, error registry (`SelfbuildingError` subclasses with `code` and `recovery`), `defineConfig`/`loadConfig`/`fromEnv`/`fromFile`, `reap()` |
| Hosts | plain Node (built into core) and Trigger.dev v4 (`@selfbuilding/host-trigger`: `createTriggerHost({config, factories})` returning `factoryTask`, `agentTask`, `reaperTask`; launch → wait (waitpoint) → collect in the child task, accept in the parent) |
| Harnesses | Claude Code and Codex (`@selfbuilding/harnesses/claude-code`, `/codex`). Headless invocation, normalised event stream parser, session resume, MCP config for `selfbuilding-mcp`, version policy `'tested'` with pinned versions and parser fixtures |
| Credentials | First-class subscription logins: `{kind:'oauth-token'}` for Claude Code (`CLAUDE_CODE_OAUTH_TOKEN`), `{kind:'auth-file', leased:true}` for Codex `auth.json` (one sandbox per file at a time, copied back after the call). API keys (`{kind:'api-key'}`) as the fallback. A credential pool tries subscription first and falls back to API keys when a subscription is rate-limited or refused. Secrets reach a sandbox only as 0600 files, never env vars or images. Docs say users are responsible for their plan's terms |
| Providers | Docker (`@selfbuilding/sandbox-docker`), Impello (`@selfbuilding/sandbox-impello`, uses `@impello/sdk`), E2B (`@selfbuilding/sandbox-e2b`). Impello and E2B share the E2B-shape adapter code. All three implement the full provider contract and its invariants (find never wakes; outage throws `SandboxUnavailableError`, null only on a genuine miss; pause confirms and a refusal is a typed outcome; `openOrCreate` recovers from ghost refs and converges). Plus a `tmpdir` provider in `@selfbuilding/testing` for offline tests |
| Placement | Fresh sandbox per agent by default. Shared handles. `fork(n)` and `snapshot()`. Every agent call can choose its own provider and harness, so a reviewer can run on a fork, or on a different provider (e.g. build on Impello, review on Docker or E2B) |
| Runtime | `@selfbuilding/runtime`: one bundled `selfbuilding-runtime.mjs` (supervisor, bridge, tool socket) and `selfbuilding-mcp.mjs` (stdio MCP server with `submit_result`, `ask_human`, `notify_human`). `ns-reap` may be a small script for now, with a process-group kill fallback |
| HITL | `ask()` from the factory and `ask_human` from inside the sandbox. Hot and cold waits. AFK policies (auto-answer, default after timeout, fail). Slack channel (`@selfbuilding/channel-slack`: Block Kit buttons + thread replies, signing-secret verification) and the `@selfbuilding/hooks` fetch handlers (`createHitlHandler`, `createCallbackHandler`). Discord and GitHub-comment channels are NOT in scope |
| GitHub | `@selfbuilding/channel-github` with only the `githubApp()` git credential broker (short-lived repo-scoped installation tokens; the agent gets a read-only token, the host pushes) and PR open/update as the App. A `pat()` broker as a fallback for local use |
| Agents | `@selfbuilding/agents`: `ImplementSpec`, `CodeReview`, `Verify`, and the `shipChange` factory (below). Skills are ported from the owner's own skills (see "Skill sources"). No third-party skill content |
| CLI | `selfbuilding` bin: `init`, `doctor`, `run`, `resume`, `watch`, `cancel`, `reap`, `answer` |
| Testing | `@selfbuilding/testing`: `scriptedHarness` (replays a script of events and a `submit_result`), `tmpdirProvider`, emulate.dev setup for GitHub and Slack (npm `emulate`, pinned). `@selfbuilding/sandbox-conformance`: `describeSandboxProvider()` including injected 503s/timeouts and the placement suite |

## Out of scope for the basic version

Discord, GitHub comment channel, Inngest, Cloudflare Workflows, Daytona, Vercel, Modal, Cloudflare
Sandbox, OpenCode, Amp, Droid, Pi, Grok, SQLite journal, S3 artifacts (use the file artifact store;
the Trigger host may use a file or Trigger-native store for now), OTel sink, ESLint plugin, the
control plane, telemetry.

## The built-in agents and the shipChange factory

Skill sources, to be PORTED (rewritten generically, never copied with references to the system they
came from, no internal CLIs, no Slack-posting commands, no account names):
- `ImplementSpec`: the build step of the owner's toolkit `skills/task-lifecycle/SKILL.md`
  (section "2. Build — one fresh builder" and "Implementation notes"), plus
  the owner's own implement skill. Behaviour: the spec is the source of
  truth for scope; create a new branch (never the default); small coherent commits as it goes;
  keep the diff focused; run the type checker, linter and tests for its area; append every decision,
  deviation, tradeoff and open question to `implementation-notes.md` (outside the diff); never open a
  PR itself. Result: `status`, `summary`, `changes[]`, `tests?`, `followUps[]`, `openQuestions[]`,
  `prTitle`, `prBody`. Artifacts: branch, diff, transcript, `implementation-notes.md`.
- `CodeReview`: the owner's toolkit `skills/code-review/SKILL.md` and its
  `references/medium.md` and `references/high.md` (the official multi-angle review prompt; keep the
  tier prompts verbatim). One shared skill used by BOTH harnesses. Tier by diff size: medium for
  <= ~100 changed lines and <= 3 files, high otherwise or when auth/money/migrations/concurrency are
  touched. Result: `verdict: "approve" | "request_changes" | "comment"`, `tier`, `summary`,
  `findings[]` (`file`, `line`, `severity`, `category`, `summary`, `failureScenario`, `verdict`).
  NOTE for later: these prompts come from Claude Code; record (now in `NOTICE`) that their
  license must be checked before the repo goes public.
- `Verify`: the owner's toolkit `skills/verify/SKILL.md` and its references.
  Behaviour: prove a change runs for a real user against a real, isolated database and browser.
  Three roles (setup, verifier that drives the flow as a user, checker that reads the DB, logs and
  evidence and writes the verdict). Browser and computer use run on Codex. Result: one of four
  outcomes (`verified`, `broken`, `could_not_boot`, `unverifiable`) per flow with an evidence
  artifact. Port the web-app path only; drop desktop-app routes and any internal tooling.
- `shipChange` factory: the owner's toolkit `skills/task-lifecycle/SKILL.md` and
  its `references/review-round.md`, `verify-round.md`, `decision-page.md`, rewritten as a
  Selfbuilding factory: `ImplementSpec` (Claude Code) in a shared sandbox → open PR as the GitHub
  App with the notes in the body → up to two review-and-fix rounds where `CodeReview` runs on
  forks of the build sandbox or on fresh sandboxes on any chosen provider, with Claude Code and
  Codex reviewers in `parallel()` → fixer `agent()` in the shared sandbox → `Verify` → `ask()` on
  Slack with the decision page before any merge (AFK policy: never merge). Resumable by run id.

## Acceptance tests (the build is done when all pass)

Offline (must pass in CI with no credentials, using `scriptedHarness`, `tmpdirProvider` and emulate):
1. **Review a PR**: `CodeReview` against an emulated GitHub PR returns a typed result; an invalid
   `submit_result` is rejected and retried inside the run.
2. **Spec → PR loop**: `shipChange` runs implement → PR (emulated GitHub, as the App) → review on
   forks with two reviewers on different providers/harnesses → fix → verify → Slack ask (emulated)
   → stops before merge.
3. **Crash + resume**: kill the process mid-run, edit a prompt, resume with the same run id: finished
   calls replay from the journal, the edited call and everything after run live; an interrupted call
   is never silently re-run. On plain Node, and on the Trigger host with a local/mock Trigger.
4. **Slack ask round-trip**: hot wait answered by a button click; cold wait (sandbox parked, session
   resumed with the answer); AFK policy resolution.
5. **Placement**: shared handle, fork, snapshot and cross-provider review all behave per spec.
6. **Provider conformance**: tmpdir passes the full suite offline; Docker, Impello and E2B suites
   exist and are skipped unless their credentials/daemon are present.

Live (written now, gated by env vars, run later when credentials exist): the same five scenarios on
Impello and E2B with real Claude Code and Codex on a private playground repo
(`ray-amjad/selfbuilding-playground`), using subscription credentials first and API keys as
fallback, plus Docker conformance when the daemon is reachable.
