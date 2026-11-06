import {
  type ProviderSandbox,
  type ResolvedSize,
  type SandboxSpec,
  SELFBUILDING_LABELS,
  SizeUnavailableError,
} from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { type DockerOptions, docker, dockerImageBuilder } from "../src/index.js";
import { FakeDocker } from "./fake-docker.js";

// Docker sizes at create (docs/spec/demo-path.md §1.3): any size up to the host limit, forks may take another size.

const DEPLOYMENT = "dev";
const RUN = "run-sizes";
const IMAGE = { name: "selfbuilding-base", ref: "selfbuilding/base:test", version: "0.0.0-test" };
const MEDIUM: ResolvedSize = { name: "medium", vcpu: 4, memoryMiB: 8192 };
const LARGE: ResolvedSize = { name: "large", vcpu: 8, memoryMiB: 16384 };

const key = (scope: string) => ({ runId: RUN, scope, deployment: DEPLOYMENT });

function spec(scope: string, size?: ResolvedSize): SandboxSpec {
  return {
    image: IMAGE,
    env: {},
    lifetimeMs: 60_000,
    onExpire: "pause",
    labels: {
      [SELFBUILDING_LABELS.deployment]: DEPLOYMENT,
      [SELFBUILDING_LABELS.run]: RUN,
      [SELFBUILDING_LABELS.name]: `box-${scope}`,
    },
    ...(size ? { size, resources: { vcpu: size.vcpu, memoryMiB: size.memoryMiB } } : {}),
  };
}

function setup(opts: DockerOptions = {}) {
  const fake = new FakeDocker();
  const provider = docker({
    client: fake,
    backoff: { baseMs: 1, capMs: 5 },
    pollMs: 5,
    deadlineMs: 1_500,
    ...opts,
  });
  return { fake, provider };
}

describe("docker sizing", () => {
  it("declares create-time sizing whose forks may override, with no host cap by default", () => {
    const { provider } = setup();
    expect(provider.sizing).toMatchObject({ kind: "create", forkSize: "override", resize: false });
    expect(provider.sizing?.limits.maxVcpu).toBeUndefined();
    const capped = setup({ maxVcpu: 4, maxMemoryMiB: 8192 }).provider;
    expect(capped.sizing?.limits).toMatchObject({ maxVcpu: 4, maxMemoryMiB: 8192 });
    expect(capped.sizing?.limits.overLimitFix).toBe(
      "Docker host limit set in docker({ maxVcpu, maxMemoryMiB }) is 4 vCPU and 8 GiB. Raise it there, or use a smaller size.",
    );
  });

  it("creates the box at the requested size and reads the size back into the ref", async () => {
    const { fake, provider } = setup();
    const { handle } = await provider.openOrCreate(key("a"), spec("a", MEDIUM));
    const container = fake.only();
    expect(container.options.HostConfig.NanoCpus).toBe(4e9);
    expect(container.options.HostConfig.Memory).toBe(8192 * 1024 * 1024);
    expect(container.labels[SELFBUILDING_LABELS.size]).toBe("medium");
    expect(handle.ref.size).toBe("medium");
    expect((await provider.find(key("a")))?.size).toBe("medium");
  });

  it("leaves an unsized box at the daemon default with no size on the ref", async () => {
    const { fake, provider } = setup();
    const { handle } = await provider.openOrCreate(key("plain"), spec("plain"));
    expect(fake.only().options.HostConfig.NanoCpus).toBeUndefined();
    expect(handle.ref.size).toBeUndefined();
  });

  it("refuses a size over the host limit before touching the daemon, naming the fix", async () => {
    const { fake, provider } = setup({ maxVcpu: 4 });
    const error = await provider.openOrCreate(key("big"), spec("big", LARGE)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SizeUnavailableError);
    expect(error).toMatchObject({ provider: "docker", size: "large", vcpu: 8, reason: "over-limit" });
    expect((error as Error).message).toMatch(/docker\(\{ maxVcpu, maxMemoryMiB \}\) is 4 vCPU\. Raise it there/);
    expect(fake.containers.size).toBe(0);
  });

  it("forks children at the parent's size by default, and at another size when asked", async () => {
    const { fake, provider } = setup();
    const parent = (await provider.openOrCreate(key("p"), spec("p", MEDIUM))).handle;
    const child = (n: number) => ({ name: `child-${n}`, labels: {} });
    const fork = provider.fork?.bind(provider);
    if (!fork) throw new Error("docker() forks");
    const [same] = (await fork(parent.ref, { children: [child(0)], lifetimeMs: 60_000 })) as [ProviderSandbox];
    expect(fake.containers.get(same.ref.id)?.options.HostConfig.NanoCpus).toBe(4e9);
    expect(same.ref.size).toBe("medium");

    const [bigger] = (await fork(parent.ref, {
      children: [{ ...child(1), key: { ...key("p"), scope: "p/fork-big" } }],
      lifetimeMs: 60_000,
      size: LARGE,
    })) as [ProviderSandbox];
    expect(fake.containers.get(bigger.ref.id)?.options.HostConfig.NanoCpus).toBe(8e9);
    expect(fake.containers.get(bigger.ref.id)?.options.HostConfig.Memory).toBe(16384 * 1024 * 1024);
    expect(bigger.ref.size).toBe("large");
  });

  it("refuses a fork size over the host limit", async () => {
    const { provider } = setup({ maxVcpu: 4 });
    const parent = (await provider.openOrCreate(key("q"), spec("q", MEDIUM))).handle;
    await expect(
      provider.fork?.(parent.ref, { children: [{ name: "c", labels: {} }], lifetimeMs: 60_000, size: LARGE }),
    ).rejects.toBeInstanceOf(SizeUnavailableError);
  });
});

