import {
  ConfigError,
  type HarnessCredential,
  type HarnessFailure,
  type McpServerSpec,
  MissingCredentialError,
  type ProviderSandbox,
  SANDBOX_PATHS,
} from "@selfbuilding/core";
import {
  canonicalPaths,
  openTestBox,
  runHarnessTurn,
  scripted,
  scriptedHarness,
  tmpdirProvider,
} from "@selfbuilding/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_TESTED_VERSION,
  claudeCode,
  claudeCodeImageInstallCommand,
  claudeCredentialPool,
  claudeSessionId,
  encodeProjectDir,
  isAccountFailure,
  renderMcpConfig,
  resolveClaudeCodeVersion,
  uuidv5,
} from "./index.js";

const paths = canonicalPaths();
const call = { runId: "run-1", callPath: "root/1/build", attempt: 1 };
const promptFile = `${paths.in}/prompt.md`;
const SELFBUILDING_MCP: McpServerSpec = {
  name: "selfbuilding",
  type: "stdio",
  command: "/usr/bin/node",
  args: [SANDBOX_PATHS.mcpBundle],
};

const failure = (code: HarnessFailure["code"]): HarnessFailure => ({
  code,
  retryable: code === "rate_limit" || code === "provider",
  message: code,
});

describe("claudeCode(): identity and capabilities", () => {
  it("is a stable harness that pins a tested version", () => {
    const harness = claudeCode({ model: "claude-x", effort: "high" });
    expect(harness.id).toBe("claude-code");
    expect(harness.stability).toBe("stable");
    expect(harness.testedVersion).toBe(CLAUDE_CODE_TESTED_VERSION);
    expect(harness.options).toEqual({ model: "claude-x", effort: "high", version: "tested" });
    expect(harness.capabilities).toEqual(CLAUDE_CODE_CAPABILITIES);
    expect(harness.capabilities).toMatchObject({
      promptVia: "stdin",
      preassignSessionId: true,
      stopAfterSubmit: "hook",
      nativeBudgetCap: true,
      subscriptionAuth: true,
      skillDirs: [".claude/skills"],
      streamFormat: "claude-code",
    });
    expect(typeof harness.resume).toBe("function");
    expect(typeof harness.fork).toBe("function");
    expect(typeof harness.sessionArtifacts).toBe("function");
    expect(harness.toolName("selfbuilding", "submit_result")).toBe("mcp__selfbuilding__submit_result");
  });

  it("refuses a binary that would need a PATH lookup", () => {
    expect(() => claudeCode({ binary: "claude" })).toThrow(ConfigError);
  });
});

