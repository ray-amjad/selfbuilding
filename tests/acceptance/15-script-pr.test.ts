// Acceptance 15 (docs/spec/release-prep.md §2.5): a workflow script keeps its PR as the record of the run.
//
// 1. A script on the scripted harness and the tmpdir provider builds, opens a PR on the emulated GitHub as the App,
//    posts the round markers and writes the three body sections with sb.pr. A run that dies right after a comment
//    is posted, before the journal records it, resumes without posting it again.
// 2. The worked example (tests/live/task-lifecycle/lifecycle.mjs) runs as written, with stand-in agents, against a
//    PR on the emulated GitHub: review and fix markers per round, the three sections, nothing posted twice.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMPLEMENTATION_NOTES_PATH, ImplementSpec } from "@selfbuilding/agents";
import { githubApp } from "@selfbuilding/channel-github";
import {
  type AgentCallOptions,
  fileArtifacts,
  fileJournal,
  type GitCredentialBroker,
  type JournalStore,
  type Json,
  type PullRequestApi,
  run,
} from "@selfbuilding/core";
import { createScriptFactory, type RunScriptOptions } from "@selfbuilding/script";
import {
  commitToBranch,
  type GitHubEmulator,
  mirrorRefs,
  type Playground,
  type ScriptCall,
  type ScriptStep,
  scripted,
  seedPlayground,
  startGitHubEmulator,
  type TmpdirProvider,
  tmpdirProvider,
} from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recorder, scriptedClaude, tempDir, useBuiltRuntime } from "./support/kit.js";

let dir: string;
let gh: GitHubEmulator;
let playground: Playground;
let boxes: TmpdirProvider;

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-script-pr-");
  gh = await startGitHubEmulator();
  playground = await seedPlayground(gh, { dir: path.join(dir, "remote") });
  boxes = tmpdirProvider({ root: path.join(dir, "boxes") });
});

