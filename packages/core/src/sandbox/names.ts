import type { SandboxKey } from "../types/sandbox.js";
import { base32, sha256, sha256Hex } from "./hash.js";

/** The only label names (spec §5.2). Adapters store them as metadata, labels or tags. */
export const SELFBUILDING_LABELS = {
  deployment: "selfbuilding.deployment",
  run: "selfbuilding.run",
  name: "selfbuilding.name",
  step: "selfbuilding.step",
  launch: "selfbuilding.launch",
  hostRun: "selfbuilding.hostRun",
  parent: "selfbuilding.parent",
  expiresAt: "selfbuilding.expiresAt",
  /** The size name a box was created at (demo-path §1.6). */
  size: "selfbuilding.size",
} as const;

/** `"ns-" + base32(sha256(runId:scope)).slice(0, 20)`. Adapters receive the name and never derive their own. */
export function sandboxName(key: SandboxKey): string {
  return `ns-${base32(sha256(`${key.runId}:${key.scope}`)).slice(0, 20)}`;
}

function slug(scope: string): string {
  return scope
    .toLowerCase()
    .replace(/^root\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shortSlug(scope: string): string {
  const s = slug(scope);
  if (s.length <= 60) return s;
  return `${s.slice(0, 53).replace(/-+$/, "")}-${sha256Hex(scope).slice(0, 6)}`;
}

/**
 * `selfbuilding/<runId>/<scope-slug>` (spec §6.13). The slug is lowercase with every run of [^a-z0-9]
 * replaced by "-", trimmed, a leading "root/" dropped; over 60 chars it becomes the first 53 chars,
 * "-" and 6 hex chars of sha256(scope).
 */
export function branchName(runId: string, scope: string): string {
  return `selfbuilding/${runId}/${shortSlug(scope)}`;
}

/** `refs/selfbuilding/<runId>/<boxId-slug>/<version>` (spec §6.13). */
export function checkpointRef(runId: string, boxId: string, version: number): string {
  return `refs/selfbuilding/${runId}/${shortSlug(boxId)}/${version}`;
}

/** `refs/selfbuilding/wip/<runId>/<stepKey>` (spec §5.8). */
export function wipRef(runId: string, stepKey: string): string {
  return `refs/selfbuilding/wip/${runId}/${stepKey}`;
}

/** True when the host may push this ref without an explicit `git.allowPushTo` entry (spec §6.13). */
export function isAllowedPushRef(ref: string, allowPushTo: readonly string[] = []): boolean {
  const full = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
  if (full.startsWith("refs/heads/selfbuilding/") || full.startsWith("refs/selfbuilding/")) return true;
  return allowPushTo.some((allowed) => {
    const a = allowed.startsWith("refs/") ? allowed : `refs/heads/${allowed}`;
    return a.endsWith("/**") ? full.startsWith(a.slice(0, -2)) : a === full;
  });
}
