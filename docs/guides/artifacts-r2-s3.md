# Artifacts in R2 or S3

Everything an agent leaves behind (diffs, transcripts, logs, Verify's screenshots and evidence files) is stored in
the run's artifact store and referred to by an `ArtifactRef`. The default is a local folder. For runs on other
machines, or links you can post to Slack and PRs, use a bucket: `@selfbuilding/artifacts-s3` works with Cloudflare
R2 and any S3-compatible service, with SigV4 signing and no AWS SDK.

```ts
import { r2ArtifactsFromEnv } from "@selfbuilding/artifacts-s3";

export default defineConfig({
  artifacts: r2ArtifactsFromEnv(process.env, { prefix: "prod" }),
});
```

## R2

1. Create a bucket in the Cloudflare dashboard (the default name is `selfbuilding-artifacts`).
2. R2 > Manage API tokens > create a token with Object Read and Write on that bucket. Cloudflare shows an access
   key id and a secret access key for the S3 API.
3. Put these in your secret manager or `.env`:

| Variable | Value |
|---|---|
| `R2_ACCOUNT_ID` | Your Cloudflare account id (32 hex characters) |
| `R2_ACCESS_KEY_ID` | The token's access key id |
| `R2_SECRET_ACCESS_KEY` | The token's secret access key |
| `R2_BUCKET` | Optional; default `selfbuilding-artifacts` |

`r2ArtifactsFromEnv(env, { bucket?, prefix?, fetch? })` throws `MissingSecretError` listing every missing name at
once. `r2Artifacts({ accountId, bucket, accessKeyId, secretAccessKey, prefix?, urlTtl? })` takes the values
directly.

## Any S3-compatible bucket

```ts
import { s3Artifacts } from "@selfbuilding/artifacts-s3";

s3Artifacts({
  bucket: "my-artifacts",
  endpoint: "https://s3.eu-west-1.amazonaws.com",
  region: "eu-west-1",
  accessKeyId: fromEnv("S3_ACCESS_KEY_ID"),
  secretAccessKey: fromEnv("S3_SECRET_ACCESS_KEY"),
});
```

The two variable names are yours to choose; the keys are `Secret` values, resolved once and never logged or put in
an error message.

## How objects are stored

- Content-addressed: `<prefix>/sha256/<aa>/<sha256>`, uri `s3://<bucket>/<prefix>/sha256/<aa>/<sha256>`. A second
  `put` of the same bytes is one `HEAD` and no upload. `prefix` defaults to `selfbuilding`.
- Requests are path-style. Network errors, 429 and 5xx are retried three times with full-jitter backoff; other 4xx
  are not. One `PUT` per object, at most 100 MiB.
- The `put` key (for example `runs/<runId>/summary.html` for verifyFlows' summary page) is kept as the object's
  `x-amz-meta-selfbuilding-key` metadata; the object itself is still stored by content hash.

## Signed URLs

`store.signedUrl(uri, { expiresIn?, downloadAs? })` presigns a GET, never a PUT. The default expiry is `"1d"`
(`urlTtl` changes it) and the most is `"7d"`, the SigV4 maximum; longer is a `ConfigError`. `downloadAs` sets
`content-disposition: attachment` with that file name.

URLs are made when a message is posted (Slack, a PR, the run summary) and are never stored in journals or
results, because they expire. A link in an old message stops working after its expiry; the object stays.

## A bucket lifecycle rule

Artifacts accumulate. Add a lifecycle rule that deletes them after the longest time you might still resume or
inspect a run (for example 30 days):

- **R2:** bucket > Settings > Object lifecycle rules > Add rule, prefix `<prefix>/sha256/`, delete objects after
  N days.
- **S3:** Management > Lifecycle rules, the same prefix, expire current versions after N days.

Scope the rule to the `sha256/` prefix. If the same bucket also holds a Trigger.dev result store (default prefix
`selfbuilding/results`), a rule on the bare `selfbuilding/` prefix would delete run records of live runs.

## Live test

`tests/live/8-artifacts-r2.test.ts` runs with `SELFBUILDING_LIVE=1` and the three `R2_*` keys: put, read, idempotent
put, a signed URL fetch and the expiry bound. Each run writes under `selfbuilding-live/<date>/<uuid>/`.
