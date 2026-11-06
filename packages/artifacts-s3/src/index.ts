// @selfbuilding/artifacts-s3: an S3-compatible ArtifactStore (docs/spec/demo-path.md §7). Owner: artifacts-r2.
import { type ArtifactStore, ConfigError, type Duration, MissingSecretError, type Secret } from "@selfbuilding/core";
import { createStore, DEFAULTS, expirySeconds, type RetryOptions, validateOptions } from "./store.js";

export {
  type R2ResultStoreOptions,
  r2ResultStore,
  r2ResultStoreFromEnv,
  type S3ResultStoreOptions,
  s3ResultStore,
} from "./results.js";
export type { RetryOptions } from "./store.js";

export interface S3ArtifactsOptions {
  bucket: string;
  /** "https://<account>.r2.cloudflarestorage.com" or "https://s3.<region>.amazonaws.com". */
  endpoint: string;
  /** Default "auto" (R2). */
  region?: string;
  accessKeyId: Secret;
  secretAccessKey: Secret;
  /** Key prefix inside the bucket, e.g. the deployment id. Default "selfbuilding". No leading or trailing "/". */
  prefix?: string;
  /** Default globalThis.fetch. Tests pass a fake. */
  fetch?: typeof fetch;
  /** Default expiry of `signedUrl`. Default "1d"; at most "7d". */
  urlTtl?: Duration;
  /** Retries on network errors, 429 and 5xx. Default 3 attempts with full-jitter backoff from 200 ms. */
  retry?: RetryOptions;
}

/** An ArtifactStore whose `signedUrl` is always present. */
export type SignedArtifactStore = ArtifactStore & Required<Pick<ArtifactStore, "signedUrl">>;

/** Any S3-compatible bucket. Content-addressed: `<prefix>/sha256/<aa>/<sha256>`, uri `s3://<bucket>/<key>`. */
export function s3Artifacts(opts: S3ArtifactsOptions): SignedArtifactStore {
  if (opts === null || typeof opts !== "object") throw new ConfigError("s3Artifacts needs an options object.");
  const prefix = opts.prefix ?? DEFAULTS.prefix;
  validateOptions({ ...opts, prefix });
  const urlTtl = opts.urlTtl ?? DEFAULTS.urlTtl;
  expirySeconds(urlTtl, "urlTtl");
  const attempts = opts.retry?.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = opts.retry?.baseDelayMs ?? DEFAULTS.baseDelayMs;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new ConfigError(`s3Artifacts: retry.attempts must be a whole number of at least 1; got ${attempts}.`);
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new ConfigError(`s3Artifacts: retry.baseDelayMs must be a non-negative number; got ${baseDelayMs}.`);
  }
  return createStore({
    bucket: opts.bucket,
    endpoint: opts.endpoint,
    region: opts.region ?? DEFAULTS.region,
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    prefix,
    fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    urlTtl,
    attempts,
    baseDelayMs,
  });
}

export interface R2ArtifactsOptions extends Omit<S3ArtifactsOptions, "endpoint" | "region"> {
  /** The Cloudflare account id; the endpoint is https://<accountId>.r2.cloudflarestorage.com. */
  accountId: string;
}

/** Cloudflare R2. */
export function r2Artifacts(opts: R2ArtifactsOptions): SignedArtifactStore {
  if (opts === null || typeof opts !== "object") throw new ConfigError("r2Artifacts needs an options object.");
  const { accountId, ...rest } = opts;
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new ConfigError(
      `r2Artifacts: accountId must be the 32-character Cloudflare account id (dashboard > R2 > Account details); got ${JSON.stringify(accountId)}.`,
    );
  }
  return s3Artifacts({ ...rest, endpoint: `https://${accountId}.r2.cloudflarestorage.com`, region: "auto" });
}

/** The default bucket for the selfbuilding deployment. */
export const DEFAULT_R2_BUCKET = "selfbuilding-artifacts";

/** The env names `r2ArtifactsFromEnv` reads. */
export const R2_ENV = {
  accountId: "R2_ACCOUNT_ID",
  accessKeyId: "R2_ACCESS_KEY_ID",
  secretAccessKey: "R2_SECRET_ACCESS_KEY",
  bucket: "R2_BUCKET",
} as const;

/**
 * R2 from an env record the caller passes (config files and the CLI; providers never read env). Missing names
 * throw MissingSecretError listing every missing one. Values are never logged.
 */
export function r2ArtifactsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  opts?: { bucket?: string; prefix?: string; fetch?: typeof fetch },
): SignedArtifactStore {
  if (env === null || typeof env !== "object") {
    throw new ConfigError("r2ArtifactsFromEnv needs an env record, e.g. process.env.");
  }
  const required = [R2_ENV.accountId, R2_ENV.accessKeyId, R2_ENV.secretAccessKey];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) throw new MissingSecretError({ secret: missing.join(", ") });
  return r2Artifacts({
    accountId: env[R2_ENV.accountId] as string,
    accessKeyId: env[R2_ENV.accessKeyId] as string,
    secretAccessKey: env[R2_ENV.secretAccessKey] as string,
    bucket: opts?.bucket ?? (env[R2_ENV.bucket] || DEFAULT_R2_BUCKET),
    ...(opts?.prefix !== undefined ? { prefix: opts.prefix } : {}),
    ...(opts?.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
}
