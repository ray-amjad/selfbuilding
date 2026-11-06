import {
  ChannelDeliveryError,
  ConfigError,
  type GitCredentialBroker,
  type GitPushTokenRequest,
  type GitToken,
  type GitTokenRequest,
  type Json,
  type PullRequestApi,
  type Secret,
} from "@selfbuilding/core";
import { type FetchLike, type GithubHttp, githubRequest, normaliseApiUrl, TransportFailure } from "./http.js";
import { pullRequestApi } from "./pulls.js";
import { parseRepo } from "./repo.js";
import { resolveSecret } from "./secret.js";

export interface PatOptions {
  /** A read-only fine-grained PAT for the agent. Without it, the agent gets no git token at all. */
  read?: Secret;
  /** The PAT the host pushes (and opens PRs) with. */
  push: Secret;
  apiUrl?: string;
  /** Default "github.com". */
  host?: string;
  fetch?: FetchLike;
  now?: () => number;
}

export interface PatBroker extends GitCredentialBroker {
  readonly pullRequests: PullRequestApi;
}

// A PAT's real expiry is unknown here; an hour keeps the refresh cadence the same as App tokens, and the refresh
// simply rewrites the same value.
const PAT_REFRESH_MS = 60 * 60 * 1000;

/**
 * Fine-grained PAT fallback for local use (spec §9.2). Every token is marked `longLived`, so core emits
 * `credential.long_lived` on every agent call. With only a push PAT, the read token is `cloneOnly`: it clones
 * before the harness starts and is deleted before launch.
 */
export function pat(opts: PatOptions): PatBroker {
  if (opts.push === undefined || opts.push === "") {
    throw new ConfigError("pat() needs push: a fine-grained PAT with contents: write on the repository.");
  }
  const host = opts.host ?? "github.com";
  const now = opts.now ?? Date.now;
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const http: GithubHttp = { apiUrl: normaliseApiUrl(opts.apiUrl), fetch: fetchImpl };
  const expiresAt = () => new Date(now() + PAT_REFRESH_MS).toISOString();

  return {
    id: "pat",
    host,
    pullRequests: pullRequestApi(
      http,
      host,
      async () => `token ${await resolveSecret(opts.push, "pat push token")}`,
      async (repo, authorization) => {
        // The PAT's owner; read each time, since the PAT behind a secret may change between calls.
        const result = await githubRequest<{ login?: string }>(http, "GET", "/user", { auth: authorization });
        if (result instanceof TransportFailure || !result.ok || typeof result.body?.login !== "string") {
          throw new ChannelDeliveryError(
            `Could not read the PAT's own user (GET /user) to check comment dedupe markers on ${repo.owner}/${repo.name}. Retry once GitHub answers.`,
          );
        }
        return result.body.login;
      },
    ),

    async readToken(req: GitTokenRequest): Promise<GitToken> {
      parseRepo(req.repo, host);
      if (opts.read !== undefined) {
        return {
          value: await resolveSecret(opts.read, "pat read token"),
          expiresAt: expiresAt(),
          permissions: { contents: "read", metadata: "read" },
          longLived: true,
        };
      }
      return {
        value: await resolveSecret(opts.push, "pat push token"),
        expiresAt: expiresAt(),
        permissions: { contents: "write", metadata: "read" },
        longLived: true,
        cloneOnly: true,
      };
    },

    async pushToken(req: GitPushTokenRequest): Promise<GitToken> {
      parseRepo(req.repo, host);
      if (!req.launchId) {
        throw new ConfigError("pushToken needs the launchId of the fenced launch; push tokens are minted per launch.");
      }
      return {
        value: await resolveSecret(opts.push, "pat push token"),
        expiresAt: expiresAt(),
        permissions: { contents: "write", metadata: "read" },
        longLived: true,
      };
    },

    describe(): Record<string, Json> {
      return { broker: "pat", host, separateReadToken: opts.read !== undefined };
    },
  };
}
