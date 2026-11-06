import { describe, expect, it } from "vitest";
import { type CallState, resolveVersion } from "./lifecycle.js";

// Found live: a Codex reviewer on a fork of a Claude Code box failed with "codex: No such file or directory"
// because nothing ran the harness's install plan. A missing binary (exit 127) is now installed, then checked again.
function setup(opts: { installs: boolean }) {
  const ran: { cmd: string; user?: string }[] = [];
  let installed = false;
  const box = {
    exec: async (cmd: string, o: { user?: string }) => {
      ran.push({ cmd, ...(o.user ? { user: o.user } : {}) });
      if (cmd.includes("--version") && !cmd.includes("npm")) {
        return installed
          ? { exitCode: 0, stdoutTail: "codex-cli 0.164.0", stderrTail: "" }
          : { exitCode: 127, stdoutTail: "", stderrTail: "codex: No such file or directory" };
      }
      if (cmd.includes("npm")) {
        installed = opts.installs;
        return opts.installs
          ? { exitCode: 0, stdoutTail: "", stderrTail: "" }
          : { exitCode: 1, stdoutTail: "", stderrTail: "npm ERR! network" };
      }
      return { exitCode: 0, stdoutTail: "", stderrTail: "" };
    },
  };
  const events: unknown[] = [];
  const harness = {
    id: "codex",
    options: {},
    testedVersion: "0.164.0",
    versionCommand: () => ({ argv: ["/usr/local/bin/codex", "--version"] }),
    parseVersion: (out: string) => out.split(" ").at(-1),
    install: (version: string) => ({
      version,
      binary: "/usr/local/bin/codex",
      commands: [{ argv: ["/usr/bin/env", "npm", "install", `@openai/codex@${version}`], user: "root" }],
    }),
  };
  const state = {
    box,
    plan: { harness, callPath: "review" },
    ctx: { config: {}, emit: (e: unknown) => events.push(e) },
  } as unknown as CallState;
  return { state, ran, events };
}

describe("resolveVersion installs a harness the image lacks", () => {
  it("runs the install plan as root after a 127, then reads the version", async () => {
    const { state, ran, events } = setup({ installs: true });
    await expect(resolveVersion(state)).resolves.toBe("0.164.0");
    expect(ran.find((r) => r.cmd.includes("npm"))?.user).toBe("root");
    expect(ran.find((r) => r.cmd.includes("npm"))?.cmd).toContain("@openai/codex@0.164.0");
    expect(JSON.stringify(events)).toContain("installed it");
  });

  it("fails with the installer's output when the install fails", async () => {
    const { state } = setup({ installs: false });
    await expect(resolveVersion(state)).rejects.toThrow(
      /Installing codex 0\.164\.0 in the box failed.*npm ERR! network/,
    );
  });
});
