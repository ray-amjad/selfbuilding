// Acceptance 6 (docs/BASIC-SCOPE.md): provider conformance. The tmpdir provider passes the whole suite offline,
// with injected 503s, timeouts, 429s, 401s, refusals and ghosts. The Docker, Impello and E2B suites are registered
// here too and skip, with the reason printed, unless their daemon or credentials are present. The tmpdir provider
// has no image, so the one case that checks harness CLIs inside an image skips for it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describePlacement, describeSandboxProvider } from "@selfbuilding/sandbox-conformance";
import { docker } from "@selfbuilding/sandbox-docker";
import { e2b } from "@selfbuilding/sandbox-e2b";
import { impello } from "@selfbuilding/sandbox-impello";
import { type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll } from "vitest";
import { runtimeDist } from "./support/kit.js";

const runtime = {
  runtime: readFileSync(path.join(runtimeDist(), "selfbuilding-runtime.mjs")),
  mcp: readFileSync(path.join(runtimeDist(), "selfbuilding-mcp.mjs")),
};

const tmpdir = tmpdirProvider({ id: "tmpdir" });
const reviewers: TmpdirProvider[] = [];
afterAll(async () => {
  await Promise.all([tmpdir.close(), ...reviewers.map((p) => p.close())]);
});

describeSandboxProvider("tmpdir", () => tmpdir, {
  faults: tmpdir.faults,
  ghost: (ref) => tmpdir.ghost(ref),
  runtime,
  timeoutMs: 60_000,
});

// Docker needs a reachable daemon; the official images are built locally on first use.
const dockerLive = process.env.SELFBUILDING_E2E_DOCKER === "1";
const dockerOptions = {
  build: true,
  ...(process.env.SELFBUILDING_DOCKER_SOCKET ? { socketPath: process.env.SELFBUILDING_DOCKER_SOCKET } : {}),
};
describeSandboxProvider("docker", () => docker(dockerOptions), {
  skip: dockerLive ? false : "set SELFBUILDING_E2E_DOCKER=1 with a reachable Docker daemon",
  runtime,
  timeoutMs: 10 * 60_000,
});
describePlacement(
  "docker build, tmpdir review",
  () => {
    const review = tmpdirProvider({ id: "tmpdir-review" });
    reviewers.push(review);
    return { primary: docker(dockerOptions), secondary: review };
  },
  {
    skip: dockerLive ? false : "set SELFBUILDING_E2E_DOCKER=1 with a reachable Docker daemon",
    timeoutMs: 10 * 60_000,
  },
);

const impelloKey = process.env.IMPELLO_API_KEY;
const impelloTemplate = process.env.IMPELLO_TEMPLATE ?? "selfbuilding-claude-code";
describeSandboxProvider("impello", () => impello({ apiKey: impelloKey ?? "", template: impelloTemplate }), {
  skip: impelloKey ? false : "IMPELLO_API_KEY is not set",
  timeoutMs: 180_000,
  image: { name: impelloTemplate, ref: impelloTemplate, version: "live" },
  runtime,
  harnessBinaries: ["/usr/local/bin/claude"],
});

const e2bKey = process.env.E2B_API_KEY;
const e2bTemplate = process.env.E2B_TEMPLATE ?? "selfbuilding-claude-code";
describeSandboxProvider("e2b", () => e2b({ apiKey: e2bKey ?? "", template: e2bTemplate }), {
  skip: e2bKey ? false : "E2B_API_KEY is not set",
  timeoutMs: 180_000,
  image: { name: e2bTemplate, ref: e2bTemplate, version: "live" },
  runtime,
  harnessBinaries: ["/usr/local/bin/claude"],
});
