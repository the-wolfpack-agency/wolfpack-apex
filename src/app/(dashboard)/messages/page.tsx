"use client";

/**
 * Messages — Teams chat preview + inline compose.
 *
 * Left column: the user's 1:1 and group chats sorted by last-updated
 * desc, each row shows the other member's name (or topic for groups),
 * a last-message preview, a relative timestamp, an unread badge, and
 * a PresenceDot for the other party.
 *
 * Right column: the selected chat thread — last 30 messages rendered
 * from HTML body with an allow-list strip (no new deps; there is no
 * DOMPurify in package.json). Below the thread sits the inline
 * composer that POSTs to /api/ms/chats/[id]/messages. Reply-in-Teams /
 * Call / Video deep-links are tucked into a small "More actions" row
 * below the composer — secondary, no longer primary.
 *
 * All data fetches go through fetchWithRefresh — never raw fetch —
 * per the April-16 blank-dashboard memory.
 *
 * Permission handling:
 *   - Read scope missing on list → `messages-scope-missing` card.
 *   - Read scope missing on thread → `messages-thread-scope-missing`.
 *   - Write scope missing (Chat.ReadWrite) → inline hint under the
 *     composer linking to /settings. Optimistic message is removed.
 *   - Write disabled by workspace flag → inline hint pointing at the
 *     "Reply in Teams" deep-link. Optimistic removed.
 *   - 5xx / network → transient error toast, optimistic rolled back.
 *
 * Analytics fired: messages.compose_sent, messages.compose_failed,
 * messages.scope_prompt_shown, messages.write_disabled_shown.
 */

import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
  KeyboardEvent,
  ChangeEvent,
} from "react";
import Link from "next/link";
import { fetchWithRefresh, getInstinctUser } from "@/lib/client-auth";
import PresenceDot from "@/components/PresenceDot";
import DeepLinkButton from "@/components/DeepLinkButton";

export interface ChatMember {
  id: string;
  displayName: string;
  email?: string;
  userId?: string;
}

/**
 * Shape of `lastMessagePreview` as it actually arrives from
 * /api/ms/chats (which proxies Microsoft Graph). Graph returns this
 * as an object whose `createdDateTime` is the *real* "last activity"
 * timestamp — `chat.lastUpdatedDateTime` only changes on member /
 * topic edits and does NOT bump per-message.
 *
 * We accept the legacy string form too so existing test fixtures
 * (and any cached JSON in users' Service Worker) keep working — the
 * `previewTextOf` / `previewTimeOf` helpers below normalise.
 */
export type ChatLastMessagePreview =
  | string
  | {
      body?: { contentType?: string; content?: string };
      bodyText?: string;
      from?: { displayName?: string; userId?: string; email?: string };
      createdDateTime?: string;
    };

export function previewTextOf(p: ChatLastMessagePreview | undefined): string {
  if (!p) return "";
  if (typeof p === "string") return p;
  return p.bodyText ?? p.body?.content ?? "";
}

export function previewTimeOf(p: ChatLastMessagePreview | undefined): string {
  if (!p || typeof p === "string") return "";
  return p.createdDateTime ?? "";
}

/**
 * The timestamp users actually want to see in the LEFT panel: when
 * was the last message in this chat? Falls back to lastUpdatedDateTime
 * only if the preview is missing or string-shaped (legacy).
 */
export function effectiveChatTimestamp(chat: {
  lastUpdatedDateTime: string;
  lastMessagePreview?: ChatLastMessagePreview;
}): string {
  return previewTimeOf(chat.lastMessagePreview) || chat.lastUpdatedDateTime;
}

export interface ChatSummary {
  id: string;
  topic?: string | null;
  chatType: "oneOnOne" | "group" | "meeting" | string;
  lastUpdatedDateTime: string;
  lastMessagePreview?: ChatLastMessagePreview;
  unreadCount?: number;
  members: ChatMember[];
  webUrl?: string;
}

