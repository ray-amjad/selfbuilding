import { internalNow, randomBytes } from "../engine/hash.js";
import { ConfigError, JournalConflictError } from "../errors/classes.js";

// node:fs is loaded lazily inside calls, so importing core never loads it (spec §10.1).

export type Fs = typeof import("node:fs/promises");
export type NodePath = typeof import("node:path");

let loaded: Promise<{ fs: Fs; path: NodePath }> | undefined;

export function nodeFs(): Promise<{ fs: Fs; path: NodePath }> {
  loaded ??= (async () => {
    try {
      const [fs, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
      return { fs, path };
    } catch (cause) {
      loaded = undefined;
      throw new ConfigError(
        "The file journal and file artifact store need node:fs. On this host, use the host's own journal and artifact storage.",
        { cause },
      );
    }
  })();
  return loaded;
}

function suffix(): string {
  let s = "";
  for (const b of randomBytes(6)) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Writes through a temp file and rename, so readers never see a partial file. */
export async function writeAtomic(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const { fs, path } = await nodeFs();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${suffix()}.tmp`;
  await fs.writeFile(tmp, data, mode === undefined ? undefined : { mode });
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  const { fs } = await nodeFs();
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const STALE_LOCK_MS = 15_000;
const LOCK_DEADLINE_MS = 20_000;

/**
 * A cross-process mutex built on `mkdir`, which is atomic on every local filesystem. A lock older than
 * 15 s belongs to a dead process (critical sections are a few file operations) and is broken.
 */
export async function withLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  const { fs, path } = await nodeFs();
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  const deadline = internalNow() + LOCK_DEADLINE_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockDir).catch(() => null);
      if (stat && internalNow() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (internalNow() > deadline) {
        throw new JournalConflictError(
          `Could not take ${lockDir} within ${LOCK_DEADLINE_MS / 1000}s; another writer holds it.`,
        );
      }
      await new Promise((r) =>
        setTimeout(r, Math.min(50, 2 + attempt * 2) * ((randomBytes(1)[0] as number) / 255 + 0.5)),
      );
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

const SAFE_NAME = /^[A-Za-z0-9_.~-]{1,200}$/;

/** File names come from step keys and ids; anything else is encoded so it cannot escape the directory. */
export function safeName(name: string): string {
  if (SAFE_NAME.test(name) && name !== "." && name !== "..") return name;
  return `~${Buffer.from(name, "utf8").toString("base64url")}`;
}
