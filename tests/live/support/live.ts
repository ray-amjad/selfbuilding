// The live suite's environment: which sandboxes, harnesses, GitHub identity and Slack workspace are configured,
// and the reason a case skips when one is missing. Credentials are read only as resolvers that run when a call
// needs them; nothing here prints a value.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubApp, pat } from "@selfbuilding/channel-github";
import {
  type Budget,
  type GitCredentialBroker,
  type Harness,
  type HarnessCredential,
  type PullRequestApi,
  type SandboxProvider,
  type SelfbuildingEvent,
  setRuntimeBundles,
} from "@selfbuilding/core";
import { claudeCode } from "@selfbuilding/harnesses/claude-code";
import { codex } from "@selfbuilding/harnesses/codex";
import { claudeCodeImage, codexImage, dockerImageRef } from "@selfbuilding/images";
import { docker } from "@selfbuilding/sandbox-docker";
import { e2b } from "@selfbuilding/sandbox-e2b";
import { impello } from "@selfbuilding/sandbox-impello";

const env = process.env;

/** The master switch: nothing in this suite spends money or touches a real service without it. */
export const LIVE = env.SELFBUILDING_LIVE === "1";

/** "" when the case can run; otherwise why it skips. */
export function needs(...reasons: (string | false | undefined)[]): string {
  if (!LIVE) return "set SELFBUILDING_LIVE=1 to run the live suite";
  return reasons.filter((r): r is string => typeof r === "string" && r !== "").join("; ");
}

export const PLAYGROUND = env.SELFBUILDING_PLAYGROUND ?? "github.com/ray-amjad/selfbuilding-playground";

export function budget(): Budget {
  const usd = Number(env.SELFBUILDING_LIVE_BUDGET_USD ?? "5");
  return { usd, perAgent: { usd: Math.max(0.5, usd / 4), wallClock: "30m" } };
}

const fromEnv = (name: string) => async () => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};
const fromFile = (file: string) => async () => fs.readFile(file, "utf8");

// ───────────────────────────── harnesses ─────────────────────────────

export type HarnessName = "claude-code" | "codex";

function claudeCredentials(): HarnessCredential[] {
  const out: HarnessCredential[] = [];
  if (env.CLAUDE_CODE_OAUTH_TOKEN) out.push({ kind: "oauth-token", value: fromEnv("CLAUDE_CODE_OAUTH_TOKEN") });
  if (env.ANTHROPIC_API_KEY) out.push({ kind: "api-key", value: fromEnv("ANTHROPIC_API_KEY") });
  return out;
}

function codexCredentials(): HarnessCredential[] {
  const out: HarnessCredential[] = [];
  if (env.CODEX_AUTH_FILE) out.push({ kind: "auth-file", value: fromFile(env.CODEX_AUTH_FILE), leased: true });
  if (env.OPENAI_API_KEY) out.push({ kind: "api-key", value: fromEnv("OPENAI_API_KEY") });
  return out;
}

export const harnesses: Record<HarnessName, { ready: boolean; skip: string; make(): Harness }> = {
  "claude-code": {
    ready: claudeCredentials().length > 0,
    skip: "set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
    make: () => claudeCode({ credentials: claudeCredentials() }),
  },
  codex: {
    ready: codexCredentials().length > 0,
    skip: "set CODEX_AUTH_FILE (a `codex login` auth.json) or OPENAI_API_KEY",
    make: () => codex({ credentials: codexCredentials() }),
  },
};

// ───────────────────────────── providers ─────────────────────────────

export type ProviderName = "impello" | "e2b" | "docker";

const template = (base: string | undefined, harness: HarnessName) =>
  base ?? (harness === "codex" ? "selfbuilding-codex" : "selfbuilding-claude-code");

/** Sizes whose templates are built, from E2B_SIZES / IMPELLO_SIZES (comma-separated); unset means the default. */
const builtSizes = (raw: string | undefined): { sizes?: string[] } => {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? { sizes: list } : {};
};

export const providers: Record<
  ProviderName,
  { ready: boolean; skip: string; make(harness: HarnessName): SandboxProvider }
> = {
  impello: {
    ready: Boolean(env.IMPELLO_API_KEY),
    skip: "set IMPELLO_API_KEY",
    make: (h) =>
      impello({
        apiKey: env.IMPELLO_API_KEY ?? "",
        template: template(h === "codex" ? env.IMPELLO_CODEX_TEMPLATE : env.IMPELLO_TEMPLATE, h),
        ...builtSizes(env.IMPELLO_SIZES),
      }),
  },
  e2b: {
    ready: Boolean(env.E2B_API_KEY),
    skip: "set E2B_API_KEY",
    make: (h) =>
      e2b({
        apiKey: env.E2B_API_KEY ?? "",
        template: template(h === "codex" ? env.E2B_CODEX_TEMPLATE : env.E2B_TEMPLATE, h),
        ...builtSizes(env.E2B_SIZES),
      }),
  },
  docker: {
    ready: env.SELFBUILDING_E2E_DOCKER === "1",
    skip: "set SELFBUILDING_E2E_DOCKER=1 with a reachable Docker daemon",
    // Like the cloud templates above, the box image follows the harness; without it every box would run the
    // conformance suite's harness-free default image.
    make: (h) =>
      docker({
        build: true,
        image: dockerImageRef(h === "codex" ? codexImage : claudeCodeImage),
        ...(env.SELFBUILDING_DOCKER_SOCKET ? { socketPath: env.SELFBUILDING_DOCKER_SOCKET } : {}),
      }),
  },
};

