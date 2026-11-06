# Harness: Codex

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { fromEnv, fromFile } from "@selfbuilding/core";
import { codex } from "@selfbuilding/harnesses/codex";

const gpt = codex({
  credentials: [
    { kind: "auth-file", value: fromFile(join(homedir(), ".codex", "auth.json")), leased: true },
    { kind: "api-key", value: fromEnv("OPENAI_API_KEY") },
  ],
});
```

The CLI runs headless inside the sandbox at `/usr/local/bin/codex` (`codex({ binary })` for another absolute
path), at a pinned version. The Codex image also carries the browser that `Verify` drives, so browser work runs on
Codex.

## Credentials

| Kind | Source | Notes |
|---|---|---|
| `auth-file` (`leased: true`) | The `auth.json` that `codex login` writes, read with `fromFile` | A subscription login. Tried first |
| `api-key` | `OPENAI_API_KEY` from your secret manager or `.env` | The fallback |

Both arrive in the sandbox as `~/.codex/auth.json`, a 0600 file owned by the agent user, because Codex runs as
that user and reads the file itself. An API key is written in the shape `codex login --with-api-key` produces, so
no secret is ever in a command line or an environment variable.

## Why a login file is leased

A Codex login is a rotating refresh token. If two sandboxes refreshed the same login at once, the vendor would
revoke the older token and the slower box would lose its credential mid-run. So:

- A login file is leased to one sandbox at a time. A call takes the first credential that is free; when another
  box holds the login, it takes the next free credential in the pool (an API key), or waits for the lease when none
  is free.
- When the call ends, the copy Codex may have rewritten is read back. It is kept for the next call only when it is
  a valid file for the same login; a truncated file, a file for another account or anything that is not a regular
  file is dropped and the previous copy stays in the pool.
- The refreshed copy is kept in the process's pool for later calls. The file on disk is not rewritten, so after a
  long run, `codex login` on your machine again if the original file was refreshed away.

## The credential pool

The order is the same as for every harness: subscription credentials (`auth-file`, `oauth-token`) first, API keys
after, each group in the order you gave. A call moves on only for an account failure (`auth`, `quota`, or a
rate-limited subscription while an API key is waiting) and resumes the same session when it can.

Like the other built-in agents, `Verify` has its own default Codex harness without credentials: pass your harness
value on each call.

## Your plan's terms

You are responsible for using your ChatGPT plan or API account within its provider's terms, including any rules
about automated or shared use. A leased login is still one person's login.
