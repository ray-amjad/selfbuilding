import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  type InboxAnswer,
  type LaunchProbe,
  type ProviderSandbox,
  type RuntimeState,
  SANDBOX_PATHS,
  type WaitResponse,
} from "@selfbuilding/core";
import { openTestBox, scripted, scriptedHarness, type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signCallback } from "../src/wake.js";
import {
  attemptPath,
  buildBundles,
  createRemote,
  launch,
  readBox,
  runToOutcome,
  type StagedCall,
  sh,
  stageCall,
  start,
  verb,
  waitUntil,
} from "./host.js";

// The runtime driven end to end through its verbs, in tmpdir boxes, with the scripted harness playing real Claude Code
// and Codex stream formats through the real selfbuilding-mcp bundle.

let provider: TmpdirProvider;
let remote: ReturnType<typeof createRemote>;
let n = 0;
const box = (): Promise<ProviderSandbox> => openTestBox(provider, `rt-${process.pid}-${++n}`);
const done = { status: "done", summary: "did it" };
const SESSION = "11111111-1111-4111-8111-111111111111";
const T = 60_000;

beforeAll(() => {
  buildBundles();
  provider = tmpdirProvider();
  remote = createRemote();
}, 120_000);

afterAll(async () => {
  await provider?.close();
  if (remote) fs.rmSync(remote.dir, { recursive: true, force: true });
});

async function cancel(b: ProviderSandbox, call: StagedCall, reason = "test cancel"): Promise<void> {
  await b.writeFiles([
    { path: attemptPath(call, "cancel"), data: JSON.stringify({ reason, at: new Date().toISOString() }) },
  ]);
}

function answerFor(askId: string, text: string): InboxAnswer {
  return {
    askId,
    resolution: {
      askId,
      answer: { kind: "text", text },
      choiceId: null,
      answeredBy: { kind: "human", channel: "slack", userId: "U1", displayName: "alice" },
      answeredAt: new Date().toISOString(),
    },
  };
}

