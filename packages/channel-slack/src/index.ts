import type {
  AskRecord,
  AskView,
  ChannelMessageRef,
  HitlChannel,
  InboundEvent,
  Notification,
  RunInfo,
  Secret,
  ThreadKey,
} from "@selfbuilding/core";
import { ChannelDeliveryError, MissingSecretError, WebhookSignatureError } from "@selfbuilding/core";
import { SlackApi } from "./api.js";
import { answerModal, askCard, notificationMessage, type Redact, rootCard, settledCard } from "./blocks.js";
import { formInputBlocks } from "./forms.js";
import { parseSlackRequest, threadId } from "./inbound.js";
import { verifySlackSignature } from "./signature.js";

export { ACTION, MODAL_CALLBACK_ID } from "./blocks.js";
export type { SlackInbound } from "./inbound.js";
export { parseSlackRequest } from "./inbound.js";
export { slackAppManifest } from "./manifest.js";
export { SLACK_MAX_SKEW_SECONDS, signSlackRequest, verifySlackSignature } from "./signature.js";
export { escapeMrkdwn, splitOrdinal } from "./text.js";

export interface SlackOptions {
  /** Channel id or "#name". */
  channel: string;
  /** Default: the SLACK_BOT_TOKEN environment variable, read at first use. */
  botToken?: Secret;
  /** Default: the SLACK_SIGNING_SECRET environment variable, read at first use. */
  signingSecret?: Secret;
  /** Override for tests against an emulator: the Web API base, with or without the trailing `/api`. */
  apiUrl?: string;
  /** Applied to every outbound string before it is escaped and truncated (spec §8.9). Default: identity. */
  redact?: (text: string) => string;
  /** Extra attempts for 429, 5xx and network failures. Default 3. */
  retries?: number;
  /** Backoff base in ms. Default 500. */
  retryDelayMs?: number;
  /** Minimum gap between live status-line edits of the root card. Default 15 s (chat.update is Tier 3). */
  statusIntervalMs?: number;
  /** Clock in ms, for the signature skew check and the status throttle. Default Date.now. */
  now?: () => number;
  fetch?: typeof fetch;
  /** Where skip lines and soft failures go. Default console.warn. */
  log?: (line: string) => void;
}

/** The Slack channel adds two inbound helpers the hooks handler uses when present. */
export interface SlackChannel extends HitlChannel {
  readonly id: "slack";
  /** Answers Slack's `url_verification` handshake; null for every other request. */
  handshake(req: Request, rawBody: Uint8Array): Response | null;
  /** Edits the live status line on the run's root card, at most once per `statusIntervalMs`. */
  status(thread: ThreadKey, line: string): Promise<boolean>;
}

const SLACK_API = "https://slack.com/api";

function secretGetter(secret: Secret | undefined, envName: string): () => Promise<string> {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= (async () => {
      const value = typeof secret === "function" ? await secret() : (secret ?? process.env[envName]);
      if (!value) throw new MissingSecretError({ secret: envName });
      return value;
    })();
    cached.catch(() => {
      cached = undefined;
    });
    return cached;
  };
}

function splitThread(thread: ThreadKey): { channel: string; ts: string } {
  const at = thread.id.indexOf(":");
  if (thread.channel !== "slack" || at <= 0) {
    throw new ChannelDeliveryError(
      `Thread ${thread.channel}/${thread.id} is not a Slack thread key. Pass the ThreadKey returned by openThread().`,
    );
  }
  return { channel: thread.id.slice(0, at), ts: thread.id.slice(at + 1) };
}

