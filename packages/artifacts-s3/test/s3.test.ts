import { createHash } from "node:crypto";
import { ArtifactError, ConfigError, defineConfig, MissingSecretError, SelfbuildingError } from "@selfbuilding/core";
import { AwsClient } from "aws4fetch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_R2_BUCKET,
  r2Artifacts,
  r2ArtifactsFromEnv,
  type SignedArtifactStore,
  s3Artifacts,
} from "../src/index.js";
import { contentDisposition, MAX_BODY_BYTES } from "../src/store.js";
import { type FakeS3, startFakeS3 } from "./fake-s3.js";

const ACCESS = "AKIDTESTFAKE0000";
const SECRET = "fake-secret-value-do-not-print-0123456789";
const BUCKET = "selfbuilding-artifacts";
const ACCOUNT = "f2821033c1667dab67b5f3f891dc6123";
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

let s3: FakeS3;
let store: SignedArtifactStore;

beforeEach(async () => {
  s3 = await startFakeS3({ accessKeyId: ACCESS, secretAccessKey: SECRET, bucket: BUCKET });
  store = s3Artifacts({
    bucket: BUCKET,
    endpoint: s3.endpoint,
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    retry: { baseDelayMs: 1 },
  });
});

afterEach(async () => {
  await s3.close();
});

describe("put and read", () => {
  it("stores content-addressed under the prefix with the key as metadata", async () => {
    const ref = await store.put("diff/run-1.patch", "hello world", { contentType: "text/x-diff" });
    const hash = sha("hello world");
    expect(ref).toEqual({
      uri: `s3://${BUCKET}/selfbuilding/sha256/${hash.slice(0, 2)}/${hash}`,
      bytes: 11,
      sha256: hash,
      contentType: "text/x-diff",
    });
    const object = s3.objects.get(`selfbuilding/sha256/${hash.slice(0, 2)}/${hash}`);
    expect(object?.contentType).toBe("text/x-diff");
    expect(object?.meta["x-amz-meta-selfbuilding-key"]).toBe("diff/run-1.patch");
    expect(await ref.text()).toBe("hello world");
    expect(new TextDecoder().decode(await store.read(ref.uri))).toBe("hello world");
    // Every request was signed in the header, and the fake verified the signature independently.
    expect(s3.requests.map((r) => [r.method, r.auth])).toEqual([
      ["HEAD", "header"],
      ["PUT", "header"],
      ["GET", "header"],
      ["GET", "header"],
    ]);
  });

  it("defaults the content type by body kind and round-trips binary bytes", async () => {
    const bytes = new Uint8Array([0, 255, 1, 254, 10]);
    const ref = await store.put("bin", bytes);
    expect(ref.contentType).toBe("application/octet-stream");
    expect([...(await store.read(ref.uri))]).toEqual([...bytes]);
    expect((await store.put("t", "x")).contentType).toBe("text/plain; charset=utf-8");
  });

  it("a second put of the same bytes uploads nothing and returns the same ref", async () => {
    const a = await store.put("one", "same bytes", { contentType: "text/plain" });
    const before = s3.requests.length;
    const b = await store.put("two", "same bytes", { contentType: "application/json" });
    expect(s3.requests.slice(before).map((r) => r.method)).toEqual(["HEAD"]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("re-uploads when the stored object has the wrong length", async () => {
    const ref = await store.put("k", "abcdef");
    const key = ref.uri.slice(`s3://${BUCKET}/`.length);
    const object = s3.objects.get(key);
    if (object) object.body = Buffer.from("abc");
    await store.put("k", "abcdef");
    expect(s3.requests.at(-1)?.method).toBe("PUT");
    expect(s3.objects.get(key)?.body.toString()).toBe("abcdef");
  });

  it("keeps non-ASCII put keys readable in metadata", async () => {
    await store.put("files/résumé 100%.md", "x");
    const [object] = [...s3.objects.values()];
    expect(decodeURIComponent(object?.meta["x-amz-meta-selfbuilding-key"] ?? "")).toBe("files/résumé 100%.md");
  });

  it("refs serialise without text() and hydrate back", async () => {
    const ref = await store.put("k", "payload");
    const json = JSON.parse(JSON.stringify(ref));
    expect(Object.keys(json).sort()).toEqual(["bytes", "contentType", "sha256", "uri"]);
    expect(await store.hydrate(json).text()).toBe("payload");
  });

  it("uses a custom prefix", async () => {
    const custom = s3Artifacts({
      bucket: BUCKET,
      endpoint: s3.endpoint,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      prefix: "deploy-1/evidence",
    });
    const ref = await custom.put("k", "p");
    expect(ref.uri).toMatch(new RegExp(`^s3://${BUCKET}/deploy-1/evidence/sha256/[0-9a-f]{2}/[0-9a-f]{64}$`));
    await expect(store.read(ref.uri)).rejects.toThrow(/prefix "selfbuilding"/);
  });

  it("refuses a body over 100 MiB without a request", async () => {
    const err = await store.put("big", new Uint8Array(MAX_BODY_BYTES + 1)).catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactError);
    expect(s3.requests).toHaveLength(0);
  });

  it("rejects uris from another bucket, prefix or scheme without a request", async () => {
    const hash = sha("x");
    for (const uri of [
      `s3://other-bucket/selfbuilding/sha256/${hash.slice(0, 2)}/${hash}`,
      `s3://${BUCKET}/elsewhere/sha256/${hash.slice(0, 2)}/${hash}`,
      `s3://${BUCKET}/selfbuilding/sha256/zz/${hash}`,
      `s3://${BUCKET}/selfbuilding/sha256/${hash.slice(0, 2)}/../../secret`,
      `file:///tmp/sha256/${hash.slice(0, 2)}/${hash}`,
    ]) {
      await expect(store.read(uri)).rejects.toBeInstanceOf(ArtifactError);
      await expect(store.signedUrl(uri)).rejects.toBeInstanceOf(ArtifactError);
    }
    expect(s3.requests).toHaveLength(0);
  });

  it("a missing object is an ArtifactError naming the S3 code, not retried", async () => {
    const hash = sha("never stored");
    const err = await store.read(`s3://${BUCKET}/selfbuilding/sha256/${hash.slice(0, 2)}/${hash}`).catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactError);
    expect(err.code).toBe("artifact_failed");
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/HTTP 404 \(NoSuchKey\)/);
    expect(s3.requests).toHaveLength(1);
  });
});

