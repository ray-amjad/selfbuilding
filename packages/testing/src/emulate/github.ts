import { createEmulator, type Emulator, type SeedConfig } from "emulate";
import { EmulatorRequestError, readBody } from "./common.js";

export interface GitHubSeedOptions {
  /** Default "acme". */
  org?: string;
  /** Default "playground". Created with `auto_init`. */
  repo?: string;
  /** Default 4242. */
  appId?: number;
  /** Default 77; installed on the org with access to all repositories. */
  installationId?: number;
  /** Where the emulator delivers the App's webhooks, e.g. a local `createCallbackHandler` server. */
  webhookUrl?: string;
  /** Default "selfbuilding-test-webhook-secret". */
  webhookSecret?: string;
  /** Default "selfbuilding-test-bot-token" (user `selfbuilding-bot`). */
  botToken?: string;
  /** Default "selfbuilding-test-reviewer-token" (user `reviewer`). */
  reviewerToken?: string;
}

export interface GitHubSeedInfo {
  owner: string;
  repo: string;
  app: { appId: number; installationId: number; slug: string; webhookSecret: string };
  tokens: { bot: string; reviewer: string };
}

/**
 * The spec's GitHub seed: an org, a repo with `auto_init`, an App with a webhook secret, and bot and reviewer tokens.
 * Pass the result to `createEmulator({ service: "github", seed })`, or use `startGitHubEmulator`.
 */
export function githubSeed(opts: GitHubSeedOptions = {}): { seed: SeedConfig; info: GitHubSeedInfo } {
  const info: GitHubSeedInfo = {
    owner: opts.org ?? "acme",
    repo: opts.repo ?? "playground",
    app: {
      appId: opts.appId ?? 4242,
      installationId: opts.installationId ?? 77,
      slug: "selfbuilding-test",
      webhookSecret: opts.webhookSecret ?? "selfbuilding-test-webhook-secret",
    },
    tokens: {
      bot: opts.botToken ?? "selfbuilding-test-bot-token",
      reviewer: opts.reviewerToken ?? "selfbuilding-test-reviewer-token",
    },
  };
  const seed: SeedConfig = {
    tokens: {
      [info.tokens.bot]: { login: "selfbuilding-bot", scopes: ["repo", "workflow"] },
      [info.tokens.reviewer]: { login: "reviewer", scopes: ["repo"] },
    },
    github: {
      users: [
        { login: "selfbuilding-bot", name: "Selfbuilding Bot", email: "bot@selfbuilding.test" },
        { login: "reviewer", name: "Reviewer", email: "reviewer@selfbuilding.test" },
      ],
      orgs: [
        {
          login: info.owner,
          name: info.owner,
          members: [
            { login: "selfbuilding-bot", role: "admin" },
            { login: "reviewer", role: "member" },
          ],
        },
      ],
      repos: [{ owner: info.owner, name: info.repo, auto_init: true, private: true }],
      apps: [
        {
          app_id: info.app.appId,
          slug: info.app.slug,
          name: "Selfbuilding Test",
          permissions: {
            contents: "write",
            pull_requests: "write",
            checks: "write",
            issues: "write",
            metadata: "read",
          },
          events: ["pull_request", "issue_comment", "check_run", "push"],
          ...(opts.webhookUrl === undefined ? {} : { webhook_url: opts.webhookUrl }),
          webhook_secret: info.app.webhookSecret,
          installations: [
            { installation_id: info.app.installationId, account: info.owner, repository_selection: "all" },
          ],
        },
      ],
    },
  };
  return { seed, info };
}

export interface GitHubEmulator extends GitHubSeedInfo {
  readonly url: string;
  readonly emulator: Emulator;
  /** The App's generated RSA private key (PKCS#1 PEM), for minting installation tokens. */
  readonly appPrivateKey: string;
  /** Calls the REST API as the bot (default) or the reviewer; throws `EmulatorRequestError` on a non-2xx answer. */
  api<T = unknown>(path: string, init?: { method?: string; body?: unknown; as?: "bot" | "reviewer" }): Promise<T>;
  /** Restores the seed. Persistence is off, so this is the whole state. */
  reset(): void;
  close(): Promise<void>;
}

/** Starts a GitHub emulator with the spec seed. Port 0 (default) picks a free port; see `emulatorPort()`. */
export async function startGitHubEmulator(opts: GitHubSeedOptions & { port?: number } = {}): Promise<GitHubEmulator> {
  const { seed, info } = githubSeed(opts);
  const emulator = await createEmulator({ service: "github", port: opts.port ?? 0, hostname: "127.0.0.1", seed });
  const key = emulator.generatedSecrets.find(
    (s) => s.kind === "github.app_private_key" && s.id === String(info.app.appId),
  );
  if (!key) throw new Error("The GitHub emulator did not generate an App private key.");
  const url = emulator.url.replace("localhost", "127.0.0.1");
  return {
    ...info,
    url,
    emulator,
    appPrivateKey: key.value,
    async api<T>(path: string, init: { method?: string; body?: unknown; as?: "bot" | "reviewer" } = {}): Promise<T> {
      const method = init.method ?? (init.body === undefined ? "GET" : "POST");
      const response = await fetch(url + path, {
        method,
        headers: {
          authorization: `token ${init.as === "reviewer" ? info.tokens.reviewer : info.tokens.bot}`,
          accept: "application/vnd.github+json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const body = await readBody(response);
      if (!response.ok) throw new EmulatorRequestError(method, path, response.status, body);
      return body as T;
    },
    reset: () => emulator.reset(),
    close: () => emulator.close(),
  };
}
