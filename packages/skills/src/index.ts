import { loadSkillFolder } from "./load.js";
import { loadSkillRegistry } from "./registry.js";
import type { LoadOptions, SkillDef, SkillRegistry, SkillSource } from "./types.js";

export {
  type BuildSkillsOptions,
  buildSkills,
  checkSkills,
  checkSkillsModule,
  exportName,
  exportNames,
  GENERATED_HEADER,
  type GenerateOptions,
  generateSkillsModule,
  jsonSchemaToTs,
  readGeneratedHashes,
} from "./codegen.js";
export {
  isSkillError,
  type SkillDuplicateError,
  type SkillErrorCode,
  type SkillInvalidError,
} from "./errors.js";
export { LIMITS, SIDECAR_NAMES } from "./files.js";
export { declaredArguments, normaliseAllowedTools, splitFrontmatter } from "./frontmatter.js";
export {
  canonicalJson,
  contractFingerprint,
  type FingerprintParts,
  filesHash,
  PREAMBLE_VERSION,
  sha256Hex,
  skillHash,
} from "./hash.js";
export {
  KNOWN_EXTENSION_KEYS,
  METADATA_INPUT_KEY,
  METADATA_OUTPUT_KEY,
  SKILL_NAME_PATTERN,
  SPEC_FRONTMATTER_KEYS,
} from "./load.js";
export {
  applyContextOutputs,
  type ContextExpression,
  findContextExpressions,
  type PreambleOptions,
  processBody,
  renderPreamble,
  renderUserPrompt,
  SANDBOX_SKILLS_DIR,
  SANDBOX_WORKDIR,
  type SubstitutionContext,
  substitute,
  type WorkspaceFacts,
} from "./prompt.js";
export { sourceLabel } from "./registry.js";
export type {
  ContractSource,
  LoadOptions,
  SkillDef,
  SkillFile,
  SkillPack,
  SkillRegistry,
  SkillSource,
} from "./types.js";

/**
 * Loads and validates one skill folder (spec §2.2). `dir` is an absolute path, a file URL, or a path relative to
 * `opts.cwd`. Failures throw an Error with `code: "skill_invalid"`; core rethrows it as SkillLoadError.
 */
export async function loadSkill(dir: string | URL, opts?: LoadOptions): Promise<SkillDef> {
  return loadSkillFolder(dir, opts);
}

/**
 * Loads every skill from the given sources, applying the tier precedence of spec §2.10.3: each entry is a tier and
 * earlier entries win. A duplicate name inside one entry throws with `code: "skill_duplicate"`.
 */
export async function loadSkills(sources: SkillSource[], opts?: LoadOptions): Promise<SkillRegistry> {
  return loadSkillRegistry(sources, opts);
}
