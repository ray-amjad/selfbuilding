import { createHash } from "node:crypto";
import { type SandboxKey, type SandboxState, SELFBUILDING_LABELS } from "@selfbuilding/core";

/**
 * Adapter-private container labels. They stay outside the `selfbuilding.*` namespace (spec §5.2 allows no other
 * names there) and surface on the ref as `meta`, never as `labels`.
 */
export const PRIVATE = {
  scope: "sandbox-docker.scope",
  createdAt: "sandbox-docker.createdAt",
  onExpire: "sandbox-docker.onExpire",
} as const;

const SELFBUILDING_PREFIX = "selfbuilding.";

/**
 * The full label set for a new container. Every `selfbuilding.*` label the core did not set is written empty, because
 * a box made from a snapshot or fork image would otherwise inherit its source's step, launch and parent labels.
 */
export function containerLabels(
  key: SandboxKey,
  labels: Record<string, string>,
  o: { createdAt: string; expiresAt: string; onExpire: string },
): Record<string, string> {
  const masked = Object.fromEntries(Object.values(SELFBUILDING_LABELS).map((name) => [name, ""]));
  return {
    ...masked,
    ...labels,
    [SELFBUILDING_LABELS.deployment]: key.deployment,
    [SELFBUILDING_LABELS.run]: labels[SELFBUILDING_LABELS.run] || key.runId,
    [SELFBUILDING_LABELS.name]: labels[SELFBUILDING_LABELS.name] || fallbackName(key),
    [SELFBUILDING_LABELS.expiresAt]: o.expiresAt,
    [PRIVATE.scope]: key.scope,
    [PRIVATE.createdAt]: o.createdAt,
    [PRIVATE.onExpire]: o.onExpire,
  };
}

/** The `selfbuilding.*` labels with a value; masked (empty) labels are dropped. */
export function publicLabels(labels: Record<string, string> | null | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels ?? {}).filter(([name, value]) => name.startsWith(SELFBUILDING_PREFIX) && value !== ""),
  );
}

/** Used only when the core sent no `selfbuilding.name` label. */
function fallbackName(key: SandboxKey): string {
  const digest = createHash("sha256").update(`${key.deployment}\0${key.runId}\0${key.scope}`).digest("hex");
  return `sb-${digest.slice(0, 20)}`;
}

/**
 * The container name: the sandbox name plus the deployment, so the daemon's unique-name rule makes create atomic per
 * key (invariant 7) and two deployments sharing a daemon never collide.
 */
export function containerName(labels: Record<string, string>): string {
  const name = labels[SELFBUILDING_LABELS.name] ?? "";
  const deployment = labels[SELFBUILDING_LABELS.deployment] ?? "";
  const raw = `${name}.${deployment}`.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  return /^[a-zA-Z0-9]/.test(raw) ? raw : `sb${raw}`;
}

/** Docker's states, normalised (invariant 16). Unknown states never throw. */
export function normaliseState(status: string | undefined, paused = false): SandboxState {
  if (paused) return "paused";
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "created":
    case "restarting":
      return "starting";
    case "exited":
    case "removing":
      return "stopped";
    case "dead":
      return "error";
    default:
      return "unknown";
  }
}

export const STATE_RANK: Record<SandboxState, number> = {
  running: 0,
  paused: 1,
  starting: 2,
  stopped: 3,
  unknown: 4,
  error: 5,
};

// Variable names that carry credentials. Secrets reach a box only as 0600 files (invariant 18).
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|AUTH)($|_)/i;

export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Single-quotes a value for /bin/sh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
