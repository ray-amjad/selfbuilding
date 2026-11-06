// This package does not depend on core (core depends on it), so it throws plain Errors with a `code`.
// Core rethrows `skill_invalid` as SkillLoadError and `skill_duplicate` as DuplicateSkillError (BUILD-MAP §2).

export type SkillErrorCode = "skill_invalid" | "skill_duplicate";

export interface SkillInvalidError extends Error {
  readonly code: "skill_invalid";
  readonly dir: string;
  readonly issues: string[];
}

export interface SkillDuplicateError extends Error {
  readonly code: "skill_duplicate";
  readonly skill: string;
  readonly dirs: string[];
}

export function skillInvalid(dir: string, issues: string[], cause?: unknown): SkillInvalidError {
  const error = new Error(`Skill folder ${dir} is invalid:\n- ${issues.join("\n- ")}`, { cause }) as Error & {
    code: "skill_invalid";
    dir: string;
    issues: string[];
  };
  error.name = "SkillInvalidError";
  error.code = "skill_invalid";
  error.dir = dir;
  error.issues = issues;
  return error;
}

export function skillDuplicate(skill: string, dirs: string[]): SkillDuplicateError {
  const error = new Error(
    `Skill "${skill}" appears more than once in one source tier: ${dirs.join(", ")}. Rename or remove one.`,
  ) as Error & { code: "skill_duplicate"; skill: string; dirs: string[] };
  error.name = "SkillDuplicateError";
  error.code = "skill_duplicate";
  error.skill = skill;
  error.dirs = dirs;
  return error;
}

export function isSkillError(e: unknown): e is SkillInvalidError | SkillDuplicateError {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return code === "skill_invalid" || code === "skill_duplicate";
}
