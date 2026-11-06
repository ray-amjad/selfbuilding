import fs from "node:fs";
import path from "node:path";
import { ATTEMPT_FILES, RUNTIME_ENV, RUNTIME_EXIT, SANDBOX_PATHS } from "@selfbuilding/core";

// Installed before any other module code runs (spec §6.15). The reporter cannot throw: it writes one FATAL line to
// runtime.log, then tries to write a failed outcome for `supervise`, then exits.

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function installCrashHandlers(argv: string[]): void {
  const report = (kind: string, error: unknown) => {
    try {
      const root = (process.env[RUNTIME_ENV.fsRoot] ?? "").replace(/\/+$/, "");
      const stepKey = flag(argv, "call");
      const attempt = flag(argv, "attempt");
      const launchId = flag(argv, "launch");
      const text = `${new Date().toISOString()} FATAL [${process.pid}] ${kind}: ${String(
        (error as Error)?.stack ?? error,
      )
        .replace(/\b(Bearer\s+)\S+/g, "$1[REDACTED]")
        .slice(0, 8000)}\n`;
      const safe = (v: string | undefined) => v !== undefined && /^[A-Za-z0-9._@:+=-]{1,200}$/.test(v) && v !== "..";
      if (safe(stepKey) && safe(attempt)) {
        const dir = path.join(root, SANDBOX_PATHS.calls, stepKey as string, attempt as string);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, ATTEMPT_FILES.runtimeLog), text);
        if (argv[0] === "supervise" && safe(launchId)) {
          const spec = JSON.parse(fs.readFileSync(path.join(dir, ATTEMPT_FILES.spec), "utf8")) as {
            callId?: string;
            harnessVersion?: string;
          };
          const outcome = {
            callId: spec.callId ?? "",
            attempt: Number(attempt),
            launchId,
            status: "failed",
            reason: "harness_error",
            git: { pushed: false },
            harnessVersion: spec.harnessVersion ?? "",
            message: `The runtime crashed (${kind}). See runtime.log.`,
          };
          fs.writeFileSync(path.join(dir, ATTEMPT_FILES.outcome), `${JSON.stringify(outcome, null, 2)}\n`, {
            flag: "wx",
          });
        }
      } else process.stderr.write(text);
    } catch {
      // The reporter must never throw.
    }
    process.exit(RUNTIME_EXIT.transient);
  };
  process.on("uncaughtException", (error) => report("uncaughtException", error));
  process.on("unhandledRejection", (error) => report("unhandledRejection", error));
}
