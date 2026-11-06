import { describe, expect, it } from "vitest";
import type { FlowEvidence, FlowVerdict } from "./schemas.js";
import { EMBED_MAX_BYTES, PAGE_MAX_BYTES, type RunSummaryInput, renderRunSummary } from "./summary.js";

const ev = (slug: string, file: string, contentType: string, bytes = 10): FlowEvidence => ({
  path: `/selfbuilding/out/files/verify/${slug}/${file}`,
  uri: `s3://bucket/runs/r/${slug}/${file}`,
  contentType,
  bytes,
});

const add: FlowVerdict = {
  name: "add a note",
  slug: "add-a-note",
  kind: "regression",
  outcome: "verified",
  detail: "The note shows and the row exists.",
  callPath: "pipeline#1/[add-a-note]/stage#0/verify",
  evidence: [
    ev("add-a-note", "evidence.md", "text/markdown"),
    ev("add-a-note", "screenshots/01-form.png", "image/png"),
    ev("add-a-note", "db.txt", "text/plain"),
  ],
};
const done: FlowVerdict = {
  name: "mark a note done",
  slug: "mark-a-note-done",
  kind: "new",
  outcome: "broken",
  detail: "The button sets nothing.",
  callPath: "pipeline#1/[mark-a-note-done]/stage#0/verify",
  evidence: [ev("mark-a-note-done", "evidence.md", "text/markdown")],
};

const base: RunSummaryInput = {
  runId: "ns_123",
  title: "Mark notes done",
  branch: "selfbuilding/ns_123/build",
  pr: { url: "https://github.com/acme/app/pull/7", number: 7 },
  review: { verdict: "request_changes", findings: 3, summary: "Three issues." },
  flows: [add, done],
  generatedAt: "2026-11-02T10:00:00.000Z",
};

describe("renderRunSummary: Markdown", () => {
  it("renders the spec's table, with signed links where given and stored uris elsewhere", () => {
    const { markdown } = renderRunSummary({
      ...base,
      links: {
        [add.evidence[0]?.uri as string]: "https://r2.example/e?sig=1",
        [add.evidence[1]?.uri as string]: "https://r2.example/s?sig=2",
      },
    });
    expect(markdown).toBe(
      [
        "## Verification",
        "Run `ns_123` · branch `selfbuilding/ns_123/build` · PR #7",
        "| | Flow | Kind | Outcome | Evidence |",
        "|---|---|---|---|---|",
        "| ✅ | add a note | regression | verified | [evidence](https://r2.example/e?sig=1) · [screenshots](https://r2.example/s?sig=2) |",
        "| ❌ | mark a note done | new | broken | evidence `s3://bucket/runs/r/mark-a-note-done/evidence.md` |",
        "Review: request_changes, 3 findings.",
        "",
      ].join("\n"),
    );
  });

  it("marks could_not_boot and unverifiable with a warning, escapes pipes and reports failed calls", () => {
    const { markdown } = renderRunSummary({
      ...base,
      pr: null,
      review: { error: "agent_failed" },
      flows: [
        { ...add, outcome: "could_not_boot", name: "a | b" },
        { ...done, outcome: "unverifiable", kind: undefined, evidence: [], error: "timeout" },
      ],
    });
    expect(markdown).toContain("Run `ns_123` · branch `selfbuilding/ns_123/build`\n");
    expect(markdown).toContain("| ⚠️ | a \\| b | regression | could_not_boot |");
    expect(markdown).toContain("| ⚠️ | mark a note done | - | unverifiable | none (timeout) |");
    expect(markdown).toContain("Review: did not complete (agent_failed).");
  });

  it("says so when there are no flows, and when no review ran", () => {
    const { markdown } = renderRunSummary({ ...base, flows: [], review: null });
    expect(markdown).toContain("No flows to verify.");
    expect(markdown).not.toContain("|---|");
    expect(markdown).toContain("Review: not run.");
    expect(renderRunSummary({ ...base, review: { verdict: "approve", findings: 1, summary: "x" } }).markdown).toContain(
      "Review: approve, 1 finding.",
    );
  });

  it("percent-encodes characters that would end a Markdown link", () => {
    const uri = add.evidence[0]?.uri as string;
    const { markdown } = renderRunSummary({ ...base, links: { [uri]: "https://x/a b(c)" } });
    expect(markdown).toContain("[evidence](https://x/a%20b%28c%29)");
  });
});

