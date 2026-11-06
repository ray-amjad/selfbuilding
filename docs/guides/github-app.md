# GitHub: the App broker

Agents clone, and the host pushes and opens pull requests, through a git credential broker. The recommended broker
is a GitHub App: it mints short-lived installation tokens scoped to one repository. The agent in the sandbox gets a
read-only token; only the host, outside the sandbox, ever holds a token that can write.

```ts
import { githubApp } from "@selfbuilding/channel-github";
import { fromEnv, fromFile } from "@selfbuilding/core";

export default defineConfig({
  git: githubApp({
    appId: Number(process.env.GITHUB_APP_ID),
    // fromFile() takes an absolute path or a file: URL; this resolves a relative one against the config file.
    privateKey: fromFile(new URL(process.env.GITHUB_APP_PRIVATE_KEY_FILE ?? "./github-app.pem", import.meta.url).href),
  }),
});
```

## 1. Create the App

On GitHub: Settings > Developer settings > GitHub Apps > New GitHub App (under your user or your organisation).

- **Name and homepage:** anything. The App's bot user is the author of every PR it opens.
- **Webhook:** turn it off. Selfbuilding does not receive GitHub webhooks.
- **Repository permissions:**

  | Permission | Access | Used for |
  |---|---|---|
  | Contents | Read and write | Agents clone with read; the host pushes `selfbuilding/*` branches |
  | Pull requests | Read and write | Open and update PRs; read and edit them from workflows (`sb.pr`) |
  | Issues | Read and write | Labels on PRs and PR comments |
  | Metadata | Read | Required by GitHub; also reads the repository's rulesets |

  Leave everything else at "No access". Without Workflows permission, GitHub refuses any push that changes
  `.github/workflows/`, which is what you want from an agent.
- **Where can it be installed:** only this account, unless you mean to share it.

Create it, note the **App ID**, and generate a **private key** (a `.pem` file). Keep the key in your secret manager,
or as a file outside the repository that only you can read; pass it with `fromFile(<absolute path or file: URL>)` or
`fromEnv("<name>")`. The names the live suite uses are `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE`.

## 2. Install it

From the App's page, Install App > choose the account > Only select repositories > pick the repositories your
workflows may touch. The installation is looked up per repository, so one App installed on several accounts works
without configuration; pass `installationId` to pin one.

## 3. Protect everything outside `selfbuilding/*`

A GitHub token cannot be limited to a branch prefix, so the App's write access is safe only when a ruleset stops it
from writing anywhere else. By default (`requireRuleset: true`) the broker refuses to mint a push token until it
can see such a ruleset, and throws `UnprotectedRepoError` instead.

In the repository: Settings > Rules > Rulesets > New ruleset > New branch ruleset.

- **Enforcement status:** Active.
- **Bypass list:** your maintainers (for example the Repository admin role) if they push directly. Never the App.
- **Target branches:** include all branches; exclude by pattern `selfbuilding/**`.
- **Rules:** Restrict creations, Restrict updates, Restrict deletions.

Several rulesets may share the work: the check passes when the active branch rulesets that target every branch,
exclude nothing outside `refs/heads/selfbuilding/`, and do not let the App bypass them, together restrict creation,
update and deletion. Check it from your machine:

```sh
npx selfbuilding doctor --repo <owner>/<name>
```

On its side, the host only ever pushes `refs/heads/selfbuilding/**` and `refs/selfbuilding/**` (checkpoints), and
refuses any other ref before contacting GitHub unless you list it in a call's `git.allowPushTo`.

## `githubApp()` options

| Option | Default | Meaning |
|---|---|---|
| `appId` | required | The App's numeric id |
| `privateKey` | required | The `.pem`, as a `Secret` (`fromFile`, `fromEnv` or a function) |
| `installationId` | looked up per repository | Pin one installation |
| `agentPermissions` | `{ contents: "read" }` | What the agent's token may read: `contents`, `pull_requests`, `issues`, each only `"read"`. A write level is a `ConfigError` |
| `requireRuleset` | `true` | Refuse to push without the ruleset above. `false` emits `credential.unprotected` on every push token; use it only for a throwaway repository |
| `host`, `apiUrl` | `github.com` | GitHub Enterprise or an emulator |

## The `pat()` fallback

For local use without an App, two fine-grained personal access tokens:

```ts
import { pat } from "@selfbuilding/channel-github";

git: pat({ push: fromEnv("GITHUB_PUSH_TOKEN"), read: fromEnv("GITHUB_READ_TOKEN") }),
```

- `push`: Contents read and write and Pull requests read and write on the repositories (Issues read and write for
  labels and comments). The host pushes and opens PRs with it.
- `read` (optional but recommended): Contents read only. It is the agent's token. Without it, the push token clones
  before the harness starts and is deleted from the box before launch, and the agent gets no git token at all.

PATs are long-lived, so every agent call emits `credential.long_lived`. `pat()` does not check rulesets; protect
the repository the same way anyway.
