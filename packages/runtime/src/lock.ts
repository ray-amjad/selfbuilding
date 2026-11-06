import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The turn lock (spec §6.14) is a flock on /run/selfbuilding/call.lock, because the reaper probes it with
// `flock -n <lock> true`. Node has no flock(2), so a tiny `flock` child holds it with its stdin piped from this
// process: when this process dies for any reason the pipe closes, the child exits and the lock is released.

let flockBinary: string | null | undefined;

function findFlock(): string | null {
  if (flockBinary !== undefined) return flockBinary;
  flockBinary = null;
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(":")) {
    const candidate = path.join(dir || ".", "flock");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      flockBinary = candidate;
      break;
    } catch {
      // keep looking
    }
  }
  return flockBinary;
}

export interface TurnLock {
  readonly mode: "flock" | "pidfile";
  /** Resolves once the lock is actually free, so a probe right after never sees it held. */
  release(): Promise<void>;
}

// A probe takes the lock for a few milliseconds, so taking it must tolerate a short wait rather than
// mistaking a concurrent probe for a live supervisor.
const ACQUIRE_WAIT_SECONDS = "2";
const PROBE_WAIT_SECONDS = "0.25";

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidfilePath(lockFile: string): string {
  return `${lockFile}.pid`;
}

/** Takes the lock, waiting briefly. Returns null when another process holds it. */
export async function acquireTurnLock(lockFile: string): Promise<TurnLock | null> {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const flock = findFlock();
  if (flock === null) return acquirePidLock(lockFile);
  fs.closeSync(fs.openSync(lockFile, "a"));
  const child: ChildProcess = spawn(
    flock,
    ["-w", ACQUIRE_WAIT_SECONDS, lockFile, "-c", "echo locked; exec cat >/dev/null"],
    {
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const acquired = await new Promise<boolean>((resolve) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("locked")) resolve(true);
    });
    child.on("exit", () => resolve(false));
    child.on("error", () => resolve(false));
  });
  if (!acquired) return null;
  child.stdout?.removeAllListeners("data");
  child.stdout?.resume();
  // The holder must not keep the event loop alive on its own.
  child.unref();
  (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
  (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  let released: Promise<void> | undefined;
  return {
    mode: "flock",
    release() {
      if (released) return released;
      child.stdin?.end();
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      // Referenced again so awaiting the release keeps the process alive until the child is gone.
      child.ref();
      let timer: NodeJS.Timeout | undefined;
      const cap = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      });
      released = Promise.race([exited, cap]).finally(() => clearTimeout(timer));
      return released;
    },
  };
}

function acquirePidLock(lockFile: string): TurnLock | null {
  const file = pidfilePath(lockFile);
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      let released = false;
      return {
        mode: "pidfile",
        async release() {
          if (released) return;
          released = true;
          try {
            if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.rmSync(file, { force: true });
          } catch {
            // already gone
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(fs.readFileSync(file, "utf8").trim());
      if (pidAlive(holder)) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

/** FREE or BUSY, as the reaper would see it. Anything unclear is BUSY: a wrong FREE loses a turn. */
export function probeTurnLock(lockFile: string): "FREE" | "BUSY" {
  const flock = findFlock();
  if (flock === null) {
    try {
      const holder = Number(fs.readFileSync(pidfilePath(lockFile), "utf8").trim());
      return pidAlive(holder) ? "BUSY" : "FREE";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "FREE" : "BUSY";
    }
  }
  if (!fs.existsSync(lockFile)) return "FREE";
  const probe = spawnSync(flock, ["-w", PROBE_WAIT_SECONDS, lockFile, "-c", "echo FREE"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return probe.status === 0 && probe.stdout.trim() === "FREE" ? "FREE" : "BUSY";
}

export { pidAlive };