afterAll(async () => {
  await boxes?.close();
  await gh?.close();
  await playground?.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const fullName = () => `github.com/${gh.owner}/${gh.repo}`;
// The emulator serves PR pages on its own origin; the run's broker answers for github.com, as in production.
const publicUrl = (url: string) => url.replace(/^https?:\/\/[^/]+/, "https://github.com");
const withPublicUrl = <T extends { url: string }>(x: T): T => ({ ...x, url: publicUrl(x.url) });

/**
 * The App's PR API on the emulator, as config.git: the run's repo (the bare remote) maps to the emulator's repo,
 * and each pushed head is mirrored there before a PR is opened (the emulator has no git smart HTTP).
 */
function broker(): GitCredentialBroker {
  const app = githubApp({ appId: gh.app.appId, privateKey: gh.appPrivateKey, apiUrl: gh.url })
    .pullRequests as Required<PullRequestApi>;
  const pullRequests: Required<PullRequestApi> = {
    async openOrUpdate(req) {
      await mirrorRefs(gh, { gitDir: playground.remote.bareDir, refs: [req.head], env: playground.remote.env });
      return withPublicUrl(await app.openOrUpdate({ ...req, repo: fullName() }));
    },
    findOpen: async (_repo, head) => {
      const ref = await app.findOpen(fullName(), head);
      return ref ? withPublicUrl(ref) : null;
    },
    get: async (repo, n) => withPublicUrl(await app.get(repo, n)),
    update: async (repo, n, patch) => withPublicUrl(await app.update(repo, n, patch)),
    comment: (repo, n, body, opts) => app.comment(repo, n, body, opts),
  };
  const refuse = async () => {
    throw new Error("the file remote needs no token");
  };
  return { id: "acceptance-app", host: "github.com", readToken: refuse, pushToken: refuse, pullRequests };
}

interface Comment {
  id: number;
  body: string;
  user: { login: string };
}

const comments = (n: number) => gh.api<Comment[]>(`/repos/${gh.owner}/${gh.repo}/issues/${n}/comments?per_page=100`);
const pull = (n: number) => gh.api<{ body: string; head: { sha: string } }>(`/repos/${gh.owner}/${gh.repo}/pulls/${n}`);

/** Fails the first `ok` write of a `pr.comment` step, as a process killed right after the post would. */
function crashAfterFirstComment(inner: JournalStore): JournalStore {
  let crashed = false;
  return new Proxy(inner, {
    get(target, key) {
      if (key === "put") {
        return async (...args: Parameters<JournalStore["put"]>) => {
          const [entry] = args;
          if (!crashed && entry.status === "ok" && entry.callPath.startsWith("pr.comment")) {
            crashed = true;
            throw new Error("process killed after the post");
          }
          return target.put(...args);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const MATH = "export function multiply(a, b) {\n  return a * b;\n}\n";
const heredoc = (file: string, content: string) =>
  `mkdir -p "$(dirname ${file})" && cat > ${file} <<'EOF'\n${content}EOF`;

function harnessScript(call: ScriptCall): ScriptStep[] {
  if (call.callPath.split("/").at(-1) !== "implement") return [scripted.say(`no script for ${call.callPath}`)];
  return [
    scripted.sh(heredoc("src/math.js", MATH)),
    scripted.sh(heredoc(IMPLEMENTATION_NOTES_PATH, "# Implementation notes\n\n## Design decisions\n- one file.\n")),
    scripted.sh("git add -A && git commit -qm 'Add multiply'"),
    scripted.submit({
      status: "done",
      summary: "Added multiply(a, b).",
      changes: [{ file: "src/math.js", why: "the spec asks for multiply" }],
      tests: { command: "true", passed: true },
      followUps: ["Accept bigints"],
      openQuestions: [],
      prTitle: "Add multiply",
      prBody: "Adds multiply(a, b).",
    }),
  ];
}

const SPEC = "# Multiply\n\n## Goal\n\nAdd multiply(a, b) to src/math.js.\n";

/** The lifecycle's PR writes in miniature: sections after the build, a reviewed and a complete marker, Verified. */
const SCRIPT = `export default async function main(input, sb) {
  const box = sb.sandbox({ label: "build", repo: input.repo });
  const build = await sb.agents.ImplementSpec(
    { spec: input.spec },
    { sandbox: box, label: "implement", harness: "claude-code", pr: { draft: true } },
  );
  const pr = build.artifacts.pr;
  await sb.pr.update({ pr, section: { heading: "What changed and why", content: build.result.summary + "\\n\\nFollow-ups:\\n- " + build.result.followUps.join("\\n- ") } });
  await sb.pr.update({ pr, section: { heading: "Source", content: "\`\`\`\`\\n" + input.spec + "\\n\`\`\`\`" } });
  await sb.pr.comment({ pr, body: "### Review round 1\\n\\n- none\\n\\n<!-- task-lifecycle-round:1 stage:reviewed -->" });
  await box.push();
  const head = (await sb.pr.get(pr)).headSha;
  await sb.pr.comment({ pr, body: "### Fixes for round 1: done\\n\\n<!-- task-lifecycle-round:1 stage:complete head:" + head + " -->" });
  await sb.pr.update({ pr, section: { heading: "Verified", content: "- ✅ multiply: verified, multiply(2, 3) returned 6" } });
  await box.dispose();
  return { number: pr.number, head };
}`;

describe("acceptance 15: workflow scripts on their PR", () => {
  it("builds, opens the PR, posts the round markers and writes three sections; a crash after a post posts once", async () => {
    const runId = "ns_accept_script_pr";
    const journal = fileJournal(path.join(dir, "journal"));
    const events = recorder();
    const f = createScriptFactory({
      agents: { ImplementSpec },
      harnesses: { "claude-code": scriptedClaude(harnessScript) },
    });
    const attempt = (j: JournalStore) =>
      run(
        f,
        { source: SCRIPT, name: "script-pr", input: { repo: playground.remote.url, spec: SPEC } },
        {
          runId,
          config: {
            deployment: "acceptance",
            sandbox: boxes,
            harness: scriptedClaude(harnessScript),
            artifacts: fileArtifacts(path.join(dir, "artifacts")),
            git: broker(),
          },
          journal: j,
          events: [events.sink],
        },
      );

    const crashed = await attempt(crashAfterFirstComment(journal));
    expect(crashed.status).not.toBe("ok");
    const pulls = await gh.api<{ number: number }[]>(`/repos/${gh.owner}/${gh.repo}/pulls?state=all`);
    expect(pulls).toHaveLength(1);
    const number = pulls[0]?.number as number;
    expect((await comments(number)).map((c) => c.body)).toHaveLength(1);

    const resumed = await attempt(journal);
    expect(resumed.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
    const out = resumed.output as { number: number; head: string };
    expect(out.number).toBe(number);

    const posted = await comments(number);
    expect(posted).toHaveLength(2);
    expect(posted.every((c) => c.user.login === `${gh.app.slug}[bot]`)).toBe(true);
    expect(posted[0]?.body).toContain("<!-- task-lifecycle-round:1 stage:reviewed -->");
    expect(posted[0]?.body).toMatch(/<!-- selfbuilding:comment:ns_accept_script_pr\.pr\.comment#0 -->$/);
    const head = (await pull(number)).head.sha;
    expect(out.head).toBe(head);
    expect(posted[1]?.body).toContain(`<!-- task-lifecycle-round:1 stage:complete head:${head} -->`);

    const body = (await pull(number)).body;
    const at = (s: string) => body.indexOf(s);
    expect(body.startsWith("Adds multiply(a, b).")).toBe(true);
    expect(body).toContain("## What changed and why\n\nAdded multiply(a, b).\n\nFollow-ups:\n- Accept bigints\n\n");
    expect(body).toContain(`## Source\n\n\`\`\`\`\n${SPEC}\n\`\`\`\`\n\n`);
    expect(body).toContain("## Verified\n\n- ✅ multiply: verified, multiply(2, 3) returned 6\n\n");
    // The sections sit in write order before the trailer, which survives untouched.
    expect(at("## What changed and why")).toBeLessThan(at("## Source"));
    expect(at("## Source")).toBeLessThan(at("## Verified"));
    expect(at("## Verified")).toBeLessThan(at("\n---\n"));
    expect(body).toMatch(/\n---\n[\s\S]*Selfbuilding-Run: ns_accept_script_pr\n/);
    // The spec's own "## Goal" heading stays inside the Source fence.
    expect(body.match(/^## /gm)).toHaveLength(4);

    // A third run replays everything: no new comment, no edit.
    const replayed = await attempt(journal);
    expect(replayed.output).toEqual(out);
    expect(await comments(number)).toHaveLength(2);
    expect((await pull(number)).body).toBe(body);
  });

  it("the task-lifecycle worked example keeps its PR as the record of the run", async () => {
    const branch = "selfbuilding/ns_lifecycle/build-0";
    await commitToBranch(playground.remote, { branch, files: { "src/math.js": MATH } });
    await mirrorRefs(gh, { gitDir: playground.remote.bareDir, refs: [branch], env: playground.remote.env });
    const git = broker();
    const opened = await (git.pullRequests as PullRequestApi).openOrUpdate({
      repo: playground.remote.url,
      head: branch,
      base: "main",
      title: "Add multiply",
      body: "Adds multiply.\n\n---\nSelfbuilding-Run: ns_lifecycle\nSelfbuilding-Agent: ImplementSpec\n",
      draft: true,
    });
    const prRef = { url: opened.url, number: opened.number, draft: opened.draft };

    const source = await fs.readFile(
      fileURLToPath(new URL("../live/task-lifecycle/lifecycle.mjs", import.meta.url)),
      "utf8",
    );
    const reviews: Record<string, Json[]> = {
      "review-1-claude": [
        {
          file: "src/math.js",
          line: 2,
          severity: "high",
          category: "correctness",
          summary: "multiply ignores NaN.",
          failureScenario: "multiply(NaN, 1)",
          verdict: "CONFIRMED",
        },
      ],
      "review-1-codex": [
        {
          file: "src/math.js",
          severity: "low",
          category: "style",
          summary: "Name the parameters.",
          failureScenario: "none",
          verdict: "PLAUSIBLE",
        },
      ],
    };
    const agents = standIns(prRef, branch, reviews);
    const runId = "ns_accept_lifecycle_pr";
    const journal = fileJournal(path.join(dir, "journal-lifecycle"));
    const events = recorder();
    const go = () =>
      run(
        createScriptFactory({
          agents,
          // The stand-ins never launch a harness; the names only have to resolve.
          harnesses: { "claude-code": scriptedClaude(harnessScript), codex: scriptedClaude(harnessScript) },
        }),
        {
          source,
          name: "task-lifecycle",
          input: { repo: playground.remote.url, base: "main", spec: SPEC },
        },
        {
          runId,
          config: {
            deployment: "acceptance",
            sandbox: boxes,
            artifacts: fileArtifacts(path.join(dir, "artifacts")),
            git,
            hitl: { mode: "afk" },
          },
          journal,
          events: [events.sink],
        },
      );
    // AFK with no human: the closing merge question fails the run (it never merges). Every PR write comes before it.
    const out = await go();
    expect(events.of("error").map((e) => e.data?.code)).toEqual(["ask_timeout"]);
    expect(out.status).toBe("failed");
    expect(events.of("agent.launched")).toEqual([]);

    const posted = (await comments(opened.number)).map((c) => c.body);
    expect(posted).toHaveLength(3);
    const head = (await pull(opened.number)).head.sha;
    expect(posted[0]).toContain("<!-- task-lifecycle-round:1 stage:reviewed -->");
    // Findings to fix come first, then the carried ones, each with reviewer, severity, verdict and file:line.
    expect(posted[0]?.indexOf("multiply ignores NaN")).toBeLessThan(posted[0]?.indexOf("Name the parameters") ?? -1);
    expect(posted[0]).toContain("**high** CONFIRMED `src/math.js:2` (claude-code): multiply ignores NaN.");
    expect(posted[0]).toContain("**low** PLAUSIBLE `src/math.js` (codex): Name the parameters.");
    expect(posted[1]).toContain(`<!-- task-lifecycle-round:1 stage:complete head:${head} -->`);
    expect(posted[2]).toContain("<!-- task-lifecycle-round:2 stage:reviewed -->");

    const body = (await pull(opened.number)).body;
    expect(body).toContain("## What changed and why\n\nAdded multiply(a, b).\n\nFollow-ups:\n- Accept bigints\n\n");
    expect(body).toContain(`## Source\n\n\`\`\`\n${SPEC}\n\`\`\`\n\n`);
    expect(body).toContain(
      "## Verified\n\n- ✅ multiply: verified, multiply(2, 3) returned 6\n  - file:///evidence/multiply.md\n\n",
    );
    expect(body.indexOf("## Verified")).toBeLessThan(body.indexOf("\n---\nSelfbuilding-Run: ns_lifecycle"));

    // Run it again on the same journal: the PR calls replay (the stand-ins are not journaled, so they run again).
    await go();
    expect(await comments(opened.number)).toHaveLength(3);
    expect((await pull(opened.number)).body).toBe(body);
  });
});

/** Stand-in agents for the lifecycle script, picked by call label. Not journaled. */
function standIns(
  pr: { url: string; number: number; draft: boolean },
  branch: string,
  reviews: Record<string, Json[]>,
) {
  const result = (value: Json, files: { path: string; uri: string }[] = []) => ({
    result: value,
    callPath: "stand-in",
    replayed: false,
    usage: { usd: 0 },
    artifacts: {
      branch: { name: branch, pushed: true },
      pr,
      files: files.map((f) => ({ path: f.path, ref: { uri: f.uri } })),
    },
  });
  const agent = (produce: (label: string, input: unknown) => ReturnType<typeof result>) => {
    const call = async (input: unknown, opts?: AgentCallOptions) => produce(opts?.label ?? "", input);
    const settled = async (input: unknown, opts?: AgentCallOptions) => ({ ok: true, value: await call(input, opts) });
    return Object.assign(call, { settled, contract: { defaults: {} } });
  };
  const built = {
    status: "done",
    summary: "Added multiply(a, b).",
    followUps: ["Accept bigints"],
    openQuestions: [],
  };
  return {
    ImplementSpec: agent(() => result(built)),
    CodeReview: agent((label) =>
      result({ verdict: "request_changes", tier: "medium", summary: "s", findings: reviews[label] ?? [] }),
    ),
    FindFlows: agent(() => result({ flows: [{ name: "multiply", endState: "multiply(2, 3) returns 6" }] })),
    Verify: agent(() =>
      result(
        {
          summary: "ok",
          flows: [{ name: "multiply", outcome: "verified", detail: "multiply(2, 3) returned 6", defects: [] }],
        },
        [{ path: "verify/multiply/evidence.md", uri: "file:///evidence/multiply.md" }],
      ),
    ),
  } as unknown as NonNullable<RunScriptOptions["agents"]>;
}
