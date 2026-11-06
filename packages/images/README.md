# @selfbuilding/images

`defineImage` and the official image definitions. `docker/*/Dockerfile` are generated from them; regenerate with
`SELFBUILDING_UPDATE_DOCKERFILES=1 pnpm vitest run packages/images`.

| Image | Adds |
| --- | --- |
| `selfbuilding-base` | Debian bookworm, Node 22, git, gh, pnpm, bun, the agent user and the sandbox layout |
| `selfbuilding-claude-code` | the pinned Claude Code CLI |
| `selfbuilding-codex` | the pinned Codex CLI, headless Chromium, Playwright (`PLAYWRIGHT_VERSION`), the browser MCP server (`PLAYWRIGHT_MCP_VERSION`, at `/usr/local/bin/playwright-mcp`) and `sqlite3` |
| `selfbuilding-all-harnesses` | both pinned harness CLIs and everything the Codex image adds, so one template serves calls on either harness |

`selfbuilding images build --all-harnesses` (or `--harness all-harnesses`) builds the combined image; `--harness all`
still means each harness separately.

## Published images

`ghcr.io/ray-amjad/selfbuilding/base` and `ghcr.io/ray-amjad/selfbuilding/codex` are public. The `claude-code` and
`all-harnesses` images are not published, because they contain Claude Code, which is not open source: build them
yourself with `selfbuilding images build`, which installs it on your machine or your template vendor's build. No
image has to be pulled from a registry unless you set `SELFBUILDING_IMAGE_REGISTRY`.

## Templates without a registry

Template vendors cannot pull `selfbuilding/<image>:<tag>` until someone publishes it. `toStandaloneDockerfile(def)`
renders an image and every parent it is built from as one Dockerfile: a single `FROM`, no `ARG` (the agent user's
uid and gid are written in, default 1000), only the leaf's manifest, and every parent's verify kept. With
`SELFBUILDING_IMAGE_REGISTRY` unset, `selfbuilding images build --provider e2b|impello` builds each template from
that Dockerfile; set it to build from published images instead.

Vendor Dockerfile parsers are not Docker's:

- **ENV.** They keep quotes as part of a value (`ENV A="/x"` sets `"/x"`), so both renderers write a value bare when
  it needs no quotes. The standalone renderer refuses a value with spaces, quotes, `$` or backslashes.
- **RUN.** One drops backslashes and collapses runs of whitespace in shell-form `RUN`. A standalone `RUN` that would
  change is written as `sh -euc "$(echo <base64> | base64 -d)"`, which every parser passes through untouched.

## The browser

- **Size.** `medium` (4 vCPU, 8 GiB) is the minimum for browser work (`BROWSER_MIN_SIZE`). The `small` Codex
  template still carries the browser, but Chromium next to a dev server runs out of memory there.
- **MCP server.** Add `BROWSER_MCP_SERVER` to a call's `mcpServers`. It runs headless, with an in-memory profile, and
  writes screenshots to `/selfbuilding/out/files/verify`. `--no-sandbox` is passed only there, never image-wide.
- **Scripts.** `import("playwright")` and `require("playwright")` resolve from the work and output trees, and the
  browsers are found without `PLAYWRIGHT_BROWSERS_PATH`. The runtime starts the agent with a bare environment, so
  nothing relies on image `ENV`. Pass `--no-sandbox` when a script launches Chromium itself.
- **Check.** The image build ends by launching Chromium as the agent user. `BROWSER_LAUNCH_CHECK` repeats that
  check in a running box.