describe("results", () => {
  it(
    "rejects an invalid submit_result, accepts the retry and settles succeeded (Claude Code over MCP)",
    async () => {
      const b = await box();
      const harness = scriptedHarness([
        scripted.say("working"),
        scripted.sh("echo hello > hello.txt"),
        ...scripted.invalidThenValid({ status: "nope" }, done),
      ]);
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION });
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status, outcome.message).toBe("succeeded");
      expect(outcome.result).toEqual(done);
      expect(outcome.sessionId).toBe(SESSION);
      expect(outcome.attempts?.submits).toBe(2);
      expect(outcome.git.autoCommitted).toBe(true);
      expect(outcome.git.baseSha).toBe(remote.baseSha);
      expect(outcome.git.branch).toBe(call.spec.git.branch);
      expect(outcome.harnessVersion).toBe("1.0.0");
      expect(outcome.artifacts?.transcript).toBe("events.jsonl");
      expect(outcome.artifacts?.diff).toBe("artifacts/diff.patch");
      expect(events.filter((e) => e.type === "result.submitted").map((e) => e.data?.valid)).toEqual([false, true]);
      expect(events.some((e) => e.type === "ready")).toBe(true);
      expect(events.some((e) => e.type === "harness.tool.started")).toBe(true);
      // seq is monotonic and gap-free.
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      expect(JSON.parse(await readBox(b, attemptPath(call, "result.json")))).toEqual(done);
      const first = JSON.parse(await readBox(b, attemptPath(call, "submissions/1.json")));
      expect(first.valid).toBe(false);
      expect(first.issues.map((i: { pointer: string }) => i.pointer)).toContain("/status");
      // The leftover commit carries the trailers.
      const message = await sh(b, "git log -1 --format=%B");
      expect(message).toContain("selfbuilding: uncommitted changes from TestAgent");
      expect(message).toContain("Selfbuilding-Run: run-1");
      expect(await readBox(b, attemptPath(call, "artifacts/diff.patch"))).toContain("hello.txt");
    },
    T,
  );

  it(
    "stops a Codex turn that keeps going after an accepted submit (kill strategy)",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.submit(done), scripted.hangUntilCancelled()], { format: "codex" });
      const call = await stageCall(b, { harness, remote: remote.url });
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status, outcome.message).toBe("succeeded");
      expect(outcome.sessionId).toBeTruthy();
      const ended = events.find((e) => e.type === "turn.ended");
      expect(ended?.data?.stoppedBy).toBe("submitted");
    },
    T,
  );

  it(
    "reaches the supervisor over the tool socket directly",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.submit(done)], { toolTransport: "socket", format: "codex" });
      const call = await stageCall(b, { harness, remote: remote.url });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status, outcome.message).toBe("succeeded");
    },
    T,
  );

  it(
    "ends the turn and fails result_invalid after maxSubmitAttempts invalid calls",
    async () => {
      const b = await box();
      const bad = { status: "nope", summary: "x" };
      const harness = scriptedHarness([
        scripted.submit(bad, "rejected"),
        scripted.submit(bad, "rejected"),
        scripted.submit(bad, "rejected"),
        scripted.submit(done, "rejected"),
        scripted.hangUntilCancelled(),
      ]);
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION });
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status).toBe("failed");
      expect(outcome.reason).toBe("result_invalid");
      const last = events.filter((e) => e.type === "harness.tool.completed").pop();
      expect(String(last?.data?.output)).toContain("Submission limit reached. Stop.");
    },
    T,
  );

  it(
    "rejects a result over maxResultBytes",
    async () => {
      const b = await box();
      const harness = scriptedHarness([
        scripted.submit({ status: "done", summary: "x".repeat(2000) }, "rejected"),
        scripted.submit(done),
      ]);
      const call = await stageCall(b, {
        harness,
        remote: remote.url,
        sessionId: SESSION,
        spec: { maxResultBytes: 1000 },
      });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status, outcome.message).toBe("succeeded");
      const first = JSON.parse(await readBox(b, attemptPath(call, "submissions/1.json")));
      expect(first.issues[0].expected).toContain("at most 1000 bytes");
    },
    T,
  );

  it(
    "nudges once when the harness ends without a result, then succeeds",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.say("I think I'm done")], { turns: [[scripted.submit(done)]] });
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION });
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status, outcome.message).toBe("succeeded");
      expect(outcome.attempts?.resumes).toBe(1);
      expect(events.some((e) => e.type === "nudge")).toBe(true);
      const prompt = await readBox(b, `${SANDBOX_PATHS.in}/turn-1.md`);
      expect(prompt).toContain("You ended without calling submit_result");
    },
    T,
  );

  it(
    "fails no_result when the harness cannot resume",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.say("prose only")], { resumable: false });
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status).toBe("failed");
      expect(outcome.reason).toBe("no_result");
    },
    T,
  );

  it(
    "fails interrupted when the harness dies mid-turn, and never re-runs it",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.sh("echo partial > partial.txt"), scripted.crash("SIGKILL")], {
        turns: [[scripted.submit(done)]],
      });
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION });
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status).toBe("failed");
      expect(outcome.reason).toBe("interrupted");
      expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    },
    T,
  );

  it(
    "fails harness_error on a stream error event",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.error("rate_limit", "API Error: 429 rate limit exceeded")]);
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION });
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status).toBe("failed");
      expect(outcome.reason).toBe("harness_error");
      expect(outcome.message).toContain("rate_limit");
      expect(events.some((e) => e.type === "harness.error")).toBe(true);
    },
    T,
  );
});

