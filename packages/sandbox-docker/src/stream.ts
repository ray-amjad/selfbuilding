import { StringDecoder } from "node:string_decoder";

/** Keeps only the last `limit` bytes of a stream; the whole stream is never joined (invariant 10). */
export class Tail {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#limit) {
      const head = this.#chunks[0] as Buffer;
      const excess = this.#size - this.#limit;
      this.truncated = true;
      if (head.length <= excess) {
        this.#chunks.shift();
        this.#size -= head.length;
      } else {
        this.#chunks[0] = head.subarray(excess);
        this.#size -= excess;
      }
    }
  }

  toString(): string {
    const text = Buffer.concat(this.#chunks).toString("utf8");
    // The cut can split a multi-byte character; drop the replacement characters it leaves at the front.
    return this.truncated ? text.replace(/^�+/, "") : text;
  }
}

/** Splits bytes on "\n" only (never U+2028/U+2029) and reports each complete line as soon as it arrives. */
export class LineSplitter {
  readonly #decoder = new StringDecoder("utf8");
  readonly #onLine: (line: string) => void;
  #partial = "";

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  push(chunk: Buffer): void {
    const parts = (this.#partial + this.#decoder.write(chunk)).split("\n");
    this.#partial = parts.pop() ?? "";
    for (const line of parts) this.#onLine(line);
  }

  end(): void {
    const rest = this.#partial + this.#decoder.end();
    this.#partial = "";
    if (rest.length > 0) this.#onLine(rest);
  }
}

/**
 * Splits Docker's multiplexed exec stream (`Tty: false`): an 8-byte header (stream id, 3 zero bytes, big-endian
 * length) before each payload. Payload bytes are passed on as they arrive, so a large frame is never buffered whole.
 */
export class Demuxer {
  readonly #onData: (stream: "stdout" | "stderr", chunk: Buffer) => void;
  #header = Buffer.alloc(0);
  #stream: "stdout" | "stderr" = "stdout";
  #remaining = 0;

  constructor(onData: (stream: "stdout" | "stderr", chunk: Buffer) => void) {
    this.#onData = onData;
  }

  push(chunk: Buffer): void {
    let rest = chunk;
    while (rest.length > 0) {
      if (this.#remaining > 0) {
        const take = Math.min(this.#remaining, rest.length);
        this.#onData(this.#stream, rest.subarray(0, take));
        this.#remaining -= take;
        rest = rest.subarray(take);
        continue;
      }
      const need = 8 - this.#header.length;
      this.#header = Buffer.concat([this.#header, rest.subarray(0, need)]);
      rest = rest.subarray(need);
      if (this.#header.length < 8) return;
      this.#stream = this.#header[0] === 2 ? "stderr" : "stdout";
      this.#remaining = this.#header.readUInt32BE(4);
      this.#header = Buffer.alloc(0);
    }
  }
}

/** Builds one multiplexed frame. Used by tests and in-memory clients. */
export function frame(stream: "stdout" | "stderr", payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload) : payload;
  const header = Buffer.alloc(8);
  header[0] = stream === "stderr" ? 2 : 1;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

export async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Reads a newline-delimited JSON progress stream (pull, build) and returns the first error it reports. */
export async function progressError(
  stream: NodeJS.ReadableStream,
  onLog?: (line: string) => void,
): Promise<string | undefined> {
  let error: string | undefined;
  const lines = new LineSplitter((line) => {
    if (error !== undefined || line.trim() === "") return;
    try {
      const event = JSON.parse(line) as { error?: string; errorDetail?: { message?: string }; stream?: string };
      error = event.error ?? event.errorDetail?.message;
      const text = event.stream?.trimEnd();
      if (onLog && text) onLog(text);
    } catch {
      // Progress lines that are not JSON carry nothing actionable.
    }
  });
  for await (const chunk of stream) lines.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  lines.end();
  return error;
}
