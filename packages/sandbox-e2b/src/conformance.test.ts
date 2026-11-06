import { describePlacement, describeSandboxProvider } from "@selfbuilding/sandbox-conformance";
import { tmpdirProvider } from "@selfbuilding/testing";
import { afterAll } from "vitest";
import { conformanceFaults, FAST, FakeE2b } from "../test/fake-e2b.js";
import { createE2bShapeProvider, e2b, e2bClient } from "./index.js";

const LIMITS = { maxLifetimeMs: 24 * 60 * 60 * 1000, lifetimeGuaranteed: true, expireKeeps: "memory" } as const;

const fake = new FakeE2b({ flavor: "e2b" });
const reviewFake = new FakeE2b({ flavor: "impello" });
const tmpdir = tmpdirProvider({ id: "tmpdir-review" });
afterAll(async () => {
  await Promise.all([fake.close(), reviewFake.close(), tmpdir.close()]);
});

function fakeProvider(vendor: FakeE2b, id: string) {
  return createE2bShapeProvider({
    id,
    // Through the real binding wrapper, so the SDK call shapes are the ones `e2b()` uses.
    client: e2bClient(vendor.client as unknown as Parameters<typeof e2bClient>[0]),
    template: "selfbuilding-claude-code",
    apiKey: "e2b_test_key",
    domain: "fake.local",
    limits: LIMITS,
    connection: { retries: 0 },
    timings: FAST,
  });
}

// Offline: the shared adapter against a vendor double with injected 503s, timeouts, 429s, 401s and ghosts.
describeSandboxProvider("e2b-shape (offline vendor double)", () => fakeProvider(fake, "e2b"), {
  faults: conformanceFaults(fake),
  ghost: (ref) => fake.ghost(ref.id, "not-found"),
  timeoutMs: 30_000,
});

// Build on one E2B-shape box, review on forks of it, on the other vendor flavour, and on a different provider.
describePlacement(
  "e2b-shape build, impello-flavour review",
  () => ({ primary: fakeProvider(fake, "e2b"), secondary: fakeProvider(reviewFake, "impello") }),
  { timeoutMs: 30_000 },
);
describePlacement("e2b-shape build, tmpdir review", () => ({ primary: fakeProvider(fake, "e2b"), secondary: tmpdir }), {
  timeoutMs: 30_000,
});

// Live: the real E2B API, only with a key. Never runs offline.
const liveKey = process.env.E2B_API_KEY;
describeSandboxProvider(
  "e2b (live)",
  () => e2b({ apiKey: liveKey ?? "", template: process.env.E2B_TEMPLATE ?? "selfbuilding-claude-code", tier: "pro" }),
  {
    skip: liveKey ? false : "E2B_API_KEY is not set",
    timeoutMs: 180_000,
    image: {
      name: "selfbuilding-claude-code",
      ref: process.env.E2B_TEMPLATE ?? "selfbuilding-claude-code",
      version: "live",
    },
    harnessBinaries: ["/usr/local/bin/claude"],
  },
);
