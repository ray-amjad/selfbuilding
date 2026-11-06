import { ConfigError, type ResolvedImage, SANDBOX_PATHS } from "@selfbuilding/core";
import { BROWSER_MANIFEST, type BrowserManifest, browserSteps, browserVerifyCommand } from "./browser.js";

export {
  BROWSER_LAUNCH_CHECK,
  BROWSER_MANIFEST,
  BROWSER_MCP_SERVER,
  BROWSER_MIN_SIZE,
  BROWSER_OUTPUT_DIR,
  type BrowserManifest,
  PLAYWRIGHT_BROWSERS_PATH,
  PLAYWRIGHT_MCP_BIN,
  PLAYWRIGHT_MCP_VERSION,
  PLAYWRIGHT_VERSION,
} from "./browser.js";

export type ImageStep =
  | { kind: "run"; commands: string[] }
  | { kind: "verify"; command: string }
  | { kind: "env"; vars: Record<string, string> };

export interface ImageDefinition {
  /** ^[a-z0-9][a-z0-9-]*$, e.g. "selfbuilding-claude-code". */
  name: string;
  from: ImageDefinition | { base: string };
  resources?: { vcpu: number; memoryMiB: number };
  steps: ImageStep[];
  /** Absolute paths of the harness CLIs the image provides; written into the image manifest. */
  binaries?: string[];
  /** The headless browser the image provides; written into the image manifest. */
  browser?: BrowserManifest;
}

const IMAGE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Declares an image once; each provider builds its own format from it (spec §5.6). */
export function defineImage(def: ImageDefinition): ImageDefinition {
  if (!IMAGE_NAME.test(def.name)) {
    throw new ConfigError(`Image name "${def.name}" must match ${IMAGE_NAME}. Use lowercase letters, digits and "-".`);
  }
  const last = def.steps.at(-1);
  if (last?.kind !== "verify") {
    throw new ConfigError(
      `Image "${def.name}" must end with a verify step (for example verify("/usr/local/bin/<binary> --version")), so a build that cannot print a version fails.`,
    );
  }
  for (const bin of def.binaries ?? []) {
    if (!bin.startsWith("/usr/local/bin/")) {
      throw new ConfigError(
        `Image "${def.name}" lists binary "${bin}". Harness binaries live in /usr/local/bin and are called by absolute path.`,
      );
    }
  }
  for (const step of def.steps) {
    if (step.kind === "env") {
      for (const name of Object.keys(step.vars)) {
        if (/(TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)/i.test(name)) {
          throw new ConfigError(`Image "${def.name}" sets ${name}. Images never contain credentials.`);
        }
      }
    }
  }
  return Object.freeze({ ...def, steps: Object.freeze([...def.steps]) as ImageStep[] });
}

export function run(commands: string[]): ImageStep {
  return { kind: "run", commands };
}

export function verify(command: string): ImageStep {
  return { kind: "verify", command };
}

export function env(vars: Record<string, string>): ImageStep {
  return { kind: "env", vars };
}

/** The selfbuilding version the official images are tagged with. */
export const IMAGE_VERSION = "0.1.0";

/** The `'tested'` harness pins baked into the official images (spec §4.11). */
export const HARNESS_VERSIONS = {
  "claude-code": "2.1.316",
  codex: "0.166.0",
} as const;

const TOOL_VERSIONS = { pnpm: "12.16.1", bun: "1.4.4" } as const;

/** npm with an empty user config and scripts on: an inherited ignore-scripts or min-release-age breaks installs.
 * Only the user config is blanked; npm refuses the same file as both user and global config. */
const NPM_GLOBAL = "npm --userconfig=/dev/null --ignore-scripts=false install --global --prefix /usr/local";

const AGENT_DIRS = [SANDBOX_PATHS.workdir, SANDBOX_PATHS.home, SANDBOX_PATHS.out, SANDBOX_PATHS.proc];
const ROOT_DIRS = [
  SANDBOX_PATHS.bin,
  SANDBOX_PATHS.skills,
  "/selfbuilding/contract",
  SANDBOX_PATHS.in,
  SANDBOX_PATHS.launches,
  SANDBOX_PATHS.calls,
  SANDBOX_PATHS.logs,
  SANDBOX_PATHS.secrets,
  "/opt/selfbuilding",
];

