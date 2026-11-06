import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, type Factory } from "@selfbuilding/core";
import type { CliContext } from "./context.js";
import { createLoader } from "./project.js";

export function isFactory(value: unknown): value is Factory<unknown, unknown> {
  return (
    typeof value === "function" &&
    typeof (value as Partial<Factory<unknown, unknown>>).body === "function" &&
    typeof (value as Partial<Factory<unknown, unknown>>).inputSchema === "object" &&
    typeof (value as Partial<Factory<unknown, unknown>>).options === "object"
  );
}

/** Loads a factory file with jiti and picks its default export, or `exportName` (spec §1.12). */
export async function loadFactory(file: string, exportName?: string): Promise<Factory<unknown, unknown>> {
  if (!existsSync(file)) throw new ConfigError(`Factory file ${file} does not exist.`);
  let mod: Record<string, unknown>;
  try {
    mod = (await createLoader(path.dirname(file)).import(file)) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`Could not load ${file}: ${(error as Error).message}`, { cause: error });
  }
  const name = exportName ?? "default";
  const picked = mod[name];
  if (isFactory(picked)) return picked;
  const factories = Object.keys(mod).filter((key) => isFactory(mod[key]));
  const hint =
    factories.length > 0
      ? ` Factories it exports: ${factories.join(", ")}${exportName ? "" : ". Pick one with --export <name>"}.`
      : " It exports no factory; wrap the body in factory({ name, input }, async (input) => ...).";
  throw new ConfigError(
    `${file} ${picked === undefined ? `has no export "${name}"` : `export "${name}" is not a factory`}.${hint}`,
  );
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** `--input`: inline JSON, `@path/to/file.json`, or `-` for JSON on stdin. Omitted means `{}`. */
export async function readInput(ctx: CliContext, raw: string | undefined): Promise<unknown> {
  if (raw === undefined) return {};
  let text: string;
  let from: string;
  if (raw === "-") {
    text = await readAll(ctx.stdin);
    from = "stdin";
  } else if (raw.startsWith("@")) {
    const file = path.resolve(ctx.cwd, raw.slice(1));
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new ConfigError(`--input ${raw}: no such file (looked for ${file}).`);
    }
    from = file;
  } else {
    text = raw;
    from = "the --input value";
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${from} is not valid JSON (${(error as Error).message}). Pass inline JSON, @file.json, or - for stdin.`,
    );
  }
}
