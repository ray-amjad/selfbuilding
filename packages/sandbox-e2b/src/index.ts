import type { ImageBuilder, ProviderLimits, SandboxProvider, SizeLimits } from "@selfbuilding/core";
import { Sandbox, Template } from "e2b";
import { createE2bShapeProvider, type E2bShapeBindingOptions } from "./binding.js";
import { type TemplateBuildApi, templateImageBuilder } from "./build.js";
import type { E2bShapeClient } from "./client.js";
import { E2B_SIZE_LIMITS, guardTemplateSizes, templateSizing } from "./sizes.js";

export * from "./shared.js";

export interface E2bOptions extends E2bShapeBindingOptions {
  /** The account plan; sets the session maximum and concurrency. Default `plan`, else "hobby", the stricter one. */
  tier?: "hobby" | "pro";
  /** The account plan for sizes (demo-path §1.3): Hobby caps a sandbox at 8 vCPU and 8 GiB. Default `tier`. */
  plan?: "hobby" | "pro";
  /** Size names whose template you built with `selfbuilding images build` (default ["small"]). */
  sizes?: string[];
  /** Overrides for the plan's size limits. */
  sizeLimits?: SizeLimits;
  /**
   * Probe each new box that has a non-open egress policy and refuse one the vendor does not enforce, with
   * EgressPolicyUnsupportedError (docs/decisions/0001-egress-enforcement.md). Default false.
   */
  verifyEgress?: boolean;
}

const TIERS: Record<NonNullable<E2bOptions["tier"]>, ProviderLimits> = {
  hobby: { maxLifetimeMs: 60 * 60 * 1000, maxConcurrent: 20, lifetimeGuaranteed: true, expireKeeps: "memory" },
  pro: { maxLifetimeMs: 24 * 60 * 60 * 1000, maxConcurrent: 100, lifetimeGuaranteed: true, expireKeeps: "memory" },
};

/** Binds the stock `e2b` SDK. Each call goes through a typed wrapper, so an SDK upgrade that drifts fails to compile. */
export function e2bClient(S: typeof Sandbox = Sandbox): E2bShapeClient {
  return {
    create: (template, opts) => S.create(template, opts),
    connect: (id, opts) => S.connect(id, opts),
    list: (opts) => S.list(opts),
    getInfo: (id, opts) => S.getInfo(id, opts),
    kill: (id, opts) => S.kill(id, opts),
    pause: (id, opts) => S.pause(id, opts),
    setTimeout: (id, ms, opts) => S.setTimeout(id, ms, opts),
    createSnapshot: (id, opts) => S.createSnapshot(id, opts),
  };
}

/** The E2B sandbox provider (spec §5.5). Takes credentials explicitly; never reads the environment. */
export function e2b(opts: E2bOptions): SandboxProvider {
  const plan = opts.plan ?? opts.tier ?? "hobby";
  return guardTemplateSizes(
    createE2bShapeProvider({
      id: "e2b",
      client: e2bClient(),
      template: opts.template,
      apiKey: opts.apiKey,
      domain: opts.domain ?? "e2b.app",
      limits: { ...TIERS[opts.tier ?? plan], ...opts.limits },
      // The SDK retries on its own by default; one deadline per operation lives in the adapter (invariant 13).
      connection: { retries: 0 },
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.verifyEgress === undefined ? {} : { verifyEgress: opts.verifyEgress }),
      sizing: templateSizing({
        ...(opts.sizes === undefined ? {} : { available: opts.sizes }),
        limits: { ...E2B_SIZE_LIMITS[plan], ...opts.sizeLimits },
      }),
    }),
  );
}

/** Binds `Template` from the stock `e2b` SDK to a build. Every connection field is explicit, as for sandboxes. */
export function e2bTemplateApi(
  conn: { apiKey: string; domain?: string },
  T: typeof Template = Template,
): TemplateBuildApi {
  const connection = { apiKey: conn.apiKey, domain: conn.domain ?? "e2b.app", debug: false };
  return {
    async build(def, o) {
      const from = def.dockerfile === undefined ? T().fromImage(def.fromImage) : T().fromDockerfile(def.dockerfile);
      const template = from.setUser(def.user).setWorkdir(def.workdir).runCmd(def.verify);
      await T.build(template, def.alias, {
        ...connection,
        tags: o.tags,
        cpuCount: def.cpuCount,
        memoryMB: def.memoryMB,
        ...(def.minFreeDiskMb === undefined ? {} : { minFreeDiskMb: def.minFreeDiskMb }),
        ...(o.onLog ? { onBuildLogs: (entry: { toString(): string }) => o.onLog?.(entry.toString()) } : {}),
      });
    },
    async assignTags(target, tags) {
      await T.assignTags(target, tags, connection);
    },
  };
}

export interface E2bImageBuilderOptions {
  /** From E2B_API_KEY; never printed. */
  apiKey: string;
  /** The plan whose size limits apply (default "hobby"). */
  plan?: "hobby" | "pro";
  sizeLimits?: SizeLimits;
  domain?: string;
  /**
   * Where the published selfbuilding images live, e.g. "ghcr.io/acme". Unset: each template is built from the
   * official image's standalone Dockerfile, with nothing published first.
   */
  registry?: string;
  /** The SDK's `Template`; tests pass a fake. */
  template?: typeof Template;
}

/** Builds the selfbuilding templates on E2B, one per harness and size (`selfbuilding images build`). */
export function e2bImageBuilder(opts: E2bImageBuilderOptions): ImageBuilder {
  return templateImageBuilder({
    provider: "e2b",
    sizing: templateSizing({ available: [], limits: { ...E2B_SIZE_LIMITS[opts.plan ?? "hobby"], ...opts.sizeLimits } }),
    api: () =>
      e2bTemplateApi(
        { apiKey: opts.apiKey, ...(opts.domain === undefined ? {} : { domain: opts.domain }) },
        opts.template,
      ),
    disk: true,
    redact: [opts.apiKey],
    ...(opts.registry === undefined ? {} : { registry: opts.registry }),
  });
}
