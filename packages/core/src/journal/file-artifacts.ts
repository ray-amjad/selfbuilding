import { ArtifactError, ConfigError } from "../errors/classes.js";
import type { ArtifactRef, ArtifactRefJson, ArtifactStore } from "../types/artifacts.js";
import { nodeFs, readJson, writeAtomic } from "./fs-util.js";

const decoder = new TextDecoder();

/**
 * Content-addressed blobs under `<dir>/sha256/<aa>/<hash>`, with the content type beside each blob. `put`
 * keys are informational: the same bytes always yield the same ref.
 */
export function createFileArtifacts(dir: string): ArtifactStore {
  if (typeof dir !== "string" || dir === "") throw new ConfigError("fileArtifacts(dir) needs a directory path.");
  let root: string | undefined;
  const resolveRoot = async () => {
    if (root === undefined) {
      const { path } = await nodeFs();
      root = path.resolve(dir);
    }
    return root;
  };

  const blobPath = async (sha256: string) => {
    const { path } = await nodeFs();
    return path.join(await resolveRoot(), "sha256", sha256.slice(0, 2), sha256);
  };

  const pathOf = async (uri: string): Promise<string> => {
    const { path } = await nodeFs();
    const { fileURLToPath } = await import("node:url");
    let file: string;
    try {
      file = fileURLToPath(uri);
    } catch (cause) {
      throw new ArtifactError(`Artifact uri ${uri} is not a file: URI from this store.`, { cause });
    }
    const base = await resolveRoot();
    const rel = path.relative(base, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ArtifactError(`Artifact uri ${uri} points outside the artifact store at ${base}.`);
    }
    return file;
  };

  const store: ArtifactStore = {
    async put(key, body, opts) {
      if (!key) throw new ConfigError("ArtifactStore.put needs a key.");
      const { createHash } = await import("node:crypto");
      const { fs } = await nodeFs();
      const { pathToFileURL } = await import("node:url");
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const file = await blobPath(sha256);
      const contentType =
        opts?.contentType ?? (typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream");
      const exists = await fs
        .stat(file)
        .then((s) => s.size === bytes.length)
        .catch(() => false);
      if (!exists) {
        await writeAtomic(file, bytes);
        await writeAtomic(`${file}.meta.json`, JSON.stringify({ contentType, key }));
      }
      const meta = await readJson<{ contentType: string }>(`${file}.meta.json`);
      return store.hydrate({
        uri: pathToFileURL(file).href,
        bytes: bytes.length,
        sha256,
        contentType: meta?.contentType ?? contentType,
      });
    },

    async read(uri) {
      const { fs } = await nodeFs();
      const file = await pathOf(uri);
      try {
        return new Uint8Array(await fs.readFile(file));
      } catch (cause) {
        throw new ArtifactError(`Artifact ${uri} could not be read: ${(cause as Error).message}`, { cause });
      }
    },

    hydrate(ref: ArtifactRefJson): ArtifactRef {
      const json: ArtifactRefJson = {
        uri: ref.uri,
        bytes: ref.bytes,
        sha256: ref.sha256,
        contentType: ref.contentType,
      };
      const hydrated = {
        ...json,
        text: async () => decoder.decode(await store.read(json.uri)),
      };
      // text() stays out of JSON so refs serialise into journals and outcomes unchanged.
      Object.defineProperty(hydrated, "text", { enumerable: false });
      return hydrated;
    },
  };
  return store;
}
