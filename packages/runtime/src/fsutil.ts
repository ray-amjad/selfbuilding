import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Writes a file so readers see the old content or the new content, never a torn write. */
export function writeAtomic(file: string, data: string | Uint8Array, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown, mode = 0o644): void {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Creates a file only if it does not exist yet. Returns false when it already existed. */
export function writeExclusive(file: string, data: string, mode = 0o644): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Stage then link: link() fails with EEXIST atomically, and readers never see a half-written file.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function exists(file: string): boolean {
  return fs.existsSync(file);
}

export function ensureDir(dir: string, mode?: number): void {
  fs.mkdirSync(dir, { recursive: true, ...(mode === undefined ? {} : { mode }) });
}

/** The last `bytes` of a file, decoded as UTF-8 (a split leading character is dropped). */
export function tailFile(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8").replace(/^�+/, "");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function appendText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
