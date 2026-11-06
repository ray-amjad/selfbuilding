import { BROWSER_MCP_SERVER } from "@selfbuilding/images";
import { describe, expect, it } from "vitest";
import { VERIFY_BROWSER_SERVER, verifyContract } from "./contracts.js";

// release-prep §7.2 #8: this package keeps its own copy of the browser server (it does not depend on the images
// package at run time), so a change to either copy must fail here until the other follows.

describe("Verify's browser server", () => {
  it("deep-equals the BROWSER_MCP_SERVER @selfbuilding/images exports", () => {
    expect(VERIFY_BROWSER_SERVER).toStrictEqual({ ...BROWSER_MCP_SERVER });
    expect(verifyContract.defaults.mcpServers).toEqual([BROWSER_MCP_SERVER]);
  });
});
