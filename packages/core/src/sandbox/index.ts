import { currentAgentContext, standaloneContext } from "../agent/context.js";
import type { SandboxHandle, SandboxOptions } from "../types/sandbox.js";
import { createHandle } from "./handle.js";

export { branchName, checkpointRef, SELFBUILDING_LABELS, sandboxName } from "./names.js";

/**
 * Opens a shared sandbox handle. Synchronous and lazy: the box is created on first live use (spec §3.11).
 * Outside a run, the handle belongs to a standalone one-step run of its own.
 */
export function sandbox(spec: SandboxOptions = {}): SandboxHandle {
  return createHandle(currentAgentContext() ?? standaloneContext(), spec);
}
