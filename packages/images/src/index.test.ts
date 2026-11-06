import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import {
  allHarnessesImage,
  BROWSER_LAUNCH_CHECK,
  BROWSER_MCP_SERVER,
  BROWSER_MIN_SIZE,
  baseImage,
  claudeCodeImage,
  codexImage,
  defineImage,
  dockerImageRef,
  env,
  HARNESS_VERSIONS,
  IMAGE_VERSION,
  imageManifest,
  officialImageFor,
  officialImages,
  PLAYWRIGHT_BROWSERS_PATH,
  PLAYWRIGHT_MCP_BIN,
  PLAYWRIGHT_MCP_VERSION,
  PLAYWRIGHT_VERSION,
  resolveDockerImage,
  run,
  toDockerfile,
  verify,
} from "./index.js";

const dockerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docker");

describe("@selfbuilding/images", () => {
  it("builds steps", () => {
    expect(run(["true"])).toEqual({ kind: "run", commands: ["true"] });
    expect(verify("node -v")).toEqual({ kind: "verify", command: "node -v" });
    expect(env({ A: "1" })).toEqual({ kind: "env", vars: { A: "1" } });
  });

  describe("defineImage", () => {
    it("returns a frozen definition", () => {
      const def = defineImage({ name: "selfbuilding-x", from: baseImage, steps: [verify("x --version")] });
      expect(Object.isFrozen(def)).toBe(true);
      expect(Object.isFrozen(def.steps)).toBe(true);
    });

    it("rejects a bad name", () => {
      expect(() => defineImage({ name: "Bad_Name", from: { base: "debian" }, steps: [verify("true")] })).toThrow(
        ConfigError,
      );
    });

    it("requires a final verify step", () => {
      expect(() => defineImage({ name: "x", from: { base: "debian" }, steps: [run(["true"])] })).toThrow(/verify/);
      expect(() => defineImage({ name: "x", from: { base: "debian" }, steps: [] })).toThrow(ConfigError);
    });

    it("requires binaries under /usr/local/bin", () => {
      expect(() =>
        defineImage({ name: "x", from: baseImage, binaries: ["/home/agent/.local/bin/x"], steps: [verify("x")] }),
      ).toThrow(/usr\/local\/bin/);
    });

    it("refuses credential-looking env", () => {
      expect(() =>
        defineImage({ name: "x", from: baseImage, steps: [env({ GITHUB_TOKEN: "x" }), verify("true")] }),
      ).toThrow(/credentials/);
    });
  });

  describe("official images", () => {
    it("pins each harness CLI to its tested version", () => {
      expect(toDockerfile(claudeCodeImage)).toContain(`@anthropic-ai/claude-code@${HARNESS_VERSIONS["claude-code"]}`);
      expect(toDockerfile(codexImage)).toContain(`@openai/codex@${HARNESS_VERSIONS.codex}`);
    });

    it("installs with an empty npmrc and scripts enabled", () => {
      for (const def of [baseImage, claudeCodeImage, codexImage]) {
        for (const line of toDockerfile(def)
          .split("\n")
          .filter((l) => l.includes("npm "))) {
          expect(line).toContain("--userconfig=/dev/null");
          expect(line).toContain("--ignore-scripts=false");
        }
      }
    });

    it("the base image has Node 22, git, gh and an agent user with a build-time UID", () => {
      const file = toDockerfile(baseImage);
      expect(file).toMatch(/^FROM node:22-bookworm-slim$/m);
      expect(file).toContain("ARG AGENT_UID=1000");
      expect(file).toContain("install -y --no-install-recommends gh");
      expect(file).toMatch(/useradd --uid "\$AGENT_UID"/);
      expect(file).toContain("git");
    });

    it("harness images build on the base image and end with --version", () => {
      for (const def of [claudeCodeImage, codexImage]) {
        const file = toDockerfile(def);
        expect(file).toContain(`ARG BASE_IMAGE=selfbuilding/base:${IMAGE_VERSION}`);
        expect(file).toContain("FROM $BASE_IMAGE");
        const runs = file.split("\n").filter((l) => l.startsWith("RUN "));
        expect(runs.at(-1)?.startsWith(`RUN ${def.binaries?.[0]} --version`)).toBe(true);
        expect(file).toContain(JSON.stringify(imageManifest(def)));
      }
    });

    it("names follow selfbuilding/<harness>:<version>", () => {
      expect(dockerImageRef(claudeCodeImage)).toBe(`selfbuilding/claude-code:${IMAGE_VERSION}`);
      expect(resolveDockerImage(codexImage, "1.2.3")).toEqual({
        name: "selfbuilding-codex",
        ref: "selfbuilding/codex:1.2.3",
        version: "1.2.3",
      });
      expect(officialImageFor("selfbuilding/codex:1.2.3")).toEqual({ def: codexImage, tag: "1.2.3" });
      expect(officialImageFor("selfbuilding/base:test")?.def).toBe(baseImage);
      expect(officialImageFor("ubuntu:24.04")).toBeUndefined();
      expect(officialImageFor("selfbuilding/unknown:1")).toBeUndefined();
    });

    it("the checked-in Dockerfiles match the definitions", () => {
      for (const [short, def] of Object.entries(officialImages)) {
        const file = path.join(dockerDir, short, "Dockerfile");
        if (process.env.SELFBUILDING_UPDATE_DOCKERFILES) writeFileSync(file, toDockerfile(def));
        expect(readFileSync(file, "utf8"), `${file} is stale; rerun with SELFBUILDING_UPDATE_DOCKERFILES=1`).toBe(
          toDockerfile(def),
        );
      }
    });
  });

  describe("browser in the Codex image", () => {
    const codex = toDockerfile(codexImage);

    it("pins Playwright and the browser MCP server to exact versions", () => {
      expect(PLAYWRIGHT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
      expect(PLAYWRIGHT_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
      expect(codex).toContain(`playwright@${PLAYWRIGHT_VERSION} @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`);
    });

    it("installs Chromium with its OS libraries into a shared, readable browsers path", () => {
      expect(codex).toContain(`ENV PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH} `);
      expect(codex).toContain("NODE_PATH=/usr/local/lib/node_modules\n");
      expect(codex).toContain("playwright install --with-deps chromium");
      // The MCP server ships its own Playwright build; its browser revision is installed too.
      expect(codex).toContain("@playwright/mcp/node_modules/playwright-core/cli.js install chromium");
      expect(codex).toContain(`chmod -R a+rX ${PLAYWRIGHT_BROWSERS_PATH}`);
      expect(codex).toContain("install -y --no-install-recommends sqlite3");
    });

    it("puts the MCP server at an absolute path that finds the browsers without image env", () => {
      expect(PLAYWRIGHT_MCP_BIN).toBe("/usr/local/bin/playwright-mcp");
      expect(codex).toContain(`: "\${PLAYWRIGHT_BROWSERS_PATH:=${PLAYWRIGHT_BROWSERS_PATH}}"`);
      expect(codex).toContain(`chmod 0755 ${PLAYWRIGHT_MCP_BIN}`);
      expect(codex).toContain("ln -sfn /usr/local/lib/node_modules/playwright /selfbuilding/node_modules/playwright");
      // A writable directory of links, not one link to the read-only tree: the MCP server writes entries there.
      expect(codex).toContain(`cp -as ${PLAYWRIGHT_BROWSERS_PATH}/. /selfbuilding/home/.cache/ms-playwright/`);
      expect(codex).not.toContain(`ln -sfn ${PLAYWRIGHT_BROWSERS_PATH} /selfbuilding/home/.cache/ms-playwright`);
    });

    it("never disables the Chromium sandbox image-wide", () => {
      for (const line of codex.split("\n").filter((l) => l.startsWith("ENV "))) {
        expect(line).not.toMatch(/sandbox/i);
      }
    });

    it("verifies last: codex, the MCP server, and a headless launch as the agent user with a bare env", () => {
      const last = codex
        .split("\n")
        .filter((l) => l.startsWith("RUN "))
        .at(-1);
      expect(last).toContain("/usr/local/bin/codex --version");
      expect(last).toContain(`${PLAYWRIGHT_MCP_BIN} --version`);
      expect(last).toContain("runuser -u agent -- env -i HOME=/selfbuilding/home");
      expect(last).toContain("chromium.launch(");
      expect(BROWSER_LAUNCH_CHECK).toMatch(/^cd \/selfbuilding\/out && env -i /);
      expect(BROWSER_LAUNCH_CHECK).toContain("await import('playwright')");
    });

    it("records the browser in the image manifest", () => {
      expect(imageManifest(codexImage).browser).toEqual({
        engine: "chromium",
        playwright: PLAYWRIGHT_VERSION,
        mcp: PLAYWRIGHT_MCP_BIN,
        browsersPath: PLAYWRIGHT_BROWSERS_PATH,
      });
      expect(codex).toContain(`"browser":{"engine":"chromium"`);
      expect(imageManifest(claudeCodeImage).browser).toBeUndefined();
    });

    it("leaves the base and Claude Code images without a browser", () => {
      for (const def of [baseImage, claudeCodeImage]) {
        expect(toDockerfile(def)).not.toMatch(/playwright|chromium|sqlite3/i);
      }
    });

    it("exports the browser MCP server spec", () => {
      expect(BROWSER_MCP_SERVER).toEqual({
        name: "browser",
        type: "stdio",
        command: "/usr/local/bin/playwright-mcp",
        args: [
          "--headless",
          "--isolated",
          "--browser",
          "chromium",
          "--no-sandbox",
          "--output-dir",
          "/selfbuilding/out/files/verify",
        ],
        env: { PLAYWRIGHT_BROWSERS_PATH: "/opt/selfbuilding/browsers" },
      });
      expect(Object.isFrozen(BROWSER_MCP_SERVER)).toBe(true);
      expect(BROWSER_MIN_SIZE).toBe("medium");
    });
  });
});

describe("ENV quoting (release-prep §4.1)", () => {
  it("toDockerfile writes a safe value unquoted", () => {
    const def = defineImage({
      name: "x",
      from: { base: "debian" },
      steps: [env({ A: "/opt/x", B: "a.b:c@d%e+f,g=h-i_j", C: "" }), verify("true")],
    });
    expect(toDockerfile(def)).toContain("\nENV A=/opt/x B=a.b:c@d%e+f,g=h-i_j C=\n");
  });

  it("toDockerfile keeps JSON quoting for a value that needs it", () => {
    const def = defineImage({
      name: "x",
      from: { base: "debian" },
      steps: [env({ A: "two words", B: 'say "hi"', C: "$HOME" }), verify("true")],
    });
    expect(toDockerfile(def)).toContain('\nENV A="two words" B="say \\"hi\\"" C="$HOME"\n');
  });

  it("the official images write every ENV value unquoted", () => {
    for (const def of Object.values(officialImages)) {
      for (const line of toDockerfile(def)
        .split("\n")
        .filter((l) => l.startsWith("ENV "))) {
        expect(line).not.toContain('"');
      }
    }
  });
});

describe("allHarnessesImage (release-prep §4.3)", () => {
  const file = toDockerfile(allHarnessesImage);

  it("is the official all-harnesses image built on the base", () => {
    expect(allHarnessesImage.name).toBe("selfbuilding-all-harnesses");
    expect(allHarnessesImage.from).toBe(baseImage);
    expect(officialImages["all-harnesses"]).toBe(allHarnessesImage);
    expect(dockerImageRef(allHarnessesImage, "1.2.3")).toBe("selfbuilding/all-harnesses:1.2.3");
    expect(officialImageFor("selfbuilding/all-harnesses:1.2.3")?.def).toBe(allHarnessesImage);
  });

  it("carries both pinned harness CLIs and the browser", () => {
    expect(file).toContain(`@anthropic-ai/claude-code@${HARNESS_VERSIONS["claude-code"]}`);
    expect(file).toContain(`@openai/codex@${HARNESS_VERSIONS.codex}`);
    expect(file).toContain(`playwright@${PLAYWRIGHT_VERSION} @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`);
    expect(file).toContain("ENV DISABLE_AUTOUPDATER=1");
    expect(imageManifest(allHarnessesImage)).toEqual({
      image: "selfbuilding-all-harnesses",
      version: IMAGE_VERSION,
      user: "agent",
      binaries: ["/usr/local/bin/claude", "/usr/local/bin/codex"],
      browser: imageManifest(codexImage).browser,
    });
  });

  it("verifies both binaries and a headless launch last", () => {
    const last = file
      .split("\n")
      .filter((l) => l.startsWith("RUN "))
      .at(-1);
    expect(last).toMatch(/^RUN \/usr\/local\/bin\/claude --version && \/usr\/local\/bin\/codex --version/);
    expect(last).toContain(`${PLAYWRIGHT_MCP_BIN} --version`);
    expect(last).toContain("chromium.launch(");
  });
});
