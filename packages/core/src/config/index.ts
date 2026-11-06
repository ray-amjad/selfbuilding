import { ConfigError, MissingSecretError, TimeoutOrderError } from "../errors/classes.js";
import { validateSizes } from "../sizes/index.js";
import type { Budget } from "../types/budget.js";
import { CONFIG_KEYS, type SelfbuildingConfig } from "../types/config.js";
import type { Secret, SecretSource } from "../types/security.js";
import { parseDuration } from "./duration.js";

export { parseDuration, parseOptionalDuration } from "./duration.js";

/**
 * The only config builder (spec §1.11). Validation happens when the config is used, except the sizes table: a
 * redefined built-in size fails here, before any template is named after it (demo-path §1.1).
 */
export function defineConfig(config: SelfbuildingConfig): SelfbuildingConfig {
  validateSizes(config.sizes);
  return config;
}

const CONFIG_FILES = [
  "selfbuilding.config.ts",
  "selfbuilding.config.mts",
  "selfbuilding.config.js",
  "selfbuilding.config.mjs",
];

/**
 * Finds and loads `selfbuilding.config.{ts,mts,js,mjs}` from `cwd` upward to the nearest `.git`, or loads
 * `path` directly. Library calls never load config on their own.
 */
export async function loadConfig(opts: { cwd?: string; path?: string } = {}): Promise<SelfbuildingConfig> {
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  let file: string;
  if (opts.path !== undefined) {
    file = nodePath.resolve(opts.cwd ?? process.cwd(), opts.path);
    if (!fs.existsSync(file))
      throw new ConfigError(`Config file ${file} does not exist. Check --config or SELFBUILDING_CONFIG.`);
  } else {
    file = findConfigFile(fs, nodePath, nodePath.resolve(opts.cwd ?? process.cwd()));
  }
  const mod = await importConfigModule(file);
  const config = (mod as { default?: unknown }).default ?? mod;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new ConfigError(`${file} must default-export the value returned by defineConfig({...}).`);
  }
  validateSizes((config as SelfbuildingConfig).sizes, `${file}: sizes`);
  return config as SelfbuildingConfig;
}