describe("retries", () => {
  it("retries 5xx, 429 and dropped connections, then succeeds", async () => {
    s3.faults.push({ method: "HEAD", status: 503 }, { method: "HEAD", status: 429 }, { method: "PUT", drop: true });
    const ref = await store.put("k", "retry me");
    expect(s3.requests.map((r) => r.method)).toEqual(["HEAD", "HEAD", "HEAD", "PUT", "PUT"]);
    expect(await ref.text()).toBe("retry me");
  });

  it("gives up after three attempts", async () => {
    const ref = await store.put("k", "v");
    s3.requests.length = 0;
    s3.faults.push({ status: 500 }, { status: 502 }, { status: 503 }, { status: 504 });
    const err = await store.read(ref.uri).catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactError);
    expect(err.message).toMatch(/HTTP 503.*Gave up after 3 attempts/);
    expect(s3.requests).toHaveLength(3);
  });

  it("never retries a 4xx other than 429", async () => {
    const ref = await store.put("k", "v");
    s3.requests.length = 0;
    s3.faults.push({ status: 400 });
    await expect(store.read(ref.uri)).rejects.toThrow(/HTTP 400/);
    expect(s3.requests).toHaveLength(1);
  });

  it("honours retry.attempts", async () => {
    const one = s3Artifacts({
      bucket: BUCKET,
      endpoint: s3.endpoint,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      retry: { attempts: 1 },
    });
    s3.faults.push({ status: 503 });
    await expect(one.put("k", "v")).rejects.toThrow(/Gave up after 1 attempts/);
    expect(s3.requests).toHaveLength(1);
  });
});

describe("credentials", () => {
  it("resolves secret resolvers once across calls", async () => {
    let calls = 0;
    const lazy = s3Artifacts({
      bucket: BUCKET,
      endpoint: s3.endpoint,
      accessKeyId: async () => {
        calls++;
        return ACCESS;
      },
      secretAccessKey: async () => SECRET,
    });
    const ref = await lazy.put("a", "1");
    await lazy.put("b", "2");
    await lazy.read(ref.uri);
    await lazy.signedUrl(ref.uri);
    expect(calls).toBe(1);
  });

  it("a wrong key is a 403 whose message carries no secret", async () => {
    const wrong = s3Artifacts({
      bucket: BUCKET,
      endpoint: s3.endpoint,
      accessKeyId: ACCESS,
      secretAccessKey: `${SECRET}-wrong`,
    });
    const err = await wrong.put("k", "v").catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactError);
    expect(err.message).toMatch(/HTTP 403.*Check the access key/);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain(ACCESS);
    expect(JSON.stringify(err)).not.toContain(SECRET);
    expect(s3.requests).toHaveLength(1);
  });

  it("an empty resolved secret is a ConfigError and is retried on the next call", async () => {
    let value = "";
    const flaky = s3Artifacts({
      bucket: BUCKET,
      endpoint: s3.endpoint,
      accessKeyId: ACCESS,
      secretAccessKey: async () => value,
    });
    await expect(flaky.put("k", "v")).rejects.toBeInstanceOf(ConfigError);
    value = SECRET;
    await expect(flaky.put("k", "v")).resolves.toBeDefined();
  });
});

