import {
  ArtifactError,
  type ArtifactRef,
  type ArtifactRefJson,
  ConfigError,
  type Duration,
  type Secret,
  type SignedUrlOptions,
} from "@selfbuilding/core";
import { AwsClient } from "aws4fetch";

/** Bodies above this are refused: one PUT only, no multipart (demo-path §7.2). */
export const MAX_BODY_BYTES = 100 * 1024 * 1024;
/** The SigV4 presign maximum. */
export const MAX_URL_TTL_MS = 7 * 86_400_000;
const DEFAULT_URL_TTL: Duration = "1d";
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 200;
const KEY_META = "x-amz-meta-selfbuilding-key";

export interface StoreOptions {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: Secret;
  secretAccessKey: Secret;
  prefix: string;
  fetch: typeof fetch;
  urlTtl: Duration;
  attempts: number;
  baseDelayMs: number;
  /** Fixed signing clock for test vectors; ISO basic format "YYYYMMDDTHHMMSSZ". */
  datetime?: () => string;
}

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Full-jitter backoff base. Default 200 ms. */
  baseDelayMs?: number;
}

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function durationMs(value: Duration, what: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new ConfigError(
        `${what} must be a non-negative number of milliseconds or a string like "1d"; got ${value}.`,
      );
    }
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(String(value));
  if (!match)
    throw new ConfigError(`${what} must look like "30s", "45m", "2h" or "1d", or be milliseconds; got "${value}".`);
  return Math.round(Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]);
}

/** Seconds for X-Amz-Expires, bounded by the SigV4 limits. */
export function expirySeconds(value: Duration, what: string): number {
  const ms = durationMs(value, what);
  if (ms > MAX_URL_TTL_MS) {
    throw new ConfigError(
      `${what} is ${String(value)}, but a signed URL lasts at most "7d" (the SigV4 limit). Use "7d" or less.`,
    );
  }
  if (ms < 1000) throw new ConfigError(`${what} must be at least "1s"; got ${String(value)}.`);
  return Math.ceil(ms / 1000);
}

