import { ConfigError, SizeUnavailableError, SizeUnknownError } from "../errors/classes.js";
import type { SelfbuildingConfig } from "../types/config.js";
import type { SandboxProvider } from "../types/sandbox.js";
import {
  BUILT_IN_SIZES,
  type MachineSize,
  type ResolvedSize,
  SIZE_NAME_PATTERN,
  type SizeCheck,
  type SizeLimits,
  type SizeName,
  type SizeRefusal,
} from "../types/sizes.js";

// Machine sizes (docs/spec/demo-path.md §1).

/**
 * Checks the config's `sizes` table (demo-path §1.1): names match SIZE_NAME_PATTERN, numbers are positive integers,
 * and a built-in may only be repeated with its own numbers, because templates are built and named per preset.
 */
export function validateSizes(sizes: unknown, where = "config.sizes"): void {
  if (sizes === undefined) return;
  if (sizes === null || typeof sizes !== "object" || Array.isArray(sizes)) {
    throw new ConfigError(`${where} must be an object of { name: { vcpu, memoryMiB } }.`);
  }
  for (const [name, raw] of Object.entries(sizes as Record<string, unknown>)) {
    if (!SIZE_NAME_PATTERN.test(name)) {
      throw new ConfigError(`${where} name "${name}" must match ${SIZE_NAME_PATTERN.source}.`);
    }
    if (raw === null || typeof raw !== "object") {
      throw new ConfigError(`${where}.${name} must be { vcpu, memoryMiB, diskGiB? }.`);
    }
    const size = raw as Partial<MachineSize>;
    for (const key of ["vcpu", "memoryMiB"] as const) {
      if (!isPositiveInteger(size[key])) {
        throw new ConfigError(`${where}.${name}.${key} must be a positive integer; got ${String(size[key])}.`);
      }
    }
    if (size.diskGiB !== undefined && !isPositiveInteger(size.diskGiB)) {
      throw new ConfigError(`${where}.${name}.diskGiB must be a positive integer; got ${String(size.diskGiB)}.`);
    }
    const builtIn = (BUILT_IN_SIZES as Record<string, MachineSize>)[name];
    if (builtIn && (builtIn.vcpu !== size.vcpu || builtIn.memoryMiB !== size.memoryMiB)) {
      throw new ConfigError(
        `${where}.${name} redefines a built-in size (${builtIn.vcpu} vCPU, ${builtIn.memoryMiB} MiB). Built-in numbers never change; add a new name instead, e.g. "${name}-custom".`,
      );
    }
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** The built-in presets merged with the config's `sizes`. Redefining a built-in throws ConfigError. */
export function sizeTable(config: SelfbuildingConfig): Readonly<Record<string, MachineSize>> {
  validateSizes(config.sizes);
  const table: Record<string, MachineSize> = {};
  for (const [name, size] of Object.entries(BUILT_IN_SIZES)) table[name] = { ...size };
  for (const [name, size] of Object.entries(config.sizes ?? {})) {
    // A built-in repeated with identical numbers may still add a disk size.
    table[name] = { ...table[name], ...size };
  }
  return Object.freeze(table);
}

/** Resolves a size name against the table. An unknown name throws SizeUnknownError. */
export function resolveSize(config: SelfbuildingConfig, size: SizeName): ResolvedSize {
  const table = sizeTable(config);
  const found = Object.hasOwn(table, size) ? table[size] : undefined;
  if (!found) throw new SizeUnknownError({ size, known: Object.keys(table) });
  return {
    name: size,
    vcpu: found.vcpu,
    memoryMiB: found.memoryMiB,
    ...(found.diskGiB !== undefined ? { diskGiB: found.diskGiB } : {}),
  };
}

/**
 * Whether `provider` can give `size`. Pure: reads `provider.sizing`, never calls the vendor. `fork` checks a fork
 * child against its parent's size; `baseTemplate` lets template providers name the template they would use.
 */
export function checkSize(
  provider: SandboxProvider,
  size: ResolvedSize,
  o?: { fork?: { parentSize?: string }; baseTemplate?: string; harness?: string },
): SizeCheck {
  const sizing = provider.sizing;
  if (!sizing) {
    return refuse(
      "not-sizable",
      `Provider "${provider.id}" takes no sizes. Drop the size option, or run this call on a provider that sizes boxes (docker, e2b, impello).`,
    );
  }
  if (o?.fork && sizing.forkSize === "inherit") {
    // On a template provider the unsuffixed template is "small", so a parent created without a size is small.
    const parent = o.fork.parentSize ?? (sizing.kind === "template" ? "small" : undefined);
    if (parent !== size.name) {
      return refuse(
        "fork-inherits",
        `Forks on "${provider.id}" keep the parent's size (${parent ?? "provider default"}). Create the parent at "${size.name}", or run this call on a fresh box.`,
      );
    }
  }
  const limits = sizing.limits;
  if (overLimit(size, limits)) return refuse("over-limit", limits.overLimitFix ?? overLimitFix(provider.id, limits));
  if (limits.vcpuChoices && !limits.vcpuChoices.includes(size.vcpu)) {
    return refuse("invalid-shape", shapeFix(provider.id, limits));
  }
  if (limits.memoryPerVcpuMiB !== undefined && size.memoryMiB !== size.vcpu * limits.memoryPerVcpuMiB) {
    return refuse("invalid-shape", shapeFix(provider.id, limits));
  }
  if (sizing.kind === "template") {
    if (!sizing.available.includes(size.name)) {
      return refuse(
        "not-built",
        `Build it: selfbuilding images build --provider ${provider.id} --harness ${o?.harness ?? "all"} --size ${size.name}, then add "${size.name}" to ${provider.id}({ sizes }).`,
      );
    }
    return o?.baseTemplate ? { ok: true, template: sizing.templateFor(o.baseTemplate, size.name) } : { ok: true };
  }
  return { ok: true };
}

function refuse(reason: SizeRefusal, fix: string): SizeCheck {
  return { ok: false, reason, fix };
}

function overLimit(size: ResolvedSize, limits: SizeLimits): boolean {
  return (
    (limits.maxVcpu !== undefined && size.vcpu > limits.maxVcpu) ||
    (limits.maxMemoryMiB !== undefined && size.memoryMiB > limits.maxMemoryMiB) ||
    (limits.maxDiskGiB !== undefined && size.diskGiB !== undefined && size.diskGiB > limits.maxDiskGiB)
  );
}

function limitText(limits: SizeLimits): string {
  const parts: string[] = [];
  if (limits.maxVcpu !== undefined) parts.push(`${limits.maxVcpu} vCPU`);
  if (limits.maxMemoryMiB !== undefined) parts.push(`${limits.maxMemoryMiB / 1024} GiB`);
  if (limits.maxDiskGiB !== undefined) parts.push(`${limits.maxDiskGiB} GiB disk`);
  return parts.join(" and ");
}

/** The over-limit fix when the provider does not carry its own (demo-path §1.3 limits table). */
function overLimitFix(providerId: string, limits: SizeLimits): string {
  const family = providerId.split(/[-:]/)[0];
  if (family === "e2b") {
    return `E2B ${limits.maxMemoryMiB !== undefined ? "Hobby" : "Pro"} allows ${limitText(limits)} per sandbox. Use medium, upgrade the plan and pass e2b({ plan: "pro" }), or run this size on Docker.`;
  }
  if (family === "impello") return "Impello has no 8 vCPU pool yet. Use medium, or run this size on Docker or E2B.";
  if (family === "docker") {
    return `Docker host limit set in docker({ maxVcpu, maxMemoryMiB }) is ${limitText(limits)}. Raise it there, or use a smaller size.`;
  }
  return `"${providerId}" allows at most ${limitText(limits)} per box. Use a smaller size, or run this size on another provider.`;
}

function shapeFix(providerId: string, limits: SizeLimits): string {
  const choices: string[] = [];
  if (limits.vcpuChoices) choices.push(`${limits.vcpuChoices.join(", ")} vCPU`);
  if (limits.memoryPerVcpuMiB !== undefined) choices.push(`${limits.memoryPerVcpuMiB} MiB per vCPU`);
  return `"${providerId}" offers ${choices.join(" with ")}. Define a size with one of them in the config's sizes table.`;
}

/** The SizeUnavailableError for a refused check. */
export function sizeRefusedError(
  provider: SandboxProvider,
  size: ResolvedSize,
  check: Extract<SizeCheck, { ok: false }>,
): SizeUnavailableError {
  return new SizeUnavailableError({
    provider: provider.id,
    size: size.name,
    vcpu: size.vcpu,
    memoryMiB: size.memoryMiB,
    reason: check.reason,
    fix: check.fix,
  });
}

/**
 * The size a new box's spec carries: undefined when nothing asked for one (the provider default, as before),
 * else resolved and checked, throwing SizeUnknownError or SizeUnavailableError.
 */
export function sizeForSpec(
  config: SelfbuildingConfig,
  provider: SandboxProvider | undefined,
  size: SizeName | undefined,
  o?: { fork?: { parentSize?: string }; baseTemplate?: string; harness?: string },
): ResolvedSize | undefined {
  if (size === undefined) return undefined;
  const resolved = resolveSize(config, size);
  if (!provider) return resolved;
  const check = checkSize(provider, resolved, o);
  if (!check.ok) throw sizeRefusedError(provider, resolved, check);
  return resolved;
}
