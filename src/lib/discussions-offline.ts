"use client";

/**
 * Discussions offline wrapper (Stream U2 templated rollout).
 *
 * Applies the Stream U4 offline pattern (offline-queue + offline-cache)
 * to the two mutation paths on the /discussions surface:
 *
 *   - POST /api/discussions        → new thread
 *   - POST /api/discussions/{id}   → reply to an existing thread
 *
 * Contract with callers (sendDiscussion*Offline):
 *   { status: "sent",   id: string }  — inline POST succeeded (2xx)
 *   { status: "queued", id: string }  — network down OR server non-ok;
 *                                        mutation is enqueued for replay
 *
 * Behavior:
 *   - If `navigator.onLine === false` we skip the inline POST and queue
 *     immediately (matches meetings-offline.ts template).
 *   - If `navigator.onLine === true` we attempt the POST. On 2xx we
 *     return { status: "sent", id: server-assigned or nonce }. On any
 *     non-ok response OR a thrown error (mid-flight network drop) we
 *     fall through to the queue — a 503/timeout should never drop the
 *     user's reply on the floor.
 *   - Queue entry carries X-Instinct-Resource-Type header so the queue
 *     module tags the replay with the right resource dimension for
 *     analytics slicing.
 *   - On the QUEUE path we fire a feature-specific event:
 *       discussion.reply_queued_offline
 *       discussion.thread_queued_offline
 *     These live alongside the existing offline.mutation_queued /
 *     _replayed / _replay_failed events fired by offline-queue itself.
 *     We do NOT fire queued events when the server accepts the write
 *     inline (status === "sent") — those already emit the server-side
 *     trackEvent("discussion.thread_created" / "reply_posted").
 *   - Replay on reconnect reuses the queue's FIFO drain so existing
 *     Stream U4 behavior covers the return-online path.
 *
 * Zero new runtime deps; native fetchWithRefresh + IDB only.
 */

import { enqueueMutation } from "@/lib/offline-queue";
import { notifyQueueChanged } from "@/components/sites/OfflineStatusPill";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const DISCUSSION_THREAD_RESOURCE = "discussion_thread";
export const DISCUSSION_REPLY_RESOURCE = "discussion_reply";
export const DISCUSSION_THREADS_ENDPOINT = "/api/discussions";

export function discussionReplyEndpoint(threadId: string): string {
  return `/api/discussions/${encodeURIComponent(threadId)}`;
}

export interface NewThreadBody {
  title: string;
  category: string;
  content: string;
  tags?: string[];
}

export interface ReplyBody {
  thread_id: string;
  content: string;
  attachments?: unknown[];
}

export type OfflineSendStatus = "sent" | "queued";

export interface OfflineSendResult {
  status: OfflineSendStatus;
  /**
   * For "sent" this is the server-assigned id (thread or reply) when
   * available, otherwise a local nonce. For "queued" this is the queue
   * entry id (the same id the OfflineStatusPill surfaces).
   */
  id: string;
}

export interface OfflineSendOptions {
  fetchImpl?: typeof fetch;
  /** Test seam — override `navigator.onLine`. */
  isOnline?: () => boolean;
  /** Test seam — route analytics through an emitter instead of POST. */
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
// Public API — new thread
// ---------------------------------------------------------------------------

export async function sendDiscussionThreadOffline(
  body: NewThreadBody,
  opts: OfflineSendOptions = {},
): Promise<OfflineSendResult> {
  const online = (opts.isOnline ?? probeOnline)();
  const fetchImpl =
    opts.fetchImpl ?? ((...args) => fetchWithRefresh(...args));
  const emit =
    opts.onAnalytics ??
    ((e, m) => {
      void postAnalytics(e, m);
    });

  if (online) {
    try {
      const res = await fetchImpl(DISCUSSION_THREADS_ENDPOINT, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      if (res.ok) {
        let serverId: string | undefined;
        try {
          const data = (await res.json()) as { thread?: { id?: string } };
          serverId = data?.thread?.id;
        } catch {
          /* ignore — some mocks don't provide json */
        }
        return { status: "sent", id: serverId ?? randomNonce() };
      }
      // non-ok → fall through to queue
    } catch {
      // Network error (offline transition, DNS, etc.) — fall through.
    }
  }

  const entry = await enqueueMutation({
    endpoint: DISCUSSION_THREADS_ENDPOINT,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Instinct-Resource-Type": DISCUSSION_THREAD_RESOURCE,
    },
    body,
  });
  notifyQueueChanged();
  emit("discussion.thread_queued_offline", {
    queue_id: entry.id,
    resource_type: DISCUSSION_THREAD_RESOURCE,
    category: body.category,
    title_length: body.title.length,
    content_length: body.content.length,
  });
  return { status: "queued", id: entry.id };
}

// ---------------------------------------------------------------------------
// Public API — reply
// ---------------------------------------------------------------------------

export async function sendDiscussionReplyOffline(
  body: ReplyBody,
  opts: OfflineSendOptions = {},
): Promise<OfflineSendResult> {
  if (!body.thread_id) {
    throw new Error("sendDiscussionReplyOffline: thread_id is required");
  }
  const online = (opts.isOnline ?? probeOnline)();
  const fetchImpl =
    opts.fetchImpl ?? ((...args) => fetchWithRefresh(...args));
  const emit =
    opts.onAnalytics ??
    ((e, m) => {
      void postAnalytics(e, m);
    });

  const endpoint = discussionReplyEndpoint(body.thread_id);
  const payload: Record<string, unknown> = { content: body.content };
  if (body.attachments && body.attachments.length > 0) {
    payload.attachments = body.attachments;
  }

  if (online) {
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        let serverId: string | undefined;
        try {
          const data = (await res.json()) as { reply?: { id?: string } };
          serverId = data?.reply?.id;
        } catch {
          /* ignore */
        }
        return { status: "sent", id: serverId ?? randomNonce() };
      }
    } catch {
      /* fall through */
    }
  }

  const entry = await enqueueMutation({
    endpoint,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Instinct-Resource-Type": DISCUSSION_REPLY_RESOURCE,
    },
    body: payload,
  });
  notifyQueueChanged();
  emit("discussion.reply_queued_offline", {
    queue_id: entry.id,
    resource_type: DISCUSSION_REPLY_RESOURCE,
    thread_id: body.thread_id,
    content_length: body.content.length,
  });
  return { status: "queued", id: entry.id };
}
