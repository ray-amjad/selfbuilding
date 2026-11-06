import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, type ResultStore } from "@selfbuilding/core";
import { afterEach, describe, expect, it } from "vitest";
import { fileResultStore, memoryResultStore, probeConditionalWrites, updateCas } from "./store.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sbt-store-"));
  dirs.push(dir);
  return dir;
}

const stores: [string, () => Promise<ResultStore>][] = [
  ["memoryResultStore", async () => memoryResultStore()],
  ["fileResultStore", async () => fileResultStore(await freshDir())],
];

describe.each(stores)("%s", (_name, make) => {
  it("create-if-absent keeps the first value", async () => {
    const store = await make();
    expect(await store.createIfAbsent("runs/a/x.json", { v: 1 })).toBe(true);
    expect(await store.createIfAbsent("runs/a/x.json", { v: 2 })).toBe(false);
    expect(await store.get("runs/a/x.json")).toEqual({ v: 1 });
    expect(await store.get("runs/a/missing.json")).toBeNull();
  });

  it("compare-and-set succeeds only on the expected version", async () => {
    const store = await make();
    expect(await store.replace("k/a.json", { n: 1 }, null)).toBe(true);
    expect(await store.replace("k/a.json", { n: 9 }, null)).toBe(false);
    const v1 = await store.getVersioned<{ n: number }>("k/a.json");
    expect(v1?.value).toEqual({ n: 1 });
    expect(await store.replace("k/a.json", { n: 2 }, v1?.version ?? null)).toBe(true);
    expect(await store.replace("k/a.json", { n: 3 }, v1?.version ?? null)).toBe(false);
    expect(await store.get("k/a.json")).toEqual({ n: 2 });
  });

  it("concurrent create-if-absent has exactly one winner", async () => {
    const store = await make();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.createIfAbsent("race/one.json", { i })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("concurrent read-modify-write loses no update", async () => {
    const store = await make();
    await Promise.all(
      Array.from({ length: 10 }, () => updateCas<{ n: number }>(store, "count.json", (c) => ({ n: (c?.n ?? 0) + 1 }))),
    );
    expect(await store.get("count.json")).toEqual({ n: 10 });
  });

  it("lists keys under a prefix, sorted", async () => {
    const store = await make();
    await store.createIfAbsent("runs/r/e0/children/b.json", 1);
    await store.createIfAbsent("runs/r/e0/children/a.json", 1);
    await store.createIfAbsent("runs/r/e1/children/c.json", 1);
    const keys: string[] = [];
    for await (const key of store.list("runs/r/e0/children/")) keys.push(key);
    expect(keys).toEqual(["runs/r/e0/children/a.json", "runs/r/e0/children/b.json"]);
  });

  it("passes the conditional-write probe", async () => {
    await expect(probeConditionalWrites(await make())).resolves.toBeUndefined();
  });
});

describe("fileResultStore", () => {
  it("rejects keys that escape the root", async () => {
    const store = fileResultStore(await freshDir());
    await expect(store.get("../etc/passwd")).rejects.toBeInstanceOf(ConfigError);
  });

  it("two instances over one directory see each other's writes", async () => {
    const dir = await freshDir();
    const a = fileResultStore(dir);
    const b = fileResultStore(dir);
    expect(await a.createIfAbsent("x.json", { from: "a" })).toBe(true);
    expect(await b.createIfAbsent("x.json", { from: "b" })).toBe(false);
    expect(await b.get("x.json")).toEqual({ from: "a" });
  });
});

describe("probeConditionalWrites", () => {
  it("refuses a store whose create-if-absent overwrites", async () => {
    const inner = memoryResultStore();
    const broken: ResultStore = {
      ...inner,
      get: inner.get.bind(inner),
      getVersioned: inner.getVersioned.bind(inner),
      replace: inner.replace.bind(inner),
      list: inner.list.bind(inner),
      async createIfAbsent(key, value) {
        const v = await inner.getVersioned(key);
        await inner.replace(key, value, v?.version ?? null);
        return true;
      },
    };
    await expect(probeConditionalWrites(broken)).rejects.toBeInstanceOf(ConfigError);
  });
});
