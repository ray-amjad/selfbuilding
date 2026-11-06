import { ConfigError, type InvokeContext, type McpServerSpec } from "@selfbuilding/core";
import { canonicalPaths } from "@selfbuilding/testing";
import { describe, expect, it } from "vitest";
import { CODEX_CAPABILITIES, codex } from "./index.js";
import { PREPEND_SYSTEM_SCRIPT } from "./invocation.js";

const paths = canonicalPaths();
const call = { runId: "run-1", callPath: "root/2/review", attempt: 1 };
const ctx: InvokeContext = { ...call, paths, promptFile: `${paths.in}/prompt.md` };
const SB: McpServerSpec = { name: "selfbuilding", type: "stdio", command: "/selfbuilding/bin/selfbuilding-mcp" };

const BASE_OPTIONS = [
  "--json",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "-c",
  'sandbox_mode="danger-full-access"',
  "-c",
  'approval_policy="never"',
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  "check_for_update_on_startup=false",
];

const SB_MCP = (timeoutSec: number) => [
  "-c",
  'mcp_servers.selfbuilding.command="/selfbuilding/bin/selfbuilding-mcp"',
  "-c",
  'mcp_servers.selfbuilding.default_tools_approval_mode="approve"',
  "-c",
  `mcp_servers.selfbuilding.tool_timeout_sec=${timeoutSec}`,
];

describe("codex(): the harness value", () => {
  it("is a stable adapter with the Codex capabilities and its options", () => {
    const harness = codex({ model: "gpt-fake", effort: "high" });
    expect(harness.id).toBe("codex");
    expect(harness.stability).toBe("stable");
    expect(harness.capabilities).toBe(CODEX_CAPABILITIES);
    expect(harness.capabilities).toMatchObject({
      promptVia: "stdin",
      preassignSessionId: false,
      stopAfterSubmit: "kill",
      usage: "tokens",
      skillDirs: [".agents/skills"],
      subscriptionAuth: true,
      streamFormat: "codex",
    });
    expect(harness.options).toEqual({ model: "gpt-fake", effort: "high", version: "tested" });
    expect(harness.resume).toBeTypeOf("function");
    expect(harness.fork).toBeTypeOf("function");
    expect(harness.sessionArtifacts).toBeTypeOf("function");
    expect(harness.toolName("selfbuilding", "submit_result")).toBe("mcp__selfbuilding__submit_result");
    expect(harness.versionCommand()).toMatchObject({ argv: ["/usr/local/bin/codex", "--version"] });
    expect(harness.parseVersion("codex-cli 0.164.0")).toBe("0.164.0");
  });

  it("is plain JSON: a plan crosses a durable step boundary unchanged", () => {
    const harness = codex({ model: "m" });
    const inv = harness.invoke({ ...ctx, mcpServers: [SB], hotWaitMs: 60_000 });
    expect(JSON.parse(JSON.stringify(inv))).toEqual(inv);
    const plan = harness.prepare({ ...call, paths, skills: ["review"], mcpServers: [SB], hotWaitMs: 0 });
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });
});

