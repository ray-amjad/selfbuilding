// Live 14: templates built with no registry (docs/spec/release-prep.md §4). `selfbuilding images build` hands each
// vendor the official image as one standalone Dockerfile, so nothing has to be published first. This builds the
// combined `selfbuilding-all-harnesses` template at small on E2B and Impello from that Dockerfile, then boxes it
// and checks what the vendor's Dockerfile parser could have broken: both harness binaries, the image manifest
// (written with printf '%s\n'), the MCP wrapper, unquoted ENV paths and a headless Chromium launch.
//
// It moves the template's `default` tag, like any successful build. Takes 10-30 minutes per vendor.
import {
  type ImageBuilder,
  type ResolvedSize,
  type SandboxProvider,
  type SandboxSpec,
  SELFBUILDING_LABELS,
} from "@selfbuilding/core";
import { BROWSER_LAUNCH_CHECK, IMAGE_MANIFEST_PATH, IMAGE_VERSION } from "@selfbuilding/images";
import { conformanceSandboxName } from "@selfbuilding/sandbox-conformance";
import { e2b, e2bImageBuilder } from "@selfbuilding/sandbox-e2b";
import { impello, impelloImageBuilder } from "@selfbuilding/sandbox-impello";
import { describe, expect, it } from "vitest";
import { liveRunId, needs } from "./support/live.js";

const env = process.env;
const DEPLOYMENT = "live-images-dockerfile";
const TEMPLATE = "selfbuilding-all-harnesses";
const SMALL: ResolvedSize = { name: "small", vcpu: 2, memoryMiB: 4096 };
const registrySet = Boolean(env.SELFBUILDING_IMAGE_REGISTRY) && "unset SELFBUILDING_IMAGE_REGISTRY";

interface Target {
  name: string;
  skip: string;
  builder(): ImageBuilder;
  provider(): SandboxProvider;
}

const targets: Target[] = [
  {
    name: "e2b",
    skip: needs(!env.E2B_API_KEY && "set E2B_API_KEY", registrySet),
    builder: () => e2bImageBuilder({ apiKey: env.E2B_API_KEY ?? "" }),
    provider: () => e2b({ apiKey: env.E2B_API_KEY ?? "", template: TEMPLATE }),
  },
  {
    name: "impello",
    skip: needs(!env.IMPELLO_API_KEY && "set IMPELLO_API_KEY", registrySet),
    builder: () => impelloImageBuilder({ apiKey: env.IMPELLO_API_KEY ?? "" }),
    provider: () => impello({ apiKey: env.IMPELLO_API_KEY ?? "", template: TEMPLATE }),
  },
];

function specFor(runId: string): SandboxSpec {
  return {
    image: { name: TEMPLATE, ref: `selfbuilding/all-harnesses:${IMAGE_VERSION}`, version: IMAGE_VERSION },
    env: {},
    lifetimeMs: 10 * 60_000,
    onExpire: "kill",
    labels: {
      [SELFBUILDING_LABELS.deployment]: DEPLOYMENT,
      [SELFBUILDING_LABELS.run]: runId,
      [SELFBUILDING_LABELS.name]: conformanceSandboxName({ runId, scope: "box" }),
      [SELFBUILDING_LABELS.size]: SMALL.name,
    },
    size: SMALL,
    resources: { vcpu: SMALL.vcpu, memoryMiB: SMALL.memoryMiB },
  };
}

for (const target of targets) {
  describe.skipIf(target.skip !== "")(`live 14: ${TEMPLATE} from a Dockerfile on ${target.name} ${target.skip}`, () => {
    it("builds the template with no registry", { timeout: 45 * 60_000 }, async () => {
      const logs: string[] = [];
      const result = await target.builder().build({
        harness: "all-harnesses",
        size: SMALL,
        version: IMAGE_VERSION,
        name: TEMPLATE,
        onLog: (line) => logs.push(line),
      });
      if (!result.ok) console.error(logs.slice(-40).join("\n"));
      expect(result).toMatchObject({ ok: true, name: TEMPLATE });
    });

    it("boxes it with both harnesses, the manifest, the wrappers and the browser intact", {
      timeout: 10 * 60_000,
    }, async () => {
      const provider = target.provider();
      const runId = liveRunId(`images_dockerfile_${target.name}`);
      const { handle } = await provider.openOrCreate({ runId, scope: "box", deployment: DEPLOYMENT }, specFor(runId));
      try {
        const run = async (cmd: string, user: "agent" | "root" = "agent") => {
          const out = await handle.exec(cmd, { user, timeoutMs: 120_000 });
          expect(out.exitCode, `${cmd}\n${out.stderrTail}`).toBe(0);
          return out.stdoutTail.trim();
        };
        await run("/usr/local/bin/claude --version && /usr/local/bin/codex --version");
        const manifest = JSON.parse(await run(`cat ${IMAGE_MANIFEST_PATH}`)) as Record<string, unknown>;
        expect(manifest).toMatchObject({
          image: TEMPLATE,
          user: "agent",
          binaries: ["/usr/local/bin/claude", "/usr/local/bin/codex"],
        });
        // printf '\n' in the wrappers survives only if the parser kept the backslashes.
        expect((await run("cat /usr/local/bin/selfbuilding-mcp")).split("\n")[0]).toBe("#!/bin/sh");
        expect((await run("cat /usr/local/bin/playwright-mcp")).split("\n")[0]).toBe("#!/bin/sh");
        expect(await run("id -u agent")).toBe("1000");
        // ENV paths arrive without quotes, so the browsers are where the image says.
        await run("test -d /opt/selfbuilding/browsers && test -d /usr/local/lib/node_modules/playwright");
        await run(BROWSER_LAUNCH_CHECK);
      } finally {
        await provider.kill(handle.ref);
      }
    });
  });
}
