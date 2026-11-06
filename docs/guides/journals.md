# Journals

Every finished step of a run (an agent call, a `step()`, a sandbox mutation, a clock read) is written to the
journal, keyed by the run id and the step's key. Resuming a run replays the body: steps found in the journal return
their recorded value without running again, and the first step not found runs live. That is what makes a crashed,
cancelled or exited run resumable with `selfbuilding resume <runId>`.

A journal also holds a lease per run, so two processes never drive the same run at once. Each takeover increases
the run's epoch, and a write from a process that lost its lease fails with `LeaseLostError`. The ask store and the
result store live next to it (`journal.asks`, `journal.results`).

On Trigger.dev the result store is the journal (see [trigger-dev.md](trigger-dev.md)); the options below are for
the plain Node host.

## fileJournal (the default)

```ts
journal: fileJournal(".selfbuilding/journal"),
```

`selfbuilding init` writes this. It is a directory of JSON files: entries per run, a lease file per run, asks and
results. It needs nothing installed and is easy to inspect or delete. It is the right choice for one process at a
time on one machine.

## sqliteJournal

```ts
import { sqliteJournal } from "@selfbuilding/core";

journal: sqliteJournal(".selfbuilding/journal.db", { busyTimeoutMs: 5000 }),
```

One SQLite file holding entries, leases, asks and results, with the same behaviour as `fileJournal`: one live
lease per run, a strictly increasing epoch, compare-and-set writes. Use it when several processes on one machine
share runs (a `selfbuilding run`, the hooks handler answering asks, `selfbuilding reap` on a timer).

- It uses Node's built-in `node:sqlite`, so it needs Node 22.13 or later. On an older Node the first call throws a
  `ConfigError` saying to use `fileJournal` or upgrade.
- The file opens in WAL mode. Every read-then-write runs in one immediate transaction, so a writer that lost its
  lease fails with `LeaseLostError` even inside that window.
- When another process holds the write lock for longer than `busyTimeoutMs` (default 5000), the call throws
  `JournalConflictError` naming the file and the timeout.
- **Local disks only.** Do not put the file on a network filesystem (NFS, SMB, a synced folder): SQLite's locking
  is not reliable there, and two machines writing one file can corrupt it. For runs spread over machines, use a
  durable host with a shared result store.
- The journal holds what `fileJournal` holds: results and step values, never a secret.

`selfbuilding init` keeps `fileJournal` as the default and adds a comment pointing at `sqliteJournal`. Its
`.selfbuilding/.gitignore` ignores `journal.db*` as well as the journal folder.

## Moving runs from files to SQLite

```sh
npx selfbuilding journal import .selfbuilding/journal .selfbuilding/journal.db
```

`selfbuilding journal import <file-journal-dir> <db> [--json]` copies every run's entries (in order), asks and
results into the SQLite file, creating it if needed. Each run is imported in its own transaction.

- Leases are not copied: an imported run is resumed later with a fresh lease. A run whose lease is still live in
  the source is refused and nothing is written for it; stop or finish that run first.
- It is idempotent. A row that already exists with the same JSON is skipped; one that exists with different JSON
  is a conflict for that run.
- Output is one line per run, `ok   <runId>  <n> entries  <n> asks  <n> results` or `fail <runId>  <reason>`
  (`--json`: one object per run). Exit code 0 when every run was imported or skipped, 1 on any conflict or refusal,
  2 on a usage error.

Then point the config at the new file. Keep the old folder until the imported runs resumed correctly.

## Version

Both journals store a format number. A journal written by an incompatible version throws `JournalVersionError`
instead of being misread.
