import type { FlowEvidence, FlowVerdict } from "./schemas.js";

// The per-run summary page (docs/spec/demo-path.md §4.4). Owner: verify-flows.

export interface RunSummaryInput {
  runId: string;
  /** Usually the PR title or the spec's first heading. */
  title: string;
  branch: string;
  pr?: { url: string; number: number } | null;
  review?: { verdict: string; findings: number; summary: string } | { error: string } | null;
  flows: FlowVerdict[];
  /** Evidence uri → time-limited https URL (from `ArtifactStore.signedUrl`); a missing entry renders the uri. */
  links?: Record<string, string>;
  /**
   * Evidence uri → its bytes, for the HTML page only: `evidence.md` is shown as preformatted text and screenshots
   * are embedded. A uri missing here is linked instead.
   */
  contents?: Record<string, Uint8Array | string>;
  /** ISO; passed in so rendering stays deterministic. */
  generatedAt: string;
}

/** A Slack message: `text` is the notification fallback, `blocks` the Block Kit layout. */
export interface RunSummarySlack {
  text: string;
  blocks: Record<string, unknown>[];
  /** The same content as one mrkdwn message (`*bold*`, `<url|text>` links), for channels that post text only. */
  mrkdwn: string;
}

/** Screenshots up to this size are embedded as data URIs; larger ones are linked. */
export const EMBED_MAX_BYTES = 512 * 1024;
/** The whole HTML page stays under this. */
export const PAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Each evidence.md shown on the page is cut here. */
const EVIDENCE_TEXT_MAX = 256 * 1024;
const SLACK_SECTION_MAX = 3000;
const SLACK_MAX_BLOCKS = 50;

const ICON: Record<FlowVerdict["outcome"], string> = {
  verified: "✅",
  broken: "❌",
  could_not_boot: "⚠️",
  unverifiable: "⚠️",
};

/** Renders the summary as Markdown (PR body, output), one self-contained HTML page (stored), and Slack mrkdwn. */
export function renderRunSummary(input: RunSummaryInput): { markdown: string; html: string; slack: RunSummarySlack } {
  return { markdown: renderMarkdown(input), html: renderHtml(input), slack: renderSlack(input) };
}

// ───────────────────────────── shared ─────────────────────────────

/** The flow's one evidence file: `evidence.md`, else the first file that is not a screenshot. */
function evidenceFile(f: FlowVerdict): FlowEvidence | undefined {
  return f.evidence.find((e) => e.path.endsWith("/evidence.md")) ?? f.evidence.find((e) => !isScreenshot(e));
}

function screenshots(f: FlowVerdict): FlowEvidence[] {
  return f.evidence.filter(isScreenshot);
}

function isScreenshot(e: FlowEvidence): boolean {
  return e.contentType.startsWith("image/") || e.path.includes("/screenshots/");
}

function reviewLine(review: RunSummaryInput["review"]): string {
  if (!review) return "Review: not run.";
  if ("error" in review) return `Review: did not complete (${oneLine(review.error)}).`;
  return `Review: ${review.verdict}, ${review.findings} ${review.findings === 1 ? "finding" : "findings"}.`;
}

function headerLine(input: RunSummaryInput, code: (s: string) => string): string {
  const parts = [`Run ${code(input.runId)}`, `branch ${code(input.branch)}`];
  if (input.pr) parts.push(`PR #${input.pr.number}`);
  return parts.join(" · ");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ───────────────────────────── Markdown ─────────────────────────────

function renderMarkdown(input: RunSummaryInput): string {
  const lines = ["## Verification", headerLine(input, mdCode)];
  if (input.flows.length === 0) {
    lines.push("No flows to verify.");
  } else {
    lines.push("| | Flow | Kind | Outcome | Evidence |", "|---|---|---|---|---|");
    for (const f of input.flows) {
      lines.push(
        `| ${ICON[f.outcome]} | ${mdCell(f.name)} | ${f.kind ?? "-"} | ${f.outcome} | ${mdEvidence(f, input.links)} |`,
      );
    }
  }
  lines.push(reviewLine(input.review));
  return `${lines.join("\n")}\n`;
}

function mdEvidence(f: FlowVerdict, links: Record<string, string> | undefined): string {
  const parts: string[] = [];
  const ev = evidenceFile(f);
  if (ev) parts.push(mdLink("evidence", ev.uri, links));
  const shot = screenshots(f)[0];
  if (shot) parts.push(mdLink("screenshots", shot.uri, links));
  if (parts.length === 0) return f.error ? `none (${mdCell(f.error)})` : "none";
  return parts.join(" · ");
}

function mdLink(label: string, uri: string, links: Record<string, string> | undefined): string {
  const url = links?.[uri];
  // A bare ")" or space would end the Markdown link early.
  const safe = url?.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return safe ? `[${label}](${safe})` : `${label} ${mdCode(uri)}`;
}

function mdCell(s: string): string {
  return oneLine(s).replace(/\|/g, "\\|");
}

function mdCode(s: string): string {
  return `\`${s.replace(/`/g, "'")}\``;
}