/** `selfbuilding-base`: Debian bookworm, Node 22, git, gh, the agent user and the sandbox layout (spec §5.6). */
export const baseImage: ImageDefinition = defineImage({
  name: "selfbuilding-base",
  from: { base: "node:22-bookworm-slim" },
  steps: [
    env({ DEBIAN_FRONTEND: "noninteractive", LANG: "C.UTF-8" }),
    run([
      "apt-get update",
      "apt-get install -y --no-install-recommends ca-certificates curl gnupg git jq ripgrep build-essential unzip python3 procps coreutils",
      "install -d -m 0755 /etc/apt/keyrings",
      "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg",
      "chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg",
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
      "apt-get update",
      "apt-get install -y --no-install-recommends gh",
      "rm -rf /var/lib/apt/lists/*",
    ]),
    run([`${NPM_GLOBAL} pnpm@${TOOL_VERSIONS.pnpm} bun@${TOOL_VERSIONS.bun}`]),
    // The node image ships user "node" at UID 1000; the agent user takes that UID (or the host's, for local Docker).
    run([
      "userdel --remove node 2>/dev/null || true",
      '{ getent group "$AGENT_GID" >/dev/null || groupadd --gid "$AGENT_GID" agent; }',
      'useradd --uid "$AGENT_UID" --gid "$AGENT_GID" --create-home --home-dir /home/agent --shell /bin/bash agent',
    ]),
    run([
      `mkdir -p ${[...ROOT_DIRS, ...AGENT_DIRS].join(" ")}`,
      `chown agent:agent ${AGENT_DIRS.join(" ")}`,
      `printf '#!/bin/sh\\nexec node ${SANDBOX_PATHS.mcpBundle} "$@"\\n' > /usr/local/bin/selfbuilding-mcp`,
      "chmod 0755 /usr/local/bin/selfbuilding-mcp",
    ]),
    verify("node --version && git --version && gh --version && timeout --version >/dev/null"),
  ],
});

/** `selfbuilding-claude-code`: the base image plus the pinned Claude Code CLI. */
export const claudeCodeImage: ImageDefinition = defineImage({
  name: "selfbuilding-claude-code",
  from: baseImage,
  resources: { vcpu: 2, memoryMiB: 4096 },
  binaries: ["/usr/local/bin/claude"],
  steps: [
    env({ DISABLE_AUTOUPDATER: "1" }),
    run([`${NPM_GLOBAL} @anthropic-ai/claude-code@${HARNESS_VERSIONS["claude-code"]}`]),
    verify("/usr/local/bin/claude --version"),
  ],
});

/**
 * `selfbuilding-codex`: the base image plus the pinned Codex CLI, headless Chromium, Playwright, the browser MCP
 * server and sqlite3 (demo-path §3). Browser work needs at least the `medium` size.
 */
export const codexImage: ImageDefinition = defineImage({
  name: "selfbuilding-codex",
  from: baseImage,
  resources: { vcpu: 2, memoryMiB: 4096 },
  binaries: ["/usr/local/bin/codex"],
  browser: BROWSER_MANIFEST,
  steps: [
    run([`${NPM_GLOBAL} @openai/codex@${HARNESS_VERSIONS.codex}`]),
    ...browserSteps(NPM_GLOBAL),
    verify(browserVerifyCommand("/usr/local/bin/codex")),
  ],
});

/**
 * `selfbuilding-all-harnesses`: the base image plus both pinned harness CLIs and the Codex image's browser, so one
 * template serves calls on either harness (release-prep §4.3). Browser work needs at least the `medium` size.
 */
export const allHarnessesImage: ImageDefinition = defineImage({
  name: "selfbuilding-all-harnesses",
  from: baseImage,
  resources: { vcpu: 2, memoryMiB: 4096 },
  binaries: ["/usr/local/bin/claude", "/usr/local/bin/codex"],
  browser: BROWSER_MANIFEST,
  steps: [
    env({ DISABLE_AUTOUPDATER: "1" }),
    run([`${NPM_GLOBAL} @anthropic-ai/claude-code@${HARNESS_VERSIONS["claude-code"]}`]),
    run([`${NPM_GLOBAL} @openai/codex@${HARNESS_VERSIONS.codex}`]),
    ...browserSteps(NPM_GLOBAL),
    verify(`/usr/local/bin/claude --version && ${browserVerifyCommand("/usr/local/bin/codex")}`),
  ],
});

/** The official images, keyed by the short name used in `selfbuilding/<short>:<version>`. */
export const officialImages: Readonly<Record<string, ImageDefinition>> = Object.freeze({
  base: baseImage,
  "claude-code": claudeCodeImage,
  codex: codexImage,
  "all-harnesses": allHarnessesImage,
});

/** "selfbuilding-claude-code" → "claude-code". */
export function shortName(def: ImageDefinition): string {
  return def.name.replace(/^selfbuilding-/, "");
}