export interface ChatMessage {
  id: string;
  from?: { displayName?: string };
  createdDateTime: string;
  body?: { content?: string; contentType?: "text" | "html" };
  /**
   * Set to "me" on optimistic messages appended by the composer before
   * the server round-trip resolves. Allows the UI to distinguish
   * pending local writes from server-confirmed ones.
   */
  role?: "me" | "other";
  /**
   * True while the optimistic POST is inflight. Flipped false (or the
   * whole message is swapped for the server response) on resolution.
   */
  pending?: boolean;
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

function isSelfMember(
  m: { email?: string; displayName?: string; userId?: string },
  selfEmail?: string,
  selfName?: string,
  selfId?: string,
): boolean {
  // userId (Graph object id) is the strongest identity — stable across
  // email/UPN changes. Match on it first.
  if (selfId && m.userId && m.userId === selfId) return true;
  if (selfEmail && m.email && m.email.toLowerCase() === selfEmail.toLowerCase()) {
    return true;
  }
  if (selfName && m.displayName && m.displayName.toLowerCase() === selfName.toLowerCase()) {
    return true;
  }
  return false;
}

export function getChatTitle(
  chat: ChatSummary,
  selfEmail?: string,
  selfName?: string,
  selfId?: string,
): string {
  if (chat.topic && chat.topic.trim().length > 0) return chat.topic;
  const knowSelf = Boolean(selfId || selfEmail || selfName);
  if (chat.chatType === "oneOnOne" || chat.members.length === 2) {
    const other = knowSelf
      ? (chat.members.find((m) => !isSelfMember(m, selfEmail, selfName, selfId)) ??
          chat.members[chat.members.length - 1])
      : chat.members[chat.members.length - 1];
    return other?.displayName ?? "Unknown";
  }
  const others = chat.members.filter((m) => !isSelfMember(m, selfEmail, selfName, selfId));
  return (others.length > 0 ? others : chat.members)
    .map((m) => m.displayName)
    .join(", ") || "Group chat";
}

export function getOtherMemberUserId(
  chat: ChatSummary,
  selfEmail?: string,
  selfName?: string,
  selfId?: string,
): string | null {
  const other = chat.members.find((m) => !isSelfMember(m, selfEmail, selfName, selfId));
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

/**
 * Fire-and-forget analytics helper — never blocks the UI, never throws.
 * Centralised so every compose call-site stays consistent with the
 * event-registry comments in `src/lib/analytics.ts`.
 */
function fireAnalytics(
  event:
    | "messages.compose_sent"
    | "messages.compose_failed"
    | "messages.scope_prompt_shown"
    | "messages.write_disabled_shown",
  metadata: Record<string, string | number | boolean>,
): void {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, metadata }),
  }).catch(() => undefined);
}

type ComposeHint = "scope_missing" | "write_disabled" | null;

