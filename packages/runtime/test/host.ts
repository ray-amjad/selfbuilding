import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type GitSpec,
  type Harness,
  type LaunchProbe,
  type Outcome,
  type ProviderSandbox,
  type ResolvedTimeouts,
  type RuntimeSpec,
  SANDBOX_PATHS,
  type WaitResponse,
} from "@selfbuilding/core";
import { canonicalPaths } from "@selfbuilding/testing";

// A minimal stand-in for the host side of the runtime contract (BUILD-MAP §3): it builds the bundles, stages a call
// into a tmpdir box and drives the verbs over exec, the way core's agent call lifecycle will.

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const repoRoot = path.resolve(pkg, "../..");

export interface Bundles {
  runtime: string;
  mcp: string;
  nsReap: string;
  sha256: string;
}

let bundles: Bundles | undefined;

/** Builds the three bundles once per test process into a private directory, so parallel files never race. */
export function buildBundles(): Bundles {
  if (bundles) return bundles;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "sbrt-bundle-"));
  const run = spawnSync(path.join(repoRoot, "node_modules/.bin/tsup"), ["--out-dir", out, "--silent"], {
    cwd: pkg,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`tsup failed: ${run.stderr || run.stdout}`);
  const read = (name: string) => fs.readFileSync(path.join(out, name), "utf8");
  const runtime = read("selfbuilding-runtime.mjs");
  bundles = {
    runtime,
    mcp: read("selfbuilding-mcp.mjs"),
    nsReap: read("ns-reap.mjs"),
    sha256: createHash("sha256").update(runtime).digest("hex"),
  };
  fs.rmSync(out, { recursive: true, force: true });
  return bundles;
}

export const RUNTIME = `node ${SANDBOX_PATHS.runtimeBundle}`;

export const MCP_SERVERS = [
  { name: "selfbuilding", type: "stdio" as const, command: "node", args: [SANDBOX_PATHS.mcpBundle] },
];

