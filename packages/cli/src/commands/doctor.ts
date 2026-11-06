import { mkdirSync } from "node:fs";
import type { HarnessCredential, SandboxProvider, Secret, SelfbuildingConfig } from "@selfbuilding/core";
import { parseCommandArgs } from "../args.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../exit.js";
import { deploymentOf, type LoadedProject, loadProject } from "../project.js";

export const DOCTOR_HELP = `Usage: selfbuilding doctor [options]

Checks the config and every credential it names, and reports everything that is missing at once.
Secret values are resolved to check them and are never printed.

Options:
  --repo <owner/name>  Also check that the git broker can mint a token for this repo and that its
                       branch protection limits writes to selfbuilding/* refs
  --config <path>      Config file (default: search upward)
  --env-file <path>    Load a dotenv file before the config is evaluated
  --json               Print the findings as one JSON line on stdout
`;

export type Severity = "ok" | "warn" | "problem";

export interface Finding {
  check: string;
  severity: Severity;
  message: string;
  /** For missing secrets: the variable or secret name to set. */
  variable?: string;
}

const PROBE_TIMEOUT_MS = 15_000;

export async function doctorCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseCommandArgs(
    "doctor",
    argv,
    { repo: { type: "string" }, config: { type: "string" }, "env-file": { type: "string" }, json: { type: "boolean" } },
    { min: 0, max: 0 },
  );
  const findings: Finding[] = [];
  findings.push(nodeVersion());

  let project: LoadedProject | null = null;
  try {
    project = await loadProject(ctx, {
      config: args.str("config"),
      envFile: args.str("env-file"),
      requireConfig: true,
    });
    findings.push({ check: "config", severity: "ok", message: `loaded ${project.configPath}` });
  } catch (error) {
    findings.push({ check: "config", severity: "problem", message: (error as Error).message });
  }
  if (project) findings.push(...(await checkProject(project, args.str("repo"))));

  const problems = findings.filter((f) => f.severity === "problem");
  if (args.bool("json")) {
    ctx.stdout.write(`${JSON.stringify({ ok: problems.length === 0, findings })}\n`);
  } else {
    const mark: Record<Severity, string> = { ok: "ok     ", warn: "warn   ", problem: "PROBLEM" };
    for (const f of findings) ctx.stderr.write(`${mark[f.severity]} ${f.check}: ${f.message}\n`);
    ctx.stderr.write(
      problems.length === 0
        ? "Everything the config needs is in place.\n"
        : `${problems.length} problem${problems.length === 1 ? "" : "s"} to fix before a run can use every feature.\n`,
    );
  }
  return problems.length === 0 ? EXIT.ok : EXIT.failed;
}

function nodeVersion(): Finding {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const ok = major > 22 || (major === 22 && minor >= 12);
  return {
    check: "node",
    severity: ok ? "ok" : "problem",
    message: ok
      ? `Node ${process.versions.node}`
      : `Node ${process.versions.node}; selfbuilding needs Node 22.12 or later`,
  };
}

async function checkProject(project: LoadedProject, repo: string | undefined): Promise<Finding[]> {
  const { config } = project;
  const findings: Finding[] = [];
  const deployment = deploymentOf(config);
  findings.push(
    /^[a-z0-9-]{1,32}$/.test(deployment)
      ? { check: "deployment", severity: "ok", message: deployment }
      : { check: "deployment", severity: "problem", message: `"${deployment}" must match ^[a-z0-9-]{1,32}$` },
  );

  if (!config.harness) {
    findings.push({
      check: "harness",
      severity: "problem",
      message: "no harness set; add harness: claudeCode({...}) or codex({...}) to the config",
    });
  } else {
    findings.push(...(await checkHarnessCredentials(config)));
  }

  if (project.providers.length === 0) {
    findings.push({
      check: "sandbox",
      severity: "problem",
      message: "no sandbox provider set; add sandbox: docker(), impello({...}) or e2b({...}) to the config",
    });
  }
  const probes = await Promise.all(project.providers.map((p) => probeProvider(p, deployment)));
  findings.push(...probes);

  findings.push(...(await checkSecrets(config)));
  findings.push(...checkHitl(config));
  findings.push(...(await checkGit(config, repo)));

  if (!config.journal) {
    try {
      mkdirSync(project.paths.dir, { recursive: true });
      findings.push({ check: "journal", severity: "ok", message: `file journal in ${project.paths.journal}` });
    } catch (error) {
      findings.push({
        check: "journal",
        severity: "problem",
        message: `cannot create ${project.paths.dir}: ${(error as Error).message}`,
      });
    }
  }
  return findings;
}

