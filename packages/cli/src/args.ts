import { parseArgs } from "node:util";
import { ConfigError } from "@selfbuilding/core";

export interface FlagSpec {
  type: "string" | "boolean";
  multiple?: boolean;
  short?: string;
}

export interface ParsedArgs {
  positionals: string[];
  str(name: string): string | undefined;
  bool(name: string): boolean;
  list(name: string): string[];
}

/** Strict flag parsing: an unknown flag or a wrong positional count is a usage error naming the command. */
export function parseCommandArgs(
  command: string,
  argv: readonly string[],
  flags: Record<string, FlagSpec>,
  positionals: { min: number; max: number },
): ParsedArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: [...argv], options: flags, strict: true, allowPositionals: true });
  } catch (error) {
    throw new ConfigError(`selfbuilding ${command}: ${(error as Error).message}. See selfbuilding ${command} --help.`);
  }
  const values = parsed.values as Record<string, string | boolean | string[] | undefined>;
  const pos = parsed.positionals;
  if (pos.length < positionals.min || pos.length > positionals.max) {
    const want =
      positionals.min === positionals.max ? `${positionals.min}` : `${positionals.min} to ${positionals.max}`;
    throw new ConfigError(
      `selfbuilding ${command} takes ${want} argument${positionals.max === 1 ? "" : "s"}, got ${pos.length}. See selfbuilding ${command} --help.`,
    );
  }
  return {
    positionals: pos,
    str: (name) => {
      const v = values[name];
      return typeof v === "string" ? v : undefined;
    },
    bool: (name) => values[name] === true,
    list: (name) => {
      const v = values[name];
      if (Array.isArray(v)) return v;
      return typeof v === "string" ? [v] : [];
    },
  };
}

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `"45m"`, `"2h"`, `"30s"`, `"500ms"` or a bare number of milliseconds. */
export function parseDuration(flag: string, raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!match)
    throw new ConfigError(`${flag} "${raw}" is not a duration. Use a number of ms or e.g. "30s", "5m", "2h".`);
  const n = Number(match[1]) * (UNITS[match[2] ?? "ms"] ?? 1);
  if (n <= 0) throw new ConfigError(`${flag} must be greater than zero.`);
  return n;
}
