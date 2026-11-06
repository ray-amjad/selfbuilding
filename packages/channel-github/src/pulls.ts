import {
  ChannelDeliveryError,
  ConfigError,
  type GitCredentialBroker,
  type PullRequestApi,
  type PullRequestComment,
  type PullRequestInfo,
  type PullRequestPatch,
  type PullRequestRef,
  type PullRequestRequest,
  PushFailedError,
} from "@selfbuilding/core";
import {
  type GithubHttp,
  type GithubResponse,
  githubMessage,
  githubRequest,
  isTransient,
  TransportFailure,
} from "./http.js";
import { parseRepo, type RepoCoordinates } from "./repo.js";

/** GitHub refuses PR bodies over 65,536 characters. */
export const PR_BODY_LIMIT = 65_536;
const TITLE_LIMIT = 256;

/** Supplies the `authorization` header for one PR operation on one repo. */
export type PrAuth = (repo: RepoCoordinates, opts: { labels: boolean }) => Promise<string>;

interface RawPull {
  number: number;
  html_url: string;
  draft?: boolean;
  title?: string;
  body?: string | null;
  state?: string;
  merged_at?: string | null;
  merged?: boolean;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

interface RawComment {
  id: number;
  html_url: string;
  body?: string | null;
  user?: { login?: string } | null;
}

/**
 * The login the host identity's comments carry (`<app-slug>[bot]` for an App, the PAT owner for a PAT), read with
 * the authorization the PR operation uses. Dedupe trusts only that author's markers.
 */
export type PrAuthor = (repo: RepoCoordinates, authorization: string) => Promise<string>;

/** GitHub refuses comment bodies over 65,536 characters, like PR bodies. */
export const COMMENT_BODY_LIMIT = 65_536;
/** 50 pages of 100: a PR with more comments than that is not one a run keeps writing to. */
const MAX_COMMENT_PAGES = 50;

function toInfo(repo: RepoCoordinates, pull: RawPull): PullRequestInfo {
  const merged = Boolean(pull.merged_at) || pull.merged === true;
  return {
    repo: `${repo.host}/${repo.owner}/${repo.name}`,
    url: pull.html_url,
    number: pull.number,
    draft: pull.draft === true,
    title: pull.title ?? "",
    body: pull.body ?? "",
    state: merged ? "merged" : pull.state === "closed" ? "closed" : "open",
    head: pull.head?.ref ?? "",
    base: pull.base?.ref ?? "",
    headSha: pull.head?.sha ?? "",
  };
}

/** The hidden last line of a deduplicated comment (release-prep §2.1). */
export function commentMarker(dedupeKey: string): string {
  if (dedupeKey.length === 0 || dedupeKey.length > 512 || /[\r\n]|-->/.test(dedupeKey)) {
    throw new ConfigError(
      `A comment dedupeKey is 1-512 characters on one line, without "-->" (got ${JSON.stringify(dedupeKey.slice(0, 80))}).`,
    );
  }
  return `<!-- selfbuilding:comment:${dedupeKey} -->`;
}

/** The `rel="next"` URL of a GitHub `Link` header, if any. */
function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (match) return match[1];
  }
  return undefined;
}

function toRef(pull: RawPull): PullRequestRef {
  return { url: pull.html_url, number: pull.number, draft: pull.draft === true };
}

function fail(
  action: string,
  repo: RepoCoordinates,
  result: GithubResponse | TransportFailure,
  permission?: string,
): never {
  const where = `${repo.owner}/${repo.name}`;
  if (result instanceof TransportFailure) {
    throw new ChannelDeliveryError(`Could not reach GitHub to ${action} on ${where}. Retry once GitHub is reachable.`, {
      cause: result.cause,
    });
  }
  const detail = githubMessage(result);
  if (isTransient(result.status)) {
    throw new ChannelDeliveryError(`GitHub answered ${result.status} when asked to ${action} on ${where}: ${detail}`);
  }
  if (permission !== undefined) {
    throw new ConfigError(
      `GitHub refused to ${action} on ${where} (${result.status}: ${detail}). Check that the pull request exists and that the identity may do this: a GitHub App needs "${permission}" on this repo, a PAT needs write access to it.`,
    );
  }
  throw new ConfigError(
    `GitHub refused to ${action} on ${where} (${result.status}: ${detail}). Check that the identity opening PRs can write pull requests on this repo and that the base branch exists.`,
  );
}

function clampTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new ConfigError("A pull request needs a title.");
  return trimmed.length <= TITLE_LIMIT ? trimmed : `${trimmed.slice(0, TITLE_LIMIT - 1)}…`;
}

function clampBody(body: string, limit = PR_BODY_LIMIT): string {
  if (body.length <= limit) return body;
  const note = "\n\n_(Truncated to fit GitHub's limit. The full text is in the run artifacts.)_\n";
  return body.slice(0, limit - note.length) + note;
}

/** Cuts a comment to fit GitHub's limit but keeps its dedupe marker last, so a retry still finds it. */
function clampComment(body: string, marker: string | undefined): string {
  if (marker === undefined) return clampBody(body, COMMENT_BODY_LIMIT);
  const tail = `\n\n${marker}`;
  return clampBody(body, COMMENT_BODY_LIMIT - tail.length) + tail;
}

/** The PR half of a broker: finds, opens and updates PRs with a host-held token. The agent never sees it. */
export function pullRequestApi(http: GithubHttp, host: string, auth: PrAuth, author: PrAuthor): PullRequestApi {
  async function findWith(repo: RepoCoordinates, authorization: string, head: string): Promise<PullRequestRef | null> {
    const query = new URLSearchParams({ state: "open", head: `${repo.owner}:${head}`, per_page: "100" });
    const result = await githubRequest<RawPull[]>(http, "GET", `/repos/${repo.owner}/${repo.name}/pulls?${query}`, {
      auth: authorization,
    });
    if (result instanceof TransportFailure || !result.ok) fail("list pull requests", repo, result);
    const pull = Array.isArray(result.body) ? result.body[0] : undefined;
    return pull === undefined ? null : toRef(pull);
  }

  async function addLabels(repo: RepoCoordinates, authorization: string, number: number, labels: string[]) {
    if (labels.length === 0) return;
    const result = await githubRequest(http, "POST", `/repos/${repo.owner}/${repo.name}/issues/${number}/labels`, {
      auth: authorization,
      body: { labels },
    });
    if (result instanceof TransportFailure || !result.ok) fail(`label pull request #${number}`, repo, result);
  }

  async function update(
    repo: RepoCoordinates,
    authorization: string,
    existing: PullRequestRef,
    req: PullRequestRequest,
  ): Promise<PullRequestRef & { created: boolean }> {
    // The REST API cannot flip draft state, so an existing PR keeps whatever a human set.
    const result = await githubRequest<RawPull>(
      http,
      "PATCH",
      `/repos/${repo.owner}/${repo.name}/pulls/${existing.number}`,
      { auth: authorization, body: { title: clampTitle(req.title), body: clampBody(req.body), base: req.base } },
    );
    if (result instanceof TransportFailure || !result.ok) fail(`update pull request #${existing.number}`, repo, result);
    await addLabels(repo, authorization, existing.number, req.labels ?? []);
    return { ...toRef(result.body), draft: result.body.draft ?? existing.draft, created: false };
  }

  /** The first comment on PR `number` that `match`es, following `Link` pages. */
  async function findComment(
    repo: RepoCoordinates,
    authorization: string,
    number: number,
    match: (c: RawComment) => Promise<boolean>,
  ): Promise<RawComment | undefined> {
    const action = `list the comments on pull request #${number}`;
    const origin = new URL(http.apiUrl).origin;
    let url: string | undefined =
      `${http.apiUrl}/repos/${repo.owner}/${repo.name}/issues/${number}/comments?per_page=100`;
    for (let page = 0; url !== undefined && page < MAX_COMMENT_PAGES; page++) {
      let response: Response;
      try {
        response = await http.fetch(url, {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization,
            "user-agent": "selfbuilding",
            "x-github-api-version": "2022-11-28",
          },
        });
      } catch (cause) {
        fail(action, repo, new TransportFailure(cause), "issues: write");
      }
      const text = await response.text().catch(() => "");
      let body: unknown = text;
      try {
        body = text.length > 0 ? JSON.parse(text) : [];
      } catch {
        // Not JSON (a proxy's error page); kept as text for the message.
      }
      if (!response.ok) fail(action, repo, { status: response.status, ok: false, body }, "issues: write");
      for (const comment of Array.isArray(body) ? (body as RawComment[]) : []) if (await match(comment)) return comment;
      const next = nextLink(response.headers.get("link"));
      // The token only ever goes to the API it was minted for, whatever a Link header points at.
      url = next !== undefined && new URL(next).origin === origin ? next : undefined;
    }
    return undefined;
  }

  return {
    async get(repoName, number) {
      const repo = parseRepo(repoName, host);
      const result = await githubRequest<RawPull>(http, "GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`, {
        auth: await auth(repo, { labels: false }),
      });
      if (result instanceof TransportFailure || !result.ok)
        fail(`read pull request #${number}`, repo, result, "pull_requests: read");
      return toInfo(repo, result.body);
    },

    async update(repoName, number, patch: PullRequestPatch) {
      const repo = parseRepo(repoName, host);
      const body: Record<string, string> = {};
      if (patch.title !== undefined) body.title = clampTitle(patch.title);
      if (patch.body !== undefined) body.body = clampBody(patch.body);
      const result = await githubRequest<RawPull>(http, "PATCH", `/repos/${repo.owner}/${repo.name}/pulls/${number}`, {
        auth: await auth(repo, { labels: false }),
        body,
      });
      if (result instanceof TransportFailure || !result.ok)
        fail(`update pull request #${number}`, repo, result, "pull_requests: write");
      return toInfo(repo, result.body);
    },

    async comment(repoName, number, text, opts): Promise<PullRequestComment> {
      const repo = parseRepo(repoName, host);
      // PR comments are issue comments: a GitHub App token needs the issues permission, as for labels.
      const authorization = await auth(repo, { labels: true });
      const marker = opts?.dedupeKey === undefined ? undefined : commentMarker(opts.dedupeKey);
      if (marker !== undefined) {
        // Anyone who can comment can copy a marker (they are predictable from the run id), so only the host
        // identity's own comment counts as the one already posted.
        let self: string | undefined;
        const existing = await findComment(repo, authorization, number, async (c) => {
          if (!(c.body ?? "").includes(marker)) return false;
          self ??= (await author(repo, authorization)).toLowerCase();
          return (c.user?.login ?? "").toLowerCase() === self;
        });
        if (existing) return { id: existing.id, url: existing.html_url, created: false };
      }
      const result = await githubRequest<RawComment>(
        http,
        "POST",
        `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`,
        { auth: authorization, body: { body: clampComment(text, marker) } },
      );
      if (result instanceof TransportFailure || !result.ok)
        fail(`comment on pull request #${number}`, repo, result, "issues: write");
      return { id: result.body.id, url: result.body.html_url, created: true };
    },

    async findOpen(repoName, head) {
      const repo = parseRepo(repoName, host);
      return findWith(repo, await auth(repo, { labels: false }), head);
    },

    async openOrUpdate(req) {
      const repo = parseRepo(req.repo, host);
      const authorization = await auth(repo, { labels: (req.labels ?? []).length > 0 });
      const existing = await findWith(repo, authorization, req.head);
      if (existing) return update(repo, authorization, existing, req);

      const created = await githubRequest<RawPull>(http, "POST", `/repos/${repo.owner}/${repo.name}/pulls`, {
        auth: authorization,
        body: {
          title: clampTitle(req.title),
          body: clampBody(req.body),
          head: req.head,
          base: req.base,
          draft: req.draft,
        },
      });
      if (!(created instanceof TransportFailure) && created.status === 422) {
        // Lost a race with another opener (a retried accept, say): update the PR that won.
        const raced = await findWith(repo, authorization, req.head);
        if (raced) return update(repo, authorization, raced, req);
      }
      if (created instanceof TransportFailure || !created.ok)
        fail(`open a pull request for ${req.head}`, repo, created);
      await addLabels(repo, authorization, created.body.number, req.labels ?? []);
      return { ...toRef(created.body), created: true };
    },
  };
}

