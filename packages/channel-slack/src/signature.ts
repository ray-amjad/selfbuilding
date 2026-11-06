import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookSignatureError } from "@selfbuilding/core";

/** Slack rejects requests older than five minutes; so do we, in both directions, to bound replays. */
export const SLACK_MAX_SKEW_SECONDS = 300;

export interface SlackSignatureInput {
  signingSecret: string;
  /** `X-Slack-Request-Timestamp`, in seconds. */
  timestamp: string | null;
  /** `X-Slack-Signature`, `v0=<hex>`. */
  signature: string | null;
  rawBody: Uint8Array | string;
  /** Seconds since the epoch. Defaults to the wall clock. */
  nowSeconds?: number;
}

/** Computes `v0=<hex>` the way Slack signs a request: HMAC-SHA256 over `v0:<timestamp>:<raw body>`. */
export function signSlackRequest(
  signingSecret: string,
  timestamp: string | number,
  rawBody: Uint8Array | string,
): string {
  const hmac = createHmac("sha256", signingSecret);
  hmac.update(`v0:${timestamp}:`);
  hmac.update(rawBody);
  return `v0=${hmac.digest("hex")}`;
}

/**
 * Verifies a Slack request signature and its timestamp skew. Throws `WebhookSignatureError` naming what
 * failed; the message never includes the expected digest.
 */
export function verifySlackSignature(input: SlackSignatureInput): void {
  const { timestamp, signature } = input;
  if (!timestamp || !signature) {
    throw new WebhookSignatureError("The request has no X-Slack-Signature or X-Slack-Request-Timestamp header.");
  }
  if (!/^\d{1,12}$/.test(timestamp)) {
    throw new WebhookSignatureError("X-Slack-Request-Timestamp is not a whole number of seconds.");
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = Math.abs(now - Number(timestamp));
  if (skew > SLACK_MAX_SKEW_SECONDS) {
    throw new WebhookSignatureError(
      `The Slack request timestamp is ${skew}s away from this server's clock (limit ${SLACK_MAX_SKEW_SECONDS}s). Check the server clock if this repeats.`,
    );
  }
  if (!signature.startsWith("v0=")) {
    throw new WebhookSignatureError("X-Slack-Signature is not a v0 signature.");
  }
  const expected = Buffer.from(signSlackRequest(input.signingSecret, timestamp, input.rawBody));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new WebhookSignatureError(
      "X-Slack-Signature does not match the body. Check that the handler sees the raw body and the signing secret is the app's.",
    );
  }
}
