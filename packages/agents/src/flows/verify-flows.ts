import {
  type Agent,
  type AgentResult,
  type ArtifactStore,
  type Budget,
  type ConcurrencyOptions,
  type Factory,
  type FactoryOptions,
  factory,
  type Harness,
  type HitlOptions,
  isUsageError,
  log,
  notify,
  now,
  type PullRequestApi,
  parallel,
  phase,
  pipeline,
  redactForRun,
  runArtifacts,
  type SandboxHandle,
  type SandboxProvider,
  type Settled,
  type SizeName,
  sandbox,
  step,
} from "@selfbuilding/core";
import type { z } from "zod";
import { composePrBody, replaceSection } from "../decision-page.js";
import {
  type CodeReviewInput,
  type CodeReviewResult,
  IMPLEMENTATION_NOTES_PATH,
  type ImplementSpecInput,
  type ImplementSpecResult,
  OUT_FILES_DIR,
  VERIFY_EVIDENCE_DIR,
  type VerifyFlow,
  type VerifyInput,
  type VerifyResult,
} from "../schemas.js";
import { flowSlug } from "./checks.js";
import {
  type FindFlowsInput,
  type FindFlowsResult,
  type FlowEvidence,
  type FlowKind,
  type FlowVerdict,
  VerifyFlowsInput,
  VerifyFlowsOutput,
} from "./schemas.js";
import { renderRunSummary } from "./summary.js";

// implement → (review ∥ findFlows) → one Verify per flow → summary (docs/spec/demo-path.md §4.3). Owner: verify-flows.

export interface VerifyFlowsAgents {
  ImplementSpec: Agent<ImplementSpecInput, ImplementSpecResult>;
  CodeReview: Agent<CodeReviewInput, CodeReviewResult>;
  FindFlows: Agent<FindFlowsInput, FindFlowsResult>;
  Verify: Agent<VerifyInput, VerifyResult>;
}

export interface VerifyFlowsOptions {
  agents: VerifyFlowsAgents;
  /** Default "verify-flows". */
  name?: string;
  /**
   * The shared build box. Default size "medium". Every Verify runs on a fork of it, so forks inherit its image: on
   * template providers give it the browser image (the Codex template); another harness is installed on first use.
   */
  builder?: { harness?: Harness; provider?: SandboxProvider; size?: SizeName };
  /** Runs on a fork of the build box. */
  reviewer?: { harness?: Harness };
  /** Runs on a fork of the build box. */
  finder?: { harness?: Harness };
  /**
   * One fork per flow. Default harness Codex (browser), size "medium". `size` applies only when a fork fails and
   * the flow falls back to a fresh box: a fork keeps the build box's size. `parallel` is how many flows are forked
   * and verified at once; default one less than `concurrency.sandboxes` (4), so the build box keeps its slot.
   */
  verifier?: { harness?: Harness; size?: SizeName; parallel?: number };
  /** Opens the PR and writes the summary section. Without it no PR is opened. */
  pullRequests?: PullRequestApi;
  /** Post the summary to the run's notify channels (Slack). Default true. */
  notify?: boolean;
  /** Where the summary page is stored. Default: the run's ArtifactStore, where the evidence already is. */
  artifacts?: ArtifactStore;
  budget?: Budget;
  concurrency?: ConcurrencyOptions;
  hitl?: HitlOptions;
}

type Input = z.infer<typeof VerifyFlowsInput>;
type Output = VerifyFlowsOutput;
type Review = Output["review"];
/** A flow to verify, with the slug its evidence directory and pipeline key use. */
type Planned = { flow: VerifyFlow; slug: string; kind?: FlowKind; entry?: string; why?: string };

const DEFAULT_MAX_FLOWS = 6;
const DEFAULT_SANDBOXES = 4;
/** Signed links in Slack and the PR body last as long as SigV4 allows. */
const LINK_TTL = "7d";

/**
 * Builds the verifyFlows factory: ImplementSpec in a shared build box, then CodeReview and FindFlows in parallel,
 * each on its own fork, then one Verify per flow, each on its own fork, then a summary page stored with the
 * evidence, posted to the run's channels and written into the PR. It never merges and never fixes.
 */
