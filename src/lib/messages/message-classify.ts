/**
 * Pure classification of Teams chatMessages - no React, no "use client".
 *
 * One source of truth for "what kind of message is this", shared by:
 *   - the message timeline renderer (system-event-renderer.tsx), which decides
 *     whether a row is a normal bubble, a system/attachment pill, or dropped
 *     noise; and
 *   - the unread-count route (server), which decides whether a chat's latest
 *     message should raise a "new message" notification.
 *
 * Keeping these predicates here (pure + server-safe) is what lets the
 * notification path agree with the timeline: a chat only notifies when its
 * latest message is something the timeline would actually show as a real,
 * typed human message. A meeting invite / system event / attachment card - which
 * the timeline drops or renders as a pill - must never flash the badge.
 */

import type { ChatMessageAttachment, ChatMessageEventDetail } from "@/lib/ms-graph-chats";

/**
 * Renderer-shaped subset of a chat message. Accepts both the lib's strict
 * `ChatMessage` and the loose page/preview shapes (where `from` may be absent).
 */
export interface RenderableMessage {
  id?: string;
  from?: { displayName?: string; userId?: string; email?: string };
  bodyText?: string;
  body?: { content?: string; contentType?: string };
  messageType?: string;
  attachments?: ChatMessageAttachment[];
  eventDetail?: ChatMessageEventDetail;
  /** ISO timestamp set by Graph when the user deletes the message. */
  deletedDateTime?: string | null;
}

/**
 * True when a `messageType: 'message'` row has no body content but DOES have at
 * least one attachment - a meeting card, file share, or adaptive card rather
 * than a typed message. Compared on the trimmed text representation so HTML
 * messages with only `<div></div>` wrappers are also classified as
 * attachment-only.
 */
export function isAttachmentOnly(message: RenderableMessage): boolean {
  const bodyText = (message.bodyText || "").trim();
  const bodyContent = (message.body?.content || "").trim();
  const text = bodyText.length > 0 ? bodyText : bodyContent;
  const hasAttachments =
    Array.isArray(message.attachments) && message.attachments.length > 0;
  return text.length === 0 && hasAttachments;
}

/**
 * True when this message should render via the system-event / attachment pill
 * path instead of a normal bubble.
 */
export function shouldRenderAsPill(message: RenderableMessage): boolean {
  if (message.messageType === "systemEventMessage") return true;
  return isAttachmentOnly(message);
}

/**
 * True when the message carries no useful payload at all - empty body text, no
 * attachments, not a system event. Teams emits these for reactions, deleted
 * messages, OOO auto-replies that resolve to empty bodies, and various Graph
 * chatEvent subtypes whose `messageType` is `message`. Rendering them produces a
 * blank, timestamp-only bubble; they are filtered out of the timeline.
 */
export function isNoiseMessage(message: RenderableMessage): boolean {
  if (message.messageType === "systemEventMessage") return false;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    return false;
  }
  if (message.deletedDateTime) return true;

  const bodyText = (message.bodyText || "").trim();
  if (bodyText.length > 0) return false;

  const rawContent = (message.body?.content || "").trim();
  if (rawContent.length === 0) return true;
  // Strip tags repeatedly until stable so nested/overlapping Teams custom tags
  // (`<emoji>`, `<at>`, `<attachment>`, `<systemcontent>`) all collapse.
  let stripped = rawContent;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/<[^>]+>/g, "");
  } while (stripped !== prev);
  stripped = stripped
    .replace(/&nbsp;|&#160;|&zwj;|&#8203;/gi, "")
    .replace(/\s+/g, "")
    .trim();
  return stripped.length === 0;
}

/**
 * True only when the message is a genuine typed human message worth raising a
 * "new message" notification for. This is the inverse of "the timeline would
 * drop this or render it as a pill", made explicit and slightly stricter so a
 * meeting invite never notifies:
 *
 *   - deleted              -> not worthy (tombstone)
 *   - messageType present and not "message" (systemEventMessage, chatEvent,
 *     typing, unknownFutureValue) -> not worthy. Absent messageType is treated
 *     as a normal message (older Graph payloads omit it).
 *   - eventDetail present  -> not worthy. Graph attaches eventDetail ONLY to
 *     system/meeting events (call started, meeting scheduled, members added),
 *     so it is the most reliable "this is a meeting/system event" signal even
 *     when messageType is mislabeled.
 *   - attachment-only      -> not worthy (meeting card, file share).
 *   - noise / empty body   -> not worthy.
 *
 * Everything else is a real message a human typed, and DOES notify.
 */
export function isNotificationWorthy(message: RenderableMessage): boolean {
  if (message.deletedDateTime) return false;
  if (message.messageType && message.messageType !== "message") return false;
  if (message.eventDetail) return false;
  if (isAttachmentOnly(message)) return false;
  if (isNoiseMessage(message)) return false;
  return true;
}

/** The current user's Graph identity, used to recognize self-authored messages. */
export interface SelfIdentity {
  /** Graph user id (aad object id). The stable match. */
  userId?: string | null;
  /** mail or userPrincipalName. Fallback when a payload lacks the user id. */
  email?: string | null;
}

/**
 * True when `message` was sent by the current user. A message you send is not a
 * "new message" notification for you, so the unread badge must exclude it, even
 * though the timeline still renders your own messages as your bubbles (this
 * predicate gates the notification/badge path only, never timeline rendering).
 *
 * Matches on Graph user id first (stable across display-name changes), falling
 * back to a case-insensitive email match for older payloads that omit the id.
 * With no self identity resolved, returns false (fail open: better to show a
 * possibly-self notification than to silently swallow a real one).
 */
export function isFromSelf(message: RenderableMessage, self: SelfIdentity): boolean {
  const fromId = message.from?.userId;
  if (self.userId && fromId && fromId === self.userId) return true;
  const fromEmail = message.from?.email;
  if (self.email && fromEmail && fromEmail.toLowerCase() === self.email.toLowerCase()) {
    return true;
  }
  return false;
}
