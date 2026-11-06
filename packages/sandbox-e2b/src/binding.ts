import {
  ConfigError,
  type Duration,
  MissingCredentialError,
  type ProviderLimits,
  type ProviderSizing,
  type SandboxProvider,
  type Secret,
  type Stability,
} from "@selfbuilding/core";
import type { E2bConnection, E2bShapeClient } from "./client.js";
import { E2bShapeProvider, type E2bShapeTimings } from "./provider.js";
import { STOCK_TEMPLATES } from "./templates.js";
import { durationMs } from "./util.js";

/** Options every E2B-shape binding takes. */
export interface E2bShapeBindingOptions {
  apiKey: Secret;
  /** A selfbuilding template, e.g. "selfbuilding-claude-code". */
  template: string;
  domain?: string;
  /** A floor for every box lifetime this provider asks for, e.g. "45m". */
  timeout?: Duration;
  /** Overrides for the plan's limits. */
  limits?: Partial<ProviderLimits>;
}

/**
 * The shared E2B-shape adapter used by `e2b()` and `impello()`. Internal to the selfbuilding packages; `client` is
 * the vendor SDK's Sandbox class, bound so that it only ever sees credentials passed in here.
 * @internal
 */
export function createE2bShapeProvider(opts: {
  id: string;
  client: E2bShapeClient;
  template: string;
  apiKey: Secret;
  /** Default API domain of this vendor. */
  domain: string;
  limits: ProviderLimits;
  stability?: Stability;
  timeout?: Duration;
  /** Extra connection fields the vendor's SDK needs, e.g. `retries: 0`. */
  connection?: Partial<E2bConnection>;
  timings?: Partial<E2bShapeTimings>;
  /**
   * Probe each new box with a non-open egress policy and refuse one the vendor does not enforce
   * (docs/decisions/0001-egress-enforcement.md). Default false.
   */
  verifyEgress?: boolean;
  /** Template sizing (demo-path §1.3), from `templateSizing()`. */
  sizing?: ProviderSizing;
}): SandboxProvider {
  const stock = STOCK_TEMPLATES[opts.template];
  if (stock !== undefined) {
    throw new ConfigError(
      `Template "${opts.template}" is a vendor stock template; selfbuilding needs its own templates (agent user, binaries in /usr/local/bin, image manifest). Use "${stock}".`,
    );
  }
  if (!opts.template) throw new ConfigError(`${opts.id}() needs a template, e.g. "selfbuilding-claude-code".`);
  let minLifetimeMs: number | undefined;
  try {
    minLifetimeMs = opts.timeout === undefined ? undefined : durationMs(opts.timeout);
  } catch (error) {
    throw new ConfigError(`${opts.id}({ timeout }): ${(error as Error).message}`);
  }
  const apiUrl = `https://api.${opts.domain}`;
  const connection = async (): Promise<E2bConnection> => {
    const apiKey = typeof opts.apiKey === "function" ? await opts.apiKey() : opts.apiKey;
    if (!apiKey) throw new MissingCredentialError({ consumer: `${opts.id}()` });
    // Every field is explicit so the SDK's own environment fallbacks never pick another account or host.
    return { apiKey, domain: opts.domain, apiUrl, debug: false, ...opts.connection };
  };
  return new E2bShapeProvider({
    id: opts.id,
    client: opts.client,
    template: opts.template,
    connection,
    limits: opts.limits,
    ...(opts.stability === undefined ? {} : { stability: opts.stability }),
    ...(minLifetimeMs === undefined ? {} : { minLifetimeMs }),
    ...(opts.timings === undefined ? {} : { timings: opts.timings }),
    ...(opts.verifyEgress === undefined ? {} : { verifyEgress: opts.verifyEgress }),
    ...(opts.sizing === undefined ? {} : { sizing: opts.sizing }),
  });
}
