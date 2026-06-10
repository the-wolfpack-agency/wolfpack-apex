/**
 * Renderers for non-text Teams chatMessages.
 *
 * Two surfaces here:
 *   1. SystemEventPill — `messageType: 'systemEventMessage'`. These
 *      are call-started / call-ended / member-added / topic-updated
 *      etc. notifications Graph emits inline with user messages.
 *      Without a dedicated renderer they show up as empty bubbles
 *      with only a timestamp ("15h" with no body — the bug we're
 *      fixing).
 *   2. AttachmentSummaryPill — regular `messageType: 'message'` rows
 *      whose `body.content` is empty but whose `attachments[]` is
 *      not. Meeting cards, file shares, code snippets, adaptive
 *      cards. Same blank-bubble symptom; same fix.
 *
 * Both render as plain-language pills, never developer jargon. Copy
 * follows `feedback_non_technical_ui` — a dealer / business user
 * reads "Call ended" or "Ashley joined the chat", not
 * `callEndedEventMessageDetail`.
 *
 * Both fire analytics events (`messages.system_event_rendered` /
 * `messages.attachment_summary_rendered`) so the learning loop ranks
 * which subtypes / attachment kinds are most common — that drives
 * the renderer roadmap (we'll invest in first-class renderers for
 * the busiest kinds first).
 */

"use client";

import { useEffect } from "react";
import type {
  ChatMessageEventDetail,
  ChatMessageAttachment,
} from "@/lib/ms-graph-chats";
import { fetchWithRefresh } from "@/lib/client-auth";

/**
 * Renderer-shaped subset of `ChatMessage`. Accepts both the lib's
 * strict `ChatMessage` (where `from` is required) and the page's
 * looser local interface (where `from` may be undefined). Renderers
 * only need `id`, `from.displayName`, attachments, and event detail —
 * not the strict identity set — so this widening is safe.
 */
export interface RenderableMessage {
  id: string;
  from?: { displayName?: string };
  bodyText?: string;
  body?: { content?: string; contentType?: string };
  messageType?: string;
  attachments?: ChatMessageAttachment[];
  eventDetail?: ChatMessageEventDetail;
  /** ISO timestamp set by Graph when the user deletes the message. */
  deletedDateTime?: string | null;
}

/**
 * Plain-language phrasing for each known Graph systemEvent subtype.
 * Returns `{ icon, text }`. Unknown subtypes fall back to a generic
 * "System event" pill so the bubble is never empty.
 */
export function describeSystemEvent(
  detail: ChatMessageEventDetail | undefined,
): { icon: string; text: string; subtype: string } {
  const subtype = detail?.subtype ?? "unknown";
  const names = detail?.memberNames ?? [];
  const initiator = detail?.initiatorName;
  const who = names.length > 0 ? humanJoin(names) : "Someone";
  const newTopic = detail?.newTopic;

  switch (subtype) {
    case "callStarted":
      return { icon: "📞", text: "Call started", subtype };
    case "callEnded":
      return { icon: "📞", text: "Call ended", subtype };
    case "callRecording":
      return { icon: "⏺", text: "Call recording started", subtype };
    case "meetingStarted":
      return { icon: "📹", text: "Meeting started", subtype };
    case "meetingEnded":
      return { icon: "📹", text: "Meeting ended", subtype };
    case "membersAdded":
      return {
        icon: "👤",
        text:
          names.length === 1
            ? `${who} joined the chat`
            : `${who} joined the chat`,
        subtype,
      };
    case "membersDeleted":
      return {
        icon: "👤",
        text:
          names.length === 1
            ? `${who} left the chat`
            : `${who} left the chat`,
        subtype,
      };
    case "topicUpdated":
    case "chatRenamed":
      return {
        icon: "✏️",
        text: newTopic
          ? `Topic updated to "${newTopic}"`
          : `${initiator ?? "Someone"} updated the topic`,
        subtype,
      };
    case "historyDisclosed":
      return { icon: "📜", text: "Chat history is now visible to new members", subtype };
    case "tabAdded":
      return { icon: "📌", text: "A tab was added to the chat", subtype };
    case "tabRemoved":
      return { icon: "📌", text: "A tab was removed from the chat", subtype };
    default:
      return { icon: "ℹ️", text: "System event", subtype };
  }
}