describe("cancellation and timeouts", () => {
  it(
    "cancels a running turn through the sentinel and keeps the work as a WIP commit",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.sh("echo wip > wip.txt"), scripted.hangUntilCancelled()]);
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION });
      await start(b, call);
      await waitUntil(b, call, (r) => r.events.some((e) => e.type === "harness.tool.completed"));
      await cancel(b, call, "user asked");
      // The outcome lands a moment before the lock is released.
      const { last } = await waitUntil(b, call, (r) => r.outcome !== undefined && r.lock === "FREE");
      const outcome = last.outcome;
      expect(outcome?.status).toBe("cancelled");
      expect(outcome?.reason).toBe("aborted");
      expect(outcome?.message).toContain("user asked");
      expect(outcome?.git.autoCommitted).toBe(true);
      expect(await sh(b, "git log -1 --format=%s")).toBe("selfbuilding: WIP (cancelled) from TestAgent");
      expect(last.lock).toBe("FREE");
    },
    T,
  );

  it(
    "escalates to SIGKILL when the harness ignores SIGINT",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.hangUntilCancelled({ ignoreSigint: true })]);
      const call = await stageCall(b, {
        harness,
        remote: remote.url,
        sessionId: SESSION,
        timeouts: { cancelGraceMs: 300 },
      });
      await start(b, call);
      await waitUntil(b, call, (r) => r.state?.phase === "running");
      await cancel(b, call);
      const { last } = await waitUntil(b, call, (r) => r.outcome !== undefined);
      expect(last.outcome?.status).toBe("cancelled");
      const quiesce = await verb<{ quiescent: boolean }>(b, `quiesce ${call.args} --timeout 5s`);
      expect(quiesce.json.quiescent).toBe(true);
    },
    T,
  );

  it(
    "writes a cancelled outcome without booting when the sentinel is already there",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.submit(done)]);
      const call = await stageCall(b, { harness, remote: remote.url });
      await cancel(b, call, "early");
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status).toBe("cancelled");
      expect(events.some((e) => e.type === "boot")).toBe(false);
    },
    T,
  );

  it(
    "times out an idle harness",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.hangUntilCancelled()]);
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION, timeouts: { idleMs: 800 } });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status).toBe("timed_out");
      expect(outcome.reason).toBe("idle_timeout");
      expect(outcome.sessionId).toBe(SESSION);
    },
    T,
  );

  it(
    "times out on the call's active-time limit",
    async () => {
      const b = await box();
      const harness = scriptedHarness([{ sh: "for i in 1 2 3 4 5 6 7 8 9 10; do echo tick; sleep 0.3; done" }]);
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION, timeouts: { callMs: 1000 } });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status).toBe("timed_out");
      expect(outcome.reason).toBe("timeout");
    },
    T,
  );
});

describe("asks", () => {
  it(
    "answers a hot ask through the inbox while the clocks are paused",
    async () => {
      const b = await box();
      const harness = scriptedHarness([
        scripted.askHuman({ question: "Ship it?", choices: ["yes", "no"] }, "accepted"),
        scripted.submit(done),
      ]);
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION, timeouts: { idleMs: 1000 } });
      await start(b, call);
      const { last } = await waitUntil(b, call, (r) => r.pendingAsk !== undefined);
      expect(last.pendingAsk?.question).toBe("Ship it?");
      expect(last.state?.phase).toBe("waiting");
      expect(last.state?.clock.paused).toBe(true);
      const active = last.state?.clock.activeMs ?? 0;
      // Longer than idleMs: a waiting call is not idle.
      await new Promise((r) => setTimeout(r, 2000));
      const before = await verb<WaitResponse>(b, `wait ${call.args} --after 100000 --max 0`);
      expect(before.json.state?.clock.activeMs).toBe(active);
      const written = await verb<{ written: boolean }>(
        b,
        `answer ${call.args} --ask ask_1`,
        JSON.stringify(answerFor("ask_1", "yes please")),
      );
      expect(written.json.written).toBe(true);
      const { last: end, events } = await waitUntil(b, call, (r) => r.outcome !== undefined);
      expect(end.outcome?.status, end.outcome?.message).toBe("succeeded");
      const reply = events.find(
        (e) => e.type === "harness.tool.completed" && String(e.data?.output).includes("Answer from"),
      );
      expect(String(reply?.data?.output)).toBe('Answer from @alice via Slack: "yes please".');
      expect(await sh(b, `ls ${attemptPath(call, "inbox")}`)).toContain("ask_1.taken");
      const dup = await verb<{ written: boolean }>(
        b,
        `answer ${call.args} --ask ask_1`,
        JSON.stringify(answerFor("ask_1", "again")),
      );
      expect(dup.json.written).toBe(false);
    },
    T,
  );

  it(
    "moves an ask to a cold wait, then resumes the session with the answer on the next launch",
    async () => {
      const b = await box();
      const harness = scriptedHarness(
        [scripted.sh("echo before > before.txt"), scripted.askHuman({ question: "Which db?" }, "suspended")],
        {
          turns: [[scripted.sh("echo after > after.txt"), scripted.submit(done)]],
        },
      );
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION, spec: { hotWaitMs: 1000 } });
      await start(b, call);
      const { last } = await waitUntil(b, call, (r) => r.state?.phase === "suspended" && r.lock === "FREE");
      expect(last.outcome).toBeUndefined();
      expect(last.pendingAsk?.question).toBe("Which db?");
      expect(last.state?.sessionId).toBe(SESSION);
      // The host relaunches with the answer as the next user message.
      const next = await stageCall(b, {
        harness,
        remote: remote.url,
        launch: 2,
        install: false,
        sessionId: SESSION,
        resumeSessionId: SESSION,
        prompt: 'Answer to your question #1 from @alice via Slack: "postgres"',
      });
      const { last: end } = await (async () => {
        await start(b, next);
        return waitUntil(b, next, (r) => r.outcome !== undefined);
      })();
      expect(end.outcome?.status, end.outcome?.message).toBe("succeeded");
      expect(end.outcome?.launchId).toBe(next.launchId);
      expect(end.state?.askSeq).toBe(1);
      expect(end.state?.pendingAsk).toBeUndefined();
      const files = await sh(b, "git show --name-only --format= HEAD");
      expect(files).toContain("after.txt");
      expect(files).toContain("before.txt");
    },
    T,
  );

  it(
    "refuses an answer while no ask is open",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.submit(done)]);
      const call = await stageCall(b, { harness, remote: remote.url });
      const r = await verb<{ written: boolean; reason: string }>(
        b,
        `answer ${call.args} --ask ask_9`,
        JSON.stringify(answerFor("ask_9", "x")),
      );
      expect(r.json).toEqual({ written: false, reason: "inbox-closed" });
    },
    T,
  );

  it(
    "posts notify_human as an event",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.notifyHuman({ message: "found a second bug" }), scripted.submit(done)]);
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION });
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status).toBe("succeeded");
      expect(events.find((e) => e.type === "notify")?.data?.message).toBe("found a second bug");
    },
    T,
  );
});

