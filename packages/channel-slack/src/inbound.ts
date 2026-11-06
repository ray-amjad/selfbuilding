import type { Actor, InboundEvent } from "@selfbuilding/core";
import { ACTION, MODAL_CALLBACK_ID } from "./blocks.js";
import type { FormField } from "./forms.js";
import { readFormValues } from "./forms.js";
import { splitOrdinal, unescapeSlackText } from "./text.js";

/** What a verified Slack request turned out to be. */
export type SlackInbound =
  | { kind: "event"; event: InboundEvent }
  | { kind: "challenge"; challenge: string }
  | { kind: "open-modal"; triggerId: string; askId: string; thread: string; ordinal?: number; fields?: FormField[] }
  | { kind: "ignored"; reason: string };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function threadId(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function decodeBody(rawBody: Uint8Array, contentType: string): Json | null {
  const text = new TextDecoder().decode(rawBody);
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const payload = new URLSearchParams(text).get("payload");
      const parsed: unknown = payload === null ? null : JSON.parse(payload);
      return isObject(parsed) ? parsed : null;
    }
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function interactionActor(payload: Json): Actor | null {
  const user = payload.user;
  if (!isObject(user)) return null;
  const id = str(user.id);
  if (!id) return null;
  return { channel: "slack", userId: id, displayName: str(user.username) ?? str(user.name) ?? id, isBot: false };
}

function parseJson<T>(value: string | undefined): T | null {
  if (value === undefined) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseBlockActions(payload: Json): SlackInbound {
  const actor = interactionActor(payload);
  const action = Array.isArray(payload.actions) ? payload.actions[0] : undefined;
  if (!actor || !isObject(action)) return { kind: "ignored", reason: "malformed-action" };
  const actionId = str(action.action_id) ?? "";
  const value = str(action.value);
  const deliveryId = `${str(action.action_ts) ?? str(payload.trigger_id) ?? ""}:${actor.userId}`;

  if (actionId === ACTION.choice || actionId.startsWith(`${ACTION.choice}:`)) {
    // The ask is decoded from the button's own value, never from the message text (spec §8.7 rule 1).
    const colon = value?.indexOf(":") ?? -1;
    if (!value || colon <= 0) return { kind: "ignored", reason: "malformed-choice" };
    return {
      kind: "event",
      event: { kind: "choice", askId: value.slice(0, colon), choiceId: value.slice(colon + 1), actor, deliveryId },
    };
  }
  if (actionId === ACTION.stop) {
    if (!value) return { kind: "ignored", reason: "malformed-stop" };
    return { kind: "event", event: { kind: "stop", runId: value, actor, deliveryId } };
  }
  if (actionId === ACTION.reply || actionId === ACTION.form) {
    const triggerId = str(payload.trigger_id);
    const decoded = parseJson<{ a?: string; o?: number; f?: FormField[] }>(value);
    const container = isObject(payload.container) ? payload.container : {};
    const message = isObject(payload.message) ? payload.message : {};
    const channelId = str(container.channel_id) ?? (isObject(payload.channel) ? str(payload.channel.id) : undefined);
    const threadTs = str(message.thread_ts) ?? str(container.message_ts);
    if (!triggerId || !decoded?.a || !channelId || !threadTs)
      return { kind: "ignored", reason: "malformed-modal-button" };
    return {
      kind: "open-modal",
      triggerId,
      askId: decoded.a,
      thread: threadId(channelId, threadTs),
      ...(typeof decoded.o === "number" ? { ordinal: decoded.o } : {}),
      ...(actionId === ACTION.form && Array.isArray(decoded.f) ? { fields: decoded.f } : {}),
    };
  }
  return { kind: "ignored", reason: `foreign-action:${actionId}` };
}

function parseViewSubmission(payload: Json): SlackInbound {
  const actor = interactionActor(payload);
  const view = payload.view;
  if (!actor || !isObject(view)) return { kind: "ignored", reason: "malformed-view" };
  if (view.callback_id !== MODAL_CALLBACK_ID) return { kind: "ignored", reason: "foreign-view" };
  const meta = parseJson<{ a?: string; t?: string; o?: number; m?: string }>(str(view.private_metadata));
  const state = isObject(view.state) && isObject(view.state.values) ? view.state.values : {};
  if (!meta?.a || !meta.t) return { kind: "ignored", reason: "malformed-view-metadata" };
  const deliveryId = `view:${str(view.id) ?? ""}:${str(view.hash) ?? ""}`;
  if (meta.m === "form") {
    const value = readFormValues(state as Record<string, Record<string, { value?: string | null }>>);
    return { kind: "event", event: { kind: "form", askId: meta.a, value, actor, deliveryId } };
  }
  const input = isObject(state.ns_text) && isObject(state.ns_text.value) ? str(state.ns_text.value.value) : undefined;
  return {
    kind: "event",
    event: {
      kind: "text",
      thread: { channel: "slack", id: meta.t },
      ...(typeof meta.o === "number" ? { ordinal: meta.o } : {}),
      text: (input ?? "").trim(),
      actor,
      deliveryId,
    },
  };
}

function parseEventCallback(envelope: Json, botUserId: string | undefined): SlackInbound {
  const event = envelope.event;
  if (!isObject(event)) return { kind: "ignored", reason: "malformed-event" };
  if (event.type !== "message") return { kind: "ignored", reason: `event:${String(event.type)}` };
  // Edits and deletions never answer (spec §8.7 rule 7); bot posts are flagged and dropped by the handler.
  const subtype = str(event.subtype);
  if (subtype && subtype !== "thread_broadcast" && subtype !== "bot_message") {
    return { kind: "ignored", reason: `message-subtype:${subtype}` };
  }
  const channelId = str(event.channel);
  const ts = str(event.ts);
  const threadTs = str(event.thread_ts);
  const userId = str(event.user) ?? str(event.bot_id);
  if (!channelId || !threadTs || !userId) return { kind: "ignored", reason: "not-a-thread-reply" };
  if (threadTs === ts) return { kind: "ignored", reason: "thread-root" };
  const isBot = Boolean(event.bot_id) || subtype === "bot_message" || (botUserId !== undefined && userId === botUserId);
  const { ordinal, text } = splitOrdinal(unescapeSlackText(str(event.text) ?? ""));
  const deliveryId = str(envelope.event_id) ?? `${channelId}:${ts ?? ""}`;
  return {
    kind: "event",
    event: {
      kind: "text",
      thread: { channel: "slack", id: threadId(channelId, threadTs) },
      ...(ordinal === undefined ? {} : { ordinal }),
      text,
      actor: { channel: "slack", userId, displayName: userId, isBot },
      deliveryId,
    },
  };
}

/** Maps a verified request body to what it means. Never throws on foreign or malformed input. */
export function parseSlackRequest(rawBody: Uint8Array, contentType: string, botUserId?: string): SlackInbound {
  const body = decodeBody(rawBody, contentType);
  if (!body) return { kind: "ignored", reason: "unreadable-body" };
  switch (body.type) {
    case "url_verification":
      return typeof body.challenge === "string"
        ? { kind: "challenge", challenge: body.challenge }
        : { kind: "ignored", reason: "malformed-challenge" };
    case "block_actions":
      return parseBlockActions(body);
    case "view_submission":
      return parseViewSubmission(body);
    case "event_callback":
      return parseEventCallback(body, botUserId);
    default:
      return { kind: "ignored", reason: `type:${String(body.type)}` };
  }
}
