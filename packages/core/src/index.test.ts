import { describe, expect, it } from "vitest";
import * as core from "./index.js";

describe("@selfbuilding/core", () => {
  it("lists every config key once", () => {
    expect(new Set(core.CONFIG_KEYS).size).toBe(core.CONFIG_KEYS.length);
    expect(core.CONFIG_KEYS).toContain("sandbox");
  });

  it("returns the config unchanged from defineConfig", () => {
    const config = { deployment: "test" };
    expect(core.defineConfig(config)).toBe(config);
  });

  it("builds factories that refuse to run outside run()", async () => {
    const f = core.factory({ name: "x", input: core.DefaultInput }, async () => null);
    expect(f.name).toBe("x");
    await expect(f({ task: "t" })).rejects.toBeInstanceOf(core.NoActiveRunError);
  });
});
