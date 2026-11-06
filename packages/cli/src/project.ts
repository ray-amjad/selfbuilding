import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import * as ownCore from "@selfbuilding/core";
import {
  CONFIG_KEYS,
  ConfigError,
  type JournalStore,
  type SandboxProvider,
  type SelfbuildingConfig,
} from "@selfbuilding/core";
import { readRuntimeBundles } from "@selfbuilding/runtime";
import { createJiti } from "jiti";
import type { CliContext, CoreApi } from "./context.js";

export const CONFIG_FILE_NAMES = [
  "selfbuilding.config.ts",
  "selfbuilding.config.mts",
  "selfbuilding.config.js",
  "selfbuilding.config.mjs",
] as const;

/** Where the CLI keeps a project's local state. */
export interface StatePaths {
  dir: string;
  journal: string;
  artifacts: string;
  runs: string;
  events: string;
}

export function statePaths(root: string): StatePaths {
  const dir = path.join(root, ".selfbuilding");
  return {
    dir,
    journal: path.join(dir, "journal"),
    artifacts: path.join(dir, "artifacts"),
    runs: path.join(dir, "runs"),
    events: path.join(dir, "events"),
  };
}

/**
 * Searches from `start` upward for a config file, stopping at the first directory that holds `.git` or at the
 * filesystem root (spec §1.11). Two config files in one directory is a ConfigError.
 */
export function findConfigFile(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const found = CONFIG_FILE_NAMES.filter((name) => existsSync(path.join(dir, name)));
    if (found.length > 1) {
      throw new ConfigError(`${dir} has ${found.join(" and ")}. Keep one selfbuilding config file per directory.`);
    }
    if (found[0]) return path.join(dir, found[0]);
    const parent = path.dirname(dir);
    if (existsSync(path.join(dir, ".git")) || parent === dir) return null;
    dir = parent;
  }
}

/** The nearest directory holding `.git`, else `start` itself. Used as the project root when there is no config. */
export function findProjectRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/** Loads a dotenv file into `env`. Variables that are already set win, as with every dotenv loader. */
export function loadEnvFile(ctx: CliContext, file: string): string {
  const abs = path.resolve(ctx.cwd, file);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    throw new ConfigError(`--env-file ${file}: no such file (looked for ${abs}).`);
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (ctx.env[key] === undefined) ctx.env[key] = value;
  }
  return abs;
}

export function createLoader(base: string) {
  // moduleCache off: `run` then `resume` in one process must see an edited prompt or factory file.
  return createJiti(base.endsWith(path.sep) ? base : `${base}${path.sep}`, {
    moduleCache: false,
    interopDefault: true,
  });
}

export interface LoadedProject {
  /** The directory that holds the config file, or the git root when there is none. */
  root: string;
  configPath: string | null;
  config: SelfbuildingConfig;
  /** Every provider `reap` and `cancel` sweep: `config.sandbox` plus the config file's named `providers` export. */
  providers: SandboxProvider[];
  paths: StatePaths;
  core: CoreApi;
}

export interface ProjectFlags {
  config?: string | undefined;
  envFile?: string | undefined;
  /** Without a config file, `run` still works (the factory may carry its own defaults); the others need one. */
  requireConfig: boolean;
}

export function resolveConfigPath(ctx: CliContext, flag: string | undefined): string | null {
  const explicit = flag ?? ctx.env.SELFBUILDING_CONFIG;
  if (explicit) {
    const abs = path.resolve(ctx.cwd, explicit);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new ConfigError(
        `Config file ${abs} does not exist${flag ? "" : " (from SELFBUILDING_CONFIG)"}. Run selfbuilding init to create one.`,
      );
    }
    return abs;
  }
  return findConfigFile(ctx.cwd);
}

export async function loadProject(ctx: CliContext, flags: ProjectFlags): Promise<LoadedProject> {
  if (flags.envFile) loadEnvFile(ctx, flags.envFile);
  const configPath = resolveConfigPath(ctx, flags.config);
  if (!configPath && flags.requireConfig) {
    throw new ConfigError(
      `No selfbuilding.config.ts found from ${ctx.cwd} up to the repository root. Run selfbuilding init, or pass --config <path>.`,
    );
  }
  const root = configPath ? path.dirname(configPath) : findProjectRoot(ctx.cwd);
  const loaded = configPath ? await importConfig(configPath) : { config: {}, providers: [] };
  return {
    root,
    configPath,
    config: loaded.config,
    providers: loaded.providers,
    paths: statePaths(root),
    core: ctx.core ?? (await projectCore(root)),
  };
}

async function importConfig(configPath: string): Promise<{ config: SelfbuildingConfig; providers: SandboxProvider[] }> {
  let mod: Record<string, unknown>;
  try {
    mod = (await createLoader(path.dirname(configPath)).import(configPath)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Could not load ${configPath}: ${(error as Error).message}`, { cause: error });
  }
  const config = mod.default;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ConfigError(`${configPath} must default-export the value returned by defineConfig({...}).`);
  }
  const unknown = Object.keys(config).filter((key) => !(CONFIG_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${configPath} has unknown config key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Valid keys: ${CONFIG_KEYS.join(", ")}.`,
    );
  }
  const typed = config as SelfbuildingConfig;
  const extra = mod.providers;
  if (extra !== undefined && (!Array.isArray(extra) || !extra.every(isProvider))) {
    throw new ConfigError(`${configPath}: the named export "providers" must be an array of sandbox providers.`);
  }
  const providers: SandboxProvider[] = [];
  for (const p of [typed.sandbox, ...((extra as SandboxProvider[] | undefined) ?? [])]) {
    // Two values of one adapter (say docker() twice) list the same sandboxes; sweep them once.
    if (p && !providers.some((q) => q.id === p.id)) providers.push(p);
  }
  return { config: typed, providers };
}

export function isProvider(value: unknown): value is SandboxProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SandboxProvider).id === "string" &&
    typeof (value as SandboxProvider).list === "function" &&
    typeof (value as SandboxProvider).kill === "function"
  );
}

/**
 * Prefers the project's own installed @selfbuilding/core, so the factory file and `run()` share one module
 * instance (the run context lives in its AsyncLocalStorage). Falls back to the copy the CLI was built against.
 */
async function projectCore(root: string): Promise<CoreApi> {
  try {
    const mod = (await createLoader(root).import("@selfbuilding/core")) as Partial<CoreApi>;
    if (typeof mod.run === "function" && typeof mod.reap === "function" && typeof mod.fileJournal === "function") {
      useOurRuntime(mod);
      return mod as CoreApi;
    }
  } catch {
    // Not installed in the project: use ours.
  }
  useOurRuntime(ownCore);
  return ownCore;
}

/** The CLI ships with a runtime build; hand it to core so projects need not install the runtime themselves. */
function useOurRuntime(core: Partial<CoreApi>): void {
  core.setRuntimeBundles?.(async () => {
    const bundles = readRuntimeBundles();
    return { runtime: bundles.runtime, mcp: bundles.mcp, nsReap: bundles.nsReap };
  });
}

/** The plain Node deployment default (spec §1.11): `local-<hostname>`, fitted to `^[a-z0-9-]{1,32}$`. */
export function deploymentOf(config: SelfbuildingConfig): string {
  if (config.deployment) return config.deployment;
  const host =
    os
      .hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "host";
  return `local-${host}`.slice(0, 32).replace(/-+$/, "");
}

/** The CLI default journal is `fileJournal(".selfbuilding/journal")` under the project root (spec §1.11). */
export function journalOf(project: LoadedProject): JournalStore {
  return project.config.journal ?? project.core.fileJournal(project.paths.journal);
}
