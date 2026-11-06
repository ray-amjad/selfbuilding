import { ConfigError, HarnessProtocolError, HarnessVersionUnavailableError } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { CODEX_TESTED_VERSION } from "./constants.js";
import { codex } from "./index.js";
import { codexInstallPlan, installPrefix, isExactVersion, parseCodexVersion, resolveCodexVersion } from "./version.js";

describe("version policy (spec §4.11)", () => {
  it("defaults to the tested pin, which matches the CLI this release was checked against", () => {
    expect(CODEX_TESTED_VERSION).toBe("0.164.0");
    expect(codex().options.version).toBe("tested");
    expect(resolveCodexVersion()).toEqual({ version: CODEX_TESTED_VERSION, source: "tested", tested: true });
  });

  it("follows the priority table: session, exact, hold, latest, tested", () => {
    const all = { version: "0.170.0", hold: "0.160.0", sessionVersion: "0.150.0", latest: "0.171.0" };
    expect(resolveCodexVersion(all)).toEqual({ version: "0.150.0", source: "session", tested: false });
    expect(resolveCodexVersion({ ...all, sessionVersion: undefined })).toMatchObject({
      version: "0.170.0",
      source: "exact",
    });
    expect(resolveCodexVersion({ hold: "0.160.0", latest: "0.171.0", version: "latest" })).toMatchObject({
      version: "0.160.0",
      source: "hold",
    });
    expect(resolveCodexVersion({ hold: "0.160.0" })).toMatchObject({ version: "0.160.0", source: "hold" });
    expect(resolveCodexVersion({ version: "latest", latest: "0.171.0" })).toEqual({
      version: "0.171.0",
      source: "latest",
      tested: false,
    });
  });

  it("a resume runs exactly the session's version, even under a hold", () => {
    expect(
      resolveCodexVersion({ sessionVersion: CODEX_TESTED_VERSION, hold: "0.160.0", version: "latest" }),
    ).toMatchObject({
      version: CODEX_TESTED_VERSION,
      source: "session",
    });
  });

  it("refuses ranges and tags where an exact version is needed", () => {
    expect(() => resolveCodexVersion({ version: "^0.164.0" })).toThrow(ConfigError);
    expect(() => resolveCodexVersion({ hold: "next" })).toThrow(ConfigError);
    expect(() => resolveCodexVersion({ version: "latest" })).toThrow(HarnessVersionUnavailableError);
    expect(isExactVersion("0.165.0-alpha.3")).toBe(true);
    expect(isExactVersion("0.165")).toBe(false);
  });

  it("parses `codex --version`", () => {
    expect(parseCodexVersion("codex-cli 0.164.0\n")).toBe("0.164.0");
    expect(parseCodexVersion("codex-cli 0.165.0-alpha.3")).toBe("0.165.0-alpha.3");
    expect(() => parseCodexVersion("command not found")).toThrow(HarnessProtocolError);
  });
});

describe("install plan", () => {
  it("installs an exact version from npm with empty npmrc files, as root, into the binary's prefix", () => {
    const plan = codexInstallPlan("0.164.0", "/usr/local/bin/codex");
    expect(plan.binary).toBe("/usr/local/bin/codex");
    expect(plan.version).toBe("0.164.0");
    const [install, check] = plan.commands;
    expect(install?.argv).toEqual([
      "/usr/bin/env",
      "npm",
      "install",
      "--global",
      "--prefix",
      "/usr/local",
      "--no-fund",
      "--no-audit",
      "@openai/codex@0.164.0",
    ]);
    expect(install?.env).toMatchObject({ NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_IGNORE_SCRIPTS: "false" });
    expect(install?.user).toBe("root");
    expect(check?.argv).toEqual(["/usr/local/bin/codex", "--version"]);
    expect(codex().installHosts()).toEqual(["registry.npmjs.org"]);
  });

  it("never installs a policy or an injected argument", () => {
    expect(() => codexInstallPlan("latest", "/usr/local/bin/codex")).toThrow(ConfigError);
    expect(() => codexInstallPlan("0.164.0 --registry=http://evil", "/usr/local/bin/codex")).toThrow(ConfigError);
    expect(() => installPrefix("codex")).toThrow(ConfigError);
    expect(installPrefix("/opt/tools/bin/codex")).toBe("/opt/tools");
  });
});
