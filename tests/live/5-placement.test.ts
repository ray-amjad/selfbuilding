// Live acceptance 5: the provider-level placement suite across real providers: build on one, review on another,
// for every pair that is configured.
import { describePlacement } from "@selfbuilding/sandbox-conformance";
import { needs, type ProviderName, providers } from "./support/live.js";

const pairs: [ProviderName, ProviderName][] = [
  ["impello", "e2b"],
  ["e2b", "impello"],
  ["docker", "impello"],
  ["docker", "e2b"],
];

for (const [primary, secondary] of pairs) {
  const skip = needs(
    !providers[primary].ready && providers[primary].skip,
    !providers[secondary].ready && providers[secondary].skip,
  );
  describePlacement(
    `live: ${primary} build, ${secondary} review`,
    () => ({ primary: providers[primary].make("claude-code"), secondary: providers[secondary].make("codex") }),
    { skip: skip === "" ? false : skip, timeoutMs: 15 * 60_000 },
  );
}
