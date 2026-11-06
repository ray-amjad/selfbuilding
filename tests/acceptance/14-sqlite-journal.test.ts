// Acceptance 14 (release-prep §1.5): acceptance 3 on sqliteJournal. Each host is a real child process killed with
// SIGKILL mid-call; the resume replays from the SQLite file it left, with the same results as on the file journal.
import { existsSync } from "node:fs";
import path from "node:path";
import { sqliteJournal } from "@selfbuilding/core";
import { tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, describe, expect, it } from "vitest";
import { hostDiesMidCall, machineDiesThenPromptEdit } from "./support/crash-scenarios.js";
import { tempDir } from "./support/kit.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => tmpdirProvider({ root: path.join(d, "boxes") }).close()));
});

const fresh = async () => {
  const dir = await tempDir("sba-sqlite-");
  dirs.push(dir);
  return dir;
};

/** The runs wrote to the SQLite file only, and it holds the run's entries. */
async function assertOnSqlite(dir: string, runId: string): Promise<void> {
  expect(existsSync(path.join(dir, "journal.db"))).toBe(true);
  expect(existsSync(path.join(dir, "journal"))).toBe(false);
  const steps: string[] = [];
  for await (const e of sqliteJournal(path.join(dir, "journal.db")).list(runId)) steps.push(e.callPath);
  expect(steps.length).toBeGreaterThan(0);
}

describe("acceptance 14: crash and resume on sqliteJournal", () => {
  it.concurrent("the machine dies mid-call: replay, refuse the interrupted call, then run the edited prompt live", async () => {
    const dir = await fresh();
    await machineDiesThenPromptEdit(dir, "node", "ns_accept_crash_sqlite", { journal: "sqlite" });
    await assertOnSqlite(dir, "ns_accept_crash_sqlite");
  });

  it.concurrent("the host process dies mid-call: the box finishes it and the resume collects it without a re-run", async () => {
    const dir = await fresh();
    await hostDiesMidCall(dir, "node", "ns_accept_hostdies_sqlite", { journal: "sqlite" });
    await assertOnSqlite(dir, "ns_accept_hostdies_sqlite");
  });
});
