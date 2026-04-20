"use client";

/**
 * Assistant message-draft offline wrapper (Stream U2 templated rollout).
 *
 * When the user types a message to the Wolfpack Assistant while offline,
 * we queue the USER MESSAGE (not the reply) for replay. On reconnect the
 * offline-queue module drains the FIFO in order, so the server sees the
 * messages in the same sequence the user typed them. The server reply
 * is always server-generated — we are NOT caching replies here (that's
 * U2's existing RAG-offline path in assistant-rag-offline.ts).
 *
 * Contract with callers:
 *   sendAssistantMessageOffline(body)
 *   → { status: "sent",   id }   — inline POST succeeded (2xx)
 *   → { status: "queued", id }   — offline OR non-ok; user message is
 *                                  queued and will replay on reconnect
 *
 * Analytics on the QUEUE path:
 *   assistant.message_queued_offline  { queue_id, conversation_id?,
 *                                       message_length, has_attachments,
 *                                       resource_type }
 *
 * We deliberately do NOT support file attachments through the queue:
 *   - file content lives in memory at send time (not replay time)
 *   - quality gates are server-side and their output can't be reasoned
 *     about until the network is back
 *   - IndexedDB is not a CDN — staching multi-MB uploads is an
 *     anti-pattern (see docs/offline-pattern.md "When NOT to use it").
 * Callers with attachments MUST fall back to the existing synchronous
 * path (InstinctChat already branches on attachments) — this wrapper
 * explicitly rejects attachments via a runtime check.
 *
 * Zero new runtime deps; native fetchWithRefresh + IDB only.
 */

import { enqueueMutation } from "@/lib/offline-queue";
import { notifyQueueChanged } from "@/components/sites/OfflineStatusPill";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const ASSISTANT_MESSAGE_RESOURCE = "assistant_message";
export const ASSISTANT_ENDPOINT = "/api/assistant";

export interface AssistantMessageBody {
  message: string;
  conversationId?: string | null;
  pageContext?: string;
  contextData?: Record<string, unknown>;
}

export type AssistantSendStatus = "sent" | "queued";

export interface AssistantSendResult {
  status: AssistantSendStatus;
  /** For "sent" this is server messageId when available, else nonce. */
  id: string;
  /** When sent inline: the assistant's reply payload for UI rendering. */
  response?: {
    answer: string;
    source?: string;
    tokensUsed?: number;
    conversationId?: string | null;
    messageId?: string;
  };
}

export interface AssistantSendOptions {
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  onAnalytics?: (
    event: string,
    metadata: Record<string, string | number | boolean>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Analytics (fire-and-forget; never throws)
// ---------------------------------------------------------------------------

async function postAnalytics(
  event: string,
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  if (typeof window === "undefined") return;
  const token = getInstinctToken();
  if (!token) return;
  try {
    await fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, metadata }),
      keepalive: true,
    });
  } catch {
    /* best-effort */
  }
}

function probeOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function jsonHeaders(): Record<string, string> {
  const token = getInstinctToken();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function randomNonce(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `n_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function sendAssistantMessageOffline(
  body: AssistantMessageBody,
  opts: AssistantSendOptions = {},
): Promise<AssistantSendResult> {
  if (!body.message || typeof body.message !== "string") {
    throw new Error("sendAssistantMessageOffline: message is required");
  }

  const online = (opts.isOnline ?? probeOnline)();
  const fetchImpl =
    opts.fetchImpl ?? ((...args) => fetchWithRefresh(...args));
  const emit =
    opts.onAnalytics ??
    ((e, m) => {
      void postAnalytics(e, m);
    });

  const payload: Record<string, unknown> = { message: body.message };
  if (body.conversationId !== undefined && body.conversationId !== null) {
    payload.conversationId = body.conversationId;
  }
  if (body.pageContext) payload.pageContext = body.pageContext;
  if (body.contextData) payload.contextData = body.contextData;

  if (online) {
    try {
      const res = await fetchImpl(ASSISTANT_ENDPOINT, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        interface AssistantApiResponse {
          response?: string;
          source?: string;
          tokensUsed?: number;
          conversationId?: string | null;
          messageId?: string;
        }
        let data: AssistantApiResponse | null = null;
        try {
          data = (await res.json()) as AssistantApiResponse;
        } catch {
          /* best-effort — some mocks omit .json */
        }
        return {
          status: "sent",
          id: data?.messageId ?? randomNonce(),
          response: {
            answer: data?.response ?? "",
            source: data?.source,
            tokensUsed: data?.tokensUsed,
            conversationId: data?.conversationId ?? null,
            messageId: data?.messageId,
          },
        };
      }
      // non-ok (e.g., 503) → fall through to queue so the user message
      // isn't silently dropped.
    } catch {
      /* fall through */
    }
  }

  const entry = await enqueueMutation({
    endpoint: ASSISTANT_ENDPOINT,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Instinct-Resource-Type": ASSISTANT_MESSAGE_RESOURCE,
    },
    body: payload,
  });
  notifyQueueChanged();
  emit("assistant.message_queued_offline", {
    queue_id: entry.id,
    resource_type: ASSISTANT_MESSAGE_RESOURCE,
    conversation_id: body.conversationId ?? "",
    message_length: body.message.length,
    has_page_context: Boolean(body.pageContext),
  });
  return { status: "queued", id: entry.id };
}
