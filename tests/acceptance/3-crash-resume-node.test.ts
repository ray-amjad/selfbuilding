// Acceptance 3 (docs/BASIC-SCOPE.md) on the plain Node host: kill the process mid-run, edit a prompt, resume with
// the same run id. Finished calls replay from the journal, the edited call and everything after it run live, and an
// interrupted call is never silently re-run. Each host is a real child process, killed with SIGKILL.
import path from "node:path";
import { tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, describe, it } from "vitest";
import { hostDiesMidCall, machineDiesThenPromptEdit } from "./support/crash-scenarios.js";
import { tempDir } from "./support/kit.js";

const dirs: string[] = [];
afterAll(async () => {
  // A provider on the same root sees the boxes the host processes left, and removes them.
  await Promise.all(dirs.map((d) => tmpdirProvider({ root: path.join(d, "boxes") }).close()));
});

const fresh = async () => {
  const dir = await tempDir("sba-crash-node-");
  dirs.push(dir);
  return dir;
};

describe("acceptance 3: crash and resume on plain Node", () => {
  it.concurrent("the machine dies mid-call: replay, refuse the interrupted call, then run the edited prompt live", async () => {
    await machineDiesThenPromptEdit(await fresh(), "node", "ns_accept_crash_node");
  });

  it.concurrent("the host process dies mid-call: the box finishes it and the resume collects it without a re-run", async () => {
    await hostDiesMidCall(await fresh(), "node", "ns_accept_hostdies_node");
  });
});