describe("output files", () => {
  it(
    "collects /selfbuilding/out/files into the attempt's artifacts: text redacted, binaries intact, symlinks skipped",
    async () => {
      const b = await box();
      const token = "cb-secret-token-0123456789";
      const out = `${SANDBOX_PATHS.out}/files`;
      await b.writeFiles([{ path: `${SANDBOX_PATHS.home}/root-only.txt`, data: "never collected" }]);
      const harness = scriptedHarness([
        scripted.sh(
          `mkdir -p ${out}/verify/add-a-note/screenshots && printf 'token ${token} seen' > ${out}/verify/add-a-note/claim.json && printf '\\211PNG\\000\\001' > ${out}/verify/add-a-note/screenshots/01.png && ln -s ${SANDBOX_PATHS.home}/root-only.txt ${out}/link.txt`,
        ),
        scripted.submit(done),
      ]);
      const call = await stageCall(b, { harness, remote: remote.url, spec: { callbackToken: token } });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status, outcome.message).toBe("succeeded");
      expect(outcome.artifacts?.files).toEqual([
        "artifacts/files/verify/add-a-note/claim.json",
        "artifacts/files/verify/add-a-note/screenshots/01.png",
      ]);
      const claim = await readBox(b, attemptPath(call, "artifacts/files/verify/add-a-note/claim.json"));
      expect(claim).not.toContain(token);
      expect(claim).toMatch(/^token .+ seen$/);
      const png = await sh(
        b,
        `od -An -tx1 ${attemptPath(call, "artifacts/files/verify/add-a-note/screenshots/01.png")}`,
      );
      expect(png.replace(/\s+/g, " ").trim()).toBe("89 50 4e 47 00 01");
    },
    T,
  );
});

