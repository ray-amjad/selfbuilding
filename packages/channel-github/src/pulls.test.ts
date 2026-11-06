import { ChannelDeliveryError, ConfigError, type PullRequestApi, PushFailedError } from "@selfbuilding/core";
import {
  commitToBranch,
  type GitHubEmulator,
  mirrorRefs,
  type Playground,
  seedPlayground,
  startGitHubEmulator,
} from "@selfbuilding/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { githubApp } from "./app.js";
import { pat } from "./pat.js";
import { COMMENT_BODY_LIMIT, commentMarker, defaultPrTitle, openOrUpdatePr, PR_BODY_LIMIT, prBody } from "./pulls.js";

describe("prBody", () => {
  const trailers = { run: "ns_01", call: "ns_01.ImplementSpec#0", agent: "ImplementSpec" };

  it("carries the summary, the implementation notes, the diff stat, the run link and the trailers", () => {
    const body = prBody({
      summary: "Adds multiply().",
      implementationNotes: "- Decided to keep add() untouched.\n- Open question: overflow?",
      diffStat: " src/math.js | 3 +++\n 1 file changed, 3 insertions(+)",
      runUrl: "https://example.test/runs/ns_01",
      trailers,
    });
    expect(body).toBe(
      [
        "Adds multiply().",
        "",
        "## Implementation notes",
        "",
        "- Decided to keep add() untouched.",
        "- Open question: overflow?",
        "",
        "## Changes",
        "",
        "```",
        " src/math.js | 3 +++",
        " 1 file changed, 3 insertions(+)",
        "```",
        "",
        "---",
        "",
        "Run: https://example.test/runs/ns_01",
        "",
        "Selfbuilding-Run: ns_01",
        "Selfbuilding-Call: ns_01.ImplementSpec#0",
        "Selfbuilding-Agent: ImplementSpec",
        "",
      ].join("\n"),
    );
  });

  it("omits empty sections", () => {
    expect(prBody({ summary: "Only a summary.", implementationNotes: "  " })).toBe("Only a summary.\n");
  });

  it("cuts the notes first when the body would pass GitHub's limit, keeping the trailers", () => {
    const body = prBody({ summary: "S", implementationNotes: "n".repeat(PR_BODY_LIMIT * 2), trailers });
    expect(body.length).toBeLessThanOrEqual(PR_BODY_LIMIT);
    expect(body).toContain("Notes truncated");
    expect(body.endsWith("Selfbuilding-Agent: ImplementSpec\n")).toBe(true);
  });
});

describe("defaultPrTitle", () => {
  it("prefers prTitle, else the agent name and the first 72 characters of the summary's first line", () => {
    expect(defaultPrTitle("ImplementSpec", { prTitle: " Add multiply ", summary: "x" })).toBe("Add multiply");
    expect(defaultPrTitle("ImplementSpec", { summary: `${"a".repeat(100)}\nmore` })).toBe(
      `ImplementSpec: ${"a".repeat(72)}`,
    );
    expect(defaultPrTitle("Fixer", {})).toBe("Fixer");
  });
});