/**
 * How many create-path calls the live conformance suite keeps in flight on a cloud vendor
 * (`SELFBUILDING_LIVE_CONCURRENCY`, default 2). Higher values hit the vendors' create rate limits. Docker is local
 * and unlimited.
 */
export function liveConcurrency(provider: ProviderName, value = env.SELFBUILDING_LIVE_CONCURRENCY): number | undefined {
  if (provider === "docker") return undefined;
  if (value === undefined || value === "") return 2;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`SELFBUILDING_LIVE_CONCURRENCY must be a whole number of at least 1, not "${value}".`);
  }
  return n;
}

/** Every provider × harness pair the suite exercises, with the reason it skips. */
export const targets: { name: string; provider: ProviderName; harness: HarnessName; skip: string }[] = (
  ["impello", "e2b"] as const
).flatMap((p) =>
  (["claude-code", "codex"] as const).map((h) => ({
    name: `${h} on ${p}`,
    provider: p,
    harness: h,
    skip: needs(!providers[p].ready && providers[p].skip, !harnesses[h].ready && harnesses[h].skip),
  })),
);

// ───────────────────────────── GitHub ─────────────────────────────

export const githubSkip =
  env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY_FILE
    ? ""
    : env.GITHUB_PUSH_TOKEN
      ? ""
      : "set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_FILE (or GITHUB_PUSH_TOKEN for the PAT fallback)";

/** The App broker when its id and key are set, else the PAT fallback. */
export function github(): GitCredentialBroker & { pullRequests: PullRequestApi } {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY_FILE) {
    return githubApp({
      appId: Number(env.GITHUB_APP_ID),
      privateKey: fromFile(env.GITHUB_APP_PRIVATE_KEY_FILE),
      ...(env.GITHUB_APP_INSTALLATION_ID ? { installationId: Number(env.GITHUB_APP_INSTALLATION_ID) } : {}),
    });
  }
  return pat({
    push: fromEnv("GITHUB_PUSH_TOKEN"),
    ...(env.GITHUB_READ_TOKEN ? { read: fromEnv("GITHUB_READ_TOKEN") } : {}),
  });
}

/** The two refs of the playground's standing review fixture: a branch that adds a bug on top of its base. */
export const reviewRefs = {
  base: env.SELFBUILDING_PLAYGROUND_REVIEW_BASE ?? "main",
  head: env.SELFBUILDING_PLAYGROUND_REVIEW_HEAD ?? "fixture/multiply-bug",
};

// ───────────────────────────── Slack ─────────────────────────────

export const slackSkip =
  env.SLACK_BOT_TOKEN && env.SLACK_SIGNING_SECRET && env.SLACK_CHANNEL
    ? ""
    : "set SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET and SLACK_CHANNEL";

/** A person answers the asks: the hooks endpoint is reachable from Slack and the approver is set. */
export const humanSkip =
  env.SELFBUILDING_LIVE_SLACK_HUMAN === "1" && env.SELFBUILDING_LIVE_APPROVER
    ? ""
    : "set SELFBUILDING_LIVE_SLACK_HUMAN=1 and SELFBUILDING_LIVE_APPROVER (a Slack user id), and point the Slack App's interactivity URL at SELFBUILDING_LIVE_HOOKS_PORT";

export const hooksPort = Number(env.SELFBUILDING_LIVE_HOOKS_PORT ?? "8787");
export const approver = env.SELFBUILDING_LIVE_APPROVER ?? "";
export const slackChannel = env.SLACK_CHANNEL ?? "";

// ───────────────────────────── shared ─────────────────────────────

export function runtimeDist(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.resolve("@selfbuilding/runtime/package.json"))), "dist");
}

export function useBuiltRuntime(): void {
  const dist = runtimeDist();
  setRuntimeBundles({
    runtime: readFileSync(path.join(dist, "selfbuilding-runtime.mjs")),
    mcp: readFileSync(path.join(dist, "selfbuilding-mcp.mjs")),
    nsReap: readFileSync(path.join(dist, "ns-reap.mjs")),
  });
}

export async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function recorder() {
  const events: SelfbuildingEvent[] = [];
  return {
    events,
    sink: (e: SelfbuildingEvent) => {
      events.push(e);
    },
    of: (type: string) => events.filter((e) => e.type === type),
    launched: () => events.filter((e) => e.type === "agent.launched").map((e) => e.callPath ?? ""),
  };
}

/** A unique run id per live run, so repeated runs never resume each other. */
export const liveRunId = (name: string) => `ns_live_${name}_${Date.now().toString(36)}`;
