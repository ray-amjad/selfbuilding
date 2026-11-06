import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { sha256Hex } from "./hash.js";
import type { SkillFile } from "./types.js";

export const LIMITS = {
  maxFiles: 200,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
} as const;

/** Sidecar file names, in the order they are looked for. */
export const SIDECAR_NAMES = ["selfbuilding.ts", "selfbuilding.mts", "selfbuilding.js", "selfbuilding.mjs"] as const;

export interface WalkedFile extends SkillFile {
  /** Absolute path the bytes were read from (the target, for a symlink). */
  abs: string;
  bytes: Uint8Array;
}

export interface WalkResult {
  files: WalkedFile[];
  errors: string[];
  /** Folder-relative paths of symlinks that point at directories inside the folder (not walked twice). */
  skippedDirLinks: string[];
}

const toPosix = (p: string) => p.split(sep).join("/");

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

/**
 * Reads every file under `dir`. A symlink must resolve inside the folder; a link to a file is read through,
 * a link to a directory is not walked, because its target is already walked as part of the folder.
 */
export async function walkSkillFolder(dir: string): Promise<WalkResult> {
  const root = await realpath(dir);
  const files: WalkedFile[] = [];
  const errors: string[] = [];
  const skippedDirLinks: string[] = [];

  async function visit(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const rel = toPosix(relative(root, abs));
      const info = await lstat(abs);
      if (info.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(abs);
        } catch {
          errors.push(`${rel}: symlink target does not exist`);
          continue;
        }
        if (!isInside(root, target)) {
          errors.push(`${rel}: symlink resolves outside the skill folder (${target})`);
          continue;
        }
        const targetInfo = await stat(target);
        if (targetInfo.isDirectory()) {
          skippedDirLinks.push(rel);
          continue;
        }
        if (targetInfo.isFile()) {
          files.push(await readEntry(rel, target, targetInfo.mode));
        }
        continue;
      }
      if (info.isDirectory()) {
        await visit(abs);
        continue;
      }
      if (info.isFile()) files.push(await readEntry(rel, abs, info.mode));
    }
  }

  await visit(root);
  return { files, errors, skippedDirLinks };
}

async function readEntry(rel: string, abs: string, mode: number): Promise<WalkedFile> {
  const bytes = new Uint8Array(await readFile(abs));
  return { path: rel, abs, mode: mode & 0o7777, size: bytes.byteLength, sha256: sha256Hex(bytes), bytes };
}

/** A NUL byte in the first 8 KiB marks a file as binary, the same heuristic git uses. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

export function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}