describe("done checks and git", () => {
  it(
    "feeds a failed done check back as a new turn, then succeeds",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.submit(done)], {
        turns: [[scripted.sh("echo ok > fixed.txt"), scripted.submit(done)]],
      });
      const call = await stageCall(b, {
        harness,
        remote: remote.url,
        sessionId: SESSION,
        spec: { doneChecks: [{ id: "fixed", cmd: "test -f fixed.txt && echo present" }] },
      });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status, outcome.message).toBe("succeeded");
      expect(outcome.attempts?.doneRetries).toBe(1);
      expect(outcome.checks).toEqual([{ id: "fixed", ok: true, verified: true }]);
      const feedback = await readBox(b, `${SANDBOX_PATHS.in}/turn-1.md`);
      expect(feedback).toContain("Done check `fixed` failed: `test -f fixed.txt && echo present` exited 1.");
      expect(feedback).toContain("Fix the problem and call submit_result again.");
    },
    T,
  );

  it(
    "fails done_check_failed when the retries run out",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.submit(done)]);
      const call = await stageCall(b, {
        harness,
        remote: remote.url,
        sessionId: SESSION,
        spec: { maxDoneRetries: 0, doneChecks: [{ id: "never", cmd: "echo nope; exit 3" }] },
      });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status).toBe("failed");
      expect(outcome.reason).toBe("done_check_failed");
      expect(outcome.result).toEqual(done);
      expect(outcome.message).toContain("nope");
    },
    T,
  );

  it(
    "skips done checks when the result reports blocked",
    async () => {
      const b = await box();
      const blocked = { status: "blocked", summary: "need access" };
      const harness = scriptedHarness([scripted.submit(blocked)]);
      const call = await stageCall(b, {
        harness,
        remote: remote.url,
        spec: { doneChecks: [{ id: "never", cmd: "exit 1" }] },
      });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status).toBe("succeeded");
      expect(outcome.result).toEqual(blocked);
    },
    T,
  );

  it(
    "restores protected test config from the base commit while checks run",
    async () => {
      const b = await box();
      const hack = `node -e "const f='package.json';const p=JSON.parse(require('fs').readFileSync(f));p.scripts.test='hacked';p.dependencies={x:'1'};require('fs').writeFileSync(f,JSON.stringify(p))"`;
      const harness = scriptedHarness([scripted.sh(hack), scripted.submit(done)]);
      const check = `node -e "const p=require('./package.json');process.exit(p.scripts.test==='true'&&p.dependencies.x==='1'?0:1)"`;
      const call = await stageCall(b, {
        harness,
        remote: remote.url,
        spec: { doneChecks: [{ id: "tests", cmd: check }] },
      });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status, outcome.message).toBe("succeeded");
      // The agent's version is back after the checks, and is what was committed.
      expect(await sh(b, "git show HEAD:package.json")).toContain("hacked");
    },
    T,
  );

  it(
    "reverts changes made after an accepted submit",
    async () => {
      const b = await box();
      const harness = scriptedHarness(
        [scripted.sh("echo kept > kept.txt"), scripted.submit(done), scripted.sh("echo late > late.txt")],
        {
          format: "codex",
        },
      );
      const call = await stageCall(b, { harness, remote: remote.url, timeouts: { postSubmitGraceMs: 1500 } });
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status, outcome.message).toBe("succeeded");
      expect(outcome.artifacts?.postSubmitPatch).toBe("artifacts/post-submit.patch");
      const change = events.find((e) => e.type === "post_submit_changes");
      expect(change?.data?.files).toEqual(["late.txt"]);
      expect(change?.data?.action).toBe("revert");
      const tree = await sh(b, "git ls-tree --name-only HEAD");
      expect(tree).toContain("kept.txt");
      expect(tree).not.toContain("late.txt");
    },
    T,
  );

  it(
    "requires a commit ahead of base when artifacts.branch is required",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.submit(done)]);
      const call = await stageCall(b, {
        harness,
        remote: remote.url,
        spec: { artifactsBranch: "required", maxDoneRetries: 0 },
      });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status).toBe("failed");
      expect(outcome.reason).toBe("done_check_failed");
      expect(outcome.checks).toEqual([{ id: "branch", ok: false, verified: true }]);
    },
    T,
  );

  it(
    "checks out a review head read-only, writes the diff, and fails a reviewer that changes the tree",
    async () => {
      const b = await box();
      const review = { baseSha: remote.baseSha, headSha: remote.featureSha };
      const harness = scriptedHarness([
        scripted.sh("cat /selfbuilding/in/diff.patch > /dev/null && echo x > stray.txt"),
        scripted.submit(done),
      ]);
      const call = await stageCall(b, {
        harness,
        remote: remote.url,
        git: { readOnly: true, review },
        spec: { artifactsBranch: "forbidden" },
      });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status).toBe("failed");
      expect(outcome.reason).toBe("done_check_failed");
      expect(outcome.git.branch).toBeUndefined();
      expect(outcome.git.headSha).toBe(remote.featureSha);
      expect(await readBox(b, `${SANDBOX_PATHS.in}/diff.patch`)).toContain("feature.txt");
    },
    T,
  );
});