export default function MessagesPage() {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [listScopeMissing, setListScopeMissing] = useState(false);
  const [threadScopeMissing, setThreadScopeMissing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // Resolve self identity synchronously so the first render already
  // knows which member of each 1:1 chat is "the other person".
  // Previously this was loaded in a useEffect after mount, so every
  // chat briefly (and in some cases permanently) rendered the caller's
  // own name as the title.
  const selfUserInit = (() => {
    const u = getInstinctUser<{ email?: string; name?: string }>();
    return {
      email: u?.email,
      name: u?.name,
    };
  })();
  const [selfEmail, setSelfEmail] = useState<string | undefined>(selfUserInit.email);
  const [selfName, setSelfName] = useState<string | undefined>(selfUserInit.name);
  const [selfId, setSelfId] = useState<string | undefined>(undefined);

  // Mobile responsive: at <640px widths, show either the list OR the
  // thread, not both. Desktop (>=640px) keeps the split view.
  const [isMobile, setIsMobile] = useState<boolean>(
    typeof window !== "undefined" ? window.innerWidth < 640 : false,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onResize() {
      setIsMobile(window.innerWidth < 640);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Deep links — loaded when a chat is selected.
  const [chatDeepLink, setChatDeepLink] = useState<string | null>(null);
  const [callDeepLink, setCallDeepLink] = useState<string | null>(null);
  const [videoDeepLink, setVideoDeepLink] = useState<string | null>(null);

  // Compose state — scoped per selected chat.
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composeHint, setComposeHint] = useState<ComposeHint>(null);
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null);

  // Thread auto-scroll: every chat app pins the newest message at the
  // bottom of the thread and snaps the viewport down on send / new
  // arrival. We do the same — ref points at a sentinel after the last
  // message and an effect scrolls it into view whenever `messages`
  // changes.
  const threadEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    threadEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages]);

  // Belt-and-suspenders: re-read identity after mount in case the
  // initializer ran before the session was hydrated (rare but possible
  // during SSR → CSR handoff).
  useEffect(() => {
    const u = getInstinctUser<{ email?: string; name?: string }>();
    if (u?.email && u.email !== selfEmail) setSelfEmail(u.email);
    if (u?.name && u.name !== selfName) setSelfName(u.name);
  }, [selfEmail, selfName]);

  // Auto-dismiss the transient error toast after 4s.
  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(h);
  }, [toast]);

  // Load chat list — extracted into a callback so it can run on
  // mount, on window focus (returning from Teams desktop), and on a
  // 30s poll. Without these the LEFT panel timestamps go stale: we
  // saw "1d" on a chat that had been messaged a minute before.
  const loadChatList = useCallback(
    async (opts: { showSpinner?: boolean } = {}) => {
      if (opts.showSpinner) setLoadingList(true);
      try {
        const res = await fetchWithRefresh("/api/ms/chats", { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as {
          chats?: ChatSummary[];
          scope_missing?: boolean;
          self_email?: string;
          self_name?: string;
          self_id?: string;
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
        // The MS identity from instinct_ms_tokens is authoritative for
        // "who is the caller in Graph terms" — the Instinct session
        // email can differ (e.g. login = cto@wolfpack.dev, MS email =
        // homyk@thewolfpack.agency for the CTO). Overwrite selfEmail with
        // whichever the server tells us, which is the one Graph uses.
        // Graph /me values are authoritative. userId is the strongest
        // signal (stable across email/UPN changes).
        if (data.self_email) setSelfEmail(data.self_email);
        if (data.self_name) setSelfName(data.self_name);
        if (data.self_id) setSelfId(data.self_id);
        const sorted = (data.chats ?? []).slice().sort(
          (a, b) =>
            new Date(effectiveChatTimestamp(b)).getTime() -
            new Date(effectiveChatTimestamp(a)).getTime(),
        );
        setChats(sorted);
      } catch {
        setListError("Failed to load chats");
        setChats([]);
      } finally {
        if (opts.showSpinner) setLoadingList(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadChatList({ showSpinner: true });

    // Page-viewed analytics.
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "messages" } }),
    }).catch(() => undefined);
  }, [loadChatList]);

  // Refresh on window focus (user came back from Teams desktop) and
  // on a 30s poll while the page is visible. Don't show the spinner
  // for these — they should feel ambient, not like a reload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocus = () => void loadChatList();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadChatList();
      }
    }, 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, [loadChatList]);

  const selectedChat = useMemo(
    () => (chats ?? []).find((c) => c.id === selectedId) ?? null,
    [chats, selectedId],
  );

  // Fire scope_prompt_shown / write_disabled_shown exactly when the
  // corresponding hint surfaces. Keeps the per-render fire dedup'd via
  // the (hint, chat) pair.
  const lastHintFiredRef = useRef<{ chatId: string; hint: ComposeHint } | null>(null);
  useEffect(() => {
    if (!selectedChat || !composeHint) return;
    const last = lastHintFiredRef.current;
    if (last && last.chatId === selectedChat.id && last.hint === composeHint) return;
    lastHintFiredRef.current = { chatId: selectedChat.id, hint: composeHint };
    if (composeHint === "scope_missing") {
      fireAnalytics("messages.scope_prompt_shown", { chat_id: selectedChat.id });
    } else if (composeHint === "write_disabled") {
      fireAnalytics("messages.write_disabled_shown", { chat_id: selectedChat.id });
    }
  }, [composeHint, selectedChat]);

  // Load thread + deep links when selection changes.
  const loadThread = useCallback(
    async (chat: ChatSummary) => {
      setLoadingThread(true);
      setThreadScopeMissing(false);
      setMessages(null);
      setChatDeepLink(null);
      setCallDeepLink(null);
      setVideoDeepLink(null);
      setDraft("");
      setComposeHint(null);
      setSending(false);

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
          // Microsoft Graph returns chat messages newest-first
          // (descending by createdDateTime). Sort ASCENDING so the
          // oldest sits at the top of the thread and newest at the
          // bottom — matching every chat app users know (Teams,
          // iMessage, Slack, WhatsApp). Then slice the most-recent
          // 30 off the END, which preserves chronological order.
          const msgs = (data.messages ?? [])
            .slice()
            .sort(
              (a, b) =>
                new Date(a.createdDateTime ?? 0).getTime() -
                new Date(b.createdDateTime ?? 0).getTime(),
            )
            .slice(-30);
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
    setDraft("");
    setComposeHint(null);
  }

  // Compose --------------------------------------------------------------

  const sendCompose = useCallback(async () => {
    if (!selectedChat) return;
    const trimmed = draft.trim();
    if (trimmed.length === 0 || sending) return;

    const chatId = selectedChat.id;
    const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: ChatMessage = {
      id: optimisticId,
      from: { displayName: "You" },
      createdDateTime: new Date().toISOString(),
      body: { contentType: "text", content: trimmed },
      role: "me",
      pending: true,
    };

    setSending(true);
    setComposeHint(null);
    setMessages((prev) => [...(prev ?? []), optimistic]);
    setDraft("");

    try {
      const res = await fetchWithRefresh(
        `/api/ms/chats/${encodeURIComponent(chatId)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: trimmed, contentType: "text" }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        createdDateTime?: string;
        body?: { content?: string; contentType?: "text" | "html" };
        from?: { displayName?: string };
        scope_missing?: boolean;
        write_disabled?: boolean;
      };

      if (data?.scope_missing) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== optimisticId));
        setComposeHint("scope_missing");
        setDraft(trimmed);
        fireAnalytics("messages.compose_failed", {
          chat_id: chatId,
          reason: "scope_missing",
        });
        return;
      }
      if (data?.write_disabled) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== optimisticId));
        setComposeHint("write_disabled");
        setDraft(trimmed);
        fireAnalytics("messages.compose_failed", {
          chat_id: chatId,
          reason: "write_disabled",
        });
        return;
      }
      if (!res.ok) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== optimisticId));
        setDraft(trimmed);
        setToast({ key: Date.now(), text: "Couldn't send. Try again." });
        fireAnalytics("messages.compose_failed", {
          chat_id: chatId,
          reason: `http_${res.status ?? 0}`,
        });
        return;
      }

      // Success: swap optimistic → server response.
      const server: ChatMessage = {
        id: data.id ?? optimisticId,
        from: data.from ?? { displayName: "You" },
        createdDateTime: data.createdDateTime ?? optimistic.createdDateTime,
        body:
          data.body && (data.body.content ?? "").length > 0
            ? data.body
            : { contentType: "text", content: trimmed },
        role: "me",
        pending: false,
      };
      setMessages((prev) =>
        (prev ?? []).map((m) => (m.id === optimisticId ? server : m)),
      );

      // Bump this chat's row in the LEFT list so the timestamp +
      // preview match what we just sent. We update BOTH the legacy
      // lastUpdatedDateTime (so old code paths see fresh data) AND
      // the lastMessagePreview object — the latter is what
      // `effectiveChatTimestamp` actually reads. Re-sort so the
      // freshly-bumped row floats to the top.
      const sentAt = server.createdDateTime ?? new Date().toISOString();
      setChats((prev) =>
        (prev ?? [])
          .map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  lastUpdatedDateTime: sentAt,
                  lastMessagePreview: {
                    bodyText: trimmed.slice(0, 140),
                    body: { contentType: "text", content: trimmed },
                    from: { displayName: "You" },
                    createdDateTime: sentAt,
                  },
                }
              : c,
          )
          .slice()
          .sort(
            (a, b) =>
              new Date(effectiveChatTimestamp(b)).getTime() -
              new Date(effectiveChatTimestamp(a)).getTime(),
          ),
      );
      fireAnalytics("messages.compose_sent", {
        chat_id: chatId,
        length: trimmed.length,
      });
    } catch {
      setMessages((prev) => (prev ?? []).filter((m) => m.id !== optimisticId));
      setDraft(trimmed);
      setToast({ key: Date.now(), text: "Couldn't send. Try again." });
      fireAnalytics("messages.compose_failed", {
        chat_id: chatId,
        reason: "network",
      });
    } finally {
      setSending(false);
    }
  }, [draft, selectedChat, sending]);

  function onComposeChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setDraft(e.target.value);
    if (composeHint) setComposeHint(null);
  }

  function onComposeKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd+Enter (mac) / Ctrl+Enter (win/linux) submits.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void sendCompose();
    }
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
            <p
              style={{ color: "var(--wp-error, #ef4444)", marginTop: 12 }}
              data-testid="messages-list-error"
            >
              {listError}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const isMobileThreadView = selectedChat !== null;
  const canSend = draft.trim().length > 0 && !sending;
  const hasNoMessages =
    selectedChat !== null && !loadingThread && !threadScopeMissing && (messages ?? []).length === 0;

  return (
    <div data-testid="messages-page" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 24px 8px" }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Messages</h1>
        <p style={{ margin: "4px 0 0", color: "var(--wp-text-muted, #9ca3af)", fontSize: 13 }}>
          Your Teams chats — read, reply, and start calls without leaving Instinct.
        </p>
      </div>

      <div
        data-testid="messages-split"
        style={{
          display: "flex",
          flexDirection: "row",
          flex: 1,
          minHeight: 0,
          borderTop: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        {/* Chat list column. On mobile: hidden when a chat is open. */}
        <aside
          data-testid="messages-list"
          data-mobile-hidden={isMobile && isMobileThreadView ? "true" : "false"}
          style={{
            width: isMobile ? "100%" : 320,
            borderRight: isMobile ? "none" : "1px solid var(--wp-dark-border, #333)",
            overflowY: "auto",
            background: "var(--wp-dark-surface, #1a1a1a)",
            display: isMobile && isMobileThreadView ? "none" : "block",
          }}
        >
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {(chats ?? []).map((chat) => {
              const title = getChatTitle(chat, selfEmail, selfName, selfId);
              const otherUserId = getOtherMemberUserId(chat, selfEmail, selfName, selfId);
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
                      borderBottom: "1px solid var(--wp-dark-border, #333)",
                      background: isSelected ? "rgba(234,179,8,0.12)" : "transparent",
                      cursor: "pointer",
                      gap: 10,
                      alignItems: "flex-start",
                      color: "var(--wp-text, #eee)",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 8,
                          alignItems: "center",
                        }}
                      >
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            fontWeight: 600,
                            fontSize: 14,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            minWidth: 0,
                            flex: "1 1 auto",
                          }}
                        >
                          {otherUserId ? (
                            <span style={{ flex: "0 0 auto", display: "inline-flex" }}>
                              <PresenceDot userId={otherUserId} />
                            </span>
                          ) : null}
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              minWidth: 0,
                            }}
                            data-testid={`chat-title-${chat.id}`}
                          >
                            {title}
                          </span>
                        </span>
                        <span style={{ fontSize: 11, color: "var(--wp-text-muted, #9ca3af)", flex: "0 0 auto" }}>
                          {formatRelativeTime(effectiveChatTimestamp(chat))}
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
                            color: "var(--wp-text-muted, #9ca3af)",
                            fontSize: 13,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                          }}
                          data-testid={`chat-preview-${chat.id}`}
                        >
                          {previewTextOf(chat.lastMessagePreview)}
                        </span>
                        {chat.unreadCount && chat.unreadCount > 0 ? (
                          <span
                            data-testid={`chat-unread-${chat.id}`}
                            style={{
                              background: "var(--wp-gold, #eab308)",
                              color: "var(--wp-dark-surface, #1a1a1a)",
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
          style={{
            flex: 1,
            display: isMobile && !isMobileThreadView ? "none" : "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          {!selectedChat ? (
            <div
              data-testid="messages-no-selection"
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--wp-text-muted, #9ca3af)",
                padding: 24,
                textAlign: "center",
              }}
            >
              Select a chat to read and reply.
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
                  borderBottom: "1px solid var(--wp-dark-border, #333)",
                  background: "var(--wp-dark-surface2, #222)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button
                    type="button"
                    onClick={clearSelection}
                    data-testid="messages-back"
                    style={{
                      border: "1px solid var(--wp-dark-border, #333)",
                      background: "var(--wp-dark-surface, #1a1a1a)",
                      borderRadius: 6,
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontSize: 13,
                      color: "var(--wp-text, #eee)",
                    }}
                  >
                    ← Back
                  </button>
                  <span style={{ fontWeight: 600 }}>
                    {getChatTitle(selectedChat, selfEmail, selfName, selfId)}
                  </span>
                </div>
              </div>

              <div
                data-testid="messages-thread-body"
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: 16,
                  background: "var(--wp-dark-surface, #1a1a1a)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                {loadingThread ? (
                  <div data-testid="messages-thread-loading" style={{ color: "var(--wp-text-muted, #9ca3af)" }}>
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
                ) : (messages ?? []).length === 0 ? null : (
                  (messages ?? []).map((m) => {
                    const text =
                      m.body?.contentType === "text"
                        ? m.body?.content ?? ""
                        : stripHtmlToText(m.body?.content);
                    const isMe = m.role === "me";
                    return (
                      <div
                        key={m.id}
                        data-testid={`message-${m.id}`}
                        data-pending={m.pending ? "true" : "false"}
                        data-role={m.role ?? "other"}
                        style={{
                          background: isMe
                            ? "rgba(234,179,8,0.10)"
                            : "var(--wp-dark-surface2, #222)",
                          border: "1px solid var(--wp-dark-border, #333)",
                          borderRadius: 8,
                          padding: "8px 12px",
                          alignSelf: isMe ? "flex-end" : "flex-start",
                          maxWidth: "80%",
                          opacity: m.pending ? 0.7 : 1,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--wp-text-muted, #9ca3af)",
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          <span>{m.from?.displayName ?? "Unknown"}</span>
                          <span>
                            {m.pending ? "Sending…" : formatRelativeTime(m.createdDateTime)}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 14,
                            whiteSpace: "pre-wrap",
                            marginTop: 4,
                            color: "var(--wp-text, #eee)",
                          }}
                        >
                          {text}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={threadEndRef} data-testid="messages-thread-end" />
              </div>

              {/* Compose area + more-actions row */}
              <div
                data-testid="messages-compose"
                style={{
                  borderTop: "1px solid var(--wp-dark-border, #333)",
                  background: "var(--wp-dark-surface2, #222)",
                  padding: "12px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {hasNoMessages ? (
                  <div
                    data-testid="messages-empty-thread-hint"
                    style={{ color: "var(--wp-text-muted, #9ca3af)", fontSize: 13 }}
                  >
                    No messages yet — write the first one below.
                  </div>
                ) : null}

                <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                  <textarea
                    data-testid="messages-compose-input"
                    aria-label="Send a Teams message"
                    value={draft}
                    onChange={onComposeChange}
                    onKeyDown={onComposeKeyDown}
                    placeholder="Send a Teams message…"
                    rows={2}
                    style={{
                      flex: 1,
                      resize: "none",
                      minHeight: 44,
                      maxHeight: 150, // ~6 rows at 14px line-height.
                      overflowY: "auto",
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--wp-dark-border, #333)",
                      background: "var(--wp-dark-surface, #1a1a1a)",
                      color: "var(--wp-text, #eee)",
                      fontSize: 14,
                      fontFamily: "inherit",
                      lineHeight: 1.4,
                    }}
                  />
                  <button
                    type="button"
                    data-testid="messages-compose-send"
                    onClick={() => void sendCompose()}
                    disabled={!canSend}
                    aria-label="Send message"
                    style={{
                      padding: "8px 16px",
                      borderRadius: 6,
                      border: "1px solid var(--wp-gold, #eab308)",
                      background: canSend
                        ? "var(--wp-gold, #eab308)"
                        : "var(--wp-dark-surface, #1a1a1a)",
                      color: canSend
                        ? "var(--wp-dark-surface, #1a1a1a)"
                        : "var(--wp-text-muted, #9ca3af)",
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: canSend ? "pointer" : "not-allowed",
                      opacity: canSend ? 1 : 0.6,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sending ? "Sending…" : "Send"}
                  </button>
                </div>

                {composeHint === "scope_missing" ? (
                  <div
                    data-testid="messages-compose-scope-hint"
                    style={{
                      fontSize: 12,
                      color: "var(--wp-text-muted, #9ca3af)",
                      padding: "6px 8px",
                      borderRadius: 6,
                      background: "var(--wp-dark-surface, #1a1a1a)",
                      border: "1px solid var(--wp-dark-border, #333)",
                    }}
                  >
                    Grant <code>Chat.ReadWrite</code> to send from here —{" "}
                    <Link
                      href="/settings"
                      data-testid="messages-compose-scope-cta"
                      style={{ color: "var(--wp-gold, #eab308)" }}
                    >
                      Open settings
                    </Link>
                  </div>
                ) : null}

                {composeHint === "write_disabled" ? (
                  <div
                    data-testid="messages-compose-write-disabled-hint"
                    style={{
                      fontSize: 12,
                      color: "var(--wp-text-muted, #9ca3af)",
                      padding: "6px 8px",
                      borderRadius: 6,
                      background: "var(--wp-dark-surface, #1a1a1a)",
                      border: "1px solid var(--wp-dark-border, #333)",
                    }}
                  >
                    Inline send is disabled for this workspace. Use{" "}
                    <span style={{ color: "var(--wp-gold, #eab308)" }}>Reply in Teams →</span>
                  </div>
                ) : null}

                {/* Secondary "More actions" — deep-links tucked below compose. */}
                <div
                  data-testid="messages-more-actions"
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    paddingTop: 4,
                    borderTop: "1px dashed var(--wp-dark-border, #333)",
                    marginTop: 4,
                  }}
                >
                  <DeepLinkButton
                    url={chatDeepLink ?? ""}
                    analyticsType="reply"
                    disabled={!chatDeepLink}
                    testId="deep-link-reply"
                    ariaLabel="Reply in Teams"
                  >
                    Reply in Teams
                  </DeepLinkButton>
                  <DeepLinkButton
                    url={callDeepLink ?? ""}
                    analyticsType="call"
                    disabled={!callDeepLink}
                    testId="deep-link-call"
                    ariaLabel="Start audio call in Teams"
                  >
                    Call
                  </DeepLinkButton>
                  <DeepLinkButton
                    url={videoDeepLink ?? ""}
                    analyticsType="video"
                    disabled={!videoDeepLink}
                    testId="deep-link-video"
                    ariaLabel="Start video call in Teams"
                  >
                    Video call
                  </DeepLinkButton>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {toast ? (
        <div
          key={toast.key}
          role="status"
          data-testid="messages-toast"
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            padding: "10px 14px",
            borderRadius: 6,
            background: "var(--wp-error, #ef4444)",
            color: "var(--wp-text, #fff)",
            fontSize: 13,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            zIndex: 90,
          }}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--wp-dark-border, #333)",
  borderRadius: 10,
  padding: 20,
  background: "var(--wp-dark-surface, #1a1a1a)",
  maxWidth: 520,
  color: "var(--wp-text, #eee)",
};

const linkButtonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "8px 14px",
  background: "var(--wp-gold, #eab308)",
  color: "var(--wp-dark-surface, #1a1a1a)",
  borderRadius: 6,
  textDecoration: "none",
  fontSize: 14,
  fontWeight: 600,
};