export function validateOptions(o: {
  bucket: unknown;
  endpoint: unknown;
  prefix: unknown;
  accessKeyId: unknown;
  secretAccessKey: unknown;
}): void {
  // S3 bucket naming rules, simplified: lowercase, digits, dots and hyphens.
  if (typeof o.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(o.bucket)) {
    throw new ConfigError(
      `s3Artifacts: bucket must be an S3 bucket name (3-63 lowercase letters, digits, "." or "-"); got ${JSON.stringify(o.bucket)}.`,
    );
  }
  let url: URL;
  try {
    url = new URL(String(o.endpoint));
  } catch {
    throw new ConfigError(
      `s3Artifacts: endpoint must be an https URL like "https://<account>.r2.cloudflarestorage.com"; got ${JSON.stringify(o.endpoint)}.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`s3Artifacts: endpoint must be an http(s) URL; got ${url.protocol}.`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new ConfigError(
      `s3Artifacts: endpoint must be the bare service origin (no path or query); the bucket goes in "bucket". Got ${url.href}.`,
    );
  }
  if (typeof o.prefix !== "string" || o.prefix === "" || o.prefix.startsWith("/") || o.prefix.endsWith("/")) {
    throw new ConfigError(
      `s3Artifacts: prefix must be non-empty with no leading or trailing "/" (e.g. "selfbuilding"); got ${JSON.stringify(o.prefix)}.`,
    );
  }
  if (!/^[A-Za-z0-9!\-_.*'()/]+$/.test(o.prefix) || o.prefix.includes("//")) {
    throw new ConfigError(
      `s3Artifacts: prefix may use only letters, digits, "/" between segments and !-_.*'(); got ${JSON.stringify(o.prefix)}.`,
    );
  }
  for (const name of ["accessKeyId", "secretAccessKey"] as const) {
    const v = o[name];
    if (!(typeof v === "function" || (typeof v === "string" && v !== ""))) {
      throw new ConfigError(`s3Artifacts: ${name} must be a non-empty string or a resolver function.`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Header values must be ASCII; percent-encode anything else (and "%") so the key survives the round trip. */
function metaValue(key: string): string {
  return key.replace(/[^\x20-\x7e]|%/gu, (c) => encodeURIComponent(c));
}

/** RFC 6266 disposition with an ASCII fallback name and the exact UTF-8 name. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return ascii === name
    ? `attachment; filename="${ascii}"`
    : `attachment; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

export function createStore(o: StoreOptions) {
  const origin = new URL(o.endpoint).origin;
  const keyPattern = new RegExp(
    `^${o.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sha256/([0-9a-f]{2})/([0-9a-f]{64})$`,
  );
  const defaultTtl = expirySeconds(o.urlTtl, "urlTtl");
  let client: Promise<AwsClient> | undefined;

  // Secrets resolve once, on first use; a failed resolve is retried on the next call rather than cached.
  const getClient = (): Promise<AwsClient> => {
    if (!client) {
      client = (async () => {
        const resolve = async (s: Secret) => (typeof s === "function" ? await s() : s);
        const [accessKeyId, secretAccessKey] = await Promise.all([resolve(o.accessKeyId), resolve(o.secretAccessKey)]);
        if (!accessKeyId || !secretAccessKey) {
          throw new ConfigError("s3Artifacts: the access key resolver returned an empty value.");
        }
        return new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: o.region, retries: 0 });
      })();
      client.catch(() => {
        client = undefined;
      });
    }
    return client;
  };

  const objectUrl = (key: string) => `${origin}/${o.bucket}/${key}`;
  const uriOf = (key: string) => `s3://${o.bucket}/${key}`;

  const keyOf = (uri: string): string => {
    const head = `s3://${o.bucket}/`;
    if (typeof uri !== "string" || !uri.startsWith(head)) {
      throw new ArtifactError(`Artifact uri ${uri} is not in bucket ${o.bucket} of this store.`);
    }
    const key = uri.slice(head.length);
    if (!keyPattern.test(key)) {
      throw new ArtifactError(
        `Artifact uri ${uri} is not a content-addressed key under prefix "${o.prefix}" of this store.`,
      );
    }
    return key;
  };

  /** One S3 call with retries on network errors, 429 and 5xx. Never retries other 4xx. */
  const send = async (
    method: "GET" | "HEAD" | "PUT",
    key: string,
    init: { headers?: Record<string, string>; body?: Uint8Array } = {},
  ) => {
    const aws = await getClient();
    let lastError: unknown;
    for (let attempt = 0; attempt < o.attempts; attempt++) {
      if (attempt > 0) await sleep(Math.random() * o.baseDelayMs * 2 ** (attempt - 1));
      let response: Response;
      try {
        const signed = await aws.sign(objectUrl(key), {
          method,
          headers: init.headers,
          body: init.body,
          ...(o.datetime ? { aws: { datetime: o.datetime() } } : {}),
        });
        response = await o.fetch(signed);
      } catch (cause) {
        lastError = new ArtifactError(`${method} ${uriOf(key)} failed: ${(cause as Error).message}`, { cause });
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        lastError = new ArtifactError(`${method} ${uriOf(key)} failed with HTTP ${response.status}.`);
        continue;
      }
      return response;
    }
    throw new ArtifactError(
      `${lastError instanceof Error ? lastError.message : String(lastError)} Gave up after ${o.attempts} attempts.`,
      { cause: lastError },
    );
  };

  const failure = async (method: string, key: string, response: Response) => {
    const text = method === "HEAD" ? "" : await response.text().catch(() => "");
    const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1];
    return new ArtifactError(
      `${method} ${uriOf(key)} failed with HTTP ${response.status}${code ? ` (${code})` : ""}.${
        response.status === 403 ? " Check the access key and its permissions on the bucket." : ""
      }`,
    );
  };

  const decoder = new TextDecoder();

  const store = {
    async put(key: string, body: Uint8Array | string, opts?: { contentType?: string }): Promise<ArtifactRef> {
      if (!key) throw new ConfigError("ArtifactStore.put needs a key.");
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      if (bytes.length > MAX_BODY_BYTES) {
        throw new ArtifactError(
          `Artifact "${key}" is ${bytes.length} bytes; the S3 store takes at most ${MAX_BODY_BYTES} bytes per object. Store a smaller payload.`,
        );
      }
      const { createHash } = await import("node:crypto");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const objectKey = `${o.prefix}/sha256/${sha256.slice(0, 2)}/${sha256}`;
      let contentType =
        opts?.contentType ?? (typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream");

      const head = await send("HEAD", objectKey);
      if (head.ok && Number(head.headers.get("content-length")) === bytes.length) {
        contentType = head.headers.get("content-type") ?? contentType;
      } else {
        if (!head.ok && head.status !== 404) throw await failure("HEAD", objectKey, head);
        const put = await send("PUT", objectKey, {
          headers: {
            "content-type": contentType,
            [KEY_META]: metaValue(key),
          },
          body: bytes,
        });
        if (!put.ok) throw await failure("PUT", objectKey, put);
        await put.body?.cancel();
      }
      return store.hydrate({ uri: uriOf(objectKey), bytes: bytes.length, sha256, contentType });
    },

    async read(uri: string): Promise<Uint8Array> {
      const key = keyOf(uri);
      const response = await send("GET", key);
      if (!response.ok) throw await failure("GET", key, response);
      return new Uint8Array(await response.arrayBuffer());
    },

    hydrate(ref: ArtifactRefJson): ArtifactRef {
      const json: ArtifactRefJson = {
        uri: ref.uri,
        bytes: ref.bytes,
        sha256: ref.sha256,
        contentType: ref.contentType,
      };
      const hydrated = { ...json, text: async () => decoder.decode(await store.read(json.uri)) };
      // text() stays out of JSON so refs serialise into journals and outcomes unchanged.
      Object.defineProperty(hydrated, "text", { enumerable: false });
      return hydrated;
    },

    async signedUrl(uri: string, opts?: SignedUrlOptions): Promise<string> {
      const key = keyOf(uri);
      const seconds = opts?.expiresIn === undefined ? defaultTtl : expirySeconds(opts.expiresIn, "expiresIn");
      const url = new URL(objectUrl(key));
      url.searchParams.set("X-Amz-Expires", String(seconds));
      if (opts?.downloadAs !== undefined) {
        if (typeof opts.downloadAs !== "string" || opts.downloadAs === "") {
          throw new ConfigError("signedUrl: downloadAs must be a non-empty file name.");
        }
        url.searchParams.set("response-content-disposition", contentDisposition(opts.downloadAs));
      }
      const aws = await getClient();
      const signed = await aws.sign(url.href, {
        method: "GET",
        aws: { signQuery: true, ...(o.datetime ? { datetime: o.datetime() } : {}) },
      });
      return signed.url;
    },
  };
  return store;
}

export const DEFAULTS = {
  region: "auto",
  prefix: "selfbuilding",
  urlTtl: DEFAULT_URL_TTL,
  attempts: DEFAULT_ATTEMPTS,
  baseDelayMs: DEFAULT_BASE_DELAY_MS,
} as const;
