// ns-reap: kills a harness process tree on demand (spec §6.3). This build ships it as a small Node script; it finds
// the tree by process group, by parent links and by the SELFBUILDING_TREE marker, which catches children that called
// setsid. Subreaping (PR_SET_CHILD_SUBREAPER) needs a native helper and is not done here.
//
//   ns-reap kill  [--pgid <n>] [--marker <m>] [--signal SIGKILL]   → {"signalled":[pids]}
//   ns-reap list  [--pgid <n>] [--marker <m>]                       → {"pids":[pids]}
import { findTree, signalTree, type TreeSelector } from "./tree.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const verb = process.argv[2];
const pgid = flag("pgid");
const marker = flag("marker");
const selector: TreeSelector = {
  ...(pgid !== undefined && /^\d+$/.test(pgid) && Number(pgid) > 1 ? { pgid: Number(pgid) } : {}),
  ...(marker ? { marker } : {}),
};
if (selector.pgid === undefined && selector.marker === undefined) {
  process.stderr.write("ns-reap: give --pgid or --marker\n");
  process.exit(78);
}
if (verb === "list") {
  process.stdout.write(`${JSON.stringify({ pids: findTree(selector) })}\n`);
} else if (verb === "kill") {
  const signal = (flag("signal") ?? "SIGKILL") as NodeJS.Signals;
  if (!/^SIG[A-Z0-9]+$/.test(signal)) {
    process.stderr.write(`ns-reap: bad signal ${signal}\n`);
    process.exit(78);
  }
  process.stdout.write(`${JSON.stringify({ signalled: signalTree(selector, signal) })}\n`);
} else {
  process.stderr.write("ns-reap: usage: ns-reap kill|list [--pgid <n>] [--marker <m>] [--signal <SIG>]\n");
  process.exit(78);
}
