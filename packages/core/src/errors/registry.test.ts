import { describe, expect, it } from "vitest";
import { SelfbuildingError, SelfbuildingUsageError } from "./base.js";
import { ERROR_CODES } from "./codes.js";
import { CLASSLESS_ERROR_CODES, ERROR_REGISTRY, SHARED_ERROR_CODES } from "./registry.js";

describe("error registry", () => {
  it("has one row per class name", () => {
    const names = ERROR_REGISTRY.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names every class after its constructor, ending in Error", () => {
    for (const row of ERROR_REGISTRY) {
      expect(row.ctor.name).toBe(row.name);
      expect(row.name).toMatch(/Error$/);
      expect(row.ctor.prototype).toBeInstanceOf(SelfbuildingError);
    }
  });

  it("puts usage errors under SelfbuildingUsageError and nothing else", () => {
    for (const row of ERROR_REGISTRY) {
      expect(row.ctor.prototype instanceof SelfbuildingUsageError, row.name).toBe(row.kind === "usage");
    }
  });

  it("covers every code with a class, except the classless ones", () => {
    const used = new Set(ERROR_REGISTRY.map((row) => row.code));
    for (const code of ERROR_CODES) {
      expect(used.has(code) !== CLASSLESS_ERROR_CODES.includes(code), code).toBe(true);
    }
  });

  it("shares a code between classes only where the spec does", () => {
    const counts = new Map<string, number>();
    for (const row of ERROR_REGISTRY) counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
    const shared = [...counts].filter(([, n]) => n > 1).map(([code]) => code);
    expect(shared.sort()).toEqual([...SHARED_ERROR_CODES].sort());
  });
});
