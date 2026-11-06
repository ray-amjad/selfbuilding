import type { ArtifactStore } from "../types/artifacts.js";
import type { JournalStore } from "../types/orchestration.js";
import { createFileArtifacts } from "./file-artifacts.js";
import { createFileJournal } from "./file-journal.js";

// Both stores load node:fs lazily inside the call so the core main entry statically imports only
// node:async_hooks (spec §10.1).

export { JOURNAL_FORMAT } from "./file-journal.js";
export { memoryJournal } from "./memory.js";
export { sqliteJournal } from "./sqlite-journal.js";

/** A file-backed journal with a fenced lease and an ask store in the same directory (spec §3.9, §7.5.4). */
export function fileJournal(dir: string): JournalStore {
  return createFileJournal(dir);
}

/** A content-addressed file artifact store (spec §2.8, §7.10). */
export function fileArtifacts(dir: string): ArtifactStore {
  return createFileArtifacts(dir);
}
