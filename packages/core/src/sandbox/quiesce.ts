import type { AgentRunContext } from "../agent/context.js";
import { SandboxNotQuiescentError } from "../errors/classes.js";
import type { BoxMarker } from "../types/runtime.js";
import { SANDBOX_PATHS } from "../types/runtime.js";
import type { ProviderSandbox, SandboxProvider } from "../types/sandbox.js";
import { probeTurnLock, quiesceVerb, readText, shq } from "./runtime-client.js";

async function runtimeInstalled(box: ProviderSandbox): Promise<boolean> {
  return (await readText(box, SANDBOX_PATHS.runtimeVersion)) !== null;
}

/**
 * Brings a box to a clean boundary before a snapshot or fork (spec §5.8 "Quiescence"). The caller already holds
 * the handle's mutation lock. Each check passes or throws SandboxNotQuiescentError; nothing reaches the provider
 * until all of them pass.
 */
export async function quiesce(
  ctx: AgentRunContext,
  provider: SandboxProvider,
  box: ProviderSandbox,
  credentialFiles: readonly string[] = [],
): Promise<void> {
  const lock = await probeTurnLock(box);
  if (lock === "BUSY") throw new SandboxNotQuiescentError({ reason: "busy" });
  if (lock === "UNKNOWN")
    throw new SandboxNotQuiescentError({ reason: "unknown", detail: "the turn-lock probe failed" });

  const unacked = await box.exec(
    `for f in ${SANDBOX_PATHS.calls}/*/*/outcome.json; do [ -e "$f" ] || continue; d=$(dirname "$f"); [ -e "$d/outcome.ack" ] || echo "$f"; done`,
    { user: "root", timeoutMs: 30_000, idempotent: true },
  );
  if (unacked.stdoutTail.trim()) {
    throw new SandboxNotQuiescentError({ reason: "unacked-outcome", detail: unacked.stdoutTail.trim().split("\n")[0] });
  }

  if (await runtimeInstalled(box)) {
    const verdict = await quiesceVerb({ box, provider, runId: ctx.runId });
    if (!verdict.quiescent) throw new SandboxNotQuiescentError({ reason: "process-survived", detail: verdict.reason });
  }

  const lockFile = `${SANDBOX_PATHS.workdir}/.git/index.lock`;
  const flushed = await box.exec(`sync 2>/dev/null; [ -e ${shq(lockFile)} ] && echo LOCKED || true`, {
    user: "root",
    timeoutMs: 30_000,
  });
  if (flushed.stdoutTail.includes("LOCKED")) {
    throw new SandboxNotQuiescentError({ reason: "git-index-lock", detail: lockFile });
  }

  // Credentials never enter a snapshot (spec §5.8 step 6, §9.3): they are delivered again after every open. That
  // covers files a harness keeps in its home (a login file, MCP env files), not only the secrets directory.
  const extra = credentialFiles.map(shq).join(" ");
  await box.exec(
    `rm -rf ${shq(SANDBOX_PATHS.secrets)}; mkdir -p ${shq(SANDBOX_PATHS.secrets)}${extra ? `; rm -f ${extra}` : ""}`,
    {
      user: "root",
      timeoutMs: 30_000,
    },
  );
}

/**
 * Resets a fork child on its first open (spec §5.8): kill leftover agent processes, wipe /run/selfbuilding, empty
 * the parent's call state so no outcome or callback is sent twice, and write the child's own box marker.
 */
export async function resetForkChild(
  ctx: AgentRunContext,
  provider: SandboxProvider,
  box: ProviderSandbox,
  marker: { boxId: string; branch?: string },
): Promise<void> {
  if (await runtimeInstalled(box)) {
    await quiesceVerb({ box, provider, runId: ctx.runId }).catch(() => undefined);
  }
  await box.exec(
    [
      `rm -rf ${shq(SANDBOX_PATHS.run)}`,
      `mkdir -p ${shq(SANDBOX_PATHS.run)} ${shq(SANDBOX_PATHS.secrets)}`,
      `rm -rf ${shq(SANDBOX_PATHS.calls)} ${shq(SANDBOX_PATHS.launches)}`,
      `mkdir -p ${shq(SANDBOX_PATHS.calls)} ${shq(SANDBOX_PATHS.launches)}`,
      // The child works on its own branch, starting from exactly what the parent had checked out. Without it, the
      // runtime would find no such branch and start the child from the base, dropping the parent's commits.
      ...(marker.branch
        ? [
            `if [ -d ${shq(`${SANDBOX_PATHS.workdir}/.git`)} ]; then git -C ${shq(SANDBOX_PATHS.workdir)} -c safe.directory=* -c core.hooksPath=/dev/null checkout -q -B ${shq(marker.branch)}; fi`,
          ]
        : []),
    ].join("; "),
    { user: "root", timeoutMs: 60_000 },
  );
  await writeBoxMarker(ctx, box, { boxId: marker.boxId, version: 0 });
}

export async function writeBoxMarker(
  ctx: AgentRunContext,
  box: ProviderSandbox,
  o: { boxId: string; version: number },
): Promise<void> {
  const marker: BoxMarker = {
    runId: ctx.runId,
    boxId: o.boxId,
    version: o.version,
    generation: box.ref.id,
    sandboxId: box.ref.id,
  };
  await box.writeFiles([{ path: SANDBOX_PATHS.boxMarker, data: JSON.stringify(marker), mode: 0o644, owner: "root" }]);
}
