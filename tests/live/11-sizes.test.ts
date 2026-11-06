// Live 11: machine sizes on real providers (docs/spec/demo-path.md §1.3, §1.4). Each built size boxes at its own
// template (E2B, Impello) or create-time limits (Docker), and the box really has that many vCPUs and that much
// memory. Sizes a provider cannot give are refused before any vendor call. Build templates first with
// `selfbuilding images build --provider <id> --size <name>` and list them in E2B_SIZES / IMPELLO_SIZES.
import {
  BUILT_IN_SIZES,
  type ResolvedSize,
  type SandboxProvider,
  type SandboxSpec,
  SELFBUILDING_LABELS,
  SizeUnavailableError,
} from "@selfbuilding/core";
import { conformanceSandboxName } from "@selfbuilding/sandbox-conformance";
import { docker } from "@selfbuilding/sandbox-docker";
import { e2b } from "@selfbuilding/sandbox-e2b";
import { impello } from "@selfbuilding/sandbox-impello";
import { describe, expect, it } from "vitest";
import { liveRunId, needs } from "./support/live.js";

const env = process.env;
const DEPLOYMENT = "live-sizes";

const sizesFrom = (raw: string | undefined): string[] =>
  (raw ?? "small")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const resolved = (name: string): ResolvedSize => {
  const size = BUILT_IN_SIZES[name as keyof typeof BUILT_IN_SIZES];
  if (!size) throw new Error(`live 11 knows only the built-in sizes; got "${name}"`);
  return { name, ...size };
};

interface Target {
  name: string;
  skip: string;
  sizes: string[];
  refused: ResolvedSize[];
  make(sizes: string[]): SandboxProvider;
  /** Docker caps a container at its size but the kernel still shows the host's CPUs; read the cgroup instead. */
  cgroup: boolean;
}

const targets: Target[] = [
  {
    name: "e2b",
    skip: needs(!env.E2B_API_KEY && "set E2B_API_KEY"),
    sizes: sizesFrom(env.E2B_SIZES),
    refused: env.E2B_PLAN === "pro" ? [] : [resolved("large")],
    make: (sizes) =>
      e2b({
        apiKey: env.E2B_API_KEY ?? "",
        template: env.E2B_CODEX_TEMPLATE ?? "selfbuilding-codex",
        sizes,
        ...(env.E2B_PLAN === "pro" ? { plan: "pro" as const } : {}),
      }),
    cgroup: false,
  },
  {
    name: "impello",
    skip: needs(!env.IMPELLO_API_KEY && "set IMPELLO_API_KEY"),
    sizes: sizesFrom(env.IMPELLO_SIZES),
    refused: [resolved("large")],
    make: (sizes) =>
      impello({
        apiKey: env.IMPELLO_API_KEY ?? "",
        template: env.IMPELLO_CODEX_TEMPLATE ?? "selfbuilding-codex",
        sizes,
      }),
    cgroup: false,
  },
  {
    name: "docker",
    skip: needs(env.SELFBUILDING_E2E_DOCKER !== "1" && "set SELFBUILDING_E2E_DOCKER=1 with a reachable Docker daemon"),
    sizes: ["small", "medium"],
    refused: [resolved("large")],
    make: () =>
      docker({
        build: true,
        maxVcpu: 4,
        ...(env.SELFBUILDING_DOCKER_SOCKET ? { socketPath: env.SELFBUILDING_DOCKER_SOCKET } : {}),
      }),
    cgroup: true,
  },
];

function specFor(runId: string, scope: string, size: ResolvedSize): SandboxSpec {
  return {
    image: { name: "selfbuilding-codex", ref: "selfbuilding/codex:0.1.0", version: "0.1.0" },
    env: {},
    lifetimeMs: 10 * 60_000,
    onExpire: "kill",
    labels: {
      [SELFBUILDING_LABELS.deployment]: DEPLOYMENT,
      [SELFBUILDING_LABELS.run]: runId,
      [SELFBUILDING_LABELS.name]: conformanceSandboxName({ runId, scope }),
      [SELFBUILDING_LABELS.size]: size.name,
    },
    size,
    resources: { vcpu: size.vcpu, memoryMiB: size.memoryMiB },
  };
}

for (const target of targets) {
  describe.skipIf(target.skip !== "")(`live 11: sizes on ${target.name} ${target.skip}`, () => {
    for (const name of target.sizes) {
      it(`a ${name} box has the size's vCPUs and memory`, { timeout: 10 * 60_000 }, async () => {
        const size = resolved(name);
        const provider = target.make(target.sizes);
        const runId = liveRunId(`sizes_${target.name}_${name}`);
        const key = { runId, scope: name, deployment: DEPLOYMENT };
        const { handle } = await provider.openOrCreate(key, specFor(runId, name, size));
        try {
          const probe = target.cgroup
            ? "cat /sys/fs/cgroup/cpu.max; cat /sys/fs/cgroup/memory.max"
            : "nproc; awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo";
          const out = await handle.exec(probe, { user: "root", timeoutMs: 30_000 });
          expect(out.exitCode).toBe(0);
          const [first = "", second = ""] = out.stdoutTail.trim().split("\n");
          if (target.cgroup) {
            const [quota = "0", period = "1"] = first.split(" ");
            expect(Number(quota) / Number(period)).toBeCloseTo(size.vcpu, 1);
            expect(Number(second)).toBe(size.memoryMiB * 1024 * 1024);
          } else {
            expect(Number(first)).toBe(size.vcpu);
            // The guest kernel keeps some memory for itself.
            expect(Number(second)).toBeGreaterThan(size.memoryMiB * 0.85);
            expect(Number(second)).toBeLessThanOrEqual(size.memoryMiB);
          }
        } finally {
          await provider.kill(handle.ref);
        }
      });
    }

    for (const size of target.refused) {
      it(`refuses ${size.name} before any vendor call, naming the fix`, async () => {
        const provider = target.make([...target.sizes, size.name]);
        const runId = liveRunId(`sizes_refused_${target.name}`);
        const error = await provider
          .openOrCreate({ runId, scope: "refused", deployment: DEPLOYMENT }, specFor(runId, "refused", size))
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(error).toBeInstanceOf(SizeUnavailableError);
        expect(error).toMatchObject({ reason: "over-limit" });
      });
    }
  });
}
