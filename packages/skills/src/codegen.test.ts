import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, fixture, skillMd } from "../test/helpers.js";
import {
  buildSkills,
  checkSkills,
  checkSkillsModule,
  exportName,
  exportNames,
  GENERATED_HEADER,
  generateSkillsModule,
  jsonSchemaToTs,
  loadSkills,
  readGeneratedHashes,
} from "./index.js";

let fx: Fixture;
beforeEach(async () => {
  fx = await fixture();
});
afterEach(async () => {
  await fx.cleanup();
});

describe("export names", () => {
  it("converts kebab-case to PascalCase", () => {
    expect(exportName("improve-codebase-architecture")).toBe("ImproveCodebaseArchitecture");
    expect(exportName("code-review")).toBe("CodeReview");
  });

  it("rejects collisions and names that are not identifiers", () => {
    expect(() =>
      exportNames([
        { name: "a-1b", dir: "/x" },
        { name: "a1b", dir: "/y" },
      ]),
    ).toThrow(/both convert to "A1b"/);
    expect(() => exportNames([{ name: "1st", dir: "/x" }])).toThrow(/not a valid identifier/);
  });
});

describe("jsonSchemaToTs", () => {
  it("prints objects, arrays, enums, unions and optional keys", () => {
    const ts = jsonSchemaToTs({
      type: "object",
      required: ["status", "items"],
      properties: {
        status: { enum: ["done", "failed"] },
        items: { type: "array", items: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        "odd-key": { type: "boolean" },
        kind: { const: "x" },
      },
      additionalProperties: false,
    });
    expect(ts).toContain('status: "done" | "failed";');
    expect(ts).toContain("items: {\n");
    expect(ts).toContain("n: number;");
    expect(ts).toContain("note?: string | null;");
    expect(ts).toContain('"odd-key"?: boolean;');
    expect(ts).toContain('kind?: "x";');
    expect(jsonSchemaToTs({ type: ["string", "number"] })).toBe("string | number");
    expect(jsonSchemaToTs({ type: "object" })).toContain("[key: string]: unknown;");
    expect(jsonSchemaToTs(undefined)).toBe("unknown");
  });
});

describe("generateSkillsModule", () => {
  it("emits one agent per skill, importing sidecars and typing metadata contracts", async () => {
    await fx.skill(".agents/skills/code-review", {
      "SKILL.md": skillMd({ name: "code-review", description: "x" }),
      "selfbuilding.ts": "export default {};\n",
    });
    await fx.skill(".agents/skills/summarise", {
      "SKILL.md": skillMd(
        "name: summarise\ndescription: x\nmetadata:\n  selfbuilding-input: in.json\n  selfbuilding-output: out.json",
      ),
      "in.json": JSON.stringify({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
      "out.json": JSON.stringify({
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      }),
    });
    await fx.skill(".agents/skills/plain-skill", { "SKILL.md": skillMd({ name: "plain-skill", description: "x" }) });
    const reg = await loadSkills([{ root: ".agents/skills" }], { cwd: fx.root, importSidecar: false });
    const outFile = join(fx.root, "selfbuilding/skills.gen.ts");
    const source = generateSkillsModule(reg.list(), { outFile });

    expect(source.startsWith(GENERATED_HEADER)).toBe(true);
    expect(source).toContain('import { Agent } from "@selfbuilding/core";');
    expect(source).toContain('import codeReviewContract from "../.agents/skills/code-review/selfbuilding.ts";');
    expect(source).toContain(
      'export const CodeReview = await Agent.fromSkill(new URL("../.agents/skills/code-review/", import.meta.url), codeReviewContract);',
    );
    expect(source).toContain("export type SummariseInput = {\n  text: string;\n};");
    expect(source).toContain("export const Summarise = await Agent.fromSkill<SummariseInput, SummariseResult>(");
    expect(source).toContain(
      'export const PlainSkill = await Agent.fromSkill(new URL("../.agents/skills/plain-skill/"',
    );
    expect([...(readGeneratedHashes(source)?.keys() ?? [])]).toEqual(["code-review", "plain-skill", "summarise"]);
  });

  it("imports the inherited sidecar for an override with no contract", async () => {
    await fx.skill("project/code-review", { "SKILL.md": skillMd({ name: "code-review", description: "x" }) });
    const packDir = await fx.skill("pack/code-review", {
      "SKILL.md": skillMd({ name: "code-review", description: "x" }),
      "selfbuilding.ts": "export default {};\n",
    });
    const reg = await loadSkills([{ root: "project" }, { pack: { name: "p", dirs: [packDir] } }], {
      cwd: fx.root,
      importSidecar: false,
    });
    const source = generateSkillsModule(reg.list(), { outFile: join(fx.root, "gen/skills.gen.ts") });
    expect(source).toContain('import codeReviewContract from "../pack/code-review/selfbuilding.ts";');
    expect(source).toContain('new URL("../project/code-review/", import.meta.url), codeReviewContract');
  });
});

describe("build and check", () => {
  it("writes the module, reports it fresh, then stale after an edit, an addition and a removal", async () => {
    await fx.skill("skills/alpha", { "SKILL.md": skillMd({ name: "alpha", description: "x" }) });
    const opts = { sources: [{ root: "skills" }], cwd: fx.root, outFile: join(fx.root, "selfbuilding/skills.gen.ts") };

    expect(await checkSkills(opts)).toMatchObject({ stale: true, reasons: [expect.stringMatching(/does not exist/)] });
    const built = await buildSkills(opts);
    expect(await readFile(built.outFile, "utf8")).toBe(built.source);
    expect(await checkSkills(opts)).toEqual({ stale: false, reasons: [] });

    await fx.file("skills/alpha/SKILL.md", skillMd({ name: "alpha", description: "edited" }));
    await fx.skill("skills/beta", { "SKILL.md": skillMd({ name: "beta", description: "x" }) });
    expect((await checkSkills(opts)).reasons).toEqual(["skill alpha changed", "skill beta is new"]);

    await buildSkills(opts);
    const { rm } = await import("node:fs/promises");
    await rm(join(fx.root, "skills/beta"), { recursive: true });
    expect((await checkSkills(opts)).reasons).toEqual(["skill beta was removed"]);
  });

  it("treats a file without the hash header as stale", () => {
    expect(checkSkillsModule("export {};\n", [])).toMatchObject({ stale: true });
  });
});