export interface PrBodyParts {
  summary: string;
  /** The agent's `implementation-notes.md`: decisions, deviations, tradeoffs and open questions. */
  implementationNotes?: string;
  /** `git diff --stat base..head`. */
  diffStat?: string;
  runUrl?: string;
  trailers?: { run: string; call: string; agent: string };
}

/**
 * The default PR body (spec §6.13): the summary, the implementation notes, the diff stat, the run link and the
 * trailers. When it would pass GitHub's limit, the notes are cut first so the trailers always survive.
 */
export function prBody(parts: PrBodyParts): string {
  const head = parts.summary.trim();
  const tailSections: string[] = [];
  if (parts.diffStat?.trim()) tailSections.push(`## Changes\n\n\`\`\`\n${parts.diffStat.trimEnd()}\n\`\`\``);
  const footer: string[] = [];
  if (parts.runUrl) footer.push(`Run: ${parts.runUrl}`);
  if (parts.trailers) {
    footer.push(
      `Selfbuilding-Run: ${parts.trailers.run}\nSelfbuilding-Call: ${parts.trailers.call}\nSelfbuilding-Agent: ${parts.trailers.agent}`,
    );
  }
  if (footer.length > 0) tailSections.push(`---\n\n${footer.join("\n\n")}`);
  const tail = tailSections.length > 0 ? `\n\n${tailSections.join("\n\n")}\n` : "\n";

  const notes = parts.implementationNotes?.trim();
  if (!notes) return clampBody(head + tail);
  const notesHeading = "\n\n## Implementation notes\n\n";
  const room = PR_BODY_LIMIT - head.length - notesHeading.length - tail.length;
  const cut = "\n\n_(Notes truncated to fit GitHub's limit. The full file is in the run artifacts.)_";
  const fitted = notes.length <= room ? notes : notes.slice(0, Math.max(0, room - cut.length)) + cut;
  return clampBody(head + notesHeading + fitted + tail);
}

