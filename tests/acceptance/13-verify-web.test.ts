// Acceptance 13 (docs/spec/demo-path.md §4.2): Verify on a small web app with a form and a database, offline.
//
// The repository holds a tiny Notes server (a JSON file stands in for SQLite) on `main`, and the planted bug on
// `fixture/web-broken-add`: the page shows the submitted note but nothing is stored. Each Verify call plays the
// three roles for real in a tmpdir box running the real runtime: setup resets and seeds a fresh database and boots
// the server detached with a bounded readiness wait; the verifier submits the form (an HTTP client standing in for
// the browser MCP tools) and claims what the page shows; the checker reads the database and the server log and
// writes the verdict. The verify-evidence done check reads claim.json and verdict.json back against the result.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { VERIFY_BROWSER_SERVER, Verify, VerifyResult } from "@selfbuilding/agents";
import { factory, fileArtifacts, fileJournal, type Harness, run, sandbox } from "@selfbuilding/core";
import {
  commitToBranch,
  createLocalRemote,
  type LocalRemote,
  type ScriptCall,
  type ScriptStep,
  scripted,
  type TmpdirProvider,
  tmpdirProvider,
} from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { recorder, scriptedCodex, tempDir, useBuiltRuntime } from "./support/kit.js";

const BROKEN = "fixture/web-broken-add";
const F = "/selfbuilding/out/files/verify/add-a-note";
const TITLE = "Buy oat milk";

const DB = `import fs from "node:fs";
const file = process.env.DATABASE_PATH ?? "./data/app.json";
export const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { notes: [] });
export const save = (db) => fs.writeFileSync(file, JSON.stringify(db, null, 2));
const command = process.argv.at(-1);
if (command === "reset") save({ notes: [] });
if (command === "seed") save({ notes: ["one", "two", "three"].map((title, i) => ({ id: i + 1, title, done: 0 })) });
`;

/** The Notes server. The broken variant renders the submitted note from the redirect and never stores it. */
const server = (broken: boolean) => `import fs from "node:fs";
import http from "node:http";
import { load, save } from "./db.mjs";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  console.log(req.method, url.pathname);
  if (url.pathname === "/api/health") {
    load();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true,"db":"ok"}');
  }
  if (req.method === "POST" && url.pathname === "/notes") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const title = new URLSearchParams(body).get("title") ?? "";
    const db = load();
    const id = db.notes.length + 1;
    ${broken ? "" : "db.notes.push({ id, title, done: 0 });\n    save(db);"}
    res.writeHead(303, { location: "/?added=" + id + ${broken ? '"&title=" + encodeURIComponent(title)' : '""'} });
    return res.end();
  }
  const notes = [...load().notes].reverse();
  const shown = url.searchParams.get("title");
  if (shown) notes.unshift({ title: shown });
  const flash = url.searchParams.has("added") ? '<p data-testid="flash">Note added</p>' : "";
  const items = notes.map((n) => '<li data-testid="note-item">' + esc(n.title) + "</li>").join("");
  res.writeHead(200, { "content-type": "text/html" });
  res.end(flash + '<form data-testid="note-form" method="post" action="/notes"></form><ul data-testid="note-list">' + items + "</ul>");
});
app.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(process.env.DATABASE_PATH + ".port", String(app.address().port));
  console.log("listening");
});
`;

const APP_FILES = {
  "README.md": "# notes\n",
  ".gitignore": "data/\n",
  "web/package.json": `${JSON.stringify({ name: "notes", private: true, type: "module" }, null, 2)}\n`,
  "web/db.mjs": DB,
  "web/server.mjs": server(false),
  ".selfbuilding/verify/README.md":
    "# Verifying this app\n\napp dir web/\nfresh database DATABASE_PATH=/tmp/verify-<slug>.db node db.mjs reset && node db.mjs seed\nboot node server.mjs\n",
};

// ── the three roles, as shell steps ──────────────────────────────────────────────────────────────────────────────

