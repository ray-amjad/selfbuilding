import { StringDecoder } from "node:string_decoder";

/** Keeps the last `limit` bytes of a stream without ever joining the whole stream (invariant 10). */
export class Tail {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#limit && this.#chunks.length > 0) {
      const first = this.#chunks[0] as Buffer;
      const excess = this.#size - this.#limit;
      this.truncated = true;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#size -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#size -= excess;
      }
    }
  }

  toString(): string {
    // A cut can land inside a multi-byte character; drop the partial leading bytes.
    const text = Buffer.concat(this.#chunks).toString("utf8");
    return this.truncated ? text.replace(/^�+/, "") : text;
  }
}

/** Splits a byte stream on "\n" only (never U+2028/U+2029) and reports each complete line at once. */
export class LineSplitter {
  readonly #decoder = new StringDecoder("utf8");
  readonly #onLine: (line: string) => void;
  #partial = "";

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  push(chunk: Buffer): void {
    const text = this.#partial + this.#decoder.write(chunk);
    const parts = text.split("\n");
    this.#partial = parts.pop() ?? "";
    for (const line of parts) this.#onLine(line);
  }

  end(): void {
    const rest = this.#partial + this.#decoder.end();
    this.#partial = "";
    if (rest.length > 0) this.#onLine(rest);
  }
}
