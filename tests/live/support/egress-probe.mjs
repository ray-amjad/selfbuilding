#!/usr/bin/env node
// Probes each cloud vendor's egress enforcement directly through its own SDK, with no selfbuilding code in the
// path, so a leak can be told apart from an adapter bug (docs/decisions/0001-egress-enforcement.md).
//
// For each configured vendor it creates short-lived boxes with:
//   - allowInternetAccess: false           (what the adapter sends for "deny-all")
//   - network.denyOut ["0.0.0.0/0"]         (the documented equivalent)
//   - network.allowOut [one host] + denyOut (what the adapter sends for an allowlist)
// and tries a TCP connection to 1.1.1.1:443 from inside each. It prints one line per box and kills every box it
// made. It never prints a credential.
//
// Gated: it does nothing without SELFBUILDING_LIVE=1. Not run by any test or CI job.
//
//   SELFBUILDING_LIVE=1 E2B_API_KEY=... IMPELLO_API_KEY=... node tests/live/support/egress-probe.mjs
//
// Optional: E2B_TEMPLATE / IMPELLO_TEMPLATE (default "selfbuilding-claude-code"), EGRESS_PROBE_HOST (default
// 1.1.1.1), EGRESS_PROBE_VENDORS (comma list, default "e2b,impello").

const env = process.env;

if (env.SELFBUILDING_LIVE !== "1") {
  console.log("egress-probe: skipped (set SELFBUILDING_LIVE=1 to run it; it creates real sandboxes)");
  process.exit(0);
}

const HOST = env.EGRESS_PROBE_HOST ?? "1.1.1.1";
const vendors = (env.EGRESS_PROBE_VENDORS ?? "e2b,impello").split(",").map((v) => v.trim());

// bash's /dev/tcp needs no node in the template; `timeout` bounds a policy that drops instead of refusing.
const PROBE = `timeout 6 bash -c 'exec 3<>/dev/tcp/${HOST}/443' && echo OPEN || echo BLOCKED`;

const cases = [
  { name: "allowInternetAccess=false", opts: { allowInternetAccess: false } },
  { name: "denyOut 0.0.0.0/0", opts: { network: { denyOut: ["0.0.0.0/0"] } } },
  {
    name: "allowOut 8.8.8.8 + denyOut 0.0.0.0/0",
    opts: { network: { allowOut: ["8.8.8.8"], denyOut: ["0.0.0.0/0"] } },
  },
  { name: "control: open", opts: {}, control: true },
];

async function load(vendor) {
  if (vendor === "e2b") {
    if (!env.E2B_API_KEY) return { skip: "E2B_API_KEY is not set" };
    const { Sandbox } = await import("e2b");
    return {
      Sandbox,
      template: env.E2B_TEMPLATE ?? "selfbuilding-claude-code",
      conn: { apiKey: env.E2B_API_KEY },
    };
  }
  if (vendor === "impello") {
    if (!env.IMPELLO_API_KEY) return { skip: "IMPELLO_API_KEY is not set" };
    const { Sandbox } = await import("@impello/sdk");
    return {
      Sandbox,
      template: env.IMPELLO_TEMPLATE ?? "selfbuilding-claude-code",
      conn: { apiKey: env.IMPELLO_API_KEY, domain: env.IMPELLO_DOMAIN ?? "sandbox.impello.ai" },
    };
  }
  return { skip: `unknown vendor "${vendor}"` };
}

async function probeOne(vendor, sdk, c) {
  let sbx;
  try {
    sbx = await sdk.Sandbox.create(sdk.template, {
      ...sdk.conn,
      timeoutMs: 5 * 60_000,
      metadata: { "selfbuilding.deployment": "egress-probe" },
      ...c.opts,
    });
    const info = await sdk.Sandbox.getInfo(sbx.sandboxId, sdk.conn).catch(() => undefined);
    const run = await sbx.commands.run(PROBE, { user: "root", timeoutMs: 30_000 }).catch((error) => ({
      stdout: "",
      stderr: String(error?.message ?? error),
      exitCode: -1,
    }));
    const verdict = run.stdout.includes("OPEN") ? "OPEN" : run.stdout.includes("BLOCKED") ? "BLOCKED" : "ERROR";
    const expected = c.control ? "OPEN" : "BLOCKED";
    const status = verdict === expected ? "ok" : verdict === "ERROR" ? "probe-error" : "NOT ENFORCED";
    const reported = info
      ? ` vendor reports allowInternetAccess=${String(info.allowInternetAccess)} network=${JSON.stringify(info.network ?? null)}`
      : "";
    console.log(
      `${vendor}\t${c.name}\t${verdict}\t${status}${reported}${verdict === "ERROR" ? `\t${run.stderr}` : ""}`,
    );
    return status === "ok";
  } catch (error) {
    console.log(`${vendor}\t${c.name}\tCREATE FAILED\t${error?.name ?? "Error"}: ${error?.message ?? error}`);
    return false;
  } finally {
    if (sbx) await sdk.Sandbox.kill(sbx.sandboxId, sdk.conn).catch(() => undefined);
  }
}

let allOk = true;
for (const vendor of vendors) {
  const sdk = await load(vendor);
  if (sdk.skip) {
    console.log(`${vendor}\tskipped\t${sdk.skip}`);
    continue;
  }
  for (const c of cases) allOk = (await probeOne(vendor, sdk, c)) && allOk;
}
process.exit(allOk ? 0 : 1);
