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
// Pure classification predicates live in a server-safe module so the
// unread-count route can share them. Re-exported below to keep the existing
// `@/lib/messages/system-event-renderer` import surface stable.
import {
  type RenderableMessage,
  isAttachmentOnly,
  shouldRenderAsPill,
  isNoiseMessage,
} from "@/lib/messages/message-classify";

export type { RenderableMessage };
export { isAttachmentOnly, shouldRenderAsPill, isNoiseMessage };

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
