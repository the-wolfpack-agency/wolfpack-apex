"use client";

import { useState, useEffect, useRef, useCallback, KeyboardEvent, DragEvent, ChangeEvent } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AttachedFile {
  name: string;
  type: string;
  content: string; // text content or base64 for images
}

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  source?: string;
  tokensUsed: number;
  timestamp: string;
  rating?: number;
  attachments?: AttachedFile[];
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

export interface ApexChatProps {
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ApexChat({
  pageContext,
  contextData,
  position = "inline",
  height = "calc(100vh - 120px)",
  showHistory = true,
  showSource = true,
  showRating = true,
}: ApexChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [floatingOpen, setFloatingOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

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

  function getToken(): string {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("apex_token") || "";
  }

  function authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    };
  }

  // Load conversations list
  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant?conversations=true", {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load on mount
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input on load
  useEffect(() => {
    if (position === "inline" || floatingOpen) {
      inputRef.current?.focus();
    }
  }, [position, floatingOpen]);

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

    // Build the message with file context prepended
    let fullMessage = trimmed;
    if (currentAttachments.length > 0) {
      const isBinaryType = (t: string) =>
        t.startsWith("image/") || t === "application/pdf"
        || t.includes("msword") || t.includes("officedocument")
        || t.includes("ms-excel") || t.includes("ms-powerpoint")
        || t.includes("opendocument") || t === "application/rtf";
      const fileContext = currentAttachments
        .filter((f) => !isBinaryType(f.type))
        .map((f) => `--- File: ${f.name} ---\n${f.content}`)
        .join("\n\n");
      if (fileContext) {
        fullMessage = `${fileContext}\n\n---\n\n${trimmed}`;
      }
    }

    try {
      const body: Record<string, unknown> = {
        message: fullMessage,
        conversationId,
      };
      if (pageContext) body.pageContext = pageContext;
      if (contextData) body.contextData = contextData;
      if (currentAttachments.length > 0) {
        body.attachments = currentAttachments.map((f) => ({
          name: f.name,
          type: f.type,
          size: f.content.length,
        }));
      }

      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });

      if (res.status === 401) {
        // Session expired — redirect to login
        localStorage.removeItem("apex_token");
        window.location.href = "/login";
        return;
      }

      if (!res.ok) throw new Error("Request failed");

      const data = await res.json();

      if (!conversationId && data.conversationId) {
        setConversationId(data.conversationId);
        // Refresh conversations list
        loadConversations();
      }

      const assistantMsg: Message = {
        id: data.messageId,
        role: "assistant",
        content: data.response,
        source: data.source,
        tokensUsed: data.tokensUsed,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
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
      await fetch("/api/assistant", {
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
      const res = await fetch(`/api/assistant?conversationId=${convId}`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      setConversationId(convId);
      setMessages(data.messages || []);
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
        onClick={() => setFloatingOpen(true)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-transform hover:scale-110"
        style={{ background: "var(--wp-gold, #eab308)" }}
        aria-label="Open assistant"
      >
        <svg
          className="w-7 h-7"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
          style={{ color: "var(--wp-dark, #111)" }}
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
          height: "32rem",
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
              className={`${
                position === "floating" ? "hidden" : ""
              } fixed lg:static inset-y-0 left-0 z-30 w-64 border-r flex flex-col transition-transform lg:translate-x-0 ${
                sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
              }`}
              style={{
                background: "var(--wp-dark-surface, #1a1a1a)",
                borderColor: "var(--wp-dark-border, #333)",
              }}
            >
              <div
                className="flex items-center justify-between px-4 py-3 border-b"
                style={{ borderColor: "var(--wp-dark-border, #333)" }}
              >
                <span className="text-sm font-medium" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                  Conversations
                </span>
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="lg:hidden p-1"
                  style={{ color: "var(--wp-text-muted, #6b7280)" }}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {conversations.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                    No conversations yet
                  </div>
                ) : (
                  conversations.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => loadConversation(c.id)}
                      className="w-full text-left px-4 py-3 border-b text-sm transition-colors hover:opacity-80"
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
          {/* Header */}
          <div
            className="flex items-center gap-3 px-4 py-3 border-b shrink-0"
            style={{ borderColor: "var(--wp-dark-border, #333)" }}
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

            {/* Brain icon */}
            <svg
              className="w-6 h-6 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              style={{ color: "var(--wp-gold, #eab308)" }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"
              />
            </svg>

            <h1
              className={`${position === "floating" ? "text-sm" : "text-lg"} font-bold`}
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

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <svg
                  className="w-16 h-16 mb-4"
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
                <h2 className="text-lg font-medium mb-2" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                  Your AI-powered team assistant
                </h2>
                <p className="text-sm max-w-md" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                  Ask about projects, clients, processes, or anything work-related.
                  Get instant answers — no digging through files or emails.
                </p>
              </div>
            )}

            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`${
                    position === "floating" ? "max-w-[90%]" : "max-w-[80%] lg:max-w-[60%]"
                  } rounded-xl px-4 py-3`}
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

                  <div className="text-sm whitespace-pre-wrap leading-relaxed break-words overflow-hidden">
                    {msg.content}
                  </div>

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
                            <svg className="w-4 h-4" fill={msg.rating === 5 ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6.633 10.5c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 012.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 00.322-1.672V3a.75.75 0 01.75-.75A2.25 2.25 0 0116.5 4.5c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 01-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 00-1.423-.23H5.904M14.25 9h2.25M5.904 18.75c.083.205.173.405.27.602.197.4-.078.898-.523.898h-.908c-.889 0-1.713-.518-1.972-1.368a12 12 0 01-.521-3.507c0-1.553.295-3.036.831-4.398C3.387 10.203 4.167 9.75 5 9.75h1.053c.472 0 .745.556.5.96a8.958 8.958 0 00-1.302 4.665c0 1.194.232 2.333.654 3.375z" />
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
                            <svg className="w-4 h-4" fill={msg.rating === 1 ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 15h2.25m8.024-9.75c.011.05.028.1.052.148.591 1.2.924 2.55.924 3.977a8.96 8.96 0 01-1.302 4.666c-.245.403.028.959.5.959h1.053c.832 0 1.612-.453 1.918-1.227C21.705 12.661 22 11.355 22 10c0-1.553-.295-3.036-.831-4.398C20.613 4.547 19.833 4.1 19 4.1h-1.053c-.472 0-.745.556-.5.96" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {loading && (
              <div className="flex justify-start">
                <div
                  className="rounded-xl px-4 py-3"
                  style={{ background: "var(--wp-dark-surface2, #222)" }}
                >
                  <div className="flex items-center gap-1.5">
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
                placeholder="Ask me anything..."
                rows={1}
                className="flex-1 resize-none rounded-xl px-4 py-3 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2, #222)",
                  color: "var(--wp-text, #eee)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  maxHeight: "120px",
                }}
                disabled={loading}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                className="shrink-0 rounded-xl px-4 py-3 text-sm font-medium transition-opacity disabled:opacity-40"
                style={{
                  background: "var(--wp-gold, #eab308)",
                  color: "var(--wp-dark, #111)",
                }}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              </button>
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
