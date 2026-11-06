# Slack: questions, approvals and summaries

With a Slack channel configured, every `ask()` (from a factory, a workflow script, or an agent's `ask_human` tool)
is posted as a card with buttons, and answered by a click or a thread reply. Run summaries and `notify()` messages go
to the same channel.

## 1. Create the app from the manifest

The manifest is `packages/channel-slack/slack-app-manifest.json` (or generate one with
`slackAppManifest({ requestUrl, name? })` from `@selfbuilding/channel-slack`). It asks for the bot scopes
`chat:write`, `channels:history`, `groups:history`, `channels:read`, `groups:read` and `users:read`, subscribes to
`message.channels` and `message.groups` (thread replies), and turns on interactivity (buttons).

1. At api.slack.com/apps: Create New App > From an app manifest > pick the workspace > paste the manifest.
2. Replace both `request_url` values (`https://example.com/selfbuilding/hitl`) with the public URL of your hooks
   handler (step 3). You can do this later under Event Subscriptions and Interactivity.
3. Install the app to the workspace.
4. Invite the bot to the channel the runs use (`/invite @selfbuilding`).

## 2. The two secrets

| Variable | Where in Slack |
|---|---|
| `SLACK_BOT_TOKEN` | OAuth & Permissions > Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | Basic Information > App Credentials > Signing Secret |

Put both in your secret manager or `.env`. The signing secret verifies every inbound request (Slack's
`X-Slack-Signature`, with a five-minute clock skew limit); a request that fails is rejected before anything reads it.

```ts
import { slack } from "@selfbuilding/channel-slack";
import { fromEnv } from "@selfbuilding/core";

const channel = slack({
  channel: "#factory", // a channel id or "#name"
  botToken: fromEnv("SLACK_BOT_TOKEN"),
  signingSecret: fromEnv("SLACK_SIGNING_SECRET"),
});

export default defineConfig({
  hitl: { channels: [channel], approvers: [{ slack: "<slack member id>" }], timeout: "24h" },
});
```

Without `botToken` and `signingSecret`, `slack()` reads the two variables above at first use.

## 3. The hooks handler

Button clicks and thread replies arrive over HTTPS at the hooks handler, a fetch-style function
`(Request) => Promise<Response>` from `@selfbuilding/hooks`. It writes the answer to the ask store first
(compare-and-set, so a second answer changes nothing) and then wakes the run.

```ts
import { fileJournal } from "@selfbuilding/core";
import { createHitlHandler } from "@selfbuilding/hooks";

// The same journal the config uses: fileJournal and sqliteJournal both carry the ask store as `.asks`.
const journal = fileJournal(".selfbuilding/journal");
const handler = createHitlHandler({
  channels: [channel],
  store: journal.asks!,
  approvers: [{ slack: "<slack member id>" }],
});
```

Serve it from anything that speaks `Request`/`Response` (a Workers route, a small Node server, a serverless
function). Its public URL is the `request_url` in the manifest. For local runs, point a tunnel at the port it
listens on; the live suite serves it on `SELFBUILDING_LIVE_HOOKS_PORT` (default 8787).

Useful options: `onResolved(record)` runs once the store holds an answer (start `selfbuilding resume <runId>` there
for a run that went cold and exited); `onStop(runId, actor)` cancels a run when an approver clicks Stop;
`resolveWaitpoint(record, resolution)` wakes a run on a durable host (on Trigger.dev, call
`createTriggerAskResolver({ trigger, store }).wake(record)`).

## 4. Approvers

Only approvers may answer. Set them in `hitl.approvers` for runs and in the handler's `approvers` (or pass
`authorize(actor, record)` for your own check). The handler refuses to start with neither, so nobody can answer by
accident. An approver is `{ slack: "<member id>" }` (Slack profile > Copy member ID) or `{ github: "<login>" }`.
`{ githubPermission: "write" | "maintain" | "admin" }` works in `hitl.approvers` for runs, but the handler cannot
look up repo permissions itself: list it in the handler's `approvers` only together with an `authorize()` that does
the lookup (the handler refuses to start otherwise). When a run has no approvers, its requester is the approver.
In AFK mode (`--afk`, or `hitl.mode: "afk"`) nothing is posted and every ask resolves by its policy.

## Text from agents

Outbound text is escaped for Slack and cut to Slack's limits. `slack({ redact })`, when given, runs first on every
outbound string.
