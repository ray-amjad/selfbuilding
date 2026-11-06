import { type ImageBuilder, ImageUnavailableError, type SizeLimits } from "@selfbuilding/core";
import {
  IMPELLO_SIZE_LIMITS,
  type TemplateBuildApi,
  templateImageBuilder,
  templateSizing,
} from "@selfbuilding/sandbox-e2b/adapter";

export const IMPELLO_DOMAIN = "sandbox.impello.ai";

type TemplateModule = typeof import("@impello/sdk/template");
type TemplateFn = TemplateModule["Template"];

/** Binds `Template` from `@impello/sdk/template` to a build. Every connection field is explicit, as for sandboxes. */
export function impelloTemplateApi(conn: { apiKey: string; domain?: string }, T: TemplateFn): TemplateBuildApi {
  const domain = conn.domain ?? IMPELLO_DOMAIN;
  const connection = { apiKey: conn.apiKey, domain, apiUrl: `https://api.${domain}`, debug: false };
  return {
    async build(def, o) {
      const base = T();
      let from: ReturnType<typeof base.fromImage>;
      if (def.dockerfile === undefined) {
        from = base.fromImage(def.fromImage);
      } else if (typeof base.fromDockerfile === "function") {
        from = base.fromDockerfile(def.dockerfile);
      } else {
        // An SDK build without Dockerfile support can still use published images.
        throw new ImageUnavailableError(
          `This @impello/sdk cannot build a template from a Dockerfile. Publish the selfbuilding images and set SELFBUILDING_IMAGE_REGISTRY (e.g. ghcr.io/acme), or upgrade @impello/sdk.`,
        );
      }
      const template = from.setUser(def.user).setWorkdir(def.workdir).runCmd(def.verify);
      // Impello templates take no disk size; the builder refuses sizes that set one before getting here.
      await T.build(template, def.alias, {
        ...connection,
        tags: o.tags,
        cpuCount: def.cpuCount,
        memoryMB: def.memoryMB,
        ...(o.onLog ? { onBuildLogs: (entry: { toString(): string }) => o.onLog?.(entry.toString()) } : {}),
      });
    },
    async assignTags(target, tags) {
      await T.assignTags(target, tags, connection);
    },
  };
}

export interface ImpelloImageBuilderOptions {
  /** From IMPELLO_API_KEY; never printed. */
  apiKey: string;
  sizeLimits?: SizeLimits;
  domain?: string;
  /**
   * Where the published selfbuilding images live, e.g. "ghcr.io/acme". Unset: each template is built from the
   * official image's standalone Dockerfile, with nothing published first.
   */
  registry?: string;
  /** The SDK's `Template`; tests pass a fake. Default: loaded from `@impello/sdk/template` on the first build. */
  template?: TemplateFn;
}

/** Builds the selfbuilding templates on Impello, one per harness and size (`selfbuilding images build`). */
export function impelloImageBuilder(opts: ImpelloImageBuilderOptions): ImageBuilder {
  const conn = { apiKey: opts.apiKey, ...(opts.domain === undefined ? {} : { domain: opts.domain }) };
  return templateImageBuilder({
    provider: "impello",
    sizing: templateSizing({ available: [], limits: { ...IMPELLO_SIZE_LIMITS, ...opts.sizeLimits } }),
    // The template entry pulls in the Dockerfile parser and tar; only a real build loads it.
    api: async () => impelloTemplateApi(conn, opts.template ?? (await import("@impello/sdk/template")).Template),
    disk: false,
    redact: [opts.apiKey],
    ...(opts.registry === undefined ? {} : { registry: opts.registry }),
  });
}