/** The default title (spec §6.13): `prTitle` from the result, else `<agent>: <first 72 chars of the summary>`. */
export function defaultPrTitle(agentName: string, result: { prTitle?: string; summary?: string }): string {
  if (result.prTitle?.trim()) return result.prTitle.trim();
  const firstLine = (result.summary ?? "").trim().split("\n")[0] ?? "";
  return firstLine.length > 0 ? `${agentName}: ${firstLine.slice(0, 72)}` : agentName;
}

/**
 * Opens or updates the PR for a pushed branch, as the broker's host identity (the GitHub App in v1). Spec §6.13
 * order: verify the push, look up an open PR for the head, create or update it. Pass the push result; a branch
 * that is not verifiably on the remote never gets a PR.
 */
export async function openOrUpdatePr(
  broker: Pick<GitCredentialBroker, "pullRequests"> | PullRequestApi,
  req: PullRequestRequest & { push?: { pushed: boolean; refs?: { ref: string; sha: string }[] } },
): Promise<PullRequestRef & { created: boolean }> {
  const api = "openOrUpdate" in broker ? broker : broker.pullRequests;
  if (!api) {
    throw new ConfigError(
      "This git broker cannot open pull requests. Use githubApp({ appId, privateKey }) (or pat({ push })) as config.git.",
    );
  }
  const { push, ...request } = req;
  if (push !== undefined) {
    const headRef = `refs/heads/${request.head}`;
    const pushedHead = push.refs === undefined || push.refs.some((r) => r.ref === headRef);
    if (!push.pushed || !pushedHead) {
      throw new PushFailedError(
        `${request.head} is not verified on the remote, so no pull request was opened. Push the branch (pushBranch) and pass its result.`,
        { recovery: { branch: request.head } },
      );
    }
  }
  return api.openOrUpdate(request);
}
