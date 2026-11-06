import type { StandardSchema } from "@selfbuilding/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cli,
  configSource,
  FACTORY_SOURCE,
  type FakeCore,
  fakeCore,
  jsonLines,
  type MemAskStore,
  makeProject,
  type TestProject,
} from "../../test/helpers.js";
import { EXIT } from "../exit.js";
import { statePaths } from "../project.js";
import { readRunRecord } from "../state.js";

let project: TestProject;
let core: FakeCore;
let asks: MemAskStore;

beforeEach(async () => {
  project = makeProject();
  project.write("selfbuilding.config.ts", configSource());
  project.write("factories/double.ts", FACTORY_SOURCE);
  core = fakeCore({ run: async () => ({ status: "waiting" }) });
  await cli(["run", "factories/double.ts", "--run-id", "r1"], { cwd: project.root, core });
  asks = core.journalFor(statePaths(project.root).journal).asks as MemAskStore;
  asks.add({
    askId: "ask_merge",
    runId: "r1",
    ordinal: 1,
    spec: {
      question: "Merge the PR?",
      choices: [{ id: "merge", label: "Merge it" }, { id: "hold", label: "Hold", safe: true }, "later"],
    },
  });
  asks.add({ askId: "ask_why", runId: "r1", ordinal: 2, spec: { question: "Why did the tests fail?" } });
});
afterEach(() => project.cleanup());

const answer = (...args: string[]) => cli(["answer", ...args], { cwd: project.root, core });

