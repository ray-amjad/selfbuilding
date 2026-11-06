import { readFile } from "node:fs/promises";
import type { DoneCheck, DoneContext, ProviderSandbox, SandboxHandle } from "@selfbuilding/core";
import { openTestBox, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyEvidenceCheck, verifyResultProblems, verifyRoleFileProblems } from "./checks.js";
import { VERIFY_BROWSER_SERVER, VERIFY_DEFAULT_SIZE, verifyContract } from "./contracts.js";
import { skillDir } from "./pack.js";
import {
  VERIFY_EVIDENCE_DIR,
  VerifyClaimFile,
  type VerifyResult,
  VerifySetupFile,
  VerifyVerdictFile,
  verifyFlowPaths,
  verifySlug,
} from "./schemas.js";

// Verify, ready for a real web app (docs/spec/demo-path.md §4.2): placement defaults, the per-flow evidence layout,
// and the done check that ties the result to the files the three roles wrote.

type Flow = VerifyResult["flows"][number];
const DIR = `${VERIFY_EVIDENCE_DIR}/add-a-note`;

const flow = (over: Partial<Flow> = {}): Flow => ({
  name: "add a note",
  outcome: "verified",
  claim: "verified",
  detail: "Added a note; it is listed and stored.",
  evidence: `${DIR}/evidence.md`,
  evidenceFiles: [`${DIR}/setup.json`, `${DIR}/claim.json`, `${DIR}/verdict.json`, `${DIR}/screenshots/01-open.png`],
  checked: ["notes rows"],
  defects: [],
  ...over,
});
const result = (flows: Flow[]): VerifyResult => ({
  summary: "using the repo's verify facts",
  flows,
  files: flows.flatMap((f) => [f.evidence, ...(f.evidenceFiles ?? [])]),
});

const claim = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ outcome: "verified", evidence_file: `${DIR}/evidence.md`, detail: "added it", ...over });
const verdict = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ outcome: "verified", claim: "verified", detail: "row 4 exists", checked: ["notes"], ...over });

describe("Verify placement", () => {
  it("defaults to a medium box with the browser MCP server, on top of the one-hour timeout", () => {
    expect(VERIFY_DEFAULT_SIZE).toBe("medium");
    expect(verifyContract.defaults).toEqual({ timeout: "1h", size: "medium", mcpServers: [VERIFY_BROWSER_SERVER] });
  });

  it("runs the image's playwright-mcp headless, isolated, with screenshots in the evidence directory", () => {
    // The fields demo-path §3 fixes for BROWSER_MCP_SERVER; env carries the browsers path past Codex's env allow-list.
    expect(VERIFY_BROWSER_SERVER).toEqual({
      name: "browser",
      type: "stdio",
      command: "/usr/local/bin/playwright-mcp",
      args: ["--headless", "--isolated", "--browser", "chromium", "--no-sandbox", "--output-dir", VERIFY_EVIDENCE_DIR],
      env: { PLAYWRIGHT_BROWSERS_PATH: "/opt/selfbuilding/browsers" },
    });
  });
});

