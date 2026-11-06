import {
  ConfigError,
  type ImageBuilder,
  type ImageBuildRequest,
  type ImageBuildResult,
  ImageUnavailableError,
  isSelfbuildingError,
  type SelfbuildingError,
  SizeUnavailableError,
} from "@selfbuilding/core";
import { officialImages, toStandaloneDockerfile } from "@selfbuilding/images";
import { overLimit, type TemplateSizing, templateNameFor } from "./sizes.js";
import { type E2bTemplateDefinition, e2bTemplate, type SelfbuildingTemplateName } from "./templates.js";

// The vendor-neutral half of `selfbuilding images build` for template providers (docs/spec/demo-path.md §2). Each
// SDK binding (E2B in index.ts, Impello in its own package) supplies a TemplateBuildApi; this file never imports one.

/** What one vendor's template SDK must do for a build. */
export interface TemplateBuildApi {
  /**
   * Builds `def.alias` from `def.dockerfile` when set, else from `def.fromImage`, at `def`'s size, tagged with `tags`.
   * Resolves once the build is done.
   */
  build(def: E2bTemplateDefinition, o: { tags: string[]; onLog?: (line: string) => void }): Promise<void>;
  /** Points `tags` at the build named `target` ("name:tag"). */
  assignTags(target: string, tags: string[]): Promise<void>;
}

export interface TemplateImageBuilderOptions {
  /** Provider id, e.g. "e2b". */
  provider: string;
  /** The provider's sizing; its `limits` refuse sizes the plan cannot run. */
  sizing: TemplateSizing;
  /** Loaded on the first build, so a dry run or a refused size never loads the SDK. */
  api: () => TemplateBuildApi | Promise<TemplateBuildApi>;
  /** Whether the vendor takes a disk size. When false, a size that sets `diskGiB` is refused. */
  disk: boolean;
  /**
   * Where the published images live (see `e2bTemplate`). Unset: each template is built from the official image as
   * one self-contained Dockerfile, so nothing has to be published first.
   */
  registry?: string;
  /** Values scrubbed from every log line and error message (the API key). */
  redact?: readonly string[];
  /** For the date tag. */
  now?: () => Date;
}

const DEFAULT_TAG = "default";

/** An `ImageBuilder` that turns the selfbuilding template definitions into one vendor's templates. */
export function templateImageBuilder(opts: TemplateImageBuilderOptions): ImageBuilder {
  const secrets = (opts.redact ?? []).filter((s) => s.length >= 4);
  const scrub = (text: string): string => secrets.reduce((acc, s) => acc.split(s).join("[redacted]"), text);
  const nameFor = (harness: string, size: string): string => templateNameFor(`selfbuilding-${harness}`, size);
  let api: Promise<TemplateBuildApi> | undefined;

  const fail = (req: ImageBuildRequest, error: SelfbuildingError): ImageBuildResult => ({
    ok: false,
    provider: opts.provider,
    harness: req.harness,
    size: req.size.name,
    name: req.name,
    error: error.toJSON(),
  });

  return {
    provider: opts.provider,
    sizing: opts.sizing,
    nameFor,
    async build(req) {
      const started = Date.now();
      const expected = nameFor(req.harness, req.size.name);
      if (req.name !== expected) {
        return fail(
          req,
          new ConfigError(`Template "${req.name}" does not follow the naming rule; build it as "${expected}".`),
        );
      }
      const refusal = refuse(opts, req);
      if (refusal) return fail(req, refusal);
      try {
        req.signal?.throwIfAborted();
        const def = e2bTemplate(`selfbuilding-${req.harness}` as SelfbuildingTemplateName, {
          version: req.version,
          date: (opts.now?.() ?? new Date()).toISOString().slice(0, 10),
          size: req.size,
          ...(opts.registry === undefined ? {} : { registry: opts.registry }),
        });
        if (opts.registry === undefined) def.dockerfile = standaloneDockerfileFor(req.harness, req.version);
        api ??= Promise.resolve(opts.api());
        const vendor = await api;
        const onLog = req.onLog;
        await vendor.build(def, {
          tags: def.tags.filter((t) => t !== DEFAULT_TAG),
          ...(onLog ? { onLog: (line: string) => onLog(scrub(line)) } : {}),
        });
        // `default` is what an untagged template name resolves to, so it moves only once the build succeeded.
        await vendor.assignTags(`${def.alias}:${req.version}`, [DEFAULT_TAG]);
        return {
          ok: true,
          provider: opts.provider,
          harness: req.harness,
          size: req.size.name,
          name: req.name,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        if (isSelfbuildingError(error)) return fail(req, error);
        const message = scrub(error instanceof Error ? error.message : String(error));
        return fail(
          req,
          new ImageUnavailableError(`Building template ${req.name} on ${opts.provider} failed: ${message}`),
        );
      }
    },
  };
}

/** The official image for `harness` as one Dockerfile, for a build with no registry (release-prep §4.2). */
function standaloneDockerfileFor(harness: string, version: string): string {
  const image = officialImages[harness];
  if (!image) {
    throw new ImageUnavailableError(
      `No official image for harness "${harness}". Build one of ${Object.keys(officialImages)
        .filter((k) => k !== "base")
        .join(", ")}.`,
    );
  }
  return toStandaloneDockerfile(image, { version });
}

function refuse(opts: TemplateImageBuilderOptions, req: ImageBuildRequest): SizeUnavailableError | null {
  const base = { provider: opts.provider, size: req.size.name, vcpu: req.size.vcpu, memoryMiB: req.size.memoryMiB };
  const fix = overLimit(req.size, opts.sizing.limits);
  if (fix !== null) return new SizeUnavailableError({ ...base, reason: "over-limit", fix });
  if (!opts.disk && req.size.diskGiB !== undefined) {
    return new SizeUnavailableError({
      ...base,
      reason: "invalid-shape",
      fix: `"${opts.provider}" templates take no disk size. Define a size without diskGiB in the config's sizes table, or build this size on E2B.`,
    });
  }
  return null;
}
