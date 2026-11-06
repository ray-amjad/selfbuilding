# Provider: Impello

Impello runs sandboxes as cloud microVMs from templates, with an E2B-compatible API. Selfbuilding uses the same
adapter for both vendors, so templates, sizes and placement behave as described in
[providers-e2b.md](providers-e2b.md); this page lists what differs.

```ts
import { fromEnv } from "@selfbuilding/core";
import { impello } from "@selfbuilding/sandbox-impello";

export default defineConfig({
  sandbox: impello({
    apiKey: fromEnv("IMPELLO_API_KEY"),
    template: "selfbuilding-codex",
    sizes: ["small", "medium"],
    tier: "plan20",
  }),
});
```

## Account and key

Create an Impello account and an API key. Put it in your secret manager or `.env` as `IMPELLO_API_KEY`. The
provider uses `@impello/sdk`, never the stock E2B client, and never reads the environment itself.

## Templates

The names follow the same rule as E2B: `selfbuilding-<harness>` for `small`, `selfbuilding-<harness>-<size>` for
any other size, and `selfbuilding-all-harnesses` for the template with both harnesses.

```sh
npx selfbuilding images build --provider impello --harness codex --size small,medium
npx selfbuilding images build --provider impello --all-harnesses
```

- **Without a registry**, the template is built from a generated Dockerfile when the Impello SDK can build from
  one. If it cannot, the build is refused with `ImageUnavailableError` naming `SELFBUILDING_IMAGE_REGISTRY` as the
  fix.
- **From a registry**, set `SELFBUILDING_IMAGE_REGISTRY` and the template starts from
  `<registry>/selfbuilding/<harness>:<version>`.
  With the official registry, `ghcr.io/ray-amjad`, this works for `--harness codex` only; build `claude-code` and
  `all-harnesses` without a registry (see `@selfbuilding/images`).

After a build, add the size to `impello({ sizes })`, as the CLI prints.

## Sizes and tiers

Impello has no 8 vCPU pool yet, so any size above 4 vCPU (the built-in `large`) is refused with a fix that says
to use `medium` or run that size on Docker or E2B. Override the limit with `sizeLimits` if your account allows more.

`tier` sets the session maximum, the concurrency and the create rate. The default is `"trial"`, the strictest, so a
call longer than the plan allows fails when it is planned instead of being cut off mid-turn:

| `tier` | Session maximum | Boxes at once | Creates per minute |
|---|---|---|---|
| `"trial"` (default) | 1 h | 2 | 5 |
| `"plan20"` | 12 h | 20 | 12 |
| `"plan100"` | 24 h | 100 | 30 |
| `"plan500"` | 24 h | 300 | 65 |

Other options: `timeout` (a floor for box lifetimes), `limits` (overrides the tier's), `verifyEgress`, `domain`
(default `sandbox.impello.ai`).

## Egress

Impello accepts `allowInternetAccess: false` and allowlists but did not enforce them in our live runs. Turn on
`impello({ verifyEgress: true })` to probe every fresh box with a non-open policy and refuse one that leaks with
`EgressPolicyUnsupportedError`. See [docs/decisions/0001-egress-enforcement.md](../decisions/0001-egress-enforcement.md).

## Tests

The live suite uses `IMPELLO_API_KEY`, `IMPELLO_TEMPLATE`, `IMPELLO_CODEX_TEMPLATE` and `IMPELLO_SIZES`
(`tests/live/README.md`).
