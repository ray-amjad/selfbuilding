// Live acceptance 8: the R2 artifact store against the real bucket: put, read, idempotent put, a signed URL
// that a plain fetch can read, and the expiry bound. Objects land under a per-run prefix so runs never collide.
import { randomUUID } from "node:crypto";
import { r2ArtifactsFromEnv } from "@selfbuilding/artifacts-s3";
import { ConfigError } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { needs } from "./support/live.js";

const missing = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter((n) => !process.env[n]);
const skip = needs(missing.length > 0 && `set ${missing.join(", ")} (from Infisical) to run the R2 case`);

describe.skipIf(skip !== "")(`live: R2 artifact store${skip ? ` (skipped: ${skip})` : ""}`, () => {
  const prefix = `selfbuilding-live/${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
  const store = () => r2ArtifactsFromEnv(process.env, { prefix });

  it("puts, reads back, and a second put uploads nothing", async () => {
    const s = store();
    const body = `live evidence ${randomUUID()}\n`;
    const ref = await s.put("live/evidence.txt", body, { contentType: "text/plain; charset=utf-8" });
    expect(ref.uri.startsWith(`s3://${process.env.R2_BUCKET || "selfbuilding-artifacts"}/${prefix}/sha256/`)).toBe(
      true,
    );
    expect(await ref.text()).toBe(body);
    const again = await s.put("live/evidence-copy.txt", body);
    expect(JSON.stringify(again)).toBe(JSON.stringify(ref));
    expect(again.contentType).toBe("text/plain; charset=utf-8");
  });

  it("a signed URL serves the bytes to a plain fetch, as an attachment when asked", async () => {
    const s = store();
    const body = JSON.stringify({ ok: true, id: randomUUID() });
    const ref = await s.put("live/result.json", body, { contentType: "application/json" });
    const inline = await fetch(await s.signedUrl(ref.uri, { expiresIn: "5m" }));
    expect(inline.status).toBe(200);
    expect(await inline.text()).toBe(body);
    const attached = await fetch(await s.signedUrl(ref.uri, { downloadAs: "result.json" }));
    expect(attached.status).toBe(200);
    expect(attached.headers.get("content-disposition")).toContain('filename="result.json"');
    const unsigned = await fetch((await s.signedUrl(ref.uri)).split("?")[0] as string);
    expect(unsigned.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses an expiry beyond 7 days and accepts exactly 7 days", async () => {
    const s = store();
    const ref = await s.put("live/ttl.txt", "ttl");
    await expect(s.signedUrl(ref.uri, { expiresIn: "8d" })).rejects.toBeInstanceOf(ConfigError);
    const url = await s.signedUrl(ref.uri, { expiresIn: "7d" });
    expect((await fetch(url)).status).toBe(200);
  });
});
