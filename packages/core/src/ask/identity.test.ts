import { describe, expect, it } from "vitest";
import { durationToMs, formatDuration } from "./duration.js";
import { base32, canonicalJson, computeSpecHash, deriveAskId } from "./identity.js";

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("rejects values JSON cannot carry", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/finite/);
    expect(() => canonicalJson(10n)).toThrow(/bigint/);
  });
});

describe("base32", () => {
  it("matches the RFC 4648 vectors, lowercase and unpadded", () => {
    const enc = (s: string) => base32(new TextEncoder().encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("my");
    expect(enc("foob")).toBe("mzxw6yq");
    expect(enc("foobar")).toBe("mzxw6ytboi");
  });
});

describe("ask identity", () => {
  const base = { runId: "run-1", callPath: "ImplementSpec#0", askSeq: 0, specHash: "abc" };

  it("is 24 chars of [a-z0-9_] starting with ask_", async () => {
    const id = await deriveAskId(base);
    expect(id).toMatch(/^ask_[a-z2-7]{20}$/);
    expect(id).toHaveLength(24);
  });

  it("is stable for a factory ask and changes with every identity part", async () => {
    const id = await deriveAskId(base);
    expect(await deriveAskId({ ...base })).toBe(id);
    const variants = await Promise.all([
      deriveAskId({ ...base, runId: "run-2" }),
      deriveAskId({ ...base, callPath: "Verify#0" }),
      deriveAskId({ ...base, askSeq: 1 }),
      deriveAskId({ ...base, specHash: "abd" }),
      deriveAskId({ ...base, launchId: "k_e0_l1" }),
      deriveAskId({ ...base, collision: 1 }),
    ]);
    expect(new Set([id, ...variants]).size).toBe(7);
  });

  it("binds an agent ask to its launch", async () => {
    const a = await deriveAskId({ ...base, launchId: "k_e0_l1" });
    const b = await deriveAskId({ ...base, launchId: "k_e0_l2" });
    expect(a).not.toBe(b);
  });

  it("hashes the spec without timeout, onTimeout and dedupeKey", async () => {
    const h = await computeSpecHash({ question: "Merge?", choices: ["yes", "no"] });
    expect(
      await computeSpecHash({ question: "Merge?", choices: ["yes", "no"], timeout: "1h", onTimeout: "fail" }),
    ).toBe(h);
    expect(await computeSpecHash({ question: "Merge?", choices: ["yes", "no"], dedupeKey: "k" })).toBe(h);
    expect(await computeSpecHash({ question: "Merge?", choices: ["no", "yes"] })).not.toBe(h);
    expect(await computeSpecHash({ question: "Merge?", choices: ["yes", "no"], risk: "high" })).not.toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("durations", () => {
  it("parses the public forms and rejects the rest", () => {
    expect(durationToMs("45s")).toBe(45_000);
    expect(durationToMs("10m")).toBe(600_000);
    expect(durationToMs("4h")).toBe(14_400_000);
    expect(durationToMs("1d")).toBe(86_400_000);
    expect(durationToMs("1.5h")).toBe(5_400_000);
    expect(durationToMs(1234)).toBe(1234);
    expect(durationToMs(undefined)).toBeNull();
    for (const bad of [0, -1, Number.NaN, "4 h", "4", "h", "4w"] as never[]) expect(durationToMs(bad)).toBeNull();
  });

  it("formats with the largest whole unit", () => {
    expect(formatDuration(14_400_000)).toBe("4h");
    expect(formatDuration(5_400_000)).toBe("90m");
    expect(formatDuration(86_400_000)).toBe("1d");
    expect(formatDuration(45_000)).toBe("45s");
  });
});
