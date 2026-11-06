// The GitHub side of the acceptance suite: the GitHub emulator, the playground repo, and the real githubApp()
// broker opening PRs as the App.
//
// The emulator has no git smart HTTP, so boxes clone from and the host pushes to a local bare remote. Before a PR
// is opened or updated, the pushed head is mirrored into the emulator (spec §10.3), and the run's repo (the bare
// remote's file URL) is mapped to the emulator's "github.com/<owner>/<repo>".
import { githubApp } from "@selfbuilding/channel-github";
import type { PullRequestApi } from "@selfbuilding/core";
import {
  type GitHubEmulator,
  mirrorRefs,
  type Playground,
  seedPlayground,
  startGitHubEmulator,
} from "@selfbuilding/testing";

export interface PullSummary {
  number: number;
  state: string;
  merged: boolean;
  draft: boolean;
  title: string;
  body: string | null;
  user: { login: string; type?: string };
  head: { ref: string; sha: string };
  base: { ref: string };
}

export interface GitHubRig {
  gh: GitHubEmulator;
  playground: Playground;
  /** The repo agents clone: the bare remote's file URL. */
  repo: string;
  /** The App's PR API, mirroring each pushed head into the emulator first. */
  pullRequests: PullRequestApi;
  /** Every PR opened through `pullRequests`, in order. */
  opened: { head: string; title: string }[];
  pulls(): Promise<PullSummary[]>;
  close(): Promise<void>;
}

export async function startGitHubRig(dir: string): Promise<GitHubRig> {
  const gh = await startGitHubEmulator();
  const playground = await seedPlayground(gh, { dir });
  const app = githubApp({ appId: gh.app.appId, privateKey: gh.appPrivateKey, apiUrl: gh.url });
  const fullName = `github.com/${gh.owner}/${gh.repo}`;
  const opened: { head: string; title: string }[] = [];
  const mirror = (head: string) =>
    mirrorRefs(gh, { gitDir: playground.remote.bareDir, refs: [head], env: playground.remote.env });

  const pullRequests: PullRequestApi = {
    async openOrUpdate(req) {
      await mirror(req.head);
      opened.push({ head: req.head, title: req.title });
      return app.pullRequests.openOrUpdate({ ...req, repo: fullName });
    },
    findOpen: (_repo, head) => app.pullRequests.findOpen(fullName, head),
  };

  return {
    gh,
    playground,
    repo: playground.remote.url,
    pullRequests,
    opened,
    pulls: () => gh.api<PullSummary[]>(`/repos/${gh.owner}/${gh.repo}/pulls?state=all`),
    async close() {
      await gh.close();
      await playground.dispose();
    },
  };
}
