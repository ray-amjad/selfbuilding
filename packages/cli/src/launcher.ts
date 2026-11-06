import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveStartPolicy,
  type ScriptRunInput,
  type SelfbuildingConfig,
  type SelfbuildingEvent,
  type StartWorkflowCaller,
  type StartWorkflowReceipt,
  type StartWorkflowRequest,
  startWorkflowCaps,
  type WorkflowAgentStatus,
  type WorkflowLauncher,
  type WorkflowRunStatus,
  workflowRunId,
} from "@selfbuilding/core";
import { type StatePaths, statePaths } from "./project.js";
import { eventsPath, isAlive, type RunRecord, readRunRecord, writeRunRecord } from "./state.js";

// start_workflow on the plain Node host (docs/spec/demo-path.md §9.4). Owner: start-workflow. A launch runs the
// `run-script` factory in a detached `selfbuilding run`, with the run id fixed up front, so `watch`, `cancel` and
// `resume` work on it like on any other run.

export interface NodeWorkflowLauncherOptions {
  /** The project root (where `.selfbuilding/` lives). */
  cwd: string;
  config?: SelfbuildingConfig;
  configPath?: string | null;
  envFile?: string;
  /** The CLI entry the detached run starts with. Default: the built `cli.js` next to this module, else `process.argv[1]`. */
  cliEntry?: string;
  /** Starts the detached process; tests replace it. Returns its pid. */
  spawn?: (argv: string[], opts: { cwd: string }) => number | undefined;
  /** Default: `checkScript` from @selfbuilding/script. */
  checkScript?: (source: string) => Promise<void>;
}

/** Whether a run record belongs to a workflow script run started through start_workflow or `selfbuilding start`. */
export function isScriptRun(record: RunRecord | null): record is RunRecord & { input: ScriptRunInput } {
  const input = record?.input as Partial<ScriptRunInput> | undefined;
  return typeof input?.source === "string" && typeof input.name === "string";
}

function readEvents(file: string): SelfbuildingEvent[] {
  if (!existsSync(file)) return [];
  const events: SelfbuildingEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SelfbuildingEvent);
    } catch {
      // a line still being written
    }
  }
  return events;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** A run's phase, agents (with sizes and costs) and live sandboxes, from its event stream. */
export function summariseRun(runId: string, events: SelfbuildingEvent[], record: RunRecord | null): WorkflowRunStatus {
  const agents = new Map<string, WorkflowAgentStatus>();
  const sizes = new Map<string, string>();
  let phase: string | undefined;
  let live = 0;
  let ended: { status: WorkflowRunStatus["status"]; usd?: number } | undefined;
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const at = e.callPath ?? "run";
    switch (e.type) {
      case "phase":
        if (typeof d.name === "string") phase = d.name;
        break;
      case "agent.started":
        agents.set(at, {
          callPath: at,
          ...(typeof d.agent === "string" ? { agent: d.agent } : {}),
          ...(sizes.has(at) ? { size: sizes.get(at) as string } : {}),
          status: "running",
        });
        break;
      case "agent.finished":
      case "agent.replayed": {
        const usd = num((d.usage as { usd?: unknown } | undefined)?.usd);
        const prev = agents.get(at) ?? { callPath: at, status: "running" as const };
        agents.set(at, { ...prev, status: "succeeded", ...(usd !== undefined ? { usd } : {}) });
        break;
      }
      case "agent.failed": {
        const prev = agents.get(at) ?? { callPath: at, status: "running" as const };
        agents.set(at, { ...prev, status: "failed" });
        break;
      }
      case "sandbox.created": {
        live++;
        if (typeof d.size === "string") {
          sizes.set(at, d.size);
          const agent = agents.get(at);
          if (agent) agents.set(at, { ...agent, size: d.size });
        }
        break;
      }
      case "sandbox.disposed":
      case "sandbox.killed":
        live = Math.max(0, live - 1);
        break;
      case "run.end":
        if (at === "run") {
          const usd = num((d.usage as { usd?: unknown } | undefined)?.usd) ?? num(d.usd);
          ended = { status: d.status as WorkflowRunStatus["status"], ...(usd !== undefined ? { usd } : {}) };
        }
        break;
    }
  }
  const list = [...agents.values()];
  const spent = list.reduce((sum, a) => sum + (a.usd ?? 0), 0);
  const usd = ended?.usd ?? (list.some((a) => a.usd !== undefined) ? spent : undefined);
  const driving = record?.pid !== undefined && isAlive(record.pid) && !record.finishedAt;
  const status: WorkflowRunStatus["status"] =
    ended?.status ?? (driving || !record?.status ? "running" : (record.status as WorkflowRunStatus["status"]));
  const input = record?.input as Partial<ScriptRunInput> | undefined;
  return {
    runId,
    status,
    ...(typeof input?.name === "string" ? { name: input.name } : {}),
    ...(phase ? { phase } : {}),
    agents: list,
    sandboxes: status === "running" ? live : 0,
    ...(usd !== undefined ? { usd } : {}),
    ...(input?.launchedBy ? { launchedBy: input.launchedBy } : {}),
    ...(record?.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record?.finishedAt ? { finishedAt: record.finishedAt } : {}),
  };
}

