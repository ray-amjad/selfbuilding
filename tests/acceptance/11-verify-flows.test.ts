// Acceptance 11 (docs/spec/demo-path.md §4.3, §4.4): verifyFlows builds in a shared box, runs CodeReview and
// FindFlows in parallel on forks of it, verifies each found flow on its own fork, stores a self-contained summary
// page with the evidence, posts it to Slack (emulated) and writes it into the PR (emulated GitHub, as the App).
//
// Every agent call runs the real runtime and MCP server in a tmpdir box; the scripted harnesses print Claude Code's
// and Codex's native streams. Shell steps are real: the builder commits, FindFlows reads the diff the runtime
// wrote, each verifier writes its evidence files, which the settle step stores in the run's artifact store.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  CodeReview,
  createVerifyFlows,
  FindFlows,
  IMPLEMENTATION_NOTES_PATH,
  ImplementSpec,
  Verify,
  type VerifyFlowsOutput,
} from "@selfbuilding/agents";
import { type ArtifactStore, fileArtifacts, fileJournal, run } from "@selfbuilding/core";
import { type ScriptCall, type ScriptStep, scripted, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitHubRig, startGitHubRig } from "./support/github.js";
import { recorder, scriptedClaude, scriptedCodex, tempDir, useBuiltRuntime } from "./support/kit.js";
import { type SlackRig, startSlackRig } from "./support/slack.js";

let dir: string;
let github: GitHubRig;
let slackRig: SlackRig;
let box: TmpdirProvider;

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-flows-");
  github = await startGitHubRig(path.join(dir, "remote"));
  slackRig = await startSlackRig();
  box = tmpdirProvider({ id: "tmpdir-flows", root: path.join(dir, "boxes") });
});

afterAll(async () => {
  await box?.close();
  await slackRig?.close();
  await github?.close();
});

const SIGNED = "https://signed.example/";

/** Every key put into a signing store, in order. */
const keys: string[] = [];

/** The file store, plus the signed-URL method only web-backed stores (R2, S3) have. It records each key. */
function signingStore(root: string): ArtifactStore {
  const store = fileArtifacts(root);
  return {
    put: (key, body, opts) => {
      keys.push(key);
      return store.put(key, body, opts);
    },
    read: (uri) => store.read(uri),
    hydrate: (ref) => store.hydrate(ref),
    signedUrl: async (uri, opts) => `${SIGNED}${encodeURIComponent(uri)}?ttl=${String(opts?.expiresIn)}`,
  };
}

const heredoc = (file: string, content: string) =>
  `mkdir -p "$(dirname ${file})" && cat > ${file} <<'EOF'\n${content}EOF`;

const NOTES_JS = "export const notes = [];\nexport function markDone(n) {\n  n.done = true;\n}\n";
// A real PNG header and nothing else: enough for the page to embed it as a data URI.
const PNG_PRINTF = "\\211PNG\\r\\n\\032\\n\\000\\000\\000\\015IHDR";

const LEAKED = `ghp_${"a1B2".repeat(9)}`;

const found = {
  summary: "Adds markDone; adding notes shares the notes module.",
  flows: [
    {
      name: "mark a note done",
      kind: "new",
      entry: "the Mark done button on /",
      endState: "the note renders struck through and stays so after a reload",
      rows: ["notes: done = 1"],
      why: "src/notes.js adds markDone",
    },
    {
      name: "add a note",
      kind: "regression",
      entry: "the Add note form on /",
      endState: "a flash Note added and the note in the list",
      rows: ["notes: a new row"],
      why: "src/notes.js is the module the add action uses",
    },
  ],
  noRunnableSurface: false,
  skipped: [],
};

