"use client";

import { useState, useEffect, useRef, useCallback, KeyboardEvent, DragEvent, ChangeEvent } from "react";
import { getInstinctToken, clearInstinctSession, jsonHeaders as canonicalJsonHeaders, fetchWithRefresh } from "@/lib/client-auth";
import {
  queryAssistantWithCache,
  RagOfflineMissError,
} from "@/lib/assistant-rag-offline";
import { sendAssistantMessageOffline } from "@/lib/assistant-drafts-offline";
import { RagSnapshotBadge } from "@/components/RagSnapshotBadge";

import { renderMessageContent } from "@/lib/assistant/render-markdown";
import {
  ingestFileFromChat,
  formatIngestSystemMessage,
} from "@/lib/assistant/chat-ingest";
import { ConnectorBadge } from "@/components/ConnectorBadge";
import { ChatActionForm } from "@/components/ChatActionForm";
import { ChatWidget } from "@/components/ChatWidget";
import type { FormSpec } from "@/lib/assistant/forms/types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";
import { AssistantStarterPrompts } from "@/components/AssistantStarterPrompts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AttachedFile {
  name: string;
  type: string;
  content: string; // text content or base64 for images
}

interface RelatedPage {
  domain: string;
  label: string;
  href: string;
}

interface AssistantSource {
  id: string;
  title: string;
  url: string;
  type: string;
}

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  source?: string;
  /** Connector name when the answer came from a CRM/external system
   *  (salesforce, hubspot, github, …). Rendered as a styled badge. */
  connectorSource?: string;
  tokensUsed: number;
  timestamp: string;
  rating?: number;
  attachments?: AttachedFile[];
  /** Set when this reply was served from U1's offline RAG cache. */
  fromCache?: boolean;
  /** Cache metadata — fed into RagSnapshotBadge. */
  cachedAtMs?: number;
  isFuzzy?: boolean;
  similarity?: number;
  /** Chip-links into Instinct pages the answer touches. */
  relatedPages?: RelatedPage[];
  /** Citations for the answer. Rendered as a collapsible "Sources" block. */
  sources?: AssistantSource[];
  /** Free-form metadata persisted with the message (e.g. connector_source).
   *  Hydrated into typed fields at message-load time. */
  metadata?: Record<string, unknown>;
  /** Structured chat-action form spec (create email / message / event
   *  / task). When set, the chat surface renders ChatActionForm
   *  inline below the bubble. */
  form?: import("@/lib/assistant/forms/types").FormSpec;
  /** Interactive widget spec (calendar grid, email thread, task list,
   *  dashboard chart). Rendered via the ChatWidget dispatcher. */
  widget?: import("@/lib/assistant/widgets/types").WidgetSpec;
  /** Per-turn correlation id. Threaded through every analytics event
   *  fired during the originating chat() call; forwarded by widget +
   *  form children so their client-side interaction events join the
   *  same funnel. */
  workflowId?: string;
}

interface Conversation {
  id: string;
  title: string | null;
  status: string;
  messageCount: number;
  totalTokens: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface InstinctChatProps {
  /** Page-specific context injected into every message */
  pageContext?: string;
  /** Arbitrary data passed as context */
  contextData?: Record<string, unknown>;
  /** inline = full page, floating = bottom-right bubble */
  position?: "inline" | "floating";
  /** CSS height for inline mode */
  height?: string;
  /** Show conversation sidebar */
  showHistory?: boolean;
  /** Show source badges on assistant messages */
  showSource?: boolean;
  /** Show thumbs up/down rating buttons */
  showRating?: boolean;
}

// ---------------------------------------------------------------------------
// Source badge config
// ---------------------------------------------------------------------------

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  knowledge_cache: { label: "From knowledge base", color: "var(--wp-success, #22c55e)" },

  analytics: { label: "From analytics", color: "#a855f7" },
  ai: { label: "AI generated", color: "var(--wp-gold, #eab308)" },
  fallback: { label: "No match found", color: "var(--wp-text-muted, #6b7280)" },
};

