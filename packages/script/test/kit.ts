// Test helpers (not exported from the package): fake agents journaled through step(), so scripts run offline
// inside a real run() with a real journal, and a resume replays them.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type Agent,
  type AgentCallOptions,
  fileJournal,
  type Json,
  NoResultError,
  type RunOutcome,
  run,
  type ScriptRunInput,
  type SelfbuildingConfig,
  type SelfbuildingEvent,
  step,
} from "@selfbuilding/core";
import { createScriptFactory, type RunScriptOptions } from "../src/index.js";

export interface FakeCall {
  name: string;
  input: unknown;
  opts: AgentCallOptions | undefined;
}

export interface FakeAgents {
  // biome-ignore lint/suspicious/noExplicitAny: fake agents stand in for agents of any shape
  agents: Record<string, Agent<any, any>>;
  /** Every live (not replayed) call, in issue order. */
  calls: FakeCall[];
  /** Agent names in the order the script issued them, replays included; `calls` holds only live runs. */
  issued: string[];
  /** Restarts the step-label counter; call it before each run() so a resume issues the same labels. */
  reset(): void;
}

/** Each fake returns `produce(input)`; `fail` makes it throw AgentFailedError. Costs `usd` per call. */
export function fakeAgents(
  spec: Record<
    string,
    {
      produce?: (input: unknown) => Json;
      usd?: number;
      fail?: boolean;
      failTimes?: number;
      delayMs?: number;
      /** The contract's default size, as Verify's "medium". */
      defaultSize?: string;
      /** A PR the call reports as opened, as `artifacts.pr`. */
      pr?: { url: string; number: number; draft: boolean };
    }
  >,
): FakeAgents {
  const calls: FakeCall[] = [];
  const issued: string[] = [];
  let seq = 0;
  const failures: Record<string, number> = {};
  // biome-ignore lint/suspicious/noExplicitAny: see FakeAgents
  const agents: Record<string, Agent<any, any>> = {};
  for (const [name, s] of Object.entries(spec)) {
    const call = async (input: unknown, opts?: AgentCallOptions) => {
      // Recorded before the step's journal I/O, so the order is the order the script issued calls in.
      issued.push(name);
      const value = await step(`fake-${name.toLowerCase()}-${seq++}`, async () => {
        calls.push({ name, input, opts });
        if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
        if (s.fail) throw new NoResultError(`${name} failed on purpose`);
        if (s.failTimes && failures[name] !== s.failTimes) {
          failures[name] = (failures[name] ?? 0) + 1;
          throw new NoResultError(`${name} failed on purpose`);
        }
        return { result: s.produce ? s.produce(input) : { ok: true } };
      });
      return {
        result: (value as { result: Json }).result,
        runId: "fake",
        callPath: name,
        stepKey: "fake",
        attempts: { submits: 1, resumes: 0, doneRetries: 0 },
        replayed: false,
        usage: { usd: s.usd ?? 0, inputTokens: 0, outputTokens: 0, turns: 1, wallClockMs: 0, sandboxMs: 0 },
        artifacts: { files: [], ...(s.pr ? { pr: s.pr } : {}) },
        checks: [],
        integrity: "isolated",
        harness: { id: "fake", version: "0" },
        skill: { name, hash: "fake" },
      };
    };
    const settled = async (input: unknown, opts?: AgentCallOptions) => {
      try {
        return { ok: true, value: await call(input, opts) };
      } catch (error) {
        return { ok: false, code: (error as { code?: string }).code ?? "unknown", error };
      }
    };
    const contract = { defaults: s.defaultSize ? { size: s.defaultSize } : {} };
    agents[name] = Object.assign(call, { settled, contract }) as unknown as Agent<unknown, unknown>;
  }
  return {
    agents,
    calls,
    issued,
    reset: () => {
      seq = 0;
    },
  };
}

export async function tempDir(prefix = "sbs-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export interface ScriptOutcome extends RunOutcome<Json> {
  events: SelfbuildingEvent[];
}

/** Runs `source` through the deployed `run-script` factory with a file journal under `dir`. */
export async function runSource(
  source: string,
  opts: {
    dir: string;
    runId?: string;
    input?: Json;
    caps?: ScriptRunInput["caps"];
    script?: RunScriptOptions;
    config?: SelfbuildingConfig;
  },
): Promise<ScriptOutcome> {
  const f = createScriptFactory({ agents: {}, harnesses: {}, providers: {}, ...opts.script });
  const out = await run(
    f,
    { source, name: "test-script", input: opts.input ?? {}, ...(opts.caps ? { caps: opts.caps } : {}) },
    {
      runId: opts.runId ?? `ns_script_${Math.random().toString(36).slice(2, 10)}`,
      journal: fileJournal(path.join(opts.dir, "journal")),
      config: { deployment: "test", ...opts.config },
    },
  );
  if (process.env.SB_DEBUG && out.status !== "ok") console.log(out.status, bodyError(out));
  return out as ScriptOutcome;
}

/** The first `error` event the run emitted for the body, as `{ name, message, code }`. */
export function bodyError(outcome: RunOutcome<unknown>): { name: string; message: string; code: string } | undefined {
  const e = outcome.events.find((ev) => ev.type === "error" && ev.data?.primitive === "run");
  return e?.data as { name: string; message: string; code: string } | undefined;
}