describe("signedUrl", () => {
  it("presigns a GET that a plain fetch can read, valid for a day by default", async () => {
    const ref = await store.put("k", "public evidence", { contentType: "text/plain" });
    const url = await store.signedUrl(ref.uri);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("86400");
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url).not.toContain(SECRET);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("public evidence");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(s3.requests.at(-1)?.auth).toBe("query");
  });

  it("is GET only: the same URL cannot write", async () => {
    const ref = await store.put("k", "v");
    const url = await store.signedUrl(ref.uri);
    const response = await fetch(url, { method: "PUT", body: "overwrite" });
    expect(response.status).toBe(403);
    expect(await store.hydrate(ref).text()).toBe("v");
  });

  it("takes expiresIn and expires", async () => {
    const ref = await store.put("k", "v");
    const url = await store.signedUrl(ref.uri, { expiresIn: "1h" });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("3600");
    expect((await fetch(url)).status).toBe(200);
    s3.clockSkewS = 3601;
    expect((await fetch(url)).status).toBe(403);
  });

  it("accepts 7d and refuses anything longer with ConfigError", async () => {
    const ref = await store.put("k", "v");
    const max = await store.signedUrl(ref.uri, { expiresIn: "7d" });
    expect(new URL(max).searchParams.get("X-Amz-Expires")).toBe("604800");
    expect(new URL(await store.signedUrl(ref.uri, { expiresIn: 90_000 })).searchParams.get("X-Amz-Expires")).toBe("90");
    await expect(store.signedUrl(ref.uri, { expiresIn: "8d" })).rejects.toBeInstanceOf(ConfigError);
    await expect(store.signedUrl(ref.uri, { expiresIn: "169h" })).rejects.toThrow(/at most "7d"/);
    await expect(store.signedUrl(ref.uri, { expiresIn: "soon" as never })).rejects.toBeInstanceOf(ConfigError);
  });

  it("uses the store's urlTtl and validates it up front", async () => {
    const short = s3Artifacts({
      bucket: BUCKET,
      endpoint: s3.endpoint,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      urlTtl: "15m",
    });
    const ref = await short.put("k", "v");
    expect(new URL(await short.signedUrl(ref.uri)).searchParams.get("X-Amz-Expires")).toBe("900");
    expect(() =>
      s3Artifacts({
        bucket: BUCKET,
        endpoint: s3.endpoint,
        accessKeyId: ACCESS,
        secretAccessKey: SECRET,
        urlTtl: "8d",
      }),
    ).toThrow(ConfigError);
  });

  it("downloadAs makes the response an attachment", async () => {
    const ref = await store.put("k", "{}", { contentType: "application/json" });
    const url = await store.signedUrl(ref.uri, { downloadAs: "evidence.json" });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="evidence.json"');
    const odd = await store.signedUrl(ref.uri, { downloadAs: 'rés"umé.txt' });
    expect((await fetch(odd)).headers.get("content-disposition")).toBe(
      `attachment; filename="r_s_um_.txt"; filename*=UTF-8''r%C3%A9s%22um%C3%A9.txt`,
    );
  });

  it("is never journaled: refs carry no URL", async () => {
    const ref = await store.put("k", "v");
    await store.signedUrl(ref.uri);
    expect(JSON.stringify(ref)).not.toMatch(/X-Amz/);
  });
});

