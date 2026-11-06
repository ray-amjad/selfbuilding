import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Serves a fetch handler on 127.0.0.1 so an emulator can deliver to it. The handler may be swapped later. */
export async function serveFetch(initial: (req: Request) => Promise<Response>): Promise<{
  url: string;
  set(handler: (req: Request) => Promise<Response>): void;
  close(): Promise<void>;
}> {
  let handler = initial;
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
    url: `http://127.0.0.1:${port}/slack`,
    set(next) {
      handler = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
