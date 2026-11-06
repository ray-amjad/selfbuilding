import { describe, expect, it } from "vitest";
import { type CallState, resumableSession, setSession } from "./lifecycle.js";

// A harness keeps its session transcript inside the box, so a follow-up may resume a session only in the box it ran
// in. Found live: a shared box disposed after a failed run was reopened on resume, and `--resume` found no session.
const box = (id: string) => ({ ref: { id } }) as unknown as NonNullable<CallState["box"]>;
const state = (over: Partial<CallState> = {}) =>
  ({ plan: { harness: { resume: () => ({}) } }, ...over }) as unknown as CallState;

describe("resumableSession", () => {
  it("resumes a session in the box that started it", () => {
    const s = state({ box: box("a") });
    setSession(s, "sess-1");
    expect(s.sessionBoxId).toBe("a");
    expect(resumableSession(s)).toBe("sess-1");
  });

  it("does not resume a session whose box was replaced", () => {
    const s = state({ box: box("a") });
    setSession(s, "sess-1");
    s.box = box("b");
    expect(resumableSession(s)).toBeUndefined();
  });

  it("keeps the old behaviour when the session's box is unknown, and never resumes without harness support", () => {
    expect(resumableSession(state({ box: box("a"), sessionId: "sess-1" }))).toBe("sess-1");
    const noResume = state({ box: box("a"), sessionId: "sess-1" });
    (noResume.plan.harness as { resume?: unknown }).resume = undefined;
    expect(resumableSession(noResume)).toBeUndefined();
  });
});
