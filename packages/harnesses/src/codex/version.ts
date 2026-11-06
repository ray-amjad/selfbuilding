import {
  type Command,
  ConfigError,
  HarnessProtocolError,
  HarnessVersionUnavailableError,
  type InstallPlan,
  type VersionSpec,
} from "@selfbuilding/core";
import { CODEX_NPM_PACKAGE, CODEX_TESTED_VERSION } from "./constants.js";

// Version policy for Codex (spec §4.11). The host resolves the policy to an exact version before the call starts
// and journals it; the runtime only ever sees that exact string.

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const isExactVersion = (version: string): boolean => EXACT.test(version);

/** `codex --version` prints `codex-cli 0.164.0`. */
export function parseCodexVersion(stdout: string): string {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(stdout);
  if (!match?.[1]) {
    throw new HarnessProtocolError(`Cannot read a Codex version from ${JSON.stringify(stdout.trim().slice(0, 200))}.`);
  }
  return match[1];
}

export interface CodexVersionInput {
  /** The harness value's `version` option. Default "tested". */
  version?: VersionSpec;
  /** `harnessHold.codex` from config. */
  hold?: string;
  /** Set when resuming: the exact version that wrote the session. Nothing else applies then. */
  sessionVersion?: string;
  /** The registry's latest version, resolved by the host when the policy is "latest". */
  latest?: string;
}

export interface ResolvedCodexVersion {
  version: string;
  source: "session" | "exact" | "hold" | "latest" | "tested";
  /** False for versions outside the tested pin: the run emits `harness.untested_version`. */
  tested: boolean;
}

function exact(version: string, what: string): string {
  if (!isExactVersion(version)) {
    throw new ConfigError(
      `${what} must be an exact Codex version such as "${CODEX_TESTED_VERSION}", not ${JSON.stringify(version)}.`,
    );
  }
  return version;
}

/** Which version an agent call runs, highest priority first (spec §4.11 table). */
export function resolveCodexVersion(input: CodexVersionInput = {}): ResolvedCodexVersion {
  const result = (version: string, source: ResolvedCodexVersion["source"]): ResolvedCodexVersion => ({
    version,
    source,
    tested: version === CODEX_TESTED_VERSION,
  });
  if (input.sessionVersion !== undefined) return result(exact(input.sessionVersion, "The session version"), "session");
  const policy = input.version ?? "tested";
  if (policy !== "tested" && policy !== "latest") return result(exact(policy, "The version option"), "exact");
  if (input.hold !== undefined) return result(exact(input.hold, "harnessHold.codex"), "hold");
  if (policy === "latest") {
    if (input.latest === undefined) {
      throw new HarnessVersionUnavailableError({ harness: "codex", version: "latest", reason: "network" });
    }
    return result(exact(input.latest, "The latest version from the registry"), "latest");
  }
  return result(CODEX_TESTED_VERSION, "tested");
}

/** The prefix whose `bin/` holds the binary: `/usr/local` for `/usr/local/bin/codex`. */
export function installPrefix(binary: string): string {
  const match = /^(\/.*)\/bin\/[^/]+$/.exec(binary);
  if (!match?.[1]) {
    throw new ConfigError(`Cannot install Codex for ${JSON.stringify(binary)}: the binary must live in <prefix>/bin/.`);
  }
  return match[1];
}

/**
 * Installs one exact version from npm. The npmrc files are emptied and scripts are allowed, because an inherited
 * `ignore-scripts` or `min-release-age` gives broken installs or a misleading "no matching version" (spec §4.11).
 */
export function codexInstallPlan(version: string, binary: string): InstallPlan {
  exact(version, "The install version");
  const install: Command = {
    argv: [
      "/usr/bin/env",
      "npm",
      "install",
      "--global",
      "--prefix",
      installPrefix(binary),
      "--no-fund",
      "--no-audit",
      `${CODEX_NPM_PACKAGE}@${version}`,
    ],
    env: {
      NPM_CONFIG_USERCONFIG: "/dev/null",
      NPM_CONFIG_IGNORE_SCRIPTS: "false",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    },
    user: "root",
    timeoutMs: 5 * 60 * 1000,
  };
  return { version, commands: [install, { argv: [binary, "--version"], timeoutMs: 30_000 }], binary };
}
