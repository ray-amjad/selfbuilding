import { ChannelDeliveryError } from "@selfbuilding/core";

export interface SlackApiOptions {
  /** Base URL ending in `/api`. */
  baseUrl: string;
  token: () => Promise<string>;
  fetch: typeof fetch;
  /** Extra attempts after the first, for 429, 5xx, `ratelimited` and network failures. */
  retries: number;
  /** Backoff base; doubled per attempt. A 429's Retry-After wins when it is longer. */
  retryDelayMs: number;
}

/** Slack error codes whose fix the user has to make. The message says what to do. */
const HINTS: Record<string, string> = {
  not_in_channel: "Invite the Selfbuilding bot to the channel (/invite @selfbuilding).",
  channel_not_found: "Check the channel id or name, and that the bot can see it.",
  invalid_auth: "Check the bot token (xoxb-...).",
  not_authed: "Pass a bot token, or set SLACK_BOT_TOKEN.",
  missing_scope: "Add the missing scope from the app manifest and reinstall the app.",
  account_inactive: "The bot token belongs to a deactivated app or user. Reinstall the app.",
};

const RETRYABLE_ERRORS = new Set(["ratelimited", "internal_error", "fatal_error", "service_unavailable"]);

/** A minimal Slack Web API client: JSON bodies, bearer auth, bounded retries, typed failures. */
export class SlackApi {
  constructor(private readonly opts: SlackApiOptions) {}

  async call<T extends Record<string, unknown>>(method: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.opts.token();
    let lastProblem = "";
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      let waitMs = this.opts.retryDelayMs * 2 ** attempt;
      try {
        const response = await this.opts.fetch(`${this.opts.baseUrl}/${method}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
        });
        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get("retry-after"));
          if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.max(waitMs, retryAfter * 1000);
          lastProblem = `HTTP ${response.status}`;
          await response.body?.cancel();
        } else {
          const parsed = (await response.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
          if (parsed?.ok === true) return parsed;
          const error = parsed?.error ?? `HTTP ${response.status}`;
          if (!RETRYABLE_ERRORS.has(error)) {
            const hint = HINTS[error];
            throw new ChannelDeliveryError(`Slack ${method} failed: ${error}.${hint ? ` ${hint}` : ""}`);
          }
          lastProblem = error;
        }
      } catch (error) {
        if (error instanceof ChannelDeliveryError) throw error;
        lastProblem = error instanceof Error ? error.message : String(error);
      }
      if (attempt < this.opts.retries) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    throw new ChannelDeliveryError(
      `Slack ${method} failed after ${this.opts.retries + 1} attempts: ${lastProblem}. Slack may be down or rate limiting; the call can be retried.`,
    );
  }
}
