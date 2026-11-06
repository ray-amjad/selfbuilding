import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import {
  ConfigError,
  CredentialRefreshError,
  type GitToken,
  MissingCredentialError,
  UnprotectedRepoError,
} from "@selfbuilding/core";
import { type GitHubEmulator, seedPlayground, startGitHubEmulator } from "@selfbuilding/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type GitBrokerEvent, githubApp } from "./app.js";
import { appJwt, type FetchLike, loadPrivateKey } from "./http.js";
import type { RulesetDetail } from "./rulesets.js";

let gh: GitHubEmulator;
beforeAll(async () => {
  gh = await startGitHubEmulator();
});
afterAll(() => gh.close());
beforeEach(() => gh.reset());

const repo = () => `github.com/${gh.owner}/${gh.repo}`;
const call = (over: Partial<{ runId: string; callPath: string; launchId: string }> = {}) => ({
  repo: repo(),
  runId: "ns_run1",
  callPath: "ImplementSpec#0",
  launchId: "launch-1",
  ...over,
});

/** A request against the emulator with an arbitrary token, returning just the status. */
async function statusWith(token: string, method: string, path: string, body?: unknown): Promise<number> {
  const response = await fetch(gh.url + path, {
    method,
    headers: {
      authorization: `token ${token}`,
      accept: "application/vnd.github+json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await response.arrayBuffer();
  return response.status;
}

/**
 * The emulator has no rulesets API, so tests that need one put this in front of it: ruleset paths answer from
 * `rulesets`, everything else goes to the emulator. Records every path it saw.
 */
function withRulesets(
  rulesets: RulesetDetail[] | "forbidden",
  agentBranchRules: { type: string }[] = [],
): { fetch: FetchLike; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const url = new URL(input);
      seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.includes("/rules/branches/")) return Response.json(agentBranchRules);
      const match = /\/rulesets(?:\/(\d+))?$/.exec(url.pathname);
      if (!match) return fetch(input, init);
      if (rulesets === "forbidden")
        return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
      if (match[1] === undefined) {
        return Response.json(rulesets.map(({ id, name, target, enforcement }) => ({ id, name, target, enforcement })));
      }
      const found = rulesets.find((r) => r.id === Number(match[1]));
      return found ? Response.json(found) : Response.json({ message: "Not Found" }, { status: 404 });
    },
  };
}

