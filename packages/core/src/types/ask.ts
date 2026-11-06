import type { Duration, StandardSchema } from "./common.js";
import type { SandboxRef } from "./sandbox.js";

// Human in the loop (spec §8).

export interface AskChoice<C extends string = string> {
  /** [a-z0-9-]{1,20}; what the caller gets back. */
  id: C;
  /** ≤ 75 chars (Slack button limit). */
  label: string;
  style?: "primary" | "danger";
  /** The choice that is safe to take without a human. */
  safe?: boolean;
}

export interface AskSpec<T = unknown, C extends string = string> {
  /** ≤ 2,000 chars, plain text plus *bold*, _italic_, `code`. */
  question: string;
  /** ≤ 120 chars; card heading. */
  title?: string;
  /** ≤ 4,000 chars; shown collapsed. */
  context?: string;
  /** 0–5; a string is shorthand for { id: s, label: s }. */
  choices?: readonly (C | AskChoice<C>)[];
  /** Default: true if no choices, else false. */
  freeText?: boolean;
  /** Flat object form: at most 5 string | number | boolean | enum fields. */
  schema?: StandardSchema<T>;
  /** A choice id, or a schema-valid value. */
  default?: C | T;
  /** Overrides the run default. */
  timeout?: Duration;
  onTimeout?: "default" | "auto" | "fail";
  /** Default "low". A high-risk ask can only fall back to a safe choice. */
  risk?: "low" | "high";
  /** A re-ask with the same key replaces the open card. */
  dedupeKey?: string;
  /** GitHub: post as a review comment on this line. */
  anchor?: { path: string; line: number };
}

export type AskAnswer<T, C extends string = string> =
  | { kind: "choice"; choiceId: C }
  | { kind: "text"; text: string }
  | { kind: "value"; value: T };

export type AnsweredBy =
  | { kind: "human"; channel: "slack" | "discord" | "github" | "cli"; userId: string; displayName: string }
  | { kind: "default"; reason: "timeout" | "afk" | "undeliverable" }
  | { kind: "auto"; model: string; rationale: string };

export interface AskResolution<T = unknown, C extends string = string> {
  askId: string;
  answer: AskAnswer<T, C>;
  /** answer.choiceId when kind is "choice", else null. */
  choiceId: C | null;
  answeredBy: AnsweredBy;
  /** ISO. */
  answeredAt: string;
}

export type Approver =
  | { slack: string }
  | { discord: string }
  | { github: string }
  | { githubPermission: "write" | "maintain" | "admin" };

export interface HitlOptions {
  /** Default "interactive" if any channel is set, else "afk". */
  mode?: "interactive" | "afk";
  /** Posted to in parallel; first answer wins. */
  channels?: HitlChannel[];
  /** Default: the run's requester, if known. */
  approvers?: Approver[];
  /** Default "4h". */
  timeout?: Duration;
  /** Default "fail". */
  onTimeout?: "default" | "auto" | "fail";
  /** Default "10m"; capped per harness. */
  hotWait?: Duration;
  /** Required for "auto". */
  autoAnswer?: { model: string; maxUsd?: number };
  /** Default 10. */
  maxAsksPerAgent?: number;
  /** Default 3 per run. */
  maxOpenAsks?: number;
}

export interface NotifyOptions {
  /** Default ["run.end", "run.failed"]. */
  on?: Array<"run.end" | "run.failed" | "agent.end" | "ask.expired">;
  /** Default: hitl.channels. */
  channels?: HitlChannel[];
  /** Default "on-failure". */
  mention?: "approvers" | "none" | "on-failure";
}

export type HostId = "node" | "trigger" | "inngest" | "cloudflare-workflows";

/** Identifies one run's thread in one channel, e.g. `{ channel: "slack", id: "C123:1712345.000" }`. */
export interface ThreadKey {
  channel: string;
  id: string;
}

/** A posted message, kept so every card for an ask can be edited later. */
export interface ChannelMessageRef {
  channel: string;
  thread: ThreadKey;
  id: string;
}

