import type { ResolvedSize } from "@selfbuilding/core";
import { allHarnessesImage, codexImage, officialImages, toStandaloneDockerfile } from "@selfbuilding/images";
import { Template } from "e2b";
import { describe, expect, it } from "vitest";
import { type TemplateBuildApi, templateImageBuilder } from "./build.js";
import {
  E2B_SIZE_LIMITS,
  type E2bTemplateDefinition,
  e2bImageBuilder,
  e2bTemplate,
  type e2bTemplateApi,
  SELFBUILDING_TEMPLATE_NAMES,
  templateSizing,
} from "./index.js";

// Template builds with no registry: the official image as one Dockerfile (docs/spec/release-prep.md §4.2, §4.3).

const SMALL: ResolvedSize = { name: "small", vcpu: 2, memoryMiB: 4096 };
const MEDIUM: ResolvedSize = { name: "medium", vcpu: 4, memoryMiB: 8192 };

function recordingApi() {
  const defs: E2bTemplateDefinition[] = [];
  const api: TemplateBuildApi = {
    async build(def) {
      defs.push(def);
    },
    async assignTags() {},
  };
  return { defs, api };
}

function builder(api: TemplateBuildApi, registry?: string) {
  return templateImageBuilder({
    provider: "e2b",
    sizing: templateSizing({ available: [], limits: E2B_SIZE_LIMITS.pro }),
    api: () => api,
    disk: true,
    ...(registry === undefined ? {} : { registry }),
  });
}

/** A fake `Template` that records the builder chain. */
function fakeTemplate() {
  const steps: Array<[string, unknown]> = [];
  const chain: Record<string, (arg: unknown) => unknown> = {};
  for (const op of ["fromImage", "fromDockerfile", "setUser", "setWorkdir", "runCmd"]) {
    chain[op] = (arg) => {
      steps.push([op, arg]);
      return chain;
    };
  }
  const T = Object.assign(() => chain, {
    build: async () => ({}),
    assignTags: async () => ({}),
  });
  return { steps, T: T as unknown as Parameters<typeof e2bTemplateApi>[1] };
}

describe("templateImageBuilder without a registry", () => {
  it("hands the vendor the official image as a standalone Dockerfile", async () => {
    const { defs, api } = recordingApi();
    const result = await builder(api).build({
      harness: "codex",
      size: SMALL,
      version: "2.0.0",
      name: "selfbuilding-codex",
    });
    expect(result.ok).toBe(true);
    expect(defs[0]?.dockerfile).toBe(toStandaloneDockerfile(codexImage, { version: "2.0.0" }));
  });

  it("keeps fromImage and no Dockerfile when a registry is given", async () => {
    const { defs, api } = recordingApi();
    await builder(api, "ghcr.io/acme").build({
      harness: "codex",
      size: SMALL,
      version: "2.0.0",
      name: "selfbuilding-codex",
    });
    expect(defs[0]?.fromImage).toBe("ghcr.io/acme/selfbuilding/codex:2.0.0");
    expect(defs[0]).not.toHaveProperty("dockerfile");
  });

  it("builds the all-harnesses template under the naming rule", async () => {
    const { defs, api } = recordingApi();
    const b = builder(api);
    expect(b.nameFor("all-harnesses", "small")).toBe("selfbuilding-all-harnesses");
    expect(b.nameFor("all-harnesses", "medium")).toBe("selfbuilding-all-harnesses-medium");
    const result = await b.build({
      harness: "all-harnesses",
      size: MEDIUM,
      version: "2.0.0",
      name: "selfbuilding-all-harnesses-medium",
    });
    expect(result.ok).toBe(true);
    expect(defs[0]).toMatchObject({
      alias: "selfbuilding-all-harnesses-medium",
      binaries: ["/usr/local/bin/claude", "/usr/local/bin/codex"],
      cpuCount: 4,
      memoryMB: 8192,
    });
    expect(defs[0]?.dockerfile).toBe(toStandaloneDockerfile(allHarnessesImage, { version: "2.0.0" }));
  });
});

describe("e2bTemplate selfbuilding-all-harnesses", () => {
  it("lists and verifies both harness binaries", () => {
    expect(SELFBUILDING_TEMPLATE_NAMES).toContain("selfbuilding-all-harnesses");
    expect(e2bTemplate("selfbuilding-all-harnesses", { version: "1.2.3" })).toMatchObject({
      alias: "selfbuilding-all-harnesses",
      fromImage: "selfbuilding/all-harnesses:1.2.3",
      binaries: ["/usr/local/bin/claude", "/usr/local/bin/codex"],
      verify: [
        "/usr/local/bin/claude --version",
        "/usr/local/bin/codex --version",
        "test -f /opt/selfbuilding/image-manifest.json",
      ],
    });
  });
});

describe("e2b SDK binding with a Dockerfile", () => {
  it("calls fromDockerfile(content), then the same user, workdir and verify chain", async () => {
    const fake = fakeTemplate();
    const result = await e2bImageBuilder({ apiKey: "e2b_key_123", template: fake.T }).build({
      harness: "codex",
      size: SMALL,
      version: "2.0.0",
      name: "selfbuilding-codex",
    });
    expect(result.ok).toBe(true);
    expect(fake.steps).toEqual([
      ["fromDockerfile", toStandaloneDockerfile(codexImage, { version: "2.0.0" })],
      ["setUser", "agent"],
      ["setWorkdir", "/selfbuilding/work"],
      ["runCmd", ["/usr/local/bin/codex --version", "test -f /opt/selfbuilding/image-manifest.json"]],
    ]);
  });

  it("calls fromImage with a registry", async () => {
    const fake = fakeTemplate();
    await e2bImageBuilder({ apiKey: "e2b_key_123", registry: "ghcr.io/acme", template: fake.T }).build({
      harness: "codex",
      size: SMALL,
      version: "2.0.0",
      name: "selfbuilding-codex",
    });
    expect(fake.steps[0]).toEqual(["fromImage", "ghcr.io/acme/selfbuilding/codex:2.0.0"]);
    expect(fake.steps.map(([op]) => op)).not.toContain("fromDockerfile");
  });
});

/** The Dockerfile's RUN bodies with continuations joined and whitespace runs collapsed. */
function runBodies(file: string): string[] {
  return file
    .replace(/ \\\n {2}&& /g, " && ")
    .split("\n")
    .filter((l) => l.startsWith("RUN "))
    .map((l) => l.slice(4).replace(/\s+/g, " "));
}

describe("the stock e2b Dockerfile parser (offline)", () => {
  // Template().fromDockerfile parses locally; toJSON without hashes never calls the API.
  for (const [short, image] of Object.entries(officialImages).filter(([k]) => k !== "base")) {
    it(`keeps every RUN and ENV of ${short} intact`, async () => {
      const file = toStandaloneDockerfile(image, { version: "2.0.0" });
      const parsed = JSON.parse(await Template.toJSON(Template().fromDockerfile(file), false)) as {
        fromImage: string;
        steps: Array<{ type: string; args: string[] }>;
      };
      expect(parsed.fromImage).toBe("node:22-bookworm-slim");
      const runs = parsed.steps.filter((s) => s.type === "RUN").map((s) => (s.args[0] ?? "").replace(/\s+/g, " "));
      expect(runs).toEqual(runBodies(file));
      for (const step of parsed.steps.filter((s) => s.type === "ENV")) {
        for (const value of step.args) expect(value).not.toContain('"');
      }
      expect(parsed.steps.filter((s) => s.type === "ENV").flatMap((s) => s.args)).toContain("C.UTF-8");
    });
  }
});
