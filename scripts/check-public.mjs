#!/usr/bin/env node
// Scans the tracked tree for things that must not ship in a public repo (docs/spec/release-prep.md §6.2).
//
//   node scripts/check-public.mjs              scan `git ls-files`, honouring scripts/check-public.allow
//   node scripts/check-public.mjs --strict     scan without the allow file (release checklist)
//   node scripts/check-public.mjs --history    scan every line every commit on every ref added or removed
//                                              (`git log --all -p`), plus every path; combine with --strict
//   node scripts/check-public.mjs --self-test  run the rule table against built-in samples
//
// Hits print as `path:line rule`, never the matched text, so the output itself is safe to share. Extra regexes, one
// per line, come from the file named by $SELFBUILDING_PUBLIC_DENYLIST (an untracked local file for account ids and
// similar); blank lines and lines starting with `#` are ignored.
//
// Dependency-free on purpose: it runs before `pnpm install` would matter and lives outside the workspace.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOW_FILE = "scripts/check-public.allow";
// Files that must never have been committed at all, whatever they contain; a history that has one is not public.
const PRIVATE_FILES = new Set([".infisical.json", ".env"]);

// SHA-256 of each lowercased banned word or two-word phrase. Only hashes live here, so the scan never carries the
// names it looks for.
const BANNED_HASHES = new Set([
  "f315d114578d9aeff0cde67fed04f002f3a73e2b57e6bd569777b2f257338561",
  "905cb5a9761ae608741bf37224d7e2d088eeed95f5d0140879edc3f99a484d38",
  "24196f8a6feeb465c790774d3f85b53a2cdf84ed1e0044c420086c4310c3f56e",
  "715773c66c9347749f5921bdce502d7de7081e19d07c7b40a70f19665700d919",
  "19e05df6b2e5fb94f3ee7eed2c02d340a1128a00231f5f6949641a143ab3b57a",
  "3c38aafb0579dafe18bb584dce2786ccaab6835245f2979af4bb7dd2b6b90775",
  "4f31fa50e5bd5ff45684e560fc24aeee527a43739ab611c49c51098a33e2b469",
]);

// Fake credentials in tests and docs carry one of these words; a token containing one is not a hit.
const EXEMPT_TOKEN = /test|fake|example/i;

/** @typedef {{ name: string, re: RegExp, exemptTokens?: boolean }} Rule */

/** @type {Rule[]} */
const REGEX_RULES = [
  // `/home/agent/` is the sandbox user. Case-sensitive so API paths like `/users/{id}/` stay clean, and anchored to
  // a path start so `/selfbuilding/home/.codex/` is not a home directory.
  {
    name: "personal-path",
    re: /(?<![\w.-])(?:\/Users\/[A-Za-z0-9._-]+\/|\/home\/(?!agent\/)[A-Za-z0-9._-]+\/)/g,
  },
  { name: "tailnet-host", re: /[a-z0-9-]+\.ts\.net\b|\btail[0-9a-f]{6}\b/gi },
  { name: "slack-token", re: /xox[abpr]-[A-Za-z0-9-]{10,}/gi, exemptTokens: true },
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/gi, exemptTokens: true },
  { name: "impello-key", re: /\bimp_[A-Za-z0-9]{16,}/gi, exemptTokens: true },
  { name: "e2b-key", re: /\be2b_[A-Za-z0-9]{16,}/gi, exemptTokens: true },
  { name: "slack-id", re: /\b[UCW]0[A-Z0-9]{8,10}\b/g },
];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Lowercased words of a line; camelCase and snake/kebab parts are split so `FooBar` and `foo-bar` both count. */
function words(line) {
  return line
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasBannedName(line, hashes) {
  const w = words(line);
  for (let i = 0; i < w.length; i++) {
    if (hashes.has(sha256(w[i]))) return true;
    if (i + 1 < w.length && hashes.has(sha256(`${w[i]} ${w[i + 1]}`))) return true;
  }
  return false;
}

/** Rule names that fire on one line. */
function lineHits(line, rules, hashes) {
  const hits = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let fired = false;
    for (const m of line.matchAll(rule.re)) {
      if (rule.exemptTokens && EXEMPT_TOKEN.test(m[0])) continue;
      fired = true;
      break;
    }
    if (fired) hits.push(rule.name);
  }
  if (hasBannedName(line, hashes)) hits.push("banned-name");
  return hits;
}

function loadDenylist() {
  const file = process.env.SELFBUILDING_PUBLIC_DENYLIST;
  if (!file) return [];
  if (!existsSync(file)) {
    console.error(
      `check-public: SELFBUILDING_PUBLIC_DENYLIST names a file that does not exist; unset it or create it.`,
    );
    process.exit(2);
  }
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((source, i) => {
      // Hits name the pattern by its position (`denylist:2` is the second pattern), never by its text.
      try {
        return { name: `denylist:${i + 1}`, re: new RegExp(source, "g") };
      } catch {
        return die(`check-public: denylist pattern ${i + 1} is not a valid regular expression.`);
      }
    });
}

