import { DEFAULT_IMAGE, describePlacement, describeSandboxProvider } from "@selfbuilding/sandbox-conformance";
import { type TmpdirProvider, tmpdirProvider } from "@selfbuilding/testing";
import { afterAll } from "vitest";
import { connectDocker } from "../src/client.js";
import { docker } from "../src/index.js";
import { runExec } from "../src/sandbox.js";

// Needs a reachable Docker daemon. The official images are built locally on first use (build: true), so the first
// run takes several minutes.
const live = process.env.SELFBUILDING_E2E_DOCKER === "1";
const skip = live ? false : "set SELFBUILDING_E2E_DOCKER=1 with a reachable Docker daemon";
const socketPath = process.env.SELFBUILDING_DOCKER_SOCKET;

const options = {
  build: true,
  deadlineMs: 60_000,
  probeBudgetMs: 5_000,
  ...(socketPath ? { socketPath } : {}),
};

/** Ghost hook: the container stays listed and running, but its guest can no longer run a shell. */
async function ghost(ref: { id: string }): Promise<void> {
  const container = connectDocker(socketPath).getContainer(ref.id);
  await runExec(container, {
    cmd: ["/bin/mv", "/bin/sh", "/bin/sh.gone"],
    user: "root",
    timeoutMs: 10_000,
    graceMs: 1_000,
  });
}

let review: TmpdirProvider | undefined;
afterAll(() => review?.close());

describeSandboxProvider("docker", () => docker(options), {
  skip,
  ghost,
  timeoutMs: 10 * 60 * 1000,
});

describeSandboxProvider("docker, harness images", () => docker({ ...options, id: "docker-harness" }), {
  skip: live && process.env.SELFBUILDING_E2E_DOCKER_IMAGES === "1" ? false : "set SELFBUILDING_E2E_DOCKER_IMAGES=1 too",
  image: {
    name: "selfbuilding-claude-code",
    ref: `selfbuilding/claude-code:${DEFAULT_IMAGE.version}`,
    version: DEFAULT_IMAGE.version,
  },
  harnessBinaries: ["/usr/local/bin/claude"],
  timeoutMs: 15 * 60 * 1000,
});

describePlacement("docker build, docker review", () => ({ primary: docker(options) }), {
  skip,
  timeoutMs: 10 * 60 * 1000,
});

describePlacement(
  "docker build, tmpdir review",
  () => {
    review = tmpdirProvider({ id: "tmpdir-review" });
    return { primary: docker(options), secondary: review };
  },
  {
    skip,
    timeoutMs: 10 * 60 * 1000,
  },
);