/* Connector badge styling + map lives in @/components/ConnectorBadge so
   it can be unit-tested + reused. Imported above. */

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function InstinctChat({
  pageContext,
  contextData,
  position = "inline",
  height = "calc(100vh - 120px)",
  showHistory = true,
  showSource = true,
  showRating = true,
}: InstinctChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /* Desktop-only collapse — independent of `sidebarOpen` (mobile drawer).
   * Persisted to localStorage so a user who prefers the wider chat area
   * keeps it across sessions. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("instinct.chat.sidebar_collapsed") === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "instinct.chat.sidebar_collapsed",
      sidebarCollapsed ? "1" : "0",
    );
  }, [sidebarCollapsed]);
  const [floatingOpen, setFloatingOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /* Stop-button state. When the user clicks Stop mid-send, we flip
   * this ref to true. Each await landing in handleSend checks it
   * before mutating messages, so a slow tool call no longer drops a
   * stale assistant bubble after the user has bailed. The network
   * request itself isn't cancelled — server saves a few KB at most
   * by aborting and the bookkeeping cost isn't worth threading an
   * AbortSignal through queryAssistantWithCache + every fetch
   * fallback. Reset to false at the top of every handleSend. */
  const cancelledRef = useRef(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  // Keep isOnline fresh so the offline UX + RagSnapshotBadge refresh
  // button both reflect real connectivity.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  /* Auto-resize the composer textarea so a longer prompt grows the
   * input up to maxHeight (120px), then scrolls inside the textarea.
   * Matches ChatGPT / Claude composer behavior; fixed-height inputs
   * feel primitive on multi-line prompts. */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    /* maxHeight is enforced via CSS; we just grow up to it. */
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  // --- File attachment constants ---
  const MAX_FILE_SIZE = 512_000; // 512KB per file
  const MAX_FILES = 5;
  const MAX_TEXT_LENGTH = 50_000; // chars of text content per file
  const ALLOWED_EXTENSIONS = new Set([
    // Documents
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".rtf", ".odt", ".ods", ".odp",
    // Text & data
    ".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm",
    ".css", ".log", ".yml", ".yaml", ".toml", ".ini", ".cfg",
    ".env.example",
    // Code
    ".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs",
    ".java", ".php", ".swift", ".kt", ".sql", ".sh", ".bash",
    ".zsh", ".r", ".m", ".h", ".c", ".cpp", ".cs",
    // Images
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
    // Design & media
    ".sketch", ".fig",
  ]);
  const ALLOWED_MIME_PREFIXES = [
    "text/",
    "application/json", "application/xml",
    "application/x-yaml", "application/yaml",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.oasis.opendocument",
    "application/rtf",
    "image/",
  ];

  function isAllowedFile(file: File): string | null {
    // Check extension
    const ext = "." + file.name.split(".").pop()?.toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return `"${file.name}" has an unsupported file type`;
    }
    // Check MIME type
    if (file.type && !ALLOWED_MIME_PREFIXES.some((p) => file.type.startsWith(p))) {
      return `"${file.name}" has an unexpected content type`;
    }
    // Check size
    if (file.size > MAX_FILE_SIZE) {
      return `"${file.name}" exceeds the 512KB limit`;
    }
    if (file.size === 0) {
      return `"${file.name}" is empty`;
    }
    return null;
  }

  function sanitizeTextContent(text: string): string {
    // Truncate to max length
    let sanitized = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) + "\n\n[Truncated]" : text;
    // Strip null bytes
    sanitized = sanitized.replace(/\0/g, "");
    return sanitized;
  }

  // Read a File object into an AttachedFile
  function readFile(file: File): Promise<AttachedFile> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const isBinary = file.type.startsWith("image/")
        || file.type === "application/pdf"
        || file.type.includes("msword")
        || file.type.includes("officedocument")
        || file.type.includes("ms-excel")
        || file.type.includes("ms-powerpoint")
        || file.type.includes("opendocument")
        || file.type === "application/rtf";
      reader.onload = () => {
        const raw = reader.result as string;
        resolve({
          name: file.name,
          type: file.type || "text/plain",
          content: isBinary ? raw : sanitizeTextContent(raw),
        });
      };
      reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
      if (isBinary) {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });
  }

  async function handleFiles(files: FileList | File[]) {
    setFileError(null);
    const incoming = Array.from(files);

    // Check total file count
    if (attachedFiles.length + incoming.length > MAX_FILES) {
      setFileError(`Maximum ${MAX_FILES} files allowed`);
      return;
    }

    const newFiles: AttachedFile[] = [];
    const errors: string[] = [];
    /* Files we'll also ingest into the Central Brain so they become
       permanently searchable across the org. We pair (file, blob)
       because handleFiles is invoked from drag/drop AND from the
       <input> picker — both supply File blobs, but readFile() only
       returns text/base64 content. */
    const toIngest: File[] = [];

    for (const file of incoming) {
      const err = isAllowedFile(file);
      if (err) {
        errors.push(err);
        continue;
      }
      // Reject duplicates
      if (attachedFiles.some((af) => af.name === file.name)) {
        errors.push(`"${file.name}" is already attached`);
        continue;
      }
      try {
        newFiles.push(await readFile(file));
        toIngest.push(file);
      } catch {
        errors.push(`Could not read "${file.name}"`);
      }
    }

    if (errors.length > 0) {
      setFileError(errors.join(". "));
    }
    if (newFiles.length > 0) {
      setAttachedFiles((prev) => [...prev, ...newFiles]);
    }

    /* Fire-and-forget Brain ingest, in parallel, AFTER attachment state
       is updated so the UI stays responsive. Each ingest result pushes
       a system message into the chat thread so the user sees what
       landed permanently versus what stayed transient. */
    for (const file of toIngest) {
      ingestFileFromChat(file)
        .then((result) => {
          const sysMsg = formatIngestSystemMessage(file.name, result);
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: sysMsg,
              source: "system" as Message["source"],
              tokensUsed: 0,
              timestamp: new Date().toISOString(),
            },
          ]);
        })
        .catch(() => {
          /* Never block the chat. The helper already returns structured
             failures; an actual throw here would only come from a
             pre-fetch error which is rare enough to swallow. */
        });
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }

  function handleFileInput(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
      e.target.value = "";
    }
  }

  function removeFile(index: number) {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function authHeaders(): HeadersInit {
    return canonicalJsonHeaders();
  }

  // Load conversations list
  const loadConversations = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/assistant?conversations=true", {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.conversations) {
        setConversations(data.conversations);
      }
    } catch {
      // Non-fatal
    }
     
  }, []);

  // Load on mount
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Auto-scroll on new messages — but NOT on empty mount. With zero
  // messages the sentinel sits below the welcome card, so scrolling it
  // into view pushes the welcome text off-screen. `block: "nearest"`
  // also keeps the scroll local to the message list instead of moving
  // the whole page.
  useEffect(() => {
    if (messages.length === 0) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  // Focus input on load — preventScroll so the browser doesn't jump
  // the page to reveal the textarea on mount. Skip auto-focus when
  // the floating panel opens on a touch device: focusing the textarea
  // triggers the on-screen keyboard, which then covers the very input
  // we just focused. Let mobile users tap to reveal the keyboard on
  // their own terms. Inline mode (/assistant full page) still auto-
  // focuses because the page is laid out to keep the input visible
  // above the keyboard.
  useEffect(() => {
    if (position === "inline") {
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!floatingOpen) return;
    if (typeof window !== "undefined") {
      const isTouch =
        window.matchMedia?.("(pointer: coarse)").matches ||
        window.innerWidth < 640;
      if (isTouch) return;
    }
    inputRef.current?.focus({ preventScroll: true });
  }, [position, floatingOpen]);

  /**
   * Re-ask the query that produced a cached assistant message, with
   * `forceRefresh: true` so the wrapper skips the cache hit path. Used
   * by the `<RagSnapshotBadge>` refresh button.
   */
  async function refreshCachedMessage(
    assistantIdx: number,
    _fallbackContent: string,
  ): Promise<void> {
    if (!isOnline) return;
    // Walk back to the preceding user message — that's the query.
    let userMsg: Message | null = null;
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === "user") {
        userMsg = messages[i];
        break;
      }
    }
    if (!userMsg) return;
    try {
      const result = await queryAssistantWithCache(userMsg.content, {
        conversationId,
        pageContext,
        contextData,
        forceRefresh: true,
      });
      setMessages((prev) =>
        prev.map((m, i) =>
          i === assistantIdx
            ? {
                ...m,
                id: result.message_id,
                content: result.answer,
                source: result.source_kind,
                tokensUsed: result.tokens_used ?? 0,
                timestamp: new Date().toISOString(),
                fromCache: result.from_cache,
                cachedAtMs: result.cached_at_ms,
                isFuzzy: result.is_fuzzy,
                similarity: result.similarity,
              }
            : m,
        ),
      );
    } catch {
      // Non-fatal — keep the cached copy visible.
    }
  }

  /* Stop button — user-initiated bail-out of an in-flight generation.
   * The in-flight network request keeps running (we don't thread an
   * AbortSignal through every fallback), but the UI immediately
   * returns to a ready state and any late-arriving response is
   * dropped via cancelledRef inside handleSend. Fires
   * assistant.generation_stopped so the learning loop sees which
   * intents users abandon — useful signal for slow-tool detection. */
  function handleStop() {
    if (!loading) return;
    cancelledRef.current = true;
    setLoading(false);
    void fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: canonicalJsonHeaders(),
      body: JSON.stringify({
        event: "assistant.generation_stopped",
        metadata: {
          conversation_id: conversationId,
          had_attachments: attachedFiles.length > 0,
        },
      }),
    }).catch(() => undefined);
  }

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const currentAttachments = [...attachedFiles];

    const userMsg: Message = {
      role: "user",
      content: trimmed,
      tokensUsed: 0,
      timestamp: new Date().toISOString(),
      attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setAttachedFiles([]);
    setFileError(null);
    setLoading(true);
    /* Fresh send — clear any prior cancellation so a previous Stop
     * click doesn't poison this turn. */
    cancelledRef.current = false;

    // Build the message with file context prepended
    const isBinaryType = (t: string) =>
      t.startsWith("image/") || t === "application/pdf"
      || t.includes("msword") || t.includes("officedocument")
      || t.includes("ms-excel") || t.includes("ms-powerpoint")
      || t.includes("opendocument") || t === "application/rtf";
    let fullMessage = trimmed;
    if (currentAttachments.length > 0) {
      const fileContext = currentAttachments
        .filter((f) => !isBinaryType(f.type))
        .map((f) => `--- File: ${f.name} ---\n${f.content}`)
        .join("\n\n");
      if (fileContext) {
        fullMessage = `${fileContext}\n\n---\n\n${trimmed}`;
      }
    }

    try {
      // Fast-path: no attachments → use the offline-aware wrapper so
      // offline users get a cached answer instead of a blank failure.
      // With attachments we stay on the original code path because the
      // cache layer doesn't model per-file quality gates or doc
      // ingestion side-effects.
      if (currentAttachments.length === 0) {
        try {
          const result = await queryAssistantWithCache(fullMessage, {
            conversationId,
            pageContext,
            contextData,
          });

          /* User clicked Stop mid-await — drop the result silently
           * rather than rendering a stale assistant bubble. */
          if (cancelledRef.current) return;

          if (!conversationId && result.conversation_id) {
            setConversationId(result.conversation_id);
            loadConversations();
          }

          const assistantMsg: Message = {
            id: result.message_id,
            role: "assistant",
            content: result.answer,
            source: result.source_kind,
            /* Forward the connector vendor badge + chip rows from the
               server response. The offline-RAG wrapper preserves these
               fields so the badge renders on the no-attachments path
               (which is 99% of message sends — the fix that was missing
               since the badge feature shipped on 2026-05-16). */
            connectorSource: result.connector_source,
            relatedPages: result.related_pages as RelatedPage[] | undefined,
            /* Chat-action form spec — when present, the message bubble
               renders ChatActionForm inline so the user fills required
               fields before any side effect fires. */
            form: result.form as FormSpec | undefined,
            widget: result.widget as WidgetSpec | undefined,
            workflowId: typeof result.workflowId === "string" ? result.workflowId : undefined,
            tokensUsed: result.tokens_used ?? 0,
            timestamp: new Date().toISOString(),
            fromCache: result.from_cache,
            cachedAtMs: result.cached_at_ms,
            isFuzzy: result.is_fuzzy,
            similarity: result.similarity,
          };
          setMessages((prev) => [...prev, assistantMsg]);
          return;
        } catch (wrapErr) {
          if (wrapErr instanceof RagOfflineMissError) {
            // Offline + no RAG cache hit: queue the user message via
            // the assistant-drafts-offline wrapper so flush-on-online
            // (owned by OfflineStatusPill) replays it once we reconnect.
            // Best-effort — the queue itself shouldn't throw.
            try {
              await sendAssistantMessageOffline({
                message: fullMessage,
                conversationId,
                pageContext,
                contextData,
              });
            } catch {
              /* queue failure is non-fatal; fall through to the fallback msg */
            }
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content:
                  "You're offline and this question hasn't been asked before. Your message will send when you're back online.",
                source: "fallback",
                tokensUsed: 0,
                timestamp: new Date().toISOString(),
              },
            ]);
            return;
          }
          // Any other failure falls through to the legacy path below
          // (which surfaces the canonical "Something went wrong" UI).
          throw wrapErr;
        }
      }

      const body: Record<string, unknown> = {
        message: fullMessage,
        conversationId,
        // Let server-rendered times format in the user's local zone.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      if (pageContext) body.pageContext = pageContext;
      if (contextData) body.contextData = contextData;
      body.attachments = currentAttachments.map((f) => ({
        name: f.name,
        type: f.type,
        size: f.content.length,
      }));
      const textFiles = currentAttachments.filter((f) => !isBinaryType(f.type));
      if (textFiles.length > 0) {
        body.fileContents = textFiles.map((f) => ({
          name: f.name,
          content: f.content,
        }));
      }

      const res = await fetchWithRefresh("/api/assistant", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });

      /* User bailed mid-flight — don't apply anything from this
       * response. */
      if (cancelledRef.current) return;

      if (res.status === 401) {
        // Session expired — redirect to login
        clearInstinctSession();
        window.location.href = "/login";
        return;
      }

      if (!res.ok) throw new Error("Request failed");

      const data = await res.json();
      if (cancelledRef.current) return;

      // Handle quality gate rejection
      if (data.source === "quality_gate" && !data.response) {
        const gateFlags = (data.gateResults || []).flatMap(
          (r: { name: string; verdict: string; flags: { message: string; category: string; severity: string }[] }) =>
            r.flags.filter((f: { severity: string }) => f.severity === "reject").map(
              (f: { message: string; category: string }) => `${r.name}: ${f.message}`
            ),
        );
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              "I couldn't accept one or more of your files:\n\n" +
              gateFlags.map((f: string) => `- ${f}`).join("\n") +
              "\n\nPlease remove sensitive data (PII, passwords, API keys) and try again.",
            source: "fallback",
            tokensUsed: 0,
            timestamp: new Date().toISOString(),
          },
        ]);
        return;
      }

      if (!conversationId && data.conversationId) {
        setConversationId(data.conversationId);
        // Refresh conversations list
        loadConversations();
      }

      // Build response message with gate warnings if any
      let responseContent = data.response;
      const gateWarnings = (data.gateResults || []).flatMap(
        (r: { name: string; verdict: string; flags: { message: string; severity: string }[] }) =>
          r.flags.filter((f: { severity: string }) => f.severity === "warn").map(
            (f: { message: string }) => `${r.name}: ${f.message}`
          ),
      );
      if (gateWarnings.length > 0) {
        responseContent +=
          "\n\n---\nNote: some content was flagged:\n" +
          gateWarnings.map((w: string) => `- ${w}`).join("\n");
      }

      // Show ingestion confirmation for attached files that passed
      const passedFiles = (data.gateResults || [])
        .filter((r: { verdict: string }) => r.verdict === "pass" || r.verdict === "warn")
        .map((r: { name: string }) => r.name);
      if (passedFiles.length > 0) {
        responseContent +=
          "\n\n" + passedFiles.map((n: string) => `Added to knowledge base: ${n}`).join("\n");
      }

      const assistantMsg: Message = {
        id: data.messageId,
        role: "assistant",
        content: responseContent,
        source: data.source,
        connectorSource:
          typeof data.connectorSource === "string" ? data.connectorSource : undefined,
        form: data.form && typeof data.form === "object" ? (data.form as FormSpec) : undefined,
        widget:
          data.widget && typeof data.widget === "object"
            ? (data.widget as WidgetSpec)
            : undefined,
        workflowId: typeof data.workflowId === "string" ? data.workflowId : undefined,
        tokensUsed: data.tokensUsed,
        timestamp: new Date().toISOString(),
        relatedPages: Array.isArray(data.relatedPages) ? data.relatedPages : undefined,
        sources: Array.isArray(data.sources) ? data.sources : undefined,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      /* Don't surface a generic error toast when the user just
       * clicked Stop — the bail-out is intentional, not a failure. */
      if (!cancelledRef.current) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Something went wrong. Please try again.",
            source: "fallback",
            tokensUsed: 0,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleRate(msgId: string | undefined, rating: number) {
    if (!msgId) return;

    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, rating } : m)),
    );

    try {
      await fetchWithRefresh("/api/assistant", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          action: "rate",
          messageId: msgId,
          rating,
        }),
      });
    } catch {
      // Rating failure is non-fatal
    }
  }

  function handleNewConversation() {
    setMessages([]);
    setConversationId(null);
    setInput("");
    setAttachedFiles([]);
    inputRef.current?.focus();
  }

  async function loadConversation(convId: string) {
    try {
      const res = await fetchWithRefresh(`/api/assistant?conversationId=${convId}`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      setConversationId(convId);
      /* Reloaded messages from the DB don't have connectorSource as a
         top-level column — it's persisted in metadata.connector_source.
         Same story for chat-action form specs (metadata.form). Hydrate
         both onto the Message so the badge AND the inline form render
         for historical tool answers too. */
      const messages: Message[] = (data.messages || []).map((m: Message & { metadata?: Record<string, unknown> }) => {
        if (m.role !== "assistant") return m;
        const next: Message = { ...m };
        if (!next.connectorSource && typeof m.metadata?.connector_source === "string") {
          next.connectorSource = m.metadata.connector_source as string;
        }
        if (!next.form && m.metadata?.form && typeof m.metadata.form === "object") {
          next.form = m.metadata.form as FormSpec;
        }
        if (!next.widget && m.metadata?.widget && typeof m.metadata.widget === "object") {
          next.widget = m.metadata.widget as WidgetSpec;
        }
        if (!next.workflowId && typeof m.metadata?.workflow_id === "string") {
          next.workflowId = m.metadata.workflow_id;
        }
        return next;
      });
      setMessages(messages);
      setSidebarOpen(false);
    } catch {
      // Load failure is non-fatal
    }
  }

  // -------------------------------------------------------------------------
  // Floating bubble mode
  // -------------------------------------------------------------------------

  if (position === "floating" && !floatingOpen) {
    return (
      <button
        onClick={() => {
          setFloatingOpen(true);
          void fetchWithRefresh("/api/analytics", {
            method: "POST",
            headers: canonicalJsonHeaders(),
            body: JSON.stringify({
              event: "assistant.floating_opened",
              metadata: {
                pathname:
                  typeof window !== "undefined" ? window.location.pathname : "",
              },
            }),
          }).catch(() => {});
        }}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-transform hover:scale-110"
        style={{ background: "var(--wp-gold, #eab308)" }}
        aria-label="Open assistant"
        data-testid="floating-assistant-fab"
      >
        <svg
          className="w-7 h-7"
          fill="none"
          // The sparkle path is drawn with its center-of-mass at x=9 in
          // a 24-wide viewBox, so rendering at 0 0 24 24 lands the
          // icon 3 units left of the button's geometric center. We
          // shift the viewport left by 3 so the star sits at visual
          // center without touching the shared Heroicons path data.
          viewBox="-3 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
          style={{ color: "var(--wp-dark, #111)" }}
          data-testid="floating-assistant-fab-icon"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
          />
        </svg>
      </button>
    );
  }

  // -------------------------------------------------------------------------
  // Chat panel (shared between inline and floating)
  // -------------------------------------------------------------------------

  const wrapperClass =
    position === "floating"
      ? "fixed bottom-4 right-4 left-4 sm:left-auto z-50 sm:w-96 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
      : "flex flex-col";

  const wrapperStyle: React.CSSProperties =
    position === "floating"
      ? {
          // Desktop: fixed 32rem. Mobile: shrink to the dynamic viewport
          // height (100dvh) so the panel doesn't overflow below the
          // mobile keyboard. dvh subtracts the keyboard automatically
          // on iOS 15.4+ and Android Chrome 108+. Fallback to 32rem is
          // the browser's job when dvh isn't supported.
          height: "min(32rem, calc(100dvh - 2rem))",
          maxHeight: "100dvh",
          background: "var(--wp-dark, #111)",
          border: "1px solid var(--wp-dark-border, #333)",
        }
      : {
          height,
          background: "var(--wp-dark, #111)",
        };

  return (
    <div className={wrapperClass} style={wrapperStyle}>
      <div className="flex h-full">
        {/* Conversation sidebar */}
        {showHistory && (
          <>
            {sidebarOpen && (
              <div
                className="fixed inset-0 bg-black/50 z-20 lg:hidden"
                onClick={() => setSidebarOpen(false)}
              />
            )}
            <aside
              data-testid="conversations-sidebar"
              data-collapsed={sidebarCollapsed ? "true" : "false"}
              className={`${
                position === "floating" ? "hidden" : ""
              } fixed lg:static inset-y-0 left-0 z-30 ${
                sidebarCollapsed ? "lg:w-12" : "lg:w-64"
              } w-64 border-r flex flex-col transition-all lg:translate-x-0 ${
                sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
              }`}
              style={{
                background: "var(--wp-dark-surface, #1a1a1a)",
                borderColor: "var(--wp-dark-border, #333)",
              }}
            >
              {/* Sidebar header — fixed height + matching px/py to the
                  main chat header so the bottom border lines up
                  pixel-perfect across the divide. Was misaligned because
                  the collapsed-mode content was shorter than the chat
                  header's icon+title. h-[52px] = matches the 14h of
                  the main header (icon 24 + py-3 = 24+12+12+border). */}
              <div
                className="flex items-center px-3 border-b shrink-0"
                style={{
                  borderColor: "var(--wp-dark-border, #333)",
                  height: 53,
                }}
              >
                {!sidebarCollapsed && (
                  <span
                    className="text-sm font-medium"
                    style={{ color: "var(--wp-text-dim, #aaa)" }}
                  >
                    Conversations
                  </span>
                )}
                {/* Chat-bubble icon — shown only when collapsed so the
                    rail says "I'm the conversations panel" at a glance.
                    Without it, the bare "»" toggle was opaque (the
                    screenshot bug). */}
                {sidebarCollapsed && (
                  <svg
                    className="w-5 h-5 hidden lg:block mx-auto"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    style={{ color: "var(--wp-text-dim, #aaa)" }}
                    aria-hidden
                    data-testid="sidebar-collapsed-icon"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.068.157 2.148.279 3.238.364.466.037.893.281 1.153.671L12 21l2.652-3.978c.26-.39.687-.634 1.153-.67 1.09-.086 2.17-.208 3.238-.365 1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
                    />
                  </svg>
                )}
                <div className="flex items-center gap-1 ml-auto">
                  {/* Desktop collapse toggle — hidden on mobile (the
                      mobile drawer uses the X button below). Icon flips
                      direction based on current state so the
                      affordance is clear. */}
                  <button
                    onClick={() => setSidebarCollapsed((c) => !c)}
                    className="hidden lg:flex p-1 rounded hover:opacity-80"
                    style={{ color: "var(--wp-text-muted, #6b7280)" }}
                    aria-label={sidebarCollapsed ? "Expand conversations panel" : "Collapse conversations panel"}
                    title={sidebarCollapsed ? "Show conversations" : "Collapse"}
                    data-testid="sidebar-collapse-toggle"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d={
                          sidebarCollapsed
                            ? "M13 5l7 7-7 7M5 5l7 7-7 7"
                            : "M11 19l-7-7 7-7M19 19l-7-7 7-7"
                        }
                      />
                    </svg>
                  </button>
                  <button
                    onClick={() => setSidebarOpen(false)}
                    className="lg:hidden p-1"
                    style={{ color: "var(--wp-text-muted, #6b7280)" }}
                    aria-label="Close conversations"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <div
                className={`flex-1 overflow-y-auto ${
                  sidebarCollapsed ? "lg:hidden" : ""
                }`}
              >
                {conversations.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                    No conversations yet
                  </div>
                ) : (
                  conversations.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => loadConversation(c.id)}
                      className={`wp-conv-item w-full text-left px-4 py-3 border-b text-sm ${c.id === conversationId ? "wp-conv-item--active" : ""}`}
                      style={{
                        borderColor: "var(--wp-dark-border, #333)",
                        background:
                          c.id === conversationId
                            ? "var(--wp-dark-surface2, #222)"
                            : "transparent",
                        color:
                          c.id === conversationId
                            ? "var(--wp-gold, #eab308)"
                            : "var(--wp-text-dim, #aaa)",
                      }}
                    >
                      <p className="truncate">{c.title || "Untitled"}</p>
                      <span className="text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                        {c.messageCount} messages
                        {c.totalTokens === 0 ? " -- Zero tokens" : ""}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </aside>
          </>
        )}

        {/* Main chat area */}
        <div
          className="flex-1 flex flex-col min-w-0 relative"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Drag overlay */}
          {dragging && (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center rounded-xl"
              style={{
                background: "rgba(241, 194, 51, 0.08)",
                border: "2px dashed var(--wp-gold, #eab308)",
              }}
            >
              <div className="text-center">
                <svg className="w-12 h-12 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--wp-gold, #eab308)" }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <p className="text-sm font-medium" style={{ color: "var(--wp-gold, #eab308)" }}>Drop files here for context</p>
              </div>
            </div>
          )}
          {/* Header — fixed height matches the sidebar header so the
              two bottom borders line up across the divide (the misaligned
              line was the 2026-05-16 screenshot bug). */}
          <div
            className="flex items-center gap-3 px-4 border-b shrink-0"
            style={{ borderColor: "var(--wp-dark-border, #333)", height: 53 }}
          >
            {showHistory && position !== "floating" && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="lg:hidden p-1"
                style={{ color: "var(--wp-text-dim, #aaa)" }}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            )}

            {/* Brain icon — pulse-glow gives the AI surface a subtle
                "alive" feel; honors prefers-reduced-motion via globals.
                Hidden on small screens so the title fits on one line
                next to the hamburger + "New" button. */}
            <svg
              className="w-6 h-6 shrink-0 wp-pulse-glow hidden sm:block"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              style={{ color: "var(--wp-gold, #eab308)" }}
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
              />
            </svg>

            <h1
              className={`${position === "floating" ? "text-sm" : "text-base sm:text-lg"} font-bold truncate min-w-0`}
              style={{ color: "var(--wp-gold, #eab308)" }}
            >
              Wolfpack Assistant
            </h1>

            <div className="flex-1" />

            <button
              onClick={handleNewConversation}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{
                background: "var(--wp-dark-surface2, #222)",
                color: "var(--wp-text-dim, #aaa)",
              }}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New
            </button>

            {position === "floating" && (
              <button
                onClick={() => setFloatingOpen(false)}
                className="p-1"
                style={{ color: "var(--wp-text-muted, #6b7280)" }}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Messages. overflow-x-hidden so a wide widget can't push the
              chat column sideways on mobile; min-w-0 lets flex children
              shrink instead of demanding their content width. */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 px-4 py-4 space-y-4">
            {messages.length === 0 && (
              /* Anchor to the TOP (not center) so the title + greeting
                 are always visible above the fold on mobile. The
                 starter-prompt chips scroll into view below. Previously
                 the centered layout pushed the greeting above the
                 viewport on narrow screens. */
              <div className="flex flex-col items-center text-center pt-4 sm:pt-8 pb-4">
                <svg
                  className="w-10 h-10 sm:w-16 sm:h-16 mb-2 sm:mb-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={0.5}
                  style={{ color: "var(--wp-dark-border, #333)" }}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
                  />
                </svg>
                <h2 className="text-base sm:text-lg font-medium mb-1 sm:mb-2" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                  Your AI-powered team assistant
                </h2>
                <p className="text-xs sm:text-sm max-w-md px-3" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                  Ask about projects, clients, processes, or anything work-related.
                  Get instant answers without digging through files or emails.
                </p>
                {/* Starter-prompt chips. Helps new users discover the
                    Assistant's surface area. Clicking a chip drops the
                    prompt into the composer; the user can edit before
                    sending or just hit Enter. */}
                <AssistantStarterPrompts
                  onPick={(prompt) => {
                    setInput(prompt);
                    /* Focus + scroll into view so the user can see what
                       they're about to send (or edit). */
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                />
              </div>
            )}

            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`${
                    /* Assistant bubbles host widgets + forms + multi-section
                     * panels, so they get full width on mobile (where 80%
                     * forced widgets to wrap awkwardly) and a generous cap
                     * on desktop. User bubbles stay narrow so the chat
                     * still reads like a conversation. min-w-0 + overflow-
                     * hidden keep the bubble inside the column even when
                     * a widget renders something wide (long meeting
                     * subject, attendee list, etc.). */
                    position === "floating"
                      ? "max-w-[90%]"
                      : msg.role === "user"
                      ? "max-w-[80%] lg:max-w-[60%]"
                      : "w-full lg:max-w-[85%]"
                  } min-w-0 overflow-hidden rounded-xl px-4 py-3`}
                  style={{
                    background:
                      msg.role === "user"
                        ? "var(--wp-gold, #eab308)"
                        : "var(--wp-dark-surface2, #222)",
                    color:
                      msg.role === "user"
                        ? "var(--wp-dark, #111)"
                        : "var(--wp-text, #eee)",
                  }}
                >
                  {/* Attachment badges on user messages */}
                  {msg.role === "user" && msg.attachments && msg.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {msg.attachments.map((att, aidx) => (
                        <span
                          key={aidx}
                          className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                          style={{
                            background: "rgba(0,0,0,0.2)",
                            color: "var(--wp-dark, #111)",
                          }}
                        >
                          {att.type.startsWith("image/") ? (
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
                            </svg>
                          ) : (
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                            </svg>
                          )}
                          {att.name}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Cached-snapshot badge — rendered above the answer
                      so it's the first thing users see when offline. */}
                  {msg.role === "assistant" && msg.fromCache && msg.cachedAtMs && (
                    <div className="mb-2" data-testid="assistant-snapshot-badge">
                      <RagSnapshotBadge
                        cachedAtMs={msg.cachedAtMs}
                        isFuzzy={!!msg.isFuzzy}
                        similarity={msg.similarity}
                        isOnline={isOnline}
                        onRefresh={
                          isOnline
                            ? () => {
                                void refreshCachedMessage(idx, msg.content);
                              }
                            : undefined
                        }
                      />
                    </div>
                  )}
                  <div
                    className="text-sm whitespace-pre-wrap leading-relaxed break-words overflow-hidden"
                    data-testid={`assistant-msg-content-${idx}`}
                  >
                    {renderMessageContent(msg.content)}
                  </div>

                  {/* Chat-action form (create email / message / event /
                      task). Rendered below the answer text so the
                      one-line intro ("Fill in the email below…") still
                      shows in the bubble. ChatActionForm owns its own
                      submit + ack lifecycle. */}
                  {msg.role === "assistant" && msg.form && (
                    <ChatActionForm spec={msg.form} workflowId={msg.workflowId} />
                  )}

                  {msg.role === "assistant" && msg.widget && (
                    <ChatWidget spec={msg.widget} workflowId={msg.workflowId} />
                  )}

                  {msg.role === "assistant" &&
                    msg.relatedPages &&
                    msg.relatedPages.length > 0 && (
                      <div
                        className="mt-2 flex flex-wrap gap-2"
                        data-testid={`related-pages-${idx}`}
                      >
                        <span
                          className="text-xs"
                          style={{ color: "var(--wp-text-muted, #6b7280)" }}
                        >
                          Related pages:
                        </span>
                        {msg.relatedPages.map((rp) => (
                          <a
                            key={rp.href}
                            href={rp.href}
                            onClick={() => {
                              void fetchWithRefresh("/api/analytics", {
                                method: "POST",
                                headers: canonicalJsonHeaders(),
                                body: JSON.stringify({
                                  event: "assistant.link_clicked",
                                  metadata: { domain: rp.domain },
                                }),
                              }).catch(() => {});
                            }}
                            className="text-xs px-2 py-1 rounded-full border transition-colors"
                            data-testid={`related-chip-${rp.domain}`}
                            style={{
                              background: "var(--wp-dark-surface2, #222)",
                              borderColor: "var(--wp-dark-border, #333)",
                              color: "var(--wp-gold, #eab308)",
                              textDecoration: "none",
                            }}
                          >
                            {rp.label}
                          </a>
                        ))}
                      </div>
                    )}

                  {msg.role === "assistant" &&
                    msg.sources &&
                    msg.sources.length > 0 && (
                      <div className="mt-2" data-testid={`sources-block-${idx}`}>
                        <button
                          type="button"
                          onClick={() => {
                            const key = String(idx);
                            const nextOpen = !expandedSources[key];
                            setExpandedSources((prev) => ({ ...prev, [key]: nextOpen }));
                            if (nextOpen && msg.sources && msg.sources.length > 0) {
                              void fetchWithRefresh("/api/analytics", {
                                method: "POST",
                                headers: canonicalJsonHeaders(),
                                body: JSON.stringify({
                                  event: "assistant.source_viewed",
                                  metadata: {
                                    source_type: msg.sources[0]?.type ?? "unknown",
                                  },
                                }),
                              }).catch(() => {});
                            }
                          }}
                          className="text-xs underline"
                          style={{ color: "var(--wp-text-muted, #6b7280)" }}
                          data-testid={`sources-toggle-${idx}`}
                        >
                          {expandedSources[String(idx)] ? "Hide" : "Show"}{" "}
                          {msg.sources.length} source
                          {msg.sources.length === 1 ? "" : "s"}
                        </button>
                        {expandedSources[String(idx)] && (
                          <ul
                            className="mt-2 space-y-1"
                            data-testid={`sources-list-${idx}`}
                          >
                            {msg.sources.map((s) => (
                              <li key={s.id} className="text-xs">
                                <a
                                  href={s.url}
                                  onClick={() => {
                                    void fetchWithRefresh("/api/analytics", {
                                      method: "POST",
                                      headers: canonicalJsonHeaders(),
                                      body: JSON.stringify({
                                        event: "assistant.source_viewed",
                                        metadata: { source_type: s.type },
                                      }),
                                    }).catch(() => {});
                                  }}
                                  className="underline"
                                  style={{
                                    color: "var(--wp-gold, #eab308)",
                                    textDecoration: "underline",
                                  }}
                                  data-testid={`source-link-${s.id}`}
                                >
                                  {s.title}
                                </a>{" "}
                                <span style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                                  · {s.type}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                  {/* Assistant metadata */}
                  {msg.role === "assistant" && (showSource || showRating) && (
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {/* Source badge */}
                      {showSource && msg.source && SOURCE_BADGE[msg.source] && (
                        <span
                          className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
                          style={{
                            background: `${SOURCE_BADGE[msg.source].color}20`,
                            color: SOURCE_BADGE[msg.source].color,
                          }}
                        >
                          {SOURCE_BADGE[msg.source].label}
                        </span>
                      )}

                      {/* Connector-source badge — when the answer came
                          from a CRM/external system (salesforce, hubspot,
                          github, …). Distinct color per vendor so a
                          multi-CRM workspace can tell at a glance which
                          system answered. ConnectorBadge returns null
                          when connector is falsy, so the gate is just
                          showSource. */}
                      {showSource && (
                        <ConnectorBadge connector={msg.connectorSource} />
                      )}

                      {/* Zero tokens badge */}
                      {showSource && msg.source !== "ai" && (
                        <span
                          className="inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium"
                          style={{
                            background: "var(--wp-success, #22c55e)20",
                            color: "var(--wp-success, #22c55e)",
                          }}
                        >
                          Zero tokens
                        </span>
                      )}

                      {/* Token count for AI */}
                      {showSource && msg.source === "ai" && msg.tokensUsed > 0 && (
                        <span
                          className="text-xs"
                          style={{ color: "var(--wp-text-muted, #6b7280)" }}
                        >
                          {msg.tokensUsed.toLocaleString()} tokens
                        </span>
                      )}

                      {/* Rating buttons */}
                      {showRating && msg.id && (
                        <div className="flex items-center gap-1 ml-auto">
                          <button
                            onClick={() => handleRate(msg.id, 5)}
                            className="p-1 rounded transition-colors"
                            style={{
                              color: msg.rating === 5 ? "var(--wp-success, #22c55e)" : "var(--wp-text-muted, #6b7280)",
                            }}
                            title="Helpful"
                          >
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill={msg.rating === 5 ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zM4 21H2V10h2v11z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleRate(msg.id, 1)}
                            className="p-1 rounded transition-colors"
                            style={{
                              color: msg.rating === 1 ? "var(--wp-error, #ef4444)" : "var(--wp-text-muted, #6b7280)",
                            }}
                            title="Not helpful"
                          >
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill={msg.rating === 1 ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10zM20 2h2v11h-2V2z" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Typing + skeleton indicator. Bouncing dots alone read as
                "thinking." Adding two shimmer rows under them signals
                "structured content is on the way" — better match for an
                assistant that often returns widgets/lists than pure
                LLM chat. The skeleton block is purely cosmetic; it's
                replaced as soon as the real assistant message renders. */}
            {loading && (
              <div className="flex justify-start" data-testid="assistant-typing-indicator">
                <div
                  className="rounded-xl px-4 py-3 w-full lg:max-w-[85%] min-w-0"
                  style={{ background: "var(--wp-dark-surface2, #222)" }}
                >
                  <div className="flex items-center gap-1.5 mb-2.5">
                    <div
                      className="w-2 h-2 rounded-full animate-bounce"
                      style={{ background: "var(--wp-gold, #eab308)", animationDelay: "0ms" }}
                    />
                    <div
                      className="w-2 h-2 rounded-full animate-bounce"
                      style={{ background: "var(--wp-gold, #eab308)", animationDelay: "150ms" }}
                    />
                    <div
                      className="w-2 h-2 rounded-full animate-bounce"
                      style={{ background: "var(--wp-gold, #eab308)", animationDelay: "300ms" }}
                    />
                  </div>
                  <div
                    className="wp-skeleton-row h-2.5 rounded mb-1.5"
                    style={{ width: "85%" }}
                    data-testid="assistant-skeleton-row-1"
                    aria-hidden
                  />
                  <div
                    className="wp-skeleton-row h-2.5 rounded"
                    style={{ width: "60%" }}
                    data-testid="assistant-skeleton-row-2"
                    aria-hidden
                  />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          <div
            className="shrink-0 border-t px-4 py-3"
            style={{ borderColor: "var(--wp-dark-border, #333)" }}
          >
            {/* File error message */}
            {fileError && (
              <div
                className="flex items-center gap-2 mb-2 max-w-4xl mx-auto px-3 py-2 rounded-lg text-xs"
                style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  color: "var(--wp-error, #ef4444)",
                }}
              >
                <span className="flex-1">{fileError}</span>
                <button onClick={() => setFileError(null)} className="shrink-0 hover:opacity-70">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}

            {/* Attached files chips */}
            {attachedFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2 max-w-4xl mx-auto">
                {attachedFiles.map((file, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs"
                    style={{
                      background: "var(--wp-dark-surface2, #222)",
                      border: "1px solid var(--wp-dark-border, #333)",
                      color: "var(--wp-text-dim, #aaa)",
                    }}
                  >
                    {file.type.startsWith("image/") ? (
                      <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--wp-gold, #eab308)" }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--wp-gold, #eab308)" }}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                      </svg>
                    )}
                    <span className="truncate max-w-[120px]">{file.name}</span>
                    <button
                      onClick={() => removeFile(idx)}
                      className="ml-0.5 p-0.5 rounded hover:opacity-70"
                      style={{ color: "var(--wp-text-muted, #6b7280)" }}
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2 max-w-4xl mx-auto">
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.rtf,.odt,.ods,.odp,.txt,.md,.csv,.tsv,.json,.xml,.html,.htm,.css,.log,.yml,.yaml,.toml,.ini,.cfg,.js,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.php,.swift,.kt,.sql,.sh,.bash,.zsh,.r,.m,.h,.c,.cpp,.cs,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.ico"
                onChange={handleFileInput}
                className="hidden"
              />

              {/* Attach button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="shrink-0 rounded-xl px-3 py-3 transition-opacity hover:opacity-80"
                style={{
                  background: "var(--wp-dark-surface2, #222)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  color: "var(--wp-text-dim, #aaa)",
                }}
                title="Attach files for context"
                disabled={loading}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                </svg>
              </button>

              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                  // Mobile keyboards cover the bottom of the panel in
                  // browsers without dvh support. Scroll the textarea
                  // into view on focus so the user sees what they type.
                  // Deferred so the keyboard has time to rise first.
                  setTimeout(() => {
                    inputRef.current?.scrollIntoView({
                      block: "nearest",
                      behavior: "smooth",
                    });
                  }, 300);
                }}
                placeholder="Ask anything..."
                rows={1}
                data-testid="assistant-composer-input"
                /* wp-input-focus drives the focus glow defined in
                 * globals.css — soft gold halo on focus. */
                className="wp-input-focus flex-1 min-w-0 resize-none rounded-xl px-3 py-3 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2, #222)",
                  color: "var(--wp-text, #eee)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  maxHeight: "120px",
                  fontFamily: "system-ui, -apple-system, sans-serif",
                }}
                /* Keep the textarea editable while loading so a user
                 * can queue the next message OR click Stop without
                 * losing keyboard focus. The send-button gate below
                 * is what actually prevents double-submits. */
              />
              {loading ? (
                <button
                  onClick={handleStop}
                  data-testid="assistant-stop-btn"
                  className="wp-stop-btn shrink-0 rounded-xl px-4 py-3 text-sm font-medium"
                  style={{
                    background: "var(--wp-dark-surface2, #222)",
                    color: "var(--wp-text, #eee)",
                    border: "1px solid var(--wp-dark-border, #333)",
                  }}
                  aria-label="Stop generating"
                  title="Stop"
                >
                  <svg
                    className="w-5 h-5"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden
                  >
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  data-testid="assistant-send-btn"
                  className="wp-send-btn shrink-0 rounded-xl px-4 py-3 text-sm font-medium disabled:opacity-40 transition-transform active:scale-95"
                  style={{
                    background: "var(--wp-gold, #eab308)",
                    color: "var(--wp-dark, #111)",
                  }}
                  aria-label="Send"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                </button>
              )}
            </div>
            <p className="text-center text-xs mt-2" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
              Cmd+Enter to send | Drop files for context
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
