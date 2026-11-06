import { Sandbox } from "@impello/sdk";
import type { ProviderLimits, SandboxProvider, SizeLimits } from "@selfbuilding/core";
import {
  createE2bShapeProvider,
  type E2bShapeBindingOptions,
  type E2bShapeClient,
  guardTemplateSizes,
  IMPELLO_SIZE_LIMITS,
  templateSizing,
} from "@selfbuilding/sandbox-e2b/adapter";
import { IMPELLO_DOMAIN } from "./build.js";

export interface ImpelloOptions extends E2bShapeBindingOptions {
  /** Size names whose template you built with `selfbuilding images build` (default ["small"]). */
  sizes?: string[];
  /** Overrides for Impello's size limits (default: at most 4 vCPU). */
  sizeLimits?: SizeLimits;
  /**
   * Probe each new box that has a non-open egress policy and refuse one the vendor does not enforce, with
   * EgressPolicyUnsupportedError (docs/decisions/0001-egress-enforcement.md). Default false.
   */
  verifyEgress?: boolean;
  /**
   * The account plan; sets the session maximum, concurrency and start rate. Default "trial", the strictest, so a
   * call longer than the plan allows fails at plan time instead of being cut off mid-turn.
   */
  tier?: "trial" | "plan20" | "plan100" | "plan500";
}

const HOUR = 60 * 60 * 1000;
const TIERS: Record<NonNullable<ImpelloOptions["tier"]>, ProviderLimits> = {
  trial: {
    maxLifetimeMs: HOUR,
    maxConcurrent: 2,
    createsPerMinute: 5,
    lifetimeGuaranteed: true,
    expireKeeps: "memory",
  },
  plan20: {
    maxLifetimeMs: 12 * HOUR,
    maxConcurrent: 20,
    createsPerMinute: 12,
    lifetimeGuaranteed: true,
    expireKeeps: "memory",
  },
  plan100: {
    maxLifetimeMs: 24 * HOUR,
    maxConcurrent: 100,
    createsPerMinute: 30,
    lifetimeGuaranteed: true,
    expireKeeps: "memory",
  },
  plan500: {
    maxLifetimeMs: 24 * HOUR,
    maxConcurrent: 300,
    createsPerMinute: 65,
    lifetimeGuaranteed: true,
    expireKeeps: "memory",
  },
};

/**
 * Binds `@impello/sdk`. The stock E2B client refuses `imp_` keys before any request leaves the machine, so it is
 * never used here. Each call goes through a typed wrapper, so an SDK upgrade that drifts fails to compile.
 */
export function impelloClient(S: typeof Sandbox = Sandbox): E2bShapeClient {
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

/** The Impello sandbox provider (spec §5.5). Uses @impello/sdk; shares the E2B-shape adapter. */
export function impello(opts: ImpelloOptions): SandboxProvider {
  return guardTemplateSizes(
    createE2bShapeProvider({
      id: "impello",
      client: impelloClient(),
      template: opts.template,
      apiKey: opts.apiKey,
      domain: opts.domain ?? IMPELLO_DOMAIN,
      limits: { ...TIERS[opts.tier ?? "trial"], ...opts.limits },
      ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
      ...(opts.verifyEgress === undefined ? {} : { verifyEgress: opts.verifyEgress }),
      sizing: templateSizing({
        ...(opts.sizes === undefined ? {} : { available: opts.sizes }),
        limits: { ...IMPELLO_SIZE_LIMITS, ...opts.sizeLimits },
      }),
    }),
  );
}

export { type ImpelloImageBuilderOptions, impelloImageBuilder, impelloTemplateApi } from "./build.js";