/** The Slack HITL channel: Block Kit buttons, thread replies, signing-secret verification (spec §8.6). */
export function slack(opts: SlackOptions): SlackChannel {
  const botToken = secretGetter(opts.botToken, "SLACK_BOT_TOKEN");
  const signingSecret = secretGetter(opts.signingSecret, "SLACK_SIGNING_SECRET");
  const redact: Redact = opts.redact ?? ((text) => text);
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const base = (opts.apiUrl ?? SLACK_API).replace(/\/+$/, "");
  const api = new SlackApi({
    baseUrl: base.endsWith("/api") ? base : `${base}/api`,
    token: botToken,
    fetch: opts.fetch ?? fetch,
    retries: opts.retries ?? 3,
    retryDelayMs: opts.retryDelayMs ?? 500,
  });
  const channelTarget = opts.channel.replace(/^#/, "");
  const statusInterval = opts.statusIntervalMs ?? 15_000;

  // Per-process caches only; every method still works without them after a restart.
  const runs = new Map<string, RunInfo>();
  const lastStatusAt = new Map<string, number>();
  let botUserId: string | undefined;

  const remember = (message: unknown) => {
    const user = (message as { user?: unknown } | undefined)?.user;
    if (typeof user === "string") botUserId ??= user;
  };

  const editRoot = async (thread: ThreadKey, run: RunInfo, state: { status?: string; line?: string }) => {
    const { channel, ts } = splitThread(thread);
    const card = rootCard({ run, ...state }, redact);
    await api.call("chat.update", { channel, ts, text: card.text, blocks: card.blocks });
  };

  return {
    id: "slack",

    async openThread(run) {
      const card = rootCard({ run }, redact);
      const posted = await api.call<{ channel: string; ts: string; message?: unknown }>("chat.postMessage", {
        channel: channelTarget,
        text: card.text,
        blocks: card.blocks,
        unfurl_links: false,
        unfurl_media: false,
      });
      remember(posted.message);
      const thread: ThreadKey = { channel: "slack", id: threadId(posted.channel, posted.ts) };
      runs.set(thread.id, run);
      return thread;
    },

    async post(ask: AskRecord, thread: ThreadKey): Promise<ChannelMessageRef> {
      const { channel, ts } = splitThread(thread);
      const card = askCard(ask, redact);
      const posted = await api.call<{ ts: string; message?: unknown }>("chat.postMessage", {
        channel,
        thread_ts: ts,
        reply_broadcast: true,
        text: card.text,
        blocks: card.blocks,
        unfurl_links: false,
        unfurl_media: false,
      });
      remember(posted.message);
      return { channel: "slack", thread, id: posted.ts };
    },

    async update(ref: ChannelMessageRef, view: AskView) {
      const { channel } = splitThread(ref.thread);
      const card = settledCard(view, redact);
      await api.call("chat.update", { channel, ts: ref.id, text: card.text, blocks: card.blocks });
    },

    async notify(thread: ThreadKey, n: Notification): Promise<ChannelMessageRef> {
      const { channel, ts } = splitThread(thread);
      const message = notificationMessage(n, redact);
      const targetUser = typeof n.data?.userId === "string" ? n.data.userId : undefined;
      if (n.kind === "refusal" && targetUser) {
        // Refusals go only to the person who acted (spec §8.7 rule 3).
        const posted = await api.call<{ message_ts?: string }>("chat.postEphemeral", {
          channel,
          user: targetUser,
          thread_ts: ts,
          text: message.text,
          blocks: message.blocks,
        });
        return { channel: "slack", thread, id: `ephemeral:${posted.message_ts ?? ""}` };
      }
      const posted = await api.call<{ ts: string; message?: unknown }>("chat.postMessage", {
        channel,
        thread_ts: ts,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      });
      remember(posted.message);
      if (n.kind === "run.end" || n.kind === "run.failed") {
        // The summary is a new message; only after it posts does the root card show the final status.
        const run =
          runs.get(thread.id) ??
          (typeof n.data?.runId === "string" && typeof n.data.factory === "string"
            ? { runId: n.data.runId, factory: n.data.factory }
            : undefined);
        const status = typeof n.data?.status === "string" ? n.data.status : n.kind === "run.failed" ? "failed" : "ok";
        if (run) {
          await editRoot(thread, run, { status }).catch((error: unknown) =>
            log(`skip [root-edit-failed] ${error instanceof Error ? error.message : String(error)}`),
          );
        } else log(`skip [root-unknown] thread ${thread.id}: no run info to rebuild the root card`);
      }
      return { channel: "slack", thread, id: posted.ts };
    },

    async status(thread: ThreadKey, line: string) {
      const run = runs.get(thread.id);
      if (!run) {
        log(`skip [root-unknown] thread ${thread.id}: status line needs the thread opened by this process`);
        return false;
      }
      const at = now();
      const last = lastStatusAt.get(thread.id);
      if (last !== undefined && at - last < statusInterval) return false;
      lastStatusAt.set(thread.id, at);
      await editRoot(thread, run, { line });
      return true;
    },

    async verify(req: Request, rawBody: Uint8Array) {
      try {
        verifySlackSignature({
          signingSecret: await signingSecret(),
          timestamp: req.headers.get("x-slack-request-timestamp"),
          signature: req.headers.get("x-slack-signature"),
          rawBody,
          nowSeconds: Math.floor(now() / 1000),
        });
        return true;
      } catch (error) {
        if (error instanceof WebhookSignatureError) {
          log(`skip [signature] ${error.message}`);
          return false;
        }
        throw error;
      }
    },

    handshake(req: Request, rawBody: Uint8Array) {
      const parsed = parseSlackRequest(rawBody, req.headers.get("content-type") ?? "");
      if (parsed.kind !== "challenge") return null;
      return new Response(JSON.stringify({ challenge: parsed.challenge }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },

    async parse(req: Request, rawBody: Uint8Array): Promise<InboundEvent | null> {
      const parsed = parseSlackRequest(rawBody, req.headers.get("content-type") ?? "", botUserId);
      if (parsed.kind === "event") return parsed.event;
      if (parsed.kind === "open-modal") {
        // A trigger_id lives 3 s and works once, so views.open is the one call made inside the ack window.
        const view = answerModal({
          askId: parsed.askId,
          thread: parsed.thread,
          ...(parsed.ordinal === undefined ? {} : { ordinal: parsed.ordinal }),
          ...(parsed.fields ? { fields: parsed.fields, blocks: formInputBlocks(parsed.fields) } : {}),
        });
        try {
          await api.call("views.open", { trigger_id: parsed.triggerId, view });
        } catch (error) {
          log(`skip [modal-open-failed] ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      }
      if (parsed.kind === "ignored") log(`skip [${parsed.reason}]`);
      return null;
    },

    ack(_ev: InboundEvent) {
      // An empty 200 is what Slack expects for actions, events and a closing modal.
      return new Response(null, { status: 200 });
    },
  };
}
