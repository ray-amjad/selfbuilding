// A host process for acceptance test 3, killed and restarted by the test. It runs one four-agent factory on the
// plain Node host or on the Trigger host (with the local Trigger stand-in), with a file journal or result store
// and tmpdir boxes under one directory, so the next process sees what this one left behind.
//
// SBA_CRASH (JSON): { dir, runId, host: "node" | "trigger", tag, promptB, slow: { <label>: seconds }, triggerRun,
//   journal: "file" | "sqlite" }
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agent, factory, fileArtifacts, fileJournal, run, setRuntimeBundles, sqliteJournal } from "@selfbuilding/core";
import { createLocalTrigger, createTriggerHost, fileResultStore } from "@selfbuilding/host-trigger";
import { scripted, scriptedHarness, tmpdirProvider } from "@selfbuilding/testing";
import { z } from "zod";

const cfg = JSON.parse(process.env.SBA_CRASH ?? "{}");
const dist = path.join(path.dirname(fileURLToPath(import.meta.resolve("@selfbuilding/runtime/package.json"))), "dist");
setRuntimeBundles({
  runtime: readFileSync(path.join(dist, "selfbuilding-runtime.mjs")),
  mcp: readFileSync(path.join(dist, "selfbuilding-mcp.mjs")),
  nsReap: readFileSync(path.join(dist, "ns-reap.mjs")),
});

const eventsFile = path.join(cfg.dir, `events-${cfg.tag}.jsonl`);
const sink = (e) => appendFileSync(eventsFile, `${JSON.stringify(e)}\n`);

// Each call says which process produced it, so a replayed value is told apart from a live one.
const harness = scriptedHarness((call) => {
  const label = call.callPath.split("/").at(-1);
  const slow = cfg.slow?.[label];
  return [
    scripted.say(`working on ${label}`),
    ...(slow ? [scripted.sh(`sleep ${slow}`)] : []),
    scripted.submit({ step: `${label}@${cfg.tag}` }),
  ];
});

const Out = z.object({ step: z.string() });
const CrashResume = factory({ name: "crash-resume", input: z.object({}) }, async () => {
  const out = [];
  for (const [label, prompt] of [
    ["a", "Step a."],
    ["b", cfg.promptB],
    ["c", "Step c."],
    ["d", "Step d."],
  ]) {
    const r = await agent({ name: label, prompt, output: Out, label });
    out.push({ label, step: r.result.step, replayed: r.replayed });
  }
  return out;
});

const provider = tmpdirProvider({ root: path.join(cfg.dir, "boxes") });
const config = {
  deployment: "acceptance",
  sandbox: provider,
  harness,
  events: [sink],
  artifacts: fileArtifacts(path.join(cfg.dir, "artifacts")),
};

async function onNode() {
  const journal =
    cfg.journal === "sqlite"
      ? sqliteJournal(path.join(cfg.dir, "journal.db"))
      : fileJournal(path.join(cfg.dir, "journal"));
  return run(CrashResume, {}, { runId: cfg.runId, config, journal });
}

async function onTrigger() {
  // A fresh local Trigger per process; the result store on disk is what survives. Its first run is named
  // `<triggerRun>0001`: the same name again is the platform retrying that run after its worker died, a new name is
  // a new trigger of the run id.
  const t = createLocalTrigger({ startAt: Date.now(), runIdPrefix: cfg.triggerRun ?? "run_" });
  createTriggerHost({
    config,
    factories: { "crash-resume": CrashResume },
    trigger: t,
    store: fileResultStore(path.join(cfg.dir, "trigger")),
    providers: [provider],
    settleMs: 0,
  });
  const { id } = await t.start("selfbuilding.factory", { factory: "crash-resume", input: {}, runId: cfg.runId });
  for (;;) {
    const view = t.run(id);
    if (["COMPLETED", "FAILED", "CANCELED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT"].includes(view.status)) {
      if (view.status !== "COMPLETED") return { status: `trigger:${view.status}`, output: null, error: view.error };
      return view.output;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const result = await (cfg.host === "trigger" ? onTrigger() : onNode());
process.stdout.write(
  `RESULT ${JSON.stringify({ status: result.status, output: result.output, epoch: result.epoch, error: result.error })}\n`,
);
process.exit(0);
