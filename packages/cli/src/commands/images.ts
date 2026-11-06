import {
  ConfigError,
  type ImageBuilder,
  type ImageHarness,
  MissingSecretError,
  type SandboxProvider,
  type SelfbuildingError,
  type SizeLimits,
} from "@selfbuilding/core";
import {
  buildSizeTable,
  formatBuildLine,
  IMAGE_HARNESSES,
  IMAGE_VERSION,
  planImageBuilds,
  resolveBuildSizes,
  runImageBuilds,
  sizesHint,
} from "@selfbuilding/images";
import { parseCommandArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../exit.js";
import { loadEnvFile, loadProject, resolveConfigPath } from "../project.js";

// `selfbuilding images build` (docs/spec/demo-path.md §2, release-prep §4.2-§4.3).

export const IMAGES_HELP = `Usage: selfbuilding images build [options]

Builds the official images (Docker) or templates (E2B, Impello), one per harness and size.
A size the provider cannot give is refused before anything is built, with the reason and the fix.
Templates are built from a generated Dockerfile, so nothing has to be published first; set
SELFBUILDING_IMAGE_REGISTRY to build them from published images instead. Each build prints the
path it took ("from Dockerfile" or "from <registry>/selfbuilding/<image>:<tag>") on stderr.

Options:
  --provider <id>     docker | e2b | impello (required; repeatable or comma-separated)
  --harness <id>      claude-code | codex | all | all-harnesses (default all: each harness
                      separately; all-harnesses: one image with both, plus the browser)
  --all-harnesses     Build only the combined all-harnesses image or template (with --harness,
                      those too)
  --size <name>       small | medium | large | a config size | all (default small; repeatable or
                      comma-separated; --sizes is an alias)
  --tag <version>     The release tag (default: the selfbuilding version)
  --dry-run           Print what would be built, build nothing
  --config <path>     Config file, for custom sizes and plan limits (default: search upward)
  --env-file <path>   Load a dotenv file first (E2B_API_KEY, IMPELLO_API_KEY)
  --json              One JSON line per result on stdout

Environment:
  E2B_API_KEY, IMPELLO_API_KEY   Credentials for template builds; never printed
  SELFBUILDING_IMAGE_REGISTRY    Optional: where published selfbuilding images live (e.g. ghcr.io/acme);
                                 templates are built from them instead of from a Dockerfile
`;

export const IMAGE_PROVIDERS = ["docker", "e2b", "impello"] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

/** What a builder factory gets: credentials from the environment and limits from a configured provider. */
export interface BuilderRequest {
  provider: ImageProvider;
  /** Empty in a dry run without a key: the builder is only asked for names and limits then. */
  apiKey: string;
  /** The limits of the config's own provider with this id (e.g. e2b({ plan: "pro" })), if it has one. */
  sizeLimits?: SizeLimits;
  registry?: string;
}

export interface ImagesDeps {
  builder(req: BuilderRequest): Promise<ImageBuilder>;
}

const KEY_VARIABLE: Record<ImageProvider, string | undefined> = {
  docker: undefined,
  e2b: "E2B_API_KEY",
  impello: "IMPELLO_API_KEY",
};

/** The real builders, loaded only for the providers asked for. */
export const defaultImagesDeps: ImagesDeps = {
  async builder(req) {
    const registry = req.registry === undefined ? {} : { registry: req.registry };
    const sizeLimits = req.sizeLimits === undefined ? {} : { sizeLimits: req.sizeLimits };
    switch (req.provider) {
      case "docker": {
        const { dockerImageBuilder } = await import("@selfbuilding/sandbox-docker");
        return dockerImageBuilder({
          ...(req.sizeLimits?.maxVcpu === undefined ? {} : { maxVcpu: req.sizeLimits.maxVcpu }),
          ...(req.sizeLimits?.maxMemoryMiB === undefined ? {} : { maxMemoryMiB: req.sizeLimits.maxMemoryMiB }),
        });
      }
      case "e2b": {
        const { e2bImageBuilder } = await import("@selfbuilding/sandbox-e2b");
        return e2bImageBuilder({ apiKey: req.apiKey, ...sizeLimits, ...registry });
      }
      case "impello": {
        const { impelloImageBuilder } = await import("@selfbuilding/sandbox-impello");
        return impelloImageBuilder({ apiKey: req.apiKey, ...sizeLimits, ...registry });
      }
    }
  },
};

export function imagesCommand(ctx: CliContext, argv: string[]): Promise<number> {
  return runImagesCommand(ctx, argv, defaultImagesDeps);
}

const ALL_HARNESSES: ImageHarness = "all-harnesses";

/**
 * `--harness` values plus `--all-harnesses`. "all" is each harness separately; the combined image is built only
 * when asked for, alone unless `--harness` names others too (release-prep §4.3).
 */
function resolveHarnesses(values: readonly string[], allHarnesses: boolean): ImageHarness[] {
  const harnesses: ImageHarness[] = [];
  const add = (h: ImageHarness): void => {
    if (!harnesses.includes(h)) harnesses.push(h);
  };
  if (values.length === 0 && !allHarnesses) return [...IMAGE_HARNESSES];
  for (const h of values) {
    if (h === "all") IMAGE_HARNESSES.forEach(add);
    else if (h === ALL_HARNESSES || (IMAGE_HARNESSES as readonly string[]).includes(h)) add(h as ImageHarness);
    else throw new ConfigError(`Unknown harness "${h}". Use claude-code, codex, all or all-harnesses.`);
  }
  if (allHarnesses) add(ALL_HARNESSES);
  return harnesses;
}

/** What a build starts from: template providers use the registry when one is set; Docker always builds locally. */
function buildSource(provider: string, harness: ImageHarness, tag: string, registry: string | undefined): string {
  if (provider === "docker" || registry === undefined) return "Dockerfile";
  return `${registry.replace(/\/+$/, "")}/selfbuilding/${harness}:${tag}`;
}

/** Splits repeatable, comma-separated flag values. */
function listOf(values: string[]): string[] {
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

export async function runImagesCommand(ctx: CliContext, argv: string[], deps: ImagesDeps): Promise<number> {
  const args = parseCommandArgs(
    "images",
    argv,
    {
      provider: { type: "string", multiple: true },
      harness: { type: "string", multiple: true },
      size: { type: "string", multiple: true },
      sizes: { type: "string", multiple: true },
      tag: { type: "string" },
      "all-harnesses": { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      config: { type: "string" },
      "env-file": { type: "string" },
    },
    { min: 1, max: 1 },
  );
  if (args.positionals[0] !== "build") {
    throw new ConfigError(
      `selfbuilding images has one subcommand, build; got "${args.positionals[0]}". See selfbuilding images --help.`,
    );
  }

  const providers = [...new Set(listOf(args.list("provider")))];
  if (providers.length === 0) {
    throw new ConfigError("selfbuilding images build needs --provider docker, e2b or impello.");
  }
  for (const p of providers) {
    if (!(IMAGE_PROVIDERS as readonly string[]).includes(p)) {
      throw new ConfigError(`Unknown provider "${p}". Use one of ${IMAGE_PROVIDERS.join(", ")}.`);
    }
  }
  const harnesses = resolveHarnesses(listOf(args.list("harness")), args.bool("all-harnesses"));
  const tag = args.str("tag") ?? IMAGE_VERSION;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
    throw new ConfigError(`--tag "${tag}" is not a valid image tag. Use letters, digits, ".", "_" and "-".`);
  }
  const dryRun = args.bool("dry-run");
  const json = args.bool("json");

  // Custom sizes and plan limits come from the config when there is one; building never needs a config.
  let configured: SandboxProvider[] = [];
  let customSizes: Parameters<typeof buildSizeTable>[0];
  if (resolveConfigPath(ctx, args.str("config"))) {
    const project = await loadProject(ctx, {
      config: args.str("config"),
      envFile: args.str("env-file"),
      requireConfig: true,
    });
    configured = project.providers;
    customSizes = project.config.sizes;
  } else if (args.str("env-file")) {
    loadEnvFile(ctx, args.str("env-file") as string);
  }
  const sizeNames = listOf([...args.list("size"), ...args.list("sizes")]);
  const sizes = resolveBuildSizes(buildSizeTable(customSizes), sizeNames.length === 0 ? ["small"] : sizeNames);

  const registry = ctx.env.SELFBUILDING_IMAGE_REGISTRY || undefined;
  const builders: ImageBuilder[] = [];
  const unavailable = new Map<string, SelfbuildingError>();
  for (const provider of providers as ImageProvider[]) {
    const variable = KEY_VARIABLE[provider];
    const apiKey = variable ? (ctx.env[variable] ?? "") : "";
    if (variable && !apiKey && !dryRun) unavailable.set(provider, new MissingSecretError({ secret: variable }));
    const sizeLimits = configured.find((p) => p.id === provider)?.sizing?.limits;
    builders.push(
      await deps.builder({
        provider,
        apiKey,
        ...(sizeLimits === undefined ? {} : { sizeLimits }),
        ...(registry === undefined ? {} : { registry }),
      }),
    );
  }

  const plan = planImageBuilds(builders, harnesses, sizes);
  const results = await runImageBuilds({
    plan,
    version: tag,
    dryRun,
    signal: ctx.interrupt,
    unavailable,
    onStart: (planned) => {
      const from = buildSource(planned.builder.provider, planned.harness, tag, registry);
      ctx.stderr.write(`[${planned.builder.provider} ${planned.harness} ${planned.size.name}] from ${from}\n`);
    },
    onResult: (result, planned) => {
      ctx.stdout.write(`${json ? JSON.stringify(result) : formatBuildLine(result, planned.size, { dryRun })}\n`);
    },
    onLog: (planned, line) => {
      ctx.stderr.write(`[${planned.builder.provider} ${planned.harness} ${planned.size.name}] ${line}\n`);
    },
  });

  for (const builder of builders) {
    const ran = results.some((r) => r.ok && r.provider === builder.provider);
    if (builder.sizing.kind !== "template") {
      if (ran) ctx.stderr.write(`${builder.provider} sizes at create; built once\n`);
      continue;
    }
    const hint = dryRun ? null : sizesHint(builder.provider, results);
    if (hint) ctx.stderr.write(`${hint}\n`);
  }
  return results.every((r) => r.ok) ? EXIT.ok : EXIT.failed;
}