describe("claudeCode(): invocation (spec §4.4)", () => {
  const harness = claudeCode({ model: "claude-x" });

  it("builds the headless stream-json argv with the prompt on stdin, never in argv", () => {
    const inv = harness.invoke({
      ...call,
      paths,
      promptFile,
      systemFile: `${paths.in}/system.md`,
      effort: "max",
      budgetUsd: 2.5,
      mcpToolTimeoutMs: 720_000,
    });
    const sessionId = claudeSessionId(call);
    expect(inv.argv).toEqual([
      "/usr/local/bin/claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-x",
      "--effort",
      "max",
      "--max-budget-usd",
      "2.5",
      "--session-id",
      sessionId,
      "--mcp-config",
      "/selfbuilding/home/mcp.json",
      "--strict-mcp-config",
      "--settings",
      "/selfbuilding/home/settings.json",
      "--append-system-prompt-file",
      "/selfbuilding/in/system.md",
      "--dangerously-skip-permissions",
    ]);
    expect(inv.stdinFile).toBe(promptFile);
    expect(inv.cwd).toBe(SANDBOX_PATHS.workdir);
    expect(inv.sessionId).toBe(sessionId);
    expect(inv.argv.some((arg) => arg.startsWith("-c") || arg === "--continue" || arg === "--bare")).toBe(false);
  });

  it("isolates config and sets every required env var, with no credentials", () => {
    const inv = harness.invoke({ ...call, paths, promptFile, mcpToolTimeoutMs: 720_000 });
    expect(inv.env).toEqual({
      HOME: "/selfbuilding/home",
      PWD: "/selfbuilding/work",
      CLAUDE_CONFIG_DIR: "/selfbuilding/home/.claude",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
      MCP_TOOL_TIMEOUT: "720000",
      IS_SANDBOX: "1",
    });
  });

  it("always sets MCP_TOOL_TIMEOUT, defaulting to the default hot wait + 2 min", () => {
    expect(harness.invoke({ ...call, paths, promptFile }).env.MCP_TOOL_TIMEOUT).toBe(String(12 * 60_000));
  });

  it("uses a preassigned session id when given, and rejects a non-UUID one", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(harness.invoke({ ...call, paths, promptFile, sessionId: id }).argv).toContain(id);
    expect(() => harness.invoke({ ...call, paths, promptFile, sessionId: "nope" })).toThrow(ConfigError);
  });

  it("omits --model and --effort when neither the value nor the call sets them", () => {
    const inv = claudeCode().invoke({ ...call, paths, promptFile });
    expect(inv.argv).not.toContain("--model");
    expect(inv.argv).not.toContain("--effort");
    expect(inv.argv).not.toContain("--append-system-prompt-file");
  });

  it("rejects a non-positive budget", () => {
    expect(() => harness.invoke({ ...call, paths, promptFile, budgetUsd: 0 })).toThrow(ConfigError);
  });

  it("resumes by explicit id and accepts the runtime's placeholders", () => {
    const resumed = harness.resume?.({ ...call, paths, promptFile: "{promptFile}", sessionId: "{sessionId}" });
    expect(resumed?.argv.slice(7, 9)).toEqual(["--resume", "{sessionId}"]);
    expect(resumed?.argv).not.toContain("--session-id");
    expect(resumed?.stdinFile).toBe("{promptFile}");
    expect(resumed?.sessionId).toBe("{sessionId}");
  });

  it("forks into a new session id the parser discovers", () => {
    const forked = harness.fork?.({ ...call, paths, promptFile, sessionId: claudeSessionId(call) });
    expect(forked?.argv).toEqual(expect.arrayContaining(["--resume", claudeSessionId(call), "--fork-session"]));
    expect(forked?.sessionId).toBeUndefined();
  });
});

