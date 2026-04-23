"use client";

/**
 * Messages — compliance-light read-only Teams chat preview.
 *
 * Left column: the user's 1:1 and group chats sorted by last-updated
 * desc, each row shows the other member's name (or topic for groups),
 * a last-message preview, a relative timestamp, an unread badge, and
 * a PresenceDot for the other party.
 *
 * Right column: the selected chat thread — last 30 messages rendered
 * from HTML body with an allow-list strip (no new deps; there is no
 * DOMPurify in package.json).
 *
 * Above the thread: three Teams deep-link actions — "Reply in Teams",
 * "Call", "Video call". Clicking any fires an analytics event and
 * opens the Teams client in a new tab (compliance: zero write scopes
 * consumed on our side).
 *
 * All data fetches go through fetchWithRefresh — never raw fetch —
 * per the April-16 blank-dashboard memory.
 *
 * Scope-missing: the API returns { scope_missing: true } when the
 * user hasn't granted Chat.Read; we render a card linking to /settings.
 * Empty-state: zero chats and M365 not connected → same settings CTA.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { fetchWithRefresh } from "@/lib/client-auth";
import PresenceDot from "@/components/PresenceDot";
import DeepLinkButton from "@/components/DeepLinkButton";

export interface ChatMember {
  id: string;
  displayName: string;
  email?: string;
  userId?: string;
}

export interface ChatSummary {
  id: string;
  topic?: string | null;
  chatType: "oneOnOne" | "group" | "meeting" | string;
  lastUpdatedDateTime: string;
  lastMessagePreview?: string;
  unreadCount?: number;
  members: ChatMember[];
  webUrl?: string;
}

export interface ChatMessage {
  id: string;
  from?: { displayName?: string };
  createdDateTime: string;
  body?: { content?: string; contentType?: "text" | "html" };
}

interface DeepLinkPayload {
  url: string;
}

/**
 * Allow-list HTML strip. No new deps — wolfpack-apex does not ship
 * DOMPurify (see package.json). We remove *all* tags and decode the
 * most common entities, keeping only text. Safe by construction:
 * there is no passthrough for <script>, <iframe>, <img onerror>,
 * `javascript:` URLs, etc.
 */
export function stripHtmlToText(html: string | undefined | null): string {
  if (!html) return "";
  // Remove script/style blocks including content.
  let s = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  // Convert <br> and </p> to newlines for readability.
  s = s.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/p\s*>/gi, "\n\n");
  // Strip every remaining tag.
  s = s.replace(/<[^>]+>/g, "");
  // Decode a few common entities.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return s.trim();
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const deltaMs = now - t;
  if (deltaMs < 0) return "just now";
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString();
}

export function getChatTitle(chat: ChatSummary, selfEmail?: string): string {
  if (chat.topic && chat.topic.trim().length > 0) return chat.topic;
  if (chat.chatType === "oneOnOne" || chat.members.length === 2) {
    const other =
      chat.members.find((m) => m.email && selfEmail && m.email.toLowerCase() !== selfEmail.toLowerCase()) ??
      chat.members[0];
    return other?.displayName ?? "Unknown";
  }
  return chat.members.map((m) => m.displayName).join(", ") || "Group chat";
}

export function getOtherMemberUserId(chat: ChatSummary, selfEmail?: string): string | null {
  const other = chat.members.find(
    (m) => m.email && selfEmail && m.email.toLowerCase() !== selfEmail.toLowerCase(),
  );
  return other?.userId ?? null;
}

interface DeepLink {
  url: string;
}