describe("signing", () => {
  it("aws4fetch reproduces the AWS documented presigned-URL example", async () => {
    // From the S3 SigV4 docs, "Example: presigned URL" (examplebucket/test.txt, 2013-05-24, 86400 s).
    const aws = new AwsClient({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      service: "s3",
      region: "us-east-1",
    });
    const signed = await aws.sign("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Expires=86400", {
      method: "GET",
      aws: { signQuery: true, datetime: "20130524T000000Z" },
    });
    expect(new URL(signed.url).searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("contentDisposition escapes quotes and keeps the exact name", () => {
    expect(contentDisposition("a.txt")).toBe('attachment; filename="a.txt"');
    expect(contentDisposition('a"b.txt')).toBe("attachment; filename=\"a_b.txt\"; filename*=UTF-8''a%22b.txt");
  });
});

describe("r2Artifacts", () => {
  const capture = () => {
    const seen: Request[] = [];
    const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(input as Request);
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    return { seen, fakeFetch };
  };

  it("targets the account endpoint path-style with region auto", async () => {
    const { seen, fakeFetch } = capture();
    const r2 = r2Artifacts({
      accountId: ACCOUNT,
      bucket: DEFAULT_R2_BUCKET,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      fetch: fakeFetch,
    });
    await r2.put("k", "v").catch(() => undefined);
    const first = seen[0];
    expect(first?.method).toBe("HEAD");
    expect(first?.url).toBe(
      `https://${ACCOUNT}.r2.cloudflarestorage.com/${DEFAULT_R2_BUCKET}/selfbuilding/sha256/${sha("v").slice(0, 2)}/${sha("v")}`,
    );
    expect(first?.headers.get("authorization")).toMatch(new RegExp(`Credential=${ACCESS}/\\d{8}/auto/s3/aws4_request`));
    const url = await r2.signedUrl(`s3://${DEFAULT_R2_BUCKET}/selfbuilding/sha256/${sha("v").slice(0, 2)}/${sha("v")}`);
    expect(url.startsWith(`https://${ACCOUNT}.r2.cloudflarestorage.com/${DEFAULT_R2_BUCKET}/`)).toBe(true);
  });

  it("refuses a malformed account id", () => {
    expect(() =>
      r2Artifacts({ accountId: "acct", bucket: BUCKET, accessKeyId: ACCESS, secretAccessKey: SECRET }),
    ).toThrow(ConfigError);
  });

  it("from env: lists every missing name at once and never echoes values", () => {
    const err = (() => {
      try {
        r2ArtifactsFromEnv({ R2_ACCESS_KEY_ID: ACCESS });
      } catch (e) {
        return e as MissingSecretError;
      }
    })();
    expect(err).toBeInstanceOf(MissingSecretError);
    expect(err?.secret).toBe("R2_ACCOUNT_ID, R2_SECRET_ACCESS_KEY");
    expect(err?.message).not.toContain(ACCESS);
    expect(() => r2ArtifactsFromEnv({})).toThrow(/R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);
  });

  it("from env: default bucket, R2_BUCKET, then opts.bucket", async () => {
    const env = { R2_ACCOUNT_ID: ACCOUNT, R2_ACCESS_KEY_ID: ACCESS, R2_SECRET_ACCESS_KEY: SECRET };
    const bucketOf = async (s: SignedArtifactStore, seen: Request[]) => {
      await s.put("k", "v").catch(() => undefined);
      return new URL(seen.at(-1)?.url ?? "").pathname.split("/")[1];
    };
    let c = capture();
    expect(await bucketOf(r2ArtifactsFromEnv(env, { fetch: c.fakeFetch }), c.seen)).toBe(DEFAULT_R2_BUCKET);
    c = capture();
    expect(
      await bucketOf(r2ArtifactsFromEnv({ ...env, R2_BUCKET: "env-bucket" }, { fetch: c.fakeFetch }), c.seen),
    ).toBe("env-bucket");
    c = capture();
    const s = r2ArtifactsFromEnv(
      { ...env, R2_BUCKET: "env-bucket" },
      { fetch: c.fakeFetch, bucket: "opt-bucket", prefix: "dep" },
    );
    expect(await bucketOf(s, c.seen)).toBe("opt-bucket");
    expect(new URL(c.seen.at(-1)?.url ?? "").pathname).toMatch(/^\/opt-bucket\/dep\/sha256\//);
  });

  it("plugs into config as the run's artifact store", () => {
    const config = defineConfig({
      artifacts: r2ArtifactsFromEnv(
        { R2_ACCOUNT_ID: ACCOUNT, R2_ACCESS_KEY_ID: ACCESS, R2_SECRET_ACCESS_KEY: SECRET },
        { prefix: "deployment-1" },
      ),
    });
    expect(typeof config.artifacts?.signedUrl).toBe("function");
  });
});

describe("options", () => {
  const base = {
    bucket: BUCKET,
    endpoint: "https://example.r2.cloudflarestorage.com",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
  };
  it.each([
    ["bucket", { bucket: "Bad_Bucket" }],
    ["endpoint", { endpoint: "not a url" }],
    ["endpoint path", { endpoint: "https://x.example.com/bucket" }],
    ["prefix slash", { prefix: "/lead" }],
    ["prefix trailing", { prefix: "trail/" }],
    ["prefix empty", { prefix: "" }],
    ["prefix double", { prefix: "a//b" }],
    ["access key", { accessKeyId: "" }],
    ["attempts", { retry: { attempts: 0 } }],
    ["urlTtl", { urlTtl: "1ms" as never }],
  ])("refuses a bad %s with ConfigError", (_name, patch) => {
    let thrown: unknown;
    try {
      s3Artifacts({ ...base, ...patch });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown).toBeInstanceOf(SelfbuildingError);
    expect((thrown as Error).message).not.toContain(SECRET);
  });
});