describe("claudeCode(): session ids and transfer (spec §4.7)", () => {
  it("derives a stable RFC 4122 v5 id per (runId, callPath, attempt)", () => {
    const id = claudeSessionId(call);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claudeSessionId(call)).toBe(id);
    expect(claudeSessionId({ ...call, attempt: 2 })).not.toBe(id);
    expect(claudeSessionId({ runId: "run-1r", callPath: "oot/1/build", attempt: 1 })).not.toBe(id);
    // The RFC 4122 appendix vector for the DNS namespace.
    expect(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("captures and restores the transcript at the same path on every box", () => {
    const id = claudeSessionId(call);
    const transfer = claudeCode().sessionArtifacts?.(id, paths);
    expect(encodeProjectDir(SANDBOX_PATHS.workdir)).toBe("-selfbuilding-work");
    expect(transfer?.files).toEqual([
      `.claude/projects/-selfbuilding-work/${id}.jsonl`,
      `.claude/projects/-selfbuilding-work/${id}`,
    ]);
    const [capture] = transfer?.capture ?? [];
    expect(capture?.argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(capture?.argv.slice(3)).toEqual([
      "capture-session",
      "/selfbuilding/home",
      `/selfbuilding/state/sessions/claude-code/${id}`,
      ...(transfer?.files ?? []),
    ]);
    expect(capture?.argv[2]).not.toContain(id);
    expect(() => claudeCode().sessionArtifacts?.("../../etc", paths)).toThrow(ConfigError);
  });

  it("round-trips a session between two boxes with the capture and restore commands", async () => {
    const provider = tmpdirProvider();
    try {
      const id = claudeSessionId(call);
      const transfer = claudeCode().sessionArtifacts?.(id, paths);
      if (!transfer) throw new Error("no transfer");
      const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;
      const run = (box: ProviderSandbox, argv: string[]) => box.exec(argv.map(quote).join(" "));
      const from = await openTestBox(provider, "from");
      const transcript = `${SANDBOX_PATHS.home}/${transfer.files[0]}`;
      await from.writeFiles([
        { path: transcript, data: '{"type":"user"}\n' },
        { path: `${SANDBOX_PATHS.home}/${transfer.files[1]}/subagents/a.jsonl`, data: "{}\n" },
      ]);
      for (const cmd of transfer.capture) expect((await run(from, cmd.argv)).exitCode).toBe(0);
      // Moving {state} between boxes is the host's job; copy it as the artifact store would.
      const staged = `${SANDBOX_PATHS.state}/sessions/claude-code/${id}`;
      const to = await openTestBox(provider, "to");
      await to.writeFiles([
        { path: `${staged}/${transfer.files[0]}`, data: await from.readFile(`${staged}/${transfer.files[0]}`) },
        {
          path: `${staged}/${transfer.files[1]}/subagents/a.jsonl`,
          data: await from.readFile(`${staged}/${transfer.files[1]}/subagents/a.jsonl`),
        },
      ]);
      for (const cmd of transfer.restore) expect((await run(to, cmd.argv)).exitCode).toBe(0);
      expect(new TextDecoder().decode(await to.readFile(transcript))).toBe('{"type":"user"}\n');
    } finally {
      await provider.close();
    }
  });
});

describe("claudeCode(): prepare (spec §4.5, §4.6, §4.8, §6.11)", () => {
  const plan = claudeCode().prepare({
    ...call,
    paths,
    skills: ["implement-spec", "code-review"],
    mcpServers: [
      { name: "docs", type: "http", url: "https://docs.example/mcp", headers: { authorization: "Bearer x" } },
      SELFBUILDING_MCP,
      { name: "selfbuilding", type: "stdio", command: "/tmp/evil" },
    ],
    hotWaitMs: 10 * 60_000,
  });
  const file = (suffix: string) => plan.files.find((f) => f.path.endsWith(suffix));

  it("sets the MCP tool timeout to hot wait + 2 min", () => {
    expect(plan.mcpToolTimeoutMs).toBe(12 * 60_000);
    expect(JSON.parse(file("settings.json")?.content ?? "{}").env).toEqual({ MCP_TOOL_TIMEOUT: "720000" });
  });

  it("puts selfbuilding first, always loaded, and impossible to shadow; the file is private", () => {
    const mcp = file("mcp.json");
    expect(mcp?.mode).toBe(0o600);
    const config = JSON.parse(mcp?.content ?? "{}");
    expect(Object.keys(config.mcpServers)).toEqual(["selfbuilding", "docs"]);
    expect(config.mcpServers.selfbuilding).toEqual({
      type: "stdio",
      command: "/usr/bin/node",
      args: ["/selfbuilding/bin/selfbuilding-mcp.mjs"],
      env: {},
      alwaysLoad: true,
    });
    expect(config.mcpServers.docs).toEqual({
      type: "http",
      url: "https://docs.example/mcp",
      headers: { authorization: "Bearer x" },
    });
    expect(() => renderMcpConfig([{ name: "bad name", type: "stdio", command: "/x" }])).toThrow(ConfigError);
  });

  it("writes settings that drop vendor attribution and stop the run after an accepted submit", () => {
    const settings = JSON.parse(file("settings.json")?.content ?? "{}");
    expect(settings.attribution).toEqual({ commit: "", pr: "" });
    expect(settings.includeCoAuthoredBy).toBe(false);
    expect(settings.hooks.PostToolUse).toEqual([
      {
        matcher: "mcp__selfbuilding__submit_result",
        hooks: [{ type: "command", command: "/bin/sh /selfbuilding/home/.selfbuilding/stop-after-submit.sh" }],
      },
    ]);
    expect(file("stop-after-submit.sh")?.mode).toBe(0o755);
  });

  it("links each skill into .claude/skills and excludes the links from git", () => {
    expect(plan.symlinks).toEqual([
      { path: "/selfbuilding/work/.claude/skills/implement-spec", target: "/selfbuilding/skills/implement-spec" },
      { path: "/selfbuilding/work/.claude/skills/code-review", target: "/selfbuilding/skills/code-review" },
    ]);
    expect(plan.gitExcludes).toEqual(["/.claude/skills/implement-spec", "/.claude/skills/code-review"]);
    expect(() => claudeCode().prepare({ ...call, paths, skills: ["../x"], mcpServers: [], hotWaitMs: 0 })).toThrow(
      ConfigError,
    );
  });

  it("the stop hook prints the stop decision only for a successful call", async () => {
    const provider = tmpdirProvider();
    try {
      const box = await openTestBox(provider);
      const hook = file("stop-after-submit.sh");
      await box.writeFiles([{ path: hook?.path ?? "", data: hook?.content ?? "", mode: 0o755 }]);
      const ok = await box.exec(
        `echo '{"tool_name":"mcp__selfbuilding__submit_result","tool_response":[{"type":"text","text":"Accepted."}]}' | /bin/sh ${hook?.path}`,
      );
      expect(JSON.parse(ok.stdoutTail)).toEqual({ continue: false, stopReason: "result submitted" });
      const rejected = await box.exec(`echo '{"tool_response":{"isError":true}}' | /bin/sh ${hook?.path}`);
      expect(rejected).toMatchObject({ exitCode: 0, stdoutTail: "" });
    } finally {
      await provider.close();
    }
  });
});

describe("claudeCode(): auth (spec §4.9, §9.2)", () => {
  const harness = claudeCode();

  it("delivers a subscription token as a 0600 file read into the child env, and strips API-key variables", () => {
    const plan = harness.auth({ kind: "oauth-token", value: "sk-ant-oat01-fake" }, { paths, values: {} });
    expect(plan).toEqual({
      env: {},
      files: [
        {
          path: "/run/selfbuilding/secrets/CLAUDE_CODE_OAUTH_TOKEN",
          content: "sk-ant-oat01-fake",
          mode: 0o600,
          secret: true,
        },
      ],
      stripEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
      secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: "/run/selfbuilding/secrets/CLAUDE_CODE_OAUTH_TOKEN" },
    });
  });

  it("delivers an API key the same way and strips the OAuth variable", () => {
    const resolver = async () => "never-called";
    const plan = harness.auth(
      { kind: "api-key", value: resolver },
      { paths, values: { ANTHROPIC_API_KEY: "sk-ant-api03-fake" } },
    );
    expect(plan.files).toEqual([
      { path: "/run/selfbuilding/secrets/ANTHROPIC_API_KEY", content: "sk-ant-api03-fake", mode: 0o600, secret: true },
    ]);
    expect(plan.stripEnv).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]);
    expect(plan.secretEnv).toEqual({ ANTHROPIC_API_KEY: "/run/selfbuilding/secrets/ANTHROPIC_API_KEY" });
    expect(JSON.stringify(plan.env)).not.toContain("sk-ant");
  });

  it("accepts a resolver credential in the shape core resolves it to", () => {
    const resolver = async () => "never-called";
    const plan = harness.auth(
      { kind: "oauth-token", value: resolver },
      { paths, values: { value: "sk-ant-oat01-fake", OAUTH_TOKEN: "sk-ant-oat01-fake" } },
    );
    expect(plan.files[0]?.content).toBe("sk-ant-oat01-fake");
  });

  it("fails at plan time on a missing, unsupported or swapped credential, without echoing it", () => {
    expect(() => harness.auth({ kind: "api-key", value: async () => "x" }, { paths, values: {} })).toThrow(
      MissingCredentialError,
    );
    expect(() => harness.auth({ kind: "auth-file", value: "{}", leased: true }, { paths, values: {} })).toThrow(
      /oauth-token/,
    );
    const swapped = () =>
      harness.auth({ kind: "oauth-token", value: "sk-ant-api03-secretvalue" }, { paths, values: {} });
    expect(swapped).toThrow(ConfigError);
    expect(swapped).not.toThrow(/secretvalue/);
  });
});

