// A minimal ustar codec for putArchive/getArchive: regular files and directories out; files, directories and
// symlinks in, with PAX and GNU long names. Archives here are small enough to build and read in memory.

const BLOCK = 512;

export interface TarFile {
  /** Relative to the extraction directory, "/"-separated. */
  name: string;
  data: Uint8Array;
  mode?: number;
  uid?: number;
  gid?: number;
}

export type TarEntry =
  | { type: "file"; name: string; data: Buffer; mode: number }
  | { type: "directory"; name: string; mode: number }
  | { type: "symlink"; name: string; target: string; mode: number }
  | { type: "other"; name: string; mode: number };

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, o: { size: number; mode: number; uid: number; gid: number; type: string }): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write(octal(o.mode & 0o7777, 8), 100, "ascii");
  block.write(octal(o.uid, 8), 108, "ascii");
  block.write(octal(o.gid, 8), 116, "ascii");
  block.write(octal(o.size, 12), 124, "ascii");
  block.write(octal(Math.floor(Date.now() / 1000), 12), 136, "ascii");
  block.write(o.type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.fill(" ", 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** A PAX record is "<len> path=<value>\n", where <len> counts the whole record including its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return `${length}${body}`;
}

export function packTar(files: TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);
    const ids = { uid: file.uid ?? 0, gid: file.gid ?? 0 };
    if (Buffer.byteLength(file.name) > 100) {
      const pax = Buffer.from(paxRecord("path", file.name));
      parts.push(
        header("././@PaxHeader", { size: pax.length, mode: 0o644, ...ids, type: "x" }),
        pax,
        padding(pax.length),
      );
    }
    parts.push(header(file.name, { size: data.length, mode: file.mode ?? 0o644, ...ids, type: "0" }), data);
    parts.push(padding(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
}

function readNumber(block: Buffer, offset: number, length: number): number {
  const raw = block.subarray(offset, offset + length);
  // GNU base-256: the high bit of the first byte is set and the rest is a big-endian number.
  if (((raw[0] ?? 0) & 0x80) !== 0) {
    let value = (raw[0] ?? 0) & 0x7f;
    for (const byte of raw.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = raw
    .toString("ascii")
    .replace(/[\0 ]+$/g, "")
    .trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number(data.subarray(offset, space).toString("ascii"));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

export function unpackTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const size = readNumber(block, 124, 12);
    const type = String.fromCharCode(block[156] ?? 0);
    const dataStart = offset + BLOCK;
    const data = archive.subarray(dataStart, dataStart + size);
    offset = dataStart + size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === "x") {
      const pax = parsePax(data);
      longName = pax.path ?? longName;
      longLink = pax.linkpath ?? longLink;
      continue;
    }
    if (type === "L" || type === "K") {
      const value = data.toString("utf8").replace(/\0+$/, "");
      if (type === "L") longName = value;
      else longLink = value;
      continue;
    }
    if (type === "g") continue;
    const prefix = readString(block, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${readString(block, 0, 100)}` : readString(block, 0, 100));
    const target = longLink ?? readString(block, 157, 100);
    const mode = readNumber(block, 100, 8);
    longName = undefined;
    longLink = undefined;
    if (type === "0" || type === "\0" || type === "7")
      entries.push({ type: "file", name, data: Buffer.from(data), mode });
    else if (type === "5") entries.push({ type: "directory", name, mode });
    else if (type === "2") entries.push({ type: "symlink", name, target, mode });
    else entries.push({ type: "other", name, mode });
  }
  return entries;
}
