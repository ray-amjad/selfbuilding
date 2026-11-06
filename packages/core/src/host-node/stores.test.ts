import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../../test/agent-kit/kit.js";
import type { ArtifactStore, ResultStore } from "../index.js";
import { fileArtifactStore, fileResultStore, memoryArtifactStore, memoryResultStore } from "./stores.js";

const dirs: string[] = [];
async function dir(): Promise<string> {
  const d = await tempDir("sbc-store-");
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const artifactStores: [string, () => Promise<ArtifactStore>][] = [
  ["memory", async () => memoryArtifactStore()],
  ["file", async () => fileArtifactStore(await dir())],
];

const resultStores: [string, () => Promise<ResultStore>][] = [
  ["memory", async () => memoryResultStore()],
  ["file", async () => fileResultStore(await dir())],
];

describe.each(artifactStores)("%s artifact store", (_name, make) => {
  it("is content-addressed and rehydrates refs", async () => {
    const store = await make();
    const a = await store.put("k1", "hello");
    const b = await store.put("k2", "hello");
    expect(a.uri).toBe(b.uri);
    expect(new TextDecoder().decode(await store.read(a.uri))).toBe("hello");
    const json = JSON.parse(JSON.stringify(a));
    expect(await store.hydrate(json).text()).toBe("hello");
  });
});

describe.each(resultStores)("%s result store", (_name, make) => {
  it("creates once and compares-and-sets on version", async () => {
    const store = await make();
    expect(await store.createIfAbsent("runs/a/x", { n: 1 })).toBe(true);
    expect(await store.createIfAbsent("runs/a/x", { n: 2 })).toBe(false);
    expect(await store.get("runs/a/x")).toEqual({ n: 1 });
    const v = await store.getVersioned("runs/a/x");
    expect(await store.replace("runs/a/x", { n: 3 }, v?.version ?? null)).toBe(true);
    expect(await store.replace("runs/a/x", { n: 4 }, v?.version ?? null)).toBe(false);
    expect(await store.replace("runs/a/y", { n: 5 }, null)).toBe(true);
    expect(await store.replace("runs/a/y", { n: 6 }, null)).toBe(false);
    const keys: string[] = [];
    for await (const k of store.list("runs/a/")) keys.push(k);
    expect(keys.sort()).toEqual(["runs/a/x", "runs/a/y"]);
  });
});
