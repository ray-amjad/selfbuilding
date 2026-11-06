# 0002: Calls on a shared handle stay in the Trigger.dev parent task

Status: accepted, November 2026.

## The question

On the Trigger.dev host every agent call on a fresh box is dispatched as a `selfbuilding.agent` child task: the
child runs launch, wait and collect, and the parent accepts the raw outcome (demo-path §5). A call on a shared handle
(`sandbox()`, `fork()`, a `from:` snapshot) did not follow that path. It ran in the parent task with plain Node
waits, and nothing said so. Release-prep §3.2 item 1 asked for one of two things:

1. dispatch handle calls as children too, with placement `{ kind: "handle", ref, version }`: the child attaches to
   the box by ref and returns the checkpoint, and the parent's handle takes the new version and stays busy for the
   call; or
2. keep them in the parent, and make that explicit.

## What a handle holds

A `SharedSandbox` is more than a box ref. While a call runs on it, the parent's handle object holds:

- **the busy lock.** One call at a time; a second concurrent call fails at once with `SandboxBusyError`. The lock is
  in-process state of the handle.
- **the working tree.** The handle syncs the repo once and keeps the branch, its base and the pushed head between
  calls. Each call's git spec is derived from that state.
- **the checkpoint chain.** After accept, `checkpointLocked()` takes the call's checkpoint while the lock is held, and
  the next call starts from it. Replay restores the same chain from the journal.
- **secrets and credential files.** The handle records every secret value delivered into the box and the
  credential files staged there, and removes those files when the call ends, so no later snapshot or fork keeps
  them.
- **lifetime and disposal.** The handle extends the box's lifetime while a call runs and is disposed by the run.

Dispatching would split each of these across two processes. The child would have to take the lock the parent holds,
apply a git state it did not derive, take a checkpoint the parent then adopts, stage and scrub credentials for a
handle it does not own, and report all of it back, with every step idempotent under child retries and parent
replays. Core's `agentCallDriver` rebuilds a call from `HostAgentCall.spec` for fresh placement only
(`placement: { kind: "fresh" }`). A second writer on a box whose state lives in the parent is the failure mode the
fence and the lock exist to prevent.

## Decision

Keep shared-handle calls in the parent task, and say so:

- On a dispatching host, the first shared-handle call of a run emits one `log` event at `info`: "shared-handle call
  runs in the parent task: …". Later calls in the run do not repeat it. The code is `noteSharedHandleInParent` in
  `packages/core/src/agent/call.ts`.
- `packages/host-trigger/README.md` explains this under "Calls on a shared handle".
- `tests/acceptance/16-trigger-deployed.test.ts` pins it. Two calls on one `sandbox()` handle in a deployed-style run
  start no `selfbuilding.agent` child, share one box, and log the line exactly once.

Fresh-box calls are unchanged. They are dispatched, and their box time, secrets and launch depth now cross the task
boundary (release-prep §3.2 items 5 to 7).

## Consequences

- A shared-handle call's wait is a long poll inside the parent task, so its duration counts against the parent's
  `maxDuration` (300 s of execution per attempt in `createTriggerHost`). Runs whose shared-handle calls can take
  longer should use fresh boxes, which wait on waitpoint tokens, or hand the work across by branch or result.
- If the parent attempt dies during a shared-handle call, the retried attempt replays the run from the result store
  and meets the call's `started` journal entry, as a resumed plain Node run does. That path is the in-process one;
  no offline test drives a crash in the middle of a shared-handle call on this host yet.
- Revisit this when core's driver gains handle placement. The `HostAgentCall` shape already leaves room for
  `{ kind: "handle", ref, version }` in its spec.
