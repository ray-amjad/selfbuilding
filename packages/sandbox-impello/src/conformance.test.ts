import type { Sandbox } from "@impello/sdk";
import { describeSandboxProvider } from "@selfbuilding/sandbox-conformance";
import { createE2bShapeProvider } from "@selfbuilding/sandbox-e2b/adapter";
import { afterAll } from "vitest";
import { conformanceFaults, FAST, FakeE2b } from "../../sandbox-e2b/test/fake-e2b.js";
import { impello, impelloClient } from "./index.js";

// Offline: the Impello binding wrapper over a vendor double that answers in @impello/sdk's error shapes.
const fake = new FakeE2b({ flavor: "impello" });
afterAll(() => fake.close());

describeSandboxProvider(
  "impello binding (offline vendor double)",
  () =>
    createE2bShapeProvider({
      id: "impello",
      client: impelloClient(fake.client as unknown as typeof Sandbox),
      template: "selfbuilding-claude-code",
      apiKey: "imp_test_key",
      domain: "sandbox.impello.ai",
      limits: { maxLifetimeMs: 24 * 60 * 60 * 1000, lifetimeGuaranteed: true, expireKeeps: "memory" },
      timings: FAST,
    }),
  { faults: conformanceFaults(fake), ghost: (ref) => fake.ghost(ref.id, "not-found"), timeoutMs: 30_000 },
);

// Live: the real Impello API, only with a key. Never runs offline.
const liveKey = process.env.IMPELLO_API_KEY;
const template = process.env.IMPELLO_TEMPLATE ?? "selfbuilding-claude-code";
describeSandboxProvider("impello (live)", () => impello({ apiKey: liveKey ?? "", template, tier: "plan100" }), {
  skip: liveKey ? false : "IMPELLO_API_KEY is not set",
  timeoutMs: 180_000,
  image: { name: template, ref: template, version: "live" },
  harnessBinaries: ["/usr/local/bin/claude"],
});
