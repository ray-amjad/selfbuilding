import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSkill, loadSkills } from "@selfbuilding/skills";
import { describe, expect, it } from "vitest";
import { codeReviewContract, findFlowsContract, implementSpecContract, verifyContract } from "./contracts.js";
import { defaultPack, SKILL_NAMES, skillDir } from "./pack.js";

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(abs)));
    else out.push(abs);
  }
  return out;
}

describe("the built-in skill folders", () => {
  it.each(SKILL_NAMES)("%s passes strict validation with no warnings", async (name) => {
    const def = await loadSkill(skillDir(name), { strict: true, importSidecar: false });
    expect(def.name).toBe(name);
    expect(def.contract).toBe("sidecar");
    expect(def.warnings).toEqual([]);
    expect(def.body.split("\n").length).toBeLessThan(500);
  });

  it("imports each sidecar to the same contract the agents use", async () => {
    const contracts = {
      "code-review": codeReviewContract,
      "find-flows": findFlowsContract,
      "implement-spec": implementSpecContract,
      verify: verifyContract,
    } as const;
    for (const name of SKILL_NAMES) {
      const def = await loadSkill(skillDir(name));
      const sidecar = def.sidecar as typeof codeReviewContract;
      // The sidecar resolves through the package's own export, so compare by shape, not identity.
      expect(Object.keys(sidecar).sort()).toEqual(Object.keys(contracts[name]).sort());
      expect(sidecar.done.map((c) => c.id)).toEqual(contracts[name].done.map((c) => c.id));
      expect(sidecar.artifacts).toEqual(contracts[name].artifacts);
    }
  });

  it("forms the default pack, loadable as one tier", async () => {
    expect(defaultPack.name).toBe("@selfbuilding/agents");
    const reg = await loadSkills([{ pack: defaultPack }], { importSidecar: false });
    expect(reg.list().map((s) => s.name)).toEqual(["code-review", "find-flows", "implement-spec", "verify"]);
    expect(reg.get("code-review")?.source).toBe("@selfbuilding/agents");
  });

  it("keeps the review tier prompts byte-for-byte below their rule", async () => {
    const expected = {
      medium: "c310f2eb23106cd04cc7822d6855ced8d88bb68b4c55bd931060f88f2c4f7c27",
      high: "94e40868d528d1804116e8388eb84cf04a6a2605030f40d238ee54bc187f9d79",
    };
    for (const tier of ["medium", "high"] as const) {
      const text = await readFile(join(skillDir("code-review"), "references", `${tier}.md`), "utf8");
      const body = text.slice(text.indexOf("\n---\n") + "\n---\n".length);
      expect(createHash("sha256").update(body).digest("hex")).toBe(expected[tier]);
    }
  });

  it("uses no substitution tokens by accident and names no internal tooling", async () => {
    // Bracketed letters let this guard match the names without spelling them out in the repo.
    const forbidden =
      /p[e]rcy|n[i]ghtshift|s[a]ndcastle|o[p]en inspect|d[r]eam-team|r[a]yamjad|\bn[o]va\b|\bm[i]ra\b|infisical|gpt-6-luna|\bluna\b|slack (post|upload)|inbox ask|CLAUDE_CODE_OAUTH_TOKEN_ACCOUNT|\/home\/user/i;
    for (const name of SKILL_NAMES) {
      const def = await loadSkill(skillDir(name), { importSidecar: false });
      expect(def.body).not.toMatch(/\$ARGUMENTS|\$\d\b|\$\{[A-Z_]+\}/);
      for (const file of await allFiles(skillDir(name))) {
        expect({ file, text: await readFile(file, "utf8") }).not.toEqual(
          expect.objectContaining({ text: expect.stringMatching(forbidden) }),
        );
      }
    }
  });
});