/** @returns {never} */
function die(message) {
  console.error(message);
  process.exit(2);
}

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Parses `path-glob<TAB>rule<TAB>reason` lines. The rule is a glob too: `*` or `denylist:*`. */
function parseAllow(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim() || raw.startsWith("#")) return;
    const [glob, rule, reason] = raw.split("\t");
    if (!glob || !rule || !reason?.trim()) {
      console.error(`check-public: ${ALLOW_FILE}:${i + 1} needs path-glob<TAB>rule<TAB>reason.`);
      process.exit(2);
    }
    entries.push({ re: globToRegExp(glob), ruleRe: globToRegExp(rule) });
  });
  return entries;
}

const allowed = (entries, file, rule) => entries.some((e) => e.re.test(file) && e.ruleRe.test(rule));

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Scans text and returns `{ line, rule }` for every hit. */
function scanText(text, rules, hashes) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of lineHits(line, rules, hashes)) hits.push({ line: i + 1, rule });
  });
  return hits;
}

function scanTree({ strict }) {
  const rules = [...REGEX_RULES, ...loadDenylist()];
  const allow =
    strict || !existsSync(path.join(ROOT, ALLOW_FILE))
      ? []
      : parseAllow(readFileSync(path.join(ROOT, ALLOW_FILE), "utf8"));
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  let count = 0;
  for (const file of files) {
    const abs = path.join(ROOT, file);
    if (!existsSync(abs)) continue; // deleted in the working tree but still in the index
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    // The path itself is public too.
    for (const rule of lineHits(file, rules, BANNED_HASHES)) {
      if (allowed(allow, file, rule)) continue;
      console.log(`${file}:0 ${rule}`);
      count++;
    }
    for (const hit of scanText(buf.toString("utf8"), rules, BANNED_HASHES)) {
      if (allowed(allow, file, hit.rule)) continue;
      console.log(`${file}:${hit.line} ${hit.rule}`);
      count++;
    }
  }
  if (count > 0) {
    console.error(`check-public: ${count} hit(s) in ${files.length} tracked files${strict ? " (strict)" : ""}.`);
    console.error(`Fix each one, or add a path-glob<TAB>rule<TAB>reason line to ${ALLOW_FILE} if it is a known fake.`);
    return 1;
  }
  console.error(`check-public: ${files.length} tracked files clean${strict ? " (strict)" : ""}.`);
  return 0;
}

/**
 * Every commit on every ref, as a patch: a name, path or id that a later commit removed is still public once the
 * history is. Prints `<short sha>:<path> <rule>` per distinct hit, never the text.
 */