/**
 * Plain-language label for a Graph attachment contentType. The Graph
 * vocabulary is wide; this maps the common shapes to human copy.
 */
export function describeAttachment(
  attachment: ChatMessageAttachment,
): { icon: string; text: string; kind: string } {
  const ct = (attachment.contentType || "").toLowerCase();
  const name = attachment.name?.trim();

  if (ct.includes("messagereference")) {
    return { icon: "💬", text: name || "Quoted reply", kind: "messageReference" };
  }
  if (ct.includes("card.adaptive")) {
    return { icon: "🧩", text: name || "Adaptive card", kind: "adaptiveCard" };
  }
  if (ct.includes("card.codesnippet")) {
    return { icon: "💻", text: name || "Code snippet", kind: "codeSnippet" };
  }
  if (ct.includes("card.meeting") || ct.includes("meetingreference")) {
    return { icon: "📅", text: name || "Meeting", kind: "meetingCard" };
  }
  if (ct.includes("file.download") || ct.includes("teams.file") || ct === "reference") {
    return { icon: "📎", text: name || "File shared", kind: "fileReference" };
  }
  if (ct.includes("image")) {
    return { icon: "🖼️", text: name || "Image", kind: "image" };
  }
  return { icon: "📎", text: name || "Attachment", kind: ct || "unknown" };
}

/** Format a list of names as "A", "A and B", "A, B and C". */
function humanJoin(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * True when a `messageType: 'message'` row has no body content but DOES
 * have at least one attachment — render as AttachmentSummaryPill in
 * that case. We compare on the trimmed text representation so HTML
 * messages with only `<div></div>` wrappers (Teams pads thread starts
 * this way) are also classified as attachment-only.
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
 * True when this message should render via the system-event / attachment
 * pill path instead of the normal bubble. Keeps the page-level branch
 * tiny — page calls `shouldRenderAsPill(m)` and dispatches.
 */
export function shouldRenderAsPill(message: RenderableMessage): boolean {
  if (message.messageType === "systemEventMessage") return true;
  return isAttachmentOnly(message);
}

/**
 * True when the message carries no useful payload at all — empty body
 * text, no attachments, not a system event. Teams emits these for
 * reactions, deleted messages, OOO auto-replies that resolve to empty
 * bodies, and various Graph chatEvent subtypes whose `messageType` is
 * `message` (not `systemEventMessage`). Rendering them as a normal
 * bubble produces a noise row with only a timestamp ("21h" / "5/11/2026")
 * and no content — every dealer who looked at the inbox flagged this
 * as broken. Filter them out at the page level.
 *
 * NOTE: we intentionally only call this BEFORE the pill check so
 * legitimate system events + attachments still render. Only truly
 * empty rows are dropped.
 */
export function isNoiseMessage(message: RenderableMessage): boolean {
  if (message.messageType === "systemEventMessage") return false;
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    return false;
  }
  /* Graph sets `deletedDateTime` when the sender deletes the message.
     The body usually becomes `<div></div>` but the deletion itself is
     the canonical signal. Treat as noise regardless of body content. */
  if (message.deletedDateTime) return true;

  /* `bodyText` is parser-extracted plain text — set in
     normalizeBody via htmlToText. If it has content, the user sees
     something readable; not noise. */
  const bodyText = (message.bodyText || "").trim();
  if (bodyText.length > 0) return false;

  /* Fallback for callers that don't pre-populate bodyText (older
     fixtures, hand-built RenderableMessages). Strip ALL HTML tags +
     entities + whitespace; if nothing remains, the bubble would be
     blank. We use a broad `<[^>]+>` strip rather than the narrow
     div/p/br/span pattern so Teams custom tags (`<emoji>`, `<at>`,
     `<attachment>`, `<systemcontent>`, `<itemmention>`) are also
     handled — those caused the 2026-06-01 blank-bubble screenshot. */
  const rawContent = (message.body?.content || "").trim();
  if (rawContent.length === 0) return true;
  /* Strip tags repeatedly until stable: a single pass over `<[^>]+>`
     leaves a residual `<tag` when tags are nested or overlapping
     (e.g. `<a<b>>`), so loop to a fixed point. */
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
 * Fire a server-side analytics POST without a hard `await` — the
 * callers are inside React render bodies and must never block.
 */
function fireRendererAnalytics(
  event: "messages.system_event_rendered" | "messages.attachment_summary_rendered",
  metadata: Record<string, string | number | boolean>,
): void {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, metadata }),
  }).catch(() => undefined);
}

