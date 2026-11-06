import type { ContractSpec, McpServerSpec } from "@selfbuilding/core";
import {
  findingsInDiffCheck,
  implementationNotesCheck,
  noTestRemovalCheck,
  verdictConsistentCheck,
  verifyEvidenceCheck,
} from "./checks.js";
import { findFlowsConsistentCheck } from "./flows/checks.js";
import { FindFlowsInput, FindFlowsResult } from "./flows/schemas.js";
import {
  CodeReviewInput,
  CodeReviewResult,
  ImplementSpecInput,
  ImplementSpecResult,
  VERIFY_EVIDENCE_DIR,
  VerifyInput,
  VerifyResult,
} from "./schemas.js";

// The contracts of the built-in agents. They are plain ContractSpec values, so this module is safe to import
// anywhere (each skill folder's selfbuilding.ts sidecar re-exports one). Harness defaults are attached in
// index.ts, where the harness packages are loaded.

/** Read-only review of a target (spec §2.10.1). */
export const codeReviewContract = {
  input: CodeReviewInput,
  output: CodeReviewResult,
  workspace: { repo: "required", target: "review" },
  artifacts: { branch: "forbidden", pr: "forbidden" },
  done: [findingsInDiffCheck, verdictConsistentCheck],
} satisfies ContractSpec<CodeReviewInput, CodeReviewResult>;

/** Writes code on a branch; the host pushes it and opens the pull request (spec §2.10.1). */
export const implementSpecContract = {
  input: ImplementSpecInput,
  output: ImplementSpecResult,
  workspace: { repo: "required", target: "none" },
  testCommand: (input: ImplementSpecInput) => input.testCommand,
  artifacts: { branch: "required", pr: "optional" },
  done: [noTestRemovalCheck, implementationNotesCheck],
} satisfies ContractSpec<ImplementSpecInput, ImplementSpecResult>;

/** Where the Codex image installs Chromium (demo-path §3). */
export const VERIFY_BROWSERS_PATH = "/opt/selfbuilding/browsers";

/**
 * The `browser` MCP server Verify's verifier drives the app through: headless Chromium from the Codex image, with
 * screenshots written under the evidence directory (demo-path §3). It matches `BROWSER_MCP_SERVER` from
 * `@selfbuilding/images`, which this package does not depend on, plus the browsers path in `env`: Codex starts
 * MCP servers with a short allow-list of variables, so the image-wide `PLAYWRIGHT_BROWSERS_PATH` never reaches it.
 */
export const VERIFY_BROWSER_SERVER: Readonly<Extract<McpServerSpec, { type: "stdio" }>> = {
  name: "browser",
  type: "stdio",
  command: "/usr/local/bin/playwright-mcp",
  args: ["--headless", "--isolated", "--browser", "chromium", "--no-sandbox", "--output-dir", VERIFY_EVIDENCE_DIR],
  env: { PLAYWRIGHT_BROWSERS_PATH: VERIFY_BROWSERS_PATH },
};

/** Verify's size on a fresh box: a dev server and Chromium side by side need more than `small` (demo-path §4.2). */
export const VERIFY_DEFAULT_SIZE = "medium";

/**
 * Boots the app and drives it; leaves the repository untouched, so it can run on a fork of the build box. The size
 * applies only to a fresh box: on a fork or a shared handle the box's own size wins.
 */
export const verifyContract = {
  input: VerifyInput,
  output: VerifyResult,
  workspace: { repo: "required", target: "none" },
  artifacts: { branch: "forbidden", pr: "forbidden" },
  done: [verifyEvidenceCheck],
  defaults: {
    timeout: "1h",
    size: VERIFY_DEFAULT_SIZE,
    mcpServers: [VERIFY_BROWSER_SERVER],
  },
} satisfies ContractSpec<VerifyInput, VerifyResult>;

/** Reads a diff and names every user flow it adds or changes; read-only (demo-path §4.3). */
export const findFlowsContract = {
  input: FindFlowsInput,
  output: FindFlowsResult,
  workspace: { repo: "required", target: "review" },
  artifacts: { branch: "forbidden", pr: "forbidden" },
  done: [findFlowsConsistentCheck],
} satisfies ContractSpec<FindFlowsInput, FindFlowsResult>;
