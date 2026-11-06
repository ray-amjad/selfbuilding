import { createHash } from "node:crypto";
import { ArtifactError, ConfigError, type Json, MissingSecretError, type ResultStore } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { r2ResultStore, r2ResultStoreFromEnv, s3ResultStore } from "./results.js";

// A fake S3 behind a fetch stub: path-style GET/PUT, ListObjectsV2 with continuation tokens, and the conditional
// headers S3 and R2 honour (If-None-Match: *, If-Match: <etag>). Signatures are checked by the artifact store's own
// fake server; here only the shape of each request matters.

const BUCKET = "selfbuilding-test";
const ENDPOINT = "https://s3.fake.test";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

type Fault = { method?: string; status: number } | { method?: string; drop: true; apply?: boolean };

interface FakeBucket {
  fetch: typeof fetch;
  objects: Map<string, { body: string; etag: string; contentType: string }>;
  requests: { method: string; key: string; query: Record<string, string>; headers: Record<string, string> }[];
  faults: Fault[];
  /** Keys per ListObjectsV2 page. */
  pageSize: number;
  /** A bucket without conditional writes: every PUT overwrites. */
  ignoreConditions: boolean;
  /**
   * Compressing GETs, as R2 does past a small size: the answer carries the ETag weakened to W/"…", while If-Match
   * still compares against the strong one. "negotiated" compresses unless the GET asks for identity.
   */
  compress: "off" | "negotiated" | "always";
}