export interface AskRecord {
  askId: string;
  runId: string;
  /** Short per-run number people type in replies (#1, #2, ...). */
  ordinal: number;
  callPath: string;
  origin: { kind: "agent"; launchId: string; askSeq: number } | { kind: "factory"; askSeq: number };
  specHash: string;
  /** After validation and redaction. */
  spec: AskSpec;
  status: "open" | "answered" | "expired" | "cancelled";
  resolution?: AskResolution;
  /** e.g. Trigger token id. */
  waitpoint: { host: HostId; ref: string };
  messages: ChannelMessageRef[];
  /** Last GitHub reconcile. */
  reconciledAt?: string;
  createdAt: string;
  expiresAt: string;
  /**
   * Set when the hot wait ended and the ask went cold (demo-path §6): the box was parked and the run may exit.
   * Whoever resumes the run reads this, never process memory.
   */
  cold?: { since: string; sandbox?: SandboxRef; sessionId?: string; launch?: number };
}

export interface AskStore {
  create(r: AskRecord): Promise<{ status: "created" } | { status: "exists"; record: AskRecord }>;
  get(askId: string): Promise<AskRecord | null>;
  /** CAS on status=open. One atomic statement. */
  resolve(askId: string, res: AskResolution): Promise<{ won: true } | { won: false; current: AskRecord }>;
  openForThread(thread: ThreadKey): Promise<AskRecord[]>;
  /** Used by reconcile and reminders. */
  open(filter: { channel?: string; runId?: string }): AsyncIterable<AskRecord>;
  setStatus(askId: string, s: "expired" | "cancelled"): Promise<void>;
  /** Records the cards posted after create, and the last reconcile. Without it they live only in memory. */
  patch?(askId: string, p: { messages?: ChannelMessageRef[]; reconciledAt?: string }): Promise<void>;
  /** Every record of a run, whatever its status: per-run ordinals and per-agent limits survive a restart. */
  list?(filter: { runId: string }): AsyncIterable<AskRecord>;
  /**
   * Records that the ask went cold (demo-path §6), compare-and-set on status=open. Returns the record as stored
   * afterwards (null when it does not exist); its `cold` is unset when the ask had already settled.
   */
  markCold?(askId: string, cold: NonNullable<AskRecord["cold"]>): Promise<AskRecord | null>;
}

/** What a channel needs to open a run's thread. */
export interface RunInfo {
  runId: string;
  factory: string;
  /** Requester or trigger, when known. */
  requestedBy?: string;
  /** Link to a transcript viewer, when configured. */
  url?: string;
}

/** How a card should look after its ask settles. */
export interface AskView {
  status: "answered" | "expired" | "cancelled" | "superseded";
  record: AskRecord;
  /** e.g. "Answered by @alice: Hold". */
  text: string;
}

export interface Notification {
  kind: "run.end" | "run.failed" | "agent.end" | "ask.expired" | "fyi" | "reminder" | "refusal";
  text: string;
  /** Mention the approvers. */
  mention?: boolean;
  data?: Record<string, unknown>;
}

/** Who acted on an inbound event. */
export interface Actor {
  channel: "slack" | "discord" | "github" | "cli";
  userId: string;
  displayName: string;
  isBot: boolean;
}

export type InboundEvent =
  | { kind: "choice"; askId: string; choiceId: string; actor: Actor; deliveryId: string }
  | { kind: "text"; thread: ThreadKey; ordinal?: number; text: string; actor: Actor; deliveryId: string }
  | { kind: "form"; askId: string; value: unknown; actor: Actor; deliveryId: string }
  | { kind: "stop"; runId: string; actor: Actor; deliveryId: string };

/** A channel adapter (spec §8.6). The core owns identity, authorisation, CAS and waitpoint resolution. */
export interface HitlChannel {
  id: "slack" | "discord" | "github" | (string & {});
  /** Called once per run, lazily, at the first post. */
  openThread(run: RunInfo): Promise<ThreadKey>;
  post(ask: AskRecord, thread: ThreadKey): Promise<ChannelMessageRef>;
  update(ref: ChannelMessageRef, view: AskView): Promise<void>;
  notify(thread: ThreadKey, n: Notification): Promise<ChannelMessageRef>;
  /** Inbound: verify the raw request. */
  verify(req: Request, rawBody: Uint8Array): Promise<boolean>;
  /** Map a verified request to a typed event. null = not ours. */
  parse(req: Request, rawBody: Uint8Array): Promise<InboundEvent | null>;
  /** Must be cheap; platform deadlines are ~3 s. */
  ack(ev: InboundEvent): Response;
  /** Pull answers a missed webhook would have carried. */
  reconcile?(ask: AskRecord, since: string): AsyncIterable<InboundEvent>;
}