describe("openOrUpdatePr guard", () => {
  const api: PullRequestApi = {
    openOrUpdate: async () => ({ url: "u", number: 1, draft: true, created: true }),
    findOpen: async () => null,
  };
  const req = { repo: "github.com/a/b", head: "selfbuilding/r/x", base: "main", title: "t", body: "b", draft: true };

  it("refuses a branch whose push was not verified", async () => {
    await expect(openOrUpdatePr(api, { ...req, push: { pushed: false } })).rejects.toBeInstanceOf(PushFailedError);
    await expect(
      openOrUpdatePr(api, { ...req, push: { pushed: true, refs: [{ ref: "refs/heads/other", sha: "1" }] } }),
    ).rejects.toThrow(/not verified/);
    await expect(
      openOrUpdatePr(api, { ...req, push: { pushed: true, refs: [{ ref: "refs/heads/selfbuilding/r/x", sha: "1" }] } }),
    ).resolves.toMatchObject({ number: 1 });
  });

  it("explains a broker that cannot open PRs", async () => {
    await expect(openOrUpdatePr({}, req)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("PRs against the GitHub emulator", () => {
  let gh: GitHubEmulator;
  let playground: Playground;
  const branch = "selfbuilding/ns_run1/implementspec-0";

  beforeAll(async () => {
    gh = await startGitHubEmulator();
  });
  afterAll(() => gh.close());
  beforeEach(async () => {
    gh.reset();
    playground = await seedPlayground(gh);
    await commitToBranch(playground.remote, {
      branch,
      files: { "src/math.js": "export const multiply = (a, b) => a * b;\n" },
    });
    await mirrorRefs(gh, { gitDir: playground.remote.bareDir, refs: [branch], env: playground.remote.env });
  });
  afterEach(() => playground.dispose());

  const repo = () => `github.com/${gh.owner}/${gh.repo}`;
  const app = () => githubApp({ appId: gh.app.appId, privateKey: gh.appPrivateKey, apiUrl: gh.url });
  const pr = (over: Record<string, unknown> = {}) => ({
    repo: repo(),
    head: branch,
    base: "main",
    title: "ImplementSpec: add multiply",
    body: prBody({ summary: "Adds multiply().", implementationNotes: "- Kept add() as is." }),
    draft: true,
    ...over,
  });

  it("opens a draft PR as the App, with the implementation notes in the body", async () => {
    const broker = app();
    expect(await broker.pullRequests.findOpen(repo(), branch)).toBeNull();
    const opened = await openOrUpdatePr(broker, { ...pr(), push: { pushed: true } });
    expect(opened).toMatchObject({ created: true, draft: true });
    expect(opened.url).toContain(`/pull/${opened.number}`);

    const fetched = await gh.api<{
      user: { login: string; type: string };
      body: string;
      draft: boolean;
      head: { ref: string };
    }>(`/repos/${gh.owner}/${gh.repo}/pulls/${opened.number}`);
    expect(fetched.user).toMatchObject({ login: `${gh.app.slug}[bot]`, type: "Bot" });
    expect(fetched.body).toContain("## Implementation notes\n\n- Kept add() as is.");
    expect(fetched.draft).toBe(true);
    expect(fetched.head.ref).toBe(branch);
    expect(await broker.pullRequests.findOpen(repo(), branch)).toEqual({
      url: opened.url,
      number: opened.number,
      draft: true,
    });
  });

  it("updates the open PR for the same head instead of opening a second one", async () => {
    const broker = app();
    const first = await broker.pullRequests.openOrUpdate(pr());
    const second = await broker.pullRequests.openOrUpdate(
      pr({ title: "ImplementSpec: add multiply (round 2)", body: "Round 2 notes", labels: ["selfbuilding"] }),
    );
    expect(second).toMatchObject({ number: first.number, created: false, draft: true });
    const pulls = await gh.api<{ number: number; title: string; body: string; labels: { name: string }[] }[]>(
      `/repos/${gh.owner}/${gh.repo}/pulls?state=all`,
    );
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ title: "ImplementSpec: add multiply (round 2)", body: "Round 2 notes" });
    expect(pulls[0]?.labels.map((l) => l.name)).toEqual(["selfbuilding"]);
  });

  it("opens with labels on creation", async () => {
    const opened = await app().pullRequests.openOrUpdate(pr({ labels: ["selfbuilding", "draft"], draft: false }));
    expect(opened).toMatchObject({ created: true, draft: false });
    const issue = await gh.api<{ labels: { name: string }[] }>(`/repos/${gh.owner}/${gh.repo}/pulls/${opened.number}`);
    expect(issue.labels.map((l) => l.name).sort()).toEqual(["draft", "selfbuilding"]);
  });

  it("maps an unknown base branch to a ConfigError and an outage to a retryable ChannelDeliveryError", async () => {
    // A missing head is a refusal from GitHub (the PR token cannot create branches).
    await expect(
      app().pullRequests.openOrUpdate(pr({ head: "selfbuilding/ns_run1/never-pushed" })),
    ).rejects.toBeInstanceOf(ConfigError);
    const down = githubApp({
      appId: gh.app.appId,
      privateKey: gh.appPrivateKey,
      apiUrl: gh.url,
      fetch: async (input, init) =>
        new URL(input).pathname.endsWith("/pulls") ? Response.json({}, { status: 503 }) : fetch(input, init),
    });
    const error = await down.pullRequests.openOrUpdate(pr()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelDeliveryError);
  });

  it("pat() opens PRs as the PAT's user", async () => {
    const broker = pat({ push: gh.tokens.bot, apiUrl: gh.url });
    const opened = await openOrUpdatePr(broker, pr());
    const fetched = await gh.api<{ user: { login: string } }>(`/repos/${gh.owner}/${gh.repo}/pulls/${opened.number}`);
    expect(fetched.user.login).toBe("selfbuilding-bot");
  });
});

describe("githubMessage", () => {
  it("adds the reasons GitHub lists under errors[] to a 422's bare 'Validation Failed'", async () => {
    const { githubMessage } = await import("./http.js");
    const body = {
      message: "Validation Failed",
      errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and topic" }],
    };
    expect(githubMessage({ ok: false, status: 422, body } as never)).toBe(
      "Validation Failed: No commits between main and topic",
    );
    expect(githubMessage({ ok: false, status: 404, body: { message: "Not Found" } } as never)).toBe("Not Found");
  });
});

describe("reading, editing and commenting on a PR (release-prep §2.1)", () => {
  let gh: GitHubEmulator;
  let playground: Playground;
  let number: number;
  const branch = "selfbuilding/ns_run2/implementspec-0";

  beforeAll(async () => {
    gh = await startGitHubEmulator();
  });
  afterAll(() => gh.close());
  beforeEach(async () => {
    gh.reset();
    playground = await seedPlayground(gh);
    await commitToBranch(playground.remote, { branch, files: { "a.txt": "a\n" } });
    await mirrorRefs(gh, { gitDir: playground.remote.bareDir, refs: [branch], env: playground.remote.env });
    const opened = await app().pullRequests.openOrUpdate({
      repo: repo(),
      head: branch,
      base: "main",
      title: "Add a",
      body: "Body one",
      draft: true,
    });
    number = opened.number;
  });
  afterEach(() => playground.dispose());

  const repo = () => `github.com/${gh.owner}/${gh.repo}`;
  const app = () => githubApp({ appId: gh.app.appId, privateKey: gh.appPrivateKey, apiUrl: gh.url });
  const api = () => app().pullRequests as Required<PullRequestApi>;
  const comments = () =>
    gh.api<{ id: number; body: string }[]>(`/repos/${gh.owner}/${gh.repo}/issues/${number}/comments?per_page=100`);

  it("get reads the PR, with its head sha, and reports closed and merged states", async () => {
    const pull = await gh.api<{ head: { sha: string } }>(`/repos/${gh.owner}/${gh.repo}/pulls/${number}`);
    const info = await api().get(repo(), number);
    expect(info).toMatchObject({
      repo: repo(),
      number,
      draft: true,
      title: "Add a",
      body: "Body one",
      state: "open",
      head: branch,
      base: "main",
      headSha: pull.head.sha,
    });
    expect(info.url).toContain(`/pull/${number}`);
    await gh.api(`/repos/${gh.owner}/${gh.repo}/pulls/${number}`, { method: "PATCH", body: { state: "closed" } });
    expect((await api().get(repo(), number)).state).toBe("closed");
    // A merged PR is "merged", whatever its state field says.
    const merged = pat({
      push: gh.tokens.bot,
      apiUrl: gh.url,
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        const body = (await res.json()) as Record<string, unknown>;
        return Response.json({ ...body, merged_at: "2026-11-04T00:00:00Z" }, { status: res.status });
      },
    });
    expect((await (merged.pullRequests as Required<PullRequestApi>).get(repo(), number)).state).toBe("merged");
  });

  it("update changes only the fields given and returns the PR as stored", async () => {
    const after = await api().update(repo(), number, { body: "Body two" });
    expect(after).toMatchObject({ title: "Add a", body: "Body two", number });
    const retitled = await api().update(repo(), number, { title: `  ${"t".repeat(300)} ` });
    expect(retitled.title).toHaveLength(256);
    expect(retitled.body).toBe("Body two");
    const long = await api().update(repo(), number, { body: "b".repeat(PR_BODY_LIMIT + 10) });
    expect(long.body.length).toBeLessThanOrEqual(PR_BODY_LIMIT);
    expect(long.body).toContain("Truncated to fit GitHub's limit");
  });

  it("comment posts as the App; with a dedupeKey it carries the marker and posts once", async () => {
    const plain = await api().comment(repo(), number, "Hello");
    expect(plain).toMatchObject({ created: true });
    expect(plain.url).toContain(`#issuecomment-${plain.id}`);
    const first = await api().comment(repo(), number, "Round 1 findings", { dedupeKey: "ns_run2.pr.comment#0" });
    const again = await api().comment(repo(), number, "Round 1 findings (retry)", {
      dedupeKey: "ns_run2.pr.comment#0",
    });
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, url: first.url, created: false });
    const all = await comments();
    expect(all.map((c) => c.body)).toEqual(["Hello", `Round 1 findings\n\n${commentMarker("ns_run2.pr.comment#0")}`]);
    const posted = await gh.api<{ user: { login: string } }>(
      `/repos/${gh.owner}/${gh.repo}/issues/comments/${first.id}`,
    );
    expect(posted.user.login).toBe(`${gh.app.slug}[bot]`);
  });

  it("dedupe ignores a copied marker in someone else's comment", async () => {
    const key = "ns_run2.pr.comment#1";
    await gh.api(`/repos/${gh.owner}/${gh.repo}/issues/${number}/comments`, {
      body: { body: `not the host\n\n${commentMarker(key)}` },
      as: "reviewer",
    });
    const posted = await api().comment(repo(), number, "Round 2 findings", { dedupeKey: key });
    expect(posted.created).toBe(true);
    const again = await api().comment(repo(), number, "Round 2 findings (retry)", { dedupeKey: key });
    expect(again).toEqual({ ...posted, created: false });
    const p = pat({ push: gh.tokens.bot, apiUrl: gh.url }).pullRequests as Required<PullRequestApi>;
    const viaPat = await p.comment(repo(), number, "pat round", { dedupeKey: "pat-k" });
    expect(viaPat.created).toBe(true);
    expect((await p.comment(repo(), number, "pat round", { dedupeKey: "pat-k" })).created).toBe(false);
    // The App's marker is not the PAT user's, and the other way round.
    expect((await p.comment(repo(), number, "pat copy", { dedupeKey: key })).created).toBe(true);
    expect((await comments()).map((c) => c.body.split("\n")[0])).toEqual([
      "not the host",
      "Round 2 findings",
      "pat round",
      "pat copy",
    ]);
  });

  it("dedupe finds a marked comment on the second page of comments", async () => {
    for (let i = 0; i < 100; i++) {
      await gh.api(`/repos/${gh.owner}/${gh.repo}/issues/${number}/comments`, { body: { body: `noise ${i}` } });
    }
    const marked = await api().comment(repo(), number, "late", { dedupeKey: "k-late" });
    expect(marked.created).toBe(true);
    const pages: string[] = [];
    const counting = githubApp({
      appId: gh.app.appId,
      privateKey: gh.appPrivateKey,
      apiUrl: gh.url,
      fetch: async (input, init) => {
        if (input.includes("/comments") && (init?.method ?? "GET") === "GET") pages.push(input);
        return fetch(input, init);
      },
    });
    const found = await (counting.pullRequests as Required<PullRequestApi>).comment(repo(), number, "late again", {
      dedupeKey: "k-late",
    });
    expect(found).toEqual({ id: marked.id, url: marked.url, created: false });
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain("page=2");
  });

  it("cuts a long comment but keeps the marker last", async () => {
    await api().comment(repo(), number, "c".repeat(COMMENT_BODY_LIMIT + 50), { dedupeKey: "long" });
    const [posted] = await comments();
    expect(posted?.body.length).toBeLessThanOrEqual(COMMENT_BODY_LIMIT);
    expect(posted?.body.endsWith(commentMarker("long"))).toBe(true);
    expect(() => commentMarker("a-->b")).toThrow(ConfigError);
    expect(() => commentMarker("a\nb")).toThrow(ConfigError);
  });

  it("maps outages to ChannelDeliveryError and refusals to ConfigError naming the permission", async () => {
    const failing = (status: number, method: string, part: string) =>
      githubApp({
        appId: gh.app.appId,
        privateKey: gh.appPrivateKey,
        apiUrl: gh.url,
        fetch: async (input, init) =>
          (init?.method ?? "GET") === method && new URL(input).pathname.includes(part)
            ? Response.json({ message: "nope" }, { status })
            : fetch(input, init),
      }).pullRequests as Required<PullRequestApi>;

    await expect(api().get(repo(), 9999)).rejects.toThrow(/"pull_requests: read"/);
    await expect(failing(503, "GET", "/pulls/").get(repo(), number)).rejects.toBeInstanceOf(ChannelDeliveryError);

    const refusedEdit = await failing(403, "PATCH", "/pulls/")
      .update(repo(), number, { body: "x" })
      .catch((e: unknown) => e);
    expect(refusedEdit).toBeInstanceOf(ConfigError);
    expect((refusedEdit as Error).message).toContain('"pull_requests: write"');
    await expect(failing(502, "PATCH", "/pulls/").update(repo(), number, { body: "x" })).rejects.toBeInstanceOf(
      ChannelDeliveryError,
    );

    const refusedComment = await failing(403, "POST", "/comments")
      .comment(repo(), number, "x")
      .catch((e: unknown) => e);
    expect(refusedComment).toBeInstanceOf(ConfigError);
    expect((refusedComment as Error).message).toContain('"issues: write"');
    await expect(
      failing(500, "GET", "/comments").comment(repo(), number, "x", { dedupeKey: "k" }),
    ).rejects.toBeInstanceOf(ChannelDeliveryError);

    const unreachable = pat({
      push: gh.tokens.bot,
      apiUrl: gh.url,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    }).pullRequests as Required<PullRequestApi>;
    await expect(unreachable.comment(repo(), number, "x", { dedupeKey: "k" })).rejects.toBeInstanceOf(
      ChannelDeliveryError,
    );
    await expect(unreachable.get(repo(), number)).rejects.toBeInstanceOf(ChannelDeliveryError);
    expect(await comments()).toEqual([]);
  });

  it("pat() reads, edits and comments as the PAT's user", async () => {
    const p = pat({ push: gh.tokens.bot, apiUrl: gh.url }).pullRequests as Required<PullRequestApi>;
    expect((await p.get(repo(), number)).title).toBe("Add a");
    expect((await p.update(repo(), number, { title: "Add a (pat)" })).title).toBe("Add a (pat)");
    const c = await p.comment(repo(), number, "from pat", { dedupeKey: "pat-1" });
    const posted = await gh.api<{ user: { login: string } }>(`/repos/${gh.owner}/${gh.repo}/issues/comments/${c.id}`);
    expect(posted.user.login).toBe("selfbuilding-bot");
  });
});
