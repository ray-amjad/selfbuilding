import {
  type ImageBuilder,
  type ImageBuildRequest,
  type ImageBuildResult,
  ImageUnavailableError,
  isSelfbuildingError,
  type SelfbuildingError,
  SizeUnavailableError,
} from "@selfbuilding/core";
import { dockerImageRef, type ImageDefinition, officialImages, toDockerfile } from "@selfbuilding/images";
import { connectDocker, type DockerClient } from "./client.js";
import { dockerSizing } from "./provider.js";
import { progressError } from "./stream.js";
import { packTar } from "./tar.js";

// `selfbuilding images build --provider docker` (docs/spec/demo-path.md §2). Docker sizes at create, so one image
// per harness serves every size; a size only has to fit the host limit.

export interface DockerImageBuilderOptions {
  /** Docker socket path; default the local daemon. */
  socketPath?: string;
  /** A Docker Engine client; tests pass an in-memory one. */
  client?: DockerClient;
  /** The same host limits as docker({ maxVcpu, maxMemoryMiB }); a bigger size is refused. */
  maxVcpu?: number;
  maxMemoryMiB?: number;
  /** The agent user's ids baked into the image. Default: this machine's user (1000 when running as root). */
  buildUser?: { uid: number; gid: number };
}

export function hostIds(): { uid: number; gid: number } {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  // A root host user cannot be the agent (UID 0 is taken), so the image default applies.
  return uid === 0 ? { uid: 1000, gid: 1000 } : { uid, gid };
}

/** Builds the official images on a Docker daemon: the base once per version, then one image per harness. */
export function dockerImageBuilder(opts: DockerImageBuilderOptions = {}): ImageBuilder {
  const sizing = dockerSizing({
    ...(opts.maxVcpu === undefined ? {} : { maxVcpu: opts.maxVcpu }),
    ...(opts.maxMemoryMiB === undefined ? {} : { maxMemoryMiB: opts.maxMemoryMiB }),
  });
  const user = opts.buildUser ?? hostIds();
  let client: DockerClient | undefined;
  const daemon = (): DockerClient => {
    client ??= opts.client ?? connectDocker(opts.socketPath);
    return client;
  };
  const built = new Map<string, Promise<void>>();

  const buildDef = (def: ImageDefinition, version: string, onLog?: (line: string) => void): Promise<void> => {
    const ref = dockerImageRef(def, version);
    let pending = built.get(ref);
    if (!pending) {
      pending = (async () => {
        const buildargs: Record<string, string> = { AGENT_UID: String(user.uid), AGENT_GID: String(user.gid) };
        if (!("base" in def.from)) {
          await buildDef(def.from, version, onLog);
          buildargs.BASE_IMAGE = dockerImageRef(def.from, version);
        }
        const context = packTar([{ name: "Dockerfile", data: Buffer.from(toDockerfile(def, { version })) }]);
        const failure = await progressError(await daemon().buildImage(context, { t: ref, buildargs }), onLog);
        if (failure !== undefined) throw new ImageUnavailableError(`Building ${ref} failed: ${failure}`);
      })();
      built.set(ref, pending);
      pending.catch(() => built.delete(ref));
    }
    return pending;
  };

  const fail = (req: ImageBuildRequest, error: SelfbuildingError): ImageBuildResult => ({
    ok: false,
    provider: "docker",
    harness: req.harness,
    size: req.size.name,
    name: req.name,
    error: error.toJSON(),
  });

  return {
    provider: "docker",
    sizing,
    nameFor: (harness) => `selfbuilding/${harness}`,
    async build(req) {
      const started = Date.now();
      const { maxVcpu, maxMemoryMiB, overLimitFix } = sizing.limits;
      if (
        (maxVcpu !== undefined && req.size.vcpu > maxVcpu) ||
        (maxMemoryMiB !== undefined && req.size.memoryMiB > maxMemoryMiB)
      ) {
        return fail(
          req,
          new SizeUnavailableError({
            provider: "docker",
            size: req.size.name,
            vcpu: req.size.vcpu,
            memoryMiB: req.size.memoryMiB,
            reason: "over-limit",
            fix: overLimitFix ?? "Docker host limit set in docker({ maxVcpu, maxMemoryMiB }).",
          }),
        );
      }
      const def = officialImages[req.harness];
      try {
        if (!def) throw new ImageUnavailableError(`No official image for harness "${req.harness}".`);
        req.signal?.throwIfAborted();
        await buildDef(def, req.version, req.onLog);
        return {
          ok: true,
          provider: "docker",
          harness: req.harness,
          size: req.size.name,
          name: req.name,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        if (isSelfbuildingError(error)) return fail(req, error);
        const message = error instanceof Error ? error.message : String(error);
        return fail(req, new ImageUnavailableError(`Building ${req.name}:${req.version} failed: ${message}`));
      }
    },
  };
}