// Helpers the core exports for channel handlers, the CLI and tests (spec §8.3, §8.7). Added by core-ask.

export interface FileAskStoreOptions {
  /** A lock older than this is treated as left by a dead process. Default 30 s. */
  staleLockMs?: number;
  /** How long `resolve` waits for the lock before giving up. Default 10 s. */
  lockWaitMs?: number;
}

export interface AnswerAskOptions {
  store: AskStore;
  askId: string;
  answer: AskAnswer<unknown>;
  answeredBy: AnsweredBy;
  /** Cards on these channels are edited to show the answer. */
  channels?: readonly HitlChannel[];
  /** ISO; default now. */
  at?: string;
  /** Fail-soft observer for card edit failures. */
  onCardError?: (err: unknown, channel: string) => void;
}

export type AnswerResult =
  | { status: "answered"; record: AskRecord; resolution: AskResolution }
  /** Someone else answered first, or the ask expired or was cancelled. */
  | { status: "lost"; current: AskRecord }
  | { status: "invalid"; message: string }
  | { status: "not-found" };

export interface ApproverContext {
  approvers: readonly Approver[];
  /** The run's requester: an approver when no approvers are configured (spec §8.7 rule 5). */
  requester?: string;
  /** Selfbuilding's own user ids on each channel; their events never answer. */
  selfUserIds?: readonly string[];
  /** Checks `{ githubPermission }` approvers; callers cache per run. */
  hasGithubPermission?: (login: string, level: "write" | "maintain" | "admin") => Promise<boolean>;
}

export type InboundDecision =
  | { action: "answer"; askId: string; answer: AskAnswer<unknown>; actor: Actor }
  | { action: "stop"; runId: string; actor: Actor }
  /** Tell the actor who can answer (ephemeral on Slack and Discord, a log line on GitHub). */
  | { action: "refuse"; text: string }
  /** The ask already settled; `text` says what the run did instead. */
  | { action: "late"; record: AskRecord; text: string }
  /** Several free-text asks are open; reply once with `text` and answer nothing. */
  | { action: "clarify"; open: AskRecord[]; text: string }
  | { action: "skip"; reason: string };

export interface HandleInboundOptions extends ApproverContext {
  store: AskStore;
  channels: readonly HitlChannel[];
  /** Called for every skip, with its reason (spec §8.1 rule 9). */
  onSkip?: (reason: string, ev: InboundEvent) => void;
}

export type InboundOutcome =
  | InboundDecision
  | { action: "answered"; result: Extract<AnswerResult, { status: "answered" }> };

export type MemoryChannelOp = "openThread" | "post" | "update" | "notify";

/** The in-memory test channel `memoryChannel()` returns. */
export interface MemoryChannel extends HitlChannel {
  readonly threads: { key: ThreadKey; run: RunInfo }[];
  readonly posts: { ref: ChannelMessageRef; record: AskRecord }[];
  readonly updates: { ref: ChannelMessageRef; view: AskView }[];
  readonly notifications: { ref: ChannelMessageRef; thread: ThreadKey; notification: Notification }[];
  /** Makes the next `times` calls of `op` reject. */
  fail(op: MemoryChannelOp, times?: number): void;
  /** Resolves when the channel has posted `count` asks in total. */
  waitForPosts(count: number): Promise<void>;
  /** The default actor (`user-1`), which tests list in `approvers`. */
  readonly user: Actor;
  click(askId: string, choiceId: string, actor?: Partial<Actor>): InboundEvent;
  reply(thread: ThreadKey, text: string, actor?: Partial<Actor>): InboundEvent;
  submit(askId: string, value: unknown, actor?: Partial<Actor>): InboundEvent;
  stop(runId: string, actor?: Partial<Actor>): InboundEvent;
  /** Events `reconcile()` will yield, as if a missed webhook had carried them. */
  readonly missed: InboundEvent[];
}

export interface MemoryChannelOptions {
  id?: string;
  /** Implement reconcile() (like the GitHub channel). Default false. */
  reconcile?: boolean;
  /** The Actor.channel value for events this channel builds. Default "slack". */
  actorChannel?: Actor["channel"];
}
