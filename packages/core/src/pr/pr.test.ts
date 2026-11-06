// release-prep §2.2: PR targets, section edits, and journaled PR calls against an in-memory PullRequestApi.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { currentAgentContext } from "../agent/context.js";
import { factory } from "../engine/factory.js";
import { parallel } from "../engine/primitives.js";
import { run } from "../engine/run.js";
import { ConfigError, NoActiveRunError, PrTargetError } from "../errors/classes.js";
import { memoryJournal } from "../journal/index.js";
import type { JournalStore } from "../types/orchestration.js";
import type { GitCredentialBroker, PullRequestApi, PullRequestInfo } from "../types/security.js";
import { commentOnPr, getPr, parsePrTarget, replacePrSection, updatePr } from "./index.js";

describe("parsePrTarget", () => {
  const ok: [unknown, string | undefined, { repo: string; number: number }][] = [
    ["https://github.com/acme/api/pull/12", undefined, { repo: "github.com/acme/api", number: 12 }],
    ["https://github.com/acme/api/pull/12/files", undefined, { repo: "github.com/acme/api", number: 12 }],
    [" https://GitHub.com/acme/api/pull/3 ", undefined, { repo: "github.com/acme/api", number: 3 }],
    [
      { url: "https://github.com/acme/api/pull/7", number: 7, draft: true },
      undefined,
      { repo: "github.com/acme/api", number: 7 },
    ],
    [{ repo: "github.com/acme/api", number: 9 }, undefined, { repo: "github.com/acme/api", number: 9 }],
    [{ repo: "acme/api", number: 9 }, undefined, { repo: "github.com/acme/api", number: 9 }],
    [{ repo: "https://github.com/acme/api.git", number: 9 }, undefined, { repo: "github.com/acme/api", number: 9 }],
    ["https://git.example.test/acme/api/pull/5", "git.example.test", { repo: "git.example.test/acme/api", number: 5 }],
  ];
  it.each(ok)("parses %j", (target, host, expected) => {
    expect(parsePrTarget(target as never, host)).toEqual(expected);
  });

  const refused: [unknown, RegExp][] = [
    ["acme/api#12", /Not a PR URL/],
    ["http://github.com/acme/api/pull/1", /https:\/\//],
    ["https://github.com/acme/api/issues/1", /pull\/<n>/],
    ["https://github.com/acme/api/pull/0", /positive integer/],
    ["https://gitlab.com/acme/api/pull/1", /on gitlab\.com/],
    [{ url: "https://github.com/acme/api/pull/1", number: 2 }, /disagree/],
    [{ repo: "github.com/acme/api" }, /needs its number/],
    [{ repo: "github.com/acme/api", number: -1 }, /positive integer/],
    [{ repo: "github.com/acme/api", number: 1.5 }, /positive integer/],
    [{ repo: "acme", number: 1 }, /<owner>\/<repo>/],
    [{ repo: "other.host/acme/api", number: 1 }, /on other\.host/],
    [{ number: 1 }, /needs a url, or a repo/],
    [null, /PR URL or an object/],
    [42, /PR URL or an object/],
  ];
  it.each(refused)("refuses %j", (target, reason) => {
    const error = (() => {
      try {
        parsePrTarget(target as never);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(PrTargetError);
    expect((error as Error).message).toMatch(reason);
    expect((error as PrTargetError).code).toBe("pr_target");
  });
});

describe("replacePrSection", () => {
  const trailer = "---\n\nRun: https://example.test/runs/ns_1\n\nSelfbuilding-Run: ns_1\nSelfbuilding-Call: ns_1.A#0\n";
  const cases: [string, string, string, string, string][] = [
    [
      "replaces a middle section",
      "Intro\n\n## A\n\nold a\n\n## B\n\nkeep b\n",
      "A",
      "new a",
      "Intro\n\n## A\n\nnew a\n\n## B\n\nkeep b\n",
    ],
    ["replaces the last section", "Intro\n\n## A\n\nold\nlines\n", "A", "  new  \n", "Intro\n\n## A\n\nnew\n"],
    [
      "replaces a section ending at the trailer",
      `Intro\n\n## A\n\nold\n\n${trailer}`,
      "A",
      "new",
      `Intro\n\n## A\n\nnew\n\n${trailer}`,
    ],
    [
      "inserts a missing section before the trailer",
      `Intro\n\n\n${trailer}`,
      "Verified",
      "- ok",
      `Intro\n\n## Verified\n\n- ok\n\n${trailer}`,
    ],
    ["appends a missing section", "Intro text\n\n", "Source", "spec", "Intro text\n\n## Source\n\nspec\n"],
    ["fills an empty body", "", "Source", "spec", "## Source\n\nspec\n"],
    ["matches a heading line with trailing spaces", "## A   \nold\n## B\nb\n", "A", "new", "## A\n\nnew\n\n## B\nb\n"],
    ["keeps ### headings in content", "## A\nold\n", "A", "### Detail\n\ntext", "## A\n\n### Detail\n\ntext\n"],
    ["is case sensitive", "## a\nlower\n", "A", "new", "## a\nlower\n\n## A\n\nnew\n"],
    [
      "ignores ## lines inside fenced code",
      "## Source\n\n````md\n## Not a heading\n---\nSelfbuilding-Run: x\n````\n\n## Verified\n\nv\n",
      "Source",
      "replaced",
      "## Source\n\nreplaced\n\n## Verified\n\nv\n",
    ],
  ];
  it.each(cases)("%s", (_name, body, heading, content, expected) => {
    expect(replacePrSection(body, heading, content)).toBe(expected);
  });

  it("is idempotent and refuses a multi-line heading", () => {
    const once = replacePrSection(`Intro\n\n${trailer}`, "Verified", "- ok");
    expect(replacePrSection(once, "Verified", "- ok")).toBe(once);
    expect(() => replacePrSection("", "A\nB", "x")).toThrow(new ConfigError("A PR section heading is one line."));
  });
});

/** A PullRequestApi over one in-memory PR, with GitHub's dedupe-by-marker behaviour. */
function fakePrs(opts: { delayMs?: number } = {}) {
  const pr: PullRequestInfo = {
    repo: "github.com/acme/api",
    url: "https://github.com/acme/api/pull/4",
    number: 4,
    draft: true,
    title: "Add a",
    body: "Intro\n\n---\n\nSelfbuilding-Run: ns_1\n",
    state: "open",
    head: "selfbuilding/ns_1/a-0",
    base: "main",
    headSha: "abc123",
  };
  const comments: { id: number; body: string }[] = [];
  const writes: string[] = [];
  const pause = () => new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
  const api: PullRequestApi = {
    openOrUpdate: async () => ({ ...pr, created: false }),
    findOpen: async () => pr,
    async get() {
      await pause();
      return { ...pr };
    },
    async update(_repo, _n, patch) {
      await pause();
      writes.push("update");
      if (patch.title !== undefined) pr.title = patch.title;
      if (patch.body !== undefined) pr.body = patch.body;
      return { ...pr };
    },
    async comment(_repo, _n, body, o) {
      const marker = o?.dedupeKey === undefined ? undefined : `<!-- selfbuilding:comment:${o.dedupeKey} -->`;
      const existing = marker === undefined ? undefined : comments.find((c) => c.body.includes(marker));
      if (existing) return { id: existing.id, url: `${pr.url}#issuecomment-${existing.id}`, created: false };
      writes.push("comment");
      const c = { id: comments.length + 1, body: marker ? `${body}\n\n${marker}` : body };
      comments.push(c);
      return { id: c.id, url: `${pr.url}#issuecomment-${c.id}`, created: true };
    },
  };
  const git = { id: "fake", host: "github.com", pullRequests: api } as unknown as GitCredentialBroker;
  return { pr, comments, writes, git };
}

/** Fails the first `ok` write of a `pr.comment` entry, as a crash right after the post would. */
function crashAfterPost(inner: JournalStore): JournalStore {
  let crashed = false;
  return new Proxy(inner, {
    get(target, key) {
      if (key === "put") {
        return async (...args: Parameters<JournalStore["put"]>) => {
          const [entry] = args;
          if (!crashed && entry.status === "ok" && entry.callPath.startsWith("pr.comment")) {
            crashed = true;
            throw new Error("process killed");
          }
          return target.put(...args);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("getPr, commentOnPr and updatePr", () => {
  const PR = "https://github.com/acme/api/pull/4";

  it("throw outside a run and without a broker that has the member", async () => {
    await expect(getPr(PR)).rejects.toBeInstanceOf(NoActiveRunError);
    await expect(commentOnPr(PR, "x")).rejects.toBeInstanceOf(NoActiveRunError);
    const f = factory({ name: "pr-noconfig", input: z.unknown() }, async () => {
      const errors: string[] = [];
      for (const call of [() => getPr(PR), () => commentOnPr(PR, "x"), () => updatePr(PR, { body: "b" })]) {
        await call().catch((e: Error) => errors.push(`${e.name}: ${e.message}`));
      }
      return errors;
    });
    const none = await run(f, undefined, { journal: memoryJournal() });
    expect(none.output).toHaveLength(3);
    for (const message of none.output as string[]) expect(message).toMatch(/^ConfigError: .*githubApp or pat/);

    const bare = {
      id: "x",
      host: "github.com",
      pullRequests: { openOrUpdate: async () => null, findOpen: async () => null },
    };
    const partial = await run(f, undefined, { journal: memoryJournal(), config: { git: bare as never } });
    for (const message of partial.output as string[]) expect(message).toMatch(/has no (get|comment|update)\(\)/);
  });

  it("journal each call, so a resume replays the values and never writes twice", async () => {
    const fake = fakePrs();
    const journal = memoryJournal();
    const f = factory({ name: "pr-replay", input: z.unknown() }, async () => {
      const artifact = { url: PR, number: 4, draft: true };
      const before = await getPr(artifact);
      const posted = await commentOnPr(PR, "round 1");
      const updated = await updatePr(PR, { title: "Add a, reviewed" });
      return { sha: before.headSha, posted, title: updated.title };
    });
    const opts = { runId: "ns_pr_replay", journal, config: { git: fake.git } };
    const first = await run(f, undefined, opts);
    expect(first.status).toBe("ok");
    expect(first.output).toEqual({
      sha: "abc123",
      posted: { id: 1, url: `${PR}#issuecomment-1`, created: true },
      title: "Add a, reviewed",
    });
    expect(fake.comments[0]?.body).toBe("round 1\n\n<!-- selfbuilding:comment:ns_pr_replay.pr.comment#0 -->");
    const second = await run(f, undefined, opts);
    expect(second.output).toEqual(first.output);
    expect(fake.writes).toEqual(["comment", "update"]);
    const paths: string[] = [];
    for await (const e of journal.list("ns_pr_replay")) if (e.kind === "step") paths.push(e.callPath);
    expect(paths.sort()).toEqual(["pr.comment#0", "pr.get#0", "pr.update#0"]);
  });

  it("post once when the process dies between the post and the journal write", async () => {
    const fake = fakePrs();
    const journal = memoryJournal();
    const f = factory({ name: "pr-crash", input: z.unknown() }, async () => commentOnPr(PR, "findings"));
    const crashed = await run(f, undefined, {
      runId: "ns_pr_crash",
      journal: crashAfterPost(journal),
      config: { git: fake.git },
    });
    expect(crashed.status).not.toBe("ok");
    expect(fake.comments).toHaveLength(1);
    const resumed = await run(f, undefined, { runId: "ns_pr_crash", journal, config: { git: fake.git } });
    expect(resumed.status).toBe("ok");
    expect(resumed.output).toMatchObject({ id: 1, created: false });
    expect(fake.comments).toHaveLength(1);
  });

  it("serialise section edits, so two parallel edits to one PR both land", async () => {
    const fake = fakePrs({ delayMs: 5 });
    const f = factory({ name: "pr-sections", input: z.unknown() }, async () => {
      await parallel({
        what: () => updatePr(PR, { section: { heading: "What changed and why", content: "Adds a." } }),
        verified: () => updatePr(PR, { section: { heading: "Verified", content: "- ✅ login: passed, 3 steps" } }),
      });
      return (await getPr(PR)).body;
    });
    const out = await run(f, undefined, { journal: memoryJournal(), config: { git: fake.git } });
    expect(out.output).toBe(
      "Intro\n\n## What changed and why\n\nAdds a.\n\n## Verified\n\n- ✅ login: passed, 3 steps\n\n---\n\nSelfbuilding-Run: ns_1\n",
    );
  });

  it("apply a section to the body given in the same patch, and redact what is posted", async () => {
    const fake = fakePrs();
    const f = factory({ name: "pr-redact", input: z.unknown() }, async () => {
      currentAgentContext()?.noteSecrets?.(["declared-secret-value-1234"]);
      await commentOnPr(PR, "log: declared-secret-value-1234", { dedupeKey: "mine" });
      return updatePr(PR, {
        body: "Fresh body",
        section: { heading: "Source", content: "key declared-secret-value-1234" },
      });
    });
    const out = await run(f, undefined, { journal: memoryJournal(), config: { git: fake.git } });
    expect(out.status).toBe("ok");
    expect(fake.comments[0]?.body).toBe("log: [REDACTED]\n\n<!-- selfbuilding:comment:mine -->");
    expect(fake.pr.body).toBe("Fresh body\n\n## Source\n\nkey [REDACTED]\n");
  });

  it("refuse bad targets and patches before any request", async () => {
    const fake = fakePrs();
    const f = factory({ name: "pr-refuse", input: z.unknown() }, async () => {
      const errors: string[] = [];
      for (const call of [
        () => getPr("not a url"),
        () => updatePr(PR, {}),
        () => updatePr(PR, { section: { heading: "A\nB", content: "x" } }),
        () => commentOnPr(PR, 5 as never),
      ]) {
        await call().catch((e: Error) => errors.push(e.name));
      }
      return errors;
    });
    const out = await run(f, undefined, { journal: memoryJournal(), config: { git: fake.git } });
    expect(out.output).toEqual(["PrTargetError", "ConfigError", "ConfigError", "ConfigError"]);
    expect(fake.writes).toEqual([]);
  });
});
