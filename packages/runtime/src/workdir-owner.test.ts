import { describe, expect, it } from "vitest";
import { workdirChownArgs } from "./boot.js";

// Found live: on a fresh box the root runtime's clone left every repo file root-owned 0644, so the agent (uid 1000)
// could not edit or commit. A writable call now gives the tree to the workdir's owner.
describe("workdirChownArgs", () => {
  const agentOwned = { uid: 1000, gid: 1000 };
  it("gives a writable call's tree, .git included, to the agent when the runtime is root", () => {
    expect(workdirChownArgs("/selfbuilding/work", false, agentOwned, 0)).toEqual([
      "-R",
      "-h",
      "1000:1000",
      "/selfbuilding/work",
    ]);
  });

  it("leaves a read-only call's tree root-owned, so a reviewer cannot edit it", () => {
    expect(workdirChownArgs("/selfbuilding/work", true, agentOwned, 0)).toBeNull();
  });

  it("does nothing when the runtime is not root or the workdir is root's", () => {
    expect(workdirChownArgs("/w", false, agentOwned, 1000)).toBeNull();
    expect(workdirChownArgs("/w", false, { uid: 0, gid: 0 }, 0)).toBeNull();
  });
});
