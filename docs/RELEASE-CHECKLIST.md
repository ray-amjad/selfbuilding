# Release checklist

For the first public release, and every release after it. Work top to bottom; a step that fails stops the release.
Steps marked (first release) are done once.

## 1. Decisions the owner makes

- [x] **License (first release).** MIT (`LICENSE`, copied into every package). The CodeReview prompt bodies
      are third-party text kept verbatim and credited to Anthropic in `NOTICE` and in each reference header.
- [ ] **Version.** Pick the version (`0.1.0` for the first release) and confirm `IMAGE_VERSION` in
      `packages/images/src/index.ts` matches it, since image and template tags default to it.

## 2. Secrets and history (first release, then whenever the repo was private in between)

- [ ] **Rotate every credential used during development**: model API keys and subscription tokens, the Codex login
      (`codex login` again), E2B and Impello keys, the GitHub App's private key (generate a new one, delete the old)
      and any PATs, the Slack bot token and signing secret, R2 keys, the Trigger.dev secret key,
      `SELFBUILDING_START_SECRET`. Rotate in the secret manager first, then sync the platforms that read from it.
- [ ] **Scan the whole git history for secrets**: `gitleaks detect --log-opts=--all` (or an equivalent scanner
      over every commit). Any hit is rotated, then removed from history before the repository goes public.
- [ ] **Scan the tree for private details**: `node scripts/check-public.mjs --strict` (strict ignores
      `scripts/check-public.allow`). Set `SELFBUILDING_PUBLIC_DENYLIST` to a local, untracked file of extra
      patterns (account ids and the like) for this run. Strict mode also reports the known fakes that the allow
      file covers (a made-up Slack id in the spec and in a channel-slack test, a made-up Anthropic key in a runtime
      test); review each hit by hand and confirm it is a fake before going on.
- [ ] **Untrack `.infisical.json`** (first release): `git rm --cached .infisical.json`, add it to `.gitignore`, and
      remove its entry from `scripts/check-public.allow`. This takes it out of the tree only; every earlier commit
      still has it, which the next step deals with.
- [ ] Re-read `docs/` and the package READMEs for anything that names a private repository, host, account or
      person.
- [ ] **Scan the whole history for private details**: `node scripts/check-public.mjs --history --strict`. It runs
      the same rules over every line added or removed in every commit on every ref (`git log --all -p`), every
      path, and every commit message, and flags any commit that ever held `.infisical.json` or `.env`. The tree
      scans above read only `git ls-files`, and gitleaks looks for secrets, not names or paths, so neither catches a
      private detail that a later commit removed. The development history has such hits (personal paths, private
      hostnames, names this repository must not carry, `.infisical.json` with its workspace id), so expect it to
      fail.
- [ ] **Publish from a fresh history (first release)** when the history scan has any hit that is not a reviewed
      fake. Rewriting the existing repository is not enough: GitHub keeps pull-request refs and cached views of old
      commits. From the reviewed tree, after the steps above:

      ```sh
      git checkout --orphan public-main
      git commit -m "Selfbuilding <version>"
      git push <new-empty-repo> public-main:main         # push no other branch or tag from the old repository
      git clone <new-empty-repo> /tmp/selfbuilding-public
      cd /tmp/selfbuilding-public && node scripts/check-public.mjs --history --strict   # must pass
      ```

      Run the last check in the fresh clone: in the old clone `--all` still sees the old branches. Keep the old
      repository private, or archive it.

## 3. The tree

- [ ] `pnpm install --frozen-lockfile && pnpm build && pnpm check` on a clean checkout, on Node 22 and Node 24.
- [ ] `node scripts/check-public.mjs --self-test && node scripts/check-public.mjs` pass, and so does
      `node scripts/check-public.mjs --history --strict` on the history being published.
- [ ] The live suite passed against the services listed in `tests/live/README.md` for this release (the owner runs
      it; record the date and the results in `docs/ROADMAP.md`).
- [ ] `docs/ROADMAP.md` and the README status line are current.

## 4. Packages

- [ ] **Flip `"private": true` off** in each `packages/*/package.json` that is published. `tests/*` and `fixtures/*`
      packages stay private.
- [ ] Check each published package's `files` contains `dist` and everything it reads at run time (skill folders,
      Dockerfiles, the Slack manifest, the runtime bundles): `pnpm vitest run tests/acceptance/package-meta.test.ts`.
- [ ] **Changesets.** Every change since the last release has a changeset. `pnpm changeset version` bumps the
      versions (all packages are one fixed group) and writes the changelogs. Commit the result.

## 5. Images

- [ ] Build the official images on a clean machine: `npx selfbuilding images build --provider docker --harness all
      --all-harnesses --tag <version>`. This builds `selfbuilding/claude-code`, `selfbuilding/codex` and
      `selfbuilding/all-harnesses` at that tag (and the base image they start from).
- [ ] **Push `base` and `codex` to the registry**, under the names template builds expect,
      `<registry>/selfbuilding/<harness>:<version>`. Never make `claude-code` or `all-harnesses` public: they contain
      Claude Code, which is not open source, so users build those two themselves.

      ```sh
      for h in base codex; do
        docker tag selfbuilding/$h:<version> <registry>/selfbuilding/$h:<version>
        docker push <registry>/selfbuilding/$h:<version>
      done
      ```

- [ ] Make those two registry packages public, and check that `SELFBUILDING_IMAGE_REGISTRY=<registry> npx selfbuilding
      images build --provider e2b --harness codex --dry-run` resolves them.

## 6. Publish

- [ ] **Publish from CI** (it needs the repository public, for provenance): pushing the tag `v<version>` runs
      `.github/workflows/release.yml`, which needs the `NPM_TOKEN` repository secret, from an account that can
      publish the `@selfbuilding` scope. The steps below describe what it does.
- [ ] Publish in dependency order, leaves first, exactly as `node scripts/publish-order.mjs` prints it (it starts
      with `@selfbuilding/runtime`, which bundles its dependencies, then `@selfbuilding/skills` and
      `@selfbuilding/core`, and ends with `selfbuilding`, the CLI). With pnpm:
      `pnpm --filter <name> publish --access public` for each name in that order, or `pnpm changeset publish`,
      which follows the same graph. Never plain `npm publish`: packages depend on each other through `workspace:*`,
      which only pnpm and changesets rewrite to real versions. Packages carry `publishConfig: { access: "public", provenance: true }`, so
      publish from CI or with provenance available.
- [ ] Smoke test from npm in an empty folder: install, `npx selfbuilding init` with flags, `npx selfbuilding
      doctor`.

## 7. Tag and announce

- [ ] Tag the release commit `v<version>` and push the tag.
- [ ] Write the release notes from the changelogs: what works, what is pre-release, what changed since the last
      release, and the known gaps from `docs/ROADMAP.md`. Keep them factual.
- [ ] Turn on GitHub private vulnerability reporting for the repository (SECURITY.md and CODE_OF_CONDUCT.md point
      at it), then make the repository public (first release).
