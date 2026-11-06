import { describe, expect, it } from "vitest";
import { cli } from "../test/helpers.js";
import { parseCommandArgs, parseDuration } from "./args.js";
import { formatEvent } from "./events.js";
import { EXIT, exitForStatus } from "./exit.js";
import { COMMANDS, main } from "./main.js";
import { assertRunId, newRunId, RUN_ID_PATTERN, ulid } from "./state.js";

describe("selfbuilding CLI", () => {
  it("rejects unknown commands with the usage exit code", async () => {
    expect(await main(["nope"], { stderr: { write: () => true } })).toBe(EXIT.usage);
  });

  it("prints usage to stderr and exits 2 with no command, and exits 0 for --help", async () => {
    const none = await cli([]);
    expect(none.code).toBe(EXIT.usage);
    expect(none.stderr).toContain("Usage: selfbuilding <command>");
    const help = await cli(["--help"]);
    expect(help.code).toBe(EXIT.ok);
    expect(help.stdout).toContain("Exit codes:");
  });

  it("has help for every command", async () => {
    for (const command of COMMANDS) {
      const r = await cli([command, "--help"]);
      expect(r.code).toBe(EXIT.ok);
      expect(r.stdout).toContain(`selfbuilding ${command}`);
    }
  });

  it("turns an unknown flag into a usage error that names the command", async () => {
    const r = await cli(["watch", "run-1", "--bogus"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("selfbuilding watch");
    expect(r.stderr).toContain("--bogus");
  });

  it("checks the number of positional arguments", async () => {
    const r = await cli(["resume"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("takes 1 argument");
  });
});

describe("exit codes", () => {
  it("maps every run status to the spec's exit code", () => {
    expect(exitForStatus("ok")).toBe(0);
    expect(exitForStatus("failed")).toBe(1);
    expect(exitForStatus("partial")).toBe(3);
    expect(exitForStatus("budget_exhausted")).toBe(4);
    expect(exitForStatus("needs_attention")).toBe(5);
    expect(exitForStatus("waiting")).toBe(6);
    expect(exitForStatus("aborted")).toBe(7);
    expect(EXIT.interrupted).toBe(130);
  });
});

describe("argument helpers", () => {
  it("parses repeatable and boolean flags", () => {
    const args = parseCommandArgs(
      "x",
      ["a", "--tag", "1", "--tag", "2", "--yes"],
      { tag: { type: "string", multiple: true }, yes: { type: "boolean" } },
      { min: 1, max: 1 },
    );
    expect(args.positionals).toEqual(["a"]);
    expect(args.list("tag")).toEqual(["1", "2"]);
    expect(args.bool("yes")).toBe(true);
    expect(args.str("missing")).toBeUndefined();
  });

  it("parses durations", () => {
    expect(parseDuration("--every", "2m")).toBe(120_000);
    expect(parseDuration("--every", "30s")).toBe(30_000);
    expect(parseDuration("--every", "1500")).toBe(1500);
    expect(parseDuration("--every", "1h")).toBe(3_600_000);
    expect(() => parseDuration("--every", "soon")).toThrow(/--every "soon" is not a duration/);
    expect(() => parseDuration("--every", "0s")).toThrow(/greater than zero/);
  });
});

describe("run ids", () => {
  it("mints sortable ids that are valid on every host", () => {
    const id = newRunId();
    expect(id).toMatch(/^ns_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(RUN_ID_PATTERN.test(id)).toBe(true);
    expect(ulid(1000) < ulid(2000)).toBe(true);
  });

  it("rejects ids a host would refuse", () => {
    expect(() => assertRunId("-leading")).toThrow(/not valid/);
    expect(() => assertRunId("has space")).toThrow(/not valid/);
    expect(() => assertRunId("x".repeat(101))).toThrow(/not valid/);
    expect(assertRunId("ship-2026-11-01")).toBe("ship-2026-11-01");
  });
});

describe("event rendering", () => {
  const base = {
    v: 1 as const,
    runId: "r",
    callPath: "review",
    launchId: "l",
    attempt: 1,
    seq: 0,
    ts: "2026-11-01T12:34:56.000Z",
    traceId: "r",
    level: "info" as const,
  };

  it("renders the events a person watching cares about", () => {
    expect(formatEvent({ ...base, type: "phase", data: { name: "build" } })).toBe("12:34:56 review ▸ phase build");
    expect(formatEvent({ ...base, type: "ask.created", data: { ordinal: 1, question: "Merge?" } })).toContain(
      "ask #1: Merge?",
    );
    expect(formatEvent({ ...base, callPath: "run", type: "run.end", data: { status: "ok", usd: 1.5 } })).toBe(
      "12:34:56 ■ run ok $1.50",
    );
    expect(formatEvent({ ...base, type: "harness.tool.started", data: { name: "Bash" } })).toContain("tool Bash");
    expect(formatEvent({ ...base, type: "agent.started", data: { agent: "Verify" } })).toBe(
      "12:34:56 review ● agent started Verify",
    );
    expect(formatEvent({ ...base, type: "agent.finished", data: { usage: { usd: 0.25 } } })).toBe(
      "12:34:56 review ● agent finished $0.2500",
    );
  });

  it("shows warnings and errors and hides debug chatter", () => {
    expect(
      formatEvent({ ...base, type: "sandbox.pause_refused", level: "error", data: { message: "nope" } }),
    ).toContain("ERROR sandbox.pause_refused nope");
    expect(formatEvent({ ...base, type: "harness.raw", level: "debug" })).toBeNull();
  });
});