function findConfigFile(fs: typeof import("node:fs"), nodePath: typeof import("node:path"), start: string): string {
  let dir = start;
  for (;;) {
    const found = CONFIG_FILES.filter((name) => fs.existsSync(nodePath.join(dir, name)));
    if (found.length > 1) {
      throw new ConfigError(`${dir} holds more than one config file (${found.join(", ")}). Keep exactly one.`);
    }
    if (found.length === 1) return nodePath.join(dir, found[0] as string);
    const parent = nodePath.dirname(dir);
    if (fs.existsSync(nodePath.join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  throw new ConfigError(
    `No selfbuilding.config.ts found from ${start} up to the repository root. Run \`selfbuilding init\` or pass --config.`,
  );
}

async function importConfigModule(file: string): Promise<unknown> {
  const { pathToFileURL } = await import("node:url");
  try {
    if (/\.m?ts$/.test(file)) {
      const { createJiti } = await import("jiti");
      const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
      return await jiti.import(file);
    }
    return await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError(`Loading ${file} failed: ${(cause as Error)?.message ?? String(cause)}`, { cause });
  }
}

/** A secret read from the environment when it is resolved, on the orchestrator. */
export function fromEnv(name: string): Secret {
  if (!name) throw new ConfigError("fromEnv() needs a variable name.");
  return async () => {
    const value = process.env[name];
    if (value === undefined || value === "") throw new MissingSecretError({ secret: name });
    return value;
  };
}

/** A secret read from a file when it is resolved. Relative paths need an explicit base; never process.cwd(). */
export function fromFile(path: string): Secret {
  const isUrl = path.startsWith("file:");
  if (!isUrl && !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new ConfigError(
      `fromFile("${path}") needs an absolute path or a file: URL, e.g. fromFile(new URL("./token", import.meta.url).href).`,
    );
  }
  return async () => {
    const fs = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const file = isUrl ? fileURLToPath(path) : path;
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (cause) {
      throw new MissingSecretError({ secret: file }, { cause });
    }
    const value = text.replace(/\r?\n$/, "");
    if (value === "") throw new MissingSecretError({ secret: file });
    return value;
  };
}

/** A SecretSource backed by the process environment. Missing names throw MissingSecretError. */
export function envSecretSource(env?: Record<string, string | undefined>): SecretSource {
  return {
    async resolve(names) {
      const source = env ?? process.env;
      const out: Record<string, string> = {};
      for (const name of names) {
        const value = source[name];
        if (value === undefined || value === "") throw new MissingSecretError({ secret: name });
        out[name] = value;
      }
      return out;
    },
  };
}

/** Resolves a `Secret` value or resolver to its string. Runs on the orchestrator only. */
export async function resolveSecret(secret: Secret): Promise<string> {
  return typeof secret === "function" ? secret() : secret;
}

const DEPLOYMENT = /^[a-z0-9-]{1,32}$/;

/**
 * Checks a config at the point of use (spec §1.11): unknown keys, malformed durations, and impossible
 * numbers fail here with ConfigError naming the key.
 */
export function validateConfig(config: SelfbuildingConfig, where = "config"): void {
  const unknown = Object.keys(config).filter((k) => !(CONFIG_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new ConfigError(`Unknown ${where} key(s): ${unknown.join(", ")}. Valid keys: ${CONFIG_KEYS.join(", ")}.`);
  }
  if (config.deployment !== undefined && !DEPLOYMENT.test(config.deployment)) {
    throw new ConfigError(`${where}.deployment must match ^[a-z0-9-]{1,32}$; got "${config.deployment}".`);
  }
  validateConcurrency(config.concurrency, `${where}.concurrency`);
  if (config.budget !== undefined) validateBudget(config.budget, `${where}.budget`);
  if (config.timeouts !== undefined) {
    for (const [key, value] of Object.entries(config.timeouts)) {
      if (value !== undefined) parseDuration(value, `${where}.timeouts.${key}`);
    }
  }
  if (config.events !== undefined && !config.events.every((sink) => typeof sink === "function")) {
    throw new ConfigError(`${where}.events must be an array of functions (event) => void.`);
  }
  if (config.strict !== undefined && typeof config.strict !== "boolean") {
    throw new ConfigError(`${where}.strict must be a boolean.`);
  }
  validateSizes(config.sizes, `${where}.sizes`);
}

export function validateConcurrency(
  c: { sandboxes?: number; createsPerMinute?: number } | undefined,
  where: string,
): void {
  if (c === undefined) return;
  if (c.sandboxes !== undefined && (!Number.isInteger(c.sandboxes) || c.sandboxes < 1)) {
    throw new ConfigError(`${where}.sandboxes must be a positive integer; got ${c.sandboxes}.`);
  }
  if (c.createsPerMinute !== undefined && !(c.createsPerMinute > 0)) {
    throw new ConfigError(`${where}.createsPerMinute must be a positive number; got ${c.createsPerMinute}.`);
  }
}

export function validateBudget(b: Budget, where: string): void {
  const nonNegative = (value: number | undefined, key: string) => {
    if (value !== undefined && !(typeof value === "number" && value >= 0 && Number.isFinite(value))) {
      throw new ConfigError(`${where}.${key} must be a non-negative number; got ${value}.`);
    }
  };
  nonNegative(b.usd, "usd");
  nonNegative(b.tokens, "tokens");
  nonNegative(b.minAgentUsd, "minAgentUsd");
  nonNegative(b.perAgent?.usd, "perAgent.usd");
  if (b.perAgent?.maxTurns !== undefined && !(Number.isInteger(b.perAgent.maxTurns) && b.perAgent.maxTurns > 0)) {
    throw new ConfigError(`${where}.perAgent.maxTurns must be a positive integer.`);
  }
  if (b.wallClock !== undefined) parseDuration(b.wallClock, `${where}.wallClock`);
  if (b.perAgent?.wallClock !== undefined) parseDuration(b.perAgent.wallClock, `${where}.perAgent.wallClock`);
  for (const [model, price] of Object.entries(b.prices ?? {})) {
    if (!(price.inputPerMTok >= 0 && price.outputPerMTok >= 0)) {
      throw new ConfigError(`${where}.prices["${model}"] needs non-negative inputPerMTok and outputPerMTok.`);
    }
  }
}

/** The first defined value, highest precedence first. Objects are never deep-merged (spec §1.11). */
export function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
}

/**
 * Checks the timeout chain (spec §6.11, §9.6): per-call timeout < provider lifetime < dead-run closer.
 * Every argument is milliseconds; an undefined link is skipped.
 */
export function checkTimeoutOrder(links: { name: string; ms: number | undefined }[]): void {
  const present = links.filter((l): l is { name: string; ms: number } => l.ms !== undefined);
  for (let i = 1; i < present.length; i++) {
    const first = present[i - 1] as { name: string; ms: number };
    const second = present[i] as { name: string; ms: number };
    if (!(first.ms < second.ms)) {
      throw new TimeoutOrderError({
        first: `${first.name} (${first.ms} ms)`,
        second: `${second.name} (${second.ms} ms)`,
      });
    }
  }
}