describe("boot", () => {
  it(
    "runs the setup hook once and records setup.done; a failing start hook fails the boot",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.submit(done)]);
      const call = await stageCall(b, {
        harness,
        remote: remote.url,
        spec: { hooks: { setup: { command: "echo setup-ran >> /selfbuilding/out/setup-count; echo hooked" } } },
      });
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status, outcome.message).toBe("succeeded");
      expect(events.find((e) => e.type === "sandbox.hook")?.data?.log).toContain("hooked");
      expect(outcome.artifacts?.logs).toContain("hooks/setup-fresh.log");

      const again = await stageCall(b, {
        harness: scriptedHarness([scripted.submit(done)]),
        remote: remote.url,
        stepKey: "agent-1",
        install: false,
        spec: {
          hooks: {
            setup: { command: "echo setup-ran >> /selfbuilding/out/setup-count; echo hooked" },
            start: { command: "echo broken; exit 4" },
          },
        },
      });
      const second = await runToOutcome(b, again);
      expect(second.outcome.status).toBe("failed");
      expect(second.outcome.reason).toBe("boot");
      expect(second.outcome.message).toContain("The start hook exited 4");
      expect((await readBox(b, `${SANDBOX_PATHS.out}/setup-count`)).trim().split("\n")).toHaveLength(1);
    },
    T,
  );

  it(
    "exits 76 without an outcome when the runtime stamp does not match",
    async () => {
      const b = await box();
      const call = await stageCall(b, { harness: scriptedHarness([scripted.submit(done)]), remote: remote.url });
      await b.writeFiles([{ path: SANDBOX_PATHS.runtimeVersion, data: "0".repeat(64) }]);
      expect((await launch(b, call)).action).toBe("start");
      const run = await b.exec(`node ${SANDBOX_PATHS.runtimeBundle} supervise ${call.args} --launch ${call.launchId}`, {
        timeoutMs: 30_000,
      });
      expect(run.exitCode).toBe(76);
      const after = await verb<WaitResponse>(b, `wait ${call.args} --after 0 --max 0`);
      expect(after.json.outcome).toBeUndefined();
      expect(after.json.events.some((e) => e.type === "boot" && e.data?.status === "failed")).toBe(true);
    },
    T,
  );

  it(
    "warns and falls back to a process-group kill without ns-reap",
    async () => {
      const b = await box();
      const call = await stageCall(b, {
        harness: scriptedHarness([scripted.submit(done)]),
        remote: remote.url,
        nsReap: false,
      });
      const { outcome, events } = await runToOutcome(b, call);
      expect(outcome.status).toBe("succeeded");
      const warning = events.find((e) => e.type === "warning" && e.data?.scope === "containment");
      expect(warning?.level).toBe("warn");
    },
    T,
  );

  it(
    "starts from an empty repository when the call names no repo",
    async () => {
      const b = await box();
      const call = await stageCall(b, {
        harness: scriptedHarness([scripted.submit(done)]),
        remote: "",
        git: { remoteUrl: undefined },
      });
      const { outcome } = await runToOutcome(b, call);
      expect(outcome.status).toBe("succeeded");
    },
    T,
  );
});