const SETUP = `set -e
F=${F}; mkdir -p "$F/screenshots"
export DATABASE_PATH=/tmp/verify-add-a-note.db
rm -f "$DATABASE_PATH" "$DATABASE_PATH.port"
cd web && node db.mjs reset && node db.mjs seed
setsid nohup node server.mjs > /tmp/verify-add-a-note.server.log 2>&1 < /dev/null &
echo $! > /tmp/verify-add-a-note.pid
timeout 300 sh -c 'until [ -s "$DATABASE_PATH.port" ] && node -e "fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" "http://127.0.0.1:$(cat "$DATABASE_PATH.port")/api/health"; do sleep 0.2; done'
URL="http://127.0.0.1:$(cat "$DATABASE_PATH.port")"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ role: "setup", at: Date.now(), app_url: process.argv[2], readiness_url: process.argv[2] + "/api/health", database_path: process.argv[3], server_log: process.argv[4], booted: true, seeded: { notes: [1, 2, 3] } }))' "$F/setup.json" "$URL" "$DATABASE_PATH" /tmp/verify-add-a-note.server.log`;

// Stands in for the browser MCP tools: open the page, fill the form, submit, read what the user sees.
const VERIFIER = `node --input-type=module <<'EOF'
import fs from "node:fs";
const F = "${F}";
const setup = JSON.parse(fs.readFileSync(F + "/setup.json", "utf8"));
const open = await (await fetch(setup.app_url + "/")).text();
fs.writeFileSync(F + "/screenshots/01-open.png", open);
const after = await fetch(setup.app_url + "/notes", { method: "POST", body: new URLSearchParams({ title: "${TITLE}" }) });
const page = await after.text();
fs.writeFileSync(F + "/screenshots/02-submitted.png", page);
const seen = page.includes("Note added") && page.includes("${TITLE}");
fs.writeFileSync(F + "/evidence.md", "# add a note\\n\\n1. Opened the notes page. ![open](screenshots/01-open.png)\\n2. Typed the title and pressed Add note: " + (seen ? "the flash and the note are on screen" : "the note is not on screen") + ". ![submitted](screenshots/02-submitted.png)\\n");
fs.writeFileSync(F + "/claim.json", JSON.stringify({ role: "verifier", at: Date.now(), outcome: seen ? "verified" : "broken", evidence_file: F + "/evidence.md", detail: seen ? "The page shows the new note." : "The page does not show the new note." }));
EOF`;

// Reads the database and the server log, may only lower the claim, then stops the server.
const CHECKER = `node --input-type=module <<'EOF'
import fs from "node:fs";
const F = "${F}";
const setup = JSON.parse(fs.readFileSync(F + "/setup.json", "utf8"));
const claim = JSON.parse(fs.readFileSync(F + "/claim.json", "utf8"));
const rows = JSON.parse(fs.readFileSync(setup.database_path, "utf8")).notes.filter((n) => n.title === "${TITLE}");
fs.writeFileSync(F + "/db.txt", "notes where title = '${TITLE}'\\n" + JSON.stringify(rows) + "\\n");
fs.writeFileSync(F + "/server.log", fs.readFileSync(setup.server_log).subarray(-65536));
const outcome = claim.outcome === "verified" && rows.length !== 1 ? "broken" : claim.outcome;
fs.writeFileSync(F + "/verdict.json", JSON.stringify({ role: "checker", at: Date.now(), outcome, claim: claim.outcome, detail: rows.length === 1 ? "Row " + rows[0].id + " holds the note." : "The page showed the note but notes has no row for it.", checked: ["notes rows (db.txt)", "server.log", "02-submitted.png"], defects: [] }));
EOF
kill "$(cat /tmp/verify-add-a-note.pid)"`;

const EVIDENCE_FILES = [
  "setup.json",
  "claim.json",
  "verdict.json",
  "screenshots/01-open.png",
  "screenshots/02-submitted.png",
  "db.txt",
  "server.log",
].map((f) => `${F}/${f}`);

const submission = (outcome: "verified" | "broken") => ({
  summary: `using the repo's verify facts; add a note: ${outcome}`,
  flows: [
    {
      name: "add a note",
      outcome,
      claim: "verified",
      detail: outcome === "verified" ? "The note is on screen and stored." : "The note is on screen but not stored.",
      evidence: `${F}/evidence.md`,
      evidenceFiles: EVIDENCE_FILES,
      checked: ["notes rows (db.txt)", "server.log", "02-submitted.png"],
      defects: [],
    },
  ],
  files: [`${F}/evidence.md`, ...EVIDENCE_FILES],
});

