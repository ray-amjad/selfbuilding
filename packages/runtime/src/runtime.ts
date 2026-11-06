// selfbuilding-runtime: supervisor, bridge and tool socket in one process (spec §6.3).
// Verbs and JSON shapes are fixed by docs/BUILD-MAP.md §3 and the types in @selfbuilding/core.
import { installCrashHandlers } from "./crash.js";

installCrashHandlers(process.argv.slice(2));

const { Layout } = await import("./paths.js");
const { readStdin, runVerb } = await import("./verbs.js");
const { fileURLToPath } = await import("node:url");

const result = await runVerb(new Layout(), process.argv.slice(2), {
  stdin: readStdin,
  bundlePath: fileURLToPath(import.meta.url),
});
if (result.output !== undefined) process.stdout.write(`${JSON.stringify(result.output)}\n`);
process.exitCode = result.exitCode;
// supervise may leave a wake retry or the lock holder's pipe behind; the outcome is already on disk.
if (process.argv[2] === "supervise") process.exit(result.exitCode);
