# @selfbuilding/artifacts-s3

An `ArtifactStore` for any S3-compatible bucket, with a preset for Cloudflare R2. Evidence from every sandbox
(diffs, transcripts, logs, screenshots) lands in the bucket through the normal settle step, and `signedUrl` makes
time-limited links for Slack messages, PR comments and run summaries.

```ts
// selfbuilding.config.ts
import { r2ArtifactsFromEnv } from "@selfbuilding/artifacts-s3";
import { defineConfig } from "@selfbuilding/core";

export default defineConfig({
  artifacts: r2ArtifactsFromEnv(process.env, { prefix: "my-deployment" }),
});
```

`r2ArtifactsFromEnv` reads `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and optionally `R2_BUCKET`
(default `selfbuilding-artifacts`). Missing names throw `MissingSecretError` listing all of them. Author the values in
your secret manager and pass them through its run wrapper; R2 S3 access keys are made in the Cloudflare dashboard
(R2 > Manage API tokens), not with wrangler.

- Objects are content-addressed: `<prefix>/sha256/<aa>/<sha256>`, uri `s3://<bucket>/<key>`. A second `put` of the
  same bytes is one `HEAD` and no upload. The `put` key is kept as `x-amz-meta-selfbuilding-key`.
- Requests are path-style and SigV4-signed (`aws4fetch`). Network errors, 429 and 5xx are retried three times with
  full-jitter backoff; other 4xx are not. One `PUT` per object, at most 100 MiB.
- `signedUrl(uri, { expiresIn?, downloadAs? })` presigns a GET only. Default `"1d"` (`urlTtl` changes it), at most
  `"7d"`. Make URLs when posting; never store them, they expire.
- For other S3 services use `s3Artifacts({ bucket, endpoint, region, accessKeyId, secretAccessKey })`.

## Result store for a deployed Trigger.dev project

The same package exports a `ResultStore`, so every machine of a deployed Trigger.dev project shares run records,
outcomes, fences and asks:

```ts
import { r2ResultStoreFromEnv } from "@selfbuilding/artifacts-s3";

const results = r2ResultStoreFromEnv(process.env, { prefix: "selfbuilding/results" });
```

- `r2ResultStoreFromEnv` reads the same `R2_*` names as `r2ArtifactsFromEnv`. `r2ResultStore({ accountId, ... })`
  and `s3ResultStore({ bucket, endpoint, ... })` take the values directly.
- Keys live under `prefix` (default `selfbuilding/results`). Every write is conditional: create-if-absent is `PUT`
  with `If-None-Match: *`, compare-and-set is `PUT` with `If-Match: <etag>`. A bucket that ignores those headers is
  refused by the Trigger host's probe before the first task runs.
- Keep lifecycle (expiry) rules off the result prefix; see `docs/guides/artifacts-r2-s3.md`.
