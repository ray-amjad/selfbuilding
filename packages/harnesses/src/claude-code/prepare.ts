import {
  ConfigError,
  type FilePlan,
  type McpServerSpec,
  type PlannedFile,
  type PrepareContext,
} from "@selfbuilding/core";

export const SELFBUILDING_SERVER = "selfbuilding";
export const SUBMIT_TOOL = `mcp__${SELFBUILDING_SERVER}__submit_result`;
/** The MCP tool timeout is the effective hot wait plus this margin (spec §6.11). */
export const MCP_TOOL_TIMEOUT_MARGIN_MS = 120_000;
export const CLAUDE_SKILL_DIR = ".claude/skills";

/** Files the adapter writes under `{home}`. */
export function claudeConfigPaths(home: string) {
  return {
    configDir: `${home}/.claude`,
    mcpConfig: `${home}/mcp.json`,
    settings: `${home}/settings.json`,
    stopHook: `${home}/.selfbuilding/stop-after-submit.sh`,
  };
}

export function mcpToolTimeoutMs(hotWaitMs: number): number {
  return Math.max(0, Math.ceil(hotWaitMs)) + MCP_TOOL_TIMEOUT_MARGIN_MS;
}

// The hook runs only after a successful call; the error check is a second guard so an invalid submission can never
// end the turn early. The supervisor answers an accepted submit with isError false (spec §4.5).
const STOP_HOOK = `#!/bin/sh
input=$(cat)
case "$input" in
  *'"isError":true'*|*'"is_error":true'*) exit 0 ;;
esac
printf '%s\\n' '{"continue":false,"stopReason":"result submitted"}'
`;

type ClaudeMcpEntry =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; alwaysLoad?: boolean }
  | { type: "http"; url: string; headers: Record<string, string>; alwaysLoad?: boolean };

function renderServer(server: McpServerSpec, alwaysLoad: boolean): ClaudeMcpEntry {
  const always = alwaysLoad ? { alwaysLoad: true } : {};
  if (server.type === "stdio") {
    return { type: "stdio", command: server.command, args: server.args ?? [], env: server.env ?? {}, ...always };
  }
  return { type: "http", url: server.url, headers: server.headers ?? {}, ...always };
}

/**
 * `{home}/mcp.json`. The selfbuilding server comes first and later entries with its name are dropped, so it cannot be
 * shadowed. It is marked `alwaysLoad` so `submit_result` is never deferred behind tool search (spec §4.5).
 */
export function renderMcpConfig(servers: readonly McpServerSpec[]): { mcpServers: Record<string, ClaudeMcpEntry> } {
  const ordered = [
    ...servers.filter((s) => s.name === SELFBUILDING_SERVER).slice(0, 1),
    ...servers.filter((s) => s.name !== SELFBUILDING_SERVER),
  ];
  const mcpServers: Record<string, ClaudeMcpEntry> = {};
  for (const server of ordered) {
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) {
      throw new ConfigError(`MCP server name "${server.name}" may only use letters, digits, "_" and "-".`);
    }
    if (server.name in mcpServers) continue;
    mcpServers[server.name] = renderServer(server, server.name === SELFBUILDING_SERVER);
  }
  return { mcpServers };
}

/** `{home}/settings.json`: no vendor attribution (that is Selfbuilding's job, spec §6.13) and the stop hook. */
export function renderSettings(home: string, toolTimeoutMs: number) {
  return {
    attribution: { commit: "", pr: "" },
    includeCoAuthoredBy: false,
    env: { MCP_TOOL_TIMEOUT: String(toolTimeoutMs) },
    hooks: {
      PostToolUse: [
        {
          matcher: SUBMIT_TOOL,
          hooks: [{ type: "command", command: `/bin/sh ${claudeConfigPaths(home).stopHook}` }],
        },
      ],
    },
  };
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function claudeCodePrepare(ctx: PrepareContext): FilePlan {
  const paths = claudeConfigPaths(ctx.paths.home);
  const timeout = mcpToolTimeoutMs(ctx.hotWaitMs);
  const files: PlannedFile[] = [
    // MCP entries may carry secrets in env or headers, so the file is private (spec §4.8).
    { path: paths.mcpConfig, content: `${JSON.stringify(renderMcpConfig(ctx.mcpServers), null, 2)}\n`, mode: 0o600 },
    {
      path: paths.settings,
      content: `${JSON.stringify(renderSettings(ctx.paths.home, timeout), null, 2)}\n`,
      mode: 0o644,
    },
    { path: paths.stopHook, content: STOP_HOOK, mode: 0o755 },
  ];
  const symlinks: FilePlan["symlinks"] = [];
  const gitExcludes: string[] = [];
  for (const name of ctx.skills) {
    if (!SKILL_NAME.test(name) || name.includes("..")) {
      throw new ConfigError(`Skill name "${name}" cannot be linked; use letters, digits, ".", "_" and "-".`);
    }
    symlinks.push({ path: `${ctx.paths.workdir}/${CLAUDE_SKILL_DIR}/${name}`, target: `${ctx.paths.skills}/${name}` });
    gitExcludes.push(`/${CLAUDE_SKILL_DIR}/${name}`);
  }
  return { files, symlinks, gitExcludes, mcpToolTimeoutMs: timeout };
}
