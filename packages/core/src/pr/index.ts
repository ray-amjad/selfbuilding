import { OpenedCall } from "../engine/calls.js";
import { currentFrame, type Frame, internal, maybeFrame } from "../engine/context.js";
import { ConfigError, PrTargetError } from "../errors/classes.js";
import type {
  PrTarget,
  PrUpdate,
  PullRequestApi,
  PullRequestComment,
  PullRequestInfo,
  PullRequestPatch,
} from "../types/security.js";

// Reading, commenting on and editing a run's pull request from factory and script code
// (docs/spec/release-prep.md §2). Owner: script-pr.

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_HOST = "github.com";

type Refuse = (reason: string) => PrTargetError;

function shown(target: unknown): string {
  let text: string;
  try {
    text = typeof target === "string" ? JSON.stringify(target) : (JSON.stringify(target) ?? String(target));
  } catch {
    text = String(target);
  }
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function checkHost(found: string, host: string, refuse: Refuse): void {
  if (found.toLowerCase() !== host.toLowerCase()) {
    throw refuse(`The PR is on ${found}, but this run's git broker answers for ${host}`);
  }
}

function checkNumber(value: unknown, refuse: Refuse): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw refuse("A PR number is a positive integer");
  return n;
}

function checkRepo(owner: string | undefined, name: string | undefined, refuse: Refuse): [string, string] {
  if (!owner || !name || !SEGMENT.test(owner) || !SEGMENT.test(name)) {
    throw refuse("A PR target names its repository as <owner>/<repo>");
  }
  return [owner, name];
}

function parseUrl(text: string, host: string, refuse: Refuse): { repo: string; number: number } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw refuse("Not a PR URL");
  }
  if (url.protocol !== "https:") throw refuse("A PR URL starts with https://");
  checkHost(url.host, host, refuse);
  // https://<host>/<owner>/<repo>/pull/<n>, optionally followed by a tab such as /files.
  const [owner, name, pull, n] = url.pathname.split("/").filter((s) => s.length > 0);
  if (pull !== "pull" || n === undefined || !/^\d+$/.test(n)) {
    throw refuse("A PR URL looks like https://<host>/<owner>/<repo>/pull/<n>");
  }
  const [o, r] = checkRepo(owner, name, refuse);
  return { repo: `${host}/${o}/${r}`, number: checkNumber(n, refuse) };
}

function parseRepoName(text: string, host: string, refuse: Refuse): string {
  const parts = text
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split("/");
  if (parts.length !== 2 && parts.length !== 3) throw refuse("A PR target names its repository as <owner>/<repo>");
  const [found, owner, name] = parts.length === 2 ? [host, parts[0], parts[1]] : parts;
  checkHost(found ?? "", host, refuse);
  const [o, r] = checkRepo(owner, name, refuse);
  return `${host}/${o}/${r}`;
}

/** The run's git broker host, else github.com. */
function defaultHost(): string {
  return maybeFrame()?.run.config.git?.host ?? DEFAULT_HOST;
}

/**
 * Parses a PR target into `{ repo: "<host>/<owner>/<name>", number }` (release-prep §2.2). Takes an agent result's
 * `artifacts.pr`, any `{ url }`, a PR URL, or `{ repo, number }`. `host` defaults to the run's git broker host, else
 * github.com. Throws PrTargetError.
 */
export function parsePrTarget(target: PrTarget, host?: string): { repo: string; number: number } {
  const on = host ?? defaultHost();
  const refuse: Refuse = (reason) => new PrTargetError({ target: shown(target), reason });
  if (typeof target === "string") return parseUrl(target, on, refuse);
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw refuse("A PR target is a PR URL or an object");
  }
  const o = target as Record<string, unknown>;
  if (typeof o.url === "string") {
    const parsed = parseUrl(o.url, on, refuse);
    if (o.number !== undefined && o.number !== parsed.number) throw refuse("The PR's url and number disagree");
    return parsed;
  }
  if (typeof o.repo === "string") {
    if (o.number === undefined) throw refuse("A PR target with a repo needs its number");
    return { repo: parseRepoName(o.repo, on, refuse), number: checkNumber(o.number, refuse) };
  }
  throw refuse("A PR target needs a url, or a repo and a number");
}

// ---- sections ---------------------------------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Per line: true when it is inside (or opens or closes) a fenced code block, whose `## ` lines are not headings. */
function fencedLines(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | undefined;
  for (const line of lines) {
    const fence = FENCE.exec(line)?.[1];
    if (open === undefined) {
      if (fence !== undefined) {
        open = fence;
        out.push(true);
      } else out.push(false);
      continue;
    }
    out.push(true);
    if (fence !== undefined && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) {
      open = undefined;
    }
  }
  return out;
}

