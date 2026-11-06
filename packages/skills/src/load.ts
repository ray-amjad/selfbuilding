import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { skillInvalid } from "./errors.js";
import { isExecutable, LIMITS, looksBinary, SIDECAR_NAMES, type WalkedFile, walkSkillFolder } from "./files.js";
import { normaliseAllowedTools, splitFrontmatter } from "./frontmatter.js";
import { filesHash, skillHash } from "./hash.js";
import type { ContractSource, LoadOptions, SkillDef } from "./types.js";

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_DESCRIPTION = 1024;
const MAX_BODY_LINES = 500;
const MAX_BODY_TOKENS = 5000;

/** The keys the open skill format defines. Strict mode allows nothing else. */
export const SPEC_FRONTMATTER_KEYS: readonly string[] = [
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
];

/** Harness extensions that lenient mode keeps without a warning. */
export const KNOWN_EXTENSION_KEYS: readonly string[] = [
  "argument-hint",
  "arguments",
  "model",
  "effort",
  "disable-model-invocation",
  "user-invocable",
  "version",
  "context",
  "agent",
  "hooks",
  "when_to_use",
  "paths",
  "shell",
];

export const METADATA_INPUT_KEY = "selfbuilding-input";
export const METADATA_OUTPUT_KEY = "selfbuilding-output";
const FRONTMATTER_CONTRACT_KEY = "selfbuilding";

/** Resolves a folder argument: a file URL or an absolute path as is, a relative path against `opts.cwd` only. */
export function resolveSkillDir(dir: string | URL, cwd: string | undefined): string {
  if (dir instanceof URL || dir.startsWith("file:")) return fileURLToPath(dir);
  if (isAbsolute(dir)) return resolve(dir);
  if (cwd === undefined) {
    throw skillInvalid(dir, [
      `"${dir}" is a relative path and no cwd was given; pass an absolute path, a file URL, or LoadOptions.cwd`,
    ]);
  }
  return resolve(cwd, dir);
}

