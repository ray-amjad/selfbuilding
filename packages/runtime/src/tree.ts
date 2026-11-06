import fs from "node:fs";

// Finding and killing a harness process tree. A process-group kill misses children that called setsid (dev servers,
// MCP servers), so on Linux the tree is also found through /proc: by parent links, and by an env marker every
// process the harness starts inherits.

export const TREE_MARKER_ENV = "SELFBUILDING_TREE";

interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
}

function readStat(pid: number): ProcInfo | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may contain spaces and parentheses; fields resume after the last ")".
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, ppid: Number(rest[1]), pgid: Number(rest[2]), sid: Number(rest[3]) };
  } catch {
    return undefined;
  }
}

function hasMarker(pid: number, marker: string): boolean {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`${TREE_MARKER_ENV}=${marker}`);
  } catch {
    return false;
  }
}

function listPids(): number[] | undefined {
  try {
    return fs
      .readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch {
    return undefined;
  }
}

export interface TreeSelector {
  /** The harness process group (its leader's pid). */
  pgid?: number;
  /** Value of SELFBUILDING_TREE given to the harness. */
  marker?: string;
}

/** Live pids in the tree, excluding this process. Without /proc only the group leader can be seen. */
export function findTree(selector: TreeSelector): number[] {
  const pids = listPids();
  const found = new Set<number>();
  if (pids === undefined) {
    if (selector.pgid !== undefined && groupAlive(selector.pgid)) found.add(selector.pgid);
    return [...found];
  }
  const infos = pids.map(readStat).filter((info): info is ProcInfo => info !== undefined);
  for (const info of infos) {
    if (info.pid === process.pid) continue;
    if (selector.pgid !== undefined && (info.pgid === selector.pgid || info.sid === selector.pgid)) found.add(info.pid);
    else if (selector.marker !== undefined && hasMarker(info.pid, selector.marker)) found.add(info.pid);
  }
  // Descendants of anything found, by parent links.
  let grew = true;
  while (grew) {
    grew = false;
    for (const info of infos) {
      if (!found.has(info.pid) && found.has(info.ppid) && info.pid !== process.pid) {
        found.add(info.pid);
        grew = true;
      }
    }
  }
  return [...found].filter((pid) => isLive(pid));
}

function isLive(pid: number): boolean {
  try {
    const state = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const field = state.slice(state.lastIndexOf(")") + 2).split(" ")[0];
    return field !== "Z" && field !== "X";
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Signals the process group. Returns false when the group is already gone. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Sends `signal` to every process in the tree. Returns the pids signalled. */
export function signalTree(selector: TreeSelector, signal: NodeJS.Signals): number[] {
  const pids = findTree(selector);
  if (selector.pgid !== undefined) signalGroup(selector.pgid, signal);
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // gone already
    }
  }
  return pids;
}
