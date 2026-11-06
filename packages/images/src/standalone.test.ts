import { ConfigError } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import {
  allHarnessesImage,
  baseImage,
  claudeCodeImage,
  codexImage,
  defineImage,
  env,
  IMAGE_MANIFEST_PATH,
  imageManifest,
  officialImages,
  run,
  toDockerfile,
  toStandaloneDockerfile,
  verify,
} from "./index.js";

const lines = (file: string): string[] => file.split("\n");

const ENCODED = /^sh -euc "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d\)"$/;

/** Each RUN's shell script as it runs in the box: continuations joined, base64-encoded ones decoded. */
function scripts(file: string): string[] {
  return file
    .replace(/ \\\n {2}&& /g, " && ")
    .split("\n")
    .filter((l) => l.startsWith("RUN "))
    .map((l) => {
      const body = l.slice(4);
      const encoded = ENCODED.exec(body);
      return encoded ? Buffer.from(encoded[1] as string, "base64").toString("utf8") : body;
    });
}

describe("toStandaloneDockerfile (release-prep §4.1)", () => {
  it("has one FROM, the root base, and no ARG", () => {
    for (const def of Object.values(officialImages)) {
      const file = toStandaloneDockerfile(def);
      const froms = lines(file).filter((l) => l.startsWith("FROM "));
      expect(froms).toEqual(["FROM node:22-bookworm-slim"]);
      expect(file).not.toMatch(/^ARG /m);
      expect(file).not.toContain("$BASE_IMAGE");
    }
  });

  it("writes one USER root / SHELL preamble right after FROM", () => {
    const file = lines(toStandaloneDockerfile(codexImage));
    expect(file.slice(1, 4)).toEqual(["FROM node:22-bookworm-slim", "USER root", 'SHELL ["/bin/sh", "-euc"]']);
    expect(file.filter((l) => l.startsWith("USER "))).toHaveLength(1);
    expect(file.filter((l) => l.startsWith("SHELL "))).toHaveLength(1);
  });

  it("emits the ancestors' steps root-first, then the image's own, ending with WORKDIR and LABEL", () => {
    const mid = defineImage({
      name: "mid",
      from: { base: "debian:12" },
      steps: [run(["echo root-1"]), verify("echo root-verify")],
    });
    const leaf = defineImage({
      name: "leaf",
      from: mid,
      binaries: ["/usr/local/bin/leaf"],
      steps: [run(["echo leaf-1"]), verify("/usr/local/bin/leaf --version")],
    });
    const file = toStandaloneDockerfile(leaf, { version: "9.9.9" });
    expect(scripts(file)).toEqual([
      "echo root-1",
      "echo root-verify",
      "echo leaf-1",
      `mkdir -p /opt/selfbuilding && printf '%s\\n' '${JSON.stringify(imageManifest(leaf, "9.9.9"))}' > ${IMAGE_MANIFEST_PATH}`,
      "/usr/local/bin/leaf --version",
    ]);
    expect(file).toContain("FROM debian:12\n");
    expect(file).toContain("\nRUN echo root-verify\n");
    expect(file.endsWith('WORKDIR /selfbuilding/work\nLABEL org.opencontainers.image.title="leaf"\n')).toBe(true);
  });

  it("keeps every ancestor's verify as a RUN", () => {
    const file = toStandaloneDockerfile(claudeCodeImage);
    expect(file).toContain("\nRUN node --version && git --version && gh --version && timeout --version >/dev/null\n");
    expect(
      lines(file)
        .filter((l) => l.startsWith("RUN "))
        .at(-1),
    ).toBe("RUN /usr/local/bin/claude --version");
  });

  it("inlines the agent uid and gid (default 1000)", () => {
    const fallback = scripts(toStandaloneDockerfile(baseImage)).join("\n");
    expect(fallback).toContain('useradd --uid "1000" --gid "1000"');
    expect(fallback).not.toMatch(/AGENT_[UG]ID/);
    const custom = scripts(toStandaloneDockerfile(codexImage, { agentUid: 1234, agentGid: 5678 })).join("\n");
    expect(custom).toContain('getent group "5678"');
    expect(custom).toContain('groupadd --gid "5678" agent');
    expect(custom).toContain('useradd --uid "1234" --gid "5678"');
    expect(custom).not.toMatch(/AGENT_[UG]ID/);
  });

  it("runs the same commands as the per-image Dockerfiles, parent first", () => {
    const expected = [...scripts(toDockerfile(baseImage)), ...scripts(toDockerfile(codexImage))]
      .filter((s) => !s.includes('"image":"selfbuilding-base"'))
      .map((s) => s.replace(/"\$AGENT_([UG])ID"/g, '"1000"'));
    expect(scripts(toStandaloneDockerfile(codexImage))).toEqual(expected);
  });

  it("writes every RUN so a parser that drops backslashes or collapses spaces keeps it intact", () => {
    for (const def of Object.values(officialImages)) {
      const runs = toStandaloneDockerfile(def)
        .replace(/ \\\n {2}&& /g, " && ")
        .split("\n")
        .filter((l) => l.startsWith("RUN "));
      for (const line of runs) {
        if (ENCODED.test(line.slice(4))) continue;
        expect(line).not.toMatch(/[\\\t]|\s{2}/);
      }
      // The wrappers and the manifest carry `\n`, so some lines must have been encoded.
      expect(runs.some((l) => ENCODED.test(l.slice(4)))).toBe(true);
    }
  });

  it("refuses a uid or gid that is not a positive integer", () => {
    expect(() => toStandaloneDockerfile(baseImage, { agentUid: 0 })).toThrow(ConfigError);
    expect(() => toStandaloneDockerfile(baseImage, { agentGid: 1.5 })).toThrow(/agentGid/);
  });

  it("writes only the leaf's manifest", () => {
    const runs = scripts(toStandaloneDockerfile(codexImage, { version: "1.2.3" }));
    const manifests = runs.filter((s) => s.includes(IMAGE_MANIFEST_PATH));
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toContain(JSON.stringify(imageManifest(codexImage, "1.2.3")));
    expect(runs.join("\n")).not.toContain('"image":"selfbuilding-base"');
  });

  it("refuses an ENV value a vendor parser would misread, naming the variable and the fix", () => {
    const def = defineImage({
      name: "spacey",
      from: baseImage,
      steps: [env({ GREETING: "hello world" }), verify("true")],
    });
    expect(() => toStandaloneDockerfile(def)).toThrow(ConfigError);
    expect(() => toStandaloneDockerfile(def)).toThrow(/GREETING.*without spaces, quotes, \$ or backslashes/);
    // Real Docker reads the quoted form, so the per-image Dockerfile still renders.
    expect(toDockerfile(def)).toContain('ENV GREETING="hello world"');
  });

  it("writes the official images' ENV unquoted", () => {
    for (const def of Object.values(officialImages)) {
      const envs = lines(toStandaloneDockerfile(def)).filter((l) => l.startsWith("ENV "));
      expect(envs.length).toBeGreaterThan(0);
      for (const line of envs) expect(line).not.toContain('"');
    }
  });

  it("matches the snapshot for codex", () => {
    expect(toStandaloneDockerfile(codexImage)).toMatchSnapshot();
  });

  it("matches the snapshot for all-harnesses", () => {
    expect(toStandaloneDockerfile(allHarnessesImage)).toMatchSnapshot();
  });
});