describe("launch, reattach and the turn lock", () => {
  it(
    "is idempotent: start, reattached while running, settled after the outcome",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.hangUntilCancelled()]);
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION });
      await start(b, call);
      await waitUntil(b, call, (r) => r.state?.phase === "running" && r.lock === "BUSY");
      expect(await launch(b, call)).toEqual({ action: "reattached" } satisfies LaunchProbe);
      // A second supervisor for the same launch starts nothing.
      const second = await b.exec(
        `node ${SANDBOX_PATHS.runtimeBundle} supervise ${call.args} --launch ${call.launchId}`,
        { timeoutMs: 20_000 },
      );
      expect(second.exitCode).toBe(0);
      const quiet = await verb<{ quiescent: boolean; reason?: string }>(b, `quiesce ${call.args} --timeout 200ms`);
      expect(quiet.json).toMatchObject({ quiescent: false, reason: "turn-running" });
      await cancel(b, call);
      await waitUntil(b, call, (r) => r.outcome !== undefined);
      const settled = await launch(b, call);
      expect(settled.action).toBe("settled");
      expect((await verb<{ acked: boolean }>(b, `ack ${call.args}`)).json).toEqual({ acked: true });
      expect(await readBox(b, attemptPath(call, "outcome.json"))).toContain('"cancelled"');
    },
    T,
  );

  it(
    "reports an interrupted turn when the supervisor died mid-turn, and never starts a second harness",
    async () => {
      const b = await box();
      const harness = scriptedHarness([scripted.hangUntilCancelled()]);
      const call = await stageCall(b, { harness, remote: remote.url, sessionId: SESSION });
      await start(b, call);
      const { last } = await waitUntil(b, call, (r) => r.state?.phase === "running");
      const supervisorPid = last.state?.pids.supervisor as number;
      const harnessPgid = last.state?.pids.harnessPgid as number;
      process.kill(supervisorPid, "SIGKILL");
      process.kill(-harnessPgid, "SIGKILL");
      await waitUntil(b, call, (r) => r.lock === "FREE");
      expect(await launch(b, call)).toEqual({ action: "interrupted", harnessStarted: true });
      const again = await b.exec(
        `node ${SANDBOX_PATHS.runtimeBundle} supervise ${call.args} --launch ${call.launchId}`,
        { timeoutMs: 20_000 },
      );
      expect(again.exitCode).toBe(0);
      const state = JSON.parse(await readBox(b, attemptPath(call, "state.json"))) as RuntimeState;
      expect(state.phase).toBe("interrupted");
      const status = JSON.parse(await readBox(b, `${SANDBOX_PATHS.launches}/${call.launchId}.status`));
      expect(status).toMatchObject({ launchId: call.launchId, state: "interrupted", hasOutcome: false });
    },
    T,
  );

  it(
    "rejects bad arguments with exit 78",
    async () => {
      const b = await box();
      await stageCall(b, { harness: scriptedHarness([scripted.submit(done)]), remote: remote.url });
      const r = await verb<{ error: string }>(b, "wait --call ../x --attempt 1");
      expect(r.exitCode, r.stderr).toBe(78);
      expect(r.json.error).toBe("config");
      const unknown = await verb<{ error: string }>(b, "frobnicate");
      expect(unknown.exitCode).toBe(78);
    },
    T,
  );
});

describe("wake callbacks", () => {
  it(
    "sends one HMAC-signed wake for the outcome to the armed target",
    async () => {
      const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          received.push({ headers: req.headers, body });
          res.writeHead(200).end("ok");
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      try {
        const port = (server.address() as AddressInfo).port;
        const b = await box();
        const token = "callback-token-0123456789";
        const call = await stageCall(b, {
          harness: scriptedHarness([scripted.submit(done)]),
          remote: remote.url,
          spec: { callbackToken: token },
        });
        await b.writeFiles([
          {
            path: attemptPath(call, "wake.json"),
            data: JSON.stringify({
              launchId: call.launchId,
              rearm: 0,
              target: { kind: "url", url: `http://127.0.0.1:${port}/cb` },
            }),
            mode: 0o600,
          },
        ]);
        const { outcome } = await runToOutcome(b, call);
        expect(outcome.status).toBe("succeeded");
        const deadline = Date.now() + 10_000;
        while (received.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(received).toHaveLength(1);
        const [wake] = received;
        const body = JSON.parse(wake?.body ?? "{}");
        expect(body).toMatchObject({
          v: 1,
          runId: "run-1",
          stepKey: call.stepKey,
          launchId: call.launchId,
          status: "submitted",
          rearm: 0,
          source: "runtime",
        });
        expect(wake?.headers["x-selfbuilding-signature"]).toBe(signCallback(token, "agent.callback", wake?.body ?? ""));
        expect(await sh(b, `ls ${attemptPath(call)}`)).toContain(`wake.${call.launchId}.w0.sent`);
        // The token never reaches the event stream.
        expect(await readBox(b, attemptPath(call, "events.jsonl"))).not.toContain(token);
      } finally {
        server.close();
      }
    },
    T,
  );
});
