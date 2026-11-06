import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AskResolution,
  type AskSpec,
  type CancelSentinel,
  type ErrorCode,
  type HarnessEvent,
  type HarnessFailure,
  type InboxAnswer,
  type Invocation,
  type LaunchId,
  type Outcome,
  RUNTIME_ENV,
  RUNTIME_EXIT,
  type RuntimeSpec,
  SANDBOX_PATHS,
  type StartWorkflowReceipt,
  type StartWorkflowRequest,
  type TerminalCallState,
  type Usage,
} from "@selfbuilding/core";
import { type BootResult, boot, type Failure } from "./boot.js";
import { EventSpool } from "./events.js";
import { exists, readJson, readText, tailFile, writeAtomic, writeExclusive, writeJsonAtomic } from "./fsutil.js";
import { diffBinary, Git, GitCommandFailure, gitEnv } from "./git.js";
import { LineSplitter } from "./lines.js";
import { acquireTurnLock, type TurnLock } from "./lock.js";
import { RuntimeLog } from "./log.js";
import { receiptText, START_WORKFLOW_INPUT_SCHEMA } from "./mcp-server.js";
import { parserFor } from "./parsers/index.js";
import { type AttemptLayout, isSafeName, type Layout } from "./paths.js";
import { runCommand } from "./proc.js";
import { swapProtected } from "./protect.js";
import { capBytes, Redactor } from "./redact.js";
import { formatIssues, validateJsonSchema } from "./schema.js";
import { StateStore, TERMINAL_STATES } from "./state.js";
import { type ToolName, type ToolReply, ToolSocketServer } from "./tool-socket.js";
import { findTree, signalGroup, signalTree, TREE_MARKER_ENV } from "./tree.js";
import { type Fetch, WakeSender, type WakeStatus } from "./wake.js";

// The supervisor (spec §6.3): boot, one or more harness turns on one session, settling, and exactly one outcome.

export const MESSAGES = {
  accepted: "Accepted. Stop now; do not make further changes.",
  fixAndRetry: "Fix these and call submit_result again. Do not redo the work.",
  submitLimit: "Submission limit reached. Stop.",
  nudge: "You ended without calling submit_result. Call it now with the result of the work you did. Do not start over.",
  suspended: (n: number) =>
    `Your question #${n} is waiting for a human. End your turn now. Do not make further changes. You will be resumed with the answer.`,
} as const;

/** How long the selfbuilding MCP server has to say hello after the harness starts (spec §2.6.2). */
const HELLO_TIMEOUT_MS = 60_000;
/** SIGINT to SIGKILL after a post-submit stop (spec §4.5). */
const POST_SUBMIT_KILL_MS = 5_000;
const MAX_ASKS = 10;
const MAX_NOTIFIES = 20;
const DIFF_CAP_BYTES = 5 * 1024 * 1024;
// Caps on what one attempt collects from /selfbuilding/out/files; the host uploads each file it is given.
const OUT_FILES_MAX = 200;
const OUT_FILE_MAX_BYTES = 16 * 1024 * 1024;
const OUT_FILES_MAX_BYTES = 64 * 1024 * 1024;
const TICK_MS = 200;
const HEARTBEAT_MS = 15_000;
/** demo-path §9.3: the supervisor waits this long for the host's start-workflow handler. */
const START_WORKFLOW_TIMEOUT_MS = 30_000;

/**
 * Reads one file the agent may be racing to swap for a symlink (the supervisor is root). Opened without following
 * a final symlink, checked as a regular file on the open descriptor, and checked to still sit under `root` by the
 * path the kernel has for that descriptor, which also catches a parent directory swapped for a symlink.
 * Null: not a plain file under root. "skip": over `maxBytes` or `remaining`.
 */
