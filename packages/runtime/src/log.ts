import fs from "node:fs";
import path from "node:path";
import type { Redactor } from "./redact.js";

/** The durable runtime log. Written synchronously so a crash right after a line still leaves it on disk. */
export class RuntimeLog {
  constructor(
    private file: string | undefined,
    private readonly redactor?: Redactor,
  ) {}

  /** Points the log at an attempt's runtime.log once the attempt is known. */
  setFile(file: string): void {
    this.file = file;
  }

  write(level: "INFO" | "WARN" | "ERROR" | "FATAL", message: string): void {
    const text = this.redactor ? this.redactor.text(message) : message;
    const line = `${new Date().toISOString()} ${level} [${process.pid}] ${text}\n`;
    if (!this.file) {
      process.stderr.write(line);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line);
    } catch {
      process.stderr.write(line);
    }
  }

  info(message: string): void {
    this.write("INFO", message);
  }
  warn(message: string): void {
    this.write("WARN", message);
  }
  error(message: string): void {
    this.write("ERROR", message);
  }
  fatal(message: string): void {
    this.write("FATAL", message);
  }
}
