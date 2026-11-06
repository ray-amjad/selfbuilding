import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, MissingSecretError, TimeoutOrderError } from "../errors/classes.js";
import { CONFIG_KEYS } from "../types/config.js";
import {
  checkTimeoutOrder,
  defineConfig,
  envSecretSource,
  firstDefined,
  fromEnv,
  fromFile,
  loadConfig,
  parseDuration,
  resolveSecret,
  validateConfig,
} from "./index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseDuration", () => {
  it("reads units and milliseconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("45m")).toBe(2_700_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration(250)).toBe(250);
  });

  it("names the option in the error", () => {
    expect(() => parseDuration("2 hours" as never, "budget.wallClock")).toThrow(/budget\.wallClock/);
    expect(() => parseDuration(-1)).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("finds selfbuilding.config.ts upward from cwd and stops at the repo root", async () => {
    await mkdir(join(dir, "repo", ".git"), { recursive: true });
    await mkdir(join(dir, "repo", "packages", "app"), { recursive: true });
    await writeFile(
      join(dir, "repo", "selfbuilding.config.ts"),
      `const deployment: string = "local-test";\nexport default { deployment, strict: true };\n`,
    );
    const config = await loadConfig({ cwd: join(dir, "repo", "packages", "app") });
    expect(config).toEqual({ deployment: "local-test", strict: true });
  });

  it("loads an explicit .mjs path", async () => {
    await writeFile(join(dir, "custom.mjs"), `export default { deployment: "ci-1" };\n`);
    expect(await loadConfig({ path: join(dir, "custom.mjs") })).toEqual({ deployment: "ci-1" });
  });

  it("refuses two config files in one directory", async () => {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, "selfbuilding.config.ts"), "export default {};\n");
    await writeFile(join(dir, "selfbuilding.config.mjs"), "export default {};\n");
    await expect(loadConfig({ cwd: dir })).rejects.toThrow(/more than one config file/);
  });

  it("explains a missing config and a bad default export", async () => {
    await mkdir(join(dir, ".git"));
    await expect(loadConfig({ cwd: dir })).rejects.toThrow(/selfbuilding init/);
    await writeFile(join(dir, "selfbuilding.config.mjs"), "export default 42;\n");
    await expect(loadConfig({ cwd: dir })).rejects.toThrow(/defineConfig/);
    await expect(loadConfig({ path: join(dir, "nope.ts") })).rejects.toThrow(/does not exist/);
  });

  it("wraps a throwing config module in ConfigError", async () => {
    await writeFile(join(dir, "broken.mjs"), "throw new Error('kaboom');\n");
    await expect(loadConfig({ path: join(dir, "broken.mjs") })).rejects.toThrow(/kaboom/);
  });
});

describe("secrets", () => {
  it("fromEnv reads the variable only when resolved", async () => {
    const secret = fromEnv("SB_TEST_SECRET_X");
    process.env.SB_TEST_SECRET_X = "value-1";
    try {
      expect(await resolveSecret(secret)).toBe("value-1");
    } finally {
      delete process.env.SB_TEST_SECRET_X;
    }
    await expect(resolveSecret(secret)).rejects.toBeInstanceOf(MissingSecretError);
  });

  it("fromFile needs an absolute path or file URL and strips one trailing newline", async () => {
    expect(() => fromFile("relative/token")).toThrow(ConfigError);
    const file = join(dir, "token");
    await writeFile(file, "abc123\n");
    expect(await resolveSecret(fromFile(file))).toBe("abc123");
    expect(await resolveSecret(fromFile(pathToFileURL(file).href))).toBe("abc123");
    await expect(resolveSecret(fromFile(join(dir, "missing")))).rejects.toBeInstanceOf(MissingSecretError);
  });

  it("envSecretSource resolves names and names the missing one", async () => {
    const source = envSecretSource({ A: "1", B: "2", EMPTY: "" });
    expect(await source.resolve(["A", "B"])).toEqual({ A: "1", B: "2" });
    await expect(source.resolve(["A", "C"])).rejects.toThrow(/^C is declared/);
    await expect(source.resolve(["EMPTY"])).rejects.toBeInstanceOf(MissingSecretError);
    expect(await resolveSecret("plain")).toBe("plain");
  });
});

describe("validateConfig", () => {
  it("accepts every documented key", () => {
    expect(() =>
      validateConfig(defineConfig({ deployment: "prod", strict: false, concurrency: { sandboxes: 2 } })),
    ).not.toThrow();
    expect(CONFIG_KEYS).toContain("controlPlane");
  });

  it("rejects unknown keys and bad values with the key named", () => {
    expect(() => validateConfig({ maxSandboxes: 3 } as never)).toThrow(/Unknown config key\(s\): maxSandboxes/);
    expect(() => validateConfig({ deployment: "Prod!" })).toThrow(/deployment/);
    expect(() => validateConfig({ concurrency: { sandboxes: 1.5 } })).toThrow(/sandboxes/);
    expect(() => validateConfig({ budget: { usd: -2 } })).toThrow(/budget\.usd/);
    expect(() => validateConfig({ budget: { wallClock: "soon" as never } })).toThrow(/wallClock/);
    expect(() => validateConfig({ timeouts: { idle: "x" as never } })).toThrow(/timeouts\.idle/);
    expect(() => validateConfig({ events: [1 as never] })).toThrow(/events/);
  });
});

describe("precedence and timeout order", () => {
  it("firstDefined never merges objects", () => {
    expect(firstDefined(undefined, { a: 1 }, { a: 2, b: 3 })).toEqual({ a: 1 });
    expect(firstDefined<number>(undefined, undefined)).toBeUndefined();
  });

  it("checks call timeout < provider lifetime < dead-run closer", () => {
    expect(() =>
      checkTimeoutOrder([
        { name: "timeout", ms: 60_000 },
        { name: "provider lifetime", ms: undefined },
        { name: "dead-run closer", ms: 120_000 },
      ]),
    ).not.toThrow();
    const error = (() => {
      try {
        checkTimeoutOrder([
          { name: "timeout", ms: 7_200_000 },
          { name: "provider lifetime", ms: 3_600_000 },
        ]);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(TimeoutOrderError);
    expect((error as TimeoutOrderError).first).toMatch(/timeout/);
  });
});