const money = (usd: number | undefined) => (usd === undefined ? "-" : `$${usd.toFixed(usd < 1 ? 4 : 2)}`);

/** The readable summary `watch` and `start` print for a script run. */
export function formatWorkflowSummary(s: WorkflowRunStatus): string {
  const head = `Workflow ${s.name ?? s.runId} (${s.runId}): ${s.status}${s.phase ? `, phase ${s.phase}` : ""}, ${money(s.usd)}${s.status === "running" ? `, ${s.sandboxes} live sandbox${s.sandboxes === 1 ? "" : "es"}` : ""}`;
  if (s.agents.length === 0) return `${head}\n  no agent calls yet`;
  const width = Math.max(...s.agents.map((a) => a.callPath.length));
  const rows = s.agents.map(
    (a) =>
      `  ${a.callPath.padEnd(width)}  ${(a.agent ?? "-").padEnd(14)}  ${(a.size ?? "default").padEnd(8)}  ${a.status.padEnd(9)}  ${money(a.usd)}`,
  );
  return [head, ...rows].join("\n");
}

/** The status of one run this project knows, or null. */
export function workflowStatus(paths: StatePaths, runId: string): WorkflowRunStatus | null {
  const record = readRunRecord(paths, runId);
  const file = eventsPath(paths, runId);
  if (!record && !existsSync(file)) return null;
  return summariseRun(runId, readEvents(file), record);
}

async function defaultCheckScript(source: string): Promise<void> {
  const { checkScript } = await import("@selfbuilding/script");
  await checkScript(source);
}

function scriptPackageUrl(): string {
  return import.meta.resolve("@selfbuilding/script");
}

function corePackageUrl(): string {
  return import.meta.resolve("@selfbuilding/core");
}

/**
 * The CLI the detached run starts with. Built, this module sits next to `cli.js` (in the bin's bundle or the
 * `selfbuilding/launcher` entry), and `process.argv[1]` is the host's own script when another program imports it.
 */
export function defaultCliEntry(): string {
  const sibling = fileURLToPath(new URL("./cli.js", import.meta.url));
  return existsSync(sibling) ? sibling : (process.argv[1] ?? "selfbuilding");
}

