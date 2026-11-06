import {
  BUILT_IN_SIZES,
  type ImageBuilder,
  type ImageBuildResult,
  type ImageHarness,
  type MachineSize,
  type ResolvedSize,
  type SelfbuildingError,
  type SizeCheck,
  type SizeTable,
  SizeUnavailableError,
  SizeUnknownError,
} from "@selfbuilding/core";

// The provider-neutral half of `selfbuilding images build` (docs/spec/demo-path.md §2): which (provider, harness,
// size) triples to build, the limit check before any build, the build loop and its output lines. Each provider
// package supplies the `ImageBuilder`; the CLI parses flags and prints.

export const IMAGE_HARNESSES: readonly ImageHarness[] = Object.freeze(["claude-code", "codex"]);

/** The built-in presets plus the config's own names. The config loader rejects a redefined built-in. */
export function buildSizeTable(custom?: SizeTable): Readonly<Record<string, MachineSize>> {
  return Object.freeze({ ...BUILT_IN_SIZES, ...custom });
}

/** Resolves `--size` values; "all" means every name in the table. An unknown name throws SizeUnknownError. */
export function resolveBuildSizes(
  table: Readonly<Record<string, MachineSize>>,
  names: readonly string[],
): ResolvedSize[] {
  const wanted = names.includes("all") ? Object.keys(table) : [...new Set(names)];
  return wanted.map((name) => {
    const size = table[name];
    if (!size) throw new SizeUnknownError({ size: name, known: Object.keys(table) });
    return { name, ...size };
  });
}

/**
 * Whether a builder's provider can run `size` at all. Availability is ignored: building is what makes a size
 * available. Pure; never calls the vendor.
 */
export function checkBuildSize(builder: ImageBuilder, size: ResolvedSize): SizeCheck {
  const limits = builder.sizing.limits;
  if (
    (limits.maxVcpu !== undefined && size.vcpu > limits.maxVcpu) ||
    (limits.maxMemoryMiB !== undefined && size.memoryMiB > limits.maxMemoryMiB) ||
    (limits.maxDiskGiB !== undefined && size.diskGiB !== undefined && size.diskGiB > limits.maxDiskGiB)
  ) {
    return {
      ok: false,
      reason: "over-limit",
      fix: limits.overLimitFix ?? "Use a smaller size, or run this size on another provider.",
    };
  }
  const choices = limits.vcpuChoices;
  const perVcpu = limits.memoryPerVcpuMiB;
  if (
    (choices !== undefined && !choices.includes(size.vcpu)) ||
    (perVcpu !== undefined && size.memoryMiB !== size.vcpu * perVcpu)
  ) {
    const offers = [
      ...(choices ? [`${choices.join(", ")} vCPU`] : []),
      ...(perVcpu ? [`${perVcpu} MiB per vCPU`] : []),
    ].join(" with ");
    return {
      ok: false,
      reason: "invalid-shape",
      fix: `"${builder.provider}" offers ${offers}. Define a size with one of them in the config's sizes table.`,
    };
  }
  return { ok: true };
}

/** One (provider, harness, size) the run will build, or why it will not. */
export interface PlannedBuild {
  builder: ImageBuilder;
  harness: ImageHarness;
  size: ResolvedSize;
  name: string;
  /** Set when the size was refused before building. */
  refusal?: SizeUnavailableError;
}

/**
 * Every triple to build, in order: providers one after another, harnesses, then sizes. Docker sizes at create, so
 * it builds once per harness (with the first size that fits its host limit).
 */
export function planImageBuilds(
  builders: readonly ImageBuilder[],
  harnesses: readonly ImageHarness[],
  sizes: readonly ResolvedSize[],
): PlannedBuild[] {
  const plan: PlannedBuild[] = [];
  for (const builder of builders) {
    for (const harness of harnesses) {
      let builtOnce = false;
      for (const size of sizes) {
        const check = checkBuildSize(builder, size);
        const name = builder.nameFor(harness, size.name);
        if (!check.ok) {
          const refusal = new SizeUnavailableError({
            provider: builder.provider,
            size: size.name,
            vcpu: size.vcpu,
            memoryMiB: size.memoryMiB,
            reason: check.reason,
            fix: check.fix,
          });
          plan.push({ builder, harness, size, name, refusal });
          continue;
        }
        if (builder.sizing.kind !== "template") {
          if (builtOnce) continue;
          builtOnce = true;
        }
        plan.push({ builder, harness, size, name });
      }
    }
  }
  return plan;
}

