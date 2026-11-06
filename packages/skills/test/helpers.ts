import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Test-only helpers.

export interface Fixture {
  root: string;
  /** Writes a skill folder under `root`. `files` values are file contents; `null` creates a directory. */
  skill(rel: string, files: Record<string, string | Uint8Array>): Promise<string>;
  file(rel: string, content: string | Uint8Array, mode?: number): Promise<string>;
  link(rel: string, target: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sb-skills-"));
  const file = async (rel: string, content: string | Uint8Array, mode?: number) => {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    if (mode !== undefined) await chmod(abs, mode);
    return abs;
  };
  return {
    root,
    file,
    async skill(rel, files) {
      for (const [name, content] of Object.entries(files)) await file(join(rel, name), content);
      return join(root, rel);
    },
    async link(rel, target) {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await symlink(target, abs);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function skillMd(front: Record<string, unknown> | string, body = "Do the thing.\n"): string {
  const yaml =
    typeof front === "string"
      ? front
      : Object.entries(front)
          .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`)
          .join("\n");
  return `---\n${yaml}\n---\n${body}`;
}
