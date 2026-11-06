import type { KeyObject } from "node:crypto";
import {
  ConfigError,
  CredentialRefreshError,
  type GitCredentialBroker,
  type GitPushTokenRequest,
  type GitToken,
  type GitTokenRequest,
  type Json,
  type PullRequestApi,
  type Secret,
  UnprotectedRepoError,
} from "@selfbuilding/core";
import {
  appJwt,
  type FetchLike,
  type GithubHttp,
  type GithubResponse,
  githubMessage,
  githubRequest,
  isTransient,
  loadPrivateKey,
  normaliseApiUrl,
  TransportFailure,
} from "./http.js";
import { pullRequestApi } from "./pulls.js";
import { parseRepo, type RepoCoordinates } from "./repo.js";
import {
  AGENT_BRANCH_PROBE,
  REQUIRED_RULES,
  type RulesetDetail,
  type RulesetSummary,
  rulesetsProtect,
} from "./rulesets.js";
import { resolveSecret } from "./secret.js";

type Permission = "read" | "write";
type Permissions = Record<string, Permission>;

/** A non-secret fact a broker reports; core turns it into an event (names, permissions and expiry only). */
export interface GitBrokerEvent {
  type: "credential.unprotected";
  level: "warn";
  data: Record<string, Json>;
}

export interface GithubAppOptions {
  appId: number;
  privateKey: Secret;
  /**
   * The App's installation. Default: looked up per repository (`GET /repos/{owner}/{repo}/installation`), which
   * also works when the App is installed on several accounts.
   */
  installationId?: number;
  /** The agent's token. Read-only; write permissions here are a ConfigError. */
  agentPermissions?: { contents?: "read"; pull_requests?: "read"; issues?: "read" };
  /** Default true: refuse to push without a ruleset limiting the App to selfbuilding/* refs. */
  requireRuleset?: boolean;
  /** Override for tests against an emulator. */
  apiUrl?: string;
  /** The git host the credential helper answers for. Default "github.com". */
  host?: string;
  /** Default: the global fetch. */
  fetch?: FetchLike;
  /** Receives `credential.unprotected` on every push token when `requireRuleset` is false. */
  onEvent?: (event: GitBrokerEvent) => void;
  /** Clock override for tests (epoch ms). */
  now?: () => number;
}

/** A GitHub App broker: always able to open PRs as the App. */
export interface GithubAppBroker extends GitCredentialBroker {
  readonly pullRequests: PullRequestApi;
  revoke(token: GitToken): Promise<void>;
  assertProtected(repo: string): Promise<void>;
  describe(): Record<string, Json>;
}

const AGENT_PERMISSION_KEYS = new Set(["contents", "pull_requests", "issues"]);
const TOKEN_TTL_FALLBACK_MS = 60 * 60 * 1000;

function validateAgentPermissions(perms: GithubAppOptions["agentPermissions"]): Permissions {
  const out: Permissions = { contents: "read", metadata: "read" };
  for (const [name, level] of Object.entries(perms ?? {})) {
    if (!AGENT_PERMISSION_KEYS.has(name)) {
      throw new ConfigError(
        `agentPermissions.${name} is not allowed. The agent's token may carry only contents, pull_requests and issues, all "read".`,
      );
    }
    if (level === undefined) continue;
    if (level !== "read") {
      throw new ConfigError(
        `agentPermissions.${name} is "${String(level)}". The agent's token is read-only: the host pushes and opens PRs for it. Use "read".`,
      );
    }
    out[name] = "read";
  }
  return out;
}