describe("credential pool: subscription first, API key fallback (spec §4.9)", () => {
  const oauth: HarnessCredential = { kind: "oauth-token", value: "sk-ant-oat01-a" };
  const key: HarnessCredential = { kind: "api-key", value: "sk-ant-api03-b" };
  const key2: HarnessCredential = { kind: "api-key", value: "sk-ant-api03-c" };

  it("orders subscriptions before API keys, keeping each group's order", () => {
    const pool = claudeCredentialPool([key, oauth, key2]);
    expect(pool.credentials).toEqual([oauth, key, key2]);
    expect(pool.first()).toBe(oauth);
    expect(claudeCredentialPool(key).credentials).toEqual([key]);
  });

  it("falls back from a rate-limited or refused subscription to the API key", () => {
    const pool = claudeCredentialPool([oauth, key]);
    for (const code of ["rate_limit", "quota", "auth"] as const) {
      expect(pool.next(0, failure(code))).toEqual({ action: "switch", from: 0, index: 1, credential: key });
    }
  });

  it("stays on the credential for errors that are not account failures", () => {
    const pool = claudeCredentialPool([oauth, key]);
    for (const code of ["provider", "unknown", "invalid_request", "context_overflow", "harness_crash"] as const) {
      expect(pool.next(0, failure(code))).toEqual({ action: "stay", index: 0 });
    }
    // An API key's 429 is a transient rate limit; the harness and the retry rules handle it.
    expect(pool.next(1, failure("rate_limit"))).toEqual({ action: "stay", index: 1 });
  });

  it("moves through API keys on auth or quota and reports exhaustion", () => {
    const pool = claudeCredentialPool([oauth, key, key2]);
    expect(pool.next(1, failure("quota"))).toMatchObject({ action: "switch", index: 2, credential: key2 });
    expect(pool.next(2, failure("auth"))).toEqual({ action: "exhausted", index: 2, failure: failure("auth") });
  });

  it("matches account failures as classified from real vendor text, on both sides", () => {
    const harness = claudeCode();
    const fromText = (text: string) => harness.classify({ kind: "event", event: { type: "result", result: text } });
    expect(isAccountFailure(oauth, fromText("You've hit your 5-hour limit · resets 3pm"))).toBe(true);
    expect(isAccountFailure(key, fromText("Invalid API key · Fix external API key"))).toBe(true);
    expect(isAccountFailure(key, fromText("OAuth token has expired"))).toBe(true);
    // Not account failures: a bare 403 from a tool, a permission error, an overloaded API.
    expect(isAccountFailure(oauth, fromText("Request failed with status 403"))).toBe(false);
    expect(isAccountFailure(oauth, fromText('{"type":"permission_error","message":"denied"}'))).toBe(false);
    expect(isAccountFailure(oauth, fromText("API Error: 529 overloaded_error"))).toBe(false);
  });

  it("rejects an empty pool and unsupported kinds", () => {
    expect(() => claudeCredentialPool([])).toThrow(MissingCredentialError);
    expect(() => claudeCredentialPool(undefined)).toThrow(MissingCredentialError);
    expect(() => claudeCredentialPool([{ kind: "provider-keys", values: {} }])).toThrow(ConfigError);
    expect(() => claudeCredentialPool([oauth]).at(3)).toThrow(ConfigError);
  });
});

