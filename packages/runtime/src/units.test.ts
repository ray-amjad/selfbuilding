import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AskResolution } from "@selfbuilding/core";
import { CALLBACK_SIGNATURE_HEADER, CALLBACK_KIND as HOOKS_KIND, signCallback as hooksSign } from "@selfbuilding/hooks";
import { afterEach, describe, expect, it } from "vitest";
import { EventSpool, lastSeqIn, MAX_EVENT_BYTES, readEventsAfter } from "./events.js";
import { writeExclusive } from "./fsutil.js";
import { LineSplitter } from "./lines.js";
import { acquireTurnLock, probeTurnLock } from "./lock.js";
import { Layout } from "./paths.js";
import { globToRegExp, matchesAny } from "./protect.js";
import { capBytes, REDACTED, Redactor } from "./redact.js";
import { StateStore } from "./state.js";
import { formatAnswer, readContained, wakeStatusFor } from "./supervisor.js";
import { parseArgs, parseDuration, RUNTIME_VERBS } from "./verbs.js";
import { CALLBACK_KIND, SIGNATURE_HEADER, signCallback } from "./wake.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbrt-unit-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("verbs", () => {
  it("match the runtime-host contract", () => {
    expect(RUNTIME_VERBS).toEqual(["launch", "supervise", "wait", "ack", "quiesce", "answer"]);
  });

  it("parse flags in both forms", () => {
    expect(parseArgs(["wait", "--call", "k", "--attempt=2", "--after", "5"])).toEqual({
      verb: "wait",
      flags: { call: "k", attempt: "2", after: "5" },
    });
  });

  it("parse durations", () => {
    expect(parseDuration("25s", 0)).toBe(25_000);
    expect(parseDuration("500ms", 0)).toBe(500);
    expect(parseDuration("2m", 0)).toBe(120_000);
    expect(parseDuration("1500", 0)).toBe(1500);
    expect(parseDuration(undefined, 7)).toBe(7);
    expect(() => parseDuration("soon", 0)).toThrow();
  });
});

describe("Layout", () => {
  it("prefixes canonical paths with the fs root, and leaves them alone in a real sandbox", () => {
    expect(new Layout("").toolSocket).toBe("/run/selfbuilding/tools.sock");
    const layout = new Layout("/tmp/box/");
    expect(layout.toolSocket).toBe("/tmp/box/run/selfbuilding/tools.sock");
    expect(layout.attempt("step", 2).outcome).toBe("/tmp/box/selfbuilding/state/calls/step/2/outcome.json");
    expect(layout.map("/selfbuilding/in/prompt.md")).toBe("/tmp/box/selfbuilding/in/prompt.md");
    expect(layout.map("/tmp/box/selfbuilding/x")).toBe("/tmp/box/selfbuilding/x");
    expect(layout.map("/usr/bin/node")).toBe("/usr/bin/node");
  });

  it("maps canonical paths inside commands at token boundaries only", () => {
    const layout = new Layout("/r");
    expect(layout.mapCommand("cat /selfbuilding/in/x > /tmp/y; ls /selfbuildingx /usr/tmp")).toBe(
      "cat /r/selfbuilding/in/x > /r/tmp/y; ls /selfbuildingx /usr/tmp",
    );
    expect(new Layout("").mapCommand("cat /selfbuilding/in/x")).toBe("cat /selfbuilding/in/x");
  });
});

describe("Redactor", () => {
  it("replaces exact secret values longest first, and known token shapes", () => {
    const r = new Redactor(["supersecretvalue1", "supersecretvalue1-extended"]);
    expect(r.text("a supersecretvalue1-extended b supersecretvalue1")).toBe(`a ${REDACTED} b ${REDACTED}`);
    expect(r.text("Authorization: Bearer abcdefghijklmnop")).toBe(`Authorization: ${REDACTED}`);
    expect(r.text("token ghp_0123456789abcdefghijABCDEFGHIJ")).toBe(`token ${REDACTED}`);
    expect(r.text("key sk-ant-0123456789abcdefghij")).toBe(`key ${REDACTED}`);
  });

  it("ignores short values and values with whitespace, and takes secret-looking env names", () => {
    const r = new Redactor(["short", "has a space in it"]);
    r.addEnv({
      GITHUB_TOKEN: "tok-0123456789abcdef",
      REPO_URL: "https://example.com/abcdefghijk",
      HOME: "/home/someone-long",
    });
    expect(r.text("short has a space in it")).toBe("short has a space in it");
    expect(r.text("tok-0123456789abcdef https://example.com/abcdefghijk")).toBe(
      `${REDACTED} https://example.com/abcdefghijk`,
    );
  });

  it("redacts nested values", () => {
    const r = new Redactor(["supersecretvalue1"]);
    expect(r.value({ a: ["x supersecretvalue1"], n: 1 })).toEqual({ a: [`x ${REDACTED}`], n: 1 });
  });

  it("caps text by UTF-8 bytes", () => {
    expect(capBytes("héllo", 3)).toEqual({ text: "hé", truncatedBytes: 3 });
    expect(capBytes("abc", 10)).toEqual({ text: "abc", truncatedBytes: 0 });
  });
});

