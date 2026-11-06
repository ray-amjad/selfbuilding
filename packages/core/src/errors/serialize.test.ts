import { describe, expect, it } from "vitest";
import { SelfbuildingError } from "./base.js";
import {
  AgentInterruptedError,
  BudgetExceededError,
  ConfigError,
  NoActiveRunError,
  SandboxCapDeadlockError,
  SandboxUnavailableError,
} from "./classes.js";
import { ERROR_REGISTRY } from "./registry.js";
import { deserializeError, isSelfbuildingError, isUsageError, serializeThrown } from "./serialize.js";

describe("error serialisation", () => {
  it("round-trips class, code, kind, recovery and class fields", () => {
    const original = new BudgetExceededError(
      { phase: "running" },
      { runId: "r1", callPath: "A#0", recovery: { branch: "selfbuilding/r1/a-0", sessionId: "s1" } },
    );
    const back = deserializeError(JSON.parse(JSON.stringify(original)));
    expect(back).toBeInstanceOf(BudgetExceededError);
    expect(back).toBeInstanceOf(SelfbuildingError);
    expect(back).toMatchObject({
      name: "BudgetExceededError",
      code: "budget",
      kind: "agent",
      retryable: false,
      runId: "r1",
      callPath: "A#0",
      phase: "running",
      recovery: { branch: "selfbuilding/r1/a-0", sessionId: "s1" },
    });
    expect(back.toJSON()).toEqual(original.toJSON());
  });

  it("keeps usage errors usage errors", () => {
    const back = deserializeError(new NoActiveRunError({ primitive: "step" }).toJSON());
    expect(isUsageError(back)).toBe(true);
    expect(back.kind).toBe("usage");
    const deadlock = deserializeError(new SandboxCapDeadlockError({ holders: ["a"], waiters: ["b"] }).toJSON());
    expect(deadlock).toMatchObject({ holders: ["a"], waiters: ["b"] });
  });

  it("round-trips every registered class by name", () => {
    for (const row of ERROR_REGISTRY) {
      const json = { name: row.name, code: row.code, kind: row.kind, retryable: false, message: "m" };
      const back = deserializeError(json);
      expect(back, row.name).toBeInstanceOf(row.ctor);
      expect(back.code).toBe(row.code);
    }
  });

  it("falls back to the class for the code when the name is unknown", () => {
    const back = deserializeError({
      name: "FutureError",
      code: "interrupted",
      kind: "agent",
      retryable: false,
      message: "m",
    });
    expect(back).toBeInstanceOf(AgentInterruptedError);
  });

  it("serialises any thrown value", () => {
    expect(serializeThrown(new SandboxUnavailableError({ provider: "p" }))).toMatchObject({
      code: "sandbox_unavailable",
    });
    expect(serializeThrown(new TypeError("t"))).toEqual({ name: "TypeError", message: "t" });
    expect(serializeThrown("plain")).toEqual({ name: "Error", message: "plain" });
    expect(isSelfbuildingError(new ConfigError("x"))).toBe(true);
    expect(isSelfbuildingError(new Error("x"))).toBe(false);
  });
});