describe("claudeCode(): classify (spec §4.12)", () => {
  const { classify } = claudeCode();
  const event = (e: unknown) => classify({ kind: "event", event: e });

  it.each([
    ["Credit balance is too low", "billing", false],
    ["Claude AI usage limit reached", "quota", false],
    ["Not logged in · Please run /login", "auth", false],
    [
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      "auth",
      false,
    ],
    ["This organization has been disabled.", "auth", false],
    ["Prompt is too long", "context_overflow", false],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', "rate_limit", true],
    ["API Error: 529 Overloaded", "provider", true],
    ["API Error: Connection error.", "provider", true],
    [
      'API Error: 400 {"error":{"type":"invalid_request_error","message":"model: invalid model"}}',
      "invalid_request",
      false,
    ],
    ["Something odd happened", "unknown", false],
  ])("classifies %j as %s", (text, code, retryable) => {
    expect(event({ type: "result", subtype: "success", is_error: true, result: text })).toMatchObject({
      code,
      retryable,
    });
  });

  it("reads api_retry categories, keeping a bare 403 off the account path", () => {
    expect(
      event({ type: "system", subtype: "api_retry", error: "rate_limit", error_status: 429, retry_delay_ms: 900 }),
    ).toEqual({
      code: "rate_limit",
      retryable: true,
      retryAfterMs: 900,
      message: "API retry: rate_limit (429)",
    });
    expect(
      event({ type: "system", subtype: "api_retry", error: "authentication_failed", error_status: 401 }).code,
    ).toBe("auth");
    expect(
      event({ type: "system", subtype: "api_retry", error: "authentication_failed", error_status: 403 }).code,
    ).toBe("unknown");
    expect(event({ type: "system", subtype: "api_retry", error: "overloaded", error_status: 529 }).code).toBe(
      "provider",
    );
  });

  it("reads a rejected rate_limit_event as quota", () => {
    expect(
      event({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000, rateLimitType: "five_hour" },
      }),
    ).toEqual({
      code: "quota",
      retryable: false,
      message: "Subscription usage limit reached (five_hour); resets at 2030-03-17T17:46:40.000Z",
    });
  });

  it("classifies exits: missing binary, SIGTERM, and auth text on stderr", () => {
    expect(classify({ kind: "exit", code: 127, signal: null, stderrTail: "" })).toMatchObject({
      code: "harness_crash",
      message: expect.stringMatching(/binary is missing/),
    });
    expect(classify({ kind: "exit", code: 143, signal: null, stderrTail: "" }).message).toMatch(/SIGTERM/);
    expect(classify({ kind: "exit", code: 1, signal: null, stderrTail: "Invalid API key" }).code).toBe("auth");
  });
});

