import { ConfigError, type McpServerSpec, type PathsContext, type PlannedFile } from "@selfbuilding/core";
import { DEFAULT_HOT_WAIT_MS, MCP_TIMEOUT_MARGIN_MS, SELFBUILDING_SERVER } from "./constants.js";

// Codex takes MCP servers as `-c mcp_servers.<name>.<key>=<toml>` overrides (spec §4.8), because
// `--ignore-user-config` keeps it from reading any config.toml. Values are TOML; keys are dotted paths.

/** A TOML basic string. JSON string escapes are a subset of TOML's, apart from lone surrogates, which are rejected. */
export function tomlString(value: string): string {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    throw new ConfigError(
      `Codex config values must be valid Unicode; got a lone surrogate in ${JSON.stringify(value)}.`,
    );
  }
  return JSON.stringify(value);
}

export const tomlArray = (values: readonly string[]): string => `[${values.map(tomlString).join(", ")}]`;

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `-c` pair for argv. */
const override = (key: string, value: string): string[] => ["-c", `${key}=${value}`];

/** The servers in their final order: `selfbuilding` first and unshadowable, the rest as given. */
export function normaliseServers(servers: readonly McpServerSpec[] | undefined, paths: PathsContext): McpServerSpec[] {
  const list = servers ?? [];
  const seen = new Set<string>();
  for (const server of list) {
    if (!SERVER_NAME.test(server.name)) {
      throw new ConfigError(
        `MCP server name ${JSON.stringify(server.name)} cannot be used with Codex: use letters, digits, "_" or "-".`,
      );
    }
    if (seen.has(server.name)) {
      throw new ConfigError(`MCP server ${JSON.stringify(server.name)} is listed twice. Give each server one entry.`);
    }
    seen.add(server.name);
  }
  const own = list.find((s) => s.name === SELFBUILDING_SERVER) ?? defaultSelfbuildingServer(paths);
  return [own, ...list.filter((s) => s.name !== SELFBUILDING_SERVER)];
}

/** The in-sandbox tool server, used when the caller passed no server list. */
export function defaultSelfbuildingServer(paths: PathsContext): McpServerSpec {
  return { name: SELFBUILDING_SERVER, type: "stdio", command: "node", args: [`${paths.bin}/selfbuilding-mcp.mjs`] };
}

/** Effective hot wait + 2 min, whole seconds rounded up (spec §6.11). */
export function mcpToolTimeoutMs(hotWaitMs: number | undefined): number {
  const ms = (hotWaitMs ?? DEFAULT_HOT_WAIT_MS) + MCP_TIMEOUT_MARGIN_MS;
  return Math.ceil(ms / 1000) * 1000;
}

/** Where a stdio server's env lives: a 0600 shell file under `{home}`, never argv or the harness env (spec §4.8). */
export const mcpEnvFile = (paths: PathsContext, server: string): string =>
  `${paths.home}/.codex/selfbuilding-mcp-env/${server}.env`;

// Sources the env file, then runs the real server. The script is fixed; every value travels as an argument.
const ENV_WRAPPER = 'set -a; . "$1"; set +a; shift; exec "$@"';

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Env files for stdio servers that carry env. Written by `prepare()`. */
export function mcpEnvFiles(servers: readonly McpServerSpec[], paths: PathsContext): PlannedFile[] {
  const files: PlannedFile[] = [];
  for (const server of servers) {
    if (server.type !== "stdio" || !server.env || Object.keys(server.env).length === 0) continue;
    const lines = Object.entries(server.env).map(([name, value]) => {
      if (!ENV_NAME.test(name)) {
        throw new ConfigError(`MCP server ${server.name}: ${JSON.stringify(name)} is not a valid variable name.`);
      }
      return `${name}=${shellQuote(value)}`;
    });
    // Owned by the agent: Codex runs as the agent and its wrapper sources this file. A root-owned 0600 file left
    // the browser server unable to start, so Verify saw no browser tools.
    files.push({
      path: mcpEnvFile(paths, server.name),
      content: `${lines.join("\n")}\n`,
      mode: 0o600,
      secret: true,
      owner: "agent",
    });
  }
  return files;
}

/** The `-c mcp_servers.*` overrides for every server. */
export function mcpOverrides(servers: readonly McpServerSpec[], paths: PathsContext, hotWaitMs?: number): string[] {
  const argv: string[] = [];
  for (const server of servers) {
    const key = `mcp_servers.${server.name}`;
    if (server.type === "stdio") {
      const hasEnv = server.env !== undefined && Object.keys(server.env).length > 0;
      const command = hasEnv ? "/bin/sh" : server.command;
      const args = hasEnv
        ? ["-c", ENV_WRAPPER, "mcp-env", mcpEnvFile(paths, server.name), server.command, ...(server.args ?? [])]
        : (server.args ?? []);
      argv.push(...override(`${key}.command`, tomlString(command)));
      if (args.length > 0) argv.push(...override(`${key}.args`, tomlArray(args)));
    } else {
      if (server.headers && Object.keys(server.headers).length > 0) {
        throw new ConfigError(
          `MCP server ${server.name}: Codex reads HTTP headers only from its command line or environment, where ` +
            "secrets must not go. Use a stdio server, or an HTTP server that needs no headers.",
        );
      }
      argv.push(...override(`${key}.url`, tomlString(server.url)));
    }
    // Without this, approval_policy="never" refuses every MCP call ("MCP tool call requires approval").
    argv.push(...override(`${key}.default_tools_approval_mode`, tomlString("approve")));
    if (server.name === SELFBUILDING_SERVER) {
      argv.push(...override(`${key}.tool_timeout_sec`, String(mcpToolTimeoutMs(hotWaitMs) / 1000)));
    }
  }
  return argv;
}
