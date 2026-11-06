import fs from "node:fs";
import path from "node:path";
import type { Git } from "./git.js";

// Protected paths (spec §2.7.4): while done checks run, the base version of each protected path the change touched
// is put in place, then the head version is put back. package.json keeps every key but the test-runner ones, and
// pyproject.toml / setup.cfg keep every table but the pytest ones, so dependency changes still count.

const PACKAGE_JSON_KEYS = ["scripts", "jest", "vitest", "mocha", "ava"];
const TABLE_RULES: Record<string, RegExp> = {
  "pyproject.toml": /^tool\.pytest/,
  "setup.cfg": /^tool:pytest/,
};

/** A glob relative to the repo root: `**` spans directories, `*` and `?` stay within one segment. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

function restoreKind(file: string): "keys" | "tables" | "whole-file" {
  const base = path.posix.basename(file);
  if (base === "package.json") return "keys";
  if (base in TABLE_RULES && !file.includes("/")) return "tables";
  return "whole-file";
}

function mergePackageJson(head: string, base: string | undefined): string {
  let headJson: Record<string, unknown>;
  try {
    headJson = JSON.parse(head) as Record<string, unknown>;
  } catch {
    return base ?? head;
  }
  let baseJson: Record<string, unknown> = {};
  try {
    if (base !== undefined) baseJson = JSON.parse(base) as Record<string, unknown>;
  } catch {
    baseJson = {};
  }
  for (const key of PACKAGE_JSON_KEYS) {
    if (key in baseJson) headJson[key] = baseJson[key];
    else delete headJson[key];
  }
  return `${JSON.stringify(headJson, null, 2)}\n`;
}

function splitTables(text: string): { name: string; body: string }[] {
  const sections: { name: string; body: string }[] = [{ name: "", body: "" }];
  for (const line of text.split(/(?<=\n)/)) {
    const header = /^\s*\[{1,2}([^\]]+)\]{1,2}\s*$/.exec(line);
    if (header) sections.push({ name: (header[1] as string).trim(), body: line });
    else (sections[sections.length - 1] as { body: string }).body += line;
  }
  return sections;
}

function mergeTables(head: string, base: string | undefined, rule: RegExp): string {
  const baseTables = splitTables(base ?? "").filter((s) => s.name && rule.test(s.name));
  const kept = splitTables(head).filter((s) => !(s.name && rule.test(s.name)));
  const joined = kept.map((s) => s.body).join("");
  const extra = baseTables.map((s) => s.body).join("");
  return extra ? `${joined}${joined.endsWith("\n") || !joined ? "" : "\n"}${extra}` : joined;
}

export interface ProtectedSwap {
  /** Paths whose base version is in place. */
  restored: string[];
  /** Allowed protected paths the change touched (reported, not restored). */
  allowedChanged: string[];
  undo(): void;
}

/**
 * Puts the base version of every protected path the change touched in place. `undo()` puts the head versions back,
 * from the copies saved under `saveDir`.
 */
export function swapProtected(
  git: Git,
  baseSha: string,
  protect: { paths: readonly string[]; allow: readonly string[] },
  saveDir: string,
): ProtectedSwap {
  const committed = git.run(["diff", "--name-only", "-z", baseSha, "HEAD"]).stdout.split("\0").filter(Boolean);
  const touched = [...new Set([...committed, ...git.changedFiles()])].sort();
  const restored: string[] = [];
  const allowedChanged: string[] = [];
  const saved: { file: string; existed: boolean }[] = [];
  for (const file of touched) {
    if (!matchesAny(file, protect.paths)) continue;
    if (matchesAny(file, protect.allow)) {
      allowedChanged.push(file);
      continue;
    }
    const target = path.join(git.cwd, file);
    const relative = path.relative(git.cwd, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const existed = fs.existsSync(target);
    const head = existed ? fs.readFileSync(target, "utf8") : undefined;
    const backup = path.join(saveDir, file);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (head !== undefined) fs.writeFileSync(backup, head);
    saved.push({ file, existed });
    const baseShow = git.run(["show", `${baseSha}:${file}`]);
    const base = baseShow.code === 0 ? baseShow.stdout : undefined;
    const kind = restoreKind(file);
    let next: string | undefined;
    if (kind === "keys" && head !== undefined) next = mergePackageJson(head, base);
    else if (kind === "tables" && head !== undefined)
      next = mergeTables(head, base, TABLE_RULES[path.posix.basename(file)] as RegExp);
    else next = base;
    if (next === undefined) fs.rmSync(target, { force: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, next);
    }
    restored.push(file);
  }
  return {
    restored,
    allowedChanged,
    undo() {
      for (const { file, existed } of saved) {
        const target = path.join(git.cwd, file);
        if (existed) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.join(saveDir, file), target);
        } else fs.rmSync(target, { force: true });
      }
    },
  };
}