describe("the evidence layout", () => {
  it("slugs a flow name: lowercased, non-alphanumeric runs to one dash, trimmed, at most 48 characters", () => {
    expect(verifySlug("Add a note")).toBe("add-a-note");
    expect(verifySlug("  Mark a note DONE (regression)!  ")).toBe("mark-a-note-done-regression");
    expect(verifySlug("café → checkout")).toBe("caf-checkout");
    expect(verifySlug("a".repeat(60))).toHaveLength(48);
    expect(verifySlug(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
    expect(verifySlug("!!!")).toBe("flow");
  });

  it("puts every file of a flow under its slug directory", () => {
    expect(verifyFlowPaths("Add a note")).toEqual({
      dir: DIR,
      setup: `${DIR}/setup.json`,
      claim: `${DIR}/claim.json`,
      verdict: `${DIR}/verdict.json`,
      evidence: `${DIR}/evidence.md`,
      screenshots: `${DIR}/screenshots`,
      db: `${DIR}/db.txt`,
      serverLog: `${DIR}/server.log`,
      trace: `${DIR}/trace.zip`,
    });
  });

  it("parses the role files the skill's examples show, keeping extra keys", () => {
    expect(
      VerifySetupFile.parse({
        app_url: "http://127.0.0.1:3000",
        readiness_url: "http://127.0.0.1:3000/api/health",
        database_path: "/tmp/verify-add-a-note.db",
        booted: true,
        seeded: { notes: [1, 2, 3] },
        port: 3000,
      }).port,
    ).toBe(3000);
    expect(VerifyClaimFile.parse(JSON.parse(claim({ observations: ["a console warning"] }))).outcome).toBe("verified");
    expect(VerifyVerdictFile.parse(JSON.parse(verdict({ outcome: "broken" }))).outcome).toBe("broken");
    expect(VerifyVerdictFile.safeParse({ outcome: "passed", detail: "d", checked: [] }).success).toBe(false);
  });

  it("the skill names the same layout, sizes and limits the code checks", async () => {
    const skill = await readFile(`${skillDir("verify")}/SKILL.md`, "utf8");
    for (const file of ["setup.json", "claim.json", "verdict.json", "evidence.md", "db.txt", "server.log"]) {
      expect(skill).toContain(file);
    }
    expect(skill).toContain("screenshots/NN-<step>.png");
    expect(skill).toContain("DATABASE_PATH=/tmp/verify-<slug>.db");
    expect(skill).toContain("timeout 300");
    expect(skill).toContain("tail -c 65536");
    const blocks = await readFile(`${skillDir("verify")}/references/prompt-blocks.md`, "utf8");
    for (const block of ["MISSING DEPENDENCY POLICY", "VERIFIER SCOPE", "STRUCTURED RESULT", "CHECKER RULES"]) {
      expect(blocks).toContain(`BEGIN ${block}\n`);
      expect(blocks).toContain(`END ${block}\n`);
    }
  });
});

describe("verify result rules for the layout", () => {
  it("accepts a flow whose files all sit in its slug directory and are collected", () => {
    expect(verifyResultProblems(result([flow()]))).toEqual([]);
  });

  it("rejects evidence outside the flow's directory", () => {
    const r = result([flow({ evidence: `${VERIFY_EVIDENCE_DIR}/notes/evidence.md` })]);
    expect(verifyResultProblems(r).join()).toMatch(/not in the flow's directory .*add-a-note/);
    const escaped = result([flow({ evidence: `${DIR}/../other/evidence.md` })]);
    expect(verifyResultProblems(escaped).join()).toMatch(/not in the flow's directory/);
  });

  it("rejects evidenceFiles that are uncollected, elsewhere or repeat the evidence file", () => {
    const shot = `${DIR}/screenshots/02-added.png`;
    expect(verifyResultProblems({ ...result([flow()]), flows: [flow({ evidenceFiles: [shot] })] }).join()).toMatch(
      /02-added.png is not listed in files/,
    );
    expect(verifyResultProblems(result([flow({ evidenceFiles: ["/selfbuilding/out/files/x.png"] })])).join()).toMatch(
      /x.png is not in the flow's directory/,
    );
    expect(verifyResultProblems(result([flow({ evidenceFiles: [`${DIR}/evidence.md`] })])).join()).toMatch(
      /repeats the evidence file/,
    );
  });
});

describe("the role files agree with the result", () => {
  it("passes when the result repeats the claim and the verdict", () => {
    expect(verifyRoleFileProblems(flow(), { claim: claim(), verdict: verdict() })).toEqual([]);
    const lowered = flow({ outcome: "broken", claim: "verified" });
    expect(verifyRoleFileProblems(lowered, { claim: claim(), verdict: verdict({ outcome: "broken" }) })).toEqual([]);
  });

  it("judges a flow with no role files by the result alone", () => {
    expect(verifyRoleFileProblems(flow(), {})).toEqual([]);
  });

  it("rejects a result that overrules the checker's verdict", () => {
    const problems = verifyRoleFileProblems(flow(), { claim: claim(), verdict: verdict({ outcome: "broken" }) });
    expect(problems.join()).toMatch(/outcome is verified but .*verdict.json says broken/);
  });

  it("rejects a claim the result does not repeat", () => {
    expect(verifyRoleFileProblems(flow({ claim: undefined }), { claim: claim(), verdict: verdict() }).join()).toMatch(
      /claim is missing but .*claim.json says verified/,
    );
    expect(
      verifyRoleFileProblems(flow({ claim: "broken", outcome: "broken" }), {
        claim: claim(),
        verdict: verdict({ outcome: "broken" }),
      }).join(),
    ).toMatch(/claim is broken but .*says verified/);
  });

  it("rejects a claim with no verdict: the checker never ran", () => {
    expect(verifyRoleFileProblems(flow(), { claim: claim() }).join()).toMatch(/has no .*verdict.json; run the checker/);
  });

  it("rejects role files that are not one JSON object of the right shape", () => {
    expect(verifyRoleFileProblems(flow(), { claim: "verified", verdict: verdict() }).join()).toMatch(
      /claim.json is not one JSON object/,
    );
    expect(verifyRoleFileProblems(flow(), { verdict: '{"outcome":"ok"}' }).join()).toMatch(
      /verdict.json does not match its shape/,
    );
  });
});

describe("verify-evidence in a sandbox", () => {
  let provider: TmpdirProvider;
  let box: ProviderSandbox;
  const ctx = (): DoneContext => ({
    sandbox: { exec: (cmd: string) => box.exec(cmd, { cwd: "/selfbuilding/work" }) } as unknown as SandboxHandle,
    git: { base: "a", head: "a", commitsAhead: 0, dirty: false, changedPaths: [], remoteHasBranch: async () => false },
    artifacts: {},
  });
  const run = async (check: DoneCheck<unknown, VerifyResult>, r: VerifyResult) => {
    if (!("assert" in check)) throw new Error("not an assert check");
    return check.assert(r, ctx());
  };
  const write = async (p: string, text: string) => {
    const r = await box.exec(`mkdir -p "$(dirname '${p}')" && cat > '${p}' <<'EOF'\n${text}\nEOF`);
    if (r.exitCode !== 0) throw new Error(r.stderrTail);
  };

  beforeAll(async () => {
    provider = tmpdirProvider();
    box = await openTestBox(provider, "verify-layout");
    await box.exec("mkdir -p /selfbuilding/work /selfbuilding/out/files");
  }, 30_000);
  afterAll(async () => {
    await provider.close();
  });

  it("reads the role files back and names every missing evidence file", async () => {
    const r = result([flow()]);
    await write(`${DIR}/evidence.md`, "1. opened /");
    await write(`${DIR}/setup.json`, '{"app_url":"http://127.0.0.1:3000"}');
    await write(`${DIR}/claim.json`, claim());
    let out = await run(verifyEvidenceCheck, r);
    expect(out).toMatch(/verdict.json does not exist/);
    expect(out).toMatch(/01-open.png does not exist/);
    expect(out).toMatch(/run the checker/);

    await write(`${DIR}/screenshots/01-open.png`, "png");
    await write(`${DIR}/verdict.json`, verdict({ outcome: "broken" }));
    out = await run(verifyEvidenceCheck, r);
    expect(out).toMatch(/outcome is verified but .*says broken/);

    await write(`${DIR}/verdict.json`, verdict());
    expect(await run(verifyEvidenceCheck, r)).toBe(true);
  });
});
