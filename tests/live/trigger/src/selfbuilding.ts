// The tasks of the live Trigger.dev project: one factory whose two agent calls each run as a selfbuilding.agent
// child task, in a real sandbox, with real Claude Code, and the run-script factory start_workflow launches. Every
// value comes from the worker's environment; nothing is printed.
import { r2ArtifactsFromEnv, r2ResultStoreFromEnv } from "@selfbuilding/artifacts-s3";
import {
  agent,
  factory,
  fileArtifacts,
  type HarnessCredential,
  type SandboxProvider,
  type SelfbuildingConfig,
  setRuntimeBundles,
} from "@selfbuilding/core";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { createTriggerHost, fileResultStore } from "@selfbuilding/host-trigger";
import { e2b } from "@selfbuilding/sandbox-e2b";
import { impello } from "@selfbuilding/sandbox-impello";
import { createScriptFactory } from "@selfbuilding/script";
import { z } from "zod";
import * as bundles from "./runtime-bundles.generated.js";

const env = process.env;

setRuntimeBundles({
  runtime: Buffer.from(bundles.runtime, "base64"),
  mcp: Buffer.from(bundles.mcp, "base64"),
  nsReap: Buffer.from(bundles.nsReap, "base64"),
});

const fromEnv = (name: string) => async () => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set in the Trigger.dev environment.`);
  return value;
};

function credentials(): HarnessCredential[] {
  const out: HarnessCredential[] = [];
  if (env.CLAUDE_CODE_OAUTH_TOKEN) out.push({ kind: "oauth-token", value: fromEnv("CLAUDE_CODE_OAUTH_TOKEN") });
  if (env.ANTHROPIC_API_KEY) out.push({ kind: "api-key", value: fromEnv("ANTHROPIC_API_KEY") });
  return out;
}

function sandbox(): SandboxProvider {
  if ((env.SELFBUILDING_TRIGGER_PROVIDER ?? "e2b") === "impello") {
    return impello({ apiKey: env.IMPELLO_API_KEY ?? "", template: env.IMPELLO_TEMPLATE ?? "selfbuilding-claude-code" });
  }
  return e2b({ apiKey: env.E2B_API_KEY ?? "", template: env.E2B_TEMPLATE ?? "selfbuilding-claude-code" });
}

const Said = z.object({ said: z.string() });

/** Two agent calls at once: two child runs, both waited on by the parent's one wait. */
export const hello = factory({ name: "hello", input: z.object({}) }, async () => {
  const calls = ["first", "second"].map((label) =>
    agent({
      name: label,
      label,
      prompt: `Do not change any files. Call submit_result with {"said": "hello ${label}"}.`,
      output: Said,
      timeout: "15m",
    }),
  );
  const [a, b] = await Promise.all(calls);
  return { said: [a?.result.said, b?.result.said] };
});

const provider = sandbox();
const deployment = env.SELFBUILDING_DEPLOYMENT ?? "live-trigger";

const config: SelfbuildingConfig = {
  deployment,
  sandbox: provider,
  harness: claudeCode({ credentials: credentials() }),
  artifacts: env.R2_ACCESS_KEY_ID
    ? r2ArtifactsFromEnv(env, { prefix: "live-trigger" })
    : fileArtifacts(".selfbuilding/artifacts"),
  concurrency: { sandboxes: 2 },
};

export const { factoryTask, agentTask, reaperTask } = createTriggerHost({
  config,
  factories: { hello, "run-script": createScriptFactory({ config }) },
  // Every task of a run must see the same store. With R2 set, a bucket every machine reaches (a deployed project
  // needs it); otherwise a directory, which works under `trigger.dev dev`, where all tasks run on this machine.
  store: env.R2_ACCOUNT_ID
    ? r2ResultStoreFromEnv(env, { prefix: `${deployment}/results` })
    : fileResultStore(env.SELFBUILDING_TRIGGER_STORE ?? ".selfbuilding/trigger"),
  providers: [provider],
});
