import { homedir } from "node:os";
import { join } from "node:path";
import { r2ArtifactsFromEnv } from "@selfbuilding/artifacts-s3";
import { githubApp } from "@selfbuilding/channel-github";
import { slack } from "@selfbuilding/channel-slack";
import { defineConfig, fileJournal, fromEnv, fromFile } from "@selfbuilding/core";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { codex } from "@selfbuilding/harnesses/codex";
import { impello } from "@selfbuilding/sandbox-impello";

// One template for every box: the medium Codex image with the browser. Forks keep the build box's image, so the
// Claude Code builder, both reviewers and the Codex verifiers all run on copies of the same box.
const sandbox = impello({
  apiKey: fromEnv("IMPELLO_API_KEY"),
  template: "selfbuilding-codex",
  sizes: ["small", "medium"],
});

export const providers = [sandbox];

const channel = slack({
  channel: process.env.SLACK_CHANNEL ?? "#factory",
  botToken: fromEnv("SLACK_BOT_TOKEN"),
  signingSecret: fromEnv("SLACK_SIGNING_SECRET"),
});

export default defineConfig({
  deployment: "task-lifecycle",
  harness: claudeCode({ credentials: [{ kind: "oauth-token", value: fromEnv("CLAUDE_CODE_OAUTH_TOKEN") }] }),
  sandbox,
  git: githubApp({
    appId: Number(process.env.GITHUB_APP_ID),
    privateKey: fromFile(
      process.env.GITHUB_APP_PRIVATE_KEY_FILE ?? join(homedir(), ".config/selfbuilding/github-app.pem"),
    ),
  }),
  artifacts: r2ArtifactsFromEnv(process.env),
  journal: fileJournal(".selfbuilding/journal"),
  budget: { usd: 30, wallClock: "3h" },
  concurrency: { sandboxes: 4 },
  hitl: {
    channels: [channel],
    ...(process.env.SELFBUILDING_APPROVER ? { approvers: [{ slack: process.env.SELFBUILDING_APPROVER }] } : {}),
    timeout: "24h",
  },
  scripts: { allowedSizes: ["small", "medium"], maxAgentCalls: 30, maxSandboxes: 4 },
});

// Registered by name for the script: `harness: "codex"` in a call option.
export const harnesses = {
  "claude-code": claudeCode({ credentials: [{ kind: "oauth-token", value: fromEnv("CLAUDE_CODE_OAUTH_TOKEN") }] }),
  codex: codex({
    credentials: [{ kind: "auth-file", value: fromFile(join(homedir(), ".codex", "auth.json")), leased: true }],
  }),
};