describe("dockerImageBuilder", () => {
  const request = (harness: "claude-code" | "codex", size: ResolvedSize = MEDIUM) => ({
    harness,
    size,
    version: "9.9.9",
    name: `selfbuilding/${harness}`,
  });

  it("builds the base once, then one image per harness tagged with the version", async () => {
    const fake = new FakeDocker([]);
    const builder = dockerImageBuilder({ client: fake, buildUser: { uid: 1234, gid: 5678 } });
    expect(builder.provider).toBe("docker");
    expect(builder.sizing.kind).toBe("create");
    expect(builder.nameFor("codex", "large")).toBe("selfbuilding/codex");
    const logs: string[] = [];
    const codex = await builder.build({ ...request("codex"), onLog: (l) => logs.push(l) });
    const claude = await builder.build(request("claude-code"));
    expect(codex).toMatchObject({ ok: true, provider: "docker", harness: "codex", size: "medium" });
    expect(claude.ok).toBe(true);
    expect(fake.built.map((b) => b.t)).toEqual([
      "selfbuilding/base:9.9.9",
      "selfbuilding/codex:9.9.9",
      "selfbuilding/claude-code:9.9.9",
    ]);
    expect(fake.built[0]?.buildargs).toMatchObject({ AGENT_UID: "1234", AGENT_GID: "5678" });
    expect(fake.built[1]?.buildargs?.BASE_IMAGE).toBe("selfbuilding/base:9.9.9");
    expect(logs).toContain("Step 1/1");
  });

  it("refuses a size over its host limit without building", async () => {
    const fake = new FakeDocker([]);
    const result = await dockerImageBuilder({ client: fake, maxVcpu: 4 }).build(request("codex", LARGE));
    expect(result).toMatchObject({ ok: false, error: { code: "size_unavailable" } });
    expect(fake.built).toEqual([]);
  });

  it("reports a failed build as image_unavailable", async () => {
    const fake = new FakeDocker([]);
    fake.buildImage = async () => {
      const { Readable } = await import("node:stream");
      return Readable.from([`${JSON.stringify({ error: "no space left on device" })}\n`]);
    };
    const result = await dockerImageBuilder({ client: fake }).build(request("codex"));
    expect(result).toMatchObject({ ok: false, error: { code: "image_unavailable" } });
    expect(result.ok ? "" : result.error.message).toMatch(/no space left on device/);
  });
});
