import type { Duration } from "./common.js";
import type { HarnessId } from "./harness.js";
import type { Checkpoint } from "./sandbox.js";

// The one declaration of AgentResult, Artifacts, Usage and ArtifactRef (spec §2.8.1).

/** A stored payload. Serialises without `text()`; rehydrated through the run's ArtifactStore on read. */
export interface ArtifactRef {
  /** file://, s3:// or artifact:// in the configured ArtifactStore. */
  uri: string;
  bytes: number;
  sha256: string;
  contentType: string;
  text(): Promise<string>;
}

/** The JSON form of an ArtifactRef, as stored in journals, outcomes and host step values. */
export type ArtifactRefJson = Omit<ArtifactRef, "text">;

export interface Usage {
  /** null when unpriced. */
  usd: number | null;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  wallClockMs: number;
  sandboxMs: number;
  /** sandboxMs weighted by each box's vCPU count, when the size is known (demo-path §1.6). */
  sandboxVcpuMs?: number;
}

export interface BranchArtifact {
  name: string;
  base: string;
  baseSha: string;
  headSha: string;
  pushed: boolean;
  autoCommitted: boolean;
}

export interface Artifacts {
  branch?: BranchArtifact;
  /** Commits ahead of base. */
  commits?: { sha: string; message: string }[];
  pr?: { url: string; number: number; draft: boolean };
  /** The full patch is stored, not inlined. */
  diff?: { stat: { files: number; insertions: number; deletions: number }; ref: ArtifactRef };
  /** Normalised JSONL events plus the native session file, redacted. */
  transcript: ArtifactRef;
  files: { path: string; ref: ArtifactRef }[];
  /** Runtime log, including setup and hook output. */
  logs: ArtifactRef;
  /** State of a shared sandbox after the call (spec §3.11). */
  checkpoint?: Checkpoint;
}

/** The serialisable artifacts carried in host step values (spec §7.4). */
export type AgentArtifacts = Artifacts;

export interface CheckOutcome {
  id: string;
  ok: boolean;
  /** false when a claim (e.g. `tests`) was recorded but not run. */
  verified: boolean;
  /** Protected paths the contract allowed the agent to change (spec §2.7.4). */
  protectedChanged?: string[];
}

export interface AgentResult<O> {
  /** Validated against the output schema. */
  result: O;
  runId: string;
  /** Stable across replays (spec §3.2). */
  callPath: string;
  stepKey: string;
  attempts: { submits: number; resumes: number; doneRetries: number };
  /** true when the value came from the journal. */
  replayed: boolean;
  usage: Usage;
  artifacts: Artifacts;
  checks: CheckOutcome[];
  /** Whether the result file was isolation-checked (spec §2.6.4). */
  integrity: "isolated" | "same-user";
  harness: { id: HarnessId | (string & {}); version: string; model?: string; sessionId?: string };
  skill: { name: string; hash: string };
  /** Set only with `onDoneFailure: "return"` (spec §2.7.2). */
  doneFailed?: { id: string; output: string };
}

/** Stores large payloads by reference (spec §2.8, §7.10). `fileArtifacts()` is the plain Node default. */
export interface ArtifactStore {
  /** Content-addressed: a second put of the same bytes is a no-op and returns the same ref. */
  put(key: string, body: Uint8Array | string, opts?: { contentType?: string }): Promise<ArtifactRef>;
  /** Reads a payload by uri. */
  read(uri: string): Promise<Uint8Array>;
  /** Rehydrates a stored ref so `text()` works again. */
  hydrate(ref: ArtifactRefJson): ArtifactRef;
  /**
   * A time-limited https URL that reads one stored payload (demo-path §7.3). Only stores with a web endpoint
   * (S3, R2) have it. Never journal the URL: it expires.
   */
  signedUrl?(uri: string, opts?: SignedUrlOptions): Promise<string>;
}

export interface SignedUrlOptions {
  /** Default "1d". At most "7d" (the SigV4 maximum); longer throws ConfigError. */
  expiresIn?: Duration;
  /** Sets Content-Disposition: attachment with this file name. Default: inline. */
  downloadAs?: string;
}
