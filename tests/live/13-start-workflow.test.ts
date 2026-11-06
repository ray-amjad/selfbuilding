// Live 13 (docs/spec/demo-path.md §9): a real agent in a real sandbox calls start_workflow; the supervisor POSTs to
// the host's start-workflow handler on this machine through a public tunnel, and the launch is guarded and recorded.
// The launcher here records launches instead of running them, so the case costs one agent call.
import http from "node:http";
import path from "node:path";
import {
  agent,
  factory,
  fileArtifacts,
  fileJournal,
  run,
  type StartWorkflowCaller,
  type StartWorkflowRequest,
  type WorkflowLauncher,
  workflowRunId,
} from "@selfbuilding/core";
import { createStartWorkflowHandler } from "@selfbuilding/hooks";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { harnesses, liveRunId, needs, providers, recorder, targets, tempDir, useBuiltRuntime } from "./support/live.js";

const env = process.env;
const secret = env.SELFBUILDING_START_SECRET ?? "";
const publicUrl = env.SELFBUILDING_LIVE_START_URL ?? "";
const port = Number(env.SELFBUILDING_LIVE_START_PORT ?? "8788");
const startSkip = needs(
  !secret && "SELFBUILDING_START_SECRET is not set",
  !publicUrl && "SELFBUILDING_LIVE_START_URL (a public tunnel to SELFBUILDING_LIVE_START_PORT) is not set",
);

beforeAll(() => useBuiltRuntime());

const Launched = z.object({ runId: z.string() });
const Planner = factory({ name: "live-start-workflow", input: z.object({}) }, async () => {
  const r = await agent({
    name: "planner",
    label: "planner",
    output: Launched,
    startWorkflow: true,
    prompt: [
      "Use the start_workflow tool exactly once with these arguments:",
      '{ "name": "live-follow-up", "script": "export default async (input, sb) => ({ ok: true });", "size": "small" }',
      'It answers with a run id. Then submit { "runId": <that run id> }.',
    ].join("\n"),
  });
  return r.result;
});

describe("live 13: start_workflow from a real sandbox", () => {
  const target = targets.find((t) => t.skip === "") ?? targets[0];
  const skip = needs(target?.skip, startSkip);
  it.skipIf(skip !== "")(
    `an agent launches a workflow through the host handler${skip ? ` (skipped: ${skip})` : ""}`,
    async () => {
      if (!target) throw new Error("no target");
      const launches: { req: StartWorkflowRequest; caller: StartWorkflowCaller }[] = [];
      const launcher: WorkflowLauncher = {
        host: "node",
        async start(req, caller) {
          const runId = workflowRunId(caller, req);
          const existed = launches.some((l) => workflowRunId(l.caller, l.req) === runId);
          if (!existed) launches.push({ req, caller });
          return { runId, status: existed ? "exists" : "started", host: "node", watch: `selfbuilding watch ${runId}` };
        },
        active: async () => ({ runs: 0, sandboxes: 0 }),
      };
      const handler = createStartWorkflowHandler({ secret, launcher, policy: { enabled: true } });
      const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const response = await handler(
          new Request(`http://localhost${req.url}`, {
            method: req.method ?? "GET",
            headers,
            ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
          }),
        );
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      });
      await new Promise<void>((resolve) => server.listen(port, resolve));
      const dir = await tempDir("sbl-start-");
      const events = recorder();
      try {
        const runId = liveRunId("start_workflow");
        const out = await run(
          Planner,
          {},
          {
            runId,
            config: {
              deployment: "live",
              sandbox: providers[target.provider].make(target.harness),
              harness: harnesses[target.harness].make(),
              artifacts: fileArtifacts(path.join(dir, "artifacts")),
              secrets: { resolve: async (names) => Object.fromEntries(names.map((n) => [n, secret])) },
              startWorkflow: { enabled: true, url: publicUrl },
            },
            journal: fileJournal(path.join(dir, "journal")),
            events: [events.sink],
          },
        );
        expect(out.status, JSON.stringify(events.of("agent.failed").map((e) => e.data))).toBe("ok");
        expect(launches).toHaveLength(1);
        expect(launches[0]?.caller).toEqual({ kind: "agent", runId, callPath: "planner", depth: 1 });
        expect((out.output as { runId: string }).runId).toBe(
          workflowRunId(launches[0]?.caller as StartWorkflowCaller, launches[0]?.req as StartWorkflowRequest),
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
