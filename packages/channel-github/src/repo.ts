import { ConfigError } from "@selfbuilding/core";

export interface RepoCoordinates {
  host: string;
  owner: string;
  name: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Parses "github.com/acme/api" (also with https:// and .git, or the "acme/api" shorthand) and checks the host is
 * the one the broker answers for, so a token is never minted for a repo on another host.
 */
export function parseRepo(repo: string, host: string): RepoCoordinates {
  const trimmed = repo
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const parts = trimmed.split("/");
  const [repoHost, owner, name] = parts.length === 2 ? [host, parts[0], parts[1]] : parts;
  if (parts.length < 2 || parts.length > 3 || !owner || !name || !SEGMENT.test(owner) || !SEGMENT.test(name)) {
    throw new ConfigError(`"${repo}" is not a repository. Write it as "${host}/<owner>/<repo>".`);
  }
  if (repoHost?.toLowerCase() !== host.toLowerCase()) {
    throw new ConfigError(
      `"${repo}" is on ${repoHost}, but this git broker answers only for ${host}. Pass host: "${repoHost}" to the broker, or use a repo on ${host}.`,
    );
  }
  return { host, owner, name };
}
