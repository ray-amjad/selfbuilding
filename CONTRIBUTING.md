# Contributing

Thanks for helping. This file covers how the repository is laid out, how to check a change, and the few rules
every change follows.

## Setup

Node 22.12 or later (`.nvmrc`) and pnpm. Use pnpm only: never npm or yarn in this repository, because the
workspace and the lockfile are pnpm's.

```sh
pnpm install
pnpm build                       # every package: tsup emits JS, tsc -b emits .d.ts
pnpm check                       # biome check + typecheck + tests; run it before every commit
pnpm vitest run packages/core    # one package
pnpm lint                        # biome lint only
```

`pnpm check` must pass with no network, no Docker and no credentials. CI runs the same on Node 22 and 24, then
`node scripts/check-public.mjs`, which fails on anything private in tracked files (personal paths, private
hostnames, tokens, account ids). Run it yourself before you open a PR.

## Layout

ESM-only TypeScript packages under `packages/`, TypeScript strict, `.js` extensions on relative imports.

| Path | What |
|---|---|
| `packages/core` | The primitives, the plain Node host, journals, errors, and every public type (`src/types/`) |
| `packages/agents` | The built-in agents and their skill folders, `shipChange`, `verifyFlows` |
| `packages/harnesses` | Claude Code and Codex |
| `packages/sandbox-*` | Providers (Docker, E2B, Impello) and the conformance suite |
| `packages/host-trigger`, `hooks`, `channel-*`, `artifacts-s3`, `script`, `images`, `runtime`, `cli`, `testing` | The rest, one concern each |
| `tests/acceptance` | Offline end-to-end tests; they always run |
| `tests/live` | The same scenarios against real services, skipped unless their variables are set |
| `docs/` | Guides (`docs/guides/`), the design (`docs/spec/`), decisions (`docs/decisions/`), the roadmap |

`docs/BASIC-SCOPE.md` says what is in the current version, and wins over `docs/spec/selfbuilding-v1-spec.md`, the
full design. Public names, error names and option keys follow the spec exactly. `CONTEXT.md` is the glossary: use
its terms, and avoid the words it lists.

## Module ownership

`docs/BUILD-MAP.md` lists which module owns which files and where the boundaries between packages are. Keep a
change inside the modules it is about. Shared files take additions only, never renames or removals: the root
configs, every `package.json`, `packages/core/src/index.ts` and `packages/core/src/types/`. Public types live in
`packages/core/src/types/` and are imported from `@selfbuilding/core`; no third-party types appear in a public
`.d.ts`.

## Errors

Every thrown error is a `SelfbuildingError` subclass with a `code` and a `recovery`, and every class has a row in
`packages/core/src/errors/registry.ts`. A new class without a row fails the registry test. Messages say what to do
next, not only what went wrong.

## Tests

- **Offline first.** Every behaviour has an offline test, using `scriptedHarness`, `tmpdirProvider` and the
  emulated GitHub and Slack from `@selfbuilding/testing`.
- **Gated live tests.** A test that needs Docker, the network or real credentials checks an environment variable
  and skips cleanly without it, for example `describe.skipIf(!process.env.SELFBUILDING_E2E_DOCKER)`. Live variables
  are listed in `tests/live/README.md`.
- **Never read or print a real credential** in a test, a log or an error message. Use obviously fake values
  (`sk-ant-test-…`, `xoxb-test-…`). Secrets reach a sandbox only as 0600 files, never environment variables or
  images.
- New tests go in new files unless they extend an existing case table.

## Code and docs

- Comment only the non-obvious why.
- Describe Selfbuilding on its own terms in code, comments, docs and commit messages.
- Stubs throw `NotImplementedError` through the package's `not-implemented.ts`; delete that file once the package
  no longer uses it.

## Commits and pull requests

- Small, coherent commits, each passing `pnpm check`. Imperative subject with a scope:
  `fix(sandbox-e2b): wait out a 409 while a box is still pausing`.
- A change to a published package gets a changeset (`pnpm changeset`).
- Open a pull request against `main`; CI must pass.

## Releases

Releases are cut by the maintainers from `docs/RELEASE-CHECKLIST.md`. Packages are published in dependency order,
leaves first, as printed by `node scripts/publish-order.mjs`; it starts with `@selfbuilding/runtime`,
`@selfbuilding/skills` and `@selfbuilding/core` and ends with `selfbuilding`, the CLI. Publish with pnpm or
changesets, never plain `npm publish`, so `workspace:*` dependencies become real versions.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