function verifySteps(slug: string, name: string, outcome: "verified" | "broken"): ScriptStep[] {
  const dirIn = `/selfbuilding/out/files/verify/${slug}`;
  const evidence = `${dirIn}/evidence.md`;
  return [
    // A fork carries the build: the verifier sees the builder's commit without fetching anything.
    scripted.sh("grep -q markDone src/notes.js", { expectExit: 0 }),
    scripted.sh(
      `mkdir -p ${dirIn}/screenshots && printf '# ${name}\\n\\nStep 1: opened /.\\nSeen: ${outcome}.\\n' > ${evidence} && printf '${PNG_PRINTF}' > ${dirIn}/screenshots/01-start.png && echo 'select * from notes' > ${dirIn}/db.txt`,
    ),
    scripted.submit({
      summary: `Drove "${name}".`,
      flows: [
        {
          name,
          outcome,
          claim: outcome,
          detail:
            outcome === "verified" ? "The row exists and the page shows it." : "The click changed nothing in the db.",
          evidence,
          evidenceFiles: [`${dirIn}/screenshots/01-start.png`, `${dirIn}/db.txt`],
          checked: ["the page", "the notes table"],
          defects: outcome === "broken" ? [{ where: "/", seen: "done stays 0", evidence }] : [],
        },
      ],
      files: [evidence, `${dirIn}/screenshots/01-start.png`, `${dirIn}/db.txt`],
    }),
  ];
}

/** One script per agent call, picked by the call's label (the last callPath segment) and its pipeline key. */
function script(call: ScriptCall): ScriptStep[] {
  const label = call.callPath.split("/").at(-1) ?? "";
  if (label === "implement") {
    return [
      scripted.sh(heredoc("src/notes.js", NOTES_JS)),
      scripted.sh(
        heredoc(IMPLEMENTATION_NOTES_PATH, "# Implementation notes\n\n## Design decisions\n- markDone mutates.\n"),
      ),
      scripted.sh("git add -A && git commit -qm 'Add markDone'"),
      scripted.submit({
        status: "done",
        summary: "Added markDone to the notes module.",
        changes: [{ file: "src/notes.js", why: "the spec asks for it" }],
        followUps: [],
        openQuestions: [],
        prTitle: "Mark notes done",
        prBody: "## What changed and why\nAdds markDone.\n",
      }),
    ];
  }
  if (label === "review") {
    return [
      scripted.sh("grep -q markDone /selfbuilding/in/diff.patch", { expectExit: 0 }),
      scripted.submit({ verdict: "approve", tier: "medium", summary: "Small and right.", findings: [] }),
    ];
  }
  if (label === "find-flows") {
    return [
      // The runtime wrote the build's diff for this read-only call.
      scripted.sh("grep -q 'export function markDone' /selfbuilding/in/diff.patch", { expectExit: 0 }),
      scripted.sh('test -z "$(git status --porcelain)"', { expectExit: 0 }),
      scripted.submit(found),
    ];
  }
  if (label === "verify" && call.callPath.includes("[mark-a-note-done]")) {
    return verifySteps("mark-a-note-done", "mark a note done", "broken");
  }
  if (label === "verify" && call.callPath.includes("[add-a-note]")) {
    return verifySteps("add-a-note", "add a note", "verified");
  }
  if (label === "verify" && call.callPath.includes("[delete-a-note]")) {
    const d = "/selfbuilding/out/files/verify/delete-a-note";
    return [
      // A failed call's evidence is read off the fork as is; a token in it must not reach the store.
      scripted.sh(
        `mkdir -p ${d} && echo 'boot ok; token ${LEAKED} in env' > ${d}/server.log && printf '\\211PNG\\000${LEAKED}' > ${d}/leak.png`,
      ),
      scripted.error("auth", "the verifier lost its login"),
    ];
  }
  return [scripted.say(`no script for ${call.callPath}`)];
}

async function allText(root: string): Promise<string> {
  let out = "";
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out += await readFile(path.join(e.parentPath, e.name), "utf8").catch(() => "");
  }
  return out;
}

