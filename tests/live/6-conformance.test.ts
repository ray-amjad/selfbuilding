// Live acceptance 6: the provider conformance suite on Docker, Impello and E2B, once per harness image, including
// the check that the harness CLI is in the image. Cloud vendors run with SELFBUILDING_LIVE_CONCURRENCY creates in
// flight (default 2), so the suite does not trip their create rate limits.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describeSandboxProvider } from "@selfbuilding/sandbox-conformance";
import { type HarnessName, liveConcurrency, needs, type ProviderName, providers, runtimeDist } from "./support/live.js";

const runtime = {
  runtime: readFileSync(path.join(runtimeDist(), "selfbuilding-runtime.mjs")),
  mcp: readFileSync(path.join(runtimeDist(), "selfbuilding-mcp.mjs")),
};

const binary: Record<HarnessName, string> = { "claude-code": "/usr/local/bin/claude", codex: "/usr/local/bin/codex" };

for (const p of ["docker", "impello", "e2b"] as ProviderName[]) {
  const concurrency = liveConcurrency(p);
  for (const h of ["claude-code", "codex"] as HarnessName[]) {
    const skip = needs(!providers[p].ready && providers[p].skip);
    describeSandboxProvider(`live: ${p} (${h} image)`, () => providers[p].make(h), {
      skip: skip === "" ? false : skip,
      runtime,
      timeoutMs: 15 * 60_000,
      harnessBinaries: [binary[h]],
      ...(concurrency === undefined ? {} : { concurrency }),
    });
  }
}
