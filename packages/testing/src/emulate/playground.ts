import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitHubEmulator } from "./github.js";

const run = promisify(execFile);

/** HOME, git config and TMPDIR for one test, so the developer's own config never affects a result (spec §10.3). */
export function isolatedEnv(dir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: dir,
    TMPDIR: dir,
    GIT_CONFIG_GLOBAL: path.join(dir, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Selfbuilding Test",
    GIT_AUTHOR_EMAIL: "test@selfbuilding.test",
    GIT_COMMITTER_NAME: "Selfbuilding Test",
    GIT_COMMITTER_EMAIL: "test@selfbuilding.test",
    // Fixed dates make commit shas repeatable across runs.
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
}

async function git(cwd: string, args: string[], env: Record<string, string>): Promise<string> {
  const { stdout } = await run("git", args, { cwd, env, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}

async function gitBuffer(cwd: string, args: string[], env: Record<string, string>): Promise<Buffer> {
  const { stdout } = await run("git", args, { cwd, env, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" });
  return stdout;
}

/** A small Node project with a spec to implement and a test, used as the playground repo's initial content. */
export const PLAYGROUND_FILES: Readonly<Record<string, string>> = {
  "README.md": "# playground\n\nA tiny repo the offline tests build on.\n",
  "package.json": `${JSON.stringify({ name: "playground", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/math.js": "export function add(a, b) {\n  return a + b;\n}\n",
  "test/math.test.js":
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
  "docs/specs/multiply.md":
    "# Add multiply\n\nExport `multiply(a, b)` from `src/math.js` and cover it with a test in `test/math.test.js`.\n",
};

export interface LocalRemote {
  /** The bare repository: the git remote agents push to (the emulator has no smart HTTP). */
  bareDir: string;
  /** `file://` URL of the bare repository. */
  url: string;
  defaultBranch: string;
  /** The default branch's head in the bare repository. */
  headSha: string;
  env: Record<string, string>;
}

/** Creates a bare repository holding `files` as one commit on `branch`. */
export async function createLocalRemote(
  dir: string,
  opts: { files?: Readonly<Record<string, string>>; branch?: string; message?: string } = {},
): Promise<LocalRemote> {
  const branch = opts.branch ?? "main";
  const env = isolatedEnv(dir);
  const bareDir = path.join(dir, "remote.git");
  const seedDir = path.join(dir, "seed");
  await fs.mkdir(seedDir, { recursive: true });
  await git(dir, ["init", "-q", "--bare", `--initial-branch=${branch}`, bareDir], env);
  await git(seedDir, ["init", "-q", `--initial-branch=${branch}`], env);
  await writeTree(seedDir, opts.files ?? PLAYGROUND_FILES);
  await git(seedDir, ["add", "-A"], env);
  await git(seedDir, ["commit", "-q", "-m", opts.message ?? "Initial commit"], env);
  await git(seedDir, ["push", "-q", bareDir, `HEAD:refs/heads/${branch}`], env);
  const headSha = (await git(bareDir, ["rev-parse", `refs/heads/${branch}`], env)).trim();
  await fs.rm(seedDir, { recursive: true, force: true });
  return { bareDir, url: `file://${bareDir}`, defaultBranch: branch, headSha, env };
}

async function writeTree(dir: string, files: Readonly<Record<string, string | null>>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    if (content === null) {
      await fs.rm(target, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

/** Commits `files` (null deletes) on a new branch of the local remote and pushes it there. Returns the new head. */
export async function commitToBranch(
  remote: LocalRemote,
  opts: { branch: string; files: Readonly<Record<string, string | null>>; message?: string; from?: string },
): Promise<string> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "sbt-clone-"));
  try {
    await git(work, ["clone", "-q", remote.bareDir, "."], remote.env);
    await git(work, ["checkout", "-q", "-B", opts.branch, `origin/${opts.from ?? remote.defaultBranch}`], remote.env);
    await writeTree(work, opts.files);
    await git(work, ["add", "-A"], remote.env);
    await git(work, ["commit", "-q", "-m", opts.message ?? `Update ${opts.branch}`], remote.env);
    await git(work, ["push", "-q", "--force", "origin", `HEAD:refs/heads/${opts.branch}`], remote.env);
    return (await git(work, ["rev-parse", "HEAD"], remote.env)).trim();
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

interface CommitObject {
  tree: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  message: string;
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) throw new Error(`Unparseable git identity: ${line}`);
  const [, name = "", email = "", epoch = "0"] = match;
  return { name, email, date: new Date(Number(epoch) * 1000).toISOString().replace(/\.000Z$/, "Z") };
}

function parseCommit(raw: string): CommitObject {
  const split = raw.indexOf("\n\n");
  const header = raw.slice(0, split).split("\n");
  const commit: CommitObject = {
    tree: "",
    parents: [],
    author: { name: "", email: "", date: "" },
    committer: { name: "", email: "", date: "" },
    message: raw.slice(split + 2),
  };
  for (const line of header) {
    if (line.startsWith("tree ")) commit.tree = line.slice(5);
    else if (line.startsWith("parent ")) commit.parents.push(line.slice(7));
    else if (line.startsWith("author ")) commit.author = parseIdent(line.slice(7));
    else if (line.startsWith("committer ")) commit.committer = parseIdent(line.slice(10));
  }
  return commit;
}

// local sha -> emulator sha, per emulator repository. Entries are re-checked before use, because reset() wipes them.
const mirrored = new Map<string, Map<string, string>>();

/**
 * Mirrors refs from a local git repository into the GitHub emulator through the git data API (spec §10.3: the
 * emulator has no smart HTTP, so pushes go to a local bare repo and a helper copies them before `pulls.create`).
 * Every commit is recreated with its tree, parents, authorship and message. Returns ref -> emulator sha.
 */
export async function mirrorRefs(
  gh: GitHubEmulator,
  opts: { gitDir: string; refs: string[]; env?: Record<string, string> },
): Promise<Record<string, string>> {
  const env = opts.env ?? isolatedEnv(os.tmpdir());
  const repoKey = `${gh.url}/${gh.owner}/${gh.repo}`;
  const map = mirrored.get(repoKey) ?? new Map<string, string>();
  mirrored.set(repoKey, map);
  const base = `/repos/${gh.owner}/${gh.repo}`;

  const exists = async (sha: string): Promise<boolean> => {
    try {
      await gh.api(`${base}/git/commits/${sha}`);
      return true;
    } catch {
      return false;
    }
  };

  const out: Record<string, string> = {};
  for (const ref of opts.refs) {
    const full = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
    const commits = (await git(opts.gitDir, ["rev-list", "--reverse", "--topo-order", full], env))
      .split("\n")
      .filter(Boolean);
    for (const sha of commits) {
      const known = map.get(sha);
      if (known && (await exists(known))) continue;
      const commit = parseCommit(await git(opts.gitDir, ["cat-file", "commit", sha], env));
      const entries = (await gitBuffer(opts.gitDir, ["ls-tree", "-r", "-z", "--full-tree", sha], env))
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      const tree: { path: string; mode: string; type: "blob"; sha: string }[] = [];
      for (const entry of entries) {
        const tab = entry.indexOf("\t");
        const [mode = "", type = "", blobSha = ""] = entry.slice(0, tab).split(" ");
        if (type !== "blob") continue;
        const content = await gitBuffer(opts.gitDir, ["cat-file", "blob", blobSha], env);
        const blob = await gh.api<{ sha: string }>(`${base}/git/blobs`, {
          body: { content: content.toString("base64"), encoding: "base64" },
        });
        tree.push({ path: entry.slice(tab + 1), mode, type: "blob", sha: blob.sha });
      }
      const remoteTree = await gh.api<{ sha: string }>(`${base}/git/trees`, { body: { tree } });
      const parents = commit.parents.map((p) => {
        const mapped = map.get(p);
        if (!mapped) throw new Error(`Parent ${p} of ${sha} was not mirrored.`);
        return mapped;
      });
      const created = await gh.api<{ sha: string }>(`${base}/git/commits`, {
        body: {
          message: commit.message,
          tree: remoteTree.sha,
          parents,
          author: commit.author,
          committer: commit.committer,
        },
      });
      map.set(sha, created.sha);
    }
    const head = commits.at(-1);
    if (!head) continue;
    const remoteSha = map.get(head) as string;
    const refPath = full.slice("refs/".length);
    try {
      await gh.api(`${base}/git/refs/${refPath}`, { method: "PATCH", body: { sha: remoteSha, force: true } });
    } catch {
      await gh.api(`${base}/git/refs`, { body: { ref: full, sha: remoteSha } });
    }
    out[full] = remoteSha;
  }
  return out;
}

export interface Playground {
  remote: LocalRemote;
  /** The default branch head in the emulator. */
  baseSha: string;
  /** Removes the local remote's directory when `seedPlayground` created it. */
  dispose(): Promise<void>;
}

/** Creates the local remote with the playground files and makes the emulator's default branch match it. */
export async function seedPlayground(
  gh: GitHubEmulator,
  opts: { dir?: string; files?: Readonly<Record<string, string>> } = {},
): Promise<Playground> {
  const owned = opts.dir === undefined;
  const dir = opts.dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "sbt-playground-")));
  const remote = await createLocalRemote(dir, opts.files === undefined ? {} : { files: opts.files });
  const refs = await mirrorRefs(gh, { gitDir: remote.bareDir, refs: [remote.defaultBranch], env: remote.env });
  return {
    remote,
    baseSha: refs[`refs/heads/${remote.defaultBranch}`] as string,
    dispose: async () => {
      if (owned) await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export interface PlaygroundPr {
  number: number;
  branch: string;
  /** Head in the emulator. */
  headSha: string;
  /** Head in the local remote. */
  localHeadSha: string;
  baseSha: string;
  htmlUrl: string;
}

/** Commits `files` on `branch` in the local remote, mirrors it, and opens a PR against the default branch. */
export async function openPlaygroundPr(
  gh: GitHubEmulator,
  playground: Playground,
  opts: {
    branch: string;
    files: Readonly<Record<string, string | null>>;
    title?: string;
    body?: string;
    message?: string;
    as?: "bot" | "reviewer";
  },
): Promise<PlaygroundPr> {
  const { remote } = playground;
  const localHeadSha = await commitToBranch(remote, {
    branch: opts.branch,
    files: opts.files,
    ...(opts.message === undefined ? {} : { message: opts.message }),
  });
  const refs = await mirrorRefs(gh, { gitDir: remote.bareDir, refs: [opts.branch], env: remote.env });
  const pr = await gh.api<{ number: number; html_url: string; head: { sha: string }; base: { sha: string } }>(
    `/repos/${gh.owner}/${gh.repo}/pulls`,
    {
      body: { title: opts.title ?? opts.branch, body: opts.body ?? "", head: opts.branch, base: remote.defaultBranch },
      ...(opts.as === undefined ? {} : { as: opts.as }),
    },
  );
  return {
    number: pr.number,
    branch: opts.branch,
    headSha: refs[`refs/heads/${opts.branch}`] ?? pr.head.sha,
    localHeadSha,
    baseSha: pr.base.sha,
    htmlUrl: pr.html_url,
  };
}
