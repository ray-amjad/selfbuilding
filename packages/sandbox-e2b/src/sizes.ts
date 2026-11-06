import {
  ConfigError,
  type ProviderSizing,
  type ResolvedSize,
  type SandboxProvider,
  SIZE_NAME_PATTERN,
  type SizeLimits,
  SizeUnavailableError,
} from "@selfbuilding/core";

// Template sizing for E2B-shape providers (docs/spec/demo-path.md §1.3, §1.4). Size is fixed per template at build
// time, so each size is its own template and only the sizes whose template was built exist.

export type TemplateSizing = Extract<ProviderSizing, { kind: "template" }>;

/** The template alias for one size: `small` is the unsuffixed template, every other size adds `-<size>`. */
export function templateNameFor(baseTemplate: string, size: string): string {
  return size === "small" ? baseTemplate : `${baseTemplate}-${size}`;
}

/** E2B plan ceilings per sandbox. Pro memory stays unset until verified. */
export const E2B_SIZE_LIMITS: Readonly<Record<"hobby" | "pro", SizeLimits>> = Object.freeze({
  hobby: {
    maxVcpu: 8,
    maxMemoryMiB: 8192,
    overLimitFix:
      'E2B Hobby allows 8 vCPU and 8 GiB per sandbox. Use medium, upgrade the plan and pass e2b({ plan: "pro" }), or run this size on Docker.',
  },
  pro: {
    maxVcpu: 8,
    overLimitFix: "E2B Pro allows 8 vCPU per sandbox. Use a size with at most 8 vCPU, or run this size on Docker.",
  },
});

/** Impello has no 8 vCPU pool yet. */
export const IMPELLO_SIZE_LIMITS: Readonly<SizeLimits> = Object.freeze({
  maxVcpu: 4,
  overLimitFix: "Impello has no 8 vCPU pool yet. Use medium, or run this size on Docker or E2B.",
});

/** The template sizing descriptor. `available` lists the sizes whose template the user built (default small). */
export function templateSizing(opts: { available?: readonly string[]; limits: SizeLimits }): TemplateSizing {
  const available = [...new Set(opts.available ?? ["small"])];
  for (const name of available) {
    if (!SIZE_NAME_PATTERN.test(name)) {
      throw new ConfigError(
        `Size "${name}" in sizes must match ${SIZE_NAME_PATTERN}, e.g. "medium". List the sizes whose template you built.`,
      );
    }
  }
  return Object.freeze({
    kind: "template",
    forkSize: "inherit",
    resize: false,
    available: Object.freeze(available),
    limits: Object.freeze({ ...opts.limits }),
    templateFor: templateNameFor,
  });
}

/** The `over-limit` check alone, shared by the provider guard and the template builder. Null when within limits. */
export function overLimit(size: ResolvedSize, limits: SizeLimits): string | null {
  const over =
    (limits.maxVcpu !== undefined && size.vcpu > limits.maxVcpu) ||
    (limits.maxMemoryMiB !== undefined && size.memoryMiB > limits.maxMemoryMiB) ||
    (limits.maxDiskGiB !== undefined && size.diskGiB !== undefined && size.diskGiB > limits.maxDiskGiB);
  if (!over) return null;
  return limits.overLimitFix ?? "Use a smaller size, or run this size on another provider.";
}

function refuse(
  provider: string,
  size: ResolvedSize,
  reason: "not-built" | "over-limit" | "fork-inherits",
  fix: string,
): SizeUnavailableError {
  return new SizeUnavailableError({
    provider,
    size: size.name,
    vcpu: size.vcpu,
    memoryMiB: size.memoryMiB,
    reason,
    fix,
  });
}

/** Why a template provider cannot give `size`, or null when it can. */
export function templateRefusal(
  provider: string,
  sizing: TemplateSizing,
  size: ResolvedSize,
): SizeUnavailableError | null {
  const fix = overLimit(size, sizing.limits);
  if (fix !== null) return refuse(provider, size, "over-limit", fix);
  if (!sizing.available.includes(size.name)) {
    return refuse(
      provider,
      size,
      "not-built",
      `Build it: selfbuilding images build --provider ${provider} --harness all --size ${size.name}, then add "${size.name}" to ${provider}({ sizes }).`,
    );
  }
  return null;
}

/**
 * Defence in depth: the core checks sizes before create, but a provider handed a size it cannot give throws instead
 * of silently creating the default template's size. Fork children always keep the parent's size.
 */
export function guardTemplateSizes<P extends SandboxProvider>(provider: P): P {
  const sizing = provider.sizing;
  if (sizing?.kind !== "template") return provider;
  const openOrCreate = provider.openOrCreate.bind(provider);
  Object.defineProperty(provider, "openOrCreate", {
    configurable: true,
    value: ((key, spec, o) => {
      const refusal = spec.size ? templateRefusal(provider.id, sizing, spec.size) : null;
      return refusal ? Promise.reject(refusal) : openOrCreate(key, spec, o);
    }) satisfies SandboxProvider["openOrCreate"],
  });
  const fork = provider.fork?.bind(provider);
  if (fork) {
    Object.defineProperty(provider, "fork", {
      configurable: true,
      value: ((ref, o) => {
        // Children inherit regardless; refuse only a size known to differ from the parent's.
        if (o.size && ref.size !== undefined && o.size.name !== ref.size) {
          return Promise.reject(
            refuse(
              provider.id,
              o.size,
              "fork-inherits",
              `Forks on "${provider.id}" keep the parent's size (${ref.size}). Create the parent at "${o.size.name}", or run this call on a fresh box.`,
            ),
          );
        }
        return fork(ref, o);
      }) satisfies NonNullable<SandboxProvider["fork"]>,
    });
  }
  return provider;
}