function fakeBucket(bucket = BUCKET): FakeBucket {
  const state: FakeBucket = {
    objects: new Map(),
    requests: [],
    faults: [],
    pageSize: 1000,
    ignoreConditions: false,
    compress: "off",
    fetch: undefined as unknown as typeof fetch,
  };
  const xml = (status: number, code: string) =>
    new Response(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`, {
      status,
      headers: { "content-type": "application/xml" },
    });
  state.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const [, b, ...rest] = url.pathname.split("/");
    const key = rest.map(decodeURIComponent).join("/");
    const headers = Object.fromEntries(req.headers);
    const body = req.method === "PUT" ? await req.text() : "";
    state.requests.push({ method: req.method, key, query: Object.fromEntries(url.searchParams), headers });
    if (!headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) return xml(403, "AccessDenied");
    const faultAt = state.faults.findIndex((f) => f.method === undefined || f.method === req.method);
    if (faultAt >= 0) {
      const [fault] = state.faults.splice(faultAt, 1);
      if (fault && "drop" in fault) {
        // A request that reached the bucket but whose answer was lost.
        if (fault.apply && req.method === "PUT") conditionalPut(key, body, headers);
        throw new TypeError("fetch failed: socket hang up");
      }
      if (fault)
        return xml(
          fault.status,
          fault.status === 429 ? "SlowDown" : fault.status === 403 ? "AccessDenied" : "InternalError",
        );
    }
    if (b !== bucket) return xml(404, "NoSuchBucket");
    if (req.method === "GET" && rest.length === 0) return list(url);
    if (req.method === "GET") {
      const object = state.objects.get(key);
      if (!object) return xml(404, "NoSuchKey");
      const compressed =
        state.compress === "always" || (state.compress === "negotiated" && headers["accept-encoding"] !== "identity");
      return new Response(object.body, {
        status: 200,
        headers: { etag: compressed ? `W/${object.etag}` : object.etag, "content-type": object.contentType },
      });
    }
    if (req.method === "PUT") {
      const etag = conditionalPut(key, body, headers);
      if (etag === null) return xml(412, "PreconditionFailed");
      return new Response(null, { status: 200, headers: { etag } });
    }
    return xml(405, "MethodNotAllowed");
  }) as typeof fetch;

  function conditionalPut(key: string, body: string, headers: Record<string, string>): string | null {
    const existing = state.objects.get(key);
    if (!state.ignoreConditions) {
      if (headers["if-none-match"] === "*" && existing) return null;
      const ifMatch = headers["if-match"];
      if (ifMatch !== undefined && existing?.etag !== ifMatch) return null;
    }
    return put(key, body, headers);
  }

  let writes = 0;
  function put(key: string, body: string, headers: Record<string, string>): string {
    // Two writes of the same bytes get different ETags here, as on a versioned bucket; CAS must not depend on it.
    const etag = `"${createHash("md5").update(`${body}#${++writes}`).digest("hex")}"`;
    state.objects.set(key, { body, etag, contentType: headers["content-type"] ?? "binary/octet-stream" });
    return etag;
  }

  function list(url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const after = url.searchParams.get("continuation-token");
    const all = [...state.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = after ? all.indexOf(Buffer.from(after, "base64url").toString()) + 1 : 0;
    const page = all.slice(start, start + state.pageSize);
    const truncated = start + state.pageSize < all.length;
    const next = truncated ? Buffer.from(page.at(-1) as string).toString("base64url") : "";
    const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const contents = page.map((k) => `<Contents><Key>${xmlEscape(k)}</Key><Size>1</Size></Contents>`).join("");
    return new Response(
      `<?xml version="1.0"?><ListBucketResult><Name>${BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix>${contents}<IsTruncated>${truncated}</IsTruncated>${
        truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""
      }</ListBucketResult>`,
      { status: 200, headers: { "content-type": "application/xml" } },
    );
  }
  return state;
}

function storeOver(bucket: FakeBucket, over: { prefix?: string; attempts?: number } = {}): ResultStore {
  return s3ResultStore({
    bucket: BUCKET,
    endpoint: ENDPOINT,
    accessKeyId: "AKIDTESTFAKE0000",
    secretAccessKey: "fake-secret-value-0123456789",
    fetch: bucket.fetch,
    retry: { attempts: over.attempts ?? 3, baseDelayMs: 1 },
    ...(over.prefix ? { prefix: over.prefix } : {}),
  });
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const key of it) out.push(key);
  return out;
}

// The ResultStore behaviour the file and memory stores pass (packages/host-trigger/src/store.test.ts), copied.
describe("s3ResultStore: the ResultStore contract", () => {
  const make = () => storeOver(fakeBucket());

  it("create-if-absent keeps the first value", async () => {
    const store = make();
    expect(await store.createIfAbsent("runs/a/x.json", { v: 1 })).toBe(true);
    expect(await store.createIfAbsent("runs/a/x.json", { v: 2 })).toBe(false);
    expect(await store.get("runs/a/x.json")).toEqual({ v: 1 });
    expect(await store.get("runs/a/missing.json")).toBeNull();
  });

  it("compare-and-set succeeds only on the expected version", async () => {
    const store = make();
    expect(await store.replace("k/a.json", { n: 1 }, null)).toBe(true);
    expect(await store.replace("k/a.json", { n: 9 }, null)).toBe(false);
    const v1 = await store.getVersioned<{ n: number }>("k/a.json");
    expect(v1?.value).toEqual({ n: 1 });
    expect(await store.replace("k/a.json", { n: 2 }, v1?.version ?? null)).toBe(true);
    expect(await store.replace("k/a.json", { n: 3 }, v1?.version ?? null)).toBe(false);
    expect(await store.get("k/a.json")).toEqual({ n: 2 });
  });

  it("concurrent create-if-absent has exactly one winner", async () => {
    const store = make();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.createIfAbsent("race/one.json", { i })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("concurrent read-modify-write loses no update", async () => {
    const store = make();
    const bump = async () => {
      for (;;) {
        const current = await store.getVersioned<{ n: number }>("count.json");
        const next = { n: (current?.value.n ?? 0) + 1 };
        if (await store.replace("count.json", next, current?.version ?? null)) return;
      }
    };
    await Promise.all(Array.from({ length: 10 }, bump));
    expect(await store.get("count.json")).toEqual({ n: 10 });
  });

  it("lists keys under a prefix, sorted", async () => {
    const store = make();
    await store.createIfAbsent("runs/r/e0/children/b.json", 1);
    await store.createIfAbsent("runs/r/e0/children/a.json", 1);
    await store.createIfAbsent("runs/r/e1/children/c.json", 1);
    expect(await collect(store.list("runs/r/e0/children/"))).toEqual([
      "runs/r/e0/children/a.json",
      "runs/r/e0/children/b.json",
    ]);
  });

  it("two instances over one bucket see each other's writes", async () => {
    const bucket = fakeBucket();
    const a = storeOver(bucket);
    const b = storeOver(bucket);
    expect(await a.createIfAbsent("x.json", { from: "a" })).toBe(true);
    expect(await b.createIfAbsent("x.json", { from: "b" })).toBe(false);
    expect(await b.get("x.json")).toEqual({ from: "a" });
  });
});

describe("s3ResultStore: the wire", () => {
  it("puts JSON under <prefix>/<key> with each segment percent-encoded, and lists them back decoded", async () => {
    const bucket = fakeBucket();
    const store = storeOver(bucket);
    const key = "runs/ns_1/cache/Review%230 a:b(c).json";
    expect(await store.createIfAbsent(key, { ok: true })).toBe(true);
    const objectKey = "selfbuilding/results/runs/ns_1/cache/Review%25230%20a%3Ab%28c%29.json";
    expect([...bucket.objects.keys()]).toEqual([objectKey]);
    expect(bucket.objects.get(objectKey)).toMatchObject({ body: '{"ok":true}', contentType: "application/json" });
    expect(bucket.requests[0]?.headers["if-none-match"]).toBe("*");
    expect(await store.get(key)).toEqual({ ok: true });
    expect(await collect(store.list("runs/ns_1/"))).toEqual([key]);
    expect(await collect(store.list("runs/ns_1/cache/Review%23"))).toEqual([key]);
    expect(await collect(store.list("runs/ns_2/"))).toEqual([]);
  });

  it("keeps dot segments as keys, never as path steps", async () => {
    const bucket = fakeBucket();
    const store = storeOver(bucket);
    await store.createIfAbsent("a/../b.json", 1);
    expect([...bucket.objects.keys()]).toEqual(["selfbuilding/results/a/%2E%2E/b.json"]);
    expect(await store.get("a/../b.json")).toBe(1);
    expect(await store.get("b.json")).toBeNull();
    await expect(store.get("a//b")).rejects.toBeInstanceOf(ConfigError);
  });

  it("uses the configured prefix and the ETag as the version, sending If-Match on compare-and-set", async () => {
    const bucket = fakeBucket();
    const store = storeOver(bucket, { prefix: "deploy-1/state" });
    await store.replace("k.json", { n: 1 }, null);
    const v = await store.getVersioned("k.json");
    expect(v?.version).toBe(bucket.objects.get("deploy-1/state/k.json")?.etag);
    await store.replace("k.json", { n: 2 }, v?.version ?? null);
    expect(bucket.requests.at(-1)?.headers["if-match"]).toBe(v?.version);
  });

  // The live failure: R2 gzipped the run record's GET, its weak ETag never matched, and every CAS lost.
  it("compare-and-set still wins on a bucket that compresses GETs and weakens their ETag", async () => {
    for (const compress of ["negotiated", "always"] as const) {
      const bucket = fakeBucket();
      bucket.compress = compress;
      const store = storeOver(bucket);
      await store.createIfAbsent("runs/r/run.json", { status: "running" });
      const v = await store.getVersioned("runs/r/run.json");
      expect(v?.version).toBe(bucket.objects.get("selfbuilding/results/runs/r/run.json")?.etag);
      expect(await store.replace("runs/r/run.json", { status: "ok" }, v?.version ?? null)).toBe(true);
      expect(await store.get("runs/r/run.json")).toEqual({ status: "ok" });
    }
    const bucket = fakeBucket();
    bucket.compress = "negotiated";
    await storeOver(bucket).get("k.json");
    expect(bucket.requests.at(-1)?.headers["accept-encoding"]).toBe("identity");
  });

  it("follows ListObjectsV2 continuation tokens across pages", async () => {
    const bucket = fakeBucket();
    bucket.pageSize = 2;
    const store = storeOver(bucket);
    const keys = Array.from({ length: 7 }, (_, i) => `asks/ask_${i}.json`);
    for (const key of keys) await store.createIfAbsent(key, null);
    await store.createIfAbsent("other/x.json", null);
    expect(await collect(store.list("asks/"))).toEqual(keys);
    const lists = bucket.requests.filter((r) => r.query["list-type"] === "2");
    expect(lists).toHaveLength(4);
    expect(lists[0]?.query.prefix).toBe("selfbuilding/results/asks/");
    expect(lists[1]?.query["continuation-token"]).toBeTruthy();
  });

  it("passes the Trigger host's conditional-write probe only when the bucket honours the headers", async () => {
    const bucket = fakeBucket();
    const store = storeOver(bucket);
    expect(await store.createIfAbsent("selfbuilding/probe/p.json", { probe: true })).toBe(true);
    expect(await store.createIfAbsent("selfbuilding/probe/p.json", { probe: false })).toBe(false);
    bucket.ignoreConditions = true;
    expect(await store.createIfAbsent("selfbuilding/probe/q.json", { probe: true })).toBe(true);
    expect(await store.createIfAbsent("selfbuilding/probe/q.json", { probe: false })).toBe(true);
    expect(await store.get("selfbuilding/probe/q.json")).toEqual({ probe: false });
  });
});

describe("s3ResultStore: retries", () => {
  it("never retries a 412", async () => {
    const bucket = fakeBucket();
    const store = storeOver(bucket);
    await store.createIfAbsent("k.json", 1);
    const before = bucket.requests.length;
    expect(await store.createIfAbsent("k.json", 2)).toBe(false);
    expect(bucket.requests.length - before).toBe(1);
  });

  it("retries 5xx, 429 and network errors, then succeeds", async () => {
    const bucket = fakeBucket();
    const store = storeOver(bucket);
    bucket.faults.push({ method: "PUT", status: 503 }, { method: "PUT", status: 429 });
    expect(await store.createIfAbsent("k.json", { v: 1 })).toBe(true);
    bucket.faults.push({ method: "GET", drop: true });
    expect(await store.get("k.json")).toEqual({ v: 1 });
  });

  it("gives up after the attempts with an ArtifactError naming the bucket and the status", async () => {
    const bucket = fakeBucket();
    const store = storeOver(bucket);
    bucket.faults.push({ status: 500 }, { status: 502 }, { status: 503 });
    const error = await store.get("k.json").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArtifactError);
    expect((error as Error).message).toContain(`"${BUCKET}"`);
    expect((error as Error).message).toContain("HTTP 503");
    expect((error as Error).message).toContain("3 attempts");
    expect((error as ArtifactError).retryable).toBe(true);
  });

  it("a create whose first PUT landed but whose answer was lost still reports the win", async () => {
    const bucket = fakeBucket();
    const store = storeOver(bucket);
    bucket.faults.push({ method: "PUT", drop: true, apply: true });
    expect(await store.createIfAbsent("k.json", { mine: true })).toBe(true);
    const other = storeOver(bucket);
    bucket.faults.push({ method: "PUT", drop: true, apply: true });
    expect(await other.createIfAbsent("k.json", { mine: false })).toBe(false);
  });

  it("other 4xx fail at once with the S3 error code; 403 says to check the key", async () => {
    const bucket = fakeBucket();
    const store = storeOver(bucket);
    bucket.faults.push({ status: 403 });
    const error = await store.get("k.json").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArtifactError);
    expect((error as Error).message).toMatch(/HTTP 403 \(AccessDenied\)\. Check the access key/);
    expect(bucket.requests).toHaveLength(1);
  });

  it("never puts a credential in an error", async () => {
    const bucket = fakeBucket();
    const store = storeOver(bucket);
    bucket.faults.push({ status: 500 }, { status: 500 }, { status: 500 });
    const error = (await store.get("k.json").catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("fake-secret-value");
  });
});

describe("r2ResultStore and r2ResultStoreFromEnv", () => {
  const env = {
    R2_ACCOUNT_ID: ACCOUNT,
    R2_ACCESS_KEY_ID: "AKIDTESTFAKE0000",
    R2_SECRET_ACCESS_KEY: "fake-secret-value-0123456789",
  };

  it("targets the account's R2 endpoint and the default bucket", async () => {
    const seen: string[] = [];
    const store = r2ResultStoreFromEnv(env, {
      fetch: async (input) => {
        seen.push((input as Request).url);
        return new Response(null, { status: 404 });
      },
    });
    expect(await store.get("runs/x/run.json")).toBeNull();
    expect(seen[0]).toBe(
      `https://${ACCOUNT}.r2.cloudflarestorage.com/selfbuilding-artifacts/selfbuilding/results/runs/x/run.json`,
    );
  });

  it("honours R2_BUCKET and the prefix option", async () => {
    const seen: string[] = [];
    const store = r2ResultStoreFromEnv(
      { ...env, R2_BUCKET: "my-bucket" },
      {
        prefix: "prod/results",
        fetch: async (input) => {
          seen.push((input as Request).url);
          return new Response(null, { status: 404 });
        },
      },
    );
    await store.get("a.json");
    expect(seen[0]).toContain("/my-bucket/prod/results/a.json");
  });

  it("lists every missing name in one MissingSecretError", () => {
    const error = (() => {
      try {
        r2ResultStoreFromEnv({ R2_ACCESS_KEY_ID: "x" });
      } catch (e) {
        return e;
      }
    })() as MissingSecretError;
    expect(error).toBeInstanceOf(MissingSecretError);
    expect(error.message).toContain("R2_ACCOUNT_ID");
    expect(error.message).toContain("R2_SECRET_ACCESS_KEY");
    expect(error.message).not.toContain("R2_ACCESS_KEY_ID,");
  });

  it("refuses a bad account id, bucket or prefix with ConfigError", () => {
    expect(() => r2ResultStore({ accountId: "nope", bucket: BUCKET, accessKeyId: "a", secretAccessKey: "b" })).toThrow(
      ConfigError,
    );
    expect(() =>
      s3ResultStore({ bucket: "Bad_Bucket", endpoint: ENDPOINT, accessKeyId: "a", secretAccessKey: "b" }),
    ).toThrow(/s3ResultStore: bucket/);
    expect(() =>
      s3ResultStore({ bucket: BUCKET, endpoint: ENDPOINT, accessKeyId: "a", secretAccessKey: "b", prefix: "/x" }),
    ).toThrow(ConfigError);
  });

  it("stores any JSON value", async () => {
    const store = storeOver(fakeBucket());
    const values: Json[] = [null, 0, "text", [1, { a: [true] }], { nested: { deep: "ünïcode" } }];
    for (const [i, value] of values.entries()) await store.createIfAbsent(`v/${i}.json`, value);
    for (const [i, value] of values.entries()) expect(await store.get(`v/${i}.json`)).toEqual(value);
  });
});
