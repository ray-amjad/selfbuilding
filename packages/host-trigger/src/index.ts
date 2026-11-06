// @selfbuilding/host-trigger: the Trigger.dev v4 host (spec §7.5.1, §7.12.2).

export { createTriggerAskResolver, type TriggerAskResolver } from "./asks.js";
export type { AgentTaskPayload } from "./child.js";
export { type KillReport, killRunSandboxes } from "./control.js";
export { createTriggerHost, type RunFactoryFn, type TriggerHost, type TriggerHostOptions } from "./host.js";
export { type RunRecord, resultStoreAsks, resultStoreJournal } from "./journal.js";
export {
  AGENT_TASK_ID,
  FACTORY_TASK_ID,
  hostKeyOf,
  launchIdOf,
  REAPER_CRON,
  REAPER_TASK_ID,
  wakeTokenKey,
} from "./keys.js";
export {
  AGENT_LAUNCHED_TAG,
  type TriggerWorkflowLauncherOptions,
  triggerWorkflowLauncher,
} from "./launcher.js";
export {
  createLocalTrigger,
  type LocalRunInfo,
  type LocalTokenInfo,
  type LocalTrigger,
  type LocalTriggerOptions,
} from "./local.js";
export type { FactoryRunLimits, FactoryTaskOutput, FactoryTaskPayload } from "./parent.js";
export { realTriggerSdk } from "./real-sdk.js";
export type {
  TriggerRunContext,
  TriggerRunStatus,
  TriggerRunView,
  TriggerScheduleDefinition,
  TriggerSdk,
  TriggerTaskDefinition,
  WaitResult,
  Wake,
} from "./sdk.js";
export { fileResultStore, memoryResultStore } from "./store.js";
