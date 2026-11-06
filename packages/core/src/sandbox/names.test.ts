import { describe, expect, it } from "vitest";
import { base32, canonicalJson, durationMs, stableUuid } from "./hash.js";
import { branchName, checkpointRef, isAllowedPushRef, sandboxName, wipRef } from "./names.js";

describe("sandbox names", () => {
  it("derives a stable ns- name of 23 chars from runId and scope", () => {
    const a = sandboxName({ runId: "ns_1", scope: "ImplementSpec#0", deployment: "prod" });
    expect(a).toMatch(/^ns-[a-z2-7]{20}$/);
    expect(sandboxName({ runId: "ns_1", scope: "ImplementSpec#0", deployment: "other" })).toBe(a);
    expect(sandboxName({ runId: "ns_1", scope: "ImplementSpec#1", deployment: "prod" })).not.toBe(a);
  });

  it("slugs callPaths into branch names", () => {
    expect(branchName("ns_abc", "pipeline#0/[issue-412]/stage#1/ImplementSpec#0")).toBe(
      "selfbuilding/ns_abc/pipeline-0-issue-412-stage-1-implementspec-0",
    );
    expect(branchName("ns_abc", "root/work")).toBe("selfbuilding/ns_abc/work");
  });

  it("shortens long slugs with a hash suffix", () => {
    const long = `parallel#0/${"[very-long-item-key]/".repeat(6)}CodeReview#0`;
    const name = branchName("r", long);
    const slug = name.slice("selfbuilding/r/".length);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toMatch(/-[0-9a-f]{6}$/);
    expect(branchName("r", long)).toBe(name);
  });

  it("builds checkpoint and wip refs", () => {
    expect(checkpointRef("ns_x", "Work Box", 3)).toBe("refs/selfbuilding/ns_x/work-box/3");
    expect(wipRef("ns_x", "abc")).toBe("refs/selfbuilding/wip/ns_x/abc");
  });

  it("allows pushes only to selfbuilding refs and the allowlist", () => {
    expect(isAllowedPushRef("selfbuilding/r/x")).toBe(true);
    expect(isAllowedPushRef("refs/selfbuilding/r/box/1")).toBe(true);
    expect(isAllowedPushRef("main")).toBe(false);
    expect(isAllowedPushRef("refs/heads/release/1", ["release/**"])).toBe(true);
    expect(isAllowedPushRef("feature", ["feature"])).toBe(true);
  });
});

describe("hash helpers", () => {
  it("encodes base32 per RFC 4648, lowercase", () => {
    expect(base32(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
  });

  it("sorts keys in canonical JSON and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
  });

  it("makes version-5-shaped stable uuids", () => {
    const u = stableUuid("x");
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableUuid("x")).toBe(u);
  });

  it("parses durations", () => {
    expect(durationMs("45m", 0)).toBe(2_700_000);
    expect(durationMs("2h", 0)).toBe(7_200_000);
    expect(durationMs(500, 0)).toBe(500);
    expect(durationMs(undefined, 7)).toBe(7);
  });
});