/** A credential pool passes when one entry resolves; the entries that do not are listed as warnings. */
async function checkHarnessCredentials(config: SelfbuildingConfig): Promise<Finding[]> {
  const harness = config.harness;
  if (!harness) return [];
  const consumer = `harness:${harness.id}`;
  const creds = harness.options?.credentials;
  const pool: HarnessCredential[] = creds === undefined ? [] : Array.isArray(creds) ? creds : [creds];
  if (pool.length === 0) {
    return [
      {
        check: consumer,
        severity: "problem",
        message: `no credentials; pass credentials: { kind: "api-key", value: fromEnv("...") } to the harness`,
      },
    ];
  }
  const results = await Promise.all(
    pool.map(async (cred) => {
      const secrets = cred.kind === "provider-keys" ? Object.entries(cred.values) : [[cred.kind, cred.value] as const];
      const failures: Finding[] = [];
      for (const [label, secret] of secrets) {
        const missing = await resolveSecret(secret);
        if (missing) {
          failures.push({
            check: consumer,
            severity: "warn",
            message: `${cred.kind}${cred.kind === "provider-keys" ? ` ${label}` : ""}: ${missing.message}`,
            ...(missing.variable ? { variable: missing.variable } : {}),
          });
        }
      }
      return { cred, failures };
    }),
  );
  const usable = results.filter((r) => r.failures.length === 0);
  const failures = results.flatMap((r) => r.failures);
  if (usable.length === 0) return failures.map((f) => ({ ...f, severity: "problem" as const }));
  const first = usable[0]?.cred.kind ?? "credential";
  return [
    {
      check: consumer,
      severity: "ok",
      message: `${first} resolves${usable.length > 1 ? ` (${usable.length} of ${pool.length} credentials usable)` : ""}`,
    },
    ...failures,
  ];
}

async function checkSecrets(config: SelfbuildingConfig): Promise<Finding[]> {
  const named: [string, Secret][] = [];
  if (config.controlPlane) named.push(["controlPlane.token", config.controlPlane.token]);
  if (config.egress && typeof config.egress === "object") {
    for (const inject of config.egress.inject ?? []) {
      for (const [header, secret] of Object.entries(inject.headers))
        named.push([`egress ${inject.host} ${header}`, secret]);
    }
  }
  const findings: Finding[] = [];
  for (const [check, secret] of named) {
    const missing = await resolveSecret(secret);
    findings.push(
      missing
        ? {
            check,
            severity: "problem",
            message: missing.message,
            ...(missing.variable ? { variable: missing.variable } : {}),
          }
        : { check, severity: "ok", message: "resolves" },
    );
  }
  return findings;
}

function checkHitl(config: SelfbuildingConfig): Finding[] {
  const channels = config.hitl?.channels ?? [];
  const mode = config.hitl?.mode ?? (channels.length > 0 ? "interactive" : "afk");
  if (mode === "interactive" && channels.length === 0) {
    return [
      { check: "hitl", severity: "problem", message: 'mode "interactive" needs at least one channel in hitl.channels' },
    ];
  }
  if (channels.length === 0) {
    return [
      {
        check: "hitl",
        severity: "warn",
        message: "no channel: every ask resolves by its AFK policy; use selfbuilding answer to answer by hand",
      },
    ];
  }
  return [{ check: "hitl", severity: "ok", message: `${mode} on ${channels.map((c) => c.id).join(", ")}` }];
}

async function checkGit(config: SelfbuildingConfig, repo: string | undefined): Promise<Finding[]> {
  const broker = config.git;
  if (!broker) {
    return [
      {
        check: "git",
        severity: repo ? "problem" : "warn",
        message: "no git broker: public clones only and nothing is pushed; set git: githubApp({...})",
      },
    ];
  }
  if (!repo)
    return [{ check: `git:${broker.id}`, severity: "ok", message: "configured (pass --repo to check a repo)" }];
  const findings: Finding[] = [];
  try {
    const token = await withTimeout(
      broker.readToken({ repo, runId: "doctor", callPath: "doctor" }),
      "minting a read token",
    );
    findings.push({
      check: `git:${broker.id}`,
      severity: "ok",
      message: `read token for ${repo} expires ${token.expiresAt}`,
    });
  } catch (error) {
    findings.push({
      check: `git:${broker.id}`,
      severity: "problem",
      message: `cannot mint a read token for ${repo}: ${(error as Error).message}`,
    });
  }
  if (broker.assertProtected) {
    try {
      await withTimeout(broker.assertProtected(repo), "checking branch protection");
      findings.push({
        check: "branch-protection",
        severity: "ok",
        message: `${repo} limits writes to selfbuilding/* refs`,
      });
    } catch (error) {
      // Missing branch protection fails doctor rather than degrading (spec §9.9).
      findings.push({ check: "branch-protection", severity: "problem", message: (error as Error).message });
    }
  }
  return findings;
}

/** Lists one sandbox to prove the provider's credentials and endpoint work. Reads nothing else. */
async function probeProvider(provider: SandboxProvider, deployment: string): Promise<Finding> {
  const check = `sandbox:${provider.id}`;
  try {
    await withTimeout(
      (async () => {
        for await (const _ of provider.list({ deployment })) break;
      })(),
      "listing sandboxes",
    );
    return { check, severity: "ok", message: `reachable (${provider.stability})` };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const why =
      code === "sandbox_auth" ? "credentials refused" : code === "sandbox_unavailable" ? "unreachable" : "failed";
    return { check, severity: "problem", message: `${why}: ${(error as Error).message}` };
  }
}

/** Resolves one secret and returns why it is unusable, or null. The value never leaves this function. */
async function resolveSecret(secret: Secret): Promise<{ message: string; variable?: string } | null> {
  try {
    const value = typeof secret === "function" ? await withTimeout(secret(), "resolving a secret") : secret;
    return value.length > 0 ? null : { message: "resolves to an empty value" };
  } catch (error) {
    const variable = (error as { secret?: unknown }).secret;
    if (typeof variable === "string") return { message: `${variable} is not set`, variable };
    return { message: (error as Error).message };
  }
}

async function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS / 1000}s ${what}`)),
      PROBE_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
