import { sha256Hex } from "../sandbox/hash.js";
import type { ArtifactRef, ArtifactRefJson, ArtifactStore } from "../types/artifacts.js";
import type { Json } from "../types/common.js";
import type { ResultStore } from "../types/host.js";

// The plain Node host's stores (spec §7.10). node:fs loads lazily inside each call so the core entry imports
// nothing heavier than node:async_hooks at load time (spec §10.1).

function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

function refFrom(store: ArtifactStore, json: ArtifactRefJson): ArtifactRef {
  return {
    uri: json.uri,
    bytes: json.bytes,
    sha256: json.sha256,
    contentType: json.contentType,
    text: async () => new TextDecoder().decode(await store.read(json.uri)),
  };
}

/** In-memory, content-addressed. For standalone calls with no configured store, and for tests. */
export function memoryArtifactStore(): ArtifactStore {
  const blobs = new Map<string, Uint8Array>();
  const store: ArtifactStore = {
    async put(_key, body, opts) {
      const bytes = toBytes(body);
      const digest = sha256Hex(bytes);
      const uri = `artifact://memory/${digest}`;
      blobs.set(uri, bytes);
      return refFrom(store, {
        uri,
        bytes: bytes.byteLength,
        sha256: digest,
        contentType: opts?.contentType ?? "application/octet-stream",
      });
    },
    async read(uri) {
      const bytes = blobs.get(uri);
      if (!bytes) throw new Error(`artifact ${uri} is not in this store`);
      return bytes;
    },
    hydrate: (ref) => refFrom(store, ref),
  };
  return store;
}

/**
 * A content-addressed file store: `<dir>/<sha256>` holds the bytes, so a second put of the same bytes is a no-op
 * and returns the same ref (spec §2.8, §7.10).
 */
export function fileArtifactStore(dir: string): ArtifactStore {
  const store: ArtifactStore = {
    async put(_key, body, opts) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const bytes = toBytes(body);
      const digest = sha256Hex(bytes);
      const file = path.join(dir, digest);
      await fs.mkdir(dir, { recursive: true });
      try {
        await fs.writeFile(file, bytes, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return refFrom(store, {
        uri: `file://${file}`,
        bytes: bytes.byteLength,
        sha256: digest,
        contentType: opts?.contentType ?? "application/octet-stream",
      });
    },
    async read(uri) {
      const fs = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      if (!uri.startsWith("file://")) throw new Error(`fileArtifactStore cannot read ${uri}`);
      return new Uint8Array(await fs.readFile(fileURLToPath(uri)));
    },
    hydrate: (ref) => refFrom(store, ref),
  };
  return store;
}

/** In-memory result store with create-if-absent and compare-and-set. */
export function memoryResultStore(): ResultStore {
  const rows = new Map<string, { value: Json; version: number }>();
  let clock = 0;
  // A JSON round trip, like every durable store: functions (ArtifactRef.text) drop out.
  const clone = (value: Json): Json => JSON.parse(JSON.stringify(value)) as Json;
  return {
    async get<T extends Json>(key: string) {
      return (rows.get(key)?.value ?? null) as T | null;
    },
    async createIfAbsent(key, value) {
      if (rows.has(key)) return false;
      rows.set(key, { value: clone(value), version: ++clock });
      return true;
    },
    async getVersioned<T extends Json>(key: string) {
      const row = rows.get(key);
      return row ? { value: row.value as T, version: String(row.version) } : null;
    },
    async replace(key, value, expectVersion) {
      const row = rows.get(key);
      if (expectVersion === null ? row !== undefined : row?.version !== Number(expectVersion)) return false;
      rows.set(key, { value: clone(value), version: ++clock });
      return true;
    },
    async *list(prefix) {
      for (const key of [...rows.keys()].sort()) if (key.startsWith(prefix)) yield key;
    },
  };
}

/**
 * A file-backed result store, one JSON file per key. Writes are single-writer under the journal lease; creates use
 * O_EXCL and replaces compare the content hash, so a stale writer loses.
 */
export function fileResultStore(dir: string): ResultStore {
  const fileFor = async (key: string) => {
    const path = await import("node:path");
    const safe = key
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    return path.join(dir, `${safe}.json`);
  };
  const readRow = async (key: string): Promise<{ text: string } | null> => {
    const fs = await import("node:fs/promises");
    try {
      return { text: await fs.readFile(await fileFor(key), "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    async get<T extends Json>(key: string) {
      const row = await readRow(key);
      return row ? (JSON.parse(row.text) as T) : null;
    },
    async createIfAbsent(key, value) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const file = await fileFor(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      try {
        await fs.writeFile(file, JSON.stringify(value), { flag: "wx" });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    },
    async getVersioned<T extends Json>(key: string) {
      const row = await readRow(key);
      return row ? { value: JSON.parse(row.text) as T, version: sha256Hex(row.text) } : null;
    },
    async replace(key, value, expectVersion) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const row = await readRow(key);
      if (expectVersion === null ? row !== null : row === null || sha256Hex(row.text) !== expectVersion) return false;
      const file = await fileFor(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, file);
      return true;
    },
    async *list(prefix) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      let entries: string[] = [];
      try {
        entries = (await fs.readdir(dir, { recursive: true })) as string[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const keys = entries
        .filter((e) => e.endsWith(".json"))
        .map((e) =>
          e
            .slice(0, -5)
            .split(path.sep)
            .map((part) => decodeURIComponent(part))
            .join("/"),
        )
        .sort();
      for (const key of keys) if (key.startsWith(prefix)) yield key;
    },
  };
}
