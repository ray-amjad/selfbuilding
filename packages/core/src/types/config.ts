import type { SkillPack, SkillSource } from "@selfbuilding/skills";
import type { ArtifactStore } from "./artifacts.js";
import type { HitlOptions, NotifyOptions } from "./ask.js";
import type { Budget } from "./budget.js";
import type { DeploymentId, Duration, Effort } from "./common.js";
import type { EventSink } from "./events.js";
import type { Harness, HarnessId } from "./harness.js";
import type { JournalStore } from "./orchestration.js";
import type { SandboxProvider } from "./sandbox.js";
import type { EgressPolicy, GitCredentialBroker, Secret, SecretSource } from "./security.js";
import type { SizeTable } from "./sizes.js";
import type { ScriptCaps, StartWorkflowPolicy } from "./workflow.js";

/** Advanced timeouts (spec §6.11). The call-level limit is the per-call `timeout` option. */
export interface Timeouts {
  boot: Duration;
  setup: Duration;
  start: Duration;
  idle: Duration;
  postSubmitGrace: Duration;
  cancelGrace: Duration;
}

/** The one config type (spec §1.11). `defineConfig` is the only builder. */
export interface SelfbuildingConfig {
  deployment?: DeploymentId;
  harness?: Harness;
  sandbox?: SandboxProvider;
  effort?: Effort;
  journal?: JournalStore;
  artifacts?: ArtifactStore;
  budget?: Budget;
  concurrency?: { sandboxes?: number; createsPerMinute?: number };
  timeouts?: Partial<Timeouts>;
  skills?: { sources?: SkillSource[]; packs?: SkillPack[]; disable?: string[]; defaults?: boolean; strict?: boolean };
  harnessHold?: Partial<Record<HarnessId, string>>;
  secrets?: SecretSource;
  git?: GitCredentialBroker;
  egress?: EgressPolicy;
  hitl?: HitlOptions;
  notify?: NotifyOptions;
  events?: EventSink[];
  strict?: boolean;
  debug?: { rawEvents?: boolean };
  controlPlane?: { url: string; token: Secret };
  /** Extra named sizes on top of small, medium and large (demo-path §1.1). */
  sizes?: SizeTable;
  /** Guards on runs that agents launch with start_workflow (demo-path §9.4). */
  startWorkflow?: StartWorkflowPolicy;
  /** Deployment-wide caps for `runScript` (demo-path §8.3). */
  scripts?: ScriptCaps;
}

/** Every key of SelfbuildingConfig; the config-table test compares it with spec §1.11. */
export const CONFIG_KEYS: readonly (keyof SelfbuildingConfig)[] = [
  "deployment",
  "harness",
  "sandbox",
  "effort",
  "journal",
  "artifacts",
  "budget",
  "concurrency",
  "timeouts",
  "skills",
  "harnessHold",
  "secrets",
  "git",
  "egress",
  "hitl",
  "notify",
  "events",
  "strict",
  "debug",
  "controlPlane",
  "sizes",
  "startWorkflow",
  "scripts",
];