export function createVerifyFlows(o: VerifyFlowsOptions): Factory<Input, Output> {
  const A = o.agents;
  const parallelVerifies = o.verifier?.parallel ?? Math.max(1, (o.concurrency?.sandboxes ?? DEFAULT_SANDBOXES) - 1);
  if (!Number.isInteger(parallelVerifies) || parallelVerifies < 1) {
    throw new Error(`verifyFlows verifier.parallel must be a positive integer; got ${parallelVerifies}`);
  }

  const opts: FactoryOptions<typeof VerifyFlowsInput, typeof VerifyFlowsOutput> = {
    name: o.name ?? "verify-flows",
    input: VerifyFlowsInput,
    output: VerifyFlowsOutput,
  };
  if (o.budget) opts.budget = o.budget;
  if (o.concurrency) opts.concurrency = o.concurrency;
  if (o.hitl) opts.hitl = o.hitl;

  return factory(opts, async (input) => {
    const build = sandbox({
      provider: o.builder?.provider,
      repo: input.repo,
      label: "build",
      size: o.builder?.size ?? "medium",
    });
    try {
      return await verifyFlows(input, build);
    } finally {
      // Paused, not killed: a human may want to look at the build box after reading the summary.
      await build.dispose({ mode: "pause" });
    }
  });

  async function verifyFlows(input: Input, build: SandboxHandle): Promise<Output> {
    const { repo } = input;

    // 1. Build in the shared box.
    phase("build");
    const implementInput: ImplementSpecInput = { spec: input.spec };
    if (input.testCommand) implementInput.testCommand = input.testCommand;
    const impl = await A.ImplementSpec(implementInput, {
      sandbox: build,
      label: "implement",
      ...(o.builder?.harness ? { harness: o.builder.harness } : {}),
      ...(input.baseBranch ? { git: { baseBranch: input.baseBranch } } : {}),
    });
    const baseBranch = impl.artifacts.branch?.base ?? input.baseBranch ?? "main";
    // Journaled, so a resume reuses the first push instead of pushing a tree later work changed.
    const head = await step("push-build", () => build.push());
    const context: SummaryContext = {
      runId: impl.runId,
      title: impl.result.prTitle,
      branch: head.name,
      base: baseBranch,
      prBody: impl.result.prBody,
      pr: prRef(impl.artifacts.pr),
      review: null,
      flows: [],
    };
    const buildOut = { status: impl.result.status, summary: impl.result.summary };

    if (impl.result.status !== "done") {
      log("warn", "the build stopped before it was done; nothing is verified", { status: impl.result.status });
      return finish("build_incomplete", context, buildOut, input, null);
    }

    // 2. Open the PR as the host, with the implementation notes in the body.
    if (o.pullRequests) {
      phase("open-pr");
      const api = o.pullRequests;
      context.pr = prRef(
        await step("open-pr", async () =>
          api.openOrUpdate({
            repo,
            head: head.name,
            base: baseBranch,
            title: impl.result.prTitle,
            body: composePrBody({ prBody: impl.result.prBody, notes: await readNotes(build) }),
            draft: true,
          }),
        ),
      );
    }

    // 3. Review and find the flows at once, each on its own fork of the build box.
    phase("review");
    const target = { kind: "diff" as const, base: baseBranch, head: head.name };
    const findFlows = !input.flows;
    const forks = await forkOrNothing(build, findFlows ? 2 : 1, "review");
    const placed = (fork: SandboxHandle | null | undefined) =>
      fork ? { sandbox: fork } : { sandbox: "fresh" as const, repo, git: { branch: head.name } };
    const reviewInput: CodeReviewInput = { target };
    if (input.testCommand) reviewInput.notes = `The run's test command is \`${input.testCommand}\`.`;
    let reviewed: Settled<AgentResult<CodeReviewResult>> | null;
    let found: Settled<AgentResult<FindFlowsResult>> | null = null;
    try {
      const results = await parallel({
        review: () =>
          A.CodeReview.settled(reviewInput, {
            ...placed(forks[0]),
            label: "review",
            ...(o.reviewer?.harness ? { harness: o.reviewer.harness } : {}),
          }),
        find: () =>
          findFlows
            ? A.FindFlows.settled(
                { change: impl.result.summary, maxFlows: input.maxFlows ?? DEFAULT_MAX_FLOWS, target },
                {
                  ...placed(forks[1]),
                  label: "find-flows",
                  ...(o.finder?.harness ? { harness: o.finder.harness } : {}),
                },
              )
            : Promise.resolve(null),
      });
      reviewed = results.review;
      found = results.find;
    } finally {
      await Promise.all(forks.map((f) => f?.dispose()));
    }
    context.review = reviewSummary(reviewed);

    // 4. The flows: the caller's, else what findFlows returned.
    let planned: Planned[];
    if (input.flows) planned = plan(input.flows.map((flow) => ({ flow })));
    else if (found?.ok) {
      const r = found.value.result;
      if (r.noRunnableSurface) log("info", "findFlows found no runnable surface", { summary: r.summary });
      planned = plan(
        r.flows.slice(0, input.maxFlows ?? DEFAULT_MAX_FLOWS).map((f) => ({
          flow: {
            name: f.name,
            endState: f.endState,
            ...(f.rows ? { rows: f.rows } : {}),
            ...(f.sideEffects ? { sideEffects: f.sideEffects } : {}),
          },
          kind: f.kind,
          entry: f.entry,
          why: f.why,
        })),
      );
    } else {
      log("warn", "findFlows did not complete; there are no flows to verify", {
        code: found && !found.ok ? String(found.code) : "no result",
      });
      planned = [];
    }
    if (planned.length === 0) return finish("no_flows", context, buildOut, input, build);

    // 5. One Verify per flow, each on its own fork. Forks are made in waves so the build box keeps its slot.
    phase("verify");
    const verdicts: FlowVerdict[] = [];
    for (let start = 0, wave = 1; start < planned.length; start += parallelVerifies, wave++) {
      const batch = planned.slice(start, start + parallelVerifies);
      const waveForks = await forkOrNothing(build, batch.length, `verify-${wave}`);
      const handed = new Map(batch.map((p, i) => [p.slug, waveForks[i] ?? null]));
      const results = await pipeline(
        { key: (p: Planned) => p.slug, label: `verify-${wave}` },
        batch,
        async (p: Planned) => {
          const fork = handed.get(p.slug) ?? null;
          try {
            return await verifyOne(p, fork, impl.result.summary, input, head.name);
          } finally {
            await fork?.dispose();
          }
        },
      );
      batch.forEach((p, i) => {
        verdicts.push(
          results[i] ?? {
            ...verdictBase(p),
            outcome: "unverifiable",
            detail: "The Verify step failed before it returned a result.",
            callPath: "",
            evidence: [],
            error: "the Verify step was dropped",
          },
        );
      });
    }
    context.flows = verdicts;
    const status = verdicts.every((v) => v.outcome === "verified") ? "all_verified" : "some_failed";
    return finish(status, context, buildOut, input, build);
  }

  async function verifyOne(
    p: Planned,
    fork: SandboxHandle | null,
    change: string,
    input: Input,
    branch: string,
  ): Promise<FlowVerdict> {
    const verifyInput: VerifyInput = { change: describeChange(change, p), flows: [p.flow] };
    if (input.appNotes) verifyInput.appNotes = input.appNotes;
    if (!fork) log("warn", `fork for flow "${p.flow.name}" failed; verifying in a fresh sandbox instead`);
    const settled = await A.Verify.settled(verifyInput, {
      label: "verify",
      ...(o.verifier?.harness ? { harness: o.verifier.harness } : {}),
      ...(fork
        ? { sandbox: fork }
        : {
            sandbox: "fresh" as const,
            repo: input.repo,
            git: { branch },
            ...(o.verifier?.size ? { size: o.verifier.size } : {}),
          }),
    });
    const res = settled.ok ? settled.value : null;
    const flowResult = res
      ? (res.result.flows.find((f) => f.name === p.flow.name) ??
        res.result.flows.find((f) => flowSlug(f.name) === flowSlug(p.flow.name)) ??
        (res.result.flows.length === 1 ? res.result.flows[0] : undefined))
      : undefined;
    const named = flowResult ? [flowResult.evidence, ...(flowResult.evidenceFiles ?? [])] : [];
    const stored = res ? evidenceOf(res, p, named) : [];
    // A call that settled had its /selfbuilding/out/files collected into the attempt by the runtime, so only a
    // failed call's partial evidence is read off the fork before it goes.
    const evidence =
      fork && !res ? [...stored, ...(await step("evidence", () => collectEvidence(fork, p, named, stored)))] : stored;
    if (!res) {
      const error = settled.ok ? undefined : settled.error;
      const code = settled.ok ? "" : String(settled.code);
      return {
        ...verdictBase(p),
        outcome: "unverifiable",
        detail: `Verify did not complete (${code}).`,
        callPath: "",
        evidence,
        error: `${code}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000),
      };
    }
    if (!flowResult) {
      return {
        ...verdictBase(p),
        outcome: "unverifiable",
        detail: `Verify returned no result for this flow. Its summary: ${res.result.summary}`.slice(0, 2000),
        callPath: res.callPath,
        evidence,
      };
    }
    return {
      ...verdictBase(p),
      outcome: flowResult.outcome,
      detail: flowResult.detail,
      callPath: res.callPath,
      evidence,
    };
  }

  async function finish(
    status: Output["status"],
    context: SummaryContext,
    build: Output["build"],
    input: Input,
    box: SandboxHandle | null,
  ): Promise<Output> {
    phase("summary");
    const generatedAt = new Date(now()).toISOString();
    const summaryInput = { ...context, generatedAt };
    // The output and the journal carry the link-free Markdown: signed URLs expire.
    const { markdown } = renderRunSummary(summaryInput);
    const page = await step("store-summary", async () => {
      const run = runArtifacts();
      const store = o.artifacts ?? run.artifacts;
      const contents: Record<string, Uint8Array> = {};
      for (const f of context.flows) {
        for (const e of f.evidence) {
          if (!(e.path.endsWith("/evidence.md") || e.contentType.startsWith("image/"))) continue;
          try {
            contents[e.uri] = await run.artifacts.read(e.uri);
          } catch (error) {
            log("warn", `could not read ${e.path} for the summary page; linking it instead`, { error: String(error) });
          }
        }
      }
      const { html } = renderRunSummary({ ...summaryInput, contents });
      const ref = await store.put(`runs/${context.runId}/summary.html`, html, {
        contentType: "text/html; charset=utf-8",
      });
      return { uri: ref.uri, sha256: ref.sha256, bytes: ref.bytes, contentType: ref.contentType };
    });

    if (o.notify ?? true) {
      await step("post-summary", async () => {
        const links = await signLinks(context, page.uri);
        // Slack shows mrkdwn, not Markdown: `#` headings and `[text](url)` links would arrive as raw text.
        const pageLink = links[page.uri] ? `<${links[page.uri]}|Summary page>` : `Summary page: \`${page.uri}\``;
        const text = `${renderRunSummary({ ...summaryInput, links }).slack.mrkdwn}\n\n${pageLink}`;
        const posted = await notify(text);
        if (!posted.delivered) log("info", "the summary was not posted", { note: posted.note });
        return posted.delivered;
      });
    }

    if (o.pullRequests && context.pr && box) {
      const api = o.pullRequests;
      const pr = context.pr;
      await step("update-pr", async () => {
        const links = await signLinks(context, page.uri);
        const section = renderRunSummary({ ...summaryInput, links })
          .markdown.split("\n")
          .slice(1)
          .join("\n")
          .trim();
        const pageLine = links[page.uri] ? `\n\n[Summary page](${links[page.uri]})` : "";
        const body = replaceSection(
          composePrBody({ prBody: context.prBody ?? "", notes: await readNotes(box) }),
          "Verification",
          `${section}${pageLine}`,
        );
        const ref = await api.openOrUpdate({
          repo: input.repo,
          head: context.branch,
          base: context.base ?? input.baseBranch ?? "main",
          title: context.title,
          body: `${body}\n`,
          draft: true,
        });
        return { url: ref.url, number: ref.number, pr: pr.number };
      });
    }

    return {
      status,
      branch: context.branch,
      pr: context.pr,
      build,
      review: context.review,
      flows: context.flows,
      summary: { markdown, page },
    };
  }

  /** Signed links for every evidence file and the page, made at post time. Empty when the store cannot sign. */
  async function signLinks(context: SummaryContext, pageUri: string): Promise<Record<string, string>> {
    const run = runArtifacts();
    const links: Record<string, string> = {};
    const sign = async (store: ArtifactStore, uri: string) => {
      if (!store.signedUrl) return;
      try {
        links[uri] = await store.signedUrl(uri, { expiresIn: LINK_TTL });
      } catch (error) {
        log("warn", "could not sign a summary link; showing the stored uri", { uri, error: String(error) });
      }
    };
    for (const f of context.flows) for (const e of f.evidence) await sign(run.artifacts, e.uri);
    await sign(o.artifacts ?? run.artifacts, pageUri);
    return links;
  }
}

