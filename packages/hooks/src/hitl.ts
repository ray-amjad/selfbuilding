import type {
  Actor,
  Approver,
  AskAnswer,
  AskChoice,
  AskRecord,
  AskResolution,
  AskStore,
  AskView,
  DurableHost,
  HitlChannel,
  InboundEvent,
  ThreadKey,
} from "@selfbuilding/core";
import { HitlConfigError } from "@selfbuilding/core";
import { type DeliveryDedupe, memoryDedupe } from "./dedupe.js";

export type FetchHandler = (req: Request) => Promise<Response>;

export interface HitlHandlerOptions {
  channels: HitlChannel[];
  store: AskStore;
  host?: DurableHost;
  /**
   * Who may answer (spec §8.7 rule 5). Required unless `authorize` is given: a handler that nobody can
   * answer through is a configuration error, not an open door.
   */
  approvers?: Approver[];
  /**
   * Overrides the approver check, e.g. for `{ githubPermission }` lookups or a run's requester. Required when
   * `approvers` holds a `{ githubPermission }` entry: the built-in check matches only `slack`, `discord` and `github`.
   */
  authorize?: (actor: Actor, record: AskRecord | null) => boolean | Promise<boolean>;
  /**
   * Completes the host's waitpoint after the store holds the answer (spec §8.5: store first, then wake).
   * On the plain Node host the store write is enough, because the run reads the store when it resumes.
   */
  resolveWaitpoint?: (record: AskRecord, resolution: AskResolution) => Promise<void>;
  /**
   * Called once the store holds an answer, whether or not any run is waiting for it (demo-path §6.3). A record with
   * `cold` set belongs to a run that may have exited; a deployment can start `selfbuilding resume <runId>` here.
   * A throw is logged and never undoes the answer.
   */
  onResolved?: (record: AskRecord) => Promise<void> | void;
  /** Cancels a run when an approver clicks Stop. Without it, Stop clicks are skipped and logged. */
  onStop?: (runId: string, actor: Actor) => Promise<void>;
  /** Delivery-id dedupe. Default: in-process, one hour. */
  dedupe?: DeliveryDedupe;
  /** Keeps background work alive after the ack (`ctx.waitUntil` on Workers). Default: fire and forget. */
  waitUntil?: (work: Promise<unknown>) => void;
  /** Where `skip [reason]` lines go. Default console.warn. */
  log?: (line: string) => void;
  now?: () => Date;
  /** Larger bodies get 413. Default 1 MiB. */
  maxBodyBytes?: number;
}

/** A channel may answer a platform handshake (Slack's url_verification) before parsing. */
interface HandshakeChannel {
  handshake?(req: Request, rawBody: Uint8Array): Response | null;
}

const normalizeChoices = (record: AskRecord): AskChoice[] =>
  (record.spec.choices ?? []).map((c) => (typeof c === "string" ? { id: c, label: c } : c));
const acceptsFreeText = (record: AskRecord) => record.spec.freeText ?? normalizeChoices(record).length === 0;

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function describeAnswer(record: AskRecord, answer: AskAnswer<unknown>): string {
  if (answer.kind === "choice") {
    return normalizeChoices(record).find((c) => c.id === answer.choiceId)?.label ?? answer.choiceId;
  }
  if (answer.kind === "text") return `"${clip(answer.text, 200)}"`;
  return clip(JSON.stringify(answer.value) ?? "null", 200);
}

function describeAnswerer(resolution: AskResolution): string {
  const by = resolution.answeredBy;
  if (by.kind === "human") return `@${by.displayName}`;
  if (by.kind === "auto") return `an automatic reviewer (${by.model})`;
  return `the default (${by.reason})`;
}

/** Backoff for completing a host waitpoint after an answer (release-prep §3.2 item 8). Tests turn it down. */
export const WAITPOINT_RETRY = { attempts: 3, baseDelayMs: 250 };

