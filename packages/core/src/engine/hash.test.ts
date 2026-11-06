import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors/classes.js";
import { computeStepKey } from "./calls.js";
import { base32Lower, canonicalJson, formatUuidV4, randomBytes, sha256Hex, ulid } from "./hash.js";

describe("sha256Hex", () => {
  it("matches node:crypto on known vectors and odd lengths", () => {
    const inputs = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "héllo wörld ✓", "x".repeat(10_000)];
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input).digest("hex"));
    }
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes bytes", () => {
    const bytes = randomBytes(1000);
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("base32Lower", () => {
  it("encodes RFC 4648 test vectors in lowercase without padding", () => {
    const enc = (s: string) => base32Lower(new TextEncoder().encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("my");
    expect(enc("fo")).toBe("mzxq");
    expect(enc("foobar")).toBe("mzxw6ytboi");
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined, "x"], c: null }, e: undefined })).toBe(
      '{"a":{"c":null,"d":[1,null,"x"]},"b":1}',
    );
  });

  it("refuses values a resume could not reproduce", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(ConfigError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(ConfigError);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(/circular/);
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { x: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"x":1},{"x":1}]');
  });
});

describe("ids", () => {
  it("makes 26-character lowercase ULIDs that sort by time", () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
    expect(a < b).toBe(true);
  });

  it("formats version 4 UUIDs", () => {
    expect(formatUuidV4(randomBytes(16))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("derives a 26-character base32 step key that changes with every identity field", () => {
    const base = { callPath: "CodeReview#0", chain: "", target: "skill-hash", input: { a: 1 }, refresh: null };
    const key = computeStepKey(base);
    expect(key).toMatch(/^[a-z2-7]{26}$/);
    expect(computeStepKey({ ...base })).toBe(key);
    expect(computeStepKey({ ...base, input: { a: 2 } })).not.toBe(key);
    expect(computeStepKey({ ...base, chain: "x" })).not.toBe(key);
    expect(computeStepKey({ ...base, callPath: "CodeReview#1" })).not.toBe(key);
    expect(computeStepKey({ ...base, refresh: "resume-1" })).not.toBe(key);
    expect(computeStepKey({ ...base, schema: { type: "object" } })).not.toBe(key);
  });
});
