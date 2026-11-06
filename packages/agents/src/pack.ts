import { fileURLToPath } from "node:url";
import type { SkillPack } from "@selfbuilding/skills";

/** The skill folders this package ships, by skill name. They live in the package's `skills/` folder. */
export const SKILL_NAMES = ["code-review", "find-flows", "implement-spec", "verify"] as const;
export type BuiltInSkillName = (typeof SKILL_NAMES)[number];

/** Absolute path of a built-in skill folder (from `src/` in development, `dist/` when installed). */
export function skillDir(name: BuiltInSkillName): string {
  return fileURLToPath(new URL(`../skills/${name}/`, import.meta.url)).replace(/\/$/, "");
}

/** The default pack (spec §2.10): included unless `skills.defaults: false`, and shadowed by project skills. */
export const defaultPack: SkillPack = {
  name: "@selfbuilding/agents",
  dirs: SKILL_NAMES.map(skillDir),
};
