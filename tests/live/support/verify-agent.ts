// Live helpers for Verify on the playground web app (demo-path §4.2). Verify runs on Codex at `medium` on a fresh
// box, so template providers need their medium template listed in `sizes`; nothing here prints a credential.
import type { SandboxProvider } from "@selfbuilding/core";
import { docker } from "@selfbuilding/sandbox-docker";
import { e2b } from "@selfbuilding/sandbox-e2b";
import { impello } from "@selfbuilding/sandbox-impello";
import { harnesses, needs, type ProviderName, providers } from "./live.js";

const env = process.env;

/** The playground branch with the planted bug: the page shows the new note, the database never stores it. */
export const WEB_BROKEN_BRANCH = env.SELFBUILDING_PLAYGROUND_WEB_BROKEN ?? "fixture/web-broken-add";
export const WEB_MAIN_BRANCH = "main";

/** Overrides Verify's `medium` (e.g. `small` on an account whose medium template is not built yet). */
export const VERIFY_SIZE = env.SELFBUILDING_VERIFY_SIZE;

/** Comma-separated size names whose templates are built, as the sizes suite reads them (default `small`). */
function sizesFrom(value: string | undefined): string[] | undefined {
  const list = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

// Spread rather than named, so this file compiles before and after the providers gain their `sizes` option.
const sized = (value: string | undefined): Record<string, unknown> => {
  const sizes = sizesFrom(value);
  return sizes ? { sizes } : {};
};

/** A provider for Verify's Codex box, with the sizes whose templates exist. */
export function verifyProvider(name: ProviderName): SandboxProvider {
  switch (name) {
    case "impello":
      return impello({
        apiKey: env.IMPELLO_API_KEY ?? "",
        template: env.IMPELLO_CODEX_TEMPLATE ?? "selfbuilding-codex",
        ...sized(env.IMPELLO_SIZES),
      });
    case "e2b":
      return e2b({
        apiKey: env.E2B_API_KEY ?? "",
        template: env.E2B_CODEX_TEMPLATE ?? "selfbuilding-codex",
        ...sized(env.E2B_SIZES),
      });
    case "docker":
      return docker({
        build: true,
        ...(env.SELFBUILDING_DOCKER_SOCKET ? { socketPath: env.SELFBUILDING_DOCKER_SOCKET } : {}),
      });
  }
}

/** Every provider Verify runs on, with Codex, and why each skips. */
export const verifyTargets: { name: string; provider: ProviderName; skip: string }[] = (
  ["impello", "e2b", "docker"] as const
).map((p) => ({
  name: `codex on ${p}`,
  provider: p,
  skip: needs(!providers[p].ready && providers[p].skip, !harnesses.codex.ready && harnesses.codex.skip),
}));
