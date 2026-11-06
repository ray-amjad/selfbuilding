import os from "node:os";
import type { fileArtifacts, fileJournal, reap, run, setRuntimeBundles } from "@selfbuilding/core";

/** The slice of @selfbuilding/core the commands call. Tests pass their own. */
export interface CoreApi {
  run: typeof run;
  reap: typeof reap;
  fileJournal: typeof fileJournal;
  fileArtifacts: typeof fileArtifacts;
  /** Optional so an older project core still loads. */
  setRuntimeBundles?: typeof setRuntimeBundles;
}

export interface Writable {
  write(chunk: string): unknown;
}

/** Asks one question with a fixed set of answers; returns one of `choices`. */
export type Prompt = (question: string, choices: readonly string[]) => Promise<string>;

/** Everything a command touches outside its own arguments, so each command can run against a temp project. */
export interface CliContext {
  cwd: string;
  /** The environment the config is evaluated against. `--env-file` writes into it. */
  env: Record<string, string | undefined>;
  stdin: NodeJS.ReadableStream;
  stdout: Writable;
  stderr: Writable;
  /** Whether a human can answer questions on stdin. */
  isTTY: boolean;
  prompt: Prompt;
  /** Fixed core for tests; otherwise the project's own copy of @selfbuilding/core, falling back to ours. */
  core?: CoreApi;
  /** Aborted on SIGINT. */
  interrupt: AbortSignal;
  /** How often the long-running commands look at files on disk. */
  pollMs: number;
  /** Who `answer` records as the human. */
  user: { id: string; name: string };
}

export function defaultUser(): { id: string; name: string } {
  try {
    const name = os.userInfo().username;
    return { id: name, name };
  } catch {
    return { id: "unknown", name: "unknown" };
  }
}
