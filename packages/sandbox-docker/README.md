# @selfbuilding/sandbox-docker

The Docker sandbox provider: local development, CI and the reference adapter for the provider contract.

```ts
import { docker } from "@selfbuilding/sandbox-docker";

const provider = docker({ build: true }); // builds selfbuilding/<harness>:<version> locally with your UID
```

| Option | Default | Meaning |
|---|---|---|
| `image` | the spec's image | Use this image for every box that is not restored from a snapshot |
| `build` | `false` | Build a missing official image locally (agent UID/GID = this machine's user) instead of pulling it |
| `mount` / `worktree` | `"isolated"` | `"worktree"` bind-mounts `worktree` at `/selfbuilding/work`; `.git/config`, `hooks` and `info` are read-only. Snapshot and fork are refused in this mode |
| `socketPath` | the local daemon | Docker socket |
| `deadlineMs` | 120 s | One deadline for `openOrCreate`/`open`, retries included |
| `probeBudgetMs` | 20 s | First-pass budget per ref when converging ghost refs |
| `limits` | 7-day session cap, `expireKeeps: "filesystem"` | Provider limits |

How the contract maps onto Docker:

- A box is a container running `sleep infinity` under `docker-init`, named `<sandbox name>.<deployment>` so the
  daemon's unique-name rule makes `openOrCreate` atomic per key. `/run/selfbuilding` and `/tmp` are anonymous volumes,
  so secrets never land in a snapshot image.
- `find`/`list` use label filters only and never wake anything. The key's scope and other adapter-private values live
  in `sandbox-docker.*` labels and surface as `ref.meta`, never as `ref.labels`.
- `pause` is the cgroup freezer (memory kept). `open` unpauses, or starts a stopped box (filesystem only), then probes
  the guest until it answers.
- `exec` runs with `Tty: false` and demultiplexed streams; the deadline is enforced inside the box by GNU `timeout`.
  `spawn` uses the detached `setsid nohup` shim; `attach` reads the log by byte offset.
- Files move as tar streams through the archive API; owner and mode are set explicitly afterwards.
- Docker has no TTL and container labels are immutable, so `extendLifetime` writes the lease to
  `/selfbuilding/state/expires-at`; `find`/`list` report it as `selfbuilding.expiresAt` for the reaper.
- `snapshot` is `docker commit` (filesystem). `fork` commits the parent once and boots each child from that image.

Tests: `pnpm vitest run packages/sandbox-docker` runs offline against an in-memory daemon. The conformance and
placement suites run only with `SELFBUILDING_E2E_DOCKER=1` and a reachable daemon (`SELFBUILDING_DOCKER_SOCKET` to
point elsewhere); `SELFBUILDING_E2E_DOCKER_IMAGES=1` also checks the Claude Code image.
