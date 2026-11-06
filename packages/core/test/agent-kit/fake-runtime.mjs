// A stand-in for selfbuilding-runtime.mjs in core's offline tests. It speaks the host contract (verbs, files,
// exit codes from docs/BUILD-MAP.md §3) but plays a scripted outcome instead of running a harness. The script lives
// in /selfbuilding/fake/behaviour.json: { "<callPath>": [behaviour for attempt 1, attempt 2, ...] }.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.SELFBUILDING_FS_ROOT ?? "";
const P = (p) => ROOT + p;
const [, script, verb, ...rest] = process.argv;
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1];

const callDir = () => P(`/selfbuilding/state/calls/${args.call}/${args.attempt}`);
const lockPath = P("/run/selfbuilding/call.lock");
const readJson = (f, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(v));
  fs.renameSync(`${f}.tmp`, f);
};
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const lockFree = () => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return spawnSync("flock", ["-n", lockPath, "true"]).status === 0;
};
const log = (line) => {
  try {
    fs.mkdirSync(callDir(), { recursive: true });
    fs.appendFileSync(path.join(callDir(), "runtime.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {}
};

function events(after) {
  const file = path.join(callDir(), "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.seq > after);
}

let seq = 0;
function emit(spec, type, data, turnIndex) {
  seq++;
  const event = {
    v: 1,
    runId: spec.runId,
    callPath: spec.callPath,
    launchId: spec.launchId,
    attempt: spec.attempt,
    seq,
    ts: new Date().toISOString(),
    traceId: spec.runId,
    type,
    level: "info",
    ...(turnIndex !== undefined ? { turnIndex } : {}),
    ...(data ? { data } : {}),
  };
  fs.appendFileSync(path.join(callDir(), "events.jsonl"), `${JSON.stringify(event)}\n`);
  const state = readJson(path.join(callDir(), "state.json"), {});
  writeJson(path.join(callDir(), "state.json"), { ...state, lastSeq: seq });
}

function git(argv, cwd) {
  return execFileSync("git", ["-c", "safe.directory=*", ...argv], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "agent",
      GIT_AUTHOR_EMAIL: "agent@example.com",
      GIT_COMMITTER_NAME: "agent",
      GIT_COMMITTER_EMAIL: "agent@example.com",
    },
  }).trim();
}

function syncRepo(spec) {
  const work = P("/selfbuilding/work");
  const g = spec.git;
  if (!g.remoteUrl) return {};
  if (!fs.existsSync(path.join(work, ".git"))) {
    fs.mkdirSync(work, { recursive: true });
    git(["clone", "-q", g.remoteUrl, "."], work);
    let hasBranch = true;
    try {
      git(["rev-parse", "-q", "--verify", `refs/remotes/origin/${g.branch}`], work);
    } catch {
      hasBranch = false;
    }
    git(["checkout", "-q", "-B", g.branch, hasBranch ? `origin/${g.branch}` : `origin/${g.baseBranch}`], work);
  }
  let baseSha;
  try {
    baseSha = git(["merge-base", "HEAD", `origin/${g.baseBranch}`], work);
  } catch {
    baseSha = git(["rev-parse", "HEAD"], work);
  }
  return { work, baseSha };
}

function behaviourFor(spec) {
  const all = globalThis.__FAKE_BEHAVIOUR ?? readJson(P("/selfbuilding/fake/behaviour.json"), {});
  const list = all[spec.callPath] ?? all["*"] ?? [{}];
  return list[spec.attempt - 1] ?? list.at(-1) ?? {};
}

async function superviseInner() {
  const spec = readJson(path.join(callDir(), "spec.json"));
  const b = behaviourFor(spec);
  const now = new Date().toISOString();
  const sessionId = spec.resumeSessionId ?? spec.sessionId ?? b.sessionId ?? `sess-${spec.stepKey}`;
  writeJson(path.join(callDir(), "state.json"), {
    phase: "running",
    launchId: spec.launchId,
    pids: { supervisor: process.pid },
    sessionId,
    lastSeq: 0,
    heartbeatAt: now,
    clock: { activeMs: 0, paused: false },
    askSeq: 0,
    turnIndex: 0,
    harnessStartedAt: now,
    isolation: "same-user",
  });
  writeJson(P(`/selfbuilding/state/launches/${spec.launchId}.status`), {
    launchId: spec.launchId,
    state: "running",
    lastSeq: 0,
    hasOutcome: false,
    pendingAsk: false,
    at: now,
  });
  // The prompt the host staged, so tests can assert on it.
  fs.copyFileSync(P("/selfbuilding/in/prompt.md"), path.join(callDir(), "prompt.seen.md"));
  emit(spec, "boot", { phase: "ready", status: "ok", isolation: "same-user", harness: spec.harness });
  const { work, baseSha } = syncRepo(spec);
  for (const e of b.events ?? []) emit(spec, e.type, e.data, e.turnIndex);
  if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
  if (b.hang) {
    while (!fs.existsSync(path.join(callDir(), "cancel"))) await new Promise((r) => setTimeout(r, 50));
  }
  if (b.die) process.exit(1);
  if (b.commit && work) {
    fs.writeFileSync(path.join(work, b.commit.file), b.commit.content);
    git(["add", "-A"], work);
    git(["commit", "-qm", b.commit.message ?? "agent change"], work);
  }
  if (b.dirty && work) fs.writeFileSync(path.join(work, b.dirty), "dirty\n");
  for (const [rel, content] of Object.entries(b.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(callDir(), rel)), { recursive: true });
    fs.writeFileSync(path.join(callDir(), rel), content);
  }
  for (const [rel, base64] of Object.entries(b.binaryFiles ?? {})) {
    fs.mkdirSync(path.dirname(path.join(callDir(), rel)), { recursive: true });
    fs.writeFileSync(path.join(callDir(), rel), Buffer.from(base64, "base64"));
  }
  const cancelled = fs.existsSync(path.join(callDir(), "cancel"));
  const cancel = cancelled ? readJson(path.join(callDir(), "cancel"), {}) : null;
  let status = b.status ?? "succeeded";
  if (cancel) status = cancel.reason === "timeout" ? "timed_out" : "cancelled";
  if (status === "succeeded") {
    writeJson(path.join(callDir(), "result.json"), b.result ?? { status: "done", summary: "ok" });
  }
  const headSha = work ? git(["rev-parse", "HEAD"], work) : undefined;
  const outcome = {
    callId: spec.callId,
    attempt: spec.attempt,
    launchId: spec.launchId,
    status,
    ...(b.reason ? { reason: b.reason } : {}),
    ...(b.message ? { message: b.message } : {}),
    ...(b.failure ? { failure: b.failure } : {}),
    sessionId,
    git: {
      branch: spec.git.branch,
      ...(baseSha ? { baseSha } : {}),
      ...(headSha ? { headSha } : {}),
      pushed: false,
      autoCommitted: Boolean(b.dirty),
    },
    usage: b.usage ?? { usd: 0.01, inputTokens: 10, outputTokens: 5, turns: 1, wallClockMs: 1, sandboxMs: 1 },
    harnessVersion: spec.harnessVersion,
    attempts: { submits: 1, resumes: 0, doneRetries: 0 },
    checks: b.checks ?? [],
    artifacts: { files: [...Object.keys(b.files ?? {}), ...Object.keys(b.binaryFiles ?? {})] },
    isolation: b.isolation ?? "same-user",
  };
  emit(spec, "agent.outcome", { status });
  writeJson(path.join(callDir(), "outcome.json"), outcome);
  writeJson(P(`/selfbuilding/state/launches/${spec.launchId}.status`), {
    launchId: spec.launchId,
    state: status,
    lastSeq: seq,
    hasOutcome: true,
    pendingAsk: false,
    at: new Date().toISOString(),
  });
}

async function main() {
  switch (verb) {
    case "launch": {
      const marker = P(`/selfbuilding/state/launches/${args.launch}.launched`);
      const outcome = readJson(path.join(callDir(), "outcome.json"));
      if (outcome) return out({ action: "settled", outcome });
      if (fs.existsSync(marker)) {
        if (!lockFree()) return out({ action: "reattached" });
        const state = readJson(path.join(callDir(), "state.json"));
        if (state?.phase === "suspended" && state.pendingAsk) return out({ action: "suspended" });
        return out({ action: "interrupted", harnessStarted: Boolean(state?.harnessStartedAt) });
      }
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, new Date().toISOString());
      log(`launch ${args.launch}`);
      return out({ action: "start" });
    }
    case "supervise": {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const child = spawn("flock", [lockPath, process.execPath, script, "supervise-inner", ...rest], {
        stdio: "inherit",
        env: process.env,
      });
      child.on("exit", (code) => process.exit(code ?? 1));
      return;
    }
    case "supervise-inner":
      return superviseInner();
    case "wait": {
      const after = Number(args.after ?? 0);
      const maxMs = Number.parseInt(args.max ?? "0", 10) * 1000;
      const deadline = Date.now() + maxMs;
      for (;;) {
        const evs = events(after);
        const outcome = readJson(path.join(callDir(), "outcome.json"));
        if (evs.length > 0 || outcome || Date.now() >= deadline) {
          const state = readJson(path.join(callDir(), "state.json"));
          const lastSeq = evs.length ? evs.at(-1).seq : after;
          return out({
            events: evs,
            lastSeq,
            state,
            ...(outcome ? { outcome } : {}),
            lock: lockFree() ? "FREE" : "BUSY",
          });
        }
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    case "ack":
      fs.writeFileSync(path.join(callDir(), "outcome.ack"), new Date().toISOString());
      return out({ acked: true });
    case "quiesce":
      return out({ quiescent: true });
    case "answer": {
      const body = fs.readFileSync(0, "utf8");
      fs.mkdirSync(path.join(callDir(), "inbox"), { recursive: true });
      fs.writeFileSync(path.join(callDir(), "inbox", `${args.ask}.json`), body);
      return out({ written: true });
    }
    default:
      process.stderr.write(`fake runtime: unknown verb ${verb}\n`);
      process.exit(78);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(75);
});