/** Starts the `run-script` factory detached through `selfbuilding run`, tagged with its caller. */
export function nodeWorkflowLauncher(opts: NodeWorkflowLauncherOptions): WorkflowLauncher {
  const paths = statePaths(opts.cwd);
  const policy = resolveStartPolicy(opts.config?.startWorkflow);
  const start =
    opts.spawn ??
    ((argv: string[], o: { cwd: string }) => {
      const child = spawn(process.execPath, argv, { cwd: o.cwd, detached: true, stdio: "ignore", env: process.env });
      child.unref();
      return child.pid;
    });

  const scriptRuns = (): RunRecord[] => {
    if (!existsSync(paths.runs)) return [];
    return readdirSync(paths.runs)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return readRunRecord(paths, f.slice(0, -".json".length));
        } catch {
          return null;
        }
      })
      .filter(isScriptRun);
  };

  return {
    host: "node",

    checkScript: opts.checkScript ?? defaultCheckScript,

    async start(req: StartWorkflowRequest, caller: StartWorkflowCaller): Promise<StartWorkflowReceipt> {
      const runId = workflowRunId(caller, req);
      const receipt = (status: StartWorkflowReceipt["status"]): StartWorkflowReceipt => ({
        runId,
        status,
        host: "node",
        watch: `selfbuilding watch ${runId}`,
      });
      if (readRunRecord(paths, runId)) return receipt("exists");

      const input: ScriptRunInput = {
        source: req.script,
        input: req.input ?? {},
        name: req.name,
        caps: startWorkflowCaps(policy, req, opts.config),
        launchedBy: caller,
      };
      // A factory file per run: it records the caller's depth in the run's process, then exports run-script
      // built with this run's caps and the deployment's script caps and budget, so they bound the engine's
      // sandbox slots and budget, not only the script layer.
      const dir = path.join(paths.dir, "scripts");
      mkdirSync(dir, { recursive: true });
      const factoryFile = path.join(dir, `${runId}.mjs`);
      const factoryOptions = {
        ...(input.caps ? { caps: input.caps } : {}),
        config: {
          ...(opts.config?.scripts ? { scripts: opts.config.scripts } : {}),
          ...(opts.config?.budget ? { budget: opts.config.budget } : {}),
        },
      };
      writeFileSync(
        factoryFile,
        [
          `import { noteLaunchedBy } from ${JSON.stringify(corePackageUrl())};`,
          `import { createScriptFactory } from ${JSON.stringify(scriptPackageUrl())};`,
          `noteLaunchedBy(${JSON.stringify(runId)}, ${JSON.stringify(caller)});`,
          `export default createScriptFactory(${JSON.stringify(factoryOptions)});`,
          "",
        ].join("\n"),
      );
      const inputFile = path.join(dir, `${runId}.input.json`);
      writeFileSync(inputFile, JSON.stringify(input));

      const entry = opts.cliEntry ?? defaultCliEntry();
      const argv = [
        entry,
        "run",
        factoryFile,
        "--run-id",
        runId,
        "--input",
        `@${inputFile}`,
        ...(opts.configPath ? ["--config", opts.configPath] : []),
        ...(opts.envFile ? ["--env-file", opts.envFile] : []),
        ...(req.afk ? ["--afk"] : []),
      ];
      const pid = start(argv, { cwd: opts.cwd });
      // Recorded before the child gets going, so a `watch` right after this sees a run that is driving.
      const now = new Date().toISOString();
      writeRunRecord(paths, {
        v: 1,
        runId,
        factoryFile,
        input,
        configPath: opts.configPath ?? null,
        ...(opts.envFile ? { envFile: opts.envFile } : {}),
        ...(req.afk ? { afk: true } : {}),
        startedAt: now,
        updatedAt: now,
        ...(pid !== undefined ? { pid } : {}),
      });
      return receipt("started");
    },

    async active(): Promise<{ runs: number; sandboxes: number }> {
      let runs = 0;
      let sandboxes = 0;
      for (const record of scriptRuns()) {
        if (record.finishedAt || record.pid === undefined || !isAlive(record.pid)) continue;
        runs++;
        const status = summariseRun(record.runId, readEvents(eventsPath(paths, record.runId)), record);
        sandboxes += status.sandboxes;
      }
      return { runs, sandboxes };
    },

    async status(runId: string): Promise<WorkflowRunStatus | null> {
      return workflowStatus(paths, runId);
    },
  };
}
