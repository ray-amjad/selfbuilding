# Harness: Claude Code

```ts
import { fromEnv } from "@selfbuilding/core";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";

const claude = claudeCode({
  model: "<model id>", // optional; passed to the CLI unchanged
  credentials: [
    { kind: "oauth-token", value: fromEnv("CLAUDE_CODE_OAUTH_TOKEN") },
    { kind: "api-key", value: fromEnv("ANTHROPIC_API_KEY") },
  ],
});

export default defineConfig({ harness: claude, /* ... */ });
```

The CLI runs headless inside the sandbox at `/usr/local/bin/claude`, where the official images install it
(`claudeCode({ binary })` for another absolute path). Its version is pinned (`version: "tested"`, the default), and
the stream parser is tested against that version.

## Credentials

Put the values in your secret manager or `.env`; list only the ones you use.

| Kind | Variable | Where it comes from |
|---|---|---|
| `oauth-token` | `CLAUDE_CODE_OAUTH_TOKEN` | A long-lived subscription token from `claude setup-token` |
| `api-key` | `ANTHROPIC_API_KEY` | An API key from the Anthropic console |

Each credential reaches the sandbox as a 0600 file under `/run/selfbuilding/secrets/`. The runtime reads it into
the harness process's environment only, so it never appears in a command line, the provider's environment or an
image. An OAuth token and an API key are never set together: each mode strips the other's variables, because an
API key in the environment would silently win. A token passed as the wrong kind (an `sk-ant-api…` value as
`oauth-token`, or the reverse) fails when the call is planned, with a message saying which kind to use.

## The credential pool

`credentials` takes one credential or a list. The list is a pool, tried in this order:

1. Subscription credentials (`oauth-token`) first, in the order you gave them.
2. API keys after them.

A run pins one credential so prompt caches stay warm, and moves to the next only on an account failure: an `auth`
or `quota` failure on any credential, or a rate limit on a subscription (its usage cap outlasts the CLI's own
retries) when an API key is waiting. A switch resumes the same session and emits `agent.credential_switched`.
Provider errors and bare 403s stay on the same credential.

## Pass the harness to the built-in agents

`ImplementSpec`, `FindFlows` and `Verify` carry their own default harness, which has no credentials. Pass yours on
each call (`{ harness: claude }`), or wrap the built-in factories with `createShipChange` / `createVerifyFlows`
and give them your harness values. `CodeReview` has no default harness and uses `config.harness`.

## Your plan's terms

Selfbuilding runs the CLI you configure with the credential you give it. You are responsible for using your
subscription or API account within its provider's terms, including any rules about automated or shared use.
