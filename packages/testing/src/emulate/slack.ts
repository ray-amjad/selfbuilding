import { createHmac } from "node:crypto";
import { createEmulator, type Emulator, type SeedConfig } from "emulate";
import { EmulatorRequestError, readBody } from "./common.js";

export interface SlackSeedOptions {
  /** Default "selfbuilding-test-signing-secret". */
  signingSecret?: string;
  /** The channel adapter's local interactivity handler, e.g. `http://127.0.0.1:<port>/slack/interactions`. */
  interactivityUrl?: string;
  /** Default "factory". */
  channel?: string;
  /** Default "xoxb-selfbuilding-test" (the app's bot user). */
  botToken?: string;
  /** Default "xoxp-user-1" (the human `user-1`). */
  userToken?: string;
}

export interface SlackSeedInfo {
  signingSecret: string;
  channelName: string;
  appId: string;
  bot: { name: string; userId: string; botId: string; token: string };
  human: { name: string; token: string };
}

/**
 * The spec's Slack seed: a signing secret, users `user-1` and the `selfbuilding-bot` app bot, channel `#factory`,
 * an app whose `interactivity_url` points at the adapter's handler, and a 30 s modal trigger window.
 */
export function slackSeed(opts: SlackSeedOptions = {}): { seed: SeedConfig; info: SlackSeedInfo } {
  const info: SlackSeedInfo = {
    signingSecret: opts.signingSecret ?? "selfbuilding-test-signing-secret",
    channelName: opts.channel ?? "factory",
    appId: "A0SELFBUILD",
    bot: {
      name: "selfbuilding-bot",
      userId: "U0SELFBOT",
      botId: "B0SELFBOT",
      token: opts.botToken ?? "xoxb-selfbuilding-test",
    },
    human: { name: "user-1", token: opts.userToken ?? "xoxp-user-1" },
  };
  const scopes = ["chat:write", "channels:read", "channels:history", "channels:join", "users:read", "reactions:write"];
  const seed: SeedConfig = {
    slack: {
      team: { name: "Selfbuilding Test", domain: "selfbuilding-test" },
      users: [{ name: info.human.name, real_name: "User One", email: "user-1@selfbuilding.test" }],
      channels: [{ name: info.channelName, topic: "Factory asks" }],
      oauth_apps: [
        {
          app_id: info.appId,
          client_id: "selfbuilding-test-client",
          client_secret: "selfbuilding-test-client-secret",
          name: "Selfbuilding",
          redirect_uris: [],
          scopes,
          bot_id: info.bot.botId,
          bot_user_id: info.bot.userId,
          bot_name: info.bot.name,
          ...(opts.interactivityUrl === undefined ? {} : { interactivity_url: opts.interactivityUrl }),
        },
      ],
      tokens: [
        {
          token: info.bot.token,
          type: "bot",
          user: info.bot.userId,
          app_id: info.appId,
          bot_id: info.bot.botId,
          bot_user_id: info.bot.userId,
          scopes,
        },
        { token: info.human.token, type: "user", user: info.human.name, scopes },
      ],
      signing_secret: info.signingSecret,
      view_trigger_ttl_seconds: 30,
    },
  };
  return { seed, info };
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  blocks?: unknown[];
}

export interface SlackEmulator extends SlackSeedInfo {
  readonly url: string;
  readonly emulator: Emulator;
  readonly channelId: string;
  readonly human: SlackSeedInfo["human"] & { userId: string };
  /** Calls a Web API method as the bot (default) or the human; throws when `ok` is false. */
  api<T = Record<string, unknown>>(method: string, body?: Record<string, unknown>, as?: "bot" | "human"): Promise<T>;
  /** Top-level messages in the channel, oldest first. */
  messages(): Promise<SlackMessage[]>;
  /** Replies in a thread as the human. */
  reply(threadTs: string, text: string): Promise<SlackMessage>;
  /** Clicks a button on a message as the human; the emulator delivers a signed `block_actions` payload. */
  click(messageTs: string, button: { actionId?: string; text?: string }): Promise<Record<string, unknown>>;
  /** Signs a body the way Slack does, for feeding a handler directly (bad-signature tests build their own). */
  sign(body: string, timestamp?: number): { "x-slack-request-timestamp": string; "x-slack-signature": string };
  /** Restores the seed and rejoins the bot to the channel. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Starts a Slack emulator with the spec seed and puts the bot in the channel. */
export async function startSlackEmulator(opts: SlackSeedOptions & { port?: number } = {}): Promise<SlackEmulator> {
  const { seed, info } = slackSeed(opts);
  const emulator = await createEmulator({ service: "slack", port: opts.port ?? 0, hostname: "127.0.0.1", seed });
  const url = emulator.url.replace("localhost", "127.0.0.1");

  const call = async <T>(method: string, body: Record<string, unknown> = {}, as: "bot" | "human" = "bot") => {
    const response = await fetch(`${url}/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${as === "human" ? info.human.token : info.bot.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const parsed = (await readBody(response)) as { ok?: boolean } | undefined;
    if (!response.ok || parsed?.ok !== true)
      throw new EmulatorRequestError("POST", `/api/${method}`, response.status, parsed);
    return parsed as T;
  };

  const resolve = async () => {
    const channels = await call<{ channels: { id: string; name: string }[] }>("conversations.list", {});
    const channel = channels.channels.find((c) => c.name === info.channelName);
    if (!channel) throw new Error(`The Slack emulator has no #${info.channelName} channel.`);
    await call("conversations.join", { channel: channel.id });
    const users = await call<{ members: { id: string; name: string }[] }>("users.list", {});
    const human = users.members.find((u) => u.name === info.human.name);
    if (!human) throw new Error(`The Slack emulator has no ${info.human.name} user.`);
    return { channelId: channel.id, humanId: human.id };
  };
  const ids = await resolve();

  return {
    ...info,
    url,
    emulator,
    get channelId() {
      return ids.channelId;
    },
    get human() {
      return { ...info.human, userId: ids.humanId };
    },
    api: call,
    async messages() {
      const history = await call<{ messages: SlackMessage[] }>(
        "conversations.history",
        { channel: ids.channelId },
        "human",
      );
      return [...history.messages].sort((a, b) => Number(a.ts) - Number(b.ts));
    },
    async reply(threadTs, text) {
      const posted = await call<{ message: SlackMessage }>(
        "chat.postMessage",
        { channel: ids.channelId, thread_ts: threadTs, text },
        "human",
      );
      return posted.message;
    },
    async click(messageTs, button) {
      const response = await fetch(`${url}/_slack/simulate/block-actions`, {
        method: "POST",
        headers: { authorization: `Bearer ${info.human.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          channel: ids.channelId,
          message_ts: messageTs,
          user: info.human.name,
          ...(button.actionId === undefined ? {} : { action_id: button.actionId }),
          ...(button.text === undefined ? {} : { text: button.text }),
        }),
      });
      const parsed = (await readBody(response)) as Record<string, unknown> & { ok?: boolean };
      if (parsed?.ok !== true) {
        throw new EmulatorRequestError("POST", "/_slack/simulate/block-actions", response.status, parsed);
      }
      return parsed;
    },
    sign(body, timestamp = Math.floor(Date.now() / 1000)) {
      const digest = createHmac("sha256", info.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex");
      return { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": `v0=${digest}` };
    },
    async reset() {
      emulator.reset();
      // Ids are regenerated on reset.
      Object.assign(ids, await resolve());
    },
    close: () => emulator.close(),
  };
}
