import type { HostAgentCall } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { agentChildKey, agentRegistryName } from "./keys.js";

const call = (over: Partial<HostAgentCall> = {}): HostAgentCall => ({
  runId: "ns_k",
  epoch: 0,
  stepKey: "step1",
  callPath: "One#0",
  launch: 0,
  spec: null,
  ...over,
});

describe("agent child keys", () => {
  it("launch 0 uses the step's key", () => {
    expect(agentChildKey(call())).toBe("ns:ns_k:step1:e0");
    expect(agentRegistryName(call())).toBe("step1");
  });

  it("a later launch gets its own child even when re-dispatched without its resume payload", () => {
    const withResume = call({ launch: 1, resume: { message: "fix it", sessionId: "s" } });
    const replayed = call({ launch: 1 });
    expect(agentChildKey(replayed)).toBe("ns:ns_k:step1:e0:l1");
    expect(agentChildKey(replayed)).toBe(agentChildKey(withResume));
    expect(agentRegistryName(replayed)).toBe("step1_l1");
    expect(agentChildKey(replayed)).not.toBe(agentChildKey(call()));
  });
});