// ───────────────────────────── HTML ─────────────────────────────

const CSS = `body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:2rem;color:#1d1d1f;background:#fafafa}
main{max-width:1100px;margin:0 auto}h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.15rem;margin:2rem 0 .5rem}
.meta{color:#555}table{border-collapse:collapse;width:100%;background:#fff;margin:1rem 0}
th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;vertical-align:top}th{background:#f0f0f0}
code{font:13px ui-monospace,Menlo,monospace;background:#f0f0f0;padding:0 .2rem;border-radius:3px}
pre{font:13px/1.45 ui-monospace,Menlo,monospace;background:#fff;border:1px solid #ddd;padding:.75rem;overflow:auto;white-space:pre-wrap}
section{background:#fff;border:1px solid #ddd;border-radius:6px;padding:1rem;margin:1rem 0}
.verified{color:#137333}.broken{color:#b3261e}.could_not_boot,.unverifiable{color:#8a5a00}
figure{margin:.5rem 0}figure img{max-width:100%;border:1px solid #ddd}figcaption{font-size:.85rem;color:#555}
footer{color:#777;font-size:.85rem;margin-top:2rem}`;

function renderHtml(input: RunSummaryInput): string {
  const links = input.links ?? {};
  const contents = input.contents ?? {};
  const head = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(input.title)} · verification</title>`,
    `<style>${CSS}</style></head><body><main>`,
    `<h1>${esc(input.title)}</h1>`,
    `<p class="meta">${headerLine(input, htmlCode)}${input.pr ? ` · <a href="${attr(input.pr.url)}">${esc(input.pr.url)}</a>` : ""}</p>`,
  ];
  const table: string[] = [];
  if (input.flows.length === 0) table.push("<p>No flows to verify.</p>");
  else {
    table.push(
      "<table><thead><tr><th></th><th>Flow</th><th>Kind</th><th>Outcome</th><th>Evidence</th></tr></thead><tbody>",
    );
    for (const f of input.flows) {
      const ev = evidenceFile(f);
      const shots = screenshots(f);
      const cells = [
        ev ? htmlLink("evidence", ev.uri, links) : "",
        shots[0] ? htmlLink("screenshots", shots[0].uri, links) : "",
      ].filter(Boolean);
      table.push(
        `<tr><td>${ICON[f.outcome]}</td><td><a href="#${attr(f.slug)}">${esc(f.name)}</a></td><td>${esc(f.kind ?? "-")}</td>` +
          `<td class="${f.outcome}">${f.outcome}</td><td>${cells.length > 0 ? cells.join(" · ") : "none"}</td></tr>`,
      );
    }
    table.push("</tbody></table>");
  }
  table.push(`<p>${esc(reviewLine(input.review))}</p>`);
  if (input.review && !("error" in input.review)) table.push(`<pre>${esc(input.review.summary)}</pre>`);

  const tail = `<footer>Generated ${esc(input.generatedAt)}.</footer></main></body></html>\n`;

  // Detail sections without images first, to know how much of the page budget the images may use.
  const details = input.flows.map((f) => flowDetail(f, links, contents));
  const fixed = byteLength(head.join("\n")) + byteLength(table.join("\n")) + byteLength(tail);
  let budget = PAGE_MAX_BYTES - fixed - details.reduce((n, d) => n + byteLength(d.text), 0) - 64 * 1024;

  const sections = input.flows.map((f, i) => {
    const d = details[i] as { text: string };
    const figures = screenshots(f).map((shot) => {
      const body = contents[shot.uri];
      const caption = `<figcaption>${esc(basename(shot.path))}</figcaption>`;
      if (body !== undefined) {
        const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
        const uriLength = 32 + Math.ceil(bytes.length / 3) * 4;
        if (bytes.length <= EMBED_MAX_BYTES && uriLength <= budget) {
          budget -= uriLength;
          const src = `data:${shot.contentType};base64,${Buffer.from(bytes).toString("base64")}`;
          return `<figure><img alt="${attr(basename(shot.path))}" src="${src}">${caption}</figure>`;
        }
      }
      return `<figure>${htmlLink(basename(shot.path), shot.uri, links)}${caption}</figure>`;
    });
    return d.text.replace("<!--figures-->", figures.join("\n"));
  });

  return [...head, ...table, ...sections, tail].join("\n");
}

function flowDetail(
  f: FlowVerdict,
  links: Record<string, string>,
  contents: Record<string, Uint8Array | string>,
): { text: string } {
  const parts = [
    `<section id="${attr(f.slug)}">`,
    `<h2>${ICON[f.outcome]} ${esc(f.name)} <span class="${f.outcome}">${f.outcome}</span></h2>`,
    `<p>${esc(f.detail)}</p>`,
  ];
  if (f.error) parts.push(`<p><strong>The Verify call failed:</strong> ${esc(f.error)}</p>`);
  const ev = evidenceFile(f);
  if (ev) {
    const body = contents[ev.uri];
    if (body !== undefined) {
      let text = typeof body === "string" ? body : new TextDecoder().decode(body);
      if (text.length > EVIDENCE_TEXT_MAX)
        text = `${text.slice(0, EVIDENCE_TEXT_MAX)}\n… (cut; open the file for the rest)`;
      parts.push(`<pre>${esc(text)}</pre>`);
    } else parts.push(`<p>${htmlLink("evidence.md", ev.uri, links)}</p>`);
  }
  parts.push("<!--figures-->");
  const others = f.evidence.filter((e) => e !== ev && !isScreenshot(e));
  if (others.length > 0) {
    parts.push(
      `<ul>${others.map((e) => `<li>${htmlLink(basename(e.path), e.uri, links)} <span class="meta">${esc(e.contentType)}, ${e.bytes} bytes</span></li>`).join("")}</ul>`,
    );
  }
  parts.push(`<p class="meta">Call ${htmlCode(f.callPath || "-")}</p>`, "</section>");
  return { text: parts.join("\n") };
}

function htmlLink(label: string, uri: string, links: Record<string, string>): string {
  const url = links[uri];
  return url ? `<a href="${attr(url)}">${esc(label)}</a>` : `${esc(label)} ${htmlCode(uri)}`;
}

function htmlCode(s: string): string {
  return `<code>${esc(s)}</code>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

