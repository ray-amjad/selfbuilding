// End to end against the real @selfbuilding/core, the built runtime, the scripted harness and the tmpdir provider.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, jsonLines, makeProject, type TestProject } from "../test/helpers.js";
import { EXIT } from "./exit.js";

let project: TestProject;
beforeEach(() => {
  project = makeProject();
});
afterEach(() => project.cleanup());

describe("with the real core", () => {
  it("runs an agent through the scripted harness on a tmpdir sandbox, then replays it on resume", async () => {
    const boxes = path.join(project.root, "boxes");
    project.write(
      "selfbuilding.config.ts",
      `import { defineConfig } from "@selfbuilding/core";
import { scripted, scriptedHarness, tmpdirProvider } from "@selfbuilding/testing";
export default defineConfig({
  deployment: "test-cli",
  harness: scriptedHarness([scripted.say("checking"), scripted.submit({ ok: true })]),
  sandbox: tmpdirProvider({ root: ${JSON.stringify(boxes)} }),
});
`,
    );
    project.write(
      "factories/hello.ts",
      `import { agent, factory } from "@selfbuilding/core";
import { z } from "zod";
export default factory({ name: "hello", input: z.object({}) }, async () => {
  const r = await agent({ name: "hello", prompt: "Say hello and submit ok.", output: z.object({ ok: z.boolean() }) });
  return r.result;
});
`,
    );
    const first = await cli(["run", "factories/hello.ts", "--run-id", "e2e-1", "--json"], { cwd: project.root });
    expect(first.code, first.stderr).toBe(EXIT.ok);
    expect(jsonLines(first.stdout).at(-1)).toMatchObject({ status: "ok", output: { ok: true } });

    const again = await cli(["resume", "e2e-1", "--json"], { cwd: project.root });
    expect(again.code, again.stderr).toBe(EXIT.ok);
    expect(jsonLines(again.stdout).at(-1)).toMatchObject({ status: "ok", output: { ok: true } });

    const watched = await cli(["watch", "e2e-1", "--json"], { cwd: project.root });
    expect(watched.code).toBe(EXIT.ok);
  }, 60_000);
});

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

describe.skipIf(!existsSync(bin))("the built bin", () => {
  it("prints its version and scaffolds a project from flags", () => {
    expect(spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).stdout.trim()).toMatch(
      /^\d+\.\d+\.\d+/,
    );
    const r = spawnSync(
      process.execPath,
      [
        bin,
        "init",
        "--harness",
        "codex",
        "--provider",
        "docker",
        "--host",
        "node",
        "--channel",
        "none",
        "--template",
        "review-pr",
      ],
      { cwd: project.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(r.status, r.stderr).toBe(EXIT.ok);
    expect(project.exists("selfbuilding.config.ts")).toBe(true);
    const again = spawnSync(process.execPath, [bin, "init"], {
      cwd: project.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(again.status).toBe(EXIT.usage);
  });

  it("reports a config error with exit code 2", () => {
    const r = spawnSync(process.execPath, [bin, "reap"], { cwd: project.root, encoding: "utf8" });
    expect(r.status).toBe(EXIT.usage);
    expect(r.stderr).toContain("No selfbuilding.config.ts found");
  });
});
