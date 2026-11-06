// A minimal Trigger.dev v4 project for the live Trigger test (tests/live/7-trigger.test.ts). Run `node prepare.mjs`
// first: it embeds the built runtime bundles the sandboxes run. See README.md.
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./src"],
  runtime: "node",
  // Waits are not compute time, so this bounds the work between waits, not the agent call.
  maxDuration: 3600,
  retries: { enabledInDev: true, default: { maxAttempts: 3 } },
});