export function readContained(abs: string, root: string, maxBytes: number, remaining: number): Buffer | null | "skip" {
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    let actual: string;
    try {
      actual = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      // No /proc (not Linux): the path as it resolves now.
      actual = fs.realpathSync(abs);
    }
    if (!actual.startsWith(`${root}${path.sep}`)) return null;
    if (st.size > maxBytes || st.size > remaining) return "skip";
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

function startWorkflowInputProblem(input: unknown): string | undefined {
  const issues = validateJsonSchema(START_WORKFLOW_INPUT_SCHEMA, input);
  return issues.length > 0 ? `\n${formatIssues(issues)}` : undefined;
}

/** The host's refusal as the model should read it: the WorkflowGuardError or ScriptInvalidError message. */
function hostError(status: number, json: unknown): string {
  const message = (json as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message === "string" ? message : `start_workflow failed: the host answered HTTP ${status}.`;
}

type StopReason =
  | "cancel"
  | "timeout"
  | "idle"
  | "budget"
  | "hello"
  | "mcp"
  | "submit_limit"
  | "submitted"
  | "suspended";

const STOP_PRIORITY: Record<StopReason, number> = {
  cancel: 9,
  timeout: 8,
  idle: 7,
  budget: 6,
  hello: 5,
  mcp: 5,
  submit_limit: 4,
  suspended: 2,
  submitted: 1,
};

interface TurnResult {
  exit: { code: number | null; signal: string | null };
  stopped?: StopReason;
  failure?: HarnessFailure;
  accepted: boolean;
  startFailure?: string;
}

interface SubmitRecord {
  headSha: string;
  treeSha: string;
  at: string;
}

export interface SuperviseOptions {
  layout: Layout;
  stepKey: string;
  attempt: number;
  launchId: string;
  /** The running bundle, for the runtime-stamp check. */
  bundlePath?: string;
  fetch?: Fetch;
  /** Keep retrying wakes after the outcome before exiting. Default true. */
  deliverWakes?: boolean;
}

function substitute(value: string, vars: Record<string, string>): string {
  return value.replace(/\{(sessionId|promptFile)\}/g, (match, key: string) => vars[key] ?? match);
}

export function wakeStatusFor(status: TerminalCallState, reason?: ErrorCode): WakeStatus {
  if (status === "succeeded") return "submitted";
  if (status === "timed_out") return "timeout";
  if (status === "cancelled") return "stopped";
  return reason === "no_result" ? "no_result" : "failed";
}

/** Formats an answer for the model (spec §8.2). */
export function formatAnswer(resolution: AskResolution, spec: AskSpec | undefined): string {
  const answer = resolution.answer;
  let value: string;
  if (answer.kind === "choice") {
    const choice = (spec?.choices ?? []).find((c) => (typeof c === "string" ? c : c.id) === answer.choiceId);
    const label = choice && typeof choice !== "string" && choice.label !== answer.choiceId ? ` (${choice.label})` : "";
    value = `choice "${answer.choiceId}"${label}`;
  } else if (answer.kind === "text") value = JSON.stringify(answer.text);
  else value = JSON.stringify(answer.value);
  const by = resolution.answeredBy;
  if (by.kind === "human") {
    const channel = by.channel.charAt(0).toUpperCase() + by.channel.slice(1);
    return `Answer from @${by.displayName} via ${channel}: ${value}.`;
  }
  if (by.kind === "auto") return `Answered automatically by ${by.model}: ${value}. Rationale: ${by.rationale}`;
  return `No human answered (${by.reason}); proceeding with the default: ${value}.`;
}

export class Supervisor {
  readonly attempt: AttemptLayout;
  readonly log: RuntimeLog;
  readonly redactor = new Redactor();
  readonly started = Date.now();
  spec!: RuntimeSpec;
  events!: EventSpool;
  state!: StateStore;
  wakes!: WakeSender;
  git!: Git;
  bootInfo: BootResult | undefined;

  #lock: TurnLock | undefined;
  #socket: ToolSocketServer | undefined;
  #ticker: NodeJS.Timeout | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  readonly #cancel = new AbortController();
  #cancelReason = "";

  // Per-attempt counters.
  #invalidSubmits = 0;
  #submissionCount = 0;
  #resultValid = false;
  #submitRecord: SubmitRecord | undefined;
  #asks = 0;
  #notifies = 0;
  #resumes = 0;
  #doneRetries = 0;
  #turns = 0;
  #usageDone = { input: 0, output: 0, cost: 0, priced: false };
  #usageTurn = { input: 0, output: 0, cost: 0 };
  #harnessVersion = "";

  // Per-turn state.
  #child: ChildProcess | undefined;
  #pgid: number | undefined;
  #turn: {
    stopped?: StopReason;
    accepted: boolean;
    helloSeen: boolean;
    spawnedAt: number;
    lastOutputAt: number;
    failure?: HarnessFailure;
    timers: NodeJS.Timeout[];
    postSubmitTools: { name: string; summary: string }[];
    suspendedAsk?: number;
  } = { accepted: false, helloSeen: false, spawnedAt: 0, lastOutputAt: 0, timers: [], postSubmitTools: [] };
  #waitingForAnswer = false;
  #turnEnding = false;

  constructor(private readonly opts: SuperviseOptions) {
    this.attempt = opts.layout.attempt(opts.stepKey, opts.attempt);
    this.log = new RuntimeLog(this.attempt.runtimeLog, this.redactor);
  }

  get layout(): Layout {
    return this.opts.layout;
  }

  /** The tree marker every harness process inherits; unique per box because the attempt path includes the root. */
  get marker(): string {
    return `${this.opts.launchId}.${createHash("sha256").update(this.attempt.dir).digest("hex").slice(0, 12)}`;
  }

  // ───────────────────────────── entry ─────────────────────────────

  async run(): Promise<number> {
    if (!isSafeName(this.opts.stepKey) || !isSafeName(this.opts.launchId)) {
      this.log.fatal("invalid --call or --launch");
      return RUNTIME_EXIT.config;
    }
    const spec = readJson<RuntimeSpec>(this.attempt.spec);
    const problem = this.#checkSpec(spec);
    if (problem || !spec) {
      this.log.fatal(`invalid spec.json: ${problem}`);
      return RUNTIME_EXIT.config;
    }
    this.spec = spec;
    this.#loadSecrets();
    if (exists(this.attempt.outcome)) {
      this.log.info("outcome already written; nothing to do");
      return RUNTIME_EXIT.ok;
    }
    const lock = await acquireTurnLock(this.layout.callLock);
    if (!lock) {
      this.log.info("call.lock is held by another supervisor; reattached, starting nothing");
      return RUNTIME_EXIT.ok;
    }
    this.#lock = lock;
    const previous = StateStore.read(this.attempt);
    this.state = new StateStore(this.layout, this.attempt, this.opts.launchId);
    this.events = new EventSpool(
      this.attempt.events,
      { runId: spec.runId, callPath: spec.callPath, launchId: this.opts.launchId, attempt: spec.attempt },
      this.redactor,
    );
    this.events.onEvent((event) => {
      this.state.setLastSeq(event.seq);
    });
    this.wakes = new WakeSender(
      this.attempt,
      {
        runId: spec.runId,
        stepKey: spec.stepKey,
        launchId: this.opts.launchId,
        ...(spec.callbackToken ? { callbackToken: spec.callbackToken } : {}),
      },
      this.log,
      this.opts.fetch,
    );
    this.git = new Git(this.layout.workdir, gitEnv(spec.git));
    this.#submissionCount = this.#countSubmissions();
    this.#resultValid = exists(this.attempt.result);

    if (previous?.launchId === this.opts.launchId && previous.harnessStartedAt) {
      // A turn of this launch already started and died: never start a second harness over it (spec §6.8).
      this.state.update({ phase: "interrupted", harnessStartedAt: previous.harnessStartedAt });
      this.events.emit(
        "state",
        { phase: "interrupted", reason: "the previous supervisor of this launch died mid-turn" },
        { level: "warn" },
      );
      this.log.warn("launch already ran a harness turn that died; marked interrupted");
      await lock.release();
      return RUNTIME_EXIT.ok;
    }

    writeAtomic(this.layout.supervisorPid, String(process.pid));
    this.state.update({ phase: "booting", pids: { supervisor: process.pid } });
    this.events.emit("state", { phase: "booting" });
    this.log.info(`supervise ${spec.callId} attempt ${spec.attempt} launch ${this.opts.launchId}`);
    this.#startTimers();
    try {
      return await this.#main();
    } finally {
      this.#stopTimers();
      await this.#socket?.close().catch(() => undefined);
      await this.#lock?.release();
    }
  }

  #checkSpec(spec: RuntimeSpec | undefined): string | undefined {
    if (!spec || typeof spec !== "object") return "missing or unreadable";
    if (spec.v !== 1) return `unsupported version ${String(spec.v)}`;
    if (spec.stepKey !== this.opts.stepKey) return `stepKey ${spec.stepKey} does not match --call ${this.opts.stepKey}`;
    if (spec.attempt !== this.opts.attempt)
      return `attempt ${spec.attempt} does not match --attempt ${this.opts.attempt}`;
    if (spec.launchId !== this.opts.launchId)
      return `launchId ${spec.launchId} does not match --launch ${this.opts.launchId}`;
    if (!spec.plan?.invocation?.argv?.length) return "plan.invocation.argv is empty";
    if (!spec.git || !spec.timeouts) return "git or timeouts missing";
    return undefined;
  }

  #loadSecrets(): void {
    this.redactor.add(this.spec.callbackToken);
    this.redactor.addEnv(process.env);
    const dir = this.layout.secrets;
    try {
      for (const name of fs.readdirSync(dir)) {
        const value = readText(path.join(dir, name));
        if (value !== undefined) this.redactor.add(value.trim());
      }
    } catch {
      // no secrets dir
    }
    for (const file of Object.values(this.spec.plan.secretEnv ?? {}))
      this.redactor.add(readText(this.layout.map(file))?.trim());
  }

  #countSubmissions(): number {
    try {
      return fs.readdirSync(this.attempt.submissions).filter((f) => /^\d+\.json$/.test(f)).length;
    } catch {
      return 0;
    }
  }

  #startTimers(): void {
    this.#heartbeat = setInterval(() => this.state.update(), HEARTBEAT_MS);
    this.#ticker = setInterval(() => this.#tick(), TICK_MS);
  }

  #stopTimers(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#ticker) clearInterval(this.#ticker);
  }

  #tick(): void {
    if (!this.#cancel.signal.aborted && exists(this.attempt.cancel)) {
      const sentinel = readJson<CancelSentinel>(this.attempt.cancel);
      this.#cancelReason = sentinel?.reason ?? "cancelled";
      this.log.info(`cancel sentinel found: ${this.#cancelReason}`);
      this.#cancel.abort();
      if (this.#child) this.#stop("cancel");
    }
    if (this.wakes.hasPending()) void this.wakes.flush();
    if (!this.#child) return;
    const now = Date.now();
    if (this.#waitingForAnswer) return;
    if (this.state.activeMs() > this.spec.timeouts.callMs) this.#stop("timeout");
    else if (now - this.#turn.lastOutputAt > this.spec.timeouts.idleMs) this.#stop("idle");
    else if (!this.#turn.helloSeen && now - this.#turn.spawnedAt > HELLO_TIMEOUT_MS) this.#stop("hello");
  }

  // ───────────────────────────── the call ─────────────────────────────

  async #main(): Promise<number> {
    if (this.#cancel.signal.aborted || exists(this.attempt.cancel)) {
      this.#cancelReason ||= readJson<CancelSentinel>(this.attempt.cancel)?.reason ?? "cancelled";
      return this.#finish("cancelled", "aborted", `Cancelled before boot: ${this.#cancelReason}`);
    }
    const bootDeadline = this.started + this.spec.timeouts.bootMs;
    const booted = await boot({
      layout: this.layout,
      attempt: this.attempt,
      spec: this.spec,
      events: this.events,
      log: this.log,
      redactor: this.redactor,
      baseEnv: this.#baseEnv(),
      bootLeftMs: () => bootDeadline - Date.now(),
      signal: this.#cancel.signal,
      ...(this.opts.bundlePath ? { bundlePath: this.opts.bundlePath } : {}),
    });
    if (!booted.ok) return this.#bootFailed(booted.failure);
    this.bootInfo = booted.value;
    this.#harnessVersion = booted.value.harnessVersion;
    this.state.update({ isolation: booted.value.isolation });

    this.#socket = new ToolSocketServer(this.layout.toolSocket, {
      hello: (pid) => {
        this.#turn.helloSeen = true;
        this.log.info(`selfbuilding-mcp hello from pid ${pid}`);
      },
      tool: (tool, input) => this.#tool(tool, input),
    });
    try {
      await this.#socket.listen();
    } catch (error) {
      return this.#bootFailed({
        reason: "harness_start",
        message: `The tool socket could not start: ${String(error)}`,
        phase: "harness",
      });
    }
    return this.#turnLoop();
  }

  async #bootFailed(failure: Failure): Promise<number> {
    this.log.error(`boot failed in ${failure.phase ?? "?"}: ${failure.message}`);
    if (failure.reason === "aborted")
      return this.#finish("cancelled", "aborted", `Cancelled during boot: ${this.#cancelReason}`);
    if (failure.exitCode === RUNTIME_EXIT.generationMismatch || failure.exitCode === RUNTIME_EXIT.transient) {
      // The host re-provisions or retries the boot; this attempt is not over.
      this.state.update({ phase: "booting" });
      await this.wakes.notify("failed");
      return failure.exitCode;
    }
    const code = await this.#finish("failed", failure.reason, failure.message);
    return failure.exitCode ?? code;
  }

  async #turnLoop(): Promise<number> {
    let next: { kind: "fresh" } | { kind: "resume"; message?: string } = this.spec.resumeSessionId
      ? { kind: "resume" }
      : { kind: "fresh" };
    for (;;) {
      if (this.#cancel.signal.aborted) return this.#finishCancelled();
      if (this.state.activeMs() > this.spec.timeouts.callMs) return this.#finishTimedOut("timeout");
      const result = await this.#runTurn(next);
      if (result.startFailure) return this.#finish("failed", "harness_start", result.startFailure);
      switch (result.stopped) {
        case "cancel":
          return this.#finishCancelled();
        case "timeout":
        case "idle":
          return this.#finishTimedOut(result.stopped);
        case "budget":
          return this.#finish("failed", "budget", `The agent's budget of $${this.spec.budgetUsd} was used up.`);
        case "hello":
          return this.#finish(
            "failed",
            "harness_start",
            "selfbuilding MCP server did not connect: no hello within 60 s of the harness start.",
          );
        case "mcp":
          return this.#finish(
            "failed",
            "harness_start",
            `selfbuilding MCP server did not connect: ${result.failure?.message ?? "reported failed"}`,
          );
        case "suspended":
          return this.#suspend();
        default:
          break;
      }
      if (result.accepted && this.#submitRecord) {
        const reverted = this.#postSubmitCheck();
        if (reverted === "failed")
          return this.#finish("failed", "harness_error", "Could not restore the tree the accepted result describes.");
      }
      if (result.failure && !result.accepted && !this.#resultValid) {
        const failure = result.failure;
        return this.#finish("failed", "harness_error", `The harness reported ${failure.code}: ${failure.message}`, {
          failure,
        });
      }
      if (!this.#resultValid) {
        if (this.#invalidSubmits >= this.spec.maxSubmitAttempts || result.stopped === "submit_limit") {
          return this.#finish(
            "failed",
            "result_invalid",
            `submit_result was rejected ${this.#invalidSubmits} times; the submission limit was reached.`,
          );
        }
        const crashed =
          result.exit.code !== 0 && result.exit.code !== null
            ? result.exit.code !== 130
            : result.exit.signal !== null && result.exit.signal !== "SIGINT";
        if (crashed) {
          const how = result.exit.signal ? `signal ${result.exit.signal}` : `exit code ${result.exit.code}`;
          const stderr = this.redactor.text(tailFile(this.attempt.harnessStderr, 2048)).trim();
          return this.#finish(
            "failed",
            "interrupted",
            `The harness died mid-turn (${how}) without a result.${stderr ? `\n${stderr}` : ""}`,
          );
        }
        if (this.#resumes < this.spec.maxResumes && this.#canResume()) {
          this.#resumes++;
          this.events.emit("nudge", { reason: "no_result", resumes: this.#resumes });
          next = { kind: "resume", message: MESSAGES.nudge };
          continue;
        }
        return this.#finish("failed", "no_result", "The harness ended without a valid submit_result.");
      }
      const settled = await this.#settle();
      if (settled.kind === "retry") {
        next = { kind: "resume", message: settled.message };
        continue;
      }
      return settled.code;
    }
  }

  #canResume(): boolean {
    return this.spec.plan.resume !== undefined && this.#sessionId() !== undefined;
  }

  #sessionId(): string | undefined {
    return (
      this.state.value.sessionId ??
      this.spec.resumeSessionId ??
      this.spec.sessionId ??
      this.spec.plan.invocation.sessionId
    );
  }

  // ───────────────────────────── one turn ─────────────────────────────

  #baseEnv(): Record<string, string> {
    const env = gitEnv(this.spec.git, {
      HOME: this.layout.home,
      LANG: process.env.LANG ?? "C.UTF-8",
      [RUNTIME_ENV.runId]: this.spec.runId,
    });
    env.LC_ALL = env.LANG ?? "C.UTF-8";
    if (this.layout.root) {
      env[RUNTIME_ENV.fsRoot] = this.layout.root;
      env.TMPDIR = this.layout.host("/tmp");
    } else env.TMPDIR = "/tmp";
    return env;
  }

  #harnessEnv(invocation: Invocation, cwd: string): Record<string, string> {
    const env: Record<string, string> = {
      ...this.#baseEnv(),
      PWD: cwd,
      [TREE_MARKER_ENV]: this.marker,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: this.bootInfo?.hooksDir ?? "",
      ...invocation.env,
    };
    for (const [name, file] of Object.entries(this.spec.plan.secretEnv ?? {})) {
      const value = readText(this.layout.map(file));
      if (value !== undefined) {
        env[name] = value.replace(/\r?\n$/, "");
        this.redactor.add(env[name]);
      }
    }
    for (const name of this.spec.plan.stripEnv ?? []) delete env[name];
    return env;
  }

  #invocationFor(next: { kind: "fresh" } | { kind: "resume"; message?: string }): Invocation | string {
    const plan = this.spec.plan;
    if (next.kind === "fresh") return plan.invocation;
    if (!plan.resume) return "The harness cannot resume a session (plan.resume is absent).";
    const sessionId = this.#sessionId();
    if (!sessionId) return "No session id is known to resume.";
    let promptFile = `${SANDBOX_PATHS.in}/prompt.md`;
    if (next.message !== undefined) {
      promptFile = `${SANDBOX_PATHS.in}/turn-${this.state.value.turnIndex + 1}.md`;
      writeAtomic(this.layout.host(promptFile), next.message);
    }
    const vars = { sessionId, promptFile };
    const r = plan.resume;
    return {
      argv: r.argv.map((a) => substitute(a, vars)),
      env: Object.fromEntries(Object.entries(r.env ?? {}).map(([k, v]) => [k, substitute(v, vars)])),
      cwd: substitute(r.cwd, vars),
      ...(r.stdinFile ? { stdinFile: substitute(r.stdinFile, vars) } : {}),
      sessionId,
    };
  }

  async #runTurn(next: { kind: "fresh" } | { kind: "resume"; message?: string }): Promise<TurnResult> {
    const invocation = this.#invocationFor(next);
    if (typeof invocation === "string")
      return { exit: { code: null, signal: null }, accepted: false, startFailure: invocation };
    const cwd = this.layout.map(invocation.cwd || SANDBOX_PATHS.workdir);
    const env = this.#harnessEnv(invocation, cwd);
    const turnIndex =
      this.#turns === 0
        ? Math.max(this.state.value.turnIndex, this.spec.turnIndexBase)
        : this.state.value.turnIndex + 1;
    this.#turns++;
    this.#turn = {
      accepted: false,
      helloSeen: false,
      spawnedAt: Date.now(),
      lastOutputAt: Date.now(),
      timers: [],
      postSubmitTools: [],
    };
    this.#usageTurn = { input: 0, output: 0, cost: 0 };
    const parser = parserFor(this.spec.plan.streamFormat, {
      runId: this.spec.runId,
      callPath: this.spec.callPath,
      attempt: this.spec.attempt,
    });
    if (!parser)
      return {
        exit: { code: null, signal: null },
        accepted: false,
        startFailure: `No bundled parser for stream format "${this.spec.plan.streamFormat}".`,
      };
    if (invocation.sessionId && !this.state.value.sessionId) this.state.update({ sessionId: invocation.sessionId });

    let stdin: number | "ignore" = "ignore";
    if (invocation.stdinFile) {
      try {
        stdin = fs.openSync(this.layout.map(invocation.stdinFile), "r");
      } catch (error) {
        return {
          exit: { code: null, signal: null },
          accepted: false,
          startFailure: `The prompt file could not be opened: ${String(error)}`,
        };
      }
    }
    const stderrLog = fs.openSync(this.attempt.harnessStderr, "a");
    const isolated = this.bootInfo?.isolation === "isolated";
    let child: ChildProcess;
    try {
      child = spawn(invocation.argv[0] as string, invocation.argv.slice(1), {
        cwd,
        env,
        detached: true,
        stdio: [stdin, "pipe", "pipe"],
        ...(isolated ? { uid: this.bootInfo?.agentUid, gid: this.bootInfo?.agentGid } : {}),
      });
    } catch (error) {
      if (typeof stdin === "number") fs.closeSync(stdin);
      fs.closeSync(stderrLog);
      return {
        exit: { code: null, signal: null },
        accepted: false,
        startFailure: `The harness could not start: ${String(error)}`,
      };
    }
    if (typeof stdin === "number") fs.closeSync(stdin);
    this.#child = child;
    this.#pgid = child.pid;
    this.state.update({
      phase: "running",
      turnIndex,
      harnessStartedAt: new Date().toISOString(),
      pids: { supervisor: process.pid, ...(child.pid ? { harness: child.pid, harnessPgid: child.pid } : {}) },
    });
    this.events.emit("state", { phase: "running" });
    this.events.emit(
      "turn.started",
      { turnIndex, mode: next.kind, argv0: path.basename(invocation.argv[0] as string) },
      { turnIndex },
    );
    this.log.info(`turn ${turnIndex} started (${next.kind}), pid ${child.pid}`);

    const emitHarness = (event: HarnessEvent) => this.#onHarnessEvent(event, turnIndex);
    const splitter = new LineSplitter(
      (line) => {
        let parsed: HarnessEvent[] = [];
        try {
          parsed = parser.line(line);
        } catch (error) {
          this.events.emit("warning", { scope: "parser", message: String(error) }, { level: "warn" });
        }
        for (const event of parsed) emitHarness(event);
      },
      (bytes) => emitHarness({ type: "warning", message: `dropped a ${bytes}-byte line longer than 4 MiB` }),
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      this.#turn.lastOutputAt = Date.now();
      splitter.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#turn.lastOutputAt = Date.now();
      fs.writeSync(stderrLog, chunk);
    });

    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      let exitInfo: { code: number | null; signal: string | null } | undefined;
      let done = false;
      const finish = () => {
        if (done || !exitInfo) return;
        done = true;
        resolve(exitInfo);
      };
      child.on("error", (error) => {
        fs.writeSync(stderrLog, `${String(error)}\n`);
        exitInfo ??= { code: 127, signal: null };
        finish();
      });
      child.on("exit", (code, signal) => {
        exitInfo = { code, signal };
        // Descendants may hold stdout open after the harness exits (spec §6.11 exit quiet).
        const quiet = setTimeout(() => {
          this.log.warn("harness exited but its descendants hold stdout; killing the tree");
          this.#killTree("SIGKILL");
          finish();
        }, this.spec.timeouts.exitQuietMs);
        quiet.unref();
        this.#turn.timers.push(quiet);
      });
      child.on("close", () => finish());
    });
    splitter.end();
    // What the exit implies is not a stream error: a crash is judged from the exit itself.
    this.#turnEnding = true;
    for (const event of parser.end(exit)) emitHarness(event);
    this.#turnEnding = false;
    for (const timer of this.#turn.timers) clearTimeout(timer);
    fs.closeSync(stderrLog);
    // The whole tree goes before anything reads the tree or the result (spec §2.7.2).
    this.#killTree("SIGKILL");
    this.#child = undefined;
    this.#waitingForAnswer = false;
    const sessionId = parser.sessionId();
    if (sessionId && sessionId !== this.state.value.sessionId) this.state.update({ sessionId });
    this.#usageDone.input += this.#usageTurn.input;
    this.#usageDone.output += this.#usageTurn.output;
    this.#usageDone.cost += this.#usageTurn.cost;
    this.events.emit(
      "turn.ended",
      {
        turnIndex,
        exitCode: exit.code,
        signal: exit.signal,
        ...(this.#turn.stopped ? { stoppedBy: this.#turn.stopped } : {}),
      },
      { turnIndex },
    );
    this.log.info(
      `turn ${turnIndex} ended: code ${exit.code} signal ${exit.signal} stopped ${this.#turn.stopped ?? "-"}`,
    );
    return {
      exit,
      accepted: this.#turn.accepted,
      ...(this.#turn.stopped ? { stopped: this.#turn.stopped } : {}),
      ...(this.#turn.failure ? { failure: this.#turn.failure } : {}),
    };
  }

  #onHarnessEvent(event: HarnessEvent, turnIndex: number): void {
    if (event.type === "session.started") {
      if (event.sessionId && event.sessionId !== this.state.value.sessionId)
        this.state.update({ sessionId: event.sessionId });
      const own = event.mcp?.find((s) => s.name === "selfbuilding");
      if (own?.status === "connected") this.#turn.helloSeen = true;
      else if (own && own.status === "failed") {
        this.#turn.failure = { code: "harness_crash", retryable: false, message: own.error ?? `status ${own.status}` };
        this.#stop("mcp");
      }
    } else if (event.type === "usage") {
      const cost = event.costUsd ?? 0;
      if (event.cumulative) this.#usageTurn = { input: event.inputTokens, output: event.outputTokens, cost };
      else
        this.#usageTurn = {
          input: this.#usageTurn.input + event.inputTokens,
          output: this.#usageTurn.output + event.outputTokens,
          cost: this.#usageTurn.cost + cost,
        };
      if (event.costUsd !== undefined) this.#usageDone.priced = true;
      const budget = this.spec.budgetUsd;
      if (budget !== undefined && this.#usageDone.cost + this.#usageTurn.cost > budget) this.#stop("budget");
    } else if (event.type === "error" && !this.#turnEnding) {
      this.#turn.failure ??= event.failure;
    } else if (event.type === "tool.started" && this.#turn.accepted && event.effect === "effect") {
      this.#turn.postSubmitTools.push({ name: event.name, summary: event.summary });
    }
    const { type, ...data } = event;
    this.events.emit(`harness.${type}`, data as Record<string, unknown>, {
      turnIndex,
      level: type === "error" ? "error" : type === "warning" ? "warn" : "info",
      ...(this.state.value.sessionId ? { sessionId: this.state.value.sessionId } : {}),
    });
  }

  /** Stops the running harness. Post-submit stops wait out the grace window first (spec §4.5). */
  #stop(reason: StopReason): void {
    if (!this.#child) return;
    const current = this.#turn.stopped;
    if (current && STOP_PRIORITY[current] >= STOP_PRIORITY[reason]) return;
    const escalating = current !== undefined;
    this.#turn.stopped = reason;
    this.log.info(`stopping the harness: ${reason}`);
    const graceful = reason === "submitted" || reason === "suspended" || reason === "submit_limit";
    if (graceful && !escalating) {
      const grace = setTimeout(() => {
        if (!this.#child) return;
        this.#interrupt();
        const kill = setTimeout(() => this.#killTree("SIGKILL"), POST_SUBMIT_KILL_MS);
        kill.unref();
        this.#turn.timers.push(kill);
      }, this.spec.timeouts.postSubmitGraceMs);
      grace.unref();
      this.#turn.timers.push(grace);
      return;
    }
    // SIGINT first: some harnesses record nothing on SIGTERM (spec §6.10).
    this.#interrupt();
    const kill = setTimeout(() => this.#killTree("SIGKILL"), this.spec.timeouts.cancelGraceMs);
    kill.unref();
    this.#turn.timers.push(kill);
  }

  #interrupt(): void {
    if (this.#pgid !== undefined) signalGroup(this.#pgid, "SIGINT");
  }

  #killTree(signal: NodeJS.Signals): void {
    const pgid = this.#pgid;
    if (this.bootInfo?.containment === "ns-reap") {
      const args = [
        "kill",
        "--marker",
        this.marker,
        "--signal",
        signal,
        ...(pgid !== undefined ? ["--pgid", String(pgid)] : []),
      ];
      const run = spawnSync(this.layout.nsReap, args, { encoding: "utf8", timeout: 10_000 });
      if (run.status === 0) return;
      this.log.warn(`ns-reap failed (${run.status}): ${(run.stderr ?? "").trim()}; killing the process group`);
    }
    if (pgid !== undefined) signalGroup(pgid, signal);
  }

  // ───────────────────────────── tools ─────────────────────────────

  async #tool(tool: ToolName, input: unknown): Promise<ToolReply> {
    switch (tool) {
      case "submit_result":
        return this.#submit(input);
      case "ask_human":
        return this.#askHuman(input);
      case "notify_human":
        return this.#notify(input);
      case "start_workflow":
        return this.#startWorkflow(input);
      case "get_workflow_status":
        return this.#workflowStatus(input);
    }
  }

  // ───────────────────────── start_workflow (docs/spec/demo-path.md §9) ─────────────────────────

  /** POSTs to the host's start-workflow handler with the root-only grant; the agent never sees the grant. */
  async #workflowRequest(
    method: "POST" | "GET",
    body: unknown,
    query?: Record<string, string>,
  ): Promise<{ status: number; json: unknown } | ToolReply> {
    const target = this.spec.startWorkflow;
    if (!target) return { content: "start_workflow is not available in this sandbox.", isError: true };
    const grant = readText(this.layout.host(SANDBOX_PATHS.startGrant))?.trim();
    if (!grant)
      return { content: "start_workflow has no grant in this sandbox; it cannot launch runs.", isError: true };
    this.redactor.add(grant);
    const url = new URL(target.url);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(START_WORKFLOW_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = (error as Error).name === "TimeoutError" ? "timed out after 30 s" : (error as Error).message;
      this.log.warn(`start_workflow: ${url.origin} unreachable: ${reason}`);
      return {
        content: `start_workflow failed: this sandbox has no network path to the host (${reason}).`,
        isError: true,
      };
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  }

  async #startWorkflow(input: unknown): Promise<ToolReply> {
    const problem = startWorkflowInputProblem(input);
    if (problem) return { content: `start_workflow input is invalid: ${problem}`, isError: true };
    const reply = await this.#workflowRequest("POST", input);
    if ("content" in reply) return reply;
    const receipt = reply.json as StartWorkflowReceipt | undefined;
    if (reply.status !== 200 || !receipt || typeof receipt.runId !== "string") {
      return { content: hostError(reply.status, reply.json), isError: true };
    }
    const req = input as StartWorkflowRequest;
    this.events.emit("workflow.started", {
      runId: receipt.runId,
      status: receipt.status,
      host: receipt.host,
      name: req.name,
      size: req.size ?? "small",
    });
    return { content: receiptText(receipt), isError: false };
  }

  async #workflowStatus(input: unknown): Promise<ToolReply> {
    const runId = (input as { runId?: unknown } | null)?.runId;
    if (typeof runId !== "string" || !runId) return { content: "get_workflow_status needs a `runId`.", isError: true };
    const reply = await this.#workflowRequest("GET", undefined, { runId });
    if ("content" in reply) return reply;
    if (reply.status !== 200) return { content: hostError(reply.status, reply.json), isError: true };
    return { content: JSON.stringify(reply.json), isError: false };
  }

  #submit(input: unknown): ToolReply {
    if (this.#turn.stopped === "submit_limit" || this.#invalidSubmits >= this.spec.maxSubmitAttempts) {
      this.#stop("submit_limit");
      return { content: MESSAGES.submitLimit, isError: true };
    }
    const n = ++this.#submissionCount;
    const serialised = JSON.stringify(input ?? null);
    const size = Buffer.byteLength(serialised);
    const issues =
      size > this.spec.maxResultBytes
        ? [
            {
              pointer: "",
              expected: `a result of at most ${this.spec.maxResultBytes} bytes`,
              received: `${size} bytes`,
            },
          ]
        : validateJsonSchema(this.spec.resultSchema, input);
    const valid = issues.length === 0;
    const at = new Date().toISOString();
    let record: SubmitRecord | undefined;
    if (valid) {
      const headSha = this.git.head();
      const treeSha = this.git.worktreeTree();
      if (headSha && treeSha) record = { headSha, treeSha, at };
    }
    writeJsonAtomic(path.join(this.attempt.submissions, `${n}.json`), {
      n,
      at,
      valid,
      ...(valid ? {} : { issues }),
      ...(record ? { submitTree: record } : {}),
      input: this.redactor.value(input),
    });
    this.events.emit(
      "result.submitted",
      { attempt: n, valid, ...(valid ? {} : { issues }) },
      { level: valid ? "info" : "warn" },
    );
    if (!valid) {
      this.#invalidSubmits++;
      const content = `submit_result was rejected:\n${formatIssues(issues)}\n${MESSAGES.fixAndRetry}`;
      if (this.#invalidSubmits >= this.spec.maxSubmitAttempts) {
        return { content: `${content}\nThis was the last allowed attempt.`, isError: true };
      }
      return { content, isError: true };
    }
    writeAtomic(this.attempt.result, serialised, 0o644);
    this.#resultValid = true;
    this.#turn.accepted = true;
    if (record) {
      this.#submitRecord = record;
      this.state.update({ submitTree: record });
    }
    this.#stop("submitted");
    return { content: MESSAGES.accepted, isError: false };
  }

  async #askHuman(input: unknown): Promise<ToolReply> {
    const spec = input as AskSpec;
    if (!spec || typeof spec !== "object" || typeof spec.question !== "string" || !spec.question.trim()) {
      return { content: "ask_human needs a non-empty `question` string.", isError: true };
    }
    if (spec.question.length > 2000)
      return { content: "The question is longer than 2,000 characters; shorten it.", isError: true };
    if (this.#asks >= MAX_ASKS) {
      return {
        content: `You have asked ${MAX_ASKS} questions in this call; decide for yourself and continue.`,
        isError: true,
      };
    }
    this.#asks++;
    const askSeq = this.state.value.askSeq + 1;
    this.state.pauseClock();
    this.#waitingForAnswer = true;
    fs.mkdirSync(this.attempt.inbox, { recursive: true });
    writeAtomic(this.attempt.inboxOpen, String(askSeq));
    this.state.update({ phase: "waiting", askSeq, pendingAsk: { askSeq, spec } });
    this.events.emit("state", { phase: "waiting" });
    this.events.emit("ask", { askSeq, spec });
    void this.wakes.notify("ask");

    const hotLimit = Math.min(this.spec.hotWaitMs, this.spec.timeouts.mcpToolMs - 15_000);
    const canGoCold = this.#canResume();
    const deadline = Date.now() + (hotLimit < 30_000 && canGoCold ? 0 : Math.max(0, hotLimit));
    for (;;) {
      const answer = this.#takeAnswer(askSeq);
      if (answer) {
        this.#closeAsk();
        this.events.emit("ask.answered", { askSeq, askId: answer.askId });
        return { content: formatAnswer(answer.resolution, spec), isError: false };
      }
      if (this.#cancel.signal.aborted || !this.#child) {
        this.#closeAsk();
        return { content: "The call was stopped while waiting for an answer.", isError: true };
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    }
    fs.rmSync(this.attempt.inboxOpen, { force: true });
    if (!canGoCold) {
      this.#closeAsk();
      this.events.emit("ask.expired", { askSeq }, { level: "warn" });
      return { content: "No human answered in time. Decide for yourself and continue.", isError: true };
    }
    // Cold wait (spec §8.4): the turn ends and the answer arrives as the first message of a resumed turn.
    this.#turn.suspendedAsk = askSeq;
    this.events.emit("ask.suspended", { askSeq });
    this.#stop("suspended");
    return { content: MESSAGES.suspended(askSeq), isError: false, suspended: true };
  }

  #takeAnswer(askSeq: number): InboxAnswer | undefined {
    let names: string[];
    try {
      names = fs.readdirSync(this.attempt.inbox).filter((n) => n.endsWith(".json"));
    } catch {
      return undefined;
    }
    for (const name of names.sort()) {
      const file = path.join(this.attempt.inbox, name);
      const answer = readJson<InboxAnswer>(file);
      const taken = file.replace(/\.json$/, ".taken");
      if (!answer?.resolution || this.state.value.pendingAsk?.askSeq !== askSeq) {
        this.events.emit("skip", { reason: "ask-not-open", file: name }, { level: "warn" });
        fs.renameSync(file, `${taken}.ignored`);
        continue;
      }
      fs.renameSync(file, taken);
      return { askId: answer.askId ?? name.slice(0, -5), resolution: answer.resolution };
    }
    return undefined;
  }

  #closeAsk(): void {
    fs.rmSync(this.attempt.inboxOpen, { force: true });
    this.#waitingForAnswer = false;
    this.#turn.lastOutputAt = Date.now();
    this.state.resumeClock();
    this.state.update({ phase: "running", pendingAsk: undefined });
    this.events.emit("state", { phase: "running" });
  }

  #notify(input: unknown): ToolReply {
    const message = (input as { message?: unknown } | null)?.message;
    if (typeof message !== "string" || !message.trim())
      return { content: "notify_human needs a non-empty `message` string.", isError: true };
    if (this.#notifies >= MAX_NOTIFIES) return { content: "Notification limit reached for this call.", isError: true };
    this.#notifies++;
    const level = (input as { level?: unknown }).level === "warning" ? "warning" : "info";
    this.events.emit("notify", { message, level });
    return { content: "Sent.", isError: false };
  }

  // ───────────────────────────── settling ─────────────────────────────

  /** Compares the tree with the accepted submit's tree and applies postSubmitChanges (spec §4.5.1). */
  #postSubmitCheck(): "unchanged" | "reverted" | "kept" | "failed" {
    const record = this.#submitRecord;
    if (!record || !this.git.isRepo()) return "unchanged";
    const head = this.git.head();
    const tree = this.git.worktreeTree();
    if (head === record.headSha && tree === record.treeSha) return "unchanged";
    const patchParts: string[] = [];
    if (tree) patchParts.push(diffBinary(this.git, record.treeSha, tree));
    const commits =
      head && head !== record.headSha
        ? this.git
            .run(["log", "--format=%H %s", `${record.headSha}..${head}`])
            .stdout.trim()
            .split("\n")
            .filter(Boolean)
        : [];
    const files = tree
      ? this.git.run(["diff", "--name-only", record.treeSha, tree]).stdout.trim().split("\n").filter(Boolean)
      : [];
    const patchFile = path.join(this.attempt.artifacts, "post-submit.patch");
    writeAtomic(patchFile, this.redactor.text(patchParts.join("\n")));
    const action = this.spec.postSubmitChanges;
    this.events.emit(
      "post_submit_changes",
      { files, commits, patch: path.relative(this.attempt.dir, patchFile), tools: this.#turn.postSubmitTools, action },
      { level: "warn" },
    );
    this.#postSubmitPatch = path.relative(this.attempt.dir, patchFile);
    if (action === "keep") return "kept";
    try {
      this.git.restoreTo(record.headSha, record.treeSha);
      return "reverted";
    } catch (error) {
      this.log.error(
        `post-submit revert failed: ${error instanceof GitCommandFailure ? error.message : String(error)}`,
      );
      return "failed";
    }
  }

  #postSubmitPatch: string | undefined;
  #checks: NonNullable<Outcome["checks"]> = [];
  #autoCommitted = false;

  async #settle(): Promise<{ kind: "retry"; message: string } | { kind: "done"; code: number }> {
    this.state.update({ phase: "settling" });
    this.events.emit("state", { phase: "settling" });
    const result = readJson<unknown>(this.attempt.result);
    const status = (result as { status?: unknown } | null)?.status;
    const claimsDone = status === undefined || status === "done";
    const baseSha = this.bootInfo?.baseSha ?? "";
    this.#checks = [];
    const done = (code: number) => ({ kind: "done" as const, code });

    if (this.spec.artifactsBranch === "forbidden" || this.spec.git.readOnly) {
      const ahead = this.spec.git.readOnly ? 0 : this.git.commitsAhead(baseSha);
      const dirty = this.git.dirty();
      if (this.spec.artifactsBranch === "forbidden" && (ahead > 0 || dirty)) {
        this.#checks.push({ id: "branch", ok: false, verified: true });
        return done(
          await this.#finish(
            "failed",
            "done_check_failed",
            `This agent may not change the repository, but it left ${ahead} new commit(s)${dirty ? " and uncommitted changes" : ""}.`,
            { result },
          ),
        );
      }
    }

    if (claimsDone && this.spec.doneChecks.length > 0) {
      const failed = await this.#runDoneChecks(baseSha);
      if (this.#cancel.signal.aborted) return done(await this.#finishCancelled());
      if (failed) return this.#doneFailure(failed.id, failed.feedback, failed.output, result);
    }

    if (this.spec.git.commitLeftovers && !this.spec.git.readOnly && this.spec.artifactsBranch !== "forbidden") {
      try {
        const sha = this.git.commitAll(
          `selfbuilding: uncommitted changes from ${this.spec.agentName}`,
          this.spec.git.trailers,
        );
        if (sha) {
          this.#autoCommitted = true;
          this.events.emit("git.leftovers_committed", { sha });
        }
      } catch (error) {
        this.log.error(`leftover commit failed: ${error instanceof GitCommandFailure ? error.message : String(error)}`);
      }
    }

    if (claimsDone && this.spec.artifactsBranch === "required") {
      const ahead = this.git.commitsAhead(baseSha);
      const ok = ahead > 0;
      this.#checks.push({ id: "branch", ok, verified: true });
      if (!ok) {
        return this.#doneFailure(
          "branch",
          "Done check `branch` failed: the branch has no commits ahead of its base. Commit your work, then call submit_result again.",
          "no commits ahead of base",
          result,
        );
      }
    }
    return done(await this.#finish("succeeded", undefined, undefined, { result }));
  }

  async #doneFailure(
    id: string,
    feedback: string,
    output: string,
    result: unknown,
  ): Promise<{ kind: "retry"; message: string } | { kind: "done"; code: number }> {
    if (this.#doneRetries < this.spec.maxDoneRetries && this.#canResume()) {
      this.#doneRetries++;
      this.events.emit("done_check.retry", { id, retries: this.#doneRetries });
      // The new submission replaces the old one.
      fs.rmSync(this.attempt.result, { force: true });
      this.#resultValid = false;
      this.#submitRecord = undefined;
      return { kind: "retry", message: feedback };
    }
    return {
      kind: "done",
      code: await this.#finish("failed", "done_check_failed", `Done check \`${id}\` failed.\n${output}`, { result }),
    };
  }

  async #runDoneChecks(baseSha: string): Promise<{ id: string; feedback: string; output: string } | undefined> {
    let swap: ReturnType<typeof swapProtected> | undefined;
    try {
      swap = baseSha ? swapProtected(this.git, baseSha, this.spec.protect, this.attempt.protected) : undefined;
    } catch (error) {
      this.log.warn(`protected paths could not be swapped: ${String(error)}`);
    }
    const protectedChanged = swap?.allowedChanged ?? [];
    try {
      for (const check of this.spec.doneChecks) {
        const logFile = path.join(this.attempt.hooks, `check-${check.id.replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
        this.events.emit("done_check.started", { id: check.id, cmd: check.cmd });
        const run = await runCommand(this.layout.mapCommand(check.cmd), {
          cwd: check.cwd ? path.resolve(this.layout.workdir, this.layout.map(check.cwd)) : this.layout.workdir,
          env: this.#baseEnv(),
          ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
          logFile,
          signal: this.#cancel.signal,
          ...(this.bootInfo?.isolation === "isolated"
            ? { uid: this.bootInfo.agentUid, gid: this.bootInfo.agentGid }
            : {}),
        });
        const expected = check.expectExit ?? 0;
        const ok = !run.timedOut && run.code === expected;
        this.#checks.push({
          id: check.id,
          ok,
          verified: true,
          ...(protectedChanged.length ? { protectedChanged } : {}),
        });
        const output = this.redactor.text(run.tail);
        this.events.emit(
          "done_check.finished",
          { id: check.id, ok, exitCode: run.code, timedOut: run.timedOut },
          { level: ok ? "info" : "warn" },
        );
        if (run.cancelled) return { id: check.id, feedback: "", output: "cancelled" };
        if (!ok) {
          const how = run.timedOut ? `timed out after ${check.timeoutMs} ms` : `exited ${run.code ?? run.signal}`;
          const lines = [`Done check \`${check.id}\` failed: \`${check.cmd}\` ${how}.`, output];
          if (swap && swap.restored.length > 0)
            lines.push(
              `These protected paths were restored from the base commit for the check: ${swap.restored.join(", ")}.`,
            );
          lines.push("Fix the problem and call submit_result again.");
          return { id: check.id, feedback: lines.join("\n"), output };
        }
      }
      return undefined;
    } finally {
      swap?.undo();
    }
  }

  // ───────────────────────────── endings ─────────────────────────────

  async #suspend(): Promise<number> {
    this.state.pauseClock();
    this.state.update({ phase: "suspended" });
    this.events.emit("state", { phase: "suspended", askSeq: this.#turn.suspendedAsk, sessionId: this.#sessionId() });
    this.log.info("turn ended for a cold wait; the call is suspended");
    await this.wakes.notify("ask");
    return RUNTIME_EXIT.ok;
  }

  #wip(reason: string): void {
    if (this.spec.git.readOnly || this.spec.artifactsBranch === "forbidden" || !this.git.isRepo()) return;
    try {
      const sha = this.git.commitAll(
        `selfbuilding: WIP (${reason}) from ${this.spec.agentName}`,
        this.spec.git.trailers,
      );
      if (sha) {
        this.#autoCommitted = true;
        this.events.emit("git.wip_committed", { sha, reason });
      }
    } catch (error) {
      this.log.error(`WIP commit failed: ${error instanceof GitCommandFailure ? error.message : String(error)}`);
    }
  }

  #finishCancelled(): Promise<number> {
    this.#wip("cancelled");
    return this.#finish("cancelled", "aborted", `Cancelled: ${this.#cancelReason || "cancelled"}`);
  }

  #finishTimedOut(which: "timeout" | "idle"): Promise<number> {
    this.#wip(which === "idle" ? "idle timeout" : "timeout");
    return which === "idle"
      ? this.#finish("timed_out", "idle_timeout", "The harness produced no output for timeouts.idle and was stopped.")
      : this.#finish(
          "timed_out",
          "timeout",
          "The call's active-time timeout passed. Continue from recovery with a new call on the same branch.",
        );
  }

  #usage(): Usage {
    const elapsed = Date.now() - this.started;
    return {
      usd: this.#usageDone.priced ? this.#usageDone.cost : null,
      inputTokens: this.#usageDone.input,
      outputTokens: this.#usageDone.output,
      turns: this.#turns,
      wallClockMs: elapsed,
      sandboxMs: elapsed,
    };
  }

  #artifacts(): NonNullable<Outcome["artifacts"]> {
    const artifacts: NonNullable<Outcome["artifacts"]> = {
      transcript: path.relative(this.attempt.dir, this.attempt.events),
    };
    const baseSha = this.bootInfo?.baseSha;
    if (baseSha && this.git.isRepo() && this.git.head()) {
      const diff = this.git.run(["diff", "--binary", baseSha, "HEAD"]);
      if (diff.code === 0) {
        const { text, truncatedBytes } = capBytes(this.redactor.text(diff.stdout), DIFF_CAP_BYTES);
        const file = path.join(this.attempt.artifacts, "diff.patch");
        writeAtomic(
          file,
          truncatedBytes > 0 ? `${text}\n# selfbuilding: diff truncated, ${truncatedBytes} bytes omitted\n` : text,
        );
        artifacts.diff = path.relative(this.attempt.dir, file);
      }
    }
    const logs = [this.attempt.runtimeLog, this.attempt.harnessStderr];
    try {
      for (const name of fs.readdirSync(this.attempt.hooks)) logs.push(path.join(this.attempt.hooks, name));
    } catch {
      // no hooks ran
    }
    artifacts.logs = logs.filter((file) => exists(file)).map((file) => path.relative(this.attempt.dir, file));
    if (this.#postSubmitPatch) artifacts.postSubmitPatch = this.#postSubmitPatch;
    const files = this.#collectOutFiles();
    if (files.length > 0) artifacts.files = files;
    return artifacts;
  }

  /**
   * Copies every regular file under /selfbuilding/out/files into the attempt's artifacts (spec §6 rule 6), so a
   * later call on the same box cannot change what this attempt reported. Text is redacted; binaries are copied as is.
   */
  #collectOutFiles(): string[] {
    const root = this.layout.host(`${SANDBOX_PATHS.out}/files`);
    const dest = path.join(this.attempt.artifacts, "files");
    const collected: string[] = [];
    const skipped: string[] = [];
    let total = 0;
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      return [];
    }
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(root, abs);
        // Symlinks are never followed: the agent could point one at a root-only file.
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        if (collected.length >= OUT_FILES_MAX) {
          skipped.push(rel);
          continue;
        }
        const read = readContained(abs, realRoot, OUT_FILE_MAX_BYTES, OUT_FILES_MAX_BYTES - total);
        if (read === "skip") {
          skipped.push(rel);
          continue;
        }
        if (read === null) continue;
        const size = read.length;
        let data: Buffer | string = read;
        let text = false;
        if (!read.includes(0)) {
          try {
            data = this.redactor.text(utf8.decode(read));
            text = true;
          } catch {
            // not UTF-8: copied unchanged, unless it carries a secret
          }
        }
        // latin1 maps each byte to one character, so a secret's bytes show up as its text.
        if (!text && this.redactor.text(read.toString("latin1")) !== read.toString("latin1")) {
          skipped.push(rel);
          continue;
        }
        const out = path.join(dest, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, data);
        total += size;
        collected.push(path.relative(this.attempt.dir, out));
      }
    };
    walk(root);
    if (skipped.length > 0) {
      this.log.warn(`out/files: ${skipped.length} file(s) over the collection caps were not collected`);
      this.events.emit(
        "warning",
        {
          scope: "artifacts",
          message: "files over the collection caps were not collected",
          skipped: skipped.slice(0, 20),
        },
        { level: "warn" },
      );
    }
    return collected;
  }

  /** Writes outcome.json exactly once, wakes the host and returns the exit code. */
  async #finish(
    status: TerminalCallState,
    reason: ErrorCode | undefined,
    message: string | undefined,
    extra: { result?: unknown; failure?: HarnessFailure } = {},
  ): Promise<number> {
    if (this.#child) {
      this.#interrupt();
      this.#killTree("SIGKILL");
    }
    const git = this.spec.git;
    const repo = this.git?.isRepo() ?? false;
    const head = repo ? this.git.head() : undefined;
    const outcome: Outcome = {
      callId: this.spec.callId,
      attempt: this.spec.attempt,
      launchId: this.opts.launchId as LaunchId,
      status,
      ...(reason ? { reason } : {}),
      ...(status === "succeeded" || extra.result !== undefined ? { result: extra.result } : {}),
      ...(this.#sessionId() ? { sessionId: this.#sessionId() } : {}),
      git: {
        ...(git.readOnly ? {} : { branch: git.branch }),
        ...(this.bootInfo?.baseSha ? { baseSha: this.bootInfo.baseSha } : {}),
        ...(head ? { headSha: head } : {}),
        pushed: false,
        autoCommitted: this.#autoCommitted,
      },
      usage: this.#usage(),
      harnessVersion: this.#harnessVersion || this.spec.harnessVersion,
      ...(message ? { message: this.redactor.text(message).slice(0, 8192) } : {}),
      ...(extra.failure
        ? { failure: { ...extra.failure, message: this.redactor.text(extra.failure.message).slice(0, 2048) } }
        : {}),
      attempts: { submits: this.#submissionCount, resumes: this.#resumes, doneRetries: this.#doneRetries },
      ...(this.#checks.length > 0 ? { checks: this.#checks } : {}),
      artifacts: this.#artifacts(),
      ...(this.bootInfo ? { isolation: this.bootInfo.isolation } : {}),
    };
    const written = writeExclusive(this.attempt.outcome, `${JSON.stringify(outcome, null, 2)}\n`);
    if (!written) this.log.warn("outcome.json already existed; keeping the first outcome");
    this.state.setHasOutcome();
    this.state.update({ phase: status, ...(TERMINAL_STATES.has(status) ? { pendingAsk: undefined } : {}) });
    this.events.emit(
      "outcome",
      {
        status,
        ...(reason ? { reason } : {}),
        ...(message ? { message } : {}),
        ...(extra.failure ? { failure: extra.failure } : {}),
      },
      { level: status === "succeeded" ? "info" : "warn" },
    );
    this.log.info(`outcome ${status}${reason ? ` (${reason})` : ""}`);
    // The turn is over: release the lock before the wake so a probe never sees a finished call as BUSY.
    this.#stopTimers();
    await this.#socket?.close().catch(() => undefined);
    this.#socket = undefined;
    await this.#lock?.release();
    const delivered = this.wakes.notify(wakeStatusFor(status, reason));
    if (this.opts.deliverWakes !== false && exists(this.attempt.wake)) await delivered;
    return status === "failed" && reason === "config" ? RUNTIME_EXIT.config : RUNTIME_EXIT.ok;
  }
}

/** Live harness pids of an attempt, for `quiesce`. */
export function harnessTree(
  layout: Layout,
  stepKey: string,
  attempt: number,
  launchId: string,
  pgid?: number,
): number[] {
  const dir = layout.attempt(stepKey, attempt).dir;
  const marker = `${launchId}.${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`;
  return findTree({ marker, ...(pgid === undefined ? {} : { pgid }) });
}

export { signalTree };
