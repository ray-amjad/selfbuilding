/** Lines longer than this are dropped with a warning (spec §4.3). */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Splits a byte stream on "\n" only. Node's readline also splits on U+2028/U+2029, which corrupts JSONL.
 */
export class LineSplitter {
  #parts: Buffer[] = [];
  #size = 0;
  #dropping = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onDropped: (bytes: number) => void = () => undefined,
    private readonly maxBytes = MAX_LINE_BYTES,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    let newline = chunk.indexOf(10, start);
    while (newline >= 0) {
      this.#append(chunk.subarray(start, newline));
      this.#emit();
      start = newline + 1;
      newline = chunk.indexOf(10, start);
    }
    if (start < chunk.length) this.#append(chunk.subarray(start));
  }

  end(): void {
    if (this.#size > 0 || this.#dropping) this.#emit();
  }

  #append(part: Buffer): void {
    if (this.#dropping) {
      this.#size += part.length;
      return;
    }
    this.#size += part.length;
    if (this.#size > this.maxBytes) {
      this.#dropping = true;
      this.#parts = [];
      return;
    }
    if (part.length > 0) this.#parts.push(Buffer.from(part));
  }

  #emit(): void {
    if (this.#dropping) this.onDropped(this.#size);
    else {
      let line = Buffer.concat(this.#parts).toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.onLine(line);
    }
    this.#parts = [];
    this.#size = 0;
    this.#dropping = false;
  }
}
