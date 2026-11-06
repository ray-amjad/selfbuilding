// Task lifecycle as a workflow script: one builder on one branch, a PR, up to two review-and-fix rounds with a
// Claude Code and a Codex reviewer, then find the flows and verify each in a browser, one fix round for a broken
// flow, and a question before any merge. It never merges.
//
// input: { repo, base, spec, testCommand?, appNotes?, maxReviewRounds?, maxFlows? }

const BLOCKING = new Set(["critical", "high", "medium"]);

export default async function main(input, sb) {
  const { repo, base, spec } = input;
  const maxRounds = input.maxReviewRounds ?? 2;

  // 1. Build: one builder, one box, one branch. Every later fix goes back to this box.
  sb.phase("build");
  const box = sb.sandbox({ label: "build", size: "medium", repo });
  const build = await sb.agents.ImplementSpec(
    { spec, ...(input.testCommand ? { testCommand: input.testCommand } : {}) },
    { sandbox: box, harness: "claude-code", label: "builder", git: { baseBranch: base }, pr: { draft: true } },
  );
  if (build.result.status !== "done") {
    return { status: "build_incomplete", summary: build.result.summary, openQuestions: build.result.openQuestions };
  }
  const branch = build.artifacts.branch?.name;
  const pr = build.artifacts.pr ?? null;
  await box.push();
  sb.log(`build done on ${branch}; PR ${pr ? pr.url : "not opened"}`);
  const record = prRecord(sb, pr);
  await record.section("What changed and why", whatChanged(build.result));
  await record.section("Source", sourceBlock(spec));

  // 2. Review → fix, up to two rounds. Both reviewers read the same diff, each on its own copy of the box.
  const target = { kind: "diff", base, head: branch };
  // A fork the provider could not make comes back null: run that agent in a fresh box on the pushed branch instead.
  const placed = (fork) => (fork ? { sandbox: fork } : { sandbox: "fresh", repo, git: { branch, baseBranch: base } });
  const rounds = [];
  let carried = [];
  for (let round = 1; round <= maxRounds; round++) {
    sb.phase(`review-${round}`);
    const [forClaude, forCodex] = await box.fork(2);
    const [claude, codex] = await sb.parallel([
      () =>
        sb.agents.CodeReview.settled(
          { target },
          { ...placed(forClaude), harness: "claude-code", label: `review-${round}-claude` },
        ),
      () =>
        sb.agents.CodeReview.settled(
          { target },
          { ...placed(forCodex), harness: "codex", label: `review-${round}-codex` },
        ),
    ]);
    await forClaude?.dispose();
    await forCodex?.dispose();

    const panel = [
      ["claude-code", claude],
      ["codex", codex],
    ];
    const findings = [];
    const missing = [];
    for (const [who, r] of panel) {
      if (!r?.ok) missing.push(who);
      else for (const f of r.value.result.findings) findings.push({ ...f, reviewer: who });
    }
    if (missing.length === 2) {
      rounds.push({ round, error: "no reviewer answered" });
      break;
    }
    const fixNow = findings.filter((f) => f.verdict === "CONFIRMED" && BLOCKING.has(f.severity));
    carried = carried.concat(findings.filter((f) => !fixNow.includes(f)));
    const entry = {
      round,
      reviewers: panel.filter(([, r]) => r?.ok).map(([w]) => w),
      missing,
      fixNow: fixNow.length,
      carried: findings.length - fixNow.length,
    };
    rounds.push(entry);
    sb.log(
      `round ${round}: ${fixNow.length} to fix, ${findings.length - fixNow.length} carried${missing.length ? `, ${missing.join(", ")} unavailable` : ""}`,
    );
    await record.comment(
      reviewedComment(
        round,
        fixNow,
        findings.filter((f) => !fixNow.includes(f)),
        missing,
      ),
    );
    if (fixNow.length === 0) break;

    sb.phase(`fix-${round}`);
    const strip = ({ reviewer, ...f }) => f;
    const fix = await sb.agents.ImplementSpec(
      {
        spec,
        feedback: fixNow.map(strip),
        context: `Review round ${round}. Fix these findings on this branch. Findings with one root cause get one design, not N patches.`,
      },
      {
        sandbox: box,
        harness: "claude-code",
        label: `fix-${round}`,
        git: { branch, baseBranch: base },
        pr: { draft: true },
      },
    );
    entry.fixed = fix.result.status;
    await box.push();
    if (pr) await record.comment(completeComment(round, fix.result, fixNow, (await sb.pr.get(pr)).headSha));
  }

  // 3. Find the flows the change touches, on a copy of the fixed box.
  sb.phase("find-flows");
  const [forFinder] = await box.fork(1);
  const found = await sb.agents.FindFlows.settled(
    { change: build.result.summary, maxFlows: input.maxFlows ?? 3, target },
    { ...placed(forFinder), harness: "claude-code", label: "find-flows" },
  );
  await forFinder?.dispose();
  const flows = found?.ok ? found.value.result.flows.slice(0, input.maxFlows ?? 3) : [];

  // 4. Verify each flow in a browser, each on its own copy, on Codex (not the builder's model).
  const verifyAll = async (list, label) => {
    if (list.length === 0) return [];
    const forks = await box.fork(list.length);
    const out = await sb.pipeline(
      { label, key: (x) => x.flow.name },
      list.map((flow, i) => ({ flow, i })),
      async ({ flow, i }) => {
        const r = await sb.agents.Verify.settled(
          {
            change: build.result.summary,
            flows: [{ name: flow.name, endState: flow.endState, ...(flow.rows ? { rows: flow.rows } : {}) }],
            ...(input.appNotes ? { appNotes: input.appNotes } : {}),
          },
          { ...placed(forks[i]), harness: "codex", label: `${label}-${i + 1}` },
        );
        const f = r?.ok ? r.value.result.flows[0] : null;
        return {
          name: flow.name,
          outcome: f ? f.outcome : "could_not_boot",
          detail: f ? f.detail : "the verifier did not return a result",
          defects: f ? f.defects : [],
          evidence: r?.ok ? r.value.artifacts.files.map((x) => x.uri) : [],
        };
      },
    );
    // Only the scope that forked a handle may dispose it, so the pipeline items leave that to this scope.
    await Promise.all(forks.map((f) => f?.dispose()));
    return out.map(
      (v, i) => v ?? { name: list[i].name, outcome: "could_not_boot", detail: "dropped", defects: [], evidence: [] },
    );
  };

  sb.phase("verify");
  let verdicts = await verifyAll(flows, "verify");

  // 5. One fix round for a broken flow, then re-verify only those flows with fresh verifiers.
  const broken = verdicts.filter((v) => v.outcome === "broken");
  if (broken.length > 0) {
    sb.phase("verify-fix");
    const report = broken
      .map((v) => `- ${v.name}: ${v.detail}\n${v.defects.map((d) => `  - ${d.where}: ${d.seen}`).join("\n")}`)
      .join("\n");
    await sb.agents.ImplementSpec(
      {
        spec,
        context:
          `Verification drove the app and these flows came out broken. Fix them on this branch.\n${report}`.slice(
            0,
            8000,
          ),
      },
      {
        sandbox: box,
        harness: "claude-code",
        label: "verify-fix",
        git: { branch, baseBranch: base },
        pr: { draft: true },
      },
    );
    await box.push();
    sb.phase("reverify");
    const again = await verifyAll(
      flows.filter((f) => broken.some((b) => b.name === f.name)),
      "reverify",
    );
    verdicts = verdicts.map((v) => again.find((a) => a.name === v.name) ?? v);
  }

  await record.section("Verified", verifiedSection(verdicts));

  // 6. Confirm, and do not merge.
  sb.phase("confirm");
  const lines = verdicts.map((v) => `${v.outcome === "verified" ? "✅" : "❌"} ${v.name}: ${v.outcome}`);
  const clean = verdicts.length > 0 && verdicts.every((v) => v.outcome === "verified");
  const answer = await sb.ask({
    question: [
      `${pr ? pr.url : branch}`,
      `${rounds.length} review round(s); ${carried.length} finding(s) carried, not fixed.`,
      ...(lines.length ? lines : ["No flows were verified."]),
      `Merge${pr ? ` PR #${pr.number}` : ""}?`,
    ].join("\n"),
    choices: ["merge", "hold"],
    timeout: "24h",
  });

  return {
    status: clean ? "verified" : "needs_attention",
    pr,
    branch,
    build: {
      summary: build.result.summary,
      followUps: build.result.followUps,
      openQuestions: build.result.openQuestions,
    },
    rounds,
    carried: carried.map((f) => ({
      reviewer: f.reviewer,
      severity: f.severity,
      verdict: f.verdict,
      file: f.file,
      summary: f.summary,
    })),
    flows: verdicts,
    decision: answer,
  };
}

