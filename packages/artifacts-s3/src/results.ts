import {
  ArtifactError,
  ConfigError,
  type Json,
  MissingSecretError,
  type ResultStore,
  type Secret,
} from "@selfbuilding/core";
import { AwsClient } from "aws4fetch";
import type { R2ArtifactsOptions, S3ArtifactsOptions } from "./index.js";
import { DEFAULTS, validateOptions } from "./store.js";

// A ResultStore in an S3-compatible bucket, so every machine of a deployed Trigger.dev project shares run records,
// outcomes, fences and asks (docs/spec/release-prep.md §3.1). Owner: trigger-deployed.
//
// Every write is conditional: create-if-absent is `PUT` with `If-None-Match: *`, compare-and-set is `PUT` with
// `If-Match: <etag>`, and the ETag is the version. A bucket that ignores those headers is refused by the Trigger
// host's conditional-write probe before the first task runs.

export interface S3ResultStoreOptions extends Omit<S3ArtifactsOptions, "urlTtl"> {
  /** Key prefix inside the bucket. Default "selfbuilding/results". No leading or trailing "/". */
  prefix?: string;
}

export interface R2ResultStoreOptions extends Omit<R2ArtifactsOptions, "urlTtl"> {
  /** Default "selfbuilding/results". */
  prefix?: string;
}

const DEFAULT_PREFIX = "selfbuilding/results";
/** Pages of ListObjectsV2 one `list()` follows before it decides the bucket is answering in a loop. */
const MAX_LIST_PAGES = 10_000;

/** Create-if-absent with `If-None-Match: *`, compare-and-set with `If-Match: <etag>`; the ETag is the version. */
export function s3ResultStore(opts: S3ResultStoreOptions): ResultStore {
  if (opts === null || typeof opts !== "object") throw new ConfigError("s3ResultStore needs an options object.");
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  try {
    validateOptions({ ...opts, prefix });
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(error.message.replace(/^s3Artifacts:/, "s3ResultStore:"));
    throw error;
  }
  const attempts = opts.retry?.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = opts.retry?.baseDelayMs ?? DEFAULTS.baseDelayMs;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new ConfigError(`s3ResultStore: retry.attempts must be a whole number of at least 1; got ${attempts}.`);
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new ConfigError(`s3ResultStore: retry.baseDelayMs must be a non-negative number; got ${baseDelayMs}.`);
  }
  return createResultStore({
    bucket: opts.bucket,
    origin: new URL(opts.endpoint).origin,
    region: opts.region ?? DEFAULTS.region,
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    prefix,
    fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    attempts,
    baseDelayMs,
  });
}

/** Cloudflare R2. */
export function r2ResultStore(opts: R2ResultStoreOptions): ResultStore {
  if (opts === null || typeof opts !== "object") throw new ConfigError("r2ResultStore needs an options object.");
  const { accountId, ...rest } = opts;
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new ConfigError(
      `r2ResultStore: accountId must be the 32-character Cloudflare account id (dashboard > R2 > Account details); got ${JSON.stringify(accountId)}.`,
    );
  }
  return s3ResultStore({ ...rest, endpoint: `https://${accountId}.r2.cloudflarestorage.com`, region: "auto" });
}

