import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { skillDuplicate } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { loadSkillFolder, resolveSkillDir } from "./load.js";
import type { LoadOptions, SkillDef, SkillRegistry, SkillSource } from "./types.js";

/** How a source is named in shadowing messages: "project <path>" for folders, the pack name for packs. */
export function sourceLabel(source: SkillSource): string {
  if ("pack" in source) return source.pack.name;
  return `project ${"root" in source ? source.root : source.dir}`;
}

async function dirsOf(source: SkillSource, cwd: string | undefined): Promise<string[]> {
  if ("dir" in source) return [resolveSkillDir(source.dir, cwd)];
  if ("pack" in source) return source.pack.dirs.map((d) => resolveSkillDir(d, cwd));
  const root = resolveSkillDir(source.root, cwd);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(root, entry.name);
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(abs).catch(() => null))?.isDirectory());
    if (!isDir) continue;
    // A folder of skill folders may hold other things; only folders with a SKILL.md are skills.
    if (await stat(join(abs, "SKILL.md")).catch(() => null)) out.push(abs);
  }
  return out;
}

/**
 * Loads every skill from `sources`. Each entry is its own tier and earlier entries win (spec §2.10.3): list the
 * project sources first, then packs, then the default pack. Two skills with one name inside one entry throw
 * `skill_duplicate`. A winner with no contract of its own inherits the contract of the skill it shadows.
 */
export async function loadSkillRegistry(sources: SkillSource[], opts: LoadOptions = {}): Promise<SkillRegistry> {
  const byName = new Map<string, SkillDef>();
  const losers = new Map<string, SkillDef[]>();
  const shadowed: string[] = [];

  for (const source of sources) {
    const label = sourceLabel(source);
    const dirs = await dirsOf(source, opts.cwd);
    const tier = await Promise.all(dirs.map((d) => loadSkillFolder(d, opts)));

    const seen = new Map<string, SkillDef>();
    for (const def of tier) {
      const prior = seen.get(def.name);
      if (prior) throw skillDuplicate(def.name, [prior.dir, def.dir]);
      seen.set(def.name, def);
    }

    for (const def of tier) {
      def.source = label;
      const winner = byName.get(def.name);
      if (!winner) {
        byName.set(def.name, def);
        continue;
      }
      shadowed.push(`skill ${def.name}: ${winner.source} overrides ${label}`);
      const list = losers.get(def.name) ?? [];
      list.push(def);
      losers.set(def.name, list);
      if (winner.contract === "inferred" && def.contract !== "inferred") inherit(winner, def);
    }
  }

  const list = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    get: (name) => byName.get(name),
    list: () => [...list],
    shadowed,
    shadowedDefs: losers,
  };
}

function inherit(winner: SkillDef, from: SkillDef): void {
  const root = from.inheritedFrom ?? { dir: from.dir, source: from.source ?? "", contract: from.contract };
  winner.contract = "inherited";
  winner.inheritedFrom = root;
  if (from.sidecar !== undefined) winner.sidecar = from.sidecar;
  if (from.sidecarPath !== undefined) winner.sidecarPath = from.sidecarPath;
  if (from.jsonSchemas !== undefined) winner.jsonSchemas = from.jsonSchemas;
  // The inherited contract's bytes are part of what the winner runs with, so they move its hash.
  winner.hash = sha256Hex(`${winner.hash}\ninherits:${from.hash}`);
}
