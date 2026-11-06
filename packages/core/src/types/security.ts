import type { Json } from "./common.js";

/** A credential: a value, or a resolver that runs on the orchestrator and never in the sandbox (spec §9.2). */
export type Secret = string | (() => Promise<string>);

/** Resolves declared secret names. A missing name throws MissingSecretError naming it (spec §9.2). */
export interface SecretSource {
  resolve(names: readonly string[]): Promise<Record<string, string>>;
}

/** Egress policy (spec §9.5). The default is `"open"`. Adapters always send the whole policy. */
export type EgressPolicy = "open" | "deny-all" | { allow: string[]; inject?: EgressInject[] };

/** Headers added outside the sandbox, where the provider supports it. */
export interface EgressInject {
  host: string;
  headers: Record<string, Secret>;
}

/** The provider-level network policy carried by `SandboxSpec.network`. Same shape as the user policy. */
export type NetworkPolicy = EgressPolicy;

/** A short-lived git token minted by a broker. The value never enters argv or provider env. */
export interface GitToken {
  value: string;
  /** ISO time. Written next to the token as `git-token.exp`. */
  expiresAt: string;
  /** e.g. `{ contents: "read", metadata: "read" }`. */
  permissions: Record<string, "read" | "write">;
  /** Long-lived tokens (PATs) emit `credential.long_lived` on every agent call. */
  longLived?: boolean;
  /**
   * The token can write (a single PAT doing both jobs). Use it for the clone before the harness starts, then
   * delete it before launch: the agent gets no git token (spec §9.2, "Fine-grained PATs").
   */
  cloneOnly?: boolean;
}

export interface GitTokenRequest {
  /** "github.com/acme/api" */
  repo: string;
  runId: string;
  callPath: string;
}

export interface GitPushTokenRequest extends GitTokenRequest {
  /** Push tokens are minted only for the launch the fence names (spec §7.4.5). */
  launchId: string;
}

export interface PullRequestRequest {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  labels?: string[];
}

export interface PullRequestRef {
  url: string;
  number: number;
  draft: boolean;
}

/** One PR as read back from the git host (release-prep §2.1). */
export interface PullRequestInfo extends PullRequestRef {
  /** "github.com/acme/api" */
  repo: string;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  /** Branch names. */
  head: string;
  base: string;
  /** The head commit, for stage markers such as `head:<sha>`. */
  headSha: string;
}

/** A PR comment the host identity wrote (release-prep §2.1). */
export interface PullRequestComment {
  id: number;
  url: string;
  /** False when `dedupeKey` matched a comment that already existed, which was returned instead. */
  created: boolean;
}

/** Fields `PullRequestApi.update` may change. A field left out keeps its value. */
export interface PullRequestPatch {
  title?: string;
  body?: string;
}

/** One `## heading` block of a PR body (release-prep §2.2). `heading` is the text after "## ". */
export interface PrSection {
  heading: string;
  content: string;
}

/** What `updatePr` and `sb.pr.update` take: a patch, and optionally one section to replace in the body. */
export interface PrUpdate extends PullRequestPatch {
  section?: PrSection;
}

/** Opens and updates PRs as the host's identity (a GitHub App in v1). Never available to the agent. */
export interface PullRequestApi {
  /** Updates the open PR for `head` if one exists, otherwise creates one (spec §6.13). */
  openOrUpdate(req: PullRequestRequest): Promise<PullRequestRef & { created: boolean }>;
  findOpen(repo: string, head: string): Promise<PullRequestRef | null>;
  /** Reads one PR by number (release-prep §2.1). */
  get?(repo: string, number: number): Promise<PullRequestInfo>;
  /** Edits one PR by number and returns it as stored afterwards (release-prep §2.1). */
  update?(repo: string, number: number, patch: PullRequestPatch): Promise<PullRequestInfo>;
  /**
   * Comments on one PR (release-prep §2.1). With `dedupeKey`, the body carries a hidden
   * `<!-- selfbuilding:comment:<dedupeKey> -->` marker and an existing comment with that marker is returned instead
   * of posting again, so a retried or replayed write posts once.
   */
  comment?(repo: string, number: number, body: string, opts?: { dedupeKey?: string }): Promise<PullRequestComment>;
}

/**
 * Names one PR (release-prep §2.2): an agent result's `artifacts.pr` (anything with a GitHub PR `url`), a PR URL, or
 * the repo and number.
 */
export type PrTarget = string | { url: string } | { repo: string; number: number };

/**
 * Mints git credentials (spec §9.2). The agent gets a read-only, repo-scoped token; the host pushes with a
 * separate write token after the agent's processes have exited. `githubApp()` and `pat()` implement it.
 */
export interface GitCredentialBroker {
  readonly id: string;
  /** The git host the credential helper answers for, e.g. "github.com". */
  readonly host: string;
  readToken(req: GitTokenRequest): Promise<GitToken>;
  pushToken(req: GitPushTokenRequest): Promise<GitToken>;
  /** Revokes a superseded launch's token where the vendor supports it. */
  revoke?(token: GitToken): Promise<void>;
  /** Present when the broker can also open PRs as the host identity. */
  readonly pullRequests?: PullRequestApi;
  /** Throws UnprotectedRepoError when write access is not limited to `selfbuilding/*` refs. */
  assertProtected?(repo: string): Promise<void>;
  /** Extra non-secret facts recorded on `credential.minted` events. */
  describe?(): Record<string, Json>;
}