/** Mints short-lived, repo-scoped installation tokens and opens PRs as the App (spec §9.2). */
export function githubApp(opts: GithubAppOptions): GithubAppBroker {
  if (!Number.isInteger(opts.appId) || opts.appId <= 0) {
    throw new ConfigError(`githubApp({ appId }) must be the App's numeric id; got ${String(opts.appId)}.`);
  }
  if (opts.installationId !== undefined && (!Number.isInteger(opts.installationId) || opts.installationId <= 0)) {
    throw new ConfigError(
      `githubApp({ installationId }) must be a positive integer; got ${String(opts.installationId)}.`,
    );
  }
  if (opts.privateKey === undefined || opts.privateKey === "") {
    throw new ConfigError(
      "githubApp() needs privateKey: the App's .pem, for example fromFile(new URL('./app.pem', import.meta.url).href).",
    );
  }
  const agentPermissions = validateAgentPermissions(opts.agentPermissions);
  const requireRuleset = opts.requireRuleset ?? true;
  const host = opts.host ?? "github.com";
  const now = opts.now ?? Date.now;
  const http: GithubHttp = { apiUrl: normaliseApiUrl(opts.apiUrl), fetch: opts.fetch ?? ((i, init) => fetch(i, init)) };
  const installations = new Map<string, number>();
  // "At the first write mint of each run": a passed check is remembered per run and repo, a failure never is.
  const protectedFor = new Set<string>();
  let cachedKey: { pem: string; key: KeyObject } | undefined;

  async function jwt(): Promise<string> {
    const pem = await resolveSecret(opts.privateKey, "githubApp privateKey");
    if (cachedKey?.pem !== pem) cachedKey = { pem, key: loadPrivateKey(pem) };
    return appJwt(opts.appId, cachedKey.key, now());
  }

  function mintFailure(what: string, repo: RepoCoordinates, result: GithubResponse | TransportFailure): never {
    const where = `${repo.owner}/${repo.name}`;
    if (result instanceof TransportFailure) {
      throw new CredentialRefreshError(`Could not reach GitHub to ${what} for ${where}. Retry once it is reachable.`, {
        cause: result.cause,
      });
    }
    const detail = githubMessage(result);
    if (isTransient(result.status)) {
      throw new CredentialRefreshError(
        `GitHub answered ${result.status} when asked to ${what} for ${where}: ${detail}`,
      );
    }
    if (result.status === 401) {
      throw new ConfigError(
        `GitHub rejected the App's JWT (${detail}). Check that appId ${opts.appId} matches the App the privateKey belongs to, and that this machine's clock is right.`,
      );
    }
    if (result.status === 404) {
      throw new ConfigError(
        `GitHub App ${opts.appId} is not installed on ${where}${opts.installationId === undefined ? "" : ` (installation ${opts.installationId})`}. Install it on the repository, or fix installationId.`,
      );
    }
    throw new ConfigError(
      `GitHub refused to ${what} for ${where} (${result.status}: ${detail}). Grant the App the permissions it asks for on this repository.`,
    );
  }

  async function installationFor(repo: RepoCoordinates, auth: string): Promise<number> {
    if (opts.installationId !== undefined) return opts.installationId;
    const key = `${repo.owner}/${repo.name}`.toLowerCase();
    const known = installations.get(key);
    if (known !== undefined) return known;
    const result = await githubRequest<{ id: number }>(http, "GET", `/repos/${repo.owner}/${repo.name}/installation`, {
      auth,
    });
    if (result instanceof TransportFailure || !result.ok) mintFailure("find the App installation", repo, result);
    if (typeof result.body?.id !== "number") {
      throw new CredentialRefreshError(`GitHub's installation lookup for ${repo.owner}/${repo.name} had no id.`);
    }
    installations.set(key, result.body.id);
    return result.body.id;
  }

  async function mint(repo: RepoCoordinates, permissions: Permissions, purpose: string): Promise<GitToken> {
    const auth = `Bearer ${await jwt()}`;
    const installationId = await installationFor(repo, auth);
    const result = await githubRequest<{ token: string; expires_at?: string; permissions?: Permissions }>(
      http,
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      { auth, body: { repositories: [repo.name], permissions } },
    );
    if (result instanceof TransportFailure || !result.ok) mintFailure(`mint the ${purpose} token`, repo, result);
    if (typeof result.body?.token !== "string") {
      throw new CredentialRefreshError(
        `GitHub's answer to the ${purpose} token request for ${repo.owner}/${repo.name} had no token.`,
      );
    }
    const expiresAt = result.body.expires_at ?? new Date(now() + TOKEN_TTL_FALLBACK_MS).toISOString();
    return { value: result.body.token, expiresAt, permissions: { ...permissions } };
  }

  async function assertProtectedRepo(repo: RepoCoordinates): Promise<void> {
    const where = `${repo.owner}/${repo.name}`;
    const token = await mint(repo, { metadata: "read" }, "ruleset check");
    const auth = `token ${token.value}`;
    const listed = await githubRequest<RulesetSummary[]>(
      http,
      "GET",
      `/repos/${repo.owner}/${repo.name}/rulesets?includes_parents=true&per_page=100`,
      { auth },
    );
    if (listed instanceof TransportFailure || isTransient(listed.status))
      mintFailure("read the rulesets", repo, listed);
    if (!listed.ok || !Array.isArray(listed.body)) {
      throw new UnprotectedRepoError(
        { repo: where },
        {
          message: `Could not read the rulesets of ${where} (${githubMessage(listed)}), so the App's write access cannot be shown to be limited to selfbuilding/* refs. Add the ruleset, or pass requireRuleset: false for a throwaway repo.`,
        },
      );
    }
    const details: RulesetDetail[] = [];
    for (const summary of listed.body) {
      if (summary.enforcement !== "active" || (summary.target !== undefined && summary.target !== "branch")) continue;
      const detail = await githubRequest<RulesetDetail>(
        http,
        "GET",
        `/repos/${repo.owner}/${repo.name}/rulesets/${summary.id}`,
        { auth },
      );
      if (detail instanceof TransportFailure || isTransient(detail.status)) mintFailure("read a ruleset", repo, detail);
      if (detail.ok) details.push(detail.body);
    }
    if (!rulesetsProtect(details, opts.appId)) throw new UnprotectedRepoError({ repo: where });
    // GitHub matches ruleset patterns with its own glob rules: "refs/heads/selfbuilding/**" alone does not exempt
    // nested branches such as selfbuilding/<run>/<call>, so ask GitHub what applies to one before any agent works.
    const probe = await githubRequest<{ type: string }[]>(
      http,
      "GET",
      `/repos/${repo.owner}/${repo.name}/rules/branches/${AGENT_BRANCH_PROBE}`,
      { auth },
    );
    if (probe instanceof TransportFailure || isTransient(probe.status))
      mintFailure("read the branch rules", repo, probe);
    if (probe.ok && Array.isArray(probe.body)) {
      const blocking = probe.body.filter((rule) => (REQUIRED_RULES as readonly string[]).includes(rule.type));
      if (blocking.length > 0) {
        throw new UnprotectedRepoError(
          { repo: where },
          {
            message: `The ruleset on ${where} also blocks the agents' own branches: GitHub applies ${blocking.map((r) => r.type).join(", ")} to refs/heads/${AGENT_BRANCH_PROBE}, so every push would be refused. Exclude both "refs/heads/selfbuilding/**" and "refs/heads/selfbuilding/**/*" in the ruleset.`,
          },
        );
      }
    }
  }

  // The App's comments are authored by `<slug>[bot]`; the slug comes from GET /app, once per process.
  let botLogin: Promise<string> | undefined;
  const appBotLogin = (repo: RepoCoordinates): Promise<string> => {
    botLogin ??= (async () => {
      const result = await githubRequest<{ slug?: string }>(http, "GET", "/app", { auth: `Bearer ${await jwt()}` });
      if (result instanceof TransportFailure || !result.ok) mintFailure("read the App's own slug", repo, result);
      if (typeof result.body?.slug !== "string" || result.body.slug === "") {
        throw new CredentialRefreshError("GitHub's answer to GET /app had no slug.");
      }
      return `${result.body.slug}[bot]`;
    })();
    botLogin.catch(() => {
      botLogin = undefined;
    });
    return botLogin;
  };

  const pullRequests = pullRequestApi(
    http,
    host,
    async (repo, { labels }) => {
      // GitHub reads both refs to open a PR; without contents:read it answers 422 "not all refs are readable".
      const permissions: Permissions = { pull_requests: "write", contents: "read", metadata: "read" };
      if (labels) permissions.issues = "write";
      return `token ${(await mint(repo, permissions, "pull request")).value}`;
    },
    appBotLogin,
  );

  return {
    id: `github-app:${opts.appId}`,
    host,
    pullRequests,

    async readToken(req: GitTokenRequest): Promise<GitToken> {
      return mint(parseRepo(req.repo, host), agentPermissions, "agent read");
    },

    async pushToken(req: GitPushTokenRequest): Promise<GitToken> {
      if (!req.launchId) {
        throw new ConfigError("pushToken needs the launchId of the fenced launch; push tokens are minted per launch.");
      }
      const repo = parseRepo(req.repo, host);
      const key = `${req.runId}\0${repo.owner}/${repo.name}`.toLowerCase();
      if (requireRuleset) {
        if (!protectedFor.has(key)) {
          await assertProtectedRepo(repo);
          protectedFor.add(key);
        }
      } else {
        opts.onEvent?.({
          type: "credential.unprotected",
          level: "warn",
          data: {
            repo: `${host}/${repo.owner}/${repo.name}`,
            runId: req.runId,
            callPath: req.callPath,
            broker: `github-app:${opts.appId}`,
          },
        });
      }
      // No workflows, pull_requests or administration: GitHub then rejects changes to .github/workflows/.
      return mint(repo, { contents: "write", metadata: "read" }, "push");
    },

    async revoke(token: GitToken): Promise<void> {
      const result = await githubRequest(http, "DELETE", "/installation/token", { auth: `token ${token.value}` });
      if (result instanceof TransportFailure) {
        throw new CredentialRefreshError(
          "Could not reach GitHub to revoke a token. It still expires on its own within an hour.",
          {
            cause: result.cause,
          },
        );
      }
      // A 401 means already expired or revoked, which is the goal; only an outage is worth reporting.
      if (isTransient(result.status)) {
        throw new CredentialRefreshError(
          `GitHub answered ${result.status} when revoking a token: ${githubMessage(result)}`,
        );
      }
    },

    async assertProtected(repoName: string): Promise<void> {
      await assertProtectedRepo(parseRepo(repoName, host));
    },

    describe(): Record<string, Json> {
      return {
        broker: "github-app",
        appId: opts.appId,
        ...(opts.installationId === undefined ? {} : { installationId: opts.installationId }),
        agentPermissions,
        requireRuleset,
        host,
      };
    },
  };
}