interface SummaryContext {
  runId: string;
  title: string;
  branch: string;
  base?: string;
  prBody?: string;
  pr: { url: string; number: number } | null;
  review: Review;
  flows: FlowVerdict[];
}

/** Gives every flow a unique slug: the evidence directory name, and the pipeline key. */
function plan(items: Omit<Planned, "slug">[]): Planned[] {
  const used = new Set<string>();
  return items.map((item) => {
    const base = flowSlug(item.flow.name);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base.slice(0, 44)}-${n}`;
    used.add(slug);
    return { ...item, slug };
  });
}

function verdictBase(p: Planned): Pick<FlowVerdict, "name" | "slug" | "kind"> {
  return { name: p.flow.name, slug: p.slug, ...(p.kind ? { kind: p.kind } : {}) };
}

/** The builder's summary plus where this flow starts and why it is on the list, so the verifier needs no diff. */
function describeChange(change: string, p: Planned): string {
  const extra = [p.entry ? `Start: ${p.entry}.` : "", p.why ? `Why this flow: ${p.why}` : ""].filter(Boolean);
  const text = extra.length > 0 ? `${change}\n\n${extra.join("\n")}` : change;
  return text.length > 8000 ? text.slice(0, 8000) : text;
}

/** The stored files of one flow: those the result names, plus anything else under the flow's evidence directory. */
function evidenceOf(res: AgentResult<VerifyResult>, p: Planned, named: string[]): FlowEvidence[] {
  const wanted = new Set(named);
  const dirs = [`${VERIFY_EVIDENCE_DIR}/${p.slug}/`, `${VERIFY_EVIDENCE_DIR}/${flowSlug(p.flow.name)}/`];
  return res.artifacts.files
    .map((f) => ({ ...f, path: boxPathOf(f.path) }))
    .filter((f) => wanted.has(f.path) || dirs.some((d) => f.path.startsWith(d)))
    .map((f) => ({
      path: f.path,
      uri: f.ref.uri,
      contentType: f.ref.contentType === "application/octet-stream" ? contentTypeOf(f.path) : f.ref.contentType,
      bytes: f.ref.bytes,
    }));
}

/**
 * The box path of a collected file. The runtime reports what it copied out of /selfbuilding/out/files relative to
 * its attempt directory (`artifacts/files/<rel>`); the verdicts and the summary name files by their box path.
 */
function boxPathOf(p: string): string {
  if (p.startsWith(`${OUT_FILES_DIR}/`)) return p;
  const m = /^(?:.*\/)?artifacts\/files\/(.+)$/.exec(p);
  return m?.[1] && !m[1].split("/").includes("..") ? `${OUT_FILES_DIR}/${m[1]}` : p;
}

/** At most this many files per flow are read off a fork. */
const COLLECT_MAX_FILES = 50;
/** Files larger than this stay in the box (a trace, a video); the page links what it has. */
const COLLECT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const COLLECT_MAX_FLOW_BYTES = 16 * 1024 * 1024;
/** Raw bytes per exec: base64 of this stays well under the 64 KiB output tail every provider returns. */
const COLLECT_CHUNK_BYTES = 36 * 1024;

/**
 * Reads the flow's evidence directory (and any file the result names under the verify directory) off its fork and
 * stores each file in the run's ArtifactStore under runs/<runId>/verify/<slug>/. Files already stored are skipped.
 */
async function collectEvidence(
  fork: SandboxHandle,
  p: Planned,
  named: string[],
  stored: FlowEvidence[],
): Promise<FlowEvidence[]> {
  const have = new Set(stored.map((e) => e.path));
  const prefix = `${VERIFY_EVIDENCE_DIR}/`;
  const slugs = [...new Set([p.slug, flowSlug(p.flow.name)])];
  // Relative paths only: some providers rewrite absolute box paths, in commands and in what they print.
  const listed = await fork.exec(
    `${slugs.map((s) => `echo '@@ ${s}'; [ -d ${shellQuote(prefix + s)} ] && (cd ${shellQuote(prefix + s)} && find . -type f)`).join("; ")}; true`,
  );
  const found: string[] = [];
  let dir = "";
  for (const line of listed.stdoutTail.split("\n")) {
    if (line.startsWith("@@ ")) dir = line.slice(3).trim();
    else if (dir && line.startsWith("./")) found.push(`${prefix}${dir}/${line.slice(2).trim()}`);
  }
  // The paths come from the box, so they are untrusted: only plain files under the verify directory are read.
  const paths = [...new Set([...found, ...named].map((l) => l.trim()))]
    .filter((f) => f.startsWith(prefix) && !f.split("/").includes("..") && !/[\n\r]/.test(f) && !have.has(f))
    .sort()
    .slice(0, COLLECT_MAX_FILES);
  const { runId, artifacts } = runArtifacts();
  const out: FlowEvidence[] = [];
  let total = 0;
  for (const file of paths) {
    const size = await fork.exec(`[ -f ${shellQuote(file)} ] && wc -c < ${shellQuote(file)}`);
    const bytes = Number.parseInt(size.stdoutTail.trim(), 10);
    if (size.exitCode !== 0 || !Number.isFinite(bytes)) continue;
    if (bytes > COLLECT_MAX_FILE_BYTES || total + bytes > COLLECT_MAX_FLOW_BYTES) {
      log("warn", `evidence file ${file} is too large to collect; it stays in the box`, { bytes });
      continue;
    }
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes; offset += COLLECT_CHUNK_BYTES) {
      const r = await fork.exec(
        `tail -c +${offset + 1} ${shellQuote(file)} | head -c ${COLLECT_CHUNK_BYTES} | base64 | tr -d '\\n'`,
      );
      if (r.exitCode !== 0 || r.truncated) throw new Error(`could not read ${file} from the box: ${r.stderrTail}`);
      chunks.push(Buffer.from(r.stdoutTail.trim(), "base64"));
    }
    const raw = Buffer.concat(chunks);
    if (raw.length !== bytes) throw new Error(`read ${raw.length} of ${bytes} bytes of ${file} from the box`);
    const contentType = contentTypeOf(file);
    const body = redactEvidence(raw, contentType);
    if (!body) {
      log("warn", `evidence file ${file} holds a secret this run delivered; it stays in the box`, { bytes });
      continue;
    }
    total += bytes;
    const ref = await artifacts.put(`runs/${runId}/verify/${p.slug}/${file.slice(prefix.length)}`, body, {
      contentType,
    });
    out.push({ path: file, uri: ref.uri, contentType, bytes: ref.bytes });
  }
  return out;
}

/**
 * What these files get is a signed link in Slack and the PR body, so they get the redaction every agent artifact
 * gets: text is scrubbed, and a binary that carries a secret is not stored at all (its bytes cannot be edited).
 */
function redactEvidence(raw: Buffer, contentType: string): Uint8Array | null {
  const textual = /^text\/|^application\/json|svg/.test(contentType) && !raw.includes(0);
  if (textual) return new TextEncoder().encode(redactForRun(raw.toString("utf8")));
  // latin1 maps each byte to one character, so a secret's bytes show up as its text.
  const asText = raw.toString("latin1");
  return redactForRun(asText) === asText ? new Uint8Array(raw) : null;
}

const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  zip: "application/zip",
  webm: "video/webm",
};

function contentTypeOf(file: string): string {
  const ext = file.split("/").at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function reviewSummary(r: Settled<AgentResult<CodeReviewResult>> | null): Review {
  if (!r) return { error: "the review did not run" };
  if (!r.ok) return { error: String(r.code) };
  return { verdict: r.value.result.verdict, findings: r.value.result.findings.length, summary: r.value.result.summary };
}

const prRef = (pr: { url: string; number: number } | undefined | null) =>
  pr ? { url: pr.url, number: pr.number } : null;

/** A fork that fails as a whole counts as every child failing: each call then takes its fresh fallback. */
async function forkOrNothing(box: SandboxHandle, n: number, why: string): Promise<(SandboxHandle | null)[]> {
  try {
    return await box.fork(n);
  } catch (error) {
    if (isUsageError(error)) throw error;
    log(
      "warn",
      `fork for ${why} failed (${error instanceof Error ? error.message : String(error)}); using fresh sandboxes`,
    );
    return Array.from({ length: n }, () => null);
  }
}

async function readNotes(box: SandboxHandle): Promise<string> {
  const r = await box.exec(`cat ${IMPLEMENTATION_NOTES_PATH} 2>/dev/null || true`);
  return r.stdoutTail;
}
