// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are skill bodies, not templates.
import { describe, expect, it } from "vitest";
import {
  applyContextOutputs,
  contractFingerprint,
  findContextExpressions,
  PREAMBLE_VERSION,
  processBody,
  renderPreamble,
  renderUserPrompt,
  substitute,
} from "./index.js";

describe("substitute", () => {
  const ctx = { skillName: "code-review", workdir: "/selfbuilding/work" };

  it("fills the skill dir, workdir and session tokens", () => {
    const out = substitute(
      "${CLAUDE_SKILL_DIR} ${SELFBUILDING_SKILL_DIR} ${CLAUDE_PROJECT_DIR} ${SELFBUILDING_WORKDIR} ${CLAUDE_SESSION_ID}",
      {
        ...ctx,
        sessionId: "s-1",
      },
    );
    expect(out.text).toBe(
      "/selfbuilding/skills/code-review /selfbuilding/skills/code-review /selfbuilding/work /selfbuilding/work s-1",
    );
    expect(out.warnings).toEqual([]);
  });

  it("leaves unknown tokens and an unknown session id in place, with a warning", () => {
    const out = substitute("${NOPE} ${CLAUDE_SESSION_ID}", ctx);
    expect(out.text).toBe("${NOPE} ${CLAUDE_SESSION_ID}");
    expect(out.warnings).toHaveLength(2);
  });

  it("uses input.args for $ARGUMENTS and its tokens, else the JSON input", () => {
    expect(substitute("[$ARGUMENTS] [$ARGUMENTS[1]] [$0] [$5]", { ...ctx, input: { args: "a b  c" } }).text).toBe(
      "[a b  c] [b] [a] []",
    );
    expect(substitute("$ARGUMENTS", { ...ctx, input: { task: "t" } }).text).toBe('{"task":"t"}');
  });

  it("replaces declared $names only and stringifies non-strings", () => {
    const out = substitute("$file $count $HOME", {
      ...ctx,
      input: { file: "a.ts", count: 3 },
      declaredArgs: ["file", "count"],
    });
    expect(out.text).toBe("a.ts 3 $HOME");
  });

  it("makes one pass: inserted values are never scanned again", () => {
    const out = substitute("$ARGUMENTS", { ...ctx, input: { args: "${CLAUDE_SKILL_DIR} !`rm -rf /`" } });
    expect(out.text).toBe("${CLAUDE_SKILL_DIR} !`rm -rf /`");
  });
});

describe("context expressions", () => {
  const ctx = { skillName: "s" };

  it("finds expressions outside comments and fills path tokens in their commands", () => {
    const body = "A !`git log -1` B <!-- !`inert` --> C !`ls ${SELFBUILDING_SKILL_DIR}`";
    const found = findContextExpressions(body, ctx);
    expect(found.map((e) => e.cmd)).toEqual(["git log -1", "ls /selfbuilding/skills/s"]);
  });

  it("splices outputs in by position and trims trailing newlines", () => {
    const body = "x !`a` y !`a` z";
    const found = findContextExpressions(body, ctx);
    expect(applyContextOutputs(body, found, ["1\n", "2"])).toBe("x 1 y 2 z");
    expect(() => applyContextOutputs(body, found, ["1"])).toThrow(/expected 2/);
  });

  it("expands before it substitutes, and never runs an expression from input", () => {
    const skill = { name: "s", body: "!`echo hi` $ARGUMENTS", frontmatter: {} };
    const out = processBody(skill, { input: { args: "!`whoami`" }, contextOutputs: ["hi"] });
    expect(out.text).toBe("hi !`whoami`");
  });
});

describe("renderPreamble and renderUserPrompt", () => {
  it("states the submit contract, the schema, the checks and the ask policy", () => {
    const text = renderPreamble({
      resultSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      doneCommands: [{ id: "tests", cmd: "pnpm test" }],
      artifacts: { branch: "forbidden" },
      protectedPaths: ["package.json#scripts"],
      ask: { available: true, afkPolicy: "the safe default is taken" },
      harnessNotes: ["Subagents are unavailable; do the steps in sequence."],
      testCommandDeclared: true,
    });
    expect(text).toContain(PREAMBLE_VERSION);
    expect(text).toContain("submit_result tool exactly once");
    expect(text).toContain('"ok"');
    expect(text).toContain("`tests` runs `pnpm test`");
    expect(text).toContain("read-only task");
    expect(text).toContain("package.json#scripts");
    expect(text).toContain("the safe default is taken");
    expect(text).toContain("Subagents are unavailable");
    expect(text).not.toMatch(/write the JSON to a file/i);
  });

  it("renders the workspace from options and the input as JSON", () => {
    const text = renderUserPrompt({
      skillName: "code-review",
      body: "Body.",
      workspace: {
        repo: "github.com/a/b",
        baseBranch: "main",
        baseSha: "abc",
        branch: "feat",
        pr: { number: 4, url: "u" },
      },
      input: { target: { kind: "diff", base: "main" } },
    });
    expect(text).toMatch(/^# Skill: code-review\n\nBody\.\n\n# Workspace\n/);
    expect(text).toContain("- Base branch: main (abc)");
    expect(text).toContain("- Pull request: #4 u");
    expect(text).toContain('"kind": "diff"');
  });
});

describe("contractFingerprint", () => {
  it("reduces function checks to their id and ignores key order", () => {
    const a = contractFingerprint({
      outputJsonSchema: { b: 1, a: 2 },
      done: [{ id: "x", assert: () => true }],
      artifacts: { branch: () => "required" },
    });
    const b = contractFingerprint({
      outputJsonSchema: { a: 2, b: 1 },
      done: [{ id: "x", assert: () => "different code" }],
      artifacts: { branch: () => "forbidden" },
    });
    expect(a).toBe(b);
    expect(contractFingerprint({ done: [{ id: "y", cmd: "pnpm test" }] })).not.toBe(
      contractFingerprint({ done: [{ id: "y", cmd: "pnpm lint" }] }),
    );
  });
});
