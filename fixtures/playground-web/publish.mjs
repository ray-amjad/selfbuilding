#!/usr/bin/env node
// Publishes this fixture to the playground repository. Run by hand, never from a test.
//
//   node fixtures/playground-web/publish.mjs            build both branches in a temp clone and show them
//   node fixtures/playground-web/publish.mjs --push     ...and push them
//   node fixtures/playground-web/publish.mjs --remote <git url>   use another remote (a local bare repo, say)
//
// `main` gets web/, .selfbuilding/verify/ and docs/specs/web-mark-done.md; every other file already in the
// repository (the small library the review fixture uses) is kept. The fixture branch is `main` plus
// web-broken-add.patch and is rebuilt from scratch each time, so it is force-pushed.
//
// Environment: SELFBUILDING_PLAYGROUND (default github.com/ray-amjad/selfbuilding-playground),
// SELFBUILDING_PLAYGROUND_WEB_BROKEN (default fixture/web-broken-add), and a push token in
// SELFBUILDING_PLAYGROUND_TOKEN, GH_TOKEN or GITHUB_TOKEN. Without a token, git's own credential helper is used.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCH = join(HERE, "web-broken-add.patch");
/** Paths copied into the repository, relative to both this folder and the repository root. */
const PUBLISHED = ["web", ".selfbuilding/verify", "docs/specs/web-mark-done.md"];
/** Never published: install, build and runtime output. */
const SKIPPED = new Set(["node_modules", ".next", "data", "next-env.d.ts"]);

const { values } = parseArgs({
  options: { push: { type: "boolean", default: false }, remote: { type: "string" } },
});
const env = process.env;
const repoName = env.SELFBUILDING_PLAYGROUND ?? "github.com/ray-amjad/selfbuilding-playground";
const remote = values.remote ?? `https://${repoName}.git`;
const brokenBranch = env.SELFBUILDING_PLAYGROUND_WEB_BROKEN ?? "fixture/web-broken-add";
const token = env.SELFBUILDING_PLAYGROUND_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN;

// The token travels in git's environment-supplied config, so it never appears in argv, the remote URL or
// .git/config of the clone.
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

const work = mkdtempSync(join(tmpdir(), "playground-web-publish-"));
const clone = join(work, "repo");
console.log(`cloning ${remote}`);
git(work, "clone", "--quiet", remote, clone);
const defaultBranch = git(clone, "rev-parse", "--abbrev-ref", "HEAD");
if (defaultBranch !== "main") throw new Error(`expected the default branch to be main, found ${defaultBranch}`);

for (const path of PUBLISHED) {
  const from = join(HERE, path);
  const to = join(clone, path);
  if (!existsSync(from)) throw new Error(`missing fixture file ${from}`);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !SKIPPED.has(basename(source)) && !source.endsWith(".tsbuildinfo"),
  });
}

git(clone, "add", "--all", "--", ...PUBLISHED);
const mainChanged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: clone }).status !== 0;
if (mainChanged) {
  git(clone, "commit", "--quiet", "-m", "web: the Notes app, its verify facts and the mark-done spec");
  console.log(`main: committed ${git(clone, "rev-parse", "--short", "HEAD")}`);
} else {
  console.log("main: already up to date");
}

git(clone, "checkout", "--quiet", "-B", brokenBranch, "main");
git(clone, "apply", "--index", PATCH);
git(clone, "commit", "--quiet", "-m", "web: show a new note straight away after adding it");
console.log(`${brokenBranch}: committed ${git(clone, "rev-parse", "--short", "HEAD")} on top of main`);
console.log(git(clone, "diff", "--stat", "main", brokenBranch));

if (!values.push) {
  console.log(`\nnot pushed (pass --push). Inspect the clone at ${clone}`);
  process.exit(0);
}

if (mainChanged) git(clone, "push", "--quiet", "origin", "main");
git(clone, "push", "--quiet", `--force-with-lease=${brokenBranch}`, "origin", brokenBranch);
console.log(`pushed main${mainChanged ? "" : " (unchanged)"} and ${brokenBranch} to ${remote}`);
rmSync(work, { recursive: true, force: true });
