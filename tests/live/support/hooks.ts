// Serves the hooks HITL handler on a local port, so a real Slack App (through a tunnel the tester runs) can deliver
// button clicks to it.
import { createServer } from "node:http";
import type { SlackChannel } from "@selfbuilding/channel-slack";
import type { AskStore } from "@selfbuilding/core";
import { createHitlHandler } from "@selfbuilding/hooks";

export async function serveHitl(opts: {
  port: number;
  channel: SlackChannel;
  store: AskStore;
  approver: string;
}): Promise<{ close(): Promise<void> }> {
  const handler = createHitlHandler({
    channels: [opts.channel],
    store: opts.store,
    approvers: [{ slack: opts.approver }],
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const response = await handler(
          new Request(`http://localhost${req.url ?? "/"}`, {
            method: req.method ?? "POST",
            headers,
            ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
          }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
