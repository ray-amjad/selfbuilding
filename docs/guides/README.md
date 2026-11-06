# Guides

Read them in this order. Each guide covers one thing. The design behind them is in `docs/spec/`, and the words
they use are defined in `CONTEXT.md`.

Every secret named below goes in your secret manager or in a local `.env` that is never committed. The guides list
variable names only. Selfbuilding reads a secret when a call needs it, never prints it, and hands it to a sandbox
only as a 0600 file.

## 1. Set up

1. A provider, where sandboxes run: [Docker](providers-docker.md) (local), [E2B](providers-e2b.md) or
   [Impello](providers-impello.md) (cloud).
2. A harness, the coding-agent CLI that runs inside the sandbox: [Claude Code](harness-claude-code.md) or
   [Codex](harness-codex.md).
3. GitHub, so agents can clone and the host can push and open PRs: [the GitHub App](github-app.md).
4. Optional: [a Slack app](slack-app.md) for questions and run summaries.
5. Optional: [Trigger.dev](trigger-dev.md) to run workflows off your machine, and [R2 or S3](artifacts-r2-s3.md)
   for evidence and other artifacts.

`selfbuilding doctor` checks the config and every credential it names, and reports everything missing at once.

## 2. Concepts

- [Sizes and templates](sizes-and-templates.md): `small`, `medium`, `large` and your own, and why a size can be
  refused.
- [Journals](journals.md): how runs resume; the file journal and the SQLite journal.

## 3. Write workflows

- [Writing a factory](writing-a-factory.md): `factory`, agents, placement, budget, resume.
- [Writing a workflow script](writing-a-workflow-script.md): the same in a plain ES module that runs in an isolate.
- [Agent-launched workflows](agent-launched-workflows.md): an agent starts a script as a new run, within your caps.
- [Verifying flows](verifying-flows.md): `FindFlows`, `Verify` and `verifyFlows`, with evidence per flow.

## 4. A worked example

[tests/live/task-lifecycle](../../tests/live/task-lifecycle/README.md): one builder, a PR, up to two review rounds
with two harnesses, browser verification of each flow, and a question before any merge, written as a workflow
script.