describe("claudeCode(): versions (spec §4.11)", () => {
  const harness = claudeCode();

  it("installs one exact version with an empty npmrc, by absolute path", () => {
    const plan = harness.install("2.1.316");
    expect(plan.binary).toBe("/usr/local/bin/claude");
    expect(plan.commands[0]?.argv).toEqual([
      "/usr/bin/env",
      "npm",
      "install",
      "--global",
      "--prefix",
      "/usr/local",
      "--foreground-scripts",
      "@anthropic-ai/claude-code@2.1.316",
    ]);
    expect(plan.commands[0]?.env).toMatchObject({
      NPM_CONFIG_USERCONFIG: "/dev/null",
      NPM_CONFIG_IGNORE_SCRIPTS: "false",
    });
    expect(plan.commands.at(-1)?.argv).toEqual(["/usr/local/bin/claude", "--version"]);
    expect(harness.installHosts()).toEqual(["registry.npmjs.org"]);
    expect(() => harness.install("latest")).toThrow(ConfigError);
    expect(() => harness.install("1.0.0; rm -rf /")).toThrow(ConfigError);
  });

  it("gives images an install command for the pinned version", () => {
    expect(claudeCodeImageInstallCommand()).toContain(`@anthropic-ai/claude-code@${CLAUDE_CODE_TESTED_VERSION}`);
  });

  it("runs and parses `claude --version`", () => {
    expect(harness.versionCommand().argv).toEqual(["/usr/local/bin/claude", "--version"]);
    expect(harness.parseVersion("2.1.316 (Claude Code)\n")).toBe("2.1.316");
    expect(() => harness.parseVersion("command not found")).toThrow(ConfigError);
  });

  it("resolves the policy: session version, exact pin, hold, latest, tested", () => {
    expect(resolveClaudeCodeVersion()).toBe(CLAUDE_CODE_TESTED_VERSION);
    expect(resolveClaudeCodeVersion("tested", { hold: "2.1.300" })).toBe("2.1.300");
    expect(resolveClaudeCodeVersion("latest", { latest: "2.2.0" })).toBe("2.2.0");
    expect(resolveClaudeCodeVersion("latest", { latest: "2.2.0", hold: "2.1.300" })).toBe("2.1.300");
    expect(resolveClaudeCodeVersion("2.1.1", { hold: "2.1.300" })).toBe("2.1.1");
    expect(resolveClaudeCodeVersion("2.1.1", { sessionVersion: "2.0.9", hold: "2.1.300" })).toBe("2.0.9");
    expect(() => resolveClaudeCodeVersion("latest")).toThrow(ConfigError);
    expect(() => resolveClaudeCodeVersion("2.x")).toThrow(ConfigError);
  });
});

