import type { ResolvedSize } from "@selfbuilding/core";
import { templateNameFor } from "./sizes.js";

// Template definitions for E2B-shape providers (spec §5.6). Definitions only: `selfbuilding images build` turns them
// into vendor templates. Each one starts from the published OCI image (or, with no registry, the same image as one
// self-contained Dockerfile), so it keeps the `agent` user, the absolute binary paths and the image manifest that the
// runtime's boot phase checks.

export type SelfbuildingTemplateName = "selfbuilding-claude-code" | "selfbuilding-codex" | "selfbuilding-all-harnesses";

export interface E2bTemplateDefinition {
  /** The alias callers pass as `template`: the base name, or `<base>-<size>` for any size but small. */
  alias: string;
  /** The published OCI image the template is built from. */
  fromImage: string;
  /**
   * A self-contained Dockerfile for the same image. When set the template is built from it and `fromImage` is unused:
   * no registry has to hold the published images (release-prep §4.2).
   */
  dockerfile?: string;
  /** Size is fixed per template; a bigger box needs its own `<alias>-<size>` template. */
  cpuCount: number;
  memoryMB: number;
  /** Set only when the size names a disk (`diskGiB × 1024`). */
  minFreeDiskMb?: number;
  /** The size name this template is built for. */
  size: string;
  /** Commands run as `user`; envd may default to root, so the template pins it. */
  user: "agent";
  workdir: string;
  /** Every harness binary, by absolute path. A build that cannot print each version fails. */
  binaries: string[];
  /** Run last in the build. */
  verify: string[];
  /** The manifest the runtime's `runtime` boot phase refuses to start without. */
  manifestPath: string;
  /** Tags the build gets; `default` moves only after a successful build. */
  tags: string[];
}

const HARNESS: Record<SelfbuildingTemplateName, { image: string; binaries: string[] }> = {
  "selfbuilding-claude-code": { image: "claude-code", binaries: ["/usr/local/bin/claude"] },
  "selfbuilding-codex": { image: "codex", binaries: ["/usr/local/bin/codex"] },
  "selfbuilding-all-harnesses": {
    image: "all-harnesses",
    binaries: ["/usr/local/bin/claude", "/usr/local/bin/codex"],
  },
};

export const SELFBUILDING_TEMPLATE_NAMES = Object.keys(HARNESS) as SelfbuildingTemplateName[];

/** The definition of one selfbuilding template at one release and size (default small: 2 vCPU, 4 GiB). */
export function e2bTemplate(
  name: SelfbuildingTemplateName,
  opts: {
    version: string;
    date?: string;
    size?: ResolvedSize;
    /** Where the published image lives, e.g. "ghcr.io/acme" (default: the bare `selfbuilding/<harness>` name). */
    registry?: string;
    /** Overrides the size's vCPU. Prefer `size`. */
    cpuCount?: number;
    /** Overrides the size's memory. Prefer `size`. */
    memoryMB?: number;
  },
): E2bTemplateDefinition {
  const harness = HARNESS[name];
  if (!harness) {
    throw new TypeError(`Unknown template "${name}". Known: ${SELFBUILDING_TEMPLATE_NAMES.join(", ")}.`);
  }
  const size = opts.size?.name ?? "small";
  const registry = opts.registry ? `${opts.registry.replace(/\/+$/, "")}/` : "";
  return {
    alias: templateNameFor(name, size),
    fromImage: `${registry}selfbuilding/${harness.image}:${opts.version}`,
    cpuCount: opts.cpuCount ?? opts.size?.vcpu ?? 2,
    memoryMB: opts.memoryMB ?? opts.size?.memoryMiB ?? 4096,
    ...(opts.size?.diskGiB === undefined ? {} : { minFreeDiskMb: opts.size.diskGiB * 1024 }),
    size,
    user: "agent",
    workdir: "/selfbuilding/work",
    binaries: [...harness.binaries],
    verify: [...harness.binaries.map((b) => `${b} --version`), "test -f /opt/selfbuilding/image-manifest.json"],
    manifestPath: "/opt/selfbuilding/image-manifest.json",
    tags: [opts.version, ...(opts.date ? [opts.date] : []), "default"],
  };
}

/** Vendor stock templates. They run as another user and keep binaries off `/usr/local/bin`, so they are refused. */
export const STOCK_TEMPLATES: Record<string, string> = {
  base: "selfbuilding-claude-code",
  claude: "selfbuilding-claude-code",
  "claude-code": "selfbuilding-claude-code",
  codex: "selfbuilding-codex",
  opencode: "selfbuilding-opencode",
};
