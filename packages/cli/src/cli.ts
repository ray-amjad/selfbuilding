#!/usr/bin/env node
// The selfbuilding CLI (spec §1.12).
import { EXIT, main } from "./main.js";

const interrupt = new AbortController();
process.on("SIGINT", () => {
  // The first Ctrl-C lets the run stop its agents and save their work; a second one leaves at once.
  if (interrupt.signal.aborted) process.exit(EXIT.interrupted);
  process.stderr.write("\nStopping; press Ctrl-C again to quit now.\n");
  interrupt.abort();
});

main(process.argv.slice(2), { interrupt: interrupt.signal }).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT.failed);
  },
);