/**
 * The first line of the Selfbuilding trailer block: a `---` line followed, within its next three non-blank lines, by
 * a `Selfbuilding-Run:` line. Counting non-blank lines lets the optional `Run: <url>` line sit between them.
 */
function trailerStart(lines: string[], fenced: boolean[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || (lines[i] ?? "").trimEnd() !== "---") continue;
    let seen = 0;
    for (let j = i + 1; j < lines.length && seen < 3; j++) {
      const line = (lines[j] ?? "").trim();
      if (line.length === 0) continue;
      seen++;
      if (line.startsWith("Selfbuilding-Run:")) return i;
    }
  }
  return -1;
}

function checkHeading(heading: unknown): string {
  if (typeof heading !== "string") throw new ConfigError("A PR section heading is a string.");
  if (/[\r\n]/.test(heading)) throw new ConfigError("A PR section heading is one line.");
  const trimmed = heading.trim();
  if (trimmed.length === 0) throw new ConfigError("A PR section heading cannot be empty.");
  return trimmed;
}

function trimBlankTail(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim().length === 0) end--;
  return lines.slice(0, end);
}

/**
 * Replaces the `## <heading>` block of a Markdown PR body with `content` (release-prep §2.2), or inserts it before
 * the Selfbuilding trailer block (or at the end) when the body has no such heading. Pure. Lines inside fenced code
 * blocks are never taken for headings or the trailer, so a spec quoted in a section cannot split it.
 */
export function replacePrSection(body: string, heading: string, content: string): string {
  const title = checkHeading(heading);
  if (typeof content !== "string") throw new ConfigError("A PR section's content is a string.");
  const headingLine = `## ${title}`;
  const block = `${headingLine}\n\n${content.trim()}\n\n`;
  const lines = body.split("\n");
  const fenced = fencedLines(lines);
  const trailer = trailerStart(lines, fenced);
  const bound = trailer === -1 ? lines.length : trailer;

  const start = lines.findIndex((line, i) => i < bound && !fenced[i] && line.trimEnd() === headingLine);
  if (start !== -1) {
    let end = start + 1;
    while (end < bound && (fenced[end] || !(lines[end] ?? "").startsWith("## "))) end++;
    const before = lines.slice(0, start);
    const rest = lines.slice(end);
    const head = before.length > 0 ? `${before.join("\n")}\n` : "";
    if (rest.length === 0 || rest.every((l) => l.trim().length === 0)) return `${head}${block.trimEnd()}\n`;
    return head + block + rest.join("\n");
  }

  if (trailer !== -1) {
    const before = trimBlankTail(lines.slice(0, trailer));
    const head = before.length > 0 ? `${before.join("\n")}\n\n` : "";
    return head + block + lines.slice(trailer).join("\n");
  }
  const kept = body.trimEnd();
  return `${kept.length > 0 ? `${kept}\n\n` : ""}${block.trimEnd()}\n`;
}

// ---- journaled PR calls ------------------------------------------------------------------------------------------

type Member = "get" | "update" | "comment";

function prApi<M extends Member>(frame: Frame, member: M, what: string): NonNullable<PullRequestApi[M]> {
  const api = frame.run.config.git?.pullRequests;
  if (!api) {
    throw new ConfigError(
      `Configure a git broker that can open PRs (githubApp or pat) to use sb.pr / ${what}: set config.git to githubApp({ appId, privateKey }) or pat({ push }) from @selfbuilding/channel-github.`,
    );
  }
  const fn = api[member];
  if (typeof fn !== "function") {
    throw new ConfigError(
      `config.git.pullRequests has no ${member}(), which ${what} needs. Use githubApp() or pat() from @selfbuilding/channel-github, or add ${member}() to your PullRequestApi.`,
    );
  }
  return fn.bind(api) as NonNullable<PullRequestApi[M]>;
}

/**
 * One journaled step named `name` (`pr.get#0`, ...). The call is opened synchronously, so its callPath follows
 * issue order; on replay the recorded value comes back and nothing is sent.
 */
function journaled<T>(
  frame: Frame,
  name: string,
  target: { repo: string; number: number },
  input: Record<string, unknown>,
  fn: (call: OpenedCall) => Promise<T>,
): Promise<T> {
  const call = new OpenedCall(frame, {
    kind: "step",
    name,
    target: `${name}:${target.repo}#${target.number}`,
    input: { ...target, ...input },
  });
  return (async () => {
    if (call.cached) return call.replay() as T;
    try {
      await frame.run.settleWrites();
      await call.start();
    } catch (error) {
      call.abandon();
      throw error;
    }
    let stored: T;
    try {
      const value = await internal(() => fn(call));
      stored = JSON.parse(JSON.stringify(value)) as T;
    } catch (error) {
      await call.fail(error).catch(() => {});
      throw error;
    }
    await call.complete(stored);
    return stored;
  })();
}

