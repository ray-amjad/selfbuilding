import type {
  AskRecord,
  AskResolution,
  AskStore,
  ChannelMessageRef,
  FileAskStoreOptions,
  ThreadKey,
} from "../types/ask.js";

// Two AskStore implementations (spec §8.3): in memory, and one JSON file per ask. Both make `resolve` and
// `markCold` a compare-and-set on status "open"; the file store holds an O_EXCL lock file for it, so two processes
// answering the same ask cannot both win, and an answer written while the host is down is never overwritten.

function clone<T>(v: T): T {
  return structuredClone(v);
}

function onThread(r: AskRecord, t: ThreadKey): boolean {
  return r.messages.some((m) => m.thread.channel === t.channel && m.thread.id === t.id);
}

function matches(r: AskRecord, f: { channel?: string; runId?: string }): boolean {
  if (r.status !== "open") return false;
  if (f.runId !== undefined && r.runId !== f.runId) return false;
  if (f.channel !== undefined && !r.messages.some((m) => m.channel === f.channel)) return false;
  return true;
}

function mergeMessages(have: ChannelMessageRef[], add: ChannelMessageRef[]): ChannelMessageRef[] {
  const key = (m: ChannelMessageRef) => `${m.channel}\u0000${m.thread.id}\u0000${m.id}`;
  const seen = new Set(have.map(key));
  return [...have, ...add.filter((m) => !seen.has(key(m)))];
}

/** An AskStore in process memory. For tests and single-process runs that need no restart. */
export function memoryAskStore(): AskStore & { readonly size: number } {
  const records = new Map<string, AskRecord>();
  return {
    get size() {
      return records.size;
    },
    async create(r) {
      const existing = records.get(r.askId);
      if (existing) return { status: "exists", record: clone(existing) };
      records.set(r.askId, clone(r));
      return { status: "created" };
    },
    async get(askId) {
      const r = records.get(askId);
      return r ? clone(r) : null;
    },
    async resolve(askId, res) {
      const r = records.get(askId);
      if (!r) throw new Error(`memoryAskStore.resolve: no ask ${askId}`);
      if (r.status !== "open") return { won: false, current: clone(r) };
      r.status = "answered";
      r.resolution = clone(res);
      return { won: true };
    },
    async openForThread(thread) {
      return [...records.values()].filter((r) => r.status === "open" && onThread(r, thread)).map(clone);
    },
    async *open(filter) {
      for (const r of [...records.values()]) if (matches(r, filter)) yield clone(r);
    },
    async setStatus(askId, s) {
      const r = records.get(askId);
      if (r?.status === "open") r.status = s;
    },
    async patch(askId, p) {
      const r = records.get(askId);
      if (!r) return;
      if (p.messages) r.messages = mergeMessages(r.messages, p.messages);
      if (p.reconciledAt !== undefined) r.reconciledAt = p.reconciledAt;
    },
    async *list(filter) {
      for (const r of [...records.values()]) if (r.runId === filter.runId) yield clone(r);
    },
    async markCold(askId, cold) {
      const r = records.get(askId);
      if (!r) return null;
      if (r.status === "open") r.cold = clone(cold);
      return clone(r);
    },
  };
}

const ASK_ID = /^ask_[a-z0-9_]{1,96}$/;

/**
 * An AskStore with one JSON file per ask in `dir`. The default for the plain Node host: the journal keeps
 * its asks in `<journal dir>/asks`. node:fs loads lazily so the core main entry stays free of it.
 */
export function fileAskStore(dir: string, opts: FileAskStoreOptions = {}): AskStore {
  const staleLockMs = opts.staleLockMs ?? 30_000;
  const lockWaitMs = opts.lockWaitMs ?? 10_000;
  const io = async () => {
    const [fs, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    await fs.mkdir(dir, { recursive: true });
    return { fs, file: (askId: string, ext = ".json") => path.join(dir, `${askId}${ext}`) };
  };
  const checkId = (askId: string) => {
    // The id becomes a file name; anything else could escape the directory.
    if (!ASK_ID.test(askId)) throw new Error(`fileAskStore: invalid ask id ${JSON.stringify(askId)}`);
  };

  async function read(askId: string): Promise<AskRecord | null> {
    checkId(askId);
    const { fs, file } = await io();
    try {
      return JSON.parse(await fs.readFile(file(askId), "utf8")) as AskRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async function write(r: AskRecord): Promise<void> {
    const { fs, file } = await io();
    const tmp = file(r.askId, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(r), "utf8");
    await fs.rename(tmp, file(r.askId));
  }

  async function withLock<T>(askId: string, fn: () => Promise<T>): Promise<T> {
    checkId(askId);
    const { fs, file } = await io();
    const lock = file(askId, ".lock");
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      try {
        const h = await fs.open(lock, "wx");
        await h.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const st = await fs.stat(lock).catch(() => null);
        if (st && Date.now() - st.mtimeMs > staleLockMs) {
          await fs.rm(lock, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error(`fileAskStore: timed out waiting for the lock on ${askId}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lock, { force: true });
    }
  }

  async function* all(): AsyncIterable<AskRecord> {
    const { fs } = await io();
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json")).sort();
    for (const n of names) {
      const r = await read(n.slice(0, -".json".length)).catch(() => null);
      if (r) yield r;
    }
  }

  return {
    async create(r) {
      checkId(r.askId);
      const { fs, file } = await io();
      const tmp = file(r.askId, `.${process.pid}.${Math.random().toString(36).slice(2)}.new`);
      await fs.writeFile(tmp, JSON.stringify(r), "utf8");
      try {
        // link() fails with EEXIST atomically, so two creators of one id cannot both succeed.
        await fs.link(tmp, file(r.askId));
        return { status: "created" };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        return { status: "exists", record: (await read(r.askId)) as AskRecord };
      } finally {
        await fs.rm(tmp, { force: true });
      }
    },
    get: read,
    async resolve(askId, res: AskResolution) {
      return withLock(askId, async () => {
        const r = await read(askId);
        if (!r) throw new Error(`fileAskStore.resolve: no ask ${askId}`);
        if (r.status !== "open") return { won: false as const, current: r };
        await write({ ...r, status: "answered", resolution: res });
        return { won: true as const };
      });
    },
    async openForThread(thread) {
      const out: AskRecord[] = [];
      for await (const r of all()) if (r.status === "open" && onThread(r, thread)) out.push(r);
      return out;
    },
    async *open(filter) {
      for await (const r of all()) if (matches(r, filter)) yield r;
    },
    async setStatus(askId, s) {
      await withLock(askId, async () => {
        const r = await read(askId);
        if (r?.status === "open") await write({ ...r, status: s });
      });
    },
    async patch(askId, p) {
      await withLock(askId, async () => {
        const r = await read(askId);
        if (!r) return;
        const next = { ...r };
        if (p.messages) next.messages = mergeMessages(r.messages, p.messages);
        if (p.reconciledAt !== undefined) next.reconciledAt = p.reconciledAt;
        await write(next);
      });
    },
    async *list(filter) {
      for await (const r of all()) if (r.runId === filter.runId) yield r;
    },
    async markCold(askId, cold) {
      return withLock(askId, async () => {
        const r = await read(askId);
        if (r?.status !== "open") return r;
        const next = { ...r, cold };
        await write(next);
        return next;
      });
    },
  };
}
