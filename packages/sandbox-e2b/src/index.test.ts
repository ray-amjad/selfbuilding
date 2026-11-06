import { describe, expect, it } from "vitest";
import { e2b } from "./index.js";

describe("@selfbuilding/sandbox-e2b", () => {
  it("exports e2b", () => {
    expect(e2b).toBeTypeOf("function");
  });
});