/** R2 from the same `R2_*` env names as `r2ArtifactsFromEnv`. Missing names throw MissingSecretError. */
export function r2ResultStoreFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  opts?: { bucket?: string; prefix?: string; fetch?: typeof fetch },
): ResultStore {
  if (env === null || typeof env !== "object") {
    throw new ConfigError("r2ResultStoreFromEnv needs an env record, e.g. process.env.");
  }
  // The same names as r2ArtifactsFromEnv (R2_ENV in index.ts), spelled out to keep this module free of a cycle.
  const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) throw new MissingSecretError({ secret: missing.join(", ") });
  return r2ResultStore({
    accountId: env.R2_ACCOUNT_ID as string,
    accessKeyId: env.R2_ACCESS_KEY_ID as string,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
    bucket: opts?.bucket ?? (env.R2_BUCKET || "selfbuilding-artifacts"),
    ...(opts?.prefix !== undefined ? { prefix: opts.prefix } : {}),
    ...(opts?.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
}

interface ResultStoreInternals {
  bucket: string;
  origin: string;
  region: string;
  accessKeyId: Secret;
  secretAccessKey: Secret;
  prefix: string;
  fetch: typeof fetch;
  attempts: number;
  baseDelayMs: number;
}

/** One store-key segment as it appears in the object key. Dots-only segments are encoded so no URL folds them. */
function encodeSegment(segment: string): string {
  if (segment === "." || segment === "..") return segment.replace(/\./g, "%2E");
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "amp") return "&";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Method = "GET" | "PUT";

function createResultStore(o: ResultStoreInternals): ResultStore {
  let client: Promise<AwsClient> | undefined;
  // Secrets resolve once, on first use; a failed resolve is retried on the next call rather than cached.
  const getClient = (): Promise<AwsClient> => {
    if (!client) {
      client = (async () => {
        const resolve = async (s: Secret) => (typeof s === "function" ? await s() : s);
        const [accessKeyId, secretAccessKey] = await Promise.all([resolve(o.accessKeyId), resolve(o.secretAccessKey)]);
        if (!accessKeyId || !secretAccessKey) {
          throw new ConfigError("s3ResultStore: the access key resolver returned an empty value.");
        }
        return new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: o.region, retries: 0 });
      })();
      client.catch(() => {
        client = undefined;
      });
    }
    return client;
  };

  const objectKeyOf = (key: string): string => {
    if (typeof key !== "string" || key === "") throw new ConfigError("Result store keys must be non-empty strings.");
    const segments = key.split("/");
    if (segments.some((s) => s === "")) {
      throw new ConfigError(`Result store key "${key}" has an empty segment; use "a/b", not "a//b" or "/a".`);
    }
    return `${o.prefix}/${segments.map(encodeSegment).join("/")}`;
  };

  /** The object key as it goes on the URL path: S3 reads the path decoded once, so `%` in the key travels as `%25`. */
  const urlOf = (objectKey: string): string =>
    `${o.origin}/${o.bucket}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  const where = (method: string, objectKey: string) => `${method} s3://${o.bucket}/${objectKey}`;

  /**
   * One request with retries on network errors, 429 and 5xx. Never retries any other status, so a 412 comes back
   * at once. `retried` tells a conditional write that an earlier attempt may have landed.
   */
  const send = async (
    method: Method,
    url: string,
    label: string,
    init: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ response: Response; retried: boolean }> => {
    const aws = await getClient();
    let last = "";
    let cause: unknown;
    for (let attempt = 0; attempt < o.attempts; attempt++) {
      if (attempt > 0) await sleep(Math.random() * o.baseDelayMs * 2 ** (attempt - 1));
      let response: Response;
      try {
        const signed = await aws.sign(url, {
          method,
          ...(init.headers ? { headers: init.headers } : {}),
          ...(init.body !== undefined ? { body: init.body } : {}),
        });
        response = await o.fetch(signed);
      } catch (error) {
        cause = error;
        last = `failed: ${(error as Error).message}`;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        last = `failed with HTTP ${response.status}`;
        continue;
      }
      return { response, retried: attempt > 0 };
    }
    throw new ArtifactError(
      `Result store bucket "${o.bucket}": ${label} ${last}. Gave up after ${o.attempts} attempts.`,
      cause === undefined ? {} : { cause },
    );
  };

  const failure = async (label: string, response: Response) => {
    const text = await response.text().catch(() => "");
    const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1];
    return new ArtifactError(
      `Result store bucket "${o.bucket}": ${label} failed with HTTP ${response.status}${code ? ` (${code})` : ""}.${
        response.status === 403 ? " Check the access key and its permissions on the bucket." : ""
      }`,
    );
  };

  const read = async (key: string): Promise<{ text: string; etag: string } | null> => {
    const objectKey = objectKeyOf(key);
    const label = where("GET", objectKey);
    // fetch asks for gzip by default. R2 then compresses any object past a small size and weakens its ETag to
    // W/"…", and If-Match compares strongly, so every compare-and-set on that object would lose (a 412 forever).
    const { response } = await send("GET", urlOf(objectKey), label, { headers: { "accept-encoding": "identity" } });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) throw await failure(label, response);
    // A proxy that compresses anyway weakens the stored object's strong ETag; the opaque tag inside is unchanged.
    const etag = response.headers.get("etag")?.replace(/^W\//, "");
    const text = await response.text();
    if (!etag) {
      throw new ArtifactError(
        `Result store bucket "${o.bucket}": ${label} returned no ETag, so compare-and-set cannot work. Use a bucket that returns ETags (S3, R2).`,
      );
    }
    return { text, etag };
  };

  const parse = <T>(text: string, key: string): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ArtifactError(`Result store bucket "${o.bucket}": the object for "${key}" is not JSON.`);
    }
  };

  /** A conditional PUT. False on 412 (or 409, a concurrent conditional write), unless our own retry had landed. */
  const conditionalPut = async (key: string, value: Json, condition: Record<string, string>): Promise<boolean> => {
    const objectKey = objectKeyOf(key);
    const label = where("PUT", objectKey);
    const body = JSON.stringify(value);
    const { response, retried } = await send("PUT", urlOf(objectKey), label, {
      headers: { "content-type": "application/json", ...condition },
      body,
    });
    if (response.status === 412 || response.status === 409) {
      await response.body?.cancel();
      // An attempt that failed in transit may have been applied: the object then holds exactly this body.
      if (retried) return (await read(key))?.text === body;
      return false;
    }
    if (!response.ok) throw await failure(label, response);
    await response.body?.cancel();
    return true;
  };

  return {
    async get<T extends Json>(key: string): Promise<T | null> {
      const got = await read(key);
      return got ? parse<T>(got.text, key) : null;
    },
    createIfAbsent(key, value) {
      return conditionalPut(key, value, { "if-none-match": "*" });
    },
    async getVersioned<T extends Json>(key: string) {
      const got = await read(key);
      return got ? { value: parse<T>(got.text, key), version: got.etag } : null;
    },
    replace(key, value, expectVersion) {
      return conditionalPut(
        key,
        value,
        expectVersion === null ? { "if-none-match": "*" } : { "if-match": expectVersion },
      );
    },
    async *list(prefix: string) {
      if (typeof prefix !== "string") throw new ConfigError("ResultStore.list needs a string prefix.");
      // Each segment encodes alone, and encoding is per character, so an encoded prefix is a prefix of every
      // encoded key it covers. A trailing "/" stays a trailing "/".
      const parts = prefix.split("/");
      const last = parts.pop() as string;
      // The last segment may be partial (".fo" of ".foo"), so it never takes the whole-segment dot encoding.
      const objectPrefix = `${o.prefix}/${[...parts.map(encodeSegment), encodeSegment(`${last}x`).slice(0, -1)].join("/")}`;
      const keys: string[] = [];
      let token: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= MAX_LIST_PAGES) {
          throw new ArtifactError(
            `Result store bucket "${o.bucket}": listing "${prefix}" went past ${MAX_LIST_PAGES} pages.`,
          );
        }
        const url = new URL(`${o.origin}/${o.bucket}`);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", objectPrefix);
        if (token) url.searchParams.set("continuation-token", token);
        const label = `LIST s3://${o.bucket}/${objectPrefix}`;
        const { response } = await send("GET", url.href, label);
        if (!response.ok) throw await failure(label, response);
        const xml = await response.text();
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const raw = /<Key>([\s\S]*?)<\/Key>/.exec(match[1] ?? "")?.[1];
          if (raw === undefined) continue;
          const objectKey = unescapeXml(raw);
          if (!objectKey.startsWith(`${o.prefix}/`)) continue;
          keys.push(
            objectKey
              .slice(o.prefix.length + 1)
              .split("/")
              .map(decodeSegment)
              .join("/"),
          );
        }
        const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
        token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
        if (!truncated || !token) break;
        token = unescapeXml(token);
      }
      // Sorted by store key, as the file and memory stores list them; encoded order can differ.
      keys.sort();
      yield* keys;
    },
  };
}