describe("invoke(): a fresh session", () => {
  it("runs `codex exec [options] -` with the prompt on stdin, isolated HOME and CODEX_HOME", () => {
    const inv = codex().invoke({ ...ctx, mcpServers: [SB], hotWaitMs: 10 * 60_000 });
    expect(inv).toEqual({
      argv: ["/usr/local/bin/codex", "exec", ...BASE_OPTIONS, ...SB_MCP(720), "-"],
      env: { HOME: "/selfbuilding/home", CODEX_HOME: "/selfbuilding/home/.codex", PWD: "/selfbuilding/work" },
      cwd: "/selfbuilding/work",
      stdinFile: "/selfbuilding/in/prompt.md",
    });
    expect(inv.sessionId).toBeUndefined();
  });

  it("passes the model and maps effort onto model_reasoning_effort; call options win over harness options", () => {
    const harness = codex({ model: "from-harness", effort: "low" });
    expect(harness.invoke(ctx).argv.slice(5, 9)).toEqual(["-m", "from-harness", "-c", 'model_reasoning_effort="low"']);
    const argv = harness.invoke({ ...ctx, model: "from-call", effort: "max" }).argv;
    expect(argv.slice(5, 9)).toEqual(["-m", "from-call", "-c", 'model_reasoning_effort="xhigh"']);
    expect(codex().invoke(ctx).argv.join(" ")).not.toMatch(/ -m |model_reasoning_effort/);
  });

  it("prepends the system file to the prompt through a fixed script, with every path as an argument", () => {
    const inv = codex().invoke({ ...ctx, systemFile: `${paths.in}/system.md` });
    expect(inv.argv.slice(0, 6)).toEqual([
      "/bin/sh",
      "-c",
      PREPEND_SYSTEM_SCRIPT,
      "codex-prompt",
      "/selfbuilding/in/system.md",
      "/usr/local/bin/codex",
    ]);
    expect(inv.argv.at(-1)).toBe("-");
    expect(inv.stdinFile).toBe("/selfbuilding/in/prompt.md");
    expect(PREPEND_SYSTEM_SCRIPT).not.toContain("/selfbuilding");
  });

  it("never puts the prompt in argv and never uses a continue-last flag", () => {
    for (const inv of [
      codex().invoke(ctx),
      codex().resume?.({ ...ctx, sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53" }),
    ]) {
      expect(inv?.argv).not.toContain("--last");
      expect(inv?.argv).not.toContain("--continue");
      expect(inv?.argv.some((a) => a.includes("prompt.md"))).toBe(false);
    }
  });

  it("uses an absolute binary path", () => {
    expect(codex({ binary: "/opt/codex/bin/codex" }).invoke(ctx).argv[0]).toBe("/opt/codex/bin/codex");
    expect(() => codex({ binary: "codex" }).invoke(ctx)).toThrow(ConfigError);
  });
});

describe("resume() and fork(): the subcommand comes straight after exec", () => {
  const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";

  it("resume: `codex exec resume <id> [options] -`, with no -s flag (exec resume rejects it)", () => {
    const inv = codex({ model: "m" }).resume?.({ ...ctx, sessionId: id, systemFile: `${paths.in}/system.md` });
    expect(inv?.argv.slice(0, 4)).toEqual(["/usr/local/bin/codex", "exec", "resume", id]);
    expect(inv?.argv.slice(4, 7)).toEqual(["--json", "--skip-git-repo-check", "--ignore-user-config"]);
    expect(inv?.argv).not.toContain("-s");
    expect(inv?.argv).toContain('sandbox_mode="danger-full-access"');
    expect(inv?.argv.at(-1)).toBe("-");
    // The session already holds the system text; a follow-up turn sends only the new message.
    expect(inv?.argv[0]).toBe("/usr/local/bin/codex");
    expect(inv?.stdinFile).toBe(ctx.promptFile);
  });

  it("keeps the host's {sessionId} template placeholder intact", () => {
    const inv = codex().resume?.({ ...ctx, sessionId: "{sessionId}", promptFile: "{promptFile}" });
    expect(inv?.argv.slice(2, 4)).toEqual(["resume", "{sessionId}"]);
    expect(inv?.stdinFile).toBe("{promptFile}");
  });

  it("fork: `codex exec fork <id> [options] -`", () => {
    expect(
      codex()
        .fork?.({ ...ctx, sessionId: id })
        .argv.slice(1, 4),
    ).toEqual(["exec", "fork", id]);
  });

  it("refuses an id that could be read as an option or a path", () => {
    for (const bad of ["--last", "-c", "../x", "a b", ""]) {
      expect(() => codex().resume?.({ ...ctx, sessionId: bad })).toThrow(ConfigError);
    }
  });
});

describe("MCP configuration as -c overrides (spec §4.8)", () => {
  it("falls back to the selfbuilding server alone with the default hot wait", () => {
    const argv = codex().invoke(ctx).argv;
    expect(argv).toContain('mcp_servers.selfbuilding.command="node"');
    expect(argv).toContain('mcp_servers.selfbuilding.args=["/selfbuilding/bin/selfbuilding-mcp.mjs"]');
    expect(argv).toContain("mcp_servers.selfbuilding.tool_timeout_sec=720");
  });

  it("sets the tool timeout to hot wait + 2 min, rounded up to whole seconds, and reports it from prepare()", () => {
    const argv = codex().invoke({ ...ctx, mcpServers: [SB], hotWaitMs: 30_500 }).argv;
    expect(argv).toContain("mcp_servers.selfbuilding.tool_timeout_sec=151");
    const plan = codex().prepare({ ...call, paths, skills: [], mcpServers: [SB], hotWaitMs: 30_500 });
    expect(plan.mcpToolTimeoutMs).toBe(151_000);
  });

  it("puts selfbuilding first, pre-approves every server, and renders args as TOML", () => {
    const servers: McpServerSpec[] = [
      { name: "docs", type: "stdio", command: "/usr/bin/docs-mcp", args: ["--root", 'a "quoted" dir'] },
      SB,
      { name: "web", type: "http", url: "https://mcp.example.test/mcp" },
    ];
    const argv = codex().invoke({ ...ctx, mcpServers: servers, hotWaitMs: 0 }).argv;
    const overrides = argv.filter((a) => a.startsWith("mcp_servers."));
    expect(overrides).toEqual([
      'mcp_servers.selfbuilding.command="/selfbuilding/bin/selfbuilding-mcp"',
      'mcp_servers.selfbuilding.default_tools_approval_mode="approve"',
      "mcp_servers.selfbuilding.tool_timeout_sec=120",
      'mcp_servers.docs.command="/usr/bin/docs-mcp"',
      'mcp_servers.docs.args=["--root", "a \\"quoted\\" dir"]',
      'mcp_servers.docs.default_tools_approval_mode="approve"',
      'mcp_servers.web.url="https://mcp.example.test/mcp"',
      'mcp_servers.web.default_tools_approval_mode="approve"',
    ]);
  });

  it("keeps stdio env secrets out of argv: a 0600 env file sourced by a fixed wrapper", () => {
    const servers: McpServerSpec[] = [
      SB,
      { name: "db", type: "stdio", command: "/usr/bin/db-mcp", env: { DB_TOKEN: "tok'en" } },
    ];
    const argv = codex().invoke({ ...ctx, mcpServers: servers }).argv;
    expect(argv.join(" ")).not.toContain("tok'en");
    expect(argv).toContain('mcp_servers.db.command="/bin/sh"');
    const args = argv.find((a) => a.startsWith("mcp_servers.db.args="));
    expect(args).toContain('"/selfbuilding/home/.codex/selfbuilding-mcp-env/db.env", "/usr/bin/db-mcp"');
    const plan = codex().prepare({ ...call, paths, skills: [], mcpServers: servers, hotWaitMs: 0 });
    expect(plan.files).toContainEqual({
      path: "/selfbuilding/home/.codex/selfbuilding-mcp-env/db.env",
      content: "DB_TOKEN='tok'\\''en'\n",
      mode: 0o600,
      secret: true,
      // The agent runs Codex, whose wrapper sources this file; a root-owned file kept the server from starting.
      owner: "agent",
    });
  });

  it("rejects HTTP headers, duplicate or unsafe names, and bad env names", () => {
    const invoke = (mcpServers: McpServerSpec[]) => () => codex().invoke({ ...ctx, mcpServers });
    expect(
      invoke([{ name: "h", type: "http", url: "https://x.test", headers: { Authorization: "Bearer x" } }]),
    ).toThrow(ConfigError);
    expect(invoke([SB, SB])).toThrow(/twice/);
    expect(invoke([{ name: "a.b", type: "stdio", command: "/x" }])).toThrow(ConfigError);
    const prepare = () =>
      codex().prepare({
        ...call,
        paths,
        skills: [],
        mcpServers: [{ name: "e", type: "stdio", command: "/x", env: { "BAD-NAME": "v" } }],
        hotWaitMs: 0,
      });
    expect(prepare).toThrow(ConfigError);
  });
});

describe("prepare(): config dir and skills", () => {
  it("creates CODEX_HOME with a placeholder config and links skills into .agents/skills, excluded from git", () => {
    const plan = codex().prepare({ ...call, paths, skills: ["code-review", "verify"], mcpServers: [SB], hotWaitMs: 0 });
    expect(plan.files).toEqual([
      {
        path: "/selfbuilding/home/.codex/config.toml",
        content: expect.stringContaining("--ignore-user-config"),
        mode: 0o644,
      },
    ]);
    expect(plan.symlinks).toEqual([
      { path: "/selfbuilding/work/.agents/skills/code-review", target: "/selfbuilding/skills/code-review" },
      { path: "/selfbuilding/work/.agents/skills/verify", target: "/selfbuilding/skills/verify" },
    ]);
    expect(plan.gitExcludes).toEqual(["/.agents/skills/code-review", "/.agents/skills/verify"]);
  });
});

describe("sessionArtifacts(): moving a session between boxes", () => {
  it("captures the rollout file under {state} and restores it into {home}/.codex", () => {
    const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    const transfer = codex().sessionArtifacts?.(id, paths);
    expect(transfer?.files).toEqual([`.codex/sessions/**/rollout-*-${id}.jsonl`]);
    expect(transfer?.capture[0]?.argv.slice(3)).toEqual([
      "codex-capture",
      "/selfbuilding/home",
      `/selfbuilding/state/sessions/codex/${id}`,
      id,
    ]);
    expect(transfer?.restore[0]?.argv.slice(3)).toEqual([
      "codex-restore",
      `/selfbuilding/state/sessions/codex/${id}`,
      "/selfbuilding/home",
    ]);
    expect(() => codex().sessionArtifacts?.("x*", paths)).toThrow(ConfigError);
  });
});
