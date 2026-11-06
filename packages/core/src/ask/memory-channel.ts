import type { Actor, InboundEvent, MemoryChannel, MemoryChannelOp, MemoryChannelOptions } from "../types/ask.js";

// An in-memory HitlChannel for tests. It records every call, can be told to fail, and builds the inbound
// events a real platform would deliver, so tests drive the core's identity, authorisation and CAS rules.

export function memoryChannel(opts: MemoryChannelOptions = {}): MemoryChannel {
  const id = opts.id ?? "memory";
  const actorChannel = opts.actorChannel ?? "slack";
  const failures = new Map<MemoryChannelOp, number>();
  const postWaiters: { count: number; resolve: () => void }[] = [];
  let seq = 0;
  let delivery = 0;

  const maybeFail = (op: MemoryChannelOp) => {
    const n = failures.get(op) ?? 0;
    if (n > 0) {
      failures.set(op, n - 1);
      throw new Error(`memory channel ${id}: injected ${op} failure`);
    }
  };
  const actorOf = (a?: Partial<Actor>): Actor => ({ ...channel.user, ...a });
  const nextDelivery = () => `${id}-d${++delivery}`;

  const channel: MemoryChannel = {
    id,
    threads: [],
    posts: [],
    updates: [],
    notifications: [],
    missed: [],
    user: { channel: actorChannel, userId: "user-1", displayName: "user-1", isBot: false },

    async openThread(run) {
      maybeFail("openThread");
      const key = { channel: id, id: `${run.runId}:thread${channel.threads.length + 1}` };
      channel.threads.push({ key, run });
      return key;
    },
    async post(record, thread) {
      maybeFail("post");
      const ref = { channel: id, thread, id: `m${++seq}` };
      channel.posts.push({ ref, record: structuredClone(record) });
      for (const w of [...postWaiters]) {
        if (channel.posts.length >= w.count) {
          postWaiters.splice(postWaiters.indexOf(w), 1);
          w.resolve();
        }
      }
      return ref;
    },
    async update(ref, view) {
      maybeFail("update");
      channel.updates.push({ ref, view: structuredClone(view) });
    },
    async notify(thread, notification) {
      maybeFail("notify");
      const ref = { channel: id, thread, id: `n${++seq}` };
      channel.notifications.push({ ref, thread, notification: structuredClone(notification) });
      return ref;
    },
    async verify(req) {
      return req.headers.get("x-memory-signature") === "valid";
    },
    async parse(_req, rawBody) {
      const body = JSON.parse(new TextDecoder().decode(rawBody)) as { channel?: string; event?: InboundEvent };
      return body.channel === id && body.event ? body.event : null;
    },
    ack() {
      return new Response(null, { status: 200 });
    },
    fail(op, times = 1) {
      failures.set(op, (failures.get(op) ?? 0) + times);
    },
    waitForPosts(count) {
      if (channel.posts.length >= count) return Promise.resolve();
      return new Promise((resolve) => postWaiters.push({ count, resolve }));
    },
    click: (askId, choiceId, a) => ({ kind: "choice", askId, choiceId, actor: actorOf(a), deliveryId: nextDelivery() }),
    reply: (thread, text, a) => ({ kind: "text", thread, text, actor: actorOf(a), deliveryId: nextDelivery() }),
    submit: (askId, value, a) => ({ kind: "form", askId, value, actor: actorOf(a), deliveryId: nextDelivery() }),
    stop: (runId, a) => ({ kind: "stop", runId, actor: actorOf(a), deliveryId: nextDelivery() }),
  };

  if (opts.reconcile) {
    channel.reconcile = async function* (record) {
      const mine = channel.missed.filter((ev) => !("askId" in ev) || ev.askId === record.askId);
      for (const ev of mine) {
        channel.missed.splice(channel.missed.indexOf(ev), 1);
        yield ev;
      }
    };
  }
  return channel;
}