describe("LineSplitter", () => {
  it("splits on \\n only, across chunks, keeping U+2028 inside a line", () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    s.push(Buffer.from('{"a":"x y"}\n{"b"'));
    s.push(Buffer.from(":1}\r\nlast"));
    s.end();
    expect(lines).toEqual(['{"a":"x y"}', '{"b":1}', "last"]);
  });

  it("drops lines over the cap and reports them", () => {
    const lines: string[] = [];
    const dropped: number[] = [];
    const s = new LineSplitter(
      (l) => lines.push(l),
      (n) => dropped.push(n),
      10,
    );
    s.push(Buffer.from("0123456789ABCDEF\nok\n"));
    expect(lines).toEqual(["ok"]);
    expect(dropped).toEqual([16]);
  });
});

describe("EventSpool", () => {
  const ctx = { runId: "run", callPath: "root/a", launchId: "k_e1_l1", attempt: 1 };

  it("numbers events monotonically, continues after a restart and redacts", () => {
    const file = path.join(tmp(), "events.jsonl");
    const redactor = new Redactor(["supersecretvalue1"]);
    const spool = new EventSpool(file, ctx, redactor);
    spool.emit("a", { text: "supersecretvalue1" });
    spool.emit("b", undefined, { level: "warn", turnIndex: 2, sessionId: "s" });
    fs.appendFileSync(file, '{"seq":3,"torn');
    expect(lastSeqIn(file)).toBe(2);
    const again = new EventSpool(file, ctx, redactor);
    again.emit("c");
    const { events, lastSeq } = readEventsAfter(file, 1, 1_000_000);
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [2, "b"],
      [3, "c"],
    ]);
    expect(lastSeq).toBe(3);
    const first = readEventsAfter(file, 0, 1_000_000).events[0];
    expect(first?.data).toEqual({ text: REDACTED });
    expect(first).toMatchObject({ v: 1, runId: "run", traceId: "run", callPath: "root/a", level: "info" });
    expect(events[0]).toMatchObject({ turnIndex: 2, sessionId: "s", level: "warn" });
  });

  it("caps every line at 16 KiB", () => {
    const file = path.join(tmp(), "events.jsonl");
    const spool = new EventSpool(file, ctx, new Redactor());
    spool.emit("big", { output: "x".repeat(100_000), list: Array.from({ length: 500 }, (_, i) => `item-${i}`) });
    const line = fs.readFileSync(file, "utf8").trim();
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(JSON.parse(line).data.truncated).toBe(true);
  });

  it("pages reads by byte budget", () => {
    const file = path.join(tmp(), "events.jsonl");
    const spool = new EventSpool(file, ctx, new Redactor());
    for (let i = 0; i < 10; i++) spool.emit("e", { i });
    const page = readEventsAfter(file, 0, 600);
    expect(page.more).toBe(true);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.lastSeq).toBe(page.events.at(-1)?.seq);
  });
});

describe("StateStore", () => {
  it("pauses the active-time clock while waiting and carries askSeq across launches", () => {
    const root = tmp();
    const layout = new Layout(root);
    const attempt = layout.attempt("k", 1);
    let now = 1_000;
    const store = new StateStore(layout, attempt, "k_e1_l1", () => now);
    store.update({ askSeq: 2, sessionId: "s1" });
    now += 500;
    expect(store.activeMs()).toBe(500);
    store.pauseClock();
    now += 10_000;
    expect(store.activeMs()).toBe(500);
    store.resumeClock();
    now += 100;
    store.update({ phase: "running" });
    expect(store.value.clock.activeMs).toBe(600);
    const status = JSON.parse(fs.readFileSync(layout.launchStatus("k_e1_l1"), "utf8"));
    expect(status).toMatchObject({ launchId: "k_e1_l1", state: "running", hasOutcome: false, pendingAsk: false });

    const next = new StateStore(layout, attempt, "k_e1_l2", () => now);
    expect(next.value).toMatchObject({ askSeq: 2, sessionId: "s1", launchId: "k_e1_l2", phase: "booting" });
    expect(next.value.clock.activeMs).toBe(600);
  });
});

describe("turn lock", () => {
  it("is exclusive, probes BUSY while held and FREE after release", async () => {
    const lock = path.join(tmp(), "run", "call.lock");
    expect(probeTurnLock(lock)).toBe("FREE");
    const held = await acquireTurnLock(lock);
    expect(held).not.toBeNull();
    expect(probeTurnLock(lock)).toBe("BUSY");
    expect(await acquireTurnLock(lock)).toBeNull();
    await held?.release();
    expect(probeTurnLock(lock)).toBe("FREE");
    const again = await acquireTurnLock(lock);
    expect(again).not.toBeNull();
    await again?.release();
  });
});