// The PR is the record of the run (release-prep §2.4): a comment per review round and per fix round, each ending
// in a stage marker, and three body sections kept up to date. Without a PR, every write is skipped.
function prRecord(sb, pr) {
  if (!pr) sb.log("no PR was opened, so the PR comments and sections are skipped", "warn");
  return {
    comment: async (body) => (pr ? sb.pr.comment({ pr, body }) : null),
    section: async (heading, content) => (pr ? sb.pr.update({ pr, section: { heading, content } }) : null),
  };
}

function findingLine(f) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  return `- **${f.severity}** ${f.verdict} \`${where}\` (${f.reviewer}): ${f.summary}`;
}

function reviewedComment(round, fixNow, carried, missing) {
  return [
    `### Review round ${round}`,
    "",
    missing.length ? `Not answered: ${missing.join(", ")}.\n` : "",
    `**To fix now (${fixNow.length})**`,
    ...(fixNow.length ? fixNow.map(findingLine) : ["- none"]),
    "",
    `**Carried, not fixed (${carried.length})**`,
    ...(carried.length ? carried.map(findingLine) : ["- none"]),
    "",
    `<!-- task-lifecycle-round:${round} stage:reviewed -->`,
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
}

function completeComment(round, fix, fixed, headSha) {
  return [
    `### Fixes for round ${round}: ${fix.status}`,
    "",
    fix.summary,
    "",
    `Addressed ${fixed.length} finding(s):`,
    ...fixed.map(findingLine),
    "",
    `Head: \`${headSha}\``,
    "",
    `<!-- task-lifecycle-round:${round} stage:complete head:${headSha} -->`,
  ].join("\n");
}

function whatChanged(result) {
  const followUps = result.followUps ?? [];
  return [result.summary, ...(followUps.length ? ["", "Follow-ups:", ...followUps.map((f) => `- ${f}`)] : [])].join(
    "\n",
  );
}

function verifiedSection(verdicts) {
  if (verdicts.length === 0) return "No flows were verified.";
  return verdicts
    .map((v) =>
      [
        `- ${v.outcome === "verified" ? "✅" : "❌"} ${v.name}: ${v.outcome}, ${v.detail}`,
        ...v.evidence.map((uri) => `  - ${uri}`),
      ].join("\n"),
    )
    .join("\n");
}

/** The spec as given, in a fence longer than any backtick run inside it, cut at 8,000 characters. */
function sourceBlock(spec) {
  const text = typeof spec === "string" ? spec : JSON.stringify(spec, null, 2);
  const cut = text.length > 8000 ? `${text.slice(0, 8000)}\n… (cut at 8,000 characters)` : text;
  const longest = Math.max(0, ...(cut.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${cut}\n${fence}`;
}
