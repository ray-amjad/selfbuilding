import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { emulatorPort } from "./common.js";
import { type GitHubEmulator, startGitHubEmulator } from "./github.js";
import { commitToBranch, openPlaygroundPr, seedPlayground } from "./playground.js";
import { type SlackEmulator, startSlackEmulator } from "./slack.js";

describe("emulatorPort", () => {
  it("follows 4001 + workerId * 20", () => {
    expect(emulatorPort("github", 0)).toBe(4001);
    expect(emulatorPort("slack", 2)).toBe(4043);
  });
});

describe("GitHub emulator and the playground repo", () => {
  let gh: GitHubEmulator;
  beforeAll(async () => {
    gh = await startGitHubEmulator();
  });
  afterAll(() => gh.close());

  it("seeds an org, a private repo, an App with a key and the two tokens", async () => {
    const repo = await gh.api<{ full_name: string; private: boolean }>(`/repos/${gh.owner}/${gh.repo}`);
    expect(repo.full_name).toBe("acme/playground");
    expect(gh.appPrivateKey).toContain("PRIVATE KEY");
    expect((await gh.api<{ login: string }>("/user", { as: "reviewer" })).login).toBe("reviewer");
  });

  it("mirrors a local branch with its history and opens a PR on it", async () => {
    const playground = await seedPlayground(gh);
    onTestFinished(() => playground.dispose());
    const main = await gh.api<{ object: { sha: string } }>(`/repos/${gh.owner}/${gh.repo}/git/ref/heads/main`);
    expect(main.object.sha).toBe(playground.baseSha);
    const readme = await gh.api<{ content: string }>(`/repos/${gh.owner}/${gh.repo}/contents/README.md?ref=main`);
    expect(Buffer.from(readme.content, "base64").toString()).toContain("# playground");

    const pr = await openPlaygroundPr(gh, playground, {
      branch: "selfbuilding/run-1/implement",
      files: { "src/math.js": "export const add = (a, b) => a + b;\nexport const multiply = (a, b) => a * b;\n" },
      title: "Add multiply",
      body: "Implements docs/specs/multiply.md",
    });
    expect(pr.number).toBeGreaterThan(0);
    const fetched = await gh.api<{ head: { sha: string; ref: string }; base: { sha: string }; title: string }>(
      `/repos/${gh.owner}/${gh.repo}/pulls/${pr.number}`,
    );
    expect(fetched).toMatchObject({ title: "Add multiply", head: { sha: pr.headSha, ref: pr.branch } });
    const file = await gh.api<{ content: string }>(
      `/repos/${gh.owner}/${gh.repo}/contents/src/math.js?ref=${encodeURIComponent(pr.branch)}`,
    );
    expect(Buffer.from(file.content, "base64").toString()).toContain("multiply");

    // A fix pushed to the local remote is mirrored as a child of the PR head.
    await commitToBranch(playground.remote, { branch: pr.branch, from: pr.branch, files: { "FIX.md": "fixed\n" } });
    const { mirrorRefs } = await import("./playground.js");
    const refs = await mirrorRefs(gh, {
      gitDir: playground.remote.bareDir,
      refs: [pr.branch],
      env: playground.remote.env,
    });
    const head = await gh.api<{ parents: { sha: string }[] }>(
      `/repos/${gh.owner}/${gh.repo}/git/commits/${refs[`refs/heads/${pr.branch}`]}`,
    );
    expect(head.parents.map((p) => p.sha)).toEqual([pr.headSha]);
  });
});

describe("Slack emulator", () => {
  let slack: SlackEmulator;
  let server: Server;
  const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    slack = await startSlackEmulator({ interactivityUrl: `http://127.0.0.1:${port}/slack/interactions` });
  });
  afterAll(async () => {
    await slack.close();
    server.close();
  });

  it("delivers a signed block_actions payload when the human clicks a button", async () => {
    const posted = await slack.api<{ ts: string }>("chat.postMessage", {
      channel: slack.channelId,
      text: "Ship it?",
      blocks: [
        {
          type: "actions",
          elements: [
            { type: "button", action_id: "approve", text: { type: "plain_text", text: "Approve" }, value: "yes" },
            { type: "button", action_id: "reject", text: { type: "plain_text", text: "Reject" }, value: "no" },
          ],
        },
      ],
    });
    await slack.click(posted.ts, { actionId: "approve" });
    const delivery = received.at(-1);
    if (!delivery) throw new Error("no interaction delivered");
    const timestamp = String(delivery.headers["x-slack-request-timestamp"]);
    const expected = `v0=${createHmac("sha256", slack.signingSecret).update(`v0:${timestamp}:${delivery.body}`).digest("hex")}`;
    expect(delivery.headers["x-slack-signature"]).toBe(expected);
    expect(slack.sign(delivery.body, Number(timestamp))["x-slack-signature"]).toBe(expected);
    const payload = JSON.parse(new URLSearchParams(delivery.body).get("payload") ?? delivery.body);
    expect(payload).toMatchObject({ type: "block_actions", actions: [{ action_id: "approve", value: "yes" }] });
    expect(payload.user.id).toBe(slack.human.userId);
  });

  it("lets the human reply in the thread, and reset() keeps the helpers working", async () => {
    const posted = await slack.api<{ ts: string }>("chat.postMessage", {
      channel: slack.channelId,
      text: "Which branch?",
    });
    const reply = await slack.reply(posted.ts, "use main");
    expect(reply.thread_ts).toBe(posted.ts);
    const replies = await slack.api<{ messages: { text: string }[] }>(
      "conversations.replies",
      { channel: slack.channelId, ts: posted.ts },
      "human",
    );
    expect(replies.messages.map((m) => m.text)).toContain("use main");
    await slack.reset();
    expect(await slack.messages()).toEqual([]);
    await slack.api("chat.postMessage", { channel: slack.channelId, text: "after reset" });
    expect((await slack.messages()).map((m) => m.text)).toEqual(["after reset"]);
  });
});
