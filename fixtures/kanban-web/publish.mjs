#!/usr/bin/env node
// Publishes this fixture as the root of the `kanban` branch of the playground repository. Run by hand, never
// from a test.
//
//   node fixtures/kanban-web/publish.mjs            build the branch in a temp repository and show it
//   node fixtures/kanban-web/publish.mjs --push     ...and push it
//   node fixtures/kanban-web/publish.mjs --remote <git url>   use another remote (a local bare repo, say)
//
// The branch shares no history with `main`: the first publish creates it as an orphan, later ones add a commit
// on top of the remote branch only when the files changed, so it is never force-pushed. Only that one branch is
// fetched or pushed; every other branch of the repository is left alone.
//
// Environment: SELFBUILDING_PLAYGROUND (default github.com/ray-amjad/selfbuilding-playground),
// SELFBUILDING_PLAYGROUND_KANBAN (default kanban), and a push token in SELFBUILDING_PLAYGROUND_TOKEN, GH_TOKEN or
// GITHUB_TOKEN. Without a token, git's own credential helper is used.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Never published: this script, and install, build and runtime output. */
const SKIPPED = new Set(["publish.mjs", "node_modules", ".next", "data", "next-env.d.ts"]);

const { values } = parseArgs({
  options: { push: { type: "boolean", default: false }, remote: { type: "string" } },
});
const env = process.env;
const repoName = env.SELFBUILDING_PLAYGROUND ?? "github.com/ray-amjad/selfbuilding-playground";
const remote = values.remote ?? `https://${repoName}.git`;
const branch = env.SELFBUILDING_PLAYGROUND_KANBAN ?? "kanban";
const token = env.SELFBUILDING_PLAYGROUND_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN;

// The token travels in git's environment-supplied config, so it never appears in argv, the remote URL or
// .git/config of the temp repository.
const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
if (token && remote.startsWith("https://github.com/")) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  Object.assign(gitEnv, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  });
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.status}):\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

const work = mkdtempSync(join(tmpdir(), "kanban-web-publish-"));
git(work, "init", "--quiet", "--initial-branch", branch);
git(work, "remote", "add", "origin", remote);

console.log(`looking for ${branch} on ${remote}`);
const existing = git(work, "ls-remote", "--heads", "origin", branch);
let parent;
if (existing) {
  git(work, "fetch", "--quiet", "--depth=1", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`);
  parent = git(work, "rev-parse", `refs/remotes/origin/${branch}`);
  console.log(`${branch}: exists at ${parent.slice(0, 7)}`);
} else {
  console.log(`${branch}: not on the remote yet; it will be created as an orphan branch`);
}

for (const entry of readdirSync(HERE)) {
  if (SKIPPED.has(entry)) continue;
  cpSync(join(HERE, entry), join(work, entry), {
    recursive: true,
    // CLAUDE.md is a relative symlink to AGENTS.md; keep it one rather than resolving it to an absolute path.
    verbatimSymlinks: true,
    filter: (source) => !SKIPPED.has(basename(source)) && !source.endsWith(".tsbuildinfo"),
  });
}
git(work, "add", "--all");
const tree = git(work, "write-tree");

const changed = !parent || git(work, "rev-parse", `${parent}^{tree}`) !== tree;
if (changed) {
  const message = "kanban: the Board app, its verify facts and the move-and-limit spec";
  const commit = git(work, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message);
  git(work, "update-ref", `refs/heads/${branch}`, commit);
  console.log(`${branch}: committed ${commit.slice(0, 7)}${parent ? ` on top of ${parent.slice(0, 7)}` : " (orphan)"}`);
} else {
  console.log(`${branch}: already up to date`);
}
console.log(git(work, "ls-files"));

if (!values.push) {
  console.log(`\nnot pushed (pass --push). Inspect the repository at ${work}`);
  process.exit(0);
}

if (changed) {
  // Only this one ref is pushed; the lease refuses to overwrite anything pushed since the fetch above.
  git(
    work,
    "push",
    "--quiet",
    `--force-with-lease=${branch}:${parent ?? ""}`,
    "origin",
    `${branch}:refs/heads/${branch}`,
  );
  console.log(`pushed ${branch} to ${remote}`);
} else {
  console.log(`${branch} unchanged; nothing pushed`);
}
rmSync(work, { recursive: true, force: true });
