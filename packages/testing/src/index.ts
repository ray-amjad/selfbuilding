// @selfbuilding/testing: the offline test kit (spec §10.3).

export {
  EmulatorRequestError,
  emulatorPort,
  vitestWorkerId,
} from "./emulate/common.js";
export {
  type GitHubEmulator,
  type GitHubSeedInfo,
  type GitHubSeedOptions,
  githubSeed,
  startGitHubEmulator,
} from "./emulate/github.js";
export {
  commitToBranch,
  createLocalRemote,
  isolatedEnv,
  type LocalRemote,
  mirrorRefs,
  openPlaygroundPr,
  PLAYGROUND_FILES,
  type Playground,
  type PlaygroundPr,
  seedPlayground,
} from "./emulate/playground.js";
export {
  type SlackEmulator,
  type SlackMessage,
  type SlackSeedInfo,
  type SlackSeedOptions,
  slackSeed,
  startSlackEmulator,
} from "./emulate/slack.js";
export { type GoldenIdKind, type GoldenOptions, normalizeEvents, toGoldenJsonl } from "./golden.js";
export {
  canonicalPaths,
  SCRIPTED_HARNESS_VERSION,
  type ScriptCall,
  type ScriptedHarnessOptions,
  type ScriptSource,
  scriptCallKey,
  scriptedHarness,
  scriptedPlayerSource,
} from "./scripted/harness.js";
export { claudeStreamParser, codexStreamParser } from "./scripted/parser.js";
export { type ScriptStep, scripted } from "./scripted/steps.js";
export { type HarnessTurn, type HarnessTurnOptions, openTestBox, runHarnessTurn } from "./scripted/turn.js";
export type { FaultController, FaultKind, FaultOp } from "./tmpdir/faults.js";
export {
  type GhostKind,
  type TmpdirProvider,
  type TmpdirProviderOptions,
  tmpdirProvider,
} from "./tmpdir/provider.js";
