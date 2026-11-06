import type { AgentRunContext } from "../agent/context.js";
import { SizeUnavailableError } from "../errors/classes.js";
import { sizeForSpec } from "../sizes/index.js";
import type { ResolvedImage, SandboxKey, SandboxProvider, SandboxSpec } from "../types/sandbox.js";
import type { ResolvedSize, SizeName } from "../types/sizes.js";
import { SELFBUILDING_LABELS, sandboxName } from "./names.js";

/** Image names follow `selfbuilding/<harness>` (spec §5.6); a snapshot restore passes the snapshot id as the ref. */
export function imageFor(harnessId: string | undefined, snapshotId?: string): ResolvedImage {
  const name = harnessId ? `selfbuilding-${harnessId}` : "selfbuilding-all";
  return {
    name,
    ref: snapshotId ?? `selfbuilding/${harnessId ?? "all"}:latest`,
    version: "0.0.0",
  };
}

export function keyFor(ctx: AgentRunContext, scope: string): SandboxKey {
  return { runId: ctx.runId, scope, deployment: ctx.deployment };
}

/** The spec every placement passes to `openOrCreate`, with the labels from spec §5.2. */
export function sandboxSpecFor(
  ctx: AgentRunContext,
  o: {
    key: SandboxKey;
    image: ResolvedImage;
    lifetimeMs: number;
    stepKey?: string;
    launchId?: string;
    parentId?: string;
    /** With `size`: the provider the size is checked against (demo-path §1). */
    provider?: SandboxProvider;
    size?: SizeName;
    /** A fork child: checked against the parent's size on providers whose forks inherit. */
    fork?: { parentSize?: string };
    /** Where a refused size is reported (`sandbox.size_refused`). */
    callPath?: string;
  },
): SandboxSpec {
  const size = resolveBoxSize(ctx, o);
  const labels: Record<string, string> = {
    [SELFBUILDING_LABELS.deployment]: ctx.deployment,
    [SELFBUILDING_LABELS.run]: ctx.runId,
    [SELFBUILDING_LABELS.name]: sandboxName(o.key),
  };
  if (o.stepKey) labels[SELFBUILDING_LABELS.step] = o.stepKey;
  if (o.launchId) labels[SELFBUILDING_LABELS.launch] = o.launchId;
  if (o.parentId) labels[SELFBUILDING_LABELS.parent] = o.parentId;
  if (size) labels[SELFBUILDING_LABELS.size] = size.name;
  return {
    image: o.image,
    env: {},
    lifetimeMs: o.lifetimeMs,
    onExpire: "pause",
    network: ctx.config.egress ?? "open",
    labels,
    ...(size
      ? {
          size,
          resources: {
            vcpu: size.vcpu,
            memoryMiB: size.memoryMiB,
            ...(size.diskGiB !== undefined ? { diskGiB: size.diskGiB } : {}),
          },
        }
      : {}),
  };
}

/** Resolves and checks a box's size, emitting `sandbox.size_refused` once before a refusal is thrown. */
export function resolveBoxSize(
  ctx: AgentRunContext,
  o: {
    image: ResolvedImage;
    provider?: SandboxProvider;
    size?: SizeName;
    fork?: { parentSize?: string };
    callPath?: string;
  },
): ResolvedSize | undefined {
  const harness = o.image.name.startsWith("selfbuilding-") ? o.image.name.slice("selfbuilding-".length) : "all";
  try {
    return sizeForSpec(ctx.config, o.provider, o.size, {
      baseTemplate: o.image.name,
      harness,
      ...(o.fork ? { fork: o.fork } : {}),
    });
  } catch (error) {
    if (error instanceof SizeUnavailableError) {
      ctx.emit({
        type: "sandbox.size_refused",
        level: "error",
        ...(o.callPath ? { callPath: o.callPath } : {}),
        data: {
          provider: error.provider,
          size: error.size,
          vcpu: error.vcpu,
          memoryMiB: error.memoryMiB,
          reason: error.reason,
          fix: error.fix,
        },
      });
    }
    throw error;
  }
}

/** What `sandbox.created` carries about a sized box (demo-path §1.6); empty when no size was asked for. */
export function sizeEventData(
  provider: SandboxProvider,
  spec: SandboxSpec,
): { size?: string; vcpu?: number; memoryMiB?: number; template?: string } {
  const size = spec.size;
  if (!size) return {};
  const sizing = provider.sizing;
  return {
    size: size.name,
    vcpu: size.vcpu,
    memoryMiB: size.memoryMiB,
    ...(sizing?.kind === "template" ? { template: sizing.templateFor(spec.image.name, size.name) } : {}),
  };
}

/** The default sandbox lifetime: the default call timeout (2 h) plus 15 min (spec §6.11). */
export const DEFAULT_LIFETIME_MS = 2 * 3_600_000 + 15 * 60_000;
