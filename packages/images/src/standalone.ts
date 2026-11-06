import { ConfigError, SANDBOX_PATHS } from "@selfbuilding/core";
import {
  IMAGE_MANIFEST_PATH,
  IMAGE_VERSION,
  type ImageDefinition,
  type ImageStep,
  imageManifest,
  isPlainEnvValue,
} from "./index.js";

// One self-contained Dockerfile per image, for vendors that build templates from a Dockerfile when no registry
// holds the published images (docs/spec/release-prep.md §4.1).

export interface StandaloneDockerfileOptions {
  /** The selfbuilding release written into the image manifest. Default IMAGE_VERSION. */
  version?: string;
  /** Inlined where the base image uses $AGENT_UID / $AGENT_GID (vendor builds take no build args). Default 1000. */
  agentUid?: number;
  agentGid?: number;
}

/** `def` and every parent it is built `from`, root first. */
function lineage(def: ImageDefinition): { base: string; chain: ImageDefinition[] } {
  const chain: ImageDefinition[] = [];
  let current: ImageDefinition = def;
  for (;;) {
    if (chain.includes(current)) {
      throw new ConfigError(`Image "${def.name}" is built from itself through "${current.name}". Break the cycle.`);
    }
    chain.unshift(current);
    if ("base" in current.from) return { base: current.from.base, chain };
    current = current.from;
  }
}

function agentId(name: "agentUid" | "agentGid", value: number | undefined): string {
  const id = value ?? 1000;
  // 0 is root's id; the agent user must be someone else.
  if (!Number.isInteger(id) || id < 1 || id > 2_147_483_647) {
    throw new ConfigError(`toStandaloneDockerfile: ${name} ${value} must be a positive integer, e.g. 1000.`);
  }
  return String(id);
}

/**
 * Flattens `def` and every parent it is built `from` into one Dockerfile with a single `FROM <root base>`, no `ARG`,
 * unquoted `ENV` values, and every `RUN` in a form vendor parsers keep verbatim. Throws ConfigError when an ENV value
 * cannot be written unquoted.
 */
export function toStandaloneDockerfile(def: ImageDefinition, opts: StandaloneDockerfileOptions = {}): string {
  const version = opts.version ?? IMAGE_VERSION;
  const uid = agentId("agentUid", opts.agentUid);
  const gid = agentId("agentGid", opts.agentGid);
  // Vendor builds take no build args, so the ids the base image reads from ARGs are written in.
  const inline = (command: string): string =>
    command.replace(/\$\{AGENT_UID\}|\$AGENT_UID\b/g, uid).replace(/\$\{AGENT_GID\}|\$AGENT_GID\b/g, gid);

  const { base, chain } = lineage(def);
  const lines = [
    "# Generated from @selfbuilding/images (standalone: one FROM, no ARG). Do not edit by hand.",
    `FROM ${base}`,
    "USER root",
    'SHELL ["/bin/sh", "-euc"]',
  ];
  for (const image of chain) {
    const steps: readonly ImageStep[] = image.steps;
    for (const step of steps) {
      switch (step.kind) {
        case "env":
          lines.push(
            `ENV ${Object.entries(step.vars)
              .map(([k, v]) => `${k}=${plainEnv(image, k, v)}`)
              .join(" ")}`,
          );
          break;
        case "run":
          lines.push(runLine(step.commands.map(inline)));
          break;
        case "verify":
          // Only the leaf's manifest is written: an ancestor's would be overwritten anyway, and its verify still runs.
          if (image === def && step === steps.at(-1)) {
            lines.push(
              runLine([
                `mkdir -p /opt/selfbuilding && printf '%s\\n' '${JSON.stringify(imageManifest(def, version))}' > ${IMAGE_MANIFEST_PATH}`,
              ]),
            );
          }
          lines.push(runLine([inline(step.command)]));
          break;
      }
    }
  }
  lines.push(`WORKDIR ${SANDBOX_PATHS.workdir}`, `LABEL org.opencontainers.image.title="${def.name}"`, "");
  return lines.join("\n");
}

/**
 * One `RUN`. Some vendor parsers rewrite a shell-form command: they drop backslashes (`printf 'a\nb'` becomes
 * `printf 'anb'`) and collapse runs of whitespace, even inside quotes. A command that would change is written
 * base64-encoded and decoded in the box, which every parser passes through untouched.
 */
function runLine(commands: readonly string[]): string {
  const script = commands.join(" && ");
  if (!/[\\\n\r\t]|\s{2}/.test(script)) return `RUN ${commands.join(" \\\n  && ")}`;
  return `RUN sh -euc "$(echo ${Buffer.from(script, "utf8").toString("base64")} | base64 -d)"`;
}

function plainEnv(image: ImageDefinition, name: string, value: string): string {
  if (isPlainEnvValue(value)) return value;
  throw new ConfigError(
    `Image "${image.name}" sets ENV ${name}=${JSON.stringify(value)}, which a vendor Dockerfile parser would misread when quoted. Use a value without spaces, quotes, $ or backslashes, or build this image from a registry (set SELFBUILDING_IMAGE_REGISTRY).`,
  );
}