/** Runs `fn` with the synchronous checks first, turning any throw into a rejection. */
function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Reads one PR through the run's git broker. Journaled as a step (`pr.get`). */
export function getPr(pr: PrTarget): Promise<PullRequestInfo> {
  return guarded(() => {
    const frame = currentFrame("getPr");
    const target = parsePrTarget(pr, frame.run.config.git?.host ?? DEFAULT_HOST);
    const get = prApi(frame, "get", "getPr");
    return journaled(frame, "pr.get", target, {}, () => get(target.repo, target.number));
  });
}

/**
 * Comments on one PR as the host identity. Journaled (`pr.comment`); the API gets `dedupeKey`, by default
 * `<runId>.<callPath>`, so a crash between the post and the journal write still posts once.
 */
export function commentOnPr(pr: PrTarget, body: string, opts?: { dedupeKey?: string }): Promise<PullRequestComment> {
  return guarded(() => {
    const frame = currentFrame("commentOnPr");
    const target = parsePrTarget(pr, frame.run.config.git?.host ?? DEFAULT_HOST);
    if (typeof body !== "string") throw new ConfigError("commentOnPr(pr, body) needs the comment body as a string.");
    if (opts?.dedupeKey !== undefined && (typeof opts.dedupeKey !== "string" || opts.dedupeKey.length === 0)) {
      throw new ConfigError("commentOnPr dedupeKey must be a non-empty string.");
    }
    const comment = prApi(frame, "comment", "commentOnPr");
    return journaled(frame, "pr.comment", target, {}, (call) =>
      comment(target.repo, target.number, frame.run.events.redact(body), {
        dedupeKey: opts?.dedupeKey ?? `${frame.run.runId}.${call.callPath}`,
      }),
    );
  });
}

// One promise chain per repo#number, so parallel section edits in one process never lose each other's edit.
const editQueues = new Map<string, Promise<void>>();

function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = editQueues.get(key) ?? Promise.resolve();
  const next = previous.then(fn);
  const tail = next.then(
    () => {},
    () => {},
  );
  editQueues.set(key, tail);
  void tail.then(() => {
    if (editQueues.get(key) === tail) editQueues.delete(key);
  });
  return next;
}

/**
 * Edits one PR's title, body or one `## heading` section of its body. Journaled (`pr.update`). A section edit reads
 * the PR first and applies `replacePrSection` to `patch.body ?? current body`; edits to one PR are serialised within
 * this process (there is no cross-process guarantee: GitHub has no conditional PATCH).
 */
export function updatePr(pr: PrTarget, patch: PrUpdate): Promise<PullRequestInfo> {
  return guarded(() => {
    const frame = currentFrame("updatePr");
    const target = parsePrTarget(pr, frame.run.config.git?.host ?? DEFAULT_HOST);
    if (patch === null || typeof patch !== "object") {
      throw new ConfigError("updatePr(pr, patch) needs a patch: { title?, body?, section?: { heading, content } }.");
    }
    for (const key of ["title", "body"] as const) {
      if (patch[key] !== undefined && typeof patch[key] !== "string") {
        throw new ConfigError(`updatePr patch.${key} must be a string.`);
      }
    }
    const section = patch.section;
    if (section !== undefined) {
      if (section === null || typeof section !== "object") {
        throw new ConfigError("updatePr patch.section is { heading, content }.");
      }
      checkHeading(section.heading);
      if (typeof section.content !== "string")
        throw new ConfigError("updatePr patch.section.content must be a string.");
    }
    if (patch.title === undefined && patch.body === undefined && section === undefined) {
      throw new ConfigError("updatePr needs a title, a body or a section to change.");
    }
    const update = prApi(frame, "update", "updatePr");
    const get = section !== undefined && patch.body === undefined ? prApi(frame, "get", "updatePr") : undefined;
    const redact = (text: string) => frame.run.events.redact(text);
    return journaled(frame, "pr.update", target, {}, () =>
      serialised(`${target.repo}#${target.number}`, async () => {
        let body = patch.body;
        if (section !== undefined) {
          const current = body ?? (await (get as NonNullable<typeof get>)(target.repo, target.number)).body;
          body = replacePrSection(current, section.heading, section.content);
        }
        const out: PullRequestPatch = {};
        if (patch.title !== undefined) out.title = redact(patch.title);
        if (body !== undefined) out.body = redact(body);
        return update(target.repo, target.number, out);
      }),
    );
  });
}