describe("files", () => {
  it("creates a file exclusively, once", () => {
    const file = path.join(tmp(), "outcome.json");
    expect(writeExclusive(file, "first")).toBe(true);
    expect(writeExclusive(file, "second")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("first");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["outcome.json"]);
  });
});

describe("protected path globs", () => {
  it("match from the repo root, with ** spanning directories", () => {
    expect(matchesAny("package.json", ["**/package.json"])).toBe(true);
    expect(matchesAny("packages/a/package.json", ["**/package.json"])).toBe(true);
    expect(matchesAny("vitest.config.ts", ["vitest.config.*"])).toBe(true);
    expect(matchesAny("pkg/vitest.config.ts", ["vitest.config.*"])).toBe(false);
    expect(matchesAny(".github/workflows/ci.yml", [".github/workflows/**"])).toBe(true);
    expect(matchesAny(".mocharc.json", [".mocharc*"])).toBe(true);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
  });
});

describe("answers and wakes", () => {
  const base = { askId: "ask_1", choiceId: null, answeredAt: "2026-01-01T00:00:00Z" };

  it("formats answers the way the model reads them", () => {
    const choice: AskResolution = {
      ...base,
      answer: { kind: "choice", choiceId: "hold" },
      choiceId: "hold",
      answeredBy: { kind: "human", channel: "slack", userId: "U1", displayName: "alice" },
    };
    expect(formatAnswer(choice, { question: "q", choices: [{ id: "hold", label: "Hold" }] })).toBe(
      'Answer from @alice via Slack: choice "hold" (Hold).',
    );
    const fallback: AskResolution = {
      ...base,
      answer: { kind: "choice", choiceId: "hold" },
      answeredBy: { kind: "default", reason: "timeout" },
    };
    expect(formatAnswer(fallback, { question: "q", choices: ["hold"] })).toBe(
      'No human answered (timeout); proceeding with the default: choice "hold".',
    );
    const value: AskResolution = {
      ...base,
      answer: { kind: "value", value: { n: 1 } },
      answeredBy: { kind: "auto", model: "m", rationale: "r" },
    };
    expect(formatAnswer(value, undefined)).toBe('Answered automatically by m: {"n":1}. Rationale: r');
  });

  it("maps outcomes to callback statuses", () => {
    expect(wakeStatusFor("succeeded")).toBe("submitted");
    expect(wakeStatusFor("failed", "no_result")).toBe("no_result");
    expect(wakeStatusFor("failed", "boot")).toBe("failed");
    expect(wakeStatusFor("timed_out")).toBe("timeout");
    expect(wakeStatusFor("cancelled")).toBe("stopped");
  });

  it("signs callbacks over kind and body", () => {
    const a = signCallback("token-1234567890", "agent.callback", "{}");
    expect(a).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(signCallback("token-1234567890", "other.kind", "{}")).not.toBe(a);
  });

  it("signs the way the callback handler verifies", () => {
    const body = JSON.stringify({ v: 1, launchId: "k_e0_l0", rearm: 0, status: "submitted" });
    expect(signCallback("token-1234567890", CALLBACK_KIND, body)).toBe(hooksSign("token-1234567890", body));
    expect([SIGNATURE_HEADER, CALLBACK_KIND]).toEqual([CALLBACK_SIGNATURE_HEADER, HOOKS_KIND]);
  });
});

describe("readContained", () => {
  it("reads a plain file under the root and refuses symlinks, a swapped parent directory and oversized files", () => {
    const base = fs.realpathSync(tmp());
    const root = path.join(base, "files");
    const outside = path.join(base, "secret");
    fs.mkdirSync(path.join(root, "dir"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "key"), "root-only");
    fs.writeFileSync(path.join(root, "dir", "ok.txt"), "hello");
    expect(readContained(path.join(root, "dir", "ok.txt"), root, 100, 100)?.toString()).toBe("hello");
    // A final symlink is never followed.
    fs.symlinkSync(path.join(outside, "key"), path.join(root, "link.txt"));
    expect(readContained(path.join(root, "link.txt"), root, 100, 100)).toBeNull();
    // A directory swapped for a symlink after it was listed: the opened file is outside the root.
    fs.symlinkSync(outside, path.join(root, "swapped"));
    expect(readContained(path.join(root, "swapped", "key"), root, 100, 100)).toBeNull();
    expect(readContained(path.join(root, "dir", "ok.txt"), root, 4, 100)).toBe("skip");
    expect(readContained(path.join(root, "dir", "ok.txt"), root, 100, 4)).toBe("skip");
    expect(readContained(path.join(root, "missing"), root, 100, 100)).toBeNull();
  });
});
