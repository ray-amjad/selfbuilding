import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture, skillMd } from "../test/helpers.js";
import { isSkillError, loadSkill, loadSkills, normaliseAllowedTools, splitFrontmatter } from "./index.js";

let fx: Fixture;
beforeEach(async () => {
  fx = await fixture();
});
afterEach(async () => {
  await fx.cleanup();
});

async function expectInvalid(p: Promise<unknown>, pattern: RegExp) {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect(isSkillError(error)).toBe(true);
  expect((error as { code: string }).code).toBe("skill_invalid");
  expect((error as { issues: string[] }).issues.join("\n")).toMatch(pattern);
}

describe("loadSkill", () => {
  it("loads a valid folder with its body, files, frontmatter and hash", async () => {
    const dir = await fx.skill("code-review", {
      "SKILL.md": skillMd(
        { name: "code-review", description: "Reviews code.", license: "MIT" },
        "# Review\nRead the diff.\n",
      ),
      "references/high.md": "high tier\n",
    });
    const def = await loadSkill(dir);
    expect(def.name).toBe("code-review");
    expect(def.description).toBe("Reviews code.");
    expect(def.body).toBe("# Review\nRead the diff.\n");
    expect(def.dir).toBe(dir);
    expect(def.files.map((f) => f.path)).toEqual(["SKILL.md", "references/high.md"]);
    expect(def.files[1]).toMatchObject({ size: 10, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(def.frontmatter.license).toBe("MIT");
    expect(def.contract).toBe("inferred");
    expect(def.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(def.warnings).toEqual([]);
  });

  it("accepts a file URL and resolves relative paths only against cwd", async () => {
    const dir = await fx.skill("alpha", { "SKILL.md": skillMd({ name: "alpha", description: "A." }) });
    expect((await loadSkill(pathToFileURL(dir))).name).toBe("alpha");
    expect((await loadSkill("alpha", { cwd: fx.root })).dir).toBe(dir);
    await expectInvalid(loadSkill("alpha"), /relative path and no cwd/);
  });

  it("rejects a folder with no SKILL.md, or with no frontmatter", async () => {
    const dir = await fx.skill("empty", { "README.md": "hi" });
    await expectInvalid(loadSkill(dir), /SKILL.md is missing/);
    const noFront = await fx.skill("nofront", { "SKILL.md": "# just a body\n" });
    await expectInvalid(loadSkill(noFront), /YAML frontmatter/);
  });

  it("validates the name pattern and length in both modes", async () => {
    const bad = await fx.skill("Bad_Name", { "SKILL.md": skillMd({ name: "Bad_Name", description: "x" }) });
    await expectInvalid(loadSkill(bad), /lowercase letters/);
    const long = "a".repeat(65);
    const tooLong = await fx.skill(long, { "SKILL.md": skillMd({ name: long, description: "x" }) });
    await expectInvalid(loadSkill(tooLong), /1 to 64/);
    const missing = await fx.skill("noname", { "SKILL.md": skillMd({ description: "x" }) });
    await expectInvalid(loadSkill(missing), /`name` is required/);
  });

  it("lets the folder name win over a mismatched name in lenient mode and fails in strict mode", async () => {
    const dir = await fx.skill("folder-name", { "SKILL.md": skillMd({ name: "other-name", description: "x" }) });
    const def = await loadSkill(dir);
    expect(def.name).toBe("folder-name");
    expect(def.warnings.join()).toMatch(/does not match the folder name/);
    await expectInvalid(loadSkill(dir, { strict: true }), /does not match the folder name/);
  });

  it("requires a description and truncates an overlong one in lenient mode", async () => {
    const empty = await fx.skill("nodesc", { "SKILL.md": skillMd({ name: "nodesc", description: "" }) });
    await expectInvalid(loadSkill(empty), /description/);
    const long = await fx.skill("longdesc", {
      "SKILL.md": skillMd({ name: "longdesc", description: "d".repeat(1100) }),
    });
    const def = await loadSkill(long);
    expect(def.description).toHaveLength(1024);
    expect(def.warnings.join()).toMatch(/truncated/);
    await expectInvalid(loadSkill(long, { strict: true }), /limit is 1024/);
  });

  it("keeps unknown keys, stays quiet about known harness extensions, and fails strict mode", async () => {
    const dir = await fx.skill("ext", {
      "SKILL.md": skillMd({ name: "ext", description: "x", "argument-hint": "[file]", model: "m", custom: 1 }),
    });
    const def = await loadSkill(dir);
    expect(def.frontmatter.custom).toBe(1);
    expect(def.warnings).toEqual(["Unexpected fields in frontmatter: custom (kept)"]);
    await expectInvalid(
      loadSkill(dir, { strict: true }),
      /Unexpected fields in frontmatter: argument-hint, model, custom/,
    );
  });

  it("warns about non-string metadata values in lenient mode and fails strict mode", async () => {
    const dir = await fx.skill("meta", {
      "SKILL.md": skillMd("name: meta\ndescription: x\nmetadata:\n  owner: team\n  priority: 3"),
    });
    expect((await loadSkill(dir)).warnings.join()).toMatch(/metadata values must be strings: priority/);
    await expectInvalid(loadSkill(dir, { strict: true }), /metadata values must be strings/);
  });

  it("warns when the body is too long", async () => {
    const body = Array.from({ length: 520 }, (_, i) => `line ${i}`).join("\n");
    const dir = await fx.skill("big", { "SKILL.md": skillMd({ name: "big", description: "x" }, body) });
    expect((await loadSkill(dir)).warnings.join()).toMatch(/under 500 lines/);
  });

  it("normalises allowed-tools from a list, a comma string and a space string", async () => {
    const list = await fx.skill("t1", {
      "SKILL.md": skillMd("name: t1\ndescription: x\nallowed-tools:\n  - Read\n  - Bash(git diff:*)"),
    });
    const comma = await fx.skill("t2", {
      "SKILL.md": skillMd({ name: "t2", description: "x", "allowed-tools": "Read, Bash(git diff:*)" }),
    });
    const space = await fx.skill("t3", {
      "SKILL.md": skillMd({ name: "t3", description: "x", "allowed-tools": "Read Bash(git diff:*)" }),
    });
    for (const dir of [list, comma, space]) {
      expect((await loadSkill(dir)).allowedTools).toEqual(["Read", "Bash(git diff:*)"]);
    }
    expect(normaliseAllowedTools(undefined)).toEqual([]);
  });

  it("rejects a symlink that resolves outside the folder and follows one inside it", async () => {
    const outside = await fx.file("secret.txt", "nope");
    const dir = await fx.skill("linky", { "SKILL.md": skillMd({ name: "linky", description: "x" }), "real.md": "r" });
    await fx.link("linky/inside.md", join(dir, "real.md"));
    const def = await loadSkill(dir);
    expect(def.files.map((f) => f.path)).toContain("inside.md");
    await fx.link("linky/escape.md", outside);
    await expectInvalid(loadSkill(dir), /escape.md: symlink resolves outside/);
  });

  it("treats an executable outside scripts/ as a warning in lenient mode and an error in strict mode", async () => {
    const dir = await fx.skill("exec", { "SKILL.md": skillMd({ name: "exec", description: "x" }) });
    await fx.file("exec/scripts/run.sh", "#!/bin/sh\n", 0o755);
    expect((await loadSkill(dir)).warnings).toEqual([]);
    await fx.file("exec/run.sh", "#!/bin/sh\n", 0o755);
    expect((await loadSkill(dir)).warnings.join()).toMatch(/run.sh is executable but outside scripts/);
    await expectInvalid(loadSkill(dir, { strict: true }), /outside scripts/);
  });

  it("enforces the file count and size limits in both modes", async () => {
    const dir = await fx.skill("huge", { "SKILL.md": skillMd({ name: "huge", description: "x" }) });
    await fx.file("huge/big.txt", "x".repeat(1024 * 1024 + 1));
    await expectInvalid(loadSkill(dir), /per-file limit is 1 MiB/);

    const many = await fx.skill("many", { "SKILL.md": skillMd({ name: "many", description: "x" }) });
    for (let i = 0; i < 200; i++) await fx.file(`many/f/${i}.txt`, "x");
    await expectInvalid(loadSkill(many), /limit is 200/);

    const total = await fx.skill("total", { "SKILL.md": skillMd({ name: "total", description: "x" }) });
    for (let i = 0; i < 9; i++) await fx.file(`total/f${i}.txt`, "x".repeat(1000 * 1000));
    await expectInvalid(loadSkill(total), /limit is 8 MiB/);
  });

  it("warns about binary files outside assets/", async () => {
    const dir = await fx.skill("bin", { "SKILL.md": skillMd({ name: "bin", description: "x" }) });
    await fx.file("bin/assets/logo.png", new Uint8Array([0x89, 0, 1, 2]));
    expect((await loadSkill(dir)).warnings).toEqual([]);
    await fx.file("bin/blob.dat", new Uint8Array([1, 0, 2]));
    expect((await loadSkill(dir)).warnings.join()).toMatch(/blob.dat looks binary/);
  });

  it("finds a sidecar, imports its default export, and keeps it out of files", async () => {
    const dir = await fx.skill("with-sidecar", {
      "SKILL.md": skillMd({ name: "with-sidecar", description: "x" }),
      "selfbuilding.mjs": "export default { marker: 42 };\n",
    });
    const def = await loadSkill(dir);
    expect(def.contract).toBe("sidecar");
    expect(def.sidecar).toEqual({ marker: 42 });
    expect(def.sidecarPath).toBe(join(dir, "selfbuilding.mjs"));
    expect(def.files.map((f) => f.path)).toEqual(["SKILL.md"]);

    const skipped = await loadSkill(dir, { importSidecar: false });
    expect(skipped.contract).toBe("sidecar");
    expect(skipped.sidecar).toBeUndefined();
  });

  it("fails on a sidecar with no default export or one that throws", async () => {
    const noDefault = await fx.skill("nodefault", {
      "SKILL.md": skillMd({ name: "nodefault", description: "x" }),
      "selfbuilding.mjs": "export const x = 1;\n",
    });
    await expectInvalid(loadSkill(noDefault), /no default export/);
    const throws = await fx.skill("throws", {
      "SKILL.md": skillMd({ name: "throws", description: "x" }),
      "selfbuilding.mjs": "throw new Error('boom');\n",
    });
    await expectInvalid(loadSkill(throws), /failed to load: boom/);
  });

  it("changes the hash when the sidecar changes, even though it is not in files", async () => {
    const dir = await fx.skill("hashy", {
      "SKILL.md": skillMd({ name: "hashy", description: "x" }),
      "selfbuilding.mjs": "export default { v: 1 };\n",
    });
    const a = await loadSkill(dir, { importSidecar: false });
    await fx.file("hashy/selfbuilding.mjs", "export default { v: 2 };\n");
    const b = await loadSkill(dir, { importSidecar: false });
    expect(a.hash).not.toBe(b.hash);
    expect(a.files).toEqual(b.files);
  });

  it("folds the contract fingerprint into the hash and is stable across loads", async () => {
    const dir = await fx.skill("stable", { "SKILL.md": skillMd({ name: "stable", description: "x" }) });
    const a = await loadSkill(dir);
    const b = await loadSkill(dir);
    const c = await loadSkill(dir, { contractFingerprint: "abc" });
    expect(a.hash).toBe(b.hash);
    expect(c.hash).not.toBe(a.hash);
    expect(c.contentHash).toBe(a.contentHash);
  });

  it("reads metadata pointers to JSON Schema files", async () => {
    const dir = await fx.skill("meta-contract", {
      "SKILL.md": skillMd(
        "name: meta-contract\ndescription: x\nmetadata:\n  selfbuilding-input: schema/input.json\n  selfbuilding-output: schema/output.json",
      ),
      "schema/input.json": JSON.stringify({ type: "object", properties: { q: { type: "string" } } }),
      "schema/output.json": JSON.stringify({ type: "object", properties: { a: { type: "number" } } }),
    });
    const def = await loadSkill(dir);
    expect(def.contract).toBe("metadata");
    expect(def.jsonSchemas?.input).toMatchObject({ properties: { q: { type: "string" } } });
    expect(def.jsonSchemas?.output).toMatchObject({ properties: { a: { type: "number" } } });
  });

  it("rejects metadata pointers to missing or malformed files", async () => {
    const missing = await fx.skill("meta-missing", {
      "SKILL.md": skillMd("name: meta-missing\ndescription: x\nmetadata:\n  selfbuilding-output: nope.json"),
    });
    await expectInvalid(loadSkill(missing), /not a file in the skill folder/);
    const malformed = await fx.skill("meta-bad", {
      "SKILL.md": skillMd("name: meta-bad\ndescription: x\nmetadata:\n  selfbuilding-output: out.json"),
      "out.json": "{not json",
    });
    await expectInvalid(loadSkill(malformed), /not valid JSON/);
  });

  it("reads a top-level selfbuilding key with a warning, and fails it in strict mode", async () => {
    const dir = await fx.skill("legacy", {
      "SKILL.md": skillMd("name: legacy\ndescription: x\nselfbuilding:\n  output: {}"),
    });
    const def = await loadSkill(dir);
    expect(def.contract).toBe("frontmatter");
    expect(def.warnings.join()).toMatch(/compatibility only/);
    await expectInvalid(loadSkill(dir, { strict: true }), /compatibility only/);
  });

  it("collects every problem in one error", async () => {
    const dir = await fx.skill("Many_Problems", { "SKILL.md": skillMd({ name: "Many_Problems", description: "" }) });
    const error = await loadSkill(dir).catch((e: { issues: string[] }) => e);
    expect((error as { issues: string[] }).issues).toHaveLength(2);
  });
});

describe("splitFrontmatter", () => {
  it("rejects YAML that is not a mapping and malformed YAML", () => {
    expect(splitFrontmatter("---\n- a\n---\nbody")).toMatchObject({ ok: false, issue: /mapping/ });
    expect(splitFrontmatter("---\na: [\n---\nbody")).toMatchObject({ ok: false });
    expect(splitFrontmatter("﻿---\nname: x\n---\nbody")).toMatchObject({ ok: true, body: "body" });
  });
});

describe("loadSkills", () => {
  it("loads every skill folder under a root, skipping folders without SKILL.md", async () => {
    await fx.skill("project/a-skill", { "SKILL.md": skillMd({ name: "a-skill", description: "x" }) });
    await fx.skill("project/b-skill", { "SKILL.md": skillMd({ name: "b-skill", description: "x" }) });
    await fx.file("project/notes/README.md", "not a skill");
    const reg = await loadSkills([{ root: "project" }], { cwd: fx.root });
    expect(reg.list().map((s) => s.name)).toEqual(["a-skill", "b-skill"]);
    expect(reg.get("a-skill")?.source).toBe("project project");
    expect(reg.shadowed).toEqual([]);
  });

  it("treats a missing root as empty", async () => {
    const reg = await loadSkills([{ root: join(fx.root, "nope") }]);
    expect(reg.list()).toEqual([]);
  });

  it("throws skill_duplicate for one name twice inside one tier", async () => {
    const a = await fx.skill("one/same", { "SKILL.md": skillMd({ name: "same", description: "x" }) });
    const b = await fx.skill("two/same", { "SKILL.md": skillMd({ name: "same", description: "x" }) });
    const error = await loadSkills([{ pack: { name: "pk", dirs: [a, b] } }]).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "skill_duplicate", skill: "same", dirs: [a, b] });
  });

  it("lets earlier sources win, records every shadowing, and inherits the shadowed contract", async () => {
    await fx.skill(".agents/skills/code-review", {
      "SKILL.md": skillMd({ name: "code-review", description: "Project review prompt." }),
    });
    const packDir = await fx.skill("pack/code-review", {
      "SKILL.md": skillMd({ name: "code-review", description: "Pack review." }),
      "selfbuilding.mjs": "export default { contract: 'pack' };\n",
    });
    const pack = { name: "@selfbuilding/agents", dirs: [packDir] };
    const reg = await loadSkills([{ root: ".agents/skills" }, { pack }], { cwd: fx.root });
    const winner = reg.get("code-review");
    expect(winner?.description).toBe("Project review prompt.");
    expect(winner?.contract).toBe("inherited");
    expect(winner?.sidecar).toEqual({ contract: "pack" });
    expect(winner?.inheritedFrom).toEqual({ dir: packDir, source: "@selfbuilding/agents", contract: "sidecar" });
    expect(reg.shadowed).toEqual(["skill code-review: project .agents/skills overrides @selfbuilding/agents"]);
    expect(reg.shadowedDefs?.get("code-review")?.[0]?.dir).toBe(packDir);

    const alone = await loadSkills([{ root: ".agents/skills" }], { cwd: fx.root });
    expect(alone.get("code-review")?.hash).not.toBe(winner?.hash);
  });

  it("keeps a winner's own contract when it has one", async () => {
    const mine = await fx.skill("mine/review", {
      "SKILL.md": skillMd({ name: "review", description: "x" }),
      "selfbuilding.mjs": "export default { mine: true };\n",
    });
    const theirs = await fx.skill("theirs/review", {
      "SKILL.md": skillMd({ name: "review", description: "x" }),
      "selfbuilding.mjs": "export default { mine: false };\n",
    });
    const reg = await loadSkills([{ dir: mine }, { dir: theirs }]);
    expect(reg.get("review")?.contract).toBe("sidecar");
    expect(reg.get("review")?.sidecar).toEqual({ mine: true });
  });

  it("propagates skill_invalid from any folder", async () => {
    const bad = await fx.skill("bad", { "SKILL.md": skillMd({ name: "bad", description: "" }) });
    await expect(loadSkills([{ dir: bad }])).rejects.toMatchObject({ code: "skill_invalid" });
  });
});
