import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// release-prep §7.2 #4: `selfbuilding/launcher` exports the Node start_workflow launcher; the bin stays.

const pkgUrl = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as {
  bin: Record<string, string>;
  exports: Record<string, { types: string; import: string }>;
};
const built = new URL("../dist/launcher.js", import.meta.url);

describe("the selfbuilding/launcher entry", () => {
  it("is in the package exports and the tsup entries, next to the bin", () => {
    expect(pkg.bin).toEqual({ selfbuilding: "./dist/cli.js" });
    expect(pkg.exports["./launcher"]).toEqual({ types: "./dist/launcher-entry.d.ts", import: "./dist/launcher.js" });
    const tsup = readFileSync(new URL("../tsup.config.ts", import.meta.url), "utf8");
    expect(tsup).toMatch(/launcher: "src\/launcher-entry\.ts"/);
  });

  it("exports nodeWorkflowLauncher and nothing else at run time", async () => {
    const entry = await import("./launcher-entry.js");
    expect(Object.keys(entry)).toEqual(["nodeWorkflowLauncher"]);
    const launcher = entry.nodeWorkflowLauncher({ cwd: "/nonexistent-project", spawn: () => undefined });
    expect(launcher.host).toBe("node");
  });

  it.skipIf(!existsSync(built))(
    "resolves by package name once built, and starts runs with the CLI it ships with",
    async () => {
      const mod = (await import("selfbuilding/launcher")) as typeof import("./launcher-entry.js");
      const cwd = await mkdtemp(path.join(tmpdir(), "sb-launcher-entry-"));
      try {
        const argvs: string[][] = [];
        const launcher = mod.nodeWorkflowLauncher({
          cwd,
          spawn: (argv) => {
            argvs.push(argv);
            return undefined;
          },
        });
        const receipt = await launcher.start(
          { name: "a", script: "export default async () => ({})" },
          { kind: "local", user: "tester" },
        );
        expect(receipt.status).toBe("started");
        // Not process.argv[1]: that is the importing host's own script (here, the test runner).
        expect(argvs[0]?.[0]).toBe(fileURLToPath(new URL("../dist/cli.js", import.meta.url)));
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});