describe("selfbuilding answer", () => {
  it("lists a run's open asks when no ask is named", async () => {
    const r = await answer("r1");
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain(
      "#1 (ask_merge) review\n  Merge the PR?\n  Choices: merge (Merge it), hold (Hold), later.",
    );
    expect(r.stderr).toContain("#2 (ask_why)");
    expect(r.stderr).toContain("or any text");
    const json = await answer("r1", "--json");
    expect(jsonLines(json.stdout)[0]).toMatchObject([
      { askId: "ask_merge", ordinal: 1, choices: ["merge", "hold", "later"], freeText: false },
      { askId: "ask_why", ordinal: 2, choices: [], freeText: true },
    ]);
  });

  it("shows a parked ask, and says the session resumes with the answer after the host is gone", async () => {
    asks.add({
      askId: "ask_parked",
      runId: "r1",
      ordinal: 3,
      spec: { question: "Deploy now?", choices: ["yes", "no"] },
      cold: { since: "2026-11-02T10:00:00.000Z", sessionId: "sess_1" },
    });
    const list = await answer("r1");
    expect(list.stderr).toContain("#3 (ask_parked) review (parked since 2026-11-02T10:00:00.000Z)");
    const json = await answer("r1", "--json");
    expect(jsonLines(json.stdout)[0]).toContainEqual(
      expect.objectContaining({ askId: "ask_parked", parkedSince: "2026-11-02T10:00:00.000Z" }),
    );
    const r = await answer("r1", "#3", "yes");
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain("selfbuilding resume r1. Its box is parked and the session resumes with this answer.");
    expect(asks.records.get("ask_parked")).toMatchObject({ status: "answered", cold: { sessionId: "sess_1" } });
  });

  it("answers a choice by ordinal and records the CLI user", async () => {
    const r = await answer("r1", "#1", "hold");
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain("Answered ask #1.");
    expect(r.stderr).toContain("selfbuilding resume r1");
    const record = asks.records.get("ask_merge");
    expect(record?.status).toBe("answered");
    expect(record?.resolution).toMatchObject({
      askId: "ask_merge",
      answer: { kind: "choice", choiceId: "hold" },
      choiceId: "hold",
      answeredBy: { kind: "human", channel: "cli", userId: "tester", displayName: "Test User" },
    });
  });

  it("accepts a choice label, case-insensitively, and an ask id", async () => {
    const r = await answer("r1", "ask_merge", "merge IT");
    expect(r.code).toBe(EXIT.ok);
    expect(asks.records.get("ask_merge")?.resolution?.choiceId).toBe("merge");
  });

  it("takes free text when the ask allows it", async () => {
    const r = await answer("r1", "2", "flaky network", "--json");
    expect(r.code).toBe(EXIT.ok);
    expect(jsonLines(r.stdout)[0]).toMatchObject({ askId: "ask_why", resumeNeeded: true });
    expect(asks.records.get("ask_why")?.resolution?.answer).toEqual({ kind: "text", text: "flaky network" });
  });

  it("refuses text that is not a choice, and a missing answer", async () => {
    const wrong = await answer("r1", "#1", "ship it");
    expect(wrong.code).toBe(EXIT.usage);
    expect(wrong.stderr).toContain(
      '"ship it" is not a choice of ask #1. Choices: merge (Merge it), hold (Hold), later.',
    );
    const none = await answer("r1", "#1");
    expect(none.code).toBe(EXIT.usage);
    expect(none.stderr).toContain("needs an answer");
    expect(asks.records.get("ask_merge")?.status).toBe("open");
  });

  it("validates --value against the ask's form schema", async () => {
    const schema = z.object({ reviewers: z.number().int().min(1) }) as unknown as StandardSchema<unknown>;
    asks.add({
      askId: "ask_form",
      runId: "r1",
      ordinal: 3,
      spec: { question: "How many reviewers?", schema, freeText: false },
    });
    const bad = await answer("r1", "#3", "--value", '{"reviewers":0}');
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.stderr).toContain("does not fit ask #3's form: reviewers:");
    project.write("value.json", '{"reviewers":2}');
    const good = await answer("r1", "#3", "--value", "@value.json");
    expect(good.code).toBe(EXIT.ok);
    expect(asks.records.get("ask_form")?.resolution?.answer).toEqual({ kind: "value", value: { reviewers: 2 } });
    const noForm = await answer("r1", "#2", "--value", "{}");
    expect(noForm.stderr).toContain("has no form schema");
  });

  it("reports an ask that is already settled, and the loser of a race", async () => {
    await answer("r1", "#1", "merge");
    const again = await answer("r1", "ask_merge", "hold");
    expect(again.code).toBe(EXIT.failed);
    expect(again.stderr).toContain("Ask #1 is already answered by Test User via cli.");

    const original = asks.resolve.bind(asks);
    asks.resolve = async (askId, res) => {
      await original(askId, { ...res, answeredBy: { kind: "default", reason: "timeout" } });
      return original(askId, res);
    };
    const lost = await answer("r1", "#2", "anything");
    expect(lost.code).toBe(EXIT.failed);
    expect(lost.stderr).toContain("answered first by someone else by its default (timeout)");
  });

  it("refuses an ask from another run, or one that does not exist", async () => {
    asks.add({ askId: "elsewhere", runId: "r2", ordinal: 1, spec: { question: "?" } });
    const other = await answer("r1", "elsewhere", "x");
    expect(other.code).toBe(EXIT.usage);
    expect(other.stderr).toContain("Run r1 has no ask elsewhere");
    const missing = await answer("r1", "#9", "x");
    expect(missing.code).toBe(EXIT.usage);
  });

  it("does not ask for a resume while a process is still driving the run", async () => {
    let release: () => void = () => {};
    const live = fakeCore({
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ status: "ok" });
        }),
    });
    // Same journal directory, so share the ask store.
    live.journals.set(statePaths(project.root).journal, core.journalFor(statePaths(project.root).journal));
    const running = cli(["run", "factories/double.ts", "--run-id", "r1"], { cwd: project.root, core: live });
    while (!readRunRecord(statePaths(project.root), "r1")?.pid) await new Promise((r) => setTimeout(r, 5));
    const r = await cli(["answer", "r1", "#1", "merge", "--json"], { cwd: project.root, core: live });
    expect(jsonLines(r.stdout)[0]).toMatchObject({ resumeNeeded: false });
    release();
    await running;
  });

  it("needs a journal with an ask store", async () => {
    const r = await cli(["answer", "r1"], { cwd: project.root, core: fakeCore({ asks: false }) });
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toContain("no ask store");
  });
});