async function scanHistory({ strict }) {
  const rules = [...REGEX_RULES, ...loadDenylist()];
  const allow =
    strict || !existsSync(path.join(ROOT, ALLOW_FILE))
      ? []
      : parseAllow(readFileSync(path.join(ROOT, ALLOW_FILE), "utf8"));
  const git = spawn(
    "git",
    ["log", "--all", "-p", "--no-color", "--no-ext-diff", "--format=commit %H%n%B%n--end-of-message--"],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const seen = new Set();
  let commits = 0;
  let commit = "";
  let file = "";
  let inMessage = false;
  const report = (where, rule) => {
    if (allowed(allow, where, rule)) return;
    const key = `${commit.slice(0, 10)}:${where} ${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    console.log(key);
  };
  const lines = createInterface({ input: git.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.startsWith("commit ") && /^commit [0-9a-f]{40}$/.test(line)) {
      commit = line.slice(7);
      commits++;
      inMessage = true;
      continue;
    }
    if (inMessage) {
      // The commit message is public too.
      if (line === "--end-of-message--") inMessage = false;
      else for (const rule of lineHits(line, rules, BANNED_HASHES)) report("(commit message)", rule);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      file = line.replace(/^diff --git a\/.* b\//, "");
      for (const rule of lineHits(file, rules, BANNED_HASHES)) report(file, rule);
      if (PRIVATE_FILES.has(path.basename(file))) report(file, "private-file");
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      for (const rule of lineHits(line.slice(1), rules, BANNED_HASHES)) report(file, rule);
    } else if (line.startsWith("rename ") || line.startsWith("copy ")) {
      for (const rule of lineHits(line, rules, BANNED_HASHES)) report(file, rule);
    }
  }
  const code = await new Promise((resolve) => git.on("close", resolve));
  if (code !== 0) die(`check-public: git log exited with ${code}.`);
  if (seen.size > 0) {
    console.error(`check-public: ${seen.size} hit(s) across ${commits} commits${strict ? " (strict)" : ""}.`);
    console.error(
      "Removing them from the tree does not remove them from history: publish from a fresh history (see docs/RELEASE-CHECKLIST.md).",
    );
    return 1;
  }
  console.error(`check-public: ${commits} commits clean${strict ? " (strict)" : ""}.`);
  return 0;
}

function selfTest() {
  // Samples are assembled from pieces so this file never matches its own rules.
  const tok = (prefix, body) => prefix + body;
  const hex = "0123456789abcdef";
  const testHashes = new Set([sha256("zorblax"), sha256("quux frob")]);
  /** @type {[string, string | null][]} sample text and the rule it must fire, or null for none */
  const cases = [
    [`cd ${"/Us"}ers/alice/project`, "personal-path"],
    [`cp x ${"/ho"}me/bob/.config/`, "personal-path"],
    [`workdir ${"/ho"}me/agent/repo`, null],
    ["config at /selfbuilding/home/.codex/auth.json", null],
    [`"${"/Us"}ers/carol/x"`, "personal-path"],
    ["GET /users/{id}/repos", null],
    ["the placeholder /Users/<name>/ in docs", null],
    [`open https://box.${"tail"}${hex.slice(0, 6)}.ts.net/`, "tailnet-host"],
    [`ssh build${".ts"}.net`, "tailnet-host"],
    [`host ${"tail"}9f3a21`, "tailnet-host"],
    ["const x = opts.network;", null],
    ["tailored output", null],
    [tok("xoxb", `-${"1234567890"}-abcdefghij`), "slack-token"],
    [tok("xoxb", "-test-1234567890abc"), null],
    [tok("xoxp", "-short"), null],
    [tok("sk-ant", `-api03-${"A".repeat(24)}`), "anthropic-key"],
    [tok("sk-ant", `-oat01-fake${"x".repeat(24)}`), null],
    [tok("sk-ant", `-${"Example".repeat(4)}`), null],
    [tok("imp", `_${"a1B2".repeat(5)}`), "impello-key"],
    [tok("imp", "_testtesttesttesttest"), null],
    [tok("imp", "_short"), null],
    ["simp_abcdefghijklmnopqrstu", null],
    [tok("e2b", `_${"Zz9".repeat(6)}`), "e2b-key"],
    [tok("e2b", "_fakefakefakefakefake"), null],
    [`user ${"U0"}ABCDEFGH1`, "slack-id"],
    [`channel ${"C0"}12345678`, "slack-id"],
    [`lower ${"u0"}abcdefgh1`, null],
    [`too long ${"U0"}ABCDEFGHIJKLM`, null],
    ["mentions Zorblax here", "banned-name"],
    ["see zorblaxClient and quux-frob", "banned-name"],
    ["QuuxFrob", "banned-name"],
    ["quux and frob apart", null],
    ["zorblaxed is a different word", null],
  ];
  let failed = 0;
  for (const [i, [text, expected]] of cases.entries()) {
    const got = lineHits(text, REGEX_RULES, testHashes);
    const ok = expected === null ? got.length === 0 : got.includes(expected) && got.length === 1;
    if (!ok) {
      failed++;
      console.error(`self-test FAIL: expected ${expected ?? "no hit"}, got [${got.join(", ")}] for case ${i}`);
      console.error(`  sample: ${JSON.stringify(text)}`);
    }
  }
  // The allow file grammar and globbing.
  const allow = parseAllow(
    "packages/*/test/**\tslack-token\tfake fixture\n# comment\n.infisical.json\t*\tworkspace id\na.md\tdenylist:*\tlocal\n",
  );
  const allowCases = [
    [allowed(allow, "packages/core/test/a/b.ts", "slack-token"), true],
    [allowed(allow, "packages/core/test/b.ts", "anthropic-key"), false],
    [allowed(allow, "packages/core/src/b.ts", "slack-token"), false],
    [allowed(allow, ".infisical.json", "slack-id"), true],
    [allowed(allow, "x/.infisical.json", "slack-id"), false],
    [allowed(allow, "a.md", "denylist:3"), true],
    [allowed(allow, "a.md", "slack-id"), false],
  ];
  allowCases.forEach(([got, want], i) => {
    if (got !== want) {
      failed++;
      console.error(`self-test FAIL: allow case ${i} expected ${want}`);
    }
  });
  if (isBinary(Buffer.from("ab\0cd")) !== true || isBinary(Buffer.from("plain")) !== false) {
    failed++;
    console.error("self-test FAIL: binary detection");
  }
  if (BANNED_HASHES.size === 0 || [...BANNED_HASHES].some((h) => !/^[0-9a-f]{64}$/.test(h))) {
    failed++;
    console.error("self-test FAIL: the banned hash list is malformed");
  }
  const total = cases.length + allowCases.length + 2;
  if (failed) {
    console.error(`check-public self-test: ${failed} of ${total} checks failed.`);
    return 1;
  }
  console.error(`check-public self-test: ${total} checks passed.`);
  return 0;
}

const args = new Set(process.argv.slice(2));
for (const a of args) {
  if (a !== "--strict" && a !== "--self-test" && a !== "--history") {
    console.error(`check-public: unknown flag ${a}. Use --strict, --history or --self-test.`);
    process.exit(2);
  }
}
const strict = args.has("--strict");
process.exit(
  args.has("--self-test") ? selfTest() : args.has("--history") ? await scanHistory({ strict }) : scanTree({ strict }),
);
