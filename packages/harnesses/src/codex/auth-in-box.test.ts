import { canonicalPaths } from "@selfbuilding/testing";
import { describe, expect, it } from "vitest";
import { authFilePath } from "./auth.js";
import { codex } from "./index.js";

// Regression: a leased ChatGPT-login auth.json was staged root-owned 0600 while Codex runs as the agent user, so
// Codex found no credential and called the API with no Authorization header ("401 Missing bearer or basic
// authentication"). These cases pin every link Codex needs to find and read the file.

const paths = canonicalPaths();
const jwt = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const login = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { id_token: jwt({}), access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "rt-fake", account_id: "a" },
  last_refresh: "2026-11-01T10:00:00Z",
});
const call = { runId: "run-1", callPath: "root/0/build", attempt: 1, promptFile: `${paths.in}/prompt.md` };

describe("codex auth file in the box", () => {
  const cases = [
    ["auth-file (leased login)", { kind: "auth-file", value: "x", leased: true }, { AUTH_FILE: login }],
    ["api-key", { kind: "api-key", value: "x" }, { OPENAI_API_KEY: "sk-fake" }],
  ] as const;
  for (const [label, cred, values] of cases) {
    it(`${label}: the file is where CODEX_HOME points, owned by agent, mode 0600`, () => {
      const harness = codex();
      const auth = harness.auth(cred, { paths, values: { ...values } });
      const inv = harness.invoke({ ...call, paths });
      const file = auth.files[0];
      expect(auth.files).toHaveLength(1);
      expect(file?.path).toBe(`${inv.env.CODEX_HOME}/auth.json`);
      expect(file?.path).toBe(authFilePath(paths.home));
      expect(file?.owner).toBe("agent");
      expect(file?.mode).toBe(0o600);
      expect(inv.env.HOME).toBe(paths.home);
      // The variables Codex reads to find and use the file are never stripped.
      expect(auth.stripEnv).not.toContain("CODEX_HOME");
      expect(auth.stripEnv).not.toContain("HOME");
      // The file store, not a keyring the box does not have.
      expect(inv.argv.join(" ")).toContain('cli_auth_credentials_store="file"');
    });
  }

  it("the leased file is the one Codex rewrites on refresh, so it goes back to the pool from the same path", () => {
    const auth = codex().auth({ kind: "auth-file", value: "x", leased: true }, { paths, values: { AUTH_FILE: login } });
    expect(auth.leasedFile?.path).toBe(auth.files[0]?.path);
  });

  it("config.toml does not override the auth store or point Codex elsewhere", () => {
    const plan = codex().prepare({
      ...call,
      paths,
      skills: [],
      mcpServers: [{ name: "selfbuilding", type: "stdio", command: "/selfbuilding/bin/selfbuilding-mcp" }],
      hotWaitMs: 60_000,
    });
    const config = plan.files.find((f) => f.path === `${paths.home}/.codex/config.toml`);
    expect(config).toBeDefined();
    expect(config?.content).not.toMatch(/cli_auth_credentials_store|CODEX_HOME|preferred_auth_method/);
  });
});