describe("claudeCode() parser through the scripted harness in a tmpdir box", () => {
  const provider = tmpdirProvider();
  let box: ProviderSandbox;
  const FAKE_MCP = `
import fs from "node:fs";
let buf = "";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
    if (msg.method !== "tools/call") continue;
    const ok = msg.params.arguments?.status === "done";
    send({ id: msg.id, result: ok ? { content: [{ type: "text", text: "Accepted. Stop now." }] } : { isError: true, content: [{ type: "text", text: "status: must be \\"done\\"" }] } });
  }
});
`;
  const mcp: McpServerSpec[] = [
    { name: "selfbuilding", type: "stdio", command: "node", args: [`${SANDBOX_PATHS.bin}/fake-mcp.mjs`] },
  ];

  beforeAll(async () => {
    box = await openTestBox(provider);
    await box.writeFiles([{ path: `${SANDBOX_PATHS.bin}/fake-mcp.mjs`, data: FAKE_MCP }]);
    await box.exec(`git init -q ${SANDBOX_PATHS.workdir}`);
  });
  afterAll(() => provider.close());

  it("normalises a scripted build turn: shell effect, rejected then accepted submit", async () => {
    const harness = scriptedHarness(
      [
        scripted.say("Implementing."),
        scripted.sh("echo 'export const y = 2;' > y.ts"),
        ...scripted.invalidThenValid({ status: "bogus" }, { status: "done" }),
      ],
      { parser: claudeCode().createParser, costUsdPerTurn: 0.02 },
    );
    const sessionId = claudeSessionId(call);
    const turn = await runHarnessTurn(box, harness, { mcpServers: mcp, ...call, sessionId });
    expect(turn.exitCode, turn.stderr).toBe(0);
    expect(turn.sessionId).toBe(sessionId);
    expect(turn.events.map((e) => e.type)).toEqual([
      "session.started",
      "message",
      "tool.started",
      "tool.completed",
      "tool.started",
      "tool.completed",
      "tool.started",
      "tool.completed",
      "usage",
      "turn.ended",
    ]);
    const tools = turn.events.filter((e) => e.type === "tool.started");
    expect(tools.map((e) => e.type === "tool.started" && e.effect)).toEqual(["effect", "read", "read"]);
    expect(turn.events.find((e) => e.type === "usage")).toMatchObject({ costUsd: 0.02, cumulative: true });
  });

  it("reports a scripted rate limit as a retryable error", async () => {
    const harness = scriptedHarness(
      [scripted.sh("true"), scripted.error("rate_limit", "API Error: 429 rate_limit_error")],
      {
        parser: claudeCode().createParser,
      },
    );
    const turn = await runHarnessTurn(box, harness, { mcpServers: mcp, ...call, callPath: "root/2/build" });
    expect(turn.events).toContainEqual({
      type: "error",
      failure: { code: "rate_limit", retryable: true, message: "API Error: 429 rate_limit_error" },
    });
    expect(turn.events.at(-1)).toEqual({ type: "turn.ended", reason: "error" });
  });

  it("ends a crashed turn from the exit alone", async () => {
    const harness = scriptedHarness([scripted.sh("true"), scripted.crash("SIGKILL")], {
      parser: claudeCode().createParser,
    });
    const turn = await runHarnessTurn(box, harness, { mcpServers: mcp, ...call, callPath: "root/3/build" });
    expect(turn.events.at(-2)).toMatchObject({ type: "error", failure: { code: "harness_crash" } });
    expect(turn.events.at(-1)).toEqual({ type: "turn.ended", reason: "error" });
  });
});
