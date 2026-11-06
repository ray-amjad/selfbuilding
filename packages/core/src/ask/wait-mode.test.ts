import { describe, expect, it } from "vitest";
import { hotLimitMs, selectWaitMode } from "./wait-mode.js";

const MIN = 60_000;
const H = 60 * MIN;

describe("hotLimitMs", () => {
  it("is min(hotWait, mcpToolTimeoutMs - 15 s), with null meaning no harness limit", () => {
    expect(hotLimitMs(10 * MIN, null)).toBe(10 * MIN);
    expect(hotLimitMs(10 * MIN, 12 * MIN)).toBe(10 * MIN);
    expect(hotLimitMs(10 * MIN, 60_000)).toBe(45_000);
    expect(hotLimitMs(10 * MIN, 10_000)).toBe(0);
  });
});

describe("selectWaitMode", () => {
  const base = { hotWaitMs: 10 * MIN, mcpToolTimeoutMs: 12 * MIN, askTimeoutMs: 4 * H, canResume: true };

  it("waits hot first, then continues cold when the ask can outlive the hot window", () => {
    expect(selectWaitMode(base)).toEqual({ mode: "hot", hotMs: 10 * MIN, afterHot: "cold" });
  });

  it("stays hot for the whole ask when its timeout fits in the window", () => {
    expect(selectWaitMode({ ...base, askTimeoutMs: 5 * MIN })).toEqual({
      mode: "hot",
      hotMs: 5 * MIN,
      afterHot: "policy",
    });
  });

  it("goes cold at once when the hot limit is under 30 s", () => {
    expect(selectWaitMode({ ...base, mcpToolTimeoutMs: 40_000 })).toEqual({ mode: "cold", hotMs: 0, afterHot: "cold" });
  });

  it("applies the policy at once when the limit is under 30 s and the harness cannot resume", () => {
    expect(selectWaitMode({ ...base, mcpToolTimeoutMs: 40_000, canResume: false })).toEqual({
      mode: "policy",
      hotMs: 0,
      afterHot: "policy",
    });
  });

  it("gives a harness without resume() hot waits only", () => {
    expect(selectWaitMode({ ...base, canResume: false })).toEqual({ mode: "hot", hotMs: 10 * MIN, afterHot: "policy" });
  });

  it("keeps shared handles hot-only, capped at 30 minutes and the harness limit", () => {
    expect(selectWaitMode({ ...base, hotWaitMs: 2 * H, mcpToolTimeoutMs: null, sharedHandle: true })).toEqual({
      mode: "hot",
      hotMs: 30 * MIN,
      afterHot: "policy",
    });
    expect(selectWaitMode({ ...base, sharedHandle: true })).toEqual({
      mode: "hot",
      hotMs: 10 * MIN,
      afterHot: "policy",
    });
    expect(selectWaitMode({ ...base, mcpToolTimeoutMs: 40_000, sharedHandle: true }).mode).toBe("policy");
  });

  it("uses the harness's 60 s default tool timeout correctly", () => {
    expect(selectWaitMode({ ...base, mcpToolTimeoutMs: 60_000 })).toEqual({
      mode: "hot",
      hotMs: 45_000,
      afterHot: "cold",
    });
  });
});