export interface RunImageBuildsOptions {
  plan: readonly PlannedBuild[];
  version: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Called before each triple that will be built (or, in a dry run, would be); not for refused ones. */
  onStart?: (planned: PlannedBuild) => void;
  /** Called with each result as soon as it is known. */
  onResult?: (result: ImageBuildResult, planned: PlannedBuild) => void;
  onLog?: (planned: PlannedBuild, line: string) => void;
  /**
   * A provider whose builder could not be made (a missing API key): every one of its triples fails with this error
   * and nothing is sent to it.
   */
  unavailable?: ReadonlyMap<string, SelfbuildingError>;
}

/** Builds the plan one triple at a time: vendors rate-limit template builds. */
export async function runImageBuilds(opts: RunImageBuildsOptions): Promise<ImageBuildResult[]> {
  const results: ImageBuildResult[] = [];
  for (const planned of opts.plan) {
    const { builder, harness, size, name } = planned;
    const base = { provider: builder.provider, harness, size: size.name, name };
    const missing = opts.unavailable?.get(builder.provider);
    let result: ImageBuildResult;
    if (planned.refusal) {
      result = { ok: false, ...base, error: planned.refusal.toJSON() };
    } else if (missing) {
      result = { ok: false, ...base, error: missing.toJSON() };
    } else if (opts.dryRun) {
      opts.onStart?.(planned);
      result = { ok: true, ...base, durationMs: 0 };
    } else {
      opts.signal?.throwIfAborted();
      opts.onStart?.(planned);
      const onLog = opts.onLog;
      result = await builder.build({
        harness,
        size,
        version: opts.version,
        name,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(onLog ? { onLog: (line: string) => onLog(planned, line) } : {}),
      });
    }
    results.push(result);
    opts.onResult?.(result, planned);
  }
  return results;
}

/**
 * One output line: `ok   e2b      codex        medium  selfbuilding-codex-medium  4 vCPU 8192 MiB  312s`, or
 * `fail impello  codex        large   selfbuilding-codex-large   size_unavailable: <message>`.
 */
export function formatBuildLine(result: ImageBuildResult, size: ResolvedSize, o: { dryRun?: boolean } = {}): string {
  const status = result.ok ? (o.dryRun ? "dry" : "ok") : "fail";
  const head = `${status.padEnd(4)} ${result.provider.padEnd(8)} ${result.harness.padEnd(12)} ${result.size.padEnd(7)} ${result.name.padEnd(26)}`;
  if (!result.ok) return `${head} ${result.error.code}: ${result.error.message}`;
  const machine = `${size.vcpu} vCPU ${size.memoryMiB} MiB`;
  return `${head} ${machine}  ${o.dryRun ? "would build" : `${Math.round(result.durationMs / 1000)}s`}`;
}

/**
 * The provider options to set after a build, e.g. `Add "medium" to e2b({ sizes }).`, plus the combined template's
 * name when it was built (release-prep §4.3); null when nothing new.
 */
export function sizesHint(provider: string, results: readonly ImageBuildResult[]): string | null {
  const ok = results.filter((r) => r.ok && r.provider === provider);
  const built = [...new Set(ok.map((r) => r.size))].filter((name) => name !== "small");
  const combined = ok.some((r) => r.harness === "all-harnesses");
  const template = `template: "selfbuilding-all-harnesses"`;
  if (built.length === 0) return combined ? `Use ${template} in ${provider}({ template }).` : null;
  const sizes = `Add ${built.map((s) => `"${s}"`).join(", ")} to ${provider}({ sizes })`;
  return combined ? `${sizes} and use ${template}.` : `${sizes}.`;
}