function basename(p: string): string {
  return p.split("/").at(-1) ?? p;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// ───────────────────────────── Slack ─────────────────────────────

function renderSlack(input: RunSummaryInput): RunSummarySlack {
  const links = input.links ?? {};
  const counts = new Map<string, number>();
  for (const f of input.flows) counts.set(f.outcome, (counts.get(f.outcome) ?? 0) + 1);
  const tally = [...counts].map(([k, n]) => `${n} ${k}`).join(", ") || "no flows";
  const text = `Verification for ${input.title}: ${tally}.`;
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: `Verification: ${input.title}`.slice(0, 150) } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: slackCut(
            `Run \`${slackEsc(input.runId)}\` · branch \`${slackEsc(input.branch)}\`${input.pr ? ` · <${input.pr.url}|PR #${input.pr.number}>` : ""}`,
          ),
        },
      ],
    },
  ];
  if (input.flows.length === 0) blocks.push(section("No flows to verify."));
  // Two blocks are kept for the review line and an overflow note.
  const room = SLACK_MAX_BLOCKS - blocks.length - 2;
  for (const f of input.flows.slice(0, room)) {
    const refs: string[] = [];
    const ev = evidenceFile(f);
    if (ev) refs.push(slackLink("evidence", ev.uri, links));
    const shot = screenshots(f)[0];
    if (shot) refs.push(slackLink("screenshots", shot.uri, links));
    blocks.push(
      section(
        `${ICON[f.outcome]} *${slackEsc(f.name)}*${f.kind ? ` (${f.kind})` : ""}: ${f.outcome}\n${slackEsc(oneLine(f.detail))}${refs.length > 0 ? `\n${refs.join(" · ")}` : ""}`,
      ),
    );
  }
  if (input.flows.length > room)
    blocks.push(section(`…and ${input.flows.length - room} more flows on the summary page.`));
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: slackCut(slackEsc(reviewLine(input.review))) }] });
  return { text, blocks, mrkdwn: blocksToMrkdwn(blocks) };
}

/** The blocks as one mrkdwn message, for a channel that posts text only: the header bold, one paragraph a block. */
function blocksToMrkdwn(blocks: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "header") parts.push(`*${slackEsc((b.text as { text: string }).text).replace(/\*/g, "")}*`);
    else if (b.type === "section") parts.push((b.text as { text: string }).text);
    else if (b.type === "context") parts.push((b.elements as { text: string }[]).map((e) => e.text).join(" "));
  }
  return parts.join("\n\n");
}

function section(text: string): Record<string, unknown> {
  return { type: "section", text: { type: "mrkdwn", text: slackCut(text) } };
}

function slackLink(label: string, uri: string, links: Record<string, string>): string {
  const url = links[uri];
  return url ? `<${url}|${label}>` : `${label} \`${slackEsc(uri)}\``;
}

function slackEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackCut(s: string): string {
  return s.length > SLACK_SECTION_MAX ? `${s.slice(0, SLACK_SECTION_MAX - 1)}…` : s;
}