/** The OCI reference Docker uses: `selfbuilding/<short>:<tag>`. */
export function dockerImageRef(def: ImageDefinition, tag: string = IMAGE_VERSION): string {
  return `selfbuilding/${shortName(def)}:${tag}`;
}

/** The `ResolvedImage` a Docker sandbox spec carries for an official image. */
export function resolveDockerImage(def: ImageDefinition, version: string = IMAGE_VERSION): ResolvedImage {
  return { name: def.name, ref: dockerImageRef(def, version), version };
}

/** Finds the official definition behind `selfbuilding/<short>:<tag>`, or undefined for any other reference. */
export function officialImageFor(ref: string): { def: ImageDefinition; tag: string } | undefined {
  const match = /^selfbuilding\/([a-z0-9-]+):([A-Za-z0-9_.-]+)$/.exec(ref);
  const def = match ? officialImages[match[1] as string] : undefined;
  return def && match ? { def, tag: match[2] as string } : undefined;
}

/** `/opt/selfbuilding/image-manifest.json`. The runtime's `runtime` boot phase refuses to start without it. */
export interface ImageManifest {
  image: string;
  version: string;
  user: string;
  binaries: string[];
  browser?: BrowserManifest;
}

export function imageManifest(def: ImageDefinition, version: string = IMAGE_VERSION): ImageManifest {
  const manifest: ImageManifest = { image: def.name, version, user: "agent", binaries: [...(def.binaries ?? [])] };
  if (def.browser) manifest.browser = { ...def.browser };
  return manifest;
}

export const IMAGE_MANIFEST_PATH = "/opt/selfbuilding/image-manifest.json";

/**
 * Whether an ENV value can be written without quotes. Vendor Dockerfile parsers keep the quotes of `ENV A="/x"` as
 * part of the value, so every value that needs none is written bare (release-prep §4.1).
 */
export function isPlainEnvValue(value: string): boolean {
  return /^[A-Za-z0-9_./:@%+,=-]*$/.test(value);
}

/**
 * Renders a definition as a Dockerfile. An image built from another definition starts `FROM $BASE_IMAGE`, a build
 * arg defaulting to the parent's official reference; `AGENT_UID`/`AGENT_GID` match the host user for local Docker.
 */
export function toDockerfile(def: ImageDefinition, opts: { version?: string } = {}): string {
  const version = opts.version ?? IMAGE_VERSION;
  // The syntax directive is only honoured on the first line.
  const lines = ["# syntax=docker/dockerfile:1", "# Generated from @selfbuilding/images. Do not edit by hand."];
  if ("base" in def.from) {
    lines.push(`FROM ${def.from.base}`, "ARG AGENT_UID=1000", "ARG AGENT_GID=1000");
  } else {
    lines.push(`ARG BASE_IMAGE=${dockerImageRef(def.from, version)}`, "FROM $BASE_IMAGE");
  }
  lines.push("USER root", 'SHELL ["/bin/sh", "-euc"]');
  for (const step of def.steps) {
    switch (step.kind) {
      case "env":
        lines.push(
          `ENV ${Object.entries(step.vars)
            .map(([k, v]) => `${k}=${isPlainEnvValue(v) ? v : JSON.stringify(v)}`)
            .join(" ")}`,
        );
        break;
      case "run":
        lines.push(`RUN ${step.commands.join(" \\\n  && ")}`);
        break;
      case "verify":
        if (step === def.steps.at(-1)) {
          lines.push(
            `RUN mkdir -p /opt/selfbuilding && printf '%s\\n' '${JSON.stringify(imageManifest(def, version))}' > ${IMAGE_MANIFEST_PATH}`,
          );
        }
        lines.push(`RUN ${step.command}`);
        break;
    }
  }
  lines.push(`WORKDIR ${SANDBOX_PATHS.workdir}`, `LABEL org.opencontainers.image.title="${def.name}"`, "");
  return lines.join("\n");
}

// `selfbuilding images build` (docs/spec/demo-path.md §2): sizes, the limit check, the build loop and output.
export {
  buildSizeTable,
  checkBuildSize,
  formatBuildLine,
  IMAGE_HARNESSES,
  type PlannedBuild,
  planImageBuilds,
  type RunImageBuildsOptions,
  resolveBuildSizes,
  runImageBuilds,
  sizesHint,
} from "./build/index.js";

// Self-contained Dockerfiles for registry-free template builds (docs/spec/release-prep.md §4).
export { type StandaloneDockerfileOptions, toStandaloneDockerfile } from "./standalone.js";
