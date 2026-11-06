import path from "node:path";
import { tmpdirProvider } from "@selfbuilding/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cli, fakeCore, jsonLines, makeProject, type TestProject } from "../../test/helpers.js";
import { EXIT } from "../exit.js";
import type { Finding } from "./doctor.js";

let project: TestProject;
beforeEach(() => {
  project = makeProject();
});
afterEach(() => project.cleanup());

/** A config whose secrets come from `env` lookups that throw core's MissingSecretError, as fromEnv() will. */
function config(body: string, prelude = ""): string {
  return `import { defineConfig, MissingSecretError } from "@selfbuilding/core";
import { scripted, scriptedHarness, tmpdirProvider } from "@selfbuilding/testing";

const env = (name: string) => async () => {
  const value = process.env[name];
  if (!value) throw new MissingSecretError({ secret: name });
  return value;
};
${prelude}
export default defineConfig({
  deployment: "test-cli",
  ${body}
});
`;
}

function withCredentials(creds: string): string {
  return `harness: Object.assign(Object.create(scriptedHarness([scripted.submit({})])), {
    options: { credentials: ${creds} },
  }),`;
}

async function doctor(args: string[] = []) {
  const r = await cli(["doctor", "--json", ...args], { cwd: project.root, core: fakeCore() });
  const [report] = jsonLines(r.stdout) as [{ ok: boolean; findings: Finding[] }];
  return { ...r, report };
}

describe("selfbuilding doctor", () => {
  it("lists every missing credential and setting at once", async () => {
    project.write(
      "selfbuilding.config.ts",
      config(`${withCredentials(`[
      { kind: "oauth-token", value: env("SB_TEST_MISSING_OAUTH") },
      { kind: "api-key", value: env("SB_TEST_MISSING_KEY") },
    ]`)}
  controlPlane: { url: "https://cp.example", token: env("SB_TEST_MISSING_CP") },
  hitl: { mode: "interactive" },`),
    );
    const { code, report } = await doctor(["--repo", "acme/api"]);
    expect(code).toBe(EXIT.failed);
    expect(report.ok).toBe(false);
    const problems = report.findings.filter((f) => f.severity === "problem");
    expect(problems.map((f) => f.variable).filter(Boolean)).toEqual([
      "SB_TEST_MISSING_OAUTH",
      "SB_TEST_MISSING_KEY",
      "SB_TEST_MISSING_CP",
    ]);
    const checks = problems.map((f) => f.check);
    expect(checks).toContain("sandbox");
    expect(checks).toContain("hitl");
    expect(checks).toContain("git");
  });

  it("passes a credential pool when one entry resolves, and warns about the rest", async () => {
    project.write(
      "selfbuilding.config.ts",
      config(
        `${withCredentials(`[
      { kind: "oauth-token", value: env("SB_TEST_MISSING_OAUTH") },
      { kind: "api-key", value: "sk-test-not-a-real-key" },
    ]`)}
  sandbox: provider,`,
        `const provider = tmpdirProvider({ root: ${JSON.stringify(path.join(project.root, "boxes"))} });`,
      ),
    );
    const { code, report, stdout } = await doctor();
    expect(code).toBe(EXIT.ok);
    expect(report.ok).toBe(true);
    const harness = report.findings.filter((f) => f.check === "harness:scripted");
    expect(harness.map((f) => f.severity)).toEqual(["ok", "warn"]);
    expect(harness[1]?.variable).toBe("SB_TEST_MISSING_OAUTH");
    expect(report.findings.find((f) => f.check === "sandbox:tmpdir")?.severity).toBe("ok");
    // Secret values are resolved but never printed.
    expect(stdout).not.toContain("sk-test-not-a-real-key");
  });

  it("reads --env-file before the config is evaluated", async () => {
    const name = "SB_TEST_DOCTOR_ENV_FILE_KEY";
    project.write(".env", `${name}=sk-from-file\n`);
    project.write("selfbuilding.config.ts", config(withCredentials(`{ kind: "api-key", value: env("${name}") }`)));
    const env: Record<string, string | undefined> = process.env;
    try {
      const r = await cli(["doctor", "--json", "--env-file", ".env"], { cwd: project.root, core: fakeCore(), env });
      const [report] = jsonLines(r.stdout) as [{ findings: Finding[] }];
      expect(report.findings.find((f) => f.check === "harness:scripted")?.severity).toBe("ok");
      expect(r.stdout).not.toContain("sk-from-file");
    } finally {
      delete process.env[name];
    }
  });

  it("reports a harness with no credentials and a provider whose listing fails", async () => {
    const root = path.join(project.root, "boxes");
    project.write(
      "selfbuilding.config.ts",
      config(
        `harness: scriptedHarness([scripted.submit({})]),
  sandbox: provider,`,
        `const provider = tmpdirProvider({ root: ${JSON.stringify(root)} });
provider.faults.inject("401", "list", { times: 10 });`,
      ),
    );
    const { code, report } = await doctor();
    expect(code).toBe(EXIT.failed);
    const byCheck = Object.fromEntries(report.findings.map((f) => [f.check, f]));
    expect(byCheck["harness:scripted"]?.message).toContain("no credentials");
    expect(byCheck["sandbox:tmpdir"]?.severity).toBe("problem");
    expect(byCheck["sandbox:tmpdir"]?.message).toMatch(/^credentials refused/);
    await tmpdirProvider({ root }).close();
  });

  it("checks the git broker and branch protection for --repo", async () => {
    project.write(
      "selfbuilding.config.ts",
      config(
        `${withCredentials(`{ kind: "api-key", value: "x" }`)}
  git: {
    id: "fake",
    host: "github.com",
    readToken: async () => ({ value: "t", expiresAt: "2026-11-01T13:00:00Z", permissions: { contents: "read" } }),
    pushToken: async () => ({ value: "t", expiresAt: "2026-11-01T13:00:00Z", permissions: { contents: "write" } }),
    assertProtected: async (repo: string) => {
      throw new Error(repo + " lets the agent token push to main");
    },
  },`,
      ),
    );
    const { report } = await doctor(["--repo", "acme/api"]);
    const byCheck = Object.fromEntries(report.findings.map((f) => [f.check, f]));
    expect(byCheck["git:fake"]?.severity).toBe("ok");
    expect(byCheck["branch-protection"]).toMatchObject({
      severity: "problem",
      message: "acme/api lets the agent token push to main",
    });
  });

  it("reports a missing config as a problem instead of crashing", async () => {
    const { code, report } = await doctor();
    expect(code).toBe(EXIT.failed);
    expect(report.findings.find((f) => f.check === "config")?.message).toContain("No selfbuilding.config.ts found");
  });

  it("rejects unknown config keys", async () => {
    project.write("selfbuilding.config.ts", `export default { harnes: 1, sandbox: undefined };\n`);
    const { report } = await doctor();
    expect(report.findings.find((f) => f.check === "config")?.message).toContain("unknown config key harnes");
  });

  it("writes a readable report to stderr without --json", async () => {
    project.write("selfbuilding.config.ts", config(""));
    const r = await cli(["doctor"], { cwd: project.root, core: fakeCore() });
    expect(r.code).toBe(EXIT.failed);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/PROBLEM harness: no harness set/);
    expect(r.stderr).toMatch(/problems to fix/);
  });
});
