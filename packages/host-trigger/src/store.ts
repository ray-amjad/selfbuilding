import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError, JournalConflictError, type Json, type ResultStore } from "@selfbuilding/core";
import { storeKeys } from "./keys.js";

// Result stores for the Trigger host (spec §7.10). Every write is create-if-absent or compare-and-set.

const LOCAL = Symbol.for("selfbuilding.host-trigger.local-result-store");

/** Marks a store that only one machine can reach, so a deployed run refuses it (release-prep §3.1). */
function local<T extends object>(store: T, kind: string): T {
  Object.defineProperty(store, LOCAL, { value: kind, enumerable: false });
  return store;
}

/** "fileResultStore" or "memoryResultStore" for the stores in this file; undefined for any other store. */
export function localStoreKind(store: ResultStore): string | undefined {
  return (store as { [LOCAL]?: string })[LOCAL];
}

/** An in-process store. Survives a simulated crash in tests; not durable across processes. */
export function memoryResultStore(): ResultStore & { readonly size: number; dump(): Record<string, Json> } {
  const rows = new Map<string, { json: string; version: number }>();
  let clock = 0;
  return local(
    {
      get size() {
        return rows.size;
      },
      dump() {
        return Object.fromEntries([...rows].map(([k, v]) => [k, JSON.parse(v.json) as Json]));
      },
      async get<T extends Json>(key: string) {
        const row = rows.get(key);
        return row ? (JSON.parse(row.json) as T) : null;
      },
      async createIfAbsent(key, value) {
        if (rows.has(key)) return false;
        rows.set(key, { json: JSON.stringify(value), version: ++clock });
        return true;
      },
      async getVersioned<T extends Json>(key: string) {
        const row = rows.get(key);
        return row ? { value: JSON.parse(row.json) as T, version: String(row.version) } : null;
      },
      async replace(key, value, expectVersion) {
        const row = rows.get(key);
        const current = row ? String(row.version) : null;
        if (current !== expectVersion) return false;
        rows.set(key, { json: JSON.stringify(value), version: ++clock });
        return true;
      },
      async *list(prefix) {
        for (const key of [...rows.keys()].sort()) if (key.startsWith(prefix)) yield key;
      },
    },
    "memoryResultStore",
  );
}

const LOCK_STALE_MS = 30_000;

/**
 * A directory-backed store, safe across processes on one filesystem. Create-if-absent publishes a complete
 * temp file with `link`, which fails when the target exists; compare-and-set holds a `mkdir` lock.
 */
export function fileResultStore(root: string): ResultStore {
  const base = path.resolve(root);

  function fileOf(key: string): string {
    if (key.split("/").some((part) => part === ".." || part === "." || part === "")) {
      throw new ConfigError(`Result store key "${key}" is not a plain relative path.`);
    }
    return path.join(base, key);
  }

  async function readRaw(file: string): Promise<string | null> {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function publish(file: string, json: string): Promise<boolean> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, json);
    try {
      await link(tmp, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
        await new Promise((r) => setTimeout(r, Math.min(50, 2 + attempt)));
      }
    }
    try {
      return await fn();
    } finally {
      await rmdir(lock).catch(() => {});
    }
  }

  const version = (json: string) => createHash("sha256").update(json).digest("hex");

  return local<ResultStore>(
    {
      async get<T extends Json>(key: string) {
        const raw = await readRaw(fileOf(key));
        return raw === null ? null : (JSON.parse(raw) as T);
      },
      async createIfAbsent(key, value) {
        return publish(fileOf(key), JSON.stringify(value));
      },
      async getVersioned<T extends Json>(key: string) {
        const raw = await readRaw(fileOf(key));
        return raw === null ? null : { value: JSON.parse(raw) as T, version: version(raw) };
      },
      async replace(key, value, expectVersion) {
        const file = fileOf(key);
        return withLock(file, async () => {
          const raw = await readRaw(file);
          const current = raw === null ? null : version(raw);
          if (current !== expectVersion) return false;
          const json = JSON.stringify(value);
          if (raw === null) return publish(file, json);
          const tmp = `${file}.${randomUUID()}.tmp`;
          await writeFile(tmp, json);
          await rename(tmp, file);
          return true;
        });
      },
      async *list(prefix) {
        const keys: string[] = [];
        const dir = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
        async function walk(rel: string): Promise<void> {
          let entries: import("node:fs").Dirent[];
          try {
            entries = await readdir(path.join(base, rel), { withFileTypes: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          for (const entry of entries) {
            const key = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              if (!entry.name.endsWith(".lock")) await walk(key);
            } else if (!entry.name.endsWith(".tmp") && key.startsWith(prefix)) {
              keys.push(key);
            }
          }
        }
        await walk(dir);
        keys.sort();
        yield* keys;
      },
    },
    "fileResultStore",
  );
}

/** `createTriggerHost` refuses a store without working create-if-absent (spec §7.12.2). */
export async function probeConditionalWrites(store: ResultStore): Promise<void> {
  const key = storeKeys.probe(randomUUID());
  const first = await store.createIfAbsent(key, { probe: true });
  const second = await store.createIfAbsent(key, { probe: false });
  const read = await store.get<{ probe: boolean }>(key);
  if (!first || second || read?.probe !== true) {
    throw new ConfigError(
      "The Trigger host's result store does not honour create-if-absent writes. Use a bucket with conditional writes (If-None-Match: *) or fileResultStore().",
    );
  }
}

/** Retries a read-modify-write until its compare-and-set wins. */
export async function updateCas<T extends Json>(
  store: ResultStore,
  key: string,
  update: (current: T | null) => T | undefined,
): Promise<T | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await store.getVersioned<T>(key);
    const next = update(current?.value ?? null);
    if (next === undefined) return current?.value ?? null;
    if (await store.replace(key, next, current?.version ?? null)) return next;
  }
  throw new JournalConflictError(`Compare-and-set on "${key}" kept losing; another writer is rewriting it in a loop.`);
}
