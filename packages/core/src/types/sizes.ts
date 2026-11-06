import type { SerializedSelfbuildingError } from "../errors/codes.js";

// Machine sizes (docs/spec/demo-path.md §1). Sizes are named presets defined once in config; calls name a size,
// never raw numbers. A size the provider cannot give fails with SizeUnavailableError; nothing falls back.

/** A size name. The three built-ins always exist; config may add more (`^[a-z][a-z0-9-]{0,23}$`). */
export type SizeName = "small" | "medium" | "large" | (string & {});

/** The machine a size stands for. */
export interface MachineSize {
  vcpu: number;
  memoryMiB: number;
  /** Optional: providers that size disk separately (template builds use it as minFreeDiskMb). */
  diskGiB?: number;
}

/** A size after the config table was applied. Carried in `SandboxSpec.size`. */
export interface ResolvedSize extends MachineSize {
  name: string;
}

/** The config shape: `sizes: { xlarge: { vcpu: 16, memoryMiB: 32768 } }`. Built-in names may not be redefined. */
export type SizeTable = Record<string, MachineSize>;

/** The built-in presets. Never change these numbers: templates are built and named per preset. */
export const BUILT_IN_SIZES: Readonly<Record<"small" | "medium" | "large", Readonly<MachineSize>>> = Object.freeze({
  small: Object.freeze({ vcpu: 2, memoryMiB: 4096 }),
  medium: Object.freeze({ vcpu: 4, memoryMiB: 8192 }),
  large: Object.freeze({ vcpu: 8, memoryMiB: 16384 }),
});

/** What a size name must look like. */
export const SIZE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/** The hard ceiling a provider (or the account's plan) puts on one box. */
export interface SizeLimits {
  maxVcpu?: number;
  maxMemoryMiB?: number;
  maxDiskGiB?: number;
  /** Providers that tie memory to vCPU (Vercel: 2048 per vCPU). */
  memoryPerVcpuMiB?: number;
  /** Providers that only offer some vCPU counts. */
  vcpuChoices?: readonly number[];
  /**
   * The provider's own fix sentence for an `over-limit` refusal (demo-path §1.3 limits table), e.g. "E2B Hobby
   * allows 8 vCPU and 8 GiB per sandbox. …". Absent: a generic sentence.
   */
  overLimitFix?: string;
}

/**
 * How a provider sizes boxes (demo-path §1.3).
 * - `template`: size is fixed per template at build time (E2B, Impello). Only sizes whose template was built exist.
 * - `create`: size is chosen per create call (Docker, Daytona from an image, Modal, Vercel).
 * - `start`: size is chosen when a stopped instance starts (Cloudflare).
 */
export type ProviderSizing =
  | {
      kind: "template";
      /** Fork children always get the parent's size. */
      forkSize: "inherit";
      resize: false;
      /** Size names whose template exists for this provider value (from its options). */
      available: readonly string[];
      limits: SizeLimits;
      /** The template alias for one size of one base template: "selfbuilding-codex" + "medium" → "selfbuilding-codex-medium". */
      templateFor(baseTemplate: string, size: string): string;
    }
  | {
      kind: "create" | "start";
      /** "override": a fork child may ask for another size. */
      forkSize: "inherit" | "override";
      /** The box can change size in place. */
      resize: boolean;
      limits: SizeLimits;
    };

/** Why a provider cannot give a size. Each one has a fix the error names. */
export type SizeRefusal =
  /** Template provider: no template was built for this size. */
  | "not-built"
  /** Bigger than the provider or plan allows. */
  | "over-limit"
  /** A fork asked for a different size on a provider whose forks inherit. */
  | "fork-inherits"
  /** The provider takes no sizes at all (no `sizing`). */
  | "not-sizable"
  /** The shape is not one the provider offers (vCPU choice, memory per vCPU). */
  | "invalid-shape";

export type SizeCheck = { ok: true; template?: string } | { ok: false; reason: SizeRefusal; fix: string };

// `selfbuilding images build` (demo-path §2).

/**
 * `"all-harnesses"` is one image carrying both Claude Code and Codex (and the browser), so forks of one box can run
 * either harness (release-prep §4.3).
 */
export type ImageHarness = "claude-code" | "codex" | "all-harnesses";

export interface ImageBuildRequest {
  harness: ImageHarness;
  size: ResolvedSize;
  /** The selfbuilding release the image is tagged with. */
  version: string;
  /** The template or image name to build, from the provider's naming rule. */
  name: string;
  signal?: AbortSignal;
  /** Build log lines, already redacted by the builder. */
  onLog?: (line: string) => void;
}

export type ImageBuildResult =
  | { ok: true; provider: string; harness: ImageHarness; size: string; name: string; durationMs: number }
  | {
      ok: false;
      provider: string;
      harness: ImageHarness;
      size: string;
      name: string;
      error: SerializedSelfbuildingError;
    };

/** Builds images or templates for one provider. Each provider package exports one factory for it. */
export interface ImageBuilder {
  readonly provider: string;
  readonly sizing: ProviderSizing;
  /** The name a (harness, size) pair builds to. Must agree with the provider's `sizing.templateFor`. */
  nameFor(harness: ImageHarness, size: string): string;
  build(req: ImageBuildRequest): Promise<ImageBuildResult>;
}