/** Loads and validates one skill folder (spec §2.2). */
export async function loadSkillFolder(dirArg: string | URL, opts: LoadOptions = {}): Promise<SkillDef> {
  const strict = opts.strict ?? false;
  const dir = resolveSkillDir(dirArg, opts.cwd);
  const errors: string[] = [];
  const warnings: string[] = [];
  const problem = (strictOnly: boolean, message: string) => {
    if (strictOnly && !strict) warnings.push(message);
    else errors.push(message);
  };

  const dirInfo = await stat(dir).catch(() => null);
  if (!dirInfo?.isDirectory()) throw skillInvalid(dir, ["not a directory"]);

  const walk = await walkSkillFolder(dir);
  errors.push(...walk.errors);

  const skillFile = walk.files.find((f) => f.path === "SKILL.md");
  if (!skillFile) throw skillInvalid(dir, ["SKILL.md is missing", ...errors]);

  const split = splitFrontmatter(new TextDecoder().decode(skillFile.bytes));
  if (!split.ok) throw skillInvalid(dir, [split.issue, ...errors]);
  const { frontmatter, body } = split;
  const folderName = basename(dir);

  // name
  const validName = (n: string) => n.length <= 64 && SKILL_NAME_PATTERN.test(n);
  let name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  if (!name) {
    errors.push("frontmatter `name` is required");
  } else if (!validName(name)) {
    errors.push(`name "${name}" must be 1 to 64 characters of lowercase letters, digits and single hyphens`);
  } else if (name !== folderName) {
    problem(true, `name "${name}" does not match the folder name "${folderName}"; the folder name is used`);
    name = folderName;
    if (!validName(folderName)) errors.push(`folder name "${folderName}" is not a valid skill name`);
  }

  // description
  let description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!description) errors.push("frontmatter `description` is required and must be a non-empty string");
  else if (description.length > MAX_DESCRIPTION) {
    problem(
      true,
      `description is ${description.length} characters; the limit is ${MAX_DESCRIPTION}, so it is truncated`,
    );
    description = description.slice(0, MAX_DESCRIPTION);
  }

  // unknown keys
  const unexpected = Object.keys(frontmatter).filter(
    (k) => !SPEC_FRONTMATTER_KEYS.includes(k) && k !== FRONTMATTER_CONTRACT_KEY,
  );
  if (strict && unexpected.length > 0) {
    errors.push(
      `Unexpected fields in frontmatter: ${unexpected.join(", ")}. Only ${SPEC_FRONTMATTER_KEYS.join(", ")} are allowed.`,
    );
  } else {
    const unknown = unexpected.filter((k) => !KNOWN_EXTENSION_KEYS.includes(k));
    if (unknown.length > 0) warnings.push(`Unexpected fields in frontmatter: ${unknown.join(", ")} (kept)`);
  }

  // metadata
  const metadata = frontmatter.metadata;
  if (metadata !== undefined && metadata !== null) {
    if (typeof metadata !== "object" || Array.isArray(metadata)) problem(false, "`metadata` must be a mapping");
    else {
      const nonString = Object.entries(metadata).filter(([, v]) => typeof v !== "string");
      if (nonString.length > 0) {
        problem(true, `metadata values must be strings: ${nonString.map(([k]) => k).join(", ")}`);
      }
    }
  }

  // body size
  const bodyLines = body.split("\n").length;
  const approxTokens = Math.ceil(body.length / 4);
  if (bodyLines > MAX_BODY_LINES || approxTokens > MAX_BODY_TOKENS) {
    warnings.push(
      `SKILL.md body is ${bodyLines} lines (~${approxTokens} tokens); keep it under ${MAX_BODY_LINES} lines and ~${MAX_BODY_TOKENS} tokens and move detail into references/`,
    );
  }

  // files
  const sidecarFile = SIDECAR_NAMES.map((n) => walk.files.find((f) => f.path === n)).find((f) => f !== undefined);
  const files = walk.files.filter((f) => f !== sidecarFile);
  checkFiles(walk.files, errors, problem, warnings);

  // contract source
  let contract: ContractSource = "inferred";
  let sidecar: unknown;
  let jsonSchemas: SkillDef["jsonSchemas"];
  const meta = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
  const hasMetadataContract = meta[METADATA_INPUT_KEY] !== undefined || meta[METADATA_OUTPUT_KEY] !== undefined;

  if (sidecarFile) {
    contract = "sidecar";
    if (opts.importSidecar ?? true) {
      const imported = await importSidecar(sidecarFile.abs);
      if (imported.kind === "ok") sidecar = imported.value;
      else if (imported.kind === "unsupported") warnings.push(imported.message);
      else errors.push(imported.message);
    }
  } else if (hasMetadataContract) {
    contract = "metadata";
    jsonSchemas = {};
    for (const [key, slot] of [
      [METADATA_INPUT_KEY, "input"],
      [METADATA_OUTPUT_KEY, "output"],
    ] as const) {
      const pointer = meta[key];
      if (pointer === undefined) continue;
      if (typeof pointer !== "string") {
        errors.push(`metadata.${key} must be a path to a JSON Schema file`);
        continue;
      }
      const target = files.find((f) => f.path === pointer.replace(/^\.\//, ""));
      if (!target) {
        errors.push(`metadata.${key} points at "${pointer}", which is not a file in the skill folder`);
        continue;
      }
      try {
        jsonSchemas[slot] = JSON.parse(new TextDecoder().decode(target.bytes));
      } catch (e) {
        errors.push(`metadata.${key} "${pointer}" is not valid JSON: ${(e as Error).message}`);
      }
    }
  } else if (frontmatter[FRONTMATTER_CONTRACT_KEY] !== undefined) {
    contract = "frontmatter";
    problem(
      true,
      "the top-level `selfbuilding:` frontmatter key is read for compatibility only and fails strict validation; move the contract to a selfbuilding.ts sidecar",
    );
  }

  if (errors.length > 0) throw skillInvalid(dir, errors);

  const hashed = walk.files.map((f) => ({ path: f.path, mode: f.mode, sha256: f.sha256 }));
  const def: SkillDef = {
    name,
    description,
    body,
    dir,
    files: files.map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 })),
    frontmatter,
    allowedTools: normaliseAllowedTools(frontmatter["allowed-tools"]),
    contract,
    hash: skillHash({ files: hashed, contractFingerprint: opts.contractFingerprint ?? "" }),
    contentHash: filesHash(hashed),
    warnings,
  };
  if (sidecarFile) def.sidecarPath = sidecarFile.abs;
  if (sidecar !== undefined) def.sidecar = sidecar;
  if (jsonSchemas !== undefined) def.jsonSchemas = jsonSchemas;
  return def;
}

function checkFiles(
  all: readonly WalkedFile[],
  errors: string[],
  problem: (strictOnly: boolean, message: string) => void,
  warnings: string[],
): void {
  if (all.length > LIMITS.maxFiles) {
    errors.push(`the folder holds ${all.length} files; the limit is ${LIMITS.maxFiles}`);
  }
  let total = 0;
  for (const f of all) {
    total += f.size;
    if (f.size > LIMITS.maxFileBytes) errors.push(`${f.path} is ${f.size} bytes; the per-file limit is 1 MiB`);
    if (isExecutable(f.mode) && !f.path.startsWith("scripts/")) {
      problem(true, `${f.path} is executable but outside scripts/`);
    }
    if (!f.path.startsWith("assets/") && looksBinary(f.bytes)) {
      warnings.push(`${f.path} looks binary but is outside assets/`);
    }
  }
  if (total > LIMITS.maxTotalBytes) errors.push(`the folder holds ${total} bytes; the limit is 8 MiB`);
}

type SidecarImport =
  | { kind: "ok"; value: unknown }
  | { kind: "unsupported"; message: string }
  | { kind: "failed"; message: string };

/** The sidecar runs with the user's trust: they import it into their own program anyway (spec §2.2.3). */
async function importSidecar(abs: string): Promise<SidecarImport> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ERR_UNKNOWN_FILE_EXTENSION" || code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING") {
      return {
        kind: "unsupported",
        message: `${basename(abs)} was not imported because this runtime cannot load TypeScript; pass the contract to Agent.fromSkill or import the sidecar yourself`,
      };
    }
    return { kind: "failed", message: `${basename(abs)} failed to load: ${(e as Error).message}` };
  }
  if (mod.default === undefined) {
    return { kind: "failed", message: `${basename(abs)} has no default export; export default defineContract({...})` };
  }
  return { kind: "ok", value: mod.default };
}
