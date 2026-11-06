// @selfbuilding/sandbox-conformance: the provider conformance and placement suites (spec §5.4, §3.11, §10.3).

export { describePlacement, transferRepo } from "./placement-suite.js";
export { describeSandboxProvider } from "./provider-suite.js";
export {
  type ConformanceFaultKind,
  type ConformanceFaults,
  type ConformanceOptions,
  conformanceSandboxName,
  DEFAULT_IMAGE,
  limitConcurrency,
} from "./support.js";
