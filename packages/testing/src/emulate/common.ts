/** The spec's per-worker port scheme: `4001 + workerId * 20`, plus an offset per service (GitHub 0, Slack 2). */
export function emulatorPort(service: "github" | "slack", workerId = vitestWorkerId()): number {
  return 4001 + workerId * 20 + (service === "github" ? 0 : 2);
}

/** The vitest pool worker id (1-based), or 0 outside vitest. */
export function vitestWorkerId(): number {
  const raw = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID;
  const id = raw === undefined ? 0 : Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : 0;
}

/** A non-2xx answer from an emulator, with the status and parsed body kept for assertions. */
export class EmulatorRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(method: string, path: string, status: number, body: unknown) {
    super(`${method} ${path} answered ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "EmulatorRequestError";
    this.status = status;
    this.body = body;
  }
}

export async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