interface SystemEventPillProps {
  message: RenderableMessage;
  /** Pre-formatted relative time ("15h"). Page owns formatting. */
  relativeTime: string;
}

/**
 * Centered pill for `systemEventMessage`. Fires
 * `messages.system_event_rendered` once per render so the learning
 * loop sees subtype distribution.
 */
export function SystemEventPill({ message, relativeTime }: SystemEventPillProps) {
  const { icon, text, subtype } = describeSystemEvent(message.eventDetail);

  useEffect(() => {
    fireRendererAnalytics("messages.system_event_rendered", { subtype });
    // Subtype is stable per message id; firing once per mount is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id]);

  return (
    <div
      data-testid={`system-event-${message.id}`}
      data-subtype={subtype}
      style={{
        alignSelf: "center",
        maxWidth: "80%",
        padding: "4px 12px",
        background: "var(--wp-dark-surface2, #222)",
        border: "1px solid var(--wp-dark-border, #333)",
        borderRadius: 999,
        color: "var(--wp-text-muted, #9ca3af)",
        fontSize: 12,
        textAlign: "center",
      }}
    >
      <span aria-hidden="true" style={{ marginRight: 6 }}>
        {icon}
      </span>
      <span>{text}</span>
      <span style={{ margin: "0 6px", opacity: 0.6 }}>·</span>
      <span>{relativeTime}</span>
    </div>
  );
}

interface AttachmentSummaryPillProps {
  message: RenderableMessage;
  relativeTime: string;
}

/**
 * Compact pill summarizing an attachment-only message ("📎 budget.xlsx
 * · 15h"). Fires `messages.attachment_summary_rendered` so the
 * learning loop sees which attachment kinds dominate.
 */
export function AttachmentSummaryPill({
  message,
  relativeTime,
}: AttachmentSummaryPillProps) {
  const first = message.attachments?.[0];
  const summary = first
    ? describeAttachment(first)
    : { icon: "📎", text: "Attachment", kind: "unknown" };
  const extra =
    (message.attachments?.length ?? 0) > 1
      ? ` (+${(message.attachments?.length ?? 0) - 1} more)`
      : "";

  useEffect(() => {
    fireRendererAnalytics("messages.attachment_summary_rendered", {
      attachment_kind: summary.kind,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id]);

  return (
    <div
      data-testid={`attachment-summary-${message.id}`}
      data-attachment-kind={summary.kind}
      style={{
        alignSelf: "flex-start",
        maxWidth: "80%",
        padding: "8px 12px",
        background: "var(--wp-dark-surface2, #222)",
        border: "1px solid var(--wp-dark-border, #333)",
        borderRadius: 8,
        color: "var(--wp-text, #eee)",
        fontSize: 13,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--wp-text-muted, #9ca3af)",
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ fontWeight: 600 }}>
          {message.from?.displayName ?? "Unknown"}
        </span>
        <span>{relativeTime}</span>
      </div>
      <div style={{ marginTop: 2 }}>
        <span aria-hidden="true" style={{ marginRight: 6 }}>
          {summary.icon}
        </span>
        <span>
          {summary.text}
          {extra}
        </span>
      </div>
    </div>
  );
}