/** On the planted bug the first submit copies the verifier's claim; the done check sends it back to the checker's verdict. */
function script(call: ScriptCall): ScriptStep[][] {
  const roles = [
    scripted.sh(SETUP, { expectExit: 0 }),
    scripted.sh(VERIFIER, { expectExit: 0 }),
    scripted.sh(CHECKER, { expectExit: 0 }),
  ];
  if (call.callPath.endsWith("verify-main")) return [[...roles, scripted.submit(submission("verified"))]];
  // The follow-up turn fails unless its prompt carries the done check's complaint.
  const feedback = scripted.sh("grep -q 'verdict.json says broken' /selfbuilding/in/prompt.md", { expectExit: 0 });
  return [
    [...roles, scripted.submit(submission("verified"))],
    [feedback, scripted.submit(submission("broken"))],
  ];
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────────────────────

let dir: string;
let remote: LocalRemote;
let provider: TmpdirProvider;
const prepared: string[][] = [];

beforeAll(async () => {
  useBuiltRuntime();
  dir = await tempDir("sba-verify-web-");
  remote = await createLocalRemote(path.join(dir, "remote"), { files: APP_FILES });
  await commitToBranch(remote, {
    branch: BROKEN,
    files: { "web/server.mjs": server(true) },
    message: "Add note (planted bug)",
  });
  provider = tmpdirProvider({ root: path.join(dir, "boxes") });
});

afterAll(async () => {
  // A failed run can leave its detached server behind; the checker normally stops it.
  const entries = dir ? await readdir(path.join(dir, "boxes"), { recursive: true }).catch(() => []) : [];
  for (const entry of entries.filter((e) => e.endsWith("verify-add-a-note.pid"))) {
    const pid = Number(await readFile(path.join(dir, "boxes", entry), "utf8").catch(() => ""));
    if (pid > 0) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
  }
  await provider?.close();
});

/** The scripted Codex, recording the MCP servers each call was prepared with. */
function harness(): Harness {
  const h = scriptedCodex(script);
  return {
    ...h,
    prepare: (ctx) => {
      prepared.push(ctx.mcpServers.map((s) => s.name));
      expect(ctx.mcpServers.find((s) => s.name === "browser")).toEqual(VERIFY_BROWSER_SERVER);
      return h.prepare(ctx);
    },
  };
}

const ADD_A_NOTE = {
  name: "add a note",
  endState: "The new note is listed first with the flash 'Note added', and survives a reload.",
  rows: ["notes: one row with the submitted title, done = 0"],
};

const FLOW_FILES = ["evidence.md", ...EVIDENCE_FILES.map((f) => f.slice(F.length + 1))];

const VerifyWeb = factory(
  { name: "verify-web", input: z.object({ repo: z.string(), branch: z.string().optional(), label: z.string() }) },
  async ({ repo, branch, label }) => {
    // A shared handle, as verifyFlows runs Verify on a fork of the build box: the box's size wins over medium.
    const box = sandbox({ repo, label: `app-${label}`, ...(branch ? { branch } : {}) });
    try {
      const v = await Verify(
        { change: "Notes: add a note from the form.", flows: [ADD_A_NOTE] },
        { sandbox: box, label, harness: harness() },
      );
      // The flow directory as the box left it, read before the box goes.
      const inBox: Record<string, string> = {};
      const listed = await box.exec(`cd ${F} && find . -type f | sort`);
      for (const rel of listed.stdoutTail.split("\n").filter(Boolean)) {
        const name = rel.replace(/^\.\//, "");
        inBox[name] = (await box.exec(`cat ${F}/${name}`)).stdoutTail;
      }
      return {
        result: v.result,
        doneRetries: v.attempts.doneRetries,
        files: v.artifacts.files.map((f) => f.path),
        inBox,
      };
    } finally {
      await box.dispose();
    }
  },
);

interface Out {
  result: unknown;
  doneRetries: number;
  files: string[];
  inBox: Record<string, string>;
}

async function verifyOn(branch: string | undefined, label: string) {
  const events = recorder();
  const out = await run(
    VerifyWeb,
    { repo: remote.url, ...(branch ? { branch } : {}), label },
    {
      runId: `ns_accept_verify_${label}`,
      config: {
        deployment: "acceptance",
        sandbox: provider,
        harness: harness(),
        artifacts: fileArtifacts(path.join(dir, "artifacts")),
      },
      journal: fileJournal(path.join(dir, `journal-${label}`)),
      events: [events.sink],
    },
  );
  expect(out.status, JSON.stringify(events.of("error").map((e) => e.data))).toBe("ok");
  const o = out.output as Out;
  const json = (name: string) => JSON.parse(o.inBox[name] ?? "null") as Record<string, unknown>;
  return { o, result: VerifyResult.parse(o.result), json, events };
}

let mainRun: Out | undefined;

describe("acceptance 13: Verify on a web app with a form and a database", () => {
  it("verifies adding a note on the correct change: setup, verifier and checker in order, in the evidence layout", async () => {
    const { o, result, json } = await verifyOn(undefined, "verify-main");
    mainRun = o;
    expect(result.flows).toHaveLength(1);
    const [flow] = result.flows;
    expect(flow).toMatchObject({ name: "add a note", outcome: "verified", claim: "verified" });
    expect(o.doneRetries).toBe(0);

    // The evidence layout: every file of the flow sits under its slug directory.
    expect(Object.keys(o.inBox).sort()).toEqual([...FLOW_FILES].sort());
    expect(o.inBox["evidence.md"]).toContain("![submitted](screenshots/02-submitted.png)");
    expect(o.inBox["server.log"]).toContain("POST /notes");

    // The roles ran in order, on a fresh, seeded database that the checker read back.
    const [setup, claim, verdict] = [json("setup.json"), json("claim.json"), json("verdict.json")];
    expect([setup.role, claim.role, verdict.role]).toEqual(["setup", "verifier", "checker"]);
    expect(setup.at as number).toBeLessThanOrEqual(claim.at as number);
    expect(claim.at as number).toBeLessThanOrEqual(verdict.at as number);
    expect(setup).toMatchObject({ booted: true, seeded: { notes: [1, 2, 3] } });
    expect(String(setup.database_path)).toMatch(/\/tmp\/verify-add-a-note\.db$/);
    expect(verdict).toMatchObject({ outcome: "verified", claim: "verified", detail: "Row 4 holds the note." });
    expect(o.inBox["db.txt"]).toContain(`"title":"${TITLE}"`);

    // Verify ran with the browser MCP server, after the selfbuilding server.
    expect(prepared.at(-1)).toEqual(["selfbuilding", "browser"]);
  }, 120_000);

  it("finds the planted bug broken: the page lies, the database does not, and the result must repeat the verdict", async () => {
    const { o, result, json } = await verifyOn(BROKEN, "verify-broken");
    const [flow] = result.flows;
    // The verifier saw the note on screen and claimed verified; the checker found no row and lowered it.
    expect(flow).toMatchObject({ name: "add a note", outcome: "broken", claim: "verified" });
    expect(json("claim.json")).toMatchObject({ outcome: "verified" });
    expect(json("verdict.json")).toMatchObject({ outcome: "broken", claim: "verified" });
    expect(o.inBox["db.txt"]).toBe(`notes where title = '${TITLE}'\n[]\n`);
    expect(o.inBox["screenshots/02-submitted.png"]).toContain(TITLE);

    // The first submit copied the claim; verify-evidence rejected it against verdict.json (the follow-up turn's
    // prompt says so, or its first step fails) and the second submit repeats the verdict.
    expect(o.doneRetries).toBe(1);
  }, 120_000);

  // The supervisor copies /selfbuilding/out/files/** into the attempt's artifacts and the host uploads each file.
  it("collects every file of the flow into Artifacts.files", () => {
    expect(mainRun).toBeDefined();
    for (const name of FLOW_FILES) {
      expect(
        mainRun?.files.some((p) => p.endsWith(`verify/add-a-note/${name}`)),
        name,
      ).toBe(true);
    }
  });
});
