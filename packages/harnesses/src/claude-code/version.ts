import { type Command, ConfigError, type InstallPlan, type VersionSpec } from "@selfbuilding/core";

/** Where official images put the CLI (spec §5.6); the adapter always calls it by this absolute path. */
export const CLAUDE_CODE_BINARY = "/usr/local/bin/claude";
export const CLAUDE_CODE_NPM_PACKAGE = "@anthropic-ai/claude-code";
/** The version this release pins for `version: "tested"`; images bake it in (spec §4.11). */
export const CLAUDE_CODE_TESTED_VERSION = "2.1.316";
export const CLAUDE_CODE_INSTALL_HOSTS: readonly string[] = ["registry.npmjs.org"];

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isExactVersion(version: string): boolean {
  return EXACT_VERSION.test(version);
}

function assertExact(version: string, what: string): void {
  if (!isExactVersion(version)) {
    throw new ConfigError(
      `${what} needs an exact Claude Code version such as "${CLAUDE_CODE_TESTED_VERSION}", got "${version}". Resolve "tested" or "latest" with resolveClaudeCodeVersion() first.`,
    );
  }
}

/**
 * Installs one exact version with npm. An empty npmrc keeps inherited `ignore-scripts` or `min-release-age` settings
 * from producing a broken binary, and postinstall scripts run explicitly (spec §4.11 rule 8).
 */
export function claudeCodeInstallPlan(version: string, binary = CLAUDE_CODE_BINARY): InstallPlan {
  assertExact(version, "install()");
  const prefix = binary.endsWith("/bin/claude") ? binary.slice(0, -"/bin/claude".length) || "/" : "/usr/local";
  const npmEnv = {
    NPM_CONFIG_USERCONFIG: "/dev/null",
    NPM_CONFIG_IGNORE_SCRIPTS: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
  const commands: Command[] = [
    {
      argv: [
        "/usr/bin/env",
        "npm",
        "install",
        "--global",
        "--prefix",
        prefix,
        "--foreground-scripts",
        `${CLAUDE_CODE_NPM_PACKAGE}@${version}`,
      ],
      env: npmEnv,
      user: "root",
      timeoutMs: 60_000,
    },
    { argv: [binary, "--version"], env: { DISABLE_AUTOUPDATER: "1" }, timeoutMs: 15_000 },
  ];
  return { version, commands, binary };
}

/** The image step that bakes a pinned version into an official image (spec §5.6). */
export function claudeCodeImageInstallCommand(version = CLAUDE_CODE_TESTED_VERSION): string {
  assertExact(version, "The image install step");
  return `NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_IGNORE_SCRIPTS=false npm install --global --prefix /usr/local --foreground-scripts ${CLAUDE_CODE_NPM_PACKAGE}@${version}`;
}

/** `claude --version` prints e.g. "2.1.316 (Claude Code)". */
export function parseClaudeCodeVersion(stdout: string): string {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(stdout);
  if (!match?.[1]) {
    throw new ConfigError(`Could not read a Claude Code version from "${stdout.trim().slice(0, 200)}".`);
  }
  return match[1];
}

export interface VersionResolution {
  /** A hold from `harnessHold["claude-code"]`. */
  hold?: string;
  /** The registry's newest version, looked up by the host when the spec is "latest". */
  latest?: string;
  /** The version that wrote the session being resumed; it wins over everything (spec §4.7). */
  sessionVersion?: string;
}

/** Resolves a version policy to one exact version, in the spec §4.11 priority order. Pure: the host does lookups. */
export function resolveClaudeCodeVersion(spec: VersionSpec = "tested", ctx: VersionResolution = {}): string {
  if (ctx.sessionVersion !== undefined) {
    assertExact(ctx.sessionVersion, "A resume");
    return ctx.sessionVersion;
  }
  if (spec !== "tested" && spec !== "latest") {
    assertExact(spec, "The version option");
    return spec;
  }
  if (ctx.hold !== undefined) {
    assertExact(ctx.hold, "harnessHold");
    return ctx.hold;
  }
  if (spec === "latest") {
    if (ctx.latest === undefined) {
      throw new ConfigError('version "latest" needs the registry\'s newest version; pass it as { latest }.');
    }
    assertExact(ctx.latest, "The latest version");
    return ctx.latest;
  }
  return CLAUDE_CODE_TESTED_VERSION;
}