describe("acceptance 11: verifyFlows", () => {
  it("builds, reviews and finds flows on forks, verifies each flow on its own fork, stores and posts the summary", async () => {
    const claude = scriptedClaude(script);
    const codexH = scriptedCodex(script);
    const flowsFactory = createVerifyFlows({
      agents: { ImplementSpec, CodeReview, FindFlows, Verify },
      builder: { harness: claude },
      reviewer: { harness: claude },
      finder: { harness: claude },
      verifier: { harness: codexH },
      pullRequests: github.pullRequests,
    });

    const runId = "ns_accept_flows";
    const journalDir = path.join(dir, "journal");
    const artifactsDir = path.join(dir, "artifacts");
    const events = recorder();
    const out = await run(
      flowsFactory,
      { repo: github.repo, spec: "Add a way to mark a note done." },
      {
        runId,
        config: {
          deployment: "acceptance",
          sandbox: box,
          harness: claude,
          hitl: slackRig.hitl(),
          artifacts: signingStore(artifactsDir),
        },
        journal: fileJournal(journalDir),
        events: [events.sink],
      },
    );
    expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
    const o = out.output as VerifyFlowsOutput;

    // The build, the review and the flows, in findFlows' order, each with its own verdict.
    expect(o.status).toBe("some_failed");
    expect(o.build).toEqual({ status: "done", summary: "Added markDone to the notes module." });
    expect(o.review).toEqual({ verdict: "approve", findings: 0, summary: "Small and right." });
    expect(o.flows.map((f) => [f.name, f.slug, f.kind, f.outcome])).toEqual([
      ["mark a note done", "mark-a-note-done", "new", "broken"],
      ["add a note", "add-a-note", "regression", "verified"],
    ]);
    const add = o.flows[1];
    expect(add?.evidence.map((e) => e.path).sort()).toEqual([
      "/selfbuilding/out/files/verify/add-a-note/db.txt",
      "/selfbuilding/out/files/verify/add-a-note/evidence.md",
      "/selfbuilding/out/files/verify/add-a-note/screenshots/01-start.png",
    ]);
    for (const e of add?.evidence ?? []) expect(e.uri).not.toContain(SIGNED);

    // Placement: one build box; review and findFlows on two forks of it at once; then one fork per flow.
    const launched = events.launched().map((p) => p.split("/").at(-1));
    expect(launched[0]).toBe("implement");
    expect(launched.slice(1, 3).sort()).toEqual(["find-flows", "review"]);
    expect(launched.slice(3)).toEqual(["verify", "verify"]);
    expect(events.of("sandbox.forked").map((e) => (e.data as { n: number }).n)).toEqual([2, 2]);
    const boxes = events.of("agent.launched").map((e) => (e.data as { sandbox: string }).sandbox);
    expect(new Set(boxes).size).toBe(5);

    // The page: stored at runs/<runId>/summary.html, self-contained, with the evidence text and the screenshot inline.
    expect(o.summary.page.contentType).toBe("text/html; charset=utf-8");
    const store = fileArtifacts(artifactsDir);
    const html = new TextDecoder().decode(await store.read(o.summary.page.uri));
    expect(keys).toContain("runs/ns_accept_flows/summary.html");
    expect(html).toContain("<h1>Mark notes done</h1>");
    expect(html).toContain("Step 1: opened /.");
    expect(html).toContain("data:image/png;base64,iVBORw0KGgo");
    expect(html).not.toMatch(/<script|src="http/);

    // The output and the journal carry the link-free Markdown; signed links are made only when posting.
    expect(o.summary.markdown).toContain("| ❌ | mark a note done | new | broken | evidence `");
    expect(o.summary.markdown).toContain("| ✅ | add a note | regression | verified |");
    expect(o.summary.markdown).not.toContain(SIGNED);
    expect(await allText(journalDir)).not.toContain(SIGNED);

    // Slack: one mrkdwn post in the run thread with each flow, signed evidence links and the page link.
    const transcript = await slackRig.transcript();
    expect(transcript).toContain("*Verification: Mark notes done*");
    expect(transcript).not.toContain("## Verification");
    expect(transcript).toContain("add a note");
    expect(transcript).toContain(`<${SIGNED}`);
    expect(transcript).toContain("|Summary page>");
    expect(transcript).toContain("ttl=7d");

    // The PR: opened as the App, then its Verification section written with the same table and signed links.
    const pulls = await github.pulls();
    expect(pulls).toHaveLength(1);
    const body = pulls[0]?.body ?? "";
    expect(pulls[0]?.number).toBe(o.pr?.number);
    expect(body).toContain("markDone mutates.");
    expect(body.match(/^## Verification$/gm)).toHaveLength(1);
    expect(body).toContain("| ❌ | mark a note done | new | broken | [evidence](https://signed.example/");
    expect(body).toContain("[Summary page](https://signed.example/");

    // Nothing is left running: the forks are killed, the build box is paused.
    const states: string[] = [];
    for await (const ref of box.list({ deployment: "acceptance" })) if (ref.state !== "stopped") states.push(ref.state);
    expect(states).toEqual(["paused"]);
  });

  it("verifies the caller's flows without FindFlows, and a failed Verify call becomes an unverifiable verdict", async () => {
    const store2 = fileArtifacts(path.join(dir, "artifacts-2"));
    const claude = scriptedClaude(script);
    const codexH = scriptedCodex(script);
    const flowsFactory = createVerifyFlows({
      agents: { ImplementSpec, CodeReview, FindFlows, Verify },
      builder: { harness: claude },
      reviewer: { harness: claude },
      verifier: { harness: codexH, parallel: 1 },
      notify: false,
    });
    const events = recorder();
    const out = await run(
      flowsFactory,
      {
        repo: github.repo,
        spec: "Add a way to mark a note done.",
        flows: [
          { name: "Add a note", endState: "the note is listed" },
          { name: "delete a note", endState: "the note is gone" },
        ],
      },
      {
        runId: "ns_accept_flows_given",
        config: {
          deployment: "acceptance",
          sandbox: box,
          harness: claude,
          artifacts: store2,
        },
        journal: fileJournal(path.join(dir, "journal-2")),
        events: [events.sink],
      },
    );
    expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
    const o = out.output as VerifyFlowsOutput;

    expect(events.launched().map((p) => p.split("/").at(-1))).toEqual(["implement", "review", "verify", "verify"]);
    // One fork for the review, then one wave per flow.
    expect(events.of("sandbox.forked").map((e) => (e.data as { n: number }).n)).toEqual([1, 1, 1]);
    expect(o.status).toBe("some_failed");
    expect(o.flows.map((f) => [f.name, f.kind, f.outcome])).toEqual([
      ["Add a note", undefined, "verified"],
      ["delete a note", undefined, "unverifiable"],
    ]);
    expect(o.flows[1]?.error).toBeTruthy();
    // Its evidence was read off the fork: the log is stored redacted, the binary holding the token is not stored.
    const evidence = o.flows[1]?.evidence ?? [];
    const log = evidence.find((e) => e.path.endsWith("/server.log"));
    expect(log).toBeDefined();
    const logText = new TextDecoder().decode(await store2.read(log?.uri as string));
    expect(logText).toContain("[REDACTED]");
    expect(logText).not.toContain(LEAKED);
    expect(evidence.some((e) => e.path.endsWith("/leak.png"))).toBe(false);
    // Without a PR API no PR is opened; the summary is still stored.
    expect(o.pr).toBeNull();
    expect(o.summary.markdown).toContain("| ⚠️ | delete a note | - | unverifiable | evidence `");
    expect(o.summary.page.bytes).toBeGreaterThan(0);
  });

  it("stops with no_flows when FindFlows finds no runnable surface, and still stores the summary", async () => {
    const noSurface = (call: ScriptCall): ScriptStep[] =>
      call.callPath.endsWith("/find-flows")
        ? [
            scripted.submit({
              summary: "Only an internal module changed; nothing a user can drive.",
              flows: [],
              noRunnableSurface: true,
              skipped: [{ what: "src/notes.js", why: "no page calls it yet" }],
            }),
          ]
        : script(call);
    const claude = scriptedClaude(noSurface);
    const flowsFactory = createVerifyFlows({
      agents: { ImplementSpec, CodeReview, FindFlows, Verify },
      builder: { harness: claude },
      reviewer: { harness: claude },
      finder: { harness: claude },
      notify: false,
    });
    const events = recorder();
    const out = await run(
      flowsFactory,
      { repo: github.repo, spec: "Add markDone to the notes module." },
      {
        runId: "ns_accept_flows_none",
        config: {
          deployment: "acceptance",
          sandbox: box,
          harness: claude,
          artifacts: fileArtifacts(path.join(dir, "artifacts-3")),
        },
        journal: fileJournal(path.join(dir, "journal-3")),
        events: [events.sink],
      },
    );
    expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
    const o = out.output as VerifyFlowsOutput;
    expect(o.status).toBe("no_flows");
    expect(o.flows).toEqual([]);
    expect(
      events
        .launched()
        .map((p) => p.split("/").at(-1))
        .sort(),
    ).toEqual(["find-flows", "implement", "review"]);
    expect(o.summary.markdown).toContain("No flows to verify.");
  });
});
