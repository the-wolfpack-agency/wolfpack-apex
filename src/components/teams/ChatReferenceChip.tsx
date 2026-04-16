import { fetchWithRefresh } from "@/lib/client-auth";
"use client";

/**
 * ChatReferenceChip — compact visual reference to a Teams chat.
 *
 * Fetches the chat from /api/teams/chats cache by local id + renders
 * "Teams: <topic or participant> / N participants" with a Teams deep
 * link. Designed to be embedded in Assistant answers, briefing blocks,
 * and anywhere a Teams chat is referenced in the UI.
 *
 * On load error (404, unauthorized, scope_missing) the chip renders a
 * muted placeholder so it never breaks the surrounding layout.
 */

import { useEffect, useState } from "react";

export interface ChatReferenceChipProps {
  chatId: string;
  /** Inline style color overrides — keeps the chip portable. */
  className?: string;
  /** Pass `getToken()` from the app shell if you don't use localStorage. */
  getAuthHeader?: () => string | null;
}

interface ChatShape {
  id: string;
  msChatId: string;
  topic: string | null;
  chatType: string;
  participants: { displayName: string; email?: string }[];
}

function defaultAuth(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const t = window.localStorage.getItem("instinct_token");
    return t ? `Bearer ${t}` : null;
  } catch {
    return null;
  }
}

export default function ChatReferenceChip({
  chatId,
  className,
  getAuthHeader,
}: ChatReferenceChipProps) {
  const [chat, setChat] = useState<ChatShape | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "missing" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const auth = (getAuthHeader ?? defaultAuth)();
        const res = await fetchWithRefresh(`/api/teams/chats/${encodeURIComponent(chatId)}/messages?limit=1`, {
          headers: auth ? { authorization: auth } : undefined,
        });
        if (cancelled) return;
        if (res.status === 404) {
          setStatus("missing");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const data = (await res.json()) as { chat?: ChatShape };
        if (data.chat) {
          setChat(data.chat);
          setStatus("ok");
        } else {
          setStatus("missing");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [chatId, getAuthHeader]);

  if (status === "loading") {
    return (
      <span
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 8px",
          borderRadius: 12,
          background: "#eef2ff",
          color: "#4338ca",
          fontSize: 12,
        }}
        aria-label="Loading Teams chat"
      >
        Teams: loading…
      </span>
    );
  }

  if (status === "missing" || status === "error" || !chat) {
    return (
      <span
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 8px",
          borderRadius: 12,
          background: "#f3f4f6",
          color: "#6b7280",
          fontSize: 12,
        }}
        aria-label="Teams chat unavailable"
      >
        Teams: unavailable
      </span>
    );
  }

  const title =
    chat.topic ||
    (chat.participants[0]?.displayName ?? "Chat");
  const participantCount = chat.participants.length;
  const teamsUrl = `https://teams.microsoft.com/l/chat/0/0?chatId=${encodeURIComponent(chat.msChatId)}`;

  return (
    <a
      href={teamsUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 12,
        background: "#eef2ff",
        color: "#4338ca",
        fontSize: 12,
        textDecoration: "none",
      }}
      aria-label={`Open Teams chat ${title}`}
    >
      <span>Teams: {title}</span>
      <span style={{ opacity: 0.7 }}>
        / {participantCount} participant{participantCount === 1 ? "" : "s"}
      </span>
    </a>
  );
}
