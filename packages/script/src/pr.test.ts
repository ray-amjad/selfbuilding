// sb.pr (release-prep §2.3) and script-layer sandbox counting (§7.3), offline: an in-memory PullRequestApi and the
// tmpdir provider.
import fs from "node:fs/promises";
import path from "node:path";
import {
  type GitCredentialBroker,
  type PullRequestApi,
  type PullRequestInfo,
  ScriptInvalidError,
} from "@selfbuilding/core";
import { createLocalRemote, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyError, fakeAgents, runSource, tempDir } from "../test/kit.js";

let dir: string;
let boxes: TmpdirProvider;
let unsized: TmpdirProvider;
let repo: string;

beforeAll(async () => {
  dir = await tempDir("sbs-pr-");
  boxes = tmpdirProvider({ root: path.join(dir, "boxes") });
  unsized = tmpdirProvider({ id: "tmpdir-unsized", root: path.join(dir, "unsized"), sizing: false });
  repo = `file://${(await createLocalRemote(dir, { files: { "README.md": "# playground\n" } })).bareDir}`;
});

afterAll(async () => {
  await boxes.close();
  await unsized.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const URL = "https://github.com/acme/api/pull/4";

function fakeGit() {
  const pr: PullRequestInfo = {
    repo: "github.com/acme/api",
    url: URL,
    number: 4,
    draft: true,
    title: "Add a",
    body: "Intro\n",
    state: "open",
    head: "selfbuilding/ns_1/a-0",
    base: "main",
    headSha: "abc123",
  };
  const requests: string[] = [];
  const comments: string[] = [];
  const api: PullRequestApi = {
    openOrUpdate: async () => ({ ...pr, created: false }),
    findOpen: async () => pr,
    get: async () => {
      requests.push("get");
      return { ...pr };
    },
    update: async (_r, _n, patch) => {
      requests.push("update");
      Object.assign(pr, patch);
      return { ...pr };
    },
    comment: async (_r, _n, body, o) => {
      requests.push("comment");
      comments.push(`${body} [${o?.dedupeKey ?? ""}]`);
      return { id: comments.length, url: `${URL}#issuecomment-${comments.length}`, created: true };
    },
  };
  const git = { id: "fake", host: "github.com", pullRequests: api } as unknown as GitCredentialBroker;
  return { pr, requests, comments, git };
}

function expectError(out: Awaited<ReturnType<typeof runSource>>, code: string, text: string): void {
  expect(out.status).toBe("failed");
  expect(bodyError(out)?.code).toBe(code);
  expect(bodyError(out)?.message).toContain(text);
}

describe("sb.pr", () => {
  it("reads, comments on and edits a PR, journaled so a resume sends nothing again", async () => {
    const fake = fakeGit();
    const fakes = fakeAgents({ Build: { pr: { url: URL, number: 4, draft: true } } });
    const source = `export default async (input, sb) => {
  const { artifacts: { pr } } = await sb.agents.Build({});
  const before = await sb.pr.get(pr);
  const c = await sb.pr.comment({ pr, body: "findings" });
  const keyed = await sb.pr.comment({ pr: input.url, body: "again", dedupeKey: "mine" });
  const after = await sb.pr.update({ pr: { repo: "acme/api", number: 4 }, title: "Add a, reviewed", section: { heading: "Verified", content: "- ok" } });
  return { sha: before.headSha, c: c.id, keyed: keyed.id, title: after.title, body: after.body };
}`;
    const runId = "ns_script_pr";
    const opts = { dir, runId, input: { url: URL }, config: { git: fake.git }, script: { agents: fakes.agents } };
    const first = await runSource(source, opts);
    expect(first.status).toBe("ok");
    expect(first.output).toEqual({
      sha: "abc123",
      c: 1,
      keyed: 2,
      title: "Add a, reviewed",
      body: "Intro\n\n## Verified\n\n- ok\n",
    });
    expect(fake.comments).toEqual([`findings [${runId}.pr.comment#0]`, "again [mine]"]);
    const sent = fake.requests.length;
    fakes.reset();
    const again = await runSource(source, opts);
    expect(again.output).toEqual(first.output);
    expect(fake.requests).toHaveLength(sent);
  });

  it("checks options: unknown keys, wrong types and bad targets are ScriptInvalidError", async () => {
    const fake = fakeGit();
    const fakes = fakeAgents({ Build: { pr: { url: URL, number: 4, draft: true } } });
    const cases: [string, string][] = [
      ["await sb.pr.comment({ pr: input.url, body: 'x', afk: true })", 'sb.pr.comment option "afk" is not supported'],
      ["await sb.pr.comment({ pr: input.url, body: 5 })", "needs the body as a string"],
      ["await sb.pr.comment('x')", "needs an object"],
      ["await sb.pr.update({ pr: input.url })", "needs a title, a body or a section"],
      ["await sb.pr.update({ pr: input.url, section: { heading: 'A\\nB', content: 'x' } })", "one non-empty line"],
      ["await sb.pr.update({ pr: input.url, section: { heading: 'A' } })", "with string values"],
      ["await sb.pr.update({ pr: input.url, title: 3 })", "title must be a string"],
      ["await sb.pr.get(12)", "needs a PR"],
      ["await sb.pr.get({ number: 3 })", "needs a PR"],
      ["await sb.pr.get('https://gitlab.com/acme/api/pull/1')", "The PR is on gitlab.com"],
      ["await sb.pr.get({ repo: 'acme/api', number: 0 })", "positive integer"],
      ["await sb.pr.get({ repo: 'acme/api', number: 5 })", "acme/api#5 is not a PR this run opened"],
      [
        "await sb.pr.comment({ pr: 'https://github.com/acme/other/pull/4', body: 'x' })",
        "acme/other#4 is not a PR this run opened",
      ],
      ["await sb.pr.update({ pr: 'https://github.com/acme/other/pull/12', body: 'x' })", "is not a PR this run opened"],
    ];
    for (const [call, text] of cases) {
      // A usage error ends the run by throwing out of run(), as for every other sb option error.
      const error = await runSource(
        `export default async (input, sb) => {\n  await sb.agents.Build({});\n  try { ${call}; } catch (e) {}\n}`,
        { dir, input: { url: URL }, config: { git: fake.git }, script: { agents: fakes.agents } },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ScriptInvalidError);
      expect((error as Error).message).toContain(text);
    }
    expect(fake.requests).toEqual([]);
  });

  it("a script may catch a missing broker's ConfigError", async () => {
    const fakes = fakeAgents({ Build: { pr: { url: URL, number: 4, draft: true } } });
    const out = await runSource(
      "export default async (input, sb) => {\n  const { artifacts } = await sb.agents.Build({});\n  try { await sb.pr.get(artifacts.pr); } catch (e) { return e.message; }\n}",
      { dir, input: { url: URL }, script: { agents: fakes.agents } },
    );
    expect(out.status).toBe("ok");
    expect(out.output).toContain("githubApp or pat");
  });

  it("pr_writes: the write past maxPrWrites fails the run before any request; reads and agent calls do not count", async () => {
    const fake = fakeGit();
    const fakes = fakeAgents({ A: { pr: { url: URL, number: 4, draft: true } } });
    fakes.reset();
    const out = await runSource(
      `export default async (input, sb) => {
  await sb.agents.A({});
  for (let i = 0; i < 3; i++) await sb.pr.get(input.url);
  await sb.pr.comment({ pr: input.url, body: "1" });
  await sb.pr.update({ pr: input.url, body: "2" });
  try { await sb.pr.comment({ pr: input.url, body: "3" }); } catch (e) {}
  return "kept going";
}`,
      {
        dir,
        input: { url: URL },
        caps: { maxPrWrites: 2, maxAgentCalls: 1 },
        config: { git: fake.git },
        script: { agents: fakes.agents },
      },
    );
    expectError(out, "script_limit", "hit its pr_writes limit");
    expect(fake.requests).toEqual(["get", "get", "get", "comment", "update"]);
  });
});

describe("script-layer sandbox counting (release-prep §7.3)", () => {
  it("counts live handles against maxSandboxes; dispose frees a slot", async () => {
    const ok = await runSource(
      `export default async (input, sb) => {
  const a = sb.sandbox({ label: "a" });
  const b = sb.sandbox({ label: "b" });
  await a.dispose();
  const c = sb.sandbox({ label: "c" });
  await b.dispose();
  await c.dispose();
  return [a.id, b.id, c.id];
}`,
      { dir, caps: { maxSandboxes: 2 }, config: { sandbox: boxes } },
    );
    expect(ok.status).toBe("ok");
    const over = await runSource(
      `export default async (input, sb) => {
  sb.sandbox({ label: "a" });
  sb.sandbox({ label: "b" });
  try { sb.sandbox({ label: "c" }); } catch (e) {}
  return "kept going";
}`,
      { dir, caps: { maxSandboxes: 2 }, config: { sandbox: boxes } },
    );
    expectError(over, "script_limit", "2 are live and sb.sandbox() asks for 1 more");
  });

  it("a fork counts its children with the live handles", async () => {
    const ok = await runSource(
      `export default async (input, sb) => {
  const box = sb.sandbox({ label: "build", repo: input.repo });
  await box.exec("true");
  const [child] = await box.fork(1);
  await child.dispose();
  const more = await box.fork(1);
  await Promise.all(more.map((m) => m.dispose()));
  await box.dispose();
  return more.length;
}`,
      { dir, input: { repo }, caps: { maxSandboxes: 2 }, config: { sandbox: boxes } },
    );
    expect(ok.status).toBe("ok");
    const over = await runSource(
      `export default async (input, sb) => {
  const box = sb.sandbox({ label: "build", repo: input.repo });
  await box.exec("true");
  await box.fork(2);
}`,
      { dir, input: { repo }, caps: { maxSandboxes: 2 }, config: { sandbox: boxes } },
    );
    expectError(over, "script_limit", "handle.fork(2) asks for 2 more");
  });

  it("an unsized sb.sandbox() is checked at the provider default size", async () => {
    const refused = await runSource("export default async (input, sb) => { sb.sandbox(); }", {
      dir,
      caps: { allowedSizes: ["medium"] },
      config: { sandbox: boxes },
    });
    expectError(refused, "script_limit", 'sb.sandbox() with no size defaults to "small"');
    expect(bodyError(refused)?.message).toContain('{ size: "medium" }');
    const sized = await runSource('export default async (input, sb) => sb.sandbox({ size: "medium" }).id;', {
      dir,
      caps: { allowedSizes: ["medium"] },
      config: { sandbox: boxes },
    });
    expect(sized.status).toBe("ok");
    // A provider that takes no sizes has no default size to check.
    const noSizes = await runSource('export default async (input, sb) => sb.sandbox({ provider: "plain" }).id;', {
      dir,
      caps: { allowedSizes: ["medium"] },
      config: { sandbox: boxes },
      script: { providers: { plain: unsized } },
    });
    expect(noSizes.status).toBe("ok");
  });
});