async function fetchDeepLink(
  type: "chat" | "call",
  params: Record<string, string | number>,
): Promise<DeepLink | null> {
  try {
    const res = await fetchWithRefresh("/api/ms/deep-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, ...params }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as DeepLinkPayload;
    if (typeof data?.url !== "string") return null;
    return { url: data.url };
  } catch {
    return null;
  }
}

export default function MessagesPage() {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [listScopeMissing, setListScopeMissing] = useState(false);
  const [threadScopeMissing, setThreadScopeMissing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selfEmail, setSelfEmail] = useState<string | undefined>(undefined);

  // Deep links — loaded when a chat is selected.
  const [chatDeepLink, setChatDeepLink] = useState<string | null>(null);
  const [callDeepLink, setCallDeepLink] = useState<string | null>(null);
  const [videoDeepLink, setVideoDeepLink] = useState<string | null>(null);

  // Load signed-in user email so we can identify "the other member".
  useEffect(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem("instinct_user") : null;
      if (raw) {
        const parsed = JSON.parse(raw) as { email?: string };
        if (parsed?.email) setSelfEmail(parsed.email);
      }
    } catch {
      /* noop */
    }
  }, []);

  // Load chat list.
  useEffect(() => {
    let active = true;
    setLoadingList(true);
    fetchWithRefresh("/api/ms/chats", { method: "GET" })
      .then(async (res) => {
        if (!active) return;
        const data = (await res.json().catch(() => ({}))) as {
          chats?: ChatSummary[];
          scope_missing?: boolean;
        };
        if (res.status === 401 || data?.scope_missing) {
          setListScopeMissing(true);
          setChats([]);
          return;
        }
        if (!res.ok) {
          setListError("Failed to load chats");
          setChats([]);
          return;
        }
        const sorted = (data.chats ?? []).slice().sort(
          (a, b) =>
            new Date(b.lastUpdatedDateTime).getTime() -
            new Date(a.lastUpdatedDateTime).getTime(),
        );
        setChats(sorted);
      })
      .catch(() => {
        if (active) {
          setListError("Failed to load chats");
          setChats([]);
        }
      })
      .finally(() => {
        if (active) setLoadingList(false);
      });

    // Page-viewed analytics.
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "messages" } }),
    }).catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  const selectedChat = useMemo(
    () => (chats ?? []).find((c) => c.id === selectedId) ?? null,
    [chats, selectedId],
  );

  // Load thread + deep links when selection changes.
  const loadThread = useCallback(
    async (chat: ChatSummary) => {
      setLoadingThread(true);
      setThreadScopeMissing(false);
      setMessages(null);
      setChatDeepLink(null);
      setCallDeepLink(null);
      setVideoDeepLink(null);

      try {
        const res = await fetchWithRefresh(`/api/ms/chats/${encodeURIComponent(chat.id)}`, {
          method: "GET",
        });
        const data = (await res.json().catch(() => ({}))) as {
          messages?: ChatMessage[];
          scope_missing?: boolean;
        };
        if (res.status === 401 || data?.scope_missing) {
          setThreadScopeMissing(true);
          setMessages([]);
        } else if (!res.ok) {
          setMessages([]);
        } else {
          const msgs = (data.messages ?? []).slice(-30);
          setMessages(msgs);
        }
      } catch {
        setMessages([]);
      } finally {
        setLoadingThread(false);
      }

      // Deep links in parallel — failures just leave the buttons disabled.
      const [chatDl, callDl, videoDl] = await Promise.all([
        fetchDeepLink("chat", { chatId: chat.id }),
        fetchDeepLink("call", {
          users: (chat.members.map((m) => m.email).filter(Boolean) as string[]).join(","),
          withVideo: 0,
        }),
        fetchDeepLink("call", {
          users: (chat.members.map((m) => m.email).filter(Boolean) as string[]).join(","),
          withVideo: 1,
        }),
      ]);
      setChatDeepLink(chatDl?.url ?? null);
      setCallDeepLink(callDl?.url ?? null);
      setVideoDeepLink(videoDl?.url ?? null);
    },
    [],
  );

  function selectChat(chat: ChatSummary) {
    setSelectedId(chat.id);
    void loadThread(chat);
  }

  function clearSelection() {
    setSelectedId(null);
    setMessages(null);
  }

  // Render --------------------------------------------------------------

  if (loadingList) {
    return (
      <div data-testid="messages-loading" style={{ padding: 24 }}>
        Loading messages…
      </div>
    );
  }

  if (listScopeMissing) {
    return (
      <div data-testid="messages-scope-missing" style={{ padding: 24 }}>
        <div style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Grant Chat.Read to Instinct</h2>
          <p>
            To see your Teams messages inline, grant the <code>Chat.Read</code> permission.
          </p>
          <Link href="/settings" style={linkButtonStyle} data-testid="messages-scope-cta">
            Open settings
          </Link>
        </div>
      </div>
    );
  }

  if ((chats ?? []).length === 0) {
    return (
      <div data-testid="messages-empty" style={{ padding: 24 }}>
        <div style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Connect Microsoft 365</h2>
          <p>Connect Microsoft 365 to see your Teams chats.</p>
          <Link href="/settings" style={linkButtonStyle} data-testid="messages-empty-cta">
            Open settings
          </Link>
          {listError ? (
            <p style={{ color: "#b91c1c", marginTop: 12 }} data-testid="messages-list-error">
              {listError}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const isMobileThreadView = selectedChat !== null;

  return (
    <div data-testid="messages-page" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 24px 8px" }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Messages</h1>
        <p style={{ margin: "4px 0 0", color: "#6b7280", fontSize: 13 }}>
          Read-only preview of your Teams chats. Reply, call, and video call open Teams.
        </p>
      </div>

      <div
        data-testid="messages-split"
        style={{
          display: "flex",
          flexDirection: "row",
          flex: 1,
          minHeight: 0,
          borderTop: "1px solid #e5e7eb",
        }}
      >
        {/* Chat list column. On mobile, hidden when a chat is selected. */}
        <aside
          data-testid="messages-list"
          data-mobile-hidden={isMobileThreadView ? "true" : "false"}
          style={{
            width: 320,
            borderRight: "1px solid #e5e7eb",
            overflowY: "auto",
            background: "#fff",
          }}
          className={isMobileThreadView ? "msg-list-hidden-mobile" : "msg-list-shown-mobile"}
        >
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {(chats ?? []).map((chat) => {
              const title = getChatTitle(chat, selfEmail);
              const otherUserId = getOtherMemberUserId(chat, selfEmail);
              const isSelected = chat.id === selectedId;
              return (
                <li key={chat.id}>
                  <button
                    type="button"
                    onClick={() => selectChat(chat)}
                    data-testid={`chat-row-${chat.id}`}
                    data-selected={isSelected ? "true" : "false"}
                    style={{
                      display: "flex",
                      width: "100%",
                      textAlign: "left",
                      padding: "12px 16px",
                      border: "none",
                      borderBottom: "1px solid #f3f4f6",
                      background: isSelected ? "#eef2ff" : "transparent",
                      cursor: "pointer",
                      gap: 10,
                      alignItems: "flex-start",
                    }}
                  >
                    <div style={{ paddingTop: 4 }}>
                      {otherUserId ? <PresenceDot userId={otherUserId} /> : null}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 8,
                          alignItems: "baseline",
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 14,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {title}
                        </span>
                        <span style={{ fontSize: 11, color: "#6b7280", flex: "0 0 auto" }}>
                          {formatRelativeTime(chat.lastUpdatedDateTime)}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span
                          style={{
                            color: "#4b5563",
                            fontSize: 13,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                          }}
                          data-testid={`chat-preview-${chat.id}`}
                        >
                          {chat.lastMessagePreview ?? ""}
                        </span>
                        {chat.unreadCount && chat.unreadCount > 0 ? (
                          <span
                            data-testid={`chat-unread-${chat.id}`}
                            style={{
                              background: "#2563eb",
                              color: "#fff",
                              fontSize: 11,
                              fontWeight: 600,
                              borderRadius: 999,
                              padding: "2px 8px",
                              minWidth: 20,
                              textAlign: "center",
                            }}
                          >
                            {chat.unreadCount}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* Thread column */}
        <section
          data-testid="messages-thread"
          style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}
        >
          {!selectedChat ? (
            <div
              data-testid="messages-no-selection"
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#6b7280",
                padding: 24,
                textAlign: "center",
              }}
            >
              Select a chat to preview the conversation.
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "12px 16px",
                  borderBottom: "1px solid #e5e7eb",
                  background: "#fafafa",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button
                    type="button"
                    onClick={clearSelection}
                    data-testid="messages-back"
                    style={{
                      border: "1px solid #d1d5db",
                      background: "#fff",
                      borderRadius: 6,
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    ← Back
                  </button>
                  <span style={{ fontWeight: 600 }}>
                    {getChatTitle(selectedChat, selfEmail)}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <DeepLinkButton
                    url={chatDeepLink ?? ""}
                    analyticsType="reply"
                    disabled={!chatDeepLink}
                    testId="deep-link-reply"
                    className="dl-btn dl-btn-primary"
                  >
                    Reply in Teams
                  </DeepLinkButton>
                  <DeepLinkButton
                    url={callDeepLink ?? ""}
                    analyticsType="call"
                    disabled={!callDeepLink}
                    testId="deep-link-call"
                    className="dl-btn"
                  >
                    Call
                  </DeepLinkButton>
                  <DeepLinkButton
                    url={videoDeepLink ?? ""}
                    analyticsType="video"
                    disabled={!videoDeepLink}
                    testId="deep-link-video"
                    className="dl-btn"
                  >
                    Video call
                  </DeepLinkButton>
                </div>
              </div>

              <div
                data-testid="messages-thread-body"
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: 16,
                  background: "#fff",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                {loadingThread ? (
                  <div data-testid="messages-thread-loading" style={{ color: "#6b7280" }}>
                    Loading…
                  </div>
                ) : threadScopeMissing ? (
                  <div data-testid="messages-thread-scope-missing" style={cardStyle}>
                    <p style={{ marginTop: 0 }}>
                      Grant <code>Chat.Read</code> in settings to preview this thread.
                    </p>
                    <Link href="/settings" style={linkButtonStyle}>
                      Open settings
                    </Link>
                  </div>
                ) : (messages ?? []).length === 0 ? (
                  <div style={{ color: "#6b7280" }}>No messages in this chat.</div>
                ) : (
                  (messages ?? []).map((m) => {
                    const text =
                      m.body?.contentType === "text"
                        ? m.body?.content ?? ""
                        : stripHtmlToText(m.body?.content);
                    return (
                      <div
                        key={m.id}
                        data-testid={`message-${m.id}`}
                        style={{
                          background: "#f9fafb",
                          border: "1px solid #e5e7eb",
                          borderRadius: 8,
                          padding: "8px 12px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 12,
                            color: "#6b7280",
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          <span>{m.from?.displayName ?? "Unknown"}</span>
                          <span>{formatRelativeTime(m.createdDateTime)}</span>
                        </div>
                        <div style={{ fontSize: 14, whiteSpace: "pre-wrap", marginTop: 4 }}>
                          {text}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  padding: 20,
  background: "#fff",
  maxWidth: 520,
};

const linkButtonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "8px 14px",
  background: "#2563eb",
  color: "#fff",
  borderRadius: 6,
  textDecoration: "none",
  fontSize: 14,
};