/** Runs `fn` up to `WAITPOINT_RETRY.attempts` times with full-jitter backoff; rethrows the last failure. */
export async function withRetries<T>(fn: () => Promise<T>, retry = WAITPOINT_RETRY): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < retry.attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.random() * retry.baseDelayMs * 2 ** (attempt - 1)));
    try {
      return await fn();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/** Channel webhooks: verify, dedupe, ack within the deadline, then resolve by CAS (spec §8.6). */
export function createHitlHandler(opts: HitlHandlerOptions): FetchHandler {
  if (!opts.authorize && (!opts.approvers || opts.approvers.length === 0)) {
    throw new HitlConfigError(
      "createHitlHandler() has no approvers, so nobody could answer. Add hitl.approvers (the same list the factory uses) or pass authorize().",
    );
  }
  if (!opts.authorize && opts.approvers?.some((a) => "githubPermission" in a)) {
    // The handler cannot look up repo permissions itself; without authorize() that entry would match nobody.
    throw new HitlConfigError(
      "createHitlHandler() approvers include { githubPermission }, which only authorize() can check. Pass authorize(actor, record) that looks up the actor's repo permission, or list people as { slack }, { discord } or { github }.",
    );
  }
  if (opts.channels.length === 0) {
    throw new HitlConfigError("createHitlHandler() needs at least one channel, e.g. channels: [slack({ channel })].");
  }
  const { store } = opts;
  const approvers = opts.approvers ?? [];
  const dedupe = opts.dedupe ?? memoryDedupe();
  const log = opts.log ?? ((line: string) => console.warn(line));
  const now = opts.now ?? (() => new Date());
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const schedule = opts.waitUntil ?? ((work: Promise<unknown>) => void work);

  const isApprover = async (actor: Actor, record: AskRecord | null): Promise<boolean> => {
    if (opts.authorize) return opts.authorize(actor, record);
    // The CLI writes the store directly, so whoever runs it already has the access an approver has.
    if (actor.channel === "cli") return true;
    return approvers.some((a) => {
      if ("slack" in a) return actor.channel === "slack" && a.slack === actor.userId;
      if ("discord" in a) return actor.channel === "discord" && a.discord === actor.userId;
      if ("github" in a) return actor.channel === "github" && a.github.toLowerCase() === actor.userId.toLowerCase();
      return false;
    });
  };

  const approverMentions = (channel: string) =>
    approvers.flatMap((a) =>
      "slack" in a && channel === "slack"
        ? [a.slack]
        : "discord" in a && channel === "discord"
          ? [a.discord]
          : "github" in a && channel === "github"
            ? [a.github]
            : [],
    );
  const hasPermissionRule = approvers.some((a) => "githubPermission" in a);

  const threadOf = (channel: HitlChannel, record: AskRecord): ThreadKey | null =>
    record.messages.find((m) => m.channel === channel.id)?.thread ?? null;

  /** Tells one person something; on Slack this is ephemeral. Failures are logged, never thrown. */
  const tell = async (channel: HitlChannel, thread: ThreadKey | null, actor: Actor, text: string) => {
    if (!thread) {
      log(`skip [no-thread] could not tell ${actor.userId}: ${text}`);
      return;
    }
    try {
      await channel.notify(thread, { kind: "refusal", text, data: { userId: actor.userId } });
    } catch (error) {
      log(`skip [notify-failed] ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const refusalText = (channel: string) => {
    const names = approverMentions(channel);
    const who = [...names.map((n) => `@${n}`), ...(hasPermissionRule ? ["repo maintainers"] : [])];
    return who.length > 0 ? `Only ${who.join(" or ")} can answer this.` : "You are not an approver for this run.";
  };

  const settledText = (record: AskRecord): string => {
    if (record.status === "answered" && record.resolution) {
      return `Already answered by ${describeAnswerer(record.resolution)}: ${describeAnswer(record, record.resolution.answer)}.`;
    }
    if (record.status === "expired") {
      const proceeded = record.resolution
        ? `; the run proceeded with ${describeAnswer(record, record.resolution.answer)}`
        : "";
      return `This question expired at ${record.expiresAt}${proceeded}.`;
    }
    return "This question was cancelled; the run no longer needs an answer.";
  };

  const updateCards = async (record: AskRecord, view: AskView) => {
    await Promise.all(
      record.messages.map(async (ref) => {
        const channel = opts.channels.find((c) => c.id === ref.channel);
        if (!channel) {
          log(`skip [card-channel-missing] ${ref.channel} card ${ref.id} for ${record.askId}`);
          return;
        }
        try {
          await channel.update(ref, view);
        } catch (error) {
          log(
            `skip [card-update-failed] ${record.askId} on ${ref.channel}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  };

  const answer = async (
    channel: HitlChannel,
    record: AskRecord,
    given: AskAnswer<unknown>,
    actor: Actor,
    thread: ThreadKey | null,
    refuseOutsiders: boolean,
  ) => {
    if (!(await isApprover(actor, record))) {
      log(`skip [not-approver] ${actor.channel}:${actor.userId} on ${record.askId}`);
      if (refuseOutsiders) await tell(channel, thread, actor, refusalText(actor.channel));
      return;
    }
    if (record.status !== "open") {
      log(`skip [ask-not-open] ${record.askId} is ${record.status}`);
      await tell(channel, thread, actor, settledText(record));
      return;
    }
    const resolution: AskResolution = {
      askId: record.askId,
      answer: given,
      choiceId: given.kind === "choice" ? given.choiceId : null,
      answeredBy: { kind: "human", channel: actor.channel, userId: actor.userId, displayName: actor.displayName },
      answeredAt: now().toISOString(),
    };
    const outcome = await store.resolve(record.askId, resolution);
    if (!outcome.won) {
      log(`skip [already-answered] ${record.askId} lost by ${actor.channel}:${actor.userId}`);
      await tell(channel, thread, actor, settledText(outcome.current));
      return;
    }
    const settled: AskRecord = { ...record, status: "answered", resolution };
    if (opts.resolveWaitpoint) {
      const resolveWaitpoint = opts.resolveWaitpoint;
      try {
        await withRetries(() => resolveWaitpoint(settled, resolution));
      } catch (error) {
        // The answer is already in the store, and the run reads the store after every wait (on Trigger.dev, after
        // every wait slice), so a lost completion delays the run by at most one slice.
        log(`skip [waitpoint-failed] ${record.askId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const text = `Answered by ${describeAnswerer(resolution)}: ${describeAnswer(record, given)}`;
    await updateCards(settled, { status: "answered", record: settled, text });
    if (opts.onResolved) {
      try {
        // Read back, so the callback sees what a restarted run will see (e.g. `cold` written after our read).
        await opts.onResolved((await store.get(record.askId)) ?? settled);
      } catch (error) {
        log(`skip [on-resolved-failed] ${record.askId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const onChoice = async (channel: HitlChannel, ev: Extract<InboundEvent, { kind: "choice" }>) => {
    const record = await store.get(ev.askId);
    if (!record) {
      log(`skip [unknown-ask] ${ev.askId}`);
      return;
    }
    if (!normalizeChoices(record).some((c) => c.id === ev.choiceId)) {
      log(`skip [unknown-choice] ${ev.choiceId} on ${ev.askId}`);
      return;
    }
    await answer(channel, record, { kind: "choice", choiceId: ev.choiceId }, ev.actor, threadOf(channel, record), true);
  };

  const onForm = async (channel: HitlChannel, ev: Extract<InboundEvent, { kind: "form" }>) => {
    const record = await store.get(ev.askId);
    if (!record) {
      log(`skip [unknown-ask] ${ev.askId}`);
      return;
    }
    const thread = threadOf(channel, record);
    let value = ev.value;
    const schema = record.spec.schema;
    if (schema && typeof schema === "object" && "~standard" in schema) {
      const checked = await schema["~standard"].validate(ev.value);
      if (checked.issues) {
        log(`skip [form-invalid] ${ev.askId}`);
        const issues = checked.issues.map((i) => `${i.path?.join(".") || "value"}: ${i.message}`).join("; ");
        await tell(channel, thread, ev.actor, `That answer is not valid (${issues}). Please try again.`);
        return;
      }
      value = checked.value;
    }
    await answer(channel, record, { kind: "value", value }, ev.actor, thread, true);
  };

  const onText = async (channel: HitlChannel, ev: Extract<InboundEvent, { kind: "text" }>) => {
    if (ev.text.startsWith("//")) {
      log(`skip [chatter] ${ev.actor.userId} in ${ev.thread.id}`);
      return;
    }
    if (ev.text.length === 0) {
      log(`skip [empty-reply] ${ev.actor.userId} in ${ev.thread.id}`);
      return;
    }
    const open = (await store.openForThread(ev.thread)).filter((r) => r.status === "open");
    if (ev.ordinal !== undefined) {
      const target = open.find((r) => r.ordinal === ev.ordinal);
      if (!target) {
        log(`skip [ordinal-not-open] #${ev.ordinal} in ${ev.thread.id}`);
        if (await isApprover(ev.actor, null))
          await tell(channel, ev.thread, ev.actor, `Question #${ev.ordinal} is not open.`);
        return;
      }
      if (acceptsFreeText(target)) {
        await answer(channel, target, { kind: "text", text: ev.text }, ev.actor, ev.thread, false);
        return;
      }
      // A typed reply to a buttons-only ask counts when it names one of the choices.
      const wanted = ev.text.trim().toLowerCase();
      const choice = normalizeChoices(target).find((c) => c.id === wanted || c.label.toLowerCase() === wanted);
      if (!choice) {
        log(`skip [not-a-choice] #${ev.ordinal} in ${ev.thread.id}`);
        if (await isApprover(ev.actor, target)) {
          const options = normalizeChoices(target)
            .map((c) => `"${c.label}"`)
            .join(", ");
          await tell(
            channel,
            ev.thread,
            ev.actor,
            `Question #${target.ordinal} takes one of: ${options}. Use the buttons or reply with one of them.`,
          );
        }
        return;
      }
      await answer(channel, target, { kind: "choice", choiceId: choice.id }, ev.actor, ev.thread, false);
      return;
    }
    const free = open.filter(acceptsFreeText);
    if (free.length === 0) {
      log(`skip [no-open-ask] ${ev.thread.id}`);
      return;
    }
    if (free.length > 1) {
      if (!(await isApprover(ev.actor, null))) {
        log(`skip [not-approver] ${ev.actor.channel}:${ev.actor.userId} in ${ev.thread.id}`);
        return;
      }
      log(`skip [ambiguous-reply] ${free.length} open asks in ${ev.thread.id}`);
      const list = free
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((r) => `#${r.ordinal} ${clip(r.spec.title ?? r.spec.question, 80)}`)
        .join("; ");
      try {
        await channel.notify(ev.thread, {
          kind: "fyi",
          text: `Several questions are open: ${list}. Start your reply with the number, e.g. "#${free[0]?.ordinal} ...". Nothing was answered.`,
        });
      } catch (error) {
        log(`skip [notify-failed] ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const [only] = free;
    if (only) await answer(channel, only, { kind: "text", text: ev.text }, ev.actor, ev.thread, false);
  };

  const onStop = async (channel: HitlChannel, ev: Extract<InboundEvent, { kind: "stop" }>) => {
    const asks: AskRecord[] = [];
    for await (const record of store.open({ runId: ev.runId })) asks.push(record);
    const thread = asks.map((r) => threadOf(channel, r)).find((t) => t !== null) ?? null;
    if (!(await isApprover(ev.actor, null))) {
      log(`skip [not-approver] stop of ${ev.runId} by ${ev.actor.channel}:${ev.actor.userId}`);
      await tell(channel, thread, ev.actor, refusalText(ev.actor.channel).replace("answer this", "stop this run"));
      return;
    }
    if (!opts.onStop) {
      log(`skip [stop-unsupported] ${ev.runId}: pass onStop to createHitlHandler() to cancel runs from chat`);
      return;
    }
    await opts.onStop(ev.runId, ev.actor);
    log(`stop ${ev.runId} requested by ${ev.actor.channel}:${ev.actor.userId}`);
  };

  const handleEvent = async (channel: HitlChannel, ev: InboundEvent) => {
    if (ev.actor.isBot) {
      log(`skip [bot] ${ev.actor.channel}:${ev.actor.userId}`);
      return;
    }
    if (ev.kind === "choice") await onChoice(channel, ev);
    else if (ev.kind === "form") await onForm(channel, ev);
    else if (ev.kind === "text") await onText(channel, ev);
    else await onStop(channel, ev);
  };

  return async (req) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > maxBody) return new Response("payload too large", { status: 413 });
    const rawBody = new Uint8Array(await req.arrayBuffer());
    if (rawBody.byteLength > maxBody) return new Response("payload too large", { status: 413 });

    for (const channel of opts.channels) {
      let verified: boolean;
      try {
        verified = await channel.verify(req, rawBody);
      } catch (error) {
        log(`skip [verify-error] ${channel.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!verified) continue;

      const handshake = (channel as HitlChannel & HandshakeChannel).handshake?.(req, rawBody);
      if (handshake) return handshake;

      let ev: InboundEvent | null;
      try {
        ev = await channel.parse(req, rawBody);
      } catch (error) {
        // A 2xx stops the platform from retrying a request that would fail the same way.
        log(`skip [parse-error] ${channel.id}: ${error instanceof Error ? error.message : String(error)}`);
        return new Response(null, { status: 200 });
      }
      if (!ev) return new Response(null, { status: 200 });

      const response = channel.ack(ev);
      if (!(await dedupe.claim(`${channel.id}:${ev.deliveryId}`))) {
        log(`skip [duplicate-delivery] ${channel.id}:${ev.deliveryId}`);
        return response;
      }
      const event = ev;
      schedule(
        handleEvent(channel, event).catch((error: unknown) =>
          log(
            `hitl handler failed on ${channel.id}:${event.deliveryId}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      );
      return response;
    }
    log("skip [signature] no channel verified the request");
    return new Response("invalid signature", { status: 401 });
  };
}
