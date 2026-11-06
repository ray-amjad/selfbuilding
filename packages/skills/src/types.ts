/** Where skills are loaded from. Sources are explicit; nothing is scanned implicitly. */
export type SkillSource =
  | { dir: string } // one skill folder
  | { root: string } // a folder of skill folders, e.g. ".agents/skills"
  | { pack: SkillPack }; // an npm package export, e.g. the built-in pack from @selfbuilding/agents

/** A named set of skill folders shipped by a package. */
export interface SkillPack {
  readonly name: string;
  /** Absolute paths of the skill folders in the pack. */
  readonly dirs: readonly string[];
}

export interface LoadOptions {
  /** Default false (lenient). */
  strict?: boolean;
  /** Relative paths resolve against this, never against process.cwd() implicitly. */
  cwd?: string;
  /**
   * Import the `selfbuilding.ts` sidecar to fill `SkillDef.sidecar`. Default true. A runtime that cannot load
   * TypeScript leaves `sidecar` unset with a warning; callers that pass the contract in code can skip it.
   */
  importSidecar?: boolean;
  /** The contract fingerprint (spec §2.2.4) folded into `hash`. Default "" (core recomputes it with `skillHash`). */
  contractFingerprint?: string;
}

export type ContractSource = "sidecar" | "metadata" | "frontmatter" | "inferred" | "inherited";

export interface SkillFile {
  /** Path relative to the skill folder, POSIX separators. */
  path: string;
  mode: number;
  size: number;
  sha256: string;
}

export interface SkillDef {
  /** kebab-case, equals the folder name. */
  name: string;
  description: string;
  /** SKILL.md body with the frontmatter stripped, unprocessed. */
  body: string;
  /** Absolute path on the host. */
  dir: string;
  /** Every file except the sidecar. */
  files: SkillFile[];
  /** Raw frontmatter, including unknown keys. */
  frontmatter: Record<string, unknown>;
  /** Normalised from a YAML list, a comma-separated or a space-separated string. */
  allowedTools: string[];
  contract: ContractSource;
  /** sha256 over the preamble version, the files and the contract fingerprint (spec §2.2.4). */
  hash: string;
  warnings: string[];
  /** The sidecar module's default export when contract is "sidecar"; opaque to this package. */
  sidecar?: unknown;
  /** Absolute path of the sidecar file, when the folder has one (or inherits one). */
  sidecarPath?: string;
  /** JSON Schemas named by `metadata` pointers (contract "metadata"), parsed. */
  jsonSchemas?: { input?: unknown; output?: unknown };
  /** sha256 over the files and the sidecar bytes only: `hash` without the preamble version or fingerprint. */
  contentHash?: string;
  /** Set by `loadSkills` when the skill takes its contract from the skill it shadows (spec §2.10.4). */
  inheritedFrom?: { dir: string; source: string; contract: ContractSource };
  /** The label of the source this skill came from, e.g. "project .agents/skills" or "@selfbuilding/agents". */
  source?: string;
}

/** Loaded skills by name, with the tier each one came from. */
export interface SkillRegistry {
  get(name: string): SkillDef | undefined;
  list(): SkillDef[];
  /** One entry per shadowed skill, e.g. "skill code-review: project .agents/skills overrides @selfbuilding/agents". */
  readonly shadowed: readonly string[];
  /** Every skill a winner shadowed, by name, highest tier first. */
  readonly shadowedDefs?: ReadonlyMap<string, readonly SkillDef[]>;
}
