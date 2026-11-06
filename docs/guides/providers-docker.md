# Provider: Docker

Docker runs sandboxes as containers on your machine or a server you control. It needs no account and no API key,
which makes it the quickest way to try Selfbuilding and the usual choice for CI.

```ts
import { docker } from "@selfbuilding/sandbox-docker";

export default defineConfig({ sandbox: docker(), /* ... */ });
```

## Access to the daemon

The provider talks to the Docker Engine API over the local socket. The user that runs Selfbuilding must be able to
use it: on Linux, add that user to the `docker` group and log in again. Pass `docker({ socketPath })` for another
socket. `selfbuilding doctor` reports a daemon it cannot reach.

## Images

Boxes start from the official images, `selfbuilding/<harness>:<version>` (`selfbuilding/claude-code`,
`selfbuilding/codex`, and `selfbuilding/all-harnesses`, which carries both CLIs). Docker has one image per harness,
not one per size: the size is applied when the container is created.

Build them locally once:

```sh
npx selfbuilding images build --provider docker                    # both harnesses
npx selfbuilding images build --provider docker --harness codex
npx selfbuilding images build --provider docker --all-harnesses     # selfbuilding/all-harnesses only
```

The build prints `docker sizes at create; built once` and builds each image once, whatever `--size` says. The
agent user inside the image gets this machine's UID and GID, so files in a bind-mounted worktree keep sane owners.
`docker({ build: true })` does the same lazily: it builds a missing official image on first use instead of pulling
it. `docker({ image })` uses your own image for every box that is not restored from a snapshot.

The Codex and all-harnesses images carry headless Chromium, Playwright, the browser MCP server and `sqlite3`, which
`Verify` needs. The Claude Code image has no browser.

## Options

| Option | Default | Meaning |
|---|---|---|
| `image` | the official image for the call's harness | Use this image for every fresh box |
| `build` | `false` | Build a missing official image locally instead of pulling it |
| `mount`, `worktree` | `"isolated"` | `"worktree"` bind-mounts the absolute path `worktree` at the workdir for fast local loops; snapshot and fork are refused in that mode |
| `socketPath` | the local daemon | Docker socket |
| `maxVcpu`, `maxMemoryMiB` | no cap | The largest box this host may create; a bigger size fails with `SizeUnavailableError` |
| `limits` | 7-day session cap | Provider limits (lifetime horizon for the reaper) |
| `deadlineMs` | 120 s | One deadline for `openOrCreate` and `open`, retries included |

## Sizes

Docker sizes boxes at create time from the size table (`small` 2 vCPU / 4 GiB, `medium` 4 / 8, `large` 8 / 16, plus
any in your config). Forks may take another size than their parent: a fork commits the parent once and starts each
child from that image at the size you ask for (`box.fork(2, { size: "large" })`). Cap what one box may take on a
small host:

```ts
docker({ maxVcpu: 4, maxMemoryMiB: 8192 }); // "large" is refused, naming this option as the fix
```

See [sizes-and-templates.md](sizes-and-templates.md).

## Egress

Docker enforces the policy itself. `"open"` is the default; `"deny-all"` starts the container with no network at
all. An allowlist (`{ allow: [...] }`) is refused with `EgressPolicyUnsupportedError`, because plain Docker cannot
filter by host. For how the cloud providers differ, see
[docs/decisions/0001-egress-enforcement.md](../decisions/0001-egress-enforcement.md).

## Secrets

Credentials are written as 0600 files under `/run/selfbuilding`, which is an anonymous volume, so they never end up
in a snapshot or fork image. Nothing secret is passed as a container environment variable.

## Tests

`pnpm vitest run packages/sandbox-docker` runs offline against an in-memory daemon. The conformance and placement
suites run against a real daemon only with `SELFBUILDING_E2E_DOCKER=1` (and `SELFBUILDING_DOCKER_SOCKET` to point
elsewhere).
