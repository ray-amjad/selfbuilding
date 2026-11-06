# Provider: E2B

E2B runs each sandbox as a cloud microVM started from a template. Selfbuilding builds the templates for you and
names them after the harness and size.

```ts
import { fromEnv } from "@selfbuilding/core";
import { e2b } from "@selfbuilding/sandbox-e2b";

export default defineConfig({
  sandbox: e2b({
    apiKey: fromEnv("E2B_API_KEY"),
    template: "selfbuilding-codex",
    sizes: ["small", "medium"], // the sizes whose template you built
  }),
});
```

## Account and key

Create an E2B account and an API key in its dashboard. Put the key in your secret manager or `.env` as
`E2B_API_KEY`. The provider never reads the environment itself: the config passes the key with `fromEnv`, and the
CLI's `images build` reads `E2B_API_KEY` from the environment (after `--env-file`). The key is never printed.

## Templates

A template is fixed at build time, including its size, so there is one template per harness and size:

| Size | Template |
|---|---|
| `small` | `selfbuilding-claude-code`, `selfbuilding-codex`, `selfbuilding-all-harnesses` |
| any other | the same name plus `-<size>`, e.g. `selfbuilding-codex-medium` |

Pass the small name as `template`; the provider picks the sized one for a call that asks for a size. Build them:

```sh
npx selfbuilding images build --provider e2b --harness codex --size small,medium
npx selfbuilding images build --provider e2b --all-harnesses --size small,medium
npx selfbuilding images build --provider e2b --size all --dry-run      # print what would be built
```

Each build prints one line saying which path it took, and after a build the CLI prints the option to add, for
example `Add "medium" to e2b({ sizes })`. A template carries the harness binaries of its image only, so choose one
whose image has every harness the calls on it use: `selfbuilding-all-harnesses` has Claude Code and Codex, the
browser and `sqlite3`.

Two ways to build:

- **Without a registry** (the default): the template is built from a Dockerfile generated from the official image
  definition, so nothing has to be published first.
- **From a registry**: set `SELFBUILDING_IMAGE_REGISTRY` (for example `ghcr.io/acme`) and the template starts from
  the published image `<registry>/selfbuilding/<harness>:<version>`. Use this when you publish your own images
  (see `docs/RELEASE-CHECKLIST.md`).
  With the official registry, `ghcr.io/ray-amjad`, this works for `--harness codex` only; build `claude-code` and
  `all-harnesses` without a registry (see `@selfbuilding/images`).

`--tag` sets the version (default: the Selfbuilding version). Builds run one at a time per provider, to stay under
the vendor's rate limits.

## Sizes and plans

`e2b({ plan })` sets the size limits: `"hobby"` (the default) allows 8 vCPU and 8 GiB per sandbox, so the built-in
`large` (8 vCPU, 16 GiB) is refused with a fix that names `e2b({ plan: "pro" })`; `"pro"` allows 8 vCPU. Override
the numbers with `sizeLimits`. A size whose template is not listed in `sizes` is refused with the exact
`selfbuilding images build` command to run. Forks keep the parent's size: ask for the size when you create the
parent box. See [sizes-and-templates.md](sizes-and-templates.md).

## Options

| Option | Default | Meaning |
|---|---|---|
| `apiKey` | required | The E2B key, e.g. `fromEnv("E2B_API_KEY")` |
| `template` | required | The small template name, e.g. `"selfbuilding-codex"` |
| `sizes` | `["small"]` | Size names whose template you built |
| `plan` | `"hobby"` | Size limits per plan |
| `tier` | `plan` | Session maximum and concurrency per plan (1 h and 20 boxes on hobby, 24 h and 100 on pro) |
| `sizeLimits` | the plan's | Overrides the size limits |
| `timeout` | none | A floor for every box lifetime, e.g. `"45m"` |
| `verifyEgress` | `false` | Probe each new box with a non-open egress policy, and refuse one that leaks |
| `domain` | `e2b.app` | API domain |

## Egress

A box created with `"deny-all"` or an allowlist may still reach the internet: the vendor accepts the policy and
did not enforce it in our live runs. With `verifyEgress: true`, every fresh box with a policy other than `"open"`
is probed before it is handed out, and one that leaks is killed and refused with `EgressPolicyUnsupportedError`.
The probe adds a few seconds to each create. Read
[docs/decisions/0001-egress-enforcement.md](../decisions/0001-egress-enforcement.md) before relying on a policy to
keep anything in. Secrets are never placed in a box as a defence anyway: they reach it only as 0600 files.

## Rate limits

Creates back off with full jitter when E2B answers with a quota error. The live conformance suite keeps
`SELFBUILDING_LIVE_CONCURRENCY` (default 2) create calls in flight.

## Tests

The offline tests run against a fake SDK. The live suite (`tests/live/README.md`) uses `E2B_API_KEY`,
`E2B_TEMPLATE`, `E2B_CODEX_TEMPLATE`, `E2B_SIZES` and `E2B_PLAN`.
