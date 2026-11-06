// The JavaScript that runs inside the isolate before the script (demo-path §8.2, §8.4). It builds `sb`, removes
// every source of non-determinism, and keeps the bridge bookkeeping where the script cannot reach it.
//
// It captures every intrinsic it relies on before the script runs: a script may replace `Promise.prototype.then`,
// `JSON` or `Map.prototype.set`, and that must only break the script, never the bridge. Bookkeeping tables are
// null-prototype objects, so no prototype method is ever looked up on them.

/** The file name the script is compiled under; stack frames in it carry the script's own line numbers. */
export const SCRIPT_FILE = "script.js";
export const PRELUDE_FILE = "selfbuilding-prelude.js";

/**
 * Evaluates to a function taking the host functions `(op, opSync, ban, settle)` and returning the bridge:
 * `{ resolve, invoke, invokeSync, start }`.
 */
export const PRELUDE = `(function (op, opSync, ban, settle) {
  "use strict";
  const g = globalThis;
  const apply = Reflect.apply;
  const construct = Reflect.construct;
  const defineProperty = Object.defineProperty;
  const freeze = Object.freeze;
  const create = Object.create;
  const keysOf = Object.keys;
  const isArray = Array.isArray;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const NativePromise = Promise;
  const promiseThen = Promise.prototype.then;
  const promiseResolve = Promise.resolve;
  const NativeError = Error;
  const NativeProxy = Proxy;
  const NativeString = String;
  const weakGet = WeakMap.prototype.get;
  const weakSet = WeakMap.prototype.set;
  const arrayJoin = Array.prototype.join;
  const arrayMap = Array.prototype.map;

  const pending = create(null);
  const callbacks = create(null);
  const hostErrorIds = new WeakMap();
  const handleIds = new WeakMap();
  let nextCallback = 1;

  const thenOf = (p, ok, fail) => apply(promiseThen, p, [ok, fail]);
  const toPromise = (v) => apply(promiseResolve, NativePromise, [v]);

  function replacer(key, value) {
    if (value !== null && typeof value === "object") {
      const hid = apply(weakGet, handleIds, [value]);
      if (hid !== undefined) return { $sandbox: hid };
    }
    return value;
  }
  function encode(value) {
    const text = stringify(value === undefined ? null : value, replacer);
    return text === undefined ? "null" : text;
  }
  function reviver(key, value) {
    if (value !== null && typeof value === "object" && !isArray(value) && typeof value.$sandbox === "number") {
      return makeHandle(value.$sandbox, value.id);
    }
    return value;
  }
  function decode(text) {
    return parse(text, reviver);
  }
  function encodeError(e) {
    let name = "Error";
    let message = "";
    let stack = "";
    try {
      if (e !== null && (typeof e === "object" || typeof e === "function")) {
        name = NativeString(e.name);
        message = NativeString(e.message);
        stack = e.stack === undefined ? "" : NativeString(e.stack);
      } else {
        message = NativeString(e);
      }
    } catch (_) {}
    let hostError = null;
    if (e !== null && typeof e === "object") {
      const id = apply(weakGet, hostErrorIds, [e]);
      if (id !== undefined) hostError = id;
    }
    return stringify({ name, message, stack, hostError });
  }
  function hostError(e) {
    const err = new NativeError(e.message);
    err.name = e.name;
    if (e.code !== undefined) err.code = e.code;
    if (e.retryable !== undefined) err.retryable = e.retryable;
    apply(weakSet, hostErrorIds, [err, e.id]);
    return err;
  }
  function call(name, args) {
    let ticket;
    try {
      ticket = op(name, encode(args));
    } catch (e) {
      return new NativePromise((_, reject) => reject(e));
    }
    return new NativePromise((resolve, reject) => {
      pending[ticket] = { resolve, reject };
    });
  }
  function callSync(name, args) {
    return decode(opSync(name, encode(args)));
  }
  function register(fn, what) {
    if (typeof fn !== "function") {
      throw new TypeError(what + " must be a function");
    }
    const id = nextCallback++;
    callbacks[id] = fn;
    return id;
  }

  function makeHandle(hid, id) {
    const handle = freeze({
      id,
      exec: (cmd, opts) => call("sandbox.exec", { hid, cmd, opts }),
      fork: (n, opts) => call("sandbox.fork", { hid, n, opts }),
      push: () => call("sandbox.push", { hid }),
      dispose: () => call("sandbox.dispose", { hid }),
    });
    apply(weakSet, handleIds, [handle, hid]);
    return handle;
  }

  function makeAgent(name) {
    const fn = (input, opts) => call("agent", { name, input, opts, settled: false });
    fn.settled = (input, opts) => call("agent", { name, input, opts, settled: true });
    return freeze(fn);
  }

  function makeSb(input, agentNames) {
    const table = create(null);
    for (const name of agentNames) table[name] = makeAgent(name);
    freeze(table);
    const agents = new NativeProxy(table, {
      get(target, key) {
        if (typeof key !== "string" || key === "then" || key in target) return target[key];
        return opSync("unknown_agent", stringify({ name: key }));
      },
    });
    const agent = (spec, opts) => call("agent.inline", { spec, opts, settled: false });
    agent.settled = (spec, opts) => call("agent.inline", { spec, opts, settled: true });
    freeze(agent);
    const sb = {
      input,
      agents,
      agent,
      parallel(thunks) {
        if (isArray(thunks)) {
          return call("parallel", { ids: apply(arrayMap, thunks, [(t, i) => register(t, "sb.parallel item " + i)]) });
        }
        if (thunks === null || typeof thunks !== "object") {
          return call("parallel", { invalid: true });
        }
        const keys = keysOf(thunks);
        return call("parallel", { keys, ids: apply(arrayMap, keys, [(k) => register(thunks[k], "sb.parallel item " + k)]) });
      },
      pipeline(...args) {
        let opts = {};
        let items = args[0];
        let stages = args.slice(1);
        if (!isArray(items) && items !== null && typeof items === "object") {
          opts = items;
          items = args[1];
          stages = args.slice(2);
        }
        const wire = {};
        if (opts.label !== undefined) wire.label = opts.label;
        if (opts.maxInFlight !== undefined) wire.maxInFlight = opts.maxInFlight;
        if (opts.key !== undefined) wire.key = register(opts.key, "sb.pipeline opts.key");
        for (const k of keysOf(opts)) if (k !== "label" && k !== "maxInFlight" && k !== "key") wire.unknown = k;
        return call("pipeline", {
          opts: wire,
          items,
          stages: apply(arrayMap, stages, [(s, i) => register(s, "sb.pipeline stage " + i)]),
        });
      },
      step(name, fn) {
        return call("step", { name, fn: register(fn, "sb.step fn") });
      },
      sandbox(opts) {
        // The host answers with a handle marker, which decode() turns into the handle object.
        return callSync("sandbox.create", opts === undefined ? {} : opts);
      },
      ask(spec) {
        return call("ask", spec);
      },
      pr: freeze({
        get: (pr) => call("pr.get", { pr }),
        comment: (opts) => call("pr.comment", { opts }),
        update: (opts) => call("pr.update", { opts }),
      }),
      phase(name) {
        callSync("phase", { name });
      },
      log(message, level) {
        callSync("log", { message: NativeString(message), level });
      },
      now: () => callSync("now", null),
      random: () => callSync("random", null),
      uuid: () => callSync("uuid", null),
    };
    return freeze(sb);
  }

  // Determinism (demo-path §8.4): each banned global throws ScriptInvalidError naming the replacement.
  const banned = (what, use) =>
    function () {
      return ban(what, use);
    };
  Math.random = banned("Math.random()", "sb.random()");
  const RealDate = Date;
  const dateNow = banned("Date.now()", "sb.now()");
  function SafeDate(...args) {
    if (new.target === undefined) return ban("Date()", "new Date(sb.now()).toString()");
    if (args.length === 0) return ban("new Date()", "new Date(sb.now())");
    return construct(RealDate, args, new.target);
  }
  SafeDate.prototype = RealDate.prototype;
  SafeDate.now = dateNow;
  SafeDate.UTC = RealDate.UTC;
  SafeDate.parse = RealDate.parse;
  defineProperty(RealDate.prototype, "constructor", { value: SafeDate, writable: true, configurable: true });
  g.Date = SafeDate;
  g.eval = banned("eval", "plain code");
  const fnBan = banned("the Function constructor", "plain functions");
  const ctors = [
    Function,
    (async function () {}).constructor,
    (function* () {}).constructor,
    (async function* () {}).constructor,
  ];
  for (const F of ctors) {
    defineProperty(F.prototype, "constructor", { value: fnBan, writable: true, configurable: true });
  }
  fnBan.prototype = Function.prototype;
  g.Function = fnBan;
  g.setTimeout = banned("setTimeout", "sb.step or an agent; scripts have no timers");
  g.setInterval = banned("setInterval", "sb.step or an agent; scripts have no timers");
  g.setImmediate = banned("setImmediate", "await on sb calls; scripts have no timers");
  g.queueMicrotask = banned("queueMicrotask", "await");
  g.fetch = banned("fetch", "an agent; scripts have no network");
  g.require = banned("require", "the sb argument; scripts cannot import");
  delete g.WeakRef;
  delete g.FinalizationRegistry;
  const logAt = (level) => (...parts) =>
    opSync("log", stringify({ message: apply(arrayJoin, apply(arrayMap, parts, [(p) => NativeString(p)]), [" "]), level }));
  g.console = freeze({ log: logAt("info"), info: logAt("info"), warn: logAt("warn"), error: logAt("error"), debug: logAt("debug") });

  return freeze({
    resolve(ticket, ok, payload) {
      const p = pending[ticket];
      if (p === undefined) return;
      delete pending[ticket];
      if (ok) p.resolve(decode(payload));
      else p.reject(hostError(parse(payload)));
    },
    invoke(id, args, ticket) {
      const fn = callbacks[id];
      let result;
      try {
        result = toPromise(apply(fn, undefined, decode(args)));
      } catch (e) {
        result = new NativePromise((_, reject) => reject(e));
      }
      thenOf(
        result,
        (value) => {
          let text;
          try {
            text = encode(value);
          } catch (e) {
            settle(ticket, false, encodeError(e));
            return;
          }
          settle(ticket, true, text);
        },
        (e) => settle(ticket, false, encodeError(e)),
      );
    },
    invokeSync(id, args) {
      return encode(apply(callbacks[id], undefined, decode(args)));
    },
    start(main, input, agentNames, ticket) {
      const value = parse(input);
      const sb = makeSb(value, parse(agentNames));
      let result;
      try {
        result = toPromise(main(value, sb));
      } catch (e) {
        result = new NativePromise((_, reject) => reject(e));
      }
      thenOf(
        result,
        (v) => {
          let text;
          try {
            text = encode(v);
          } catch (e) {
            settle(ticket, false, encodeError(e));
            return;
          }
          settle(ticket, true, text);
        },
        (e) => settle(ticket, false, encodeError(e)),
      );
    },
  });
})`;
