import { NonDeterminismError } from "../errors/classes.js";
import { maybeFrame } from "./context.js";

// Strict mode (spec §3.8): while any strict run is active, the non-deterministic globals are replaced with
// versions that throw NonDeterminismError when called from factory code. Calls from outside a run, from
// step() bodies and from Selfbuilding internals reach the originals.

const REPLACEMENT: Record<string, string> = {
  "Date.now()": "now()",
  "new Date()": "now()",
  "Math.random()": "random()",
  "crypto.randomUUID()": "uuid()",
};

let installed = 0;
let restore: (() => void) | null = null;

function check(what: keyof typeof REPLACEMENT): void {
  const frame = maybeFrame();
  if (!frame || frame.internal || !frame.run.strict) return;
  throw new NonDeterminismError(
    `${what} was called in factory code at ${frame.scope.path || "the factory root"}. Use ${REPLACEMENT[what]} from @selfbuilding/core, or move the work into step().`,
    { runId: frame.run.runId, callPath: frame.scope.path || "run" },
  );
}

export function installStrict(): () => void {
  if (installed++ === 0) restore = patchGlobals();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--installed === 0) {
      restore?.();
      restore = null;
    }
  };
}

function patchGlobals(): () => void {
  const g = globalThis as { Date: DateConstructor; Math: Math; crypto?: { randomUUID?: () => string } };
  const OriginalDate = g.Date;
  const originalNow = OriginalDate.now;
  const originalRandom = g.Math.random;
  const cryptoObj = g.crypto;
  const ownUuid = cryptoObj ? Object.getOwnPropertyDescriptor(cryptoObj, "randomUUID") : undefined;
  const originalUuid = cryptoObj?.randomUUID;

  function StrictDate(this: unknown, ...args: unknown[]) {
    if (!new.target) {
      check("new Date()");
      return OriginalDate();
    }
    if (args.length === 0) check("new Date()");
    return Reflect.construct(OriginalDate, args, new.target);
  }
  Object.setPrototypeOf(StrictDate, OriginalDate);
  StrictDate.prototype = OriginalDate.prototype;
  (StrictDate as unknown as DateConstructor).now = () => {
    check("Date.now()");
    return originalNow.call(OriginalDate);
  };

  g.Date = StrictDate as unknown as DateConstructor;
  g.Math.random = () => {
    check("Math.random()");
    return originalRandom.call(Math);
  };
  if (cryptoObj && originalUuid) {
    Object.defineProperty(cryptoObj, "randomUUID", {
      configurable: true,
      writable: true,
      value: () => {
        check("crypto.randomUUID()");
        return originalUuid.call(cryptoObj);
      },
    });
  }

  return () => {
    g.Date = OriginalDate;
    g.Math.random = originalRandom;
    if (cryptoObj) {
      if (ownUuid) Object.defineProperty(cryptoObj, "randomUUID", ownUuid);
      else delete (cryptoObj as { randomUUID?: unknown }).randomUUID;
    }
  };
}
