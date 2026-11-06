import { Template } from "@impello/sdk/template";
import { codexImage, officialImages, toDockerfile, toStandaloneDockerfile } from "@selfbuilding/images";
import { describe, expect, it, vi } from "vitest";
import { impelloImageBuilder, type impelloTemplateApi } from "./index.js";

// Impello template builds with no registry (docs/spec/release-prep.md §4.2).

const SMALL = { name: "small", vcpu: 2, memoryMiB: 4096 };

function fakeTemplate(o: { dockerfile?: boolean } = {}) {
  const steps: Array<[string, unknown]> = [];
  const builds: unknown[] = [];
  const chain: Record<string, (arg: unknown) => unknown> = {};
  const ops = ["fromImage", "setUser", "setWorkdir", "runCmd", ...(o.dockerfile === false ? [] : ["fromDockerfile"])];
  for (const op of ops) {
    chain[op] = (arg) => {
      steps.push([op, arg]);
      return chain;
    };
  }
  const T = Object.assign(() => chain, {
    build: async (_t: unknown, name: string) => {
      builds.push(name);
      return {};
    },
    assignTags: async () => ({}),
  });
  return { steps, builds, T: T as unknown as Parameters<typeof impelloTemplateApi>[1] };
}

const request = { harness: "codex" as const, size: SMALL, version: "3.0.0", name: "selfbuilding-codex" };

describe("impelloImageBuilder without a registry", () => {
  it("calls fromDockerfile(content), then the same user, workdir and verify chain", async () => {
    const fake = fakeTemplate();
    const result = await impelloImageBuilder({ apiKey: "imp_key_123", template: fake.T }).build(request);
    expect(result.ok).toBe(true);
    expect(fake.steps).toEqual([
      ["fromDockerfile", toStandaloneDockerfile(codexImage, { version: "3.0.0" })],
      ["setUser", "agent"],
      ["setWorkdir", "/selfbuilding/work"],
      ["runCmd", ["/usr/local/bin/codex --version", "test -f /opt/selfbuilding/image-manifest.json"]],
    ]);
  });

  it("calls fromImage with a registry", async () => {
    const fake = fakeTemplate();
    await impelloImageBuilder({ apiKey: "imp_key_123", registry: "ghcr.io/acme", template: fake.T }).build(request);
    expect(fake.steps[0]).toEqual(["fromImage", "ghcr.io/acme/selfbuilding/codex:3.0.0"]);
    expect(fake.steps.map(([op]) => op)).not.toContain("fromDockerfile");
  });

  it("refuses with ImageUnavailableError naming SELFBUILDING_IMAGE_REGISTRY when the SDK has no fromDockerfile", async () => {
    const fake = fakeTemplate({ dockerfile: false });
    const result = await impelloImageBuilder({ apiKey: "imp_key_123", template: fake.T }).build(request);
    expect(result).toMatchObject({ ok: false, error: { code: "image_unavailable" } });
    expect(result.ok ? "" : result.error.message).toContain("SELFBUILDING_IMAGE_REGISTRY");
    expect(fake.builds).toEqual([]);
  });
});

type Parsed = { fromImage: string; steps: Array<{ type: string; args: string[] }> };

async function parse(file: string): Promise<Parsed> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return JSON.parse(await Template.toJSON(Template().fromDockerfile(file), false)) as Parsed;
  } finally {
    warn.mockRestore();
  }
}

/** The Dockerfile's RUN bodies with continuations joined and whitespace runs collapsed. */
function runBodies(file: string): string[] {
  return file
    .replace(/ \\\n {2}&& /g, " && ")
    .split("\n")
    .filter((l) => l.startsWith("RUN "))
    .map((l) => l.slice(4).replace(/\s+/g, " "));
}

describe("the @impello/sdk Dockerfile parser (offline)", () => {
  // Template().fromDockerfile parses locally; toJSON without hashes never calls the API.
  it("is lossy: it keeps ENV quotes and drops RUN backslashes", async () => {
    const parsed = await parse("FROM debian\nENV A=\"/x\"\nRUN printf 'a\\nb'\n");
    expect(parsed.steps.find((s) => s.type === "ENV")?.args).toEqual(["A", '"/x"']);
    expect(parsed.steps.find((s) => s.type === "RUN")?.args).toEqual(["printf 'anb'"]);
    // So the per-image Dockerfile would arrive broken; the standalone form exists for this parser.
    const perImage = await parse(toDockerfile(codexImage).replace(/^ARG .*\nFROM .*$/m, "FROM node:22-bookworm-slim"));
    expect(perImage.steps.filter((s) => s.type === "RUN").map((s) => s.args[0])).not.toEqual(
      runBodies(toDockerfile(codexImage)),
    );
  });

  for (const [short, image] of Object.entries(officialImages).filter(([k]) => k !== "base")) {
    it(`keeps every RUN and ENV of the standalone ${short} Dockerfile intact`, async () => {
      const file = toStandaloneDockerfile(image, { version: "3.0.0" });
      const parsed = await parse(file);
      expect(parsed.fromImage).toBe("node:22-bookworm-slim");
      const runs = parsed.steps.filter((s) => s.type === "RUN").map((s) => (s.args[0] ?? "").replace(/\s+/g, " "));
      expect(runs).toEqual(runBodies(file));
      const envs = parsed.steps.filter((s) => s.type === "ENV").flatMap((s) => s.args);
      expect(envs).toContain("C.UTF-8");
      for (const value of envs) expect(value).not.toContain('"');
    });
  }
});
