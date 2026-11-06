// The Slack side of the acceptance suite: the Slack emulator, the real Slack channel adapter, and the hooks HITL
// handler served over HTTP so the emulator's signed button clicks reach it exactly as Slack's would.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type SlackChannel, slack } from "@selfbuilding/channel-slack";
import type { AskRecord, AskStore, HitlOptions } from "@selfbuilding/core";
import { createHitlHandler } from "@selfbuilding/hooks";
import { type SlackEmulator, startSlackEmulator } from "@selfbuilding/testing";

type Handler = (req: Request) => Promise<Response>;

async function serve(path: string): Promise<{ url: string; set(h: Handler): void; close(): Promise<void> }> {
  let handler: Handler = async () => new Response(null, { status: 503 });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
          method: req.method ?? "GET",
          headers,
          ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
        });
        const response = await handler(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    set(next) {
      handler = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface SlackRig {
  emu: SlackEmulator;
  channel: SlackChannel;
  /** The run's HITL options: the Slack channel, with the emulator's human as the only approver. */
  hitl(over?: Partial<HitlOptions>): HitlOptions;
  /** Points the interactivity handler at the store the run uses (its journal's ask store). */
  listen(store: AskStore): void;
  /** Polls `store` until an open ask of `runId` has a posted card, and returns it. */
  waitForAsk(store: AskStore, runId: string, timeoutMs?: number): Promise<AskRecord>;
  /** Clicks a button on the ask's Slack card as the human. */
  click(record: AskRecord, label: string): Promise<void>;
  /** Every message in the channel and its threads, as text and button labels. */
  transcript(): Promise<string>;
  close(): Promise<void>;
}

export async function startSlackRig(): Promise<SlackRig> {
  const server = await serve("/slack");
  const emu = await startSlackEmulator({ interactivityUrl: server.url });
  const channel = slack({
    channel: `#${emu.channelName}`,
    botToken: emu.bot.token,
    signingSecret: emu.signingSecret,
    apiUrl: emu.url,
    retries: 0,
    statusIntervalMs: 0,
    log: () => {},
  });
  const pending: Promise<unknown>[] = [];

  return {
    emu,
    channel,
    hitl: (over = {}) => ({ channels: [channel], approvers: [{ slack: emu.human.userId }], ...over }),
    listen(store) {
      server.set(
        createHitlHandler({
          channels: [channel],
          store,
          approvers: [{ slack: emu.human.userId }],
          waitUntil: (work) => pending.push(work),
          log: () => {},
        }),
      );
    },
    async waitForAsk(store, runId, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for await (const record of store.open({ runId })) {
          if (record.messages.some((m) => m.channel === "slack")) return record;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`No ask of ${runId} reached Slack within ${timeoutMs} ms.`);
    },
    async click(record, label) {
      const card = record.messages.find((m) => m.channel === "slack");
      if (!card) throw new Error(`Ask ${record.askId} has no Slack card.`);
      await emu.click(card.id, { text: label });
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
    async transcript() {
      const lines: string[] = [];
      for (const root of await emu.messages()) {
        const replies = await emu.api<{ messages: { ts: string; text?: string; blocks?: unknown[] }[] }>(
          "conversations.replies",
          { channel: emu.channelId, ts: root.ts },
          "human",
        );
        for (const m of replies.messages) lines.push(`${m.text ?? ""} ${JSON.stringify(m.blocks ?? [])}`);
      }
      return lines.join("\n");
    },
    async close() {
      await emu.close();
      await server.close();
    },
  };
}