describe("renderRunSummary: HTML", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const contents = {
    [add.evidence[0]?.uri as string]: "# Evidence\n<script>alert(1)</script>\nStep 1: typed the title.",
    [add.evidence[1]?.uri as string]: png,
  };

  it("is one self-contained page: inline CSS, no script, nothing fetched, evidence text and screenshots inline", () => {
    const { html } = renderRunSummary({ ...base, contents });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script|<link |src="http|@import|url\(/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(`src="data:image/png;base64,${Buffer.from(png).toString("base64")}"`);
    expect(html).toContain('<section id="add-a-note">');
    expect(html).toContain("db.txt");
    expect(html).toContain("Generated 2026-11-02T10:00:00.000Z.");
  });

  it("is deterministic", () => {
    expect(renderRunSummary({ ...base, contents }).html).toBe(renderRunSummary({ ...base, contents }).html);
  });

  it("links screenshots over 512 KiB instead of embedding them", () => {
    const big = new Uint8Array(EMBED_MAX_BYTES + 1);
    const uri = add.evidence[1]?.uri as string;
    const { html } = renderRunSummary({
      ...base,
      contents: { [uri]: big },
      links: { [uri]: "https://r2.example/big" },
    });
    expect(html).not.toContain("data:image/png");
    expect(html).toContain('<a href="https://r2.example/big">01-form.png</a>');
  });

  it("stays under 8 MiB however many screenshots there are", () => {
    const shots = Array.from({ length: 40 }, (_, i) =>
      ev("many", `screenshots/${String(i).padStart(2, "0")}.png`, "image/png"),
    );
    const flow: FlowVerdict = { ...add, slug: "many", evidence: shots };
    const contents = Object.fromEntries(shots.map((s) => [s.uri, new Uint8Array(EMBED_MAX_BYTES - 10)]));
    const { html } = renderRunSummary({ ...base, flows: [flow], contents });
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(PAGE_MAX_BYTES);
    expect(html).toContain("data:image/png");
    expect(html).toContain("39.png <code>");
  });
});

describe("renderRunSummary: Slack", () => {
  it("builds blocks with one section per flow, mrkdwn links and escaped text", () => {
    const uri = add.evidence[0]?.uri as string;
    const { slack } = renderRunSummary({
      ...base,
      flows: [{ ...add, detail: "<!channel> & co" }, done],
      links: { [uri]: "https://r2.example/e" },
    });
    expect(slack.text).toBe("Verification for Mark notes done: 1 verified, 1 broken.");
    expect(slack.blocks[0]).toMatchObject({ type: "header" });
    const sections = slack.blocks.filter((b) => b.type === "section").map((b) => (b.text as { text: string }).text);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("✅ *add a note* (regression): verified");
    expect(sections[0]).toContain("&lt;!channel&gt; &amp; co");
    expect(sections[0]).toContain("<https://r2.example/e|evidence>");
    expect(JSON.stringify(slack.blocks.at(-1))).toContain("Review: request_changes, 3 findings.");
  });

  it("caps the message at Slack's 50 blocks", () => {
    const flows = Array.from({ length: 60 }, (_, i) => ({ ...add, name: `flow ${i}`, slug: `flow-${i}` }));
    const { slack } = renderRunSummary({ ...base, flows });
    expect(slack.blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(slack.blocks)).toContain("more flows on the summary page");
  });
});