export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A bare repository on the host with one commit on main, standing in for the git remote. */
export function createRemote(): { url: string; baseSha: string; featureSha: string; dir: string } {
  // Not under /tmp: inside a box /tmp is the box's own, so a host path there would be mapped into the box.
  const parent = path.join(pkg, "node_modules", ".sbrt");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "remote-"));
  const work = path.join(dir, "seed");
  const bare = path.join(dir, "remote.git");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "seed",
    GIT_AUTHOR_EMAIL: "seed@example.com",
    GIT_COMMITTER_NAME: "seed",
    GIT_COMMITTER_EMAIL: "seed@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (args: string[], cwd: string) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  fs.mkdirSync(work, { recursive: true });
  git(["init", "-q", "-b", "main"], work);
  fs.writeFileSync(path.join(work, "README.md"), "# playground\n");
  fs.writeFileSync(
    path.join(work, "package.json"),
    `${JSON.stringify({ name: "pg", scripts: { test: "true" } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(work, ".gitignore"), "node_modules/\n");
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", "seed"], work);
  const baseSha = git(["rev-parse", "HEAD"], work);
  git(["checkout", "-q", "-b", "feature"], work);
  fs.writeFileSync(path.join(work, "feature.txt"), "a feature\n");
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", "feature"], work);
  const featureSha = git(["rev-parse", "HEAD"], work);
  git(["checkout", "-q", "main"], work);
  git(["clone", "-q", "--bare", work, bare], dir);
  return { url: bare, baseSha, featureSha, dir };
}

export const FAST_TIMEOUTS: ResolvedTimeouts = {
  callMs: 60_000,
  idleMs: 20_000,
  setupMs: 10_000,
  startMs: 10_000,
  bootMs: 60_000,
  postSubmitGraceMs: 300,
  cancelGraceMs: 1_000,
  exitQuietMs: 2_000,
  mcpToolMs: 600_000,
};

export interface StageOptions {
  harness: Harness;
  remote: string;
  stepKey?: string;
  attempt?: number;
  launch?: number;
  runId?: string;
  callPath?: string;
  prompt?: string;
  resultSchema?: RuntimeSpec["resultSchema"];
  spec?: Partial<RuntimeSpec>;
  git?: Partial<GitSpec>;
  timeouts?: Partial<ResolvedTimeouts>;
  resumeSessionId?: string;
  sessionId?: string;
  /** Write the runtime files (default true; false on a second launch into the same box). */
  install?: boolean;
  /** Write ns-reap (default true). */
  nsReap?: boolean;
}

export const DEFAULT_RESULT_SCHEMA = {
  type: "object",
  properties: { status: { type: "string", enum: ["done", "blocked", "failed"] }, summary: { type: "string" } },
  required: ["status", "summary"],
  additionalProperties: false,
} as const;

export interface StagedCall {
  stepKey: string;
  attempt: number;
  launchId: string;
  spec: RuntimeSpec;
  args: string;
}

/** Stages one launch the way the host does: runtime files, harness config, prompt, then spec.json last. */
export async function stageCall(box: ProviderSandbox, o: StageOptions): Promise<StagedCall> {
  const b = buildBundles();
  const runId = o.runId ?? "run-1";
  const callPath = o.callPath ?? "root/agent#0";
  const stepKey = o.stepKey ?? "agent-0";
  const attempt = o.attempt ?? 1;
  const launchId = `${stepKey}_e1_l${o.launch ?? 1}`;
  const attemptDir = `${SANDBOX_PATHS.calls}/${stepKey}/${attempt}`;
  const paths = canonicalPaths(attemptDir);
  if (o.install !== false) {
    await box.writeFiles([
      { path: SANDBOX_PATHS.runtimeBundle, data: b.runtime, mode: 0o755 },
      { path: SANDBOX_PATHS.mcpBundle, data: b.mcp, mode: 0o755 },
      ...(o.nsReap === false ? [] : [{ path: SANDBOX_PATHS.nsReap, data: b.nsReap, mode: 0o755 }]),
    ]);
    await box.writeFiles([{ path: SANDBOX_PATHS.runtimeVersion, data: b.sha256 }]);
  }
  const prepared = o.harness.prepare({
    runId,
    callPath,
    attempt,
    paths,
    skills: [],
    mcpServers: MCP_SERVERS,
    hotWaitMs: o.spec?.hotWaitMs ?? 60_000,
  });
  const promptFile = `${SANDBOX_PATHS.in}/prompt.md`;
  const ctx = { runId, callPath, attempt, paths, promptFile, ...(o.sessionId ? { sessionId: o.sessionId } : {}) };
  const invocation = o.harness.invoke(ctx);
  const resume = o.harness.resume?.({ ...ctx, sessionId: "{sessionId}", promptFile: "{promptFile}" });
  const git: GitSpec = {
    mode: "remote",
    remoteUrl: o.remote,
    branch: `selfbuilding/${runId}/agent-0`,
    baseBranch: "main",
    readOnly: false,
    commitLeftovers: true,
    identity: {
      authorName: "selfbuilding-bot",
      authorEmail: "bot@example.com",
      committerName: "selfbuilding-bot",
      committerEmail: "bot@example.com",
    },
    trailers: { run: runId, call: `${runId}.${callPath}`, agent: "TestAgent" },
    allowPushTo: [],
    ...o.git,
  };
  const spec: RuntimeSpec = {
    v: 1,
    runId,
    callId: `${runId}.${callPath}`,
    callPath,
    stepKey,
    attempt,
    launchId: launchId as RuntimeSpec["launchId"],
    harness: o.harness.id,
    harnessVersion: "1.0.0",
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.resumeSessionId ? { resumeSessionId: o.resumeSessionId } : {}),
    resultSchema: o.resultSchema ?? (DEFAULT_RESULT_SCHEMA as unknown as RuntimeSpec["resultSchema"]),
    maxResultBytes: 262_144,
    git,
    timeouts: { ...FAST_TIMEOUTS, ...o.timeouts },
    hotWaitMs: 60_000,
    env: { declared: [] },
    agentName: "TestAgent",
    bootMode: "fresh",
    plan: {
      streamFormat: o.harness.capabilities.streamFormat ?? "claude-code",
      invocation,
      ...(resume ? { resume } : {}),
      stopAfterSubmit: o.harness.capabilities.stopAfterSubmit,
      stripEnv: [],
      secretEnv: {},
      versionArgv: o.harness.versionCommand().argv,
    },
    maxSubmitAttempts: 3,
    maxResumes: 1,
    maxDoneRetries: 2,
    doneChecks: [],
    protect: { paths: ["**/package.json", ".selfbuilding/**"], allow: [] },
    artifactsBranch: "optional",
    postSubmitChanges: "revert",
    wipPushIntervalMs: 0,
    skills: { names: [], linkDirs: [] },
    requireIsolation: false,
    turnIndexBase: 0,
    ...o.spec,
  };
  await box.writeFiles([
    ...prepared.files.map((f) => ({ path: f.path, data: f.content, mode: f.mode })),
    { path: promptFile, data: o.prompt ?? "Do the task." },
    { path: `${attemptDir}/spec.json`, data: JSON.stringify(spec, null, 2) },
  ]);
  return { stepKey, attempt, launchId, spec, args: `--call ${stepKey} --attempt ${attempt}` };
}

export async function verb<T>(
  box: ProviderSandbox,
  args: string,
  stdin?: string,
): Promise<{ exitCode: number; json: T; stderr: string }> {
  const result = await box.exec(`${RUNTIME} ${args}`, { timeoutMs: 60_000, ...(stdin === undefined ? {} : { stdin }) });
  let json: T;
  try {
    json = JSON.parse(result.stdoutTail.trim().split("\n").pop() ?? "null") as T;
  } catch {
    json = undefined as T;
  }
  return { exitCode: result.exitCode, json, stderr: result.stderrTail };
}

export async function launch(box: ProviderSandbox, call: StagedCall): Promise<LaunchProbe> {
  const { json, exitCode, stderr } = await verb<LaunchProbe>(box, `launch ${call.args} --launch ${call.launchId}`);
  if (exitCode !== 0) throw new Error(`launch exited ${exitCode}: ${stderr}`);
  return json;
}

/** Launches and starts the supervisor detached, as the host does after `{action:"start"}`. */
export async function start(box: ProviderSandbox, call: StagedCall): Promise<void> {
  const probe = await launch(box, call);
  if (probe.action !== "start") throw new Error(`expected start, got ${JSON.stringify(probe)}`);
  await box.spawn(`${RUNTIME} supervise ${call.args} --launch ${call.launchId}`);
}

/** Loops the long-poll until `until` holds, collecting events. */
export async function waitUntil(
  box: ProviderSandbox,
  call: StagedCall,
  until: (r: WaitResponse) => boolean,
  opts: { timeoutMs?: number; after?: number } = {},
): Promise<{ last: WaitResponse; events: WaitResponse["events"] }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  let after = opts.after ?? 0;
  const events: WaitResponse["events"] = [];
  for (;;) {
    const { json, exitCode, stderr } = await verb<WaitResponse>(box, `wait ${call.args} --after ${after} --max 2s`);
    if (exitCode !== 0) throw new Error(`wait exited ${exitCode}: ${stderr}`);
    events.push(...json.events);
    after = json.lastSeq;
    if (until(json)) return { last: json, events };
    if (Date.now() > deadline) {
      const log = await readBox(box, attemptPath(call, "runtime.log")).catch(() => "(no runtime.log)");
      throw new Error(
        `timed out waiting; last state ${json.state?.phase}, lock ${json.lock}, events ${events.map((e) => e.type).join(",")}\n${log.slice(-3000)}`,
      );
    }
    if (json.events.length === 0) await new Promise((r) => setTimeout(r, 100));
  }
}

export async function runToOutcome(
  box: ProviderSandbox,
  call: StagedCall,
  timeoutMs = 45_000,
): Promise<{ outcome: Outcome; events: WaitResponse["events"] }> {
  await start(box, call);
  const { last, events } = await waitUntil(box, call, (r) => r.outcome !== undefined, { timeoutMs });
  return { outcome: last.outcome as Outcome, events };
}

export async function readBox(box: ProviderSandbox, file: string): Promise<string> {
  return new TextDecoder().decode(await box.readFile(file));
}

export function attemptPath(call: StagedCall, file = ""): string {
  return `${SANDBOX_PATHS.calls}/${call.stepKey}/${call.attempt}${file ? `/${file}` : ""}`;
}

export async function sh(box: ProviderSandbox, cmd: string, cwd: string = SANDBOX_PATHS.workdir): Promise<string> {
  const r = await box.exec(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd} exited ${r.exitCode}: ${r.stderrTail}`);
  return r.stdoutTail.trim();
}
