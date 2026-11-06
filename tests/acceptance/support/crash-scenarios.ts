// The crash-and-resume scenarios of acceptance test 3, shared by the plain Node and the Trigger host files.
import path from "node:path";
import { expect } from "vitest";
import {
  type HostConfig,
  kill,
  LEASE_EXPIRY_MS,
  launched,
  readEvents,
  sleep,
  startHost,
  turnsOf,
  waitForEvent,
} from "./crash.js";

const PROMPT_B = "Step b.";
const EDITED_B = "Step b, edited: also update the changelog.";

const describeFailure = (r: unknown, stderr: string) => `${JSON.stringify(r)}\n${stderr.slice(-2000)}`;

export interface CrashScenarioOptions {
  /** The plain Node host's journal: `fileJournal` (default) or `sqliteJournal` (release-prep §1.5). */
  journal?: "file" | "sqlite";
}

/**
 * The machine dies while call c runs (host and box processes are killed). Resuming with the same run id replays a
 * and b from the journal and refuses to re-run c silently. Resuming again after editing b's prompt replays a, and
 * runs b, then c and d, live.
 */
export async function machineDiesThenPromptEdit(
  dir: string,
  host: HostConfig["host"],
  runId: string,
  opts: CrashScenarioOptions = {},
) {
  const base = { dir, runId, host, promptB: PROMPT_B, journal: opts.journal ?? "file" };
  const boxes = path.join(dir, "boxes");

  const first = startHost({ ...base, tag: "r1", slow: { c: 600 } });
  await waitForEvent(dir, "r1", (e) => e.type === "turn.started" && e.callPath === "c", first);
  await kill(first, boxes);
  const r1 = readEvents(dir, "r1");
  expect(launched(r1)).toEqual(["a", "b", "c"]);

  // The killed process still holds the run's lease until it expires.
  await sleep(LEASE_EXPIRY_MS);

  const second = startHost({ ...base, tag: "r2" });
  const r2Result = await second.done;
  const r2 = readEvents(dir, "r2");
  expect(r2Result?.status, describeFailure(r2Result, second.stderr())).toBe("needs_attention");
  // a and b came from the journal; c was cut off with its box gone, so nothing was launched again.
  expect(launched(r2)).toEqual([]);
  expect(JSON.stringify(r2.filter((e) => e.type === "agent.failed"))).toContain("interrupted");
  expect(r2.find((e) => e.type === "run.end")?.data).toMatchObject({ needsAttention: ["c"] });

  // A new trigger of the same run id, after the run ended needing attention.
  const third = startHost({ ...base, tag: "r3", promptB: EDITED_B, triggerRun: "run_r3_" });
  const r3Result = await third.done;
  const r3 = readEvents(dir, "r3");
  expect(r3Result?.status, describeFailure([r3Result, r3.filter((e) => e.level === "error")], third.stderr())).toBe(
    "ok",
  );
  expect(r3Result?.output).toEqual([
    { label: "a", step: "a@r1", replayed: true },
    { label: "b", step: "b@r3", replayed: false },
    { label: "c", step: "c@r3", replayed: false },
    { label: "d", step: "d@r3", replayed: false },
  ]);
  expect(launched(r3)).toEqual(["b", "c", "d"]);
  // On the Trigger host the platform retried the crashed run in the same epoch; triggering again started the next.
  if (host === "trigger") expect([r2Result?.epoch, r3Result?.epoch]).toEqual([0, 1]);
  // Across all three processes a ran once; b once per prompt; c once before the crash and once after the edit.
  const all = [...r1, ...r2, ...r3];
  expect(turnsOf(all, "a")).toBe(1);
  expect(turnsOf(all, "b")).toBe(2);
  expect(turnsOf(all, "c")).toBe(2);
}

/**
 * Only the host process dies while call b runs; its box keeps going and finishes b. The resume replays a, collects
 * b's outcome from the box without launching it again, and runs c and d live.
 */
export async function hostDiesMidCall(
  dir: string,
  host: HostConfig["host"],
  runId: string,
  opts: CrashScenarioOptions = {},
) {
  const base = { dir, runId, host, promptB: PROMPT_B, journal: opts.journal ?? "file" };

  const first = startHost({ ...base, tag: "r1", slow: { b: 4 } });
  await waitForEvent(dir, "r1", (e) => e.type === "turn.started" && e.callPath === "b", first);
  await kill(first);
  const r1 = readEvents(dir, "r1");
  expect(launched(r1)).toEqual(["a", "b"]);

  await sleep(LEASE_EXPIRY_MS);

  const second = startHost({ ...base, tag: "r2" });
  const r2Result = await second.done;
  const r2 = readEvents(dir, "r2");
  expect(r2Result?.status, describeFailure(r2Result, second.stderr())).toBe("ok");
  expect(r2Result?.output?.map((o) => o.step)).toEqual(["a@r1", "b@r1", "c@r2", "d@r2"]);
  expect(r2Result?.output?.[0]?.replayed).toBe(true);
  expect(launched(r2)).toEqual(["c", "d"]);
  if (host === "trigger") expect(r2Result?.epoch).toBe(0);
  expect(turnsOf([...r1, ...r2], "b")).toBe(1);
}