const protectiveRuleset: RulesetDetail = {
  id: 1,
  name: "selfbuilding",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/selfbuilding/**"] } },
  rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
  current_user_can_bypass: "never",
};

describe("appJwt", () => {
  it("is an RS256 JWT for the App, backdated 60 s and valid for 9 minutes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = appJwt(4242, privateKey, 1_700_000_000_000);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
      iss: "4242",
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
  });

  it("accepts PKCS#1 PEM and escaped newlines from env-style storage, and rejects garbage as a ConfigError", () => {
    const pem = gh.appPrivateKey;
    expect(createPublicKey(loadPrivateKey(pem)).asymmetricKeyType).toBe("rsa");
    expect(loadPrivateKey(pem.replace(/\n/g, "\\n")).asymmetricKeyType).toBe("rsa");
    expect(() => loadPrivateKey("not a key")).toThrow(ConfigError);
  });
});

describe("githubApp options", () => {
  it("rejects any write permission for the agent, and unknown permissions, at construction", () => {
    const base = { appId: 1, privateKey: "k" };
    expect(() => githubApp({ ...base, agentPermissions: { contents: "write" as "read" } })).toThrow(/read-only/);
    expect(() => githubApp({ ...base, agentPermissions: { issues: "write" as "read" } })).toThrow(ConfigError);
    expect(() =>
      githubApp({ ...base, agentPermissions: { workflows: "read" } as unknown as { contents: "read" } }),
    ).toThrow(/not allowed/);
  });

  it("rejects a missing key and a non-numeric appId", () => {
    expect(() => githubApp({ appId: 0, privateKey: "k" })).toThrow(ConfigError);
    expect(() => githubApp({ appId: 1, privateKey: "" })).toThrow(/privateKey/);
    expect(() => githubApp({ appId: 1, privateKey: "k", installationId: -2 })).toThrow(/installationId/);
  });

  it("describes itself with non-secret facts only", () => {
    const broker = githubApp({ appId: 9, privateKey: "secret-pem", agentPermissions: { pull_requests: "read" } });
    expect(broker.id).toBe("github-app:9");
    expect(broker.host).toBe("github.com");
    const described = broker.describe();
    expect(described).toEqual({
      broker: "github-app",
      appId: 9,
      agentPermissions: { contents: "read", metadata: "read", pull_requests: "read" },
      requireRuleset: true,
      host: "github.com",
    });
    expect(JSON.stringify(described)).not.toContain("secret-pem");
  });
});

describe("githubApp against the GitHub emulator", () => {
  const broker = (over: Partial<Parameters<typeof githubApp>[0]> = {}) =>
    githubApp({ appId: gh.app.appId, privateKey: gh.appPrivateKey, apiUrl: gh.url, ...over });

  it("mints a read-only, repo-scoped token for the agent", async () => {
    const token = await broker({ agentPermissions: { pull_requests: "read" } }).readToken(call());
    expect(token.value).toMatch(/^ghs_/);
    expect(token.permissions).toEqual({ contents: "read", metadata: "read", pull_requests: "read" });
    expect(token.longLived).toBeUndefined();
    const ttl = Date.parse(token.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(50 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000);

    const base = `/repos/${gh.owner}/${gh.repo}`;
    expect(await statusWith(token.value, "GET", `${base}/contents/README.md`)).toBe(200);
    // Read-only: the agent cannot write contents or open a PR.
    expect(
      await statusWith(token.value, "POST", `${base}/git/refs`, {
        ref: "refs/heads/selfbuilding/x",
        sha: "0".repeat(40),
      }),
    ).toBe(403);
    expect(await statusWith(token.value, "POST", `${base}/pulls`, { title: "t", head: "main", base: "main" })).toBe(
      403,
    );
  });

  it("scopes the token to the one repository it was minted for", async () => {
    await gh.api(`/orgs/${gh.owner}/repos`, { body: { name: "other", private: true, auto_init: true } });
    const token = await broker().readToken(call());
    expect(await statusWith(token.value, "GET", `/repos/${gh.owner}/${gh.repo}/contents/README.md`)).toBe(200);
    expect(await statusWith(token.value, "GET", `/repos/${gh.owner}/other/contents/README.md`)).not.toBe(200);
  });

  it("mints a push token with contents: write and nothing that could touch workflows or PRs", async () => {
    const events: GitBrokerEvent[] = [];
    const token = await broker({ requireRuleset: false, onEvent: (e) => events.push(e) }).pushToken(call());
    expect(token.permissions).toEqual({ contents: "write", metadata: "read" });
    const playground = await seedPlayground(gh);
    try {
      const base = `/repos/${gh.owner}/${gh.repo}`;
      expect(
        await statusWith(token.value, "POST", `${base}/git/refs`, {
          ref: "refs/heads/selfbuilding/ns_run1/implement",
          sha: playground.baseSha,
        }),
      ).toBe(201);
      expect(await statusWith(token.value, "POST", `${base}/pulls`, { title: "t", head: "main", base: "main" })).toBe(
        403,
      );
    } finally {
      await playground.dispose();
    }
    // requireRuleset: false warns on every push token.
    expect(events).toEqual([
      {
        type: "credential.unprotected",
        level: "warn",
        data: { repo: repo(), runId: "ns_run1", callPath: "ImplementSpec#0", broker: `github-app:${gh.app.appId}` },
      },
    ]);
  });

  it("finds the installation per repo by default, and uses installationId when given", async () => {
    const looked = withRulesets([]);
    await broker({ fetch: looked.fetch }).readToken(call());
    await broker({ fetch: looked.fetch }).readToken(call());
    expect(looked.seen.filter((p) => p.endsWith("/installation"))).toHaveLength(2);

    const one = broker({ fetch: looked.fetch });
    looked.seen.length = 0;
    await one.readToken(call());
    await one.readToken(call());
    expect(looked.seen.filter((p) => p.endsWith("/installation"))).toHaveLength(1);

    const fixed = withRulesets([]);
    await broker({ fetch: fixed.fetch, installationId: gh.app.installationId }).readToken(call());
    expect(fixed.seen).toEqual([`POST /app/installations/${gh.app.installationId}/access_tokens`]);
  });

  it("mints the pull-request token with contents:read, which GitHub needs to read both refs", async () => {
    const bodies: unknown[] = [];
    const b = broker({
      fetch: async (input, init) => {
        if (new URL(input).pathname.endsWith("/access_tokens") && typeof init?.body === "string")
          bodies.push(JSON.parse(init.body));
        return fetch(input, init);
      },
    });
    await b.pullRequests.findOpen(repo(), "selfbuilding/x");
    expect(bodies.at(-1)).toMatchObject({
      permissions: { pull_requests: "write", contents: "read", metadata: "read" },
    });
  });

  it("re-resolves the private key on every mint, so a rotated key takes effect", async () => {
    let reads = 0;
    const b = broker({
      privateKey: async () => {
        reads++;
        return gh.appPrivateKey;
      },
    });
    await b.readToken(call());
    await b.readToken(call());
    expect(reads).toBe(2);
    await expect(broker({ privateKey: async () => "  " }).readToken(call())).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
  });

  it("explains a wrong key, a missing installation and a repo on another host as ConfigErrors", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongKey = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    await expect(broker({ privateKey: wrongKey }).readToken(call())).rejects.toThrow(/rejected the App's JWT/);
    await expect(broker({ installationId: 999 }).readToken(call())).rejects.toThrow(/not installed/);
    await expect(broker().readToken(call({ repo: "github.com/acme/missing" } as never))).rejects.toThrow(ConfigError);
    await expect(broker().readToken(call({ repo: "gitlab.com/acme/x" } as never))).rejects.toThrow(/gitlab\.com/);
  });

  it("fails closed with a retryable CredentialRefreshError when GitHub is unreachable or 5xx", async () => {
    const down = broker({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.readToken(call())).rejects.toBeInstanceOf(CredentialRefreshError);
    const flaky = broker({ fetch: async () => Response.json({ message: "boom" }, { status: 502 }) });
    const error = await flaky.readToken(call()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialRefreshError);
    expect((error as CredentialRefreshError).retryable).toBe(true);
  });

  it("requires a push launchId", async () => {
    await expect(broker({ requireRuleset: false }).pushToken(call({ launchId: "" }))).rejects.toThrow(/launchId/);
  });

  describe("ruleset requirement", () => {
    it("refuses the push token when no ruleset limits the App (the default)", async () => {
      const none = withRulesets([]);
      await expect(broker({ fetch: none.fetch }).pushToken(call())).rejects.toBeInstanceOf(UnprotectedRepoError);
      // The emulator has no rulesets API at all: unreadable means unprotected.
      await expect(broker().pushToken(call())).rejects.toBeInstanceOf(UnprotectedRepoError);
      const forbidden = withRulesets("forbidden");
      await expect(broker({ fetch: forbidden.fetch }).assertProtected(repo())).rejects.toThrow(/Could not read/);
    });

    it("mints once a ruleset blocks creation, update and deletion outside selfbuilding/*, checking once per run", async () => {
      const ok = withRulesets([protectiveRuleset]);
      const b = broker({ fetch: ok.fetch });
      await expect(b.assertProtected(repo())).resolves.toBeUndefined();
      const first = await b.pushToken(call());
      expect(first.permissions.contents).toBe("write");
      await b.pushToken(call({ launchId: "launch-2" }));
      expect(ok.seen.filter((p) => p.endsWith("/rulesets"))).toHaveLength(2); // assertProtected + first push
      await b.pushToken(call({ runId: "ns_run2" }));
      expect(ok.seen.filter((p) => p.endsWith("/rulesets"))).toHaveLength(3);
    });

    it("refuses before any push when GitHub still applies the ruleset to a nested agent branch", async () => {
      const nested = withRulesets([protectiveRuleset], [{ type: "creation" }, { type: "update" }]);
      await expect(broker({ fetch: nested.fetch }).assertProtected(repo())).rejects.toThrow(
        /also blocks the agents' own branches.*refs\/heads\/selfbuilding\/\*\*\/\*/,
      );
      expect(nested.seen.some((p) => p.includes("/rules/branches/selfbuilding/ruleset-check/call"))).toBe(true);
    });

    it("does not count a ruleset the App can bypass", async () => {
      const bypass = withRulesets([
        { ...protectiveRuleset, bypass_actors: [{ actor_id: gh.app.appId, actor_type: "Integration" }] },
      ]);
      await expect(broker({ fetch: bypass.fetch }).pushToken(call())).rejects.toBeInstanceOf(UnprotectedRepoError);
    });
  });

  it("revokes a token through DELETE /installation/token and treats an expired token as done", async () => {
    const seen: string[] = [];
    const b = broker({
      fetch: async (input, init) => {
        seen.push(
          `${init?.method} ${new URL(input).pathname} ${(init?.headers as Record<string, string> | undefined)?.authorization}`,
        );
        return new Response(null, { status: seen.length === 1 ? 204 : 401 });
      },
    });
    const token: GitToken = { value: "ghs_abc", expiresAt: new Date().toISOString(), permissions: {} };
    await b.revoke(token);
    await b.revoke(token);
    expect(seen).toEqual(["DELETE /installation/token token ghs_abc", "DELETE /installation/token token ghs_abc"]);
  });
});
