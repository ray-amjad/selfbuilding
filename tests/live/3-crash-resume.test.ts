// Live acceptance 3: the host process dies while a real harness works in a real sandbox. The box keeps running; the
// next process with the same run id replays a from the journal, collects b's outcome from the box without
// launching it again, and runs c.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SelfbuildingEvent } from "@selfbuilding/core";
import { describe, expect, it } from "vitest";
import { liveRunId, targets, tempDir } from "./support/live.js";

const HOST = fileURLToPath(new URL("./fixtures/live-host.mjs", import.meta.url));
// The journal lease outlives a killed process by its 60 s TTL.
const LEASE_EXPIRY_MS = 61_000;

function start(cfg: object): { child: ChildProcess; done: Promise<{ status: string; output: unknown } | null> } {
  const child = spawn(process.execPath, [HOST], {
    cwd: path.dirname(HOST),
    env: { ...process.env, SBL_CRASH: JSON.stringify(cfg) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  const done = new Promise<{ status: string; output: unknown } | null>((resolve) =>
    child.on("exit", () => {
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      resolve(line ? JSON.parse(line.slice("RESULT ".length)) : null);
    }),
  );
  return { child, done };
}

function events(dir: string, tag: string): SelfbuildingEvent[] {
  const file = path.join(dir, `events-${tag}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SelfbuildingEvent);
}

const launched = (es: SelfbuildingEvent[]) => es.filter((e) => e.type === "agent.launched").map((e) => e.callPath);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("live 3: crash and resume", () => {
  for (const t of targets) {
    it.skipIf(t.skip !== "")(`${t.name}${t.skip ? ` (skipped: ${t.skip})` : ""}`, async () => {
      const dir = await tempDir("sbl-crash-");
      const base = { dir, runId: liveRunId("crash"), provider: t.provider, harness: t.harness };

      const first = start({ ...base, tag: "r1" });
      const deadline = Date.now() + 10 * 60_000;
      while (!events(dir, "r1").some((e) => e.type === "turn.started" && e.callPath === "b")) {
        if (Date.now() > deadline || first.child.exitCode !== null) throw new Error("b never started");
        await sleep(500);
      }
      first.child.kill("SIGKILL");
      await first.done;
      expect(launched(events(dir, "r1"))).toEqual(["a", "b"]);

      await sleep(LEASE_EXPIRY_MS);
      const second = start({ ...base, tag: "r2" });
      const result = await second.done;
      expect(result?.status).toBe("ok");
      expect(result?.output).toMatchObject([
        { label: "a", word: "alpha", replayed: true },
        { label: "b", word: "bravo" },
        { label: "c", word: "charlie", replayed: false },
      ]);
      expect(launched(events(dir, "r2"))).toEqual(["c"]);
    });
  }
});
