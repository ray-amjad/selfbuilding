# @selfbuilding/testing

The offline test kit: everything here runs with no model, no Docker daemon, no credentials and no network beyond
localhost.

## `tmpdirProvider()`

A full `SandboxProvider` backed by temp directories and local child processes.

- Each box is a directory, `<fsRoot>/<sandboxId>`, standing in for `/`. Execs run `/bin/sh -c` with that box's root
  in `SELFBUILDING_FS_ROOT` (always the box's own root, whatever the host passed), `HOME=/selfbuilding/home` and
  `TMPDIR=/tmp` mapped into the box, and none of the host's environment except `PATH`.
- Canonical paths (`/selfbuilding/...`, `/run/selfbuilding/...`, `/tmp/...`) in commands, `cwd`, `readFile` and
  `writeFiles` are mapped into the box. Write commands with the canonical paths, exactly as for a real box.
- `pause` sends SIGSTOP to every process group the box started and `open` sends SIGCONT (`expireKeeps: "memory"`).
  Handle calls on a paused box throw `SandboxUnavailableError`; reopen with `provider.open(ref)`.
- `snapshot` copies the box (`snap-...` ids; create a box from one with `image.ref = snapshotId`), `fork` copies it
  per child. Both skip `/run` and `/tmp`, so secrets never land in a copy. Fork children are keyed
  `<parent scope>/fork[<index>]` and labelled `selfbuilding.parent`.
- Lifetimes are enforced lazily: an expired box is paused or killed (per `onExpire`) on the next provider call.
- Fault injection: `provider.faults.inject(kind, op, { times })` with kinds `503`, `network`, `timeout` (the call
  takes effect, then the response is lost), `429`, `401`, `refuse` (pause only). `provider.ghost(ref, kind)` leaves
  the listing row and removes the box.
- Two providers given the same `root` see the same boxes, like two processes talking to one vendor.
- Call `close()` (or `await using`) to kill every box and remove the root.

## `scriptedHarness(script, opts)`

A real `Harness` whose CLI is a small node player shipped into the box by `prepare()`. It replays scripted steps
(`scripted.*` builders: `say`, `sh`, `submit`, `invalidThenValid`, `askHuman`, `notifyHuman`, `crash`,
`hangUntilCancelled`, `error`), runs shell steps for real, sends tool calls through the `selfbuilding` MCP server
from `PrepareContext.mcpServers` (or the tool socket with `toolTransport: "socket"`), and prints Claude Code or Codex
native stream JSON (`format`). Follow-up turns (resumes, ask answers) take `opts.turns` in order. A script can be a
function of `{ runId, callPath, attempt }`, so one harness value can play a different script per agent call.

`runHarnessTurn(box, harness)` plays one turn without the runtime, for harness and fixture tests.

## Emulators

`startGitHubEmulator()` and `startSlackEmulator()` start emulate.dev (pinned `emulate@0.13.0`) with the spec seeds.
`seedPlayground(gh)` builds a local bare repo (the git remote: the emulator has no smart HTTP) and mirrors it into the
emulator; `openPlaygroundPr()` commits a branch, mirrors it and opens a PR. `mirrorRefs()` copies any pushed refs.

## Golden streams

`toGoldenJsonl(events, { roots })` normalises volatile values (`<sandbox:1>`, `<session:1>`, `<time>`, `<usd>`, ...)
for `expect(...).toMatchFileSnapshot("__golden__/<name>.jsonl")`.
