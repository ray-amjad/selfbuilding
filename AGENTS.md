# Working in this repo

selfbuilding is a pnpm monorepo of ESM-only TypeScript packages under `packages/`. Read these first:

- `docs/BASIC-SCOPE.md`: what the basic version includes. It wins over the spec.
- `docs/spec/selfbuilding-v1-spec.md`: the full design. Public names, error names and option keys follow it exactly.
- `docs/BUILD-MAP.md`: who owns which module, module boundaries, and the runtime-host contract.
- `CONTEXT.md`: the glossary. Use its terms; avoid the words it lists.

## Commands

```sh
pnpm install          # never npm or yarn
pnpm build            # every package: tsup emits JS, tsc -b emits .d.ts
pnpm typecheck        # tsc -b plus the test files
pnpm test             # vitest across all packages
pnpm lint             # biome lint
pnpm check            # biome check + typecheck + test; run before every commit
pnpm vitest run packages/core   # one package
```

## Rules

- Node >= 22.12, TypeScript strict, ESM only, `.js` extensions on relative imports.
- Stay inside the modules you own (see BUILD-MAP). Shared files (root configs, every `package.json`,
  `packages/core/src/index.ts`, `packages/core/src/types/`) take additions only; never rename or remove.
- Public types live in `packages/core/src/types/`. Import them from `@selfbuilding/core`. No third-party
  types in public `.d.ts` files.
- Every thrown error is a `SelfbuildingError` subclass listed in `packages/core/src/errors/registry.ts`.
  A new class needs a registry row; a test enforces it.
- Stubs throw `NotImplementedError` through the package's internal `not-implemented.ts`. Replace stubs;
  delete that file once your package no longer uses it.
- Everything must be provable offline. Tests that need Docker, network or real credentials check an env
  var and skip cleanly (`describe.skipIf(!process.env.SELFBUILDING_E2E_DOCKER)`).
- Never read or print real credentials. Secrets reach a sandbox only as 0600 files.
- Comment only the non-obvious why. Never name or mention any product the design was inspired by, and
  never copy from `ref/` (read-only reference, git-ignored).
- Commits: small and coherent; never push.
