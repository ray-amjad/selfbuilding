import { tmpdirProvider } from "@selfbuilding/testing";
import { afterAll } from "vitest";
import { describePlacement, describeSandboxProvider } from "./index.js";

// The tmpdir provider must pass the whole suite offline (BASIC-SCOPE acceptance tests 5 and 6).
const provider = tmpdirProvider();
const build = tmpdirProvider({ id: "tmpdir-build" });
const review = tmpdirProvider({ id: "tmpdir-review" });
afterAll(async () => {
  await Promise.all([provider.close(), build.close(), review.close()]);
});

describeSandboxProvider("tmpdir", () => provider, {
  faults: provider.faults,
  ghost: (ref) => provider.ghost(ref),
  timeoutMs: 30_000,
});

describePlacement("tmpdir build, tmpdir review", () => ({ primary: build, secondary: review }), { timeoutMs: 30_000 });
