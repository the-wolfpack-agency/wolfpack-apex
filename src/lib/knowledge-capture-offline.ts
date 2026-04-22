"use client";

/**
 * Knowledge-capture offline wrapper — Stream U1 templated offline
 * rollout applied to the knowledge-base CREATE path.
 *
 * A "knowledge capture" is a user-authored Q&A entry the team wants
 * to seed into the knowledge base (i.e. "here's a question we field
 * often and the canonical answer, save it so the next person asking
 * gets a zero-token cache hit"). This is the inverse of the existing
 * `/api/knowledge` POST path which ASKS a cached question — here we
 * add a fresh entry that the learning loop + RAG layer can index.
 *
 * Why a wrapper instead of calling `fetchWithRefresh` directly?
 *   - Designers / ops often add knowledge entries from the field
 *     (mobile, airplane, client site). The network is unreliable.
 *   - If we drop the write silently we lose the human-vetted Q&A
 *     entirely — the highest-signal data the system ever sees.
 *   - Bundling the write behind the offline queue makes the UI
 *     feel instant ("Saved locally — will sync when online")
 *     AND guarantees the entry lands on the server the moment
 *     the browser reconnects.
 *
 * Contract with the server:
 *   POST /api/knowledge
 *   body: { entry_id, question, answer, source?, tags?, created_at }
 *   auth: Bearer JWT (replay re-attaches at flush time)
 *   200  : { entry }   — server-assigned row
 *   4xx  : terminal (validation / auth)
 *   5xx  : retry up to MAX_ATTEMPTS with exponential backoff
 *
 * The `entry_id` is minted CLIENT-SIDE (crypto.randomUUID or nonce
 * fallback) so the offline-side idempotency surface is stable — if
 * the browser crashes mid-flush and the user retries, the server
 * can dedupe on entry_id.
 *
 * Analytics (queue path only):
 *   knowledge.entry_created_offline { resource_type, entry_id }
 *
 * Callers inline hit the server via `fetchWithRefresh`; only the
 * QUEUED path fires `knowledge.entry_created_offline` so dashboards
 * can slice by resilience-path without double counting.
 */

import {
  cacheResource,
  clearResource,
  listCachedResources,
  readCachedResource,
  type ResourceCacheEntry,
} from "@/lib/offline-cache";
import { enqueueMutation } from "@/lib/offline-queue";
import { notifyQueueChanged } from "@/components/sites/OfflineStatusPill";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

export const KNOWLEDGE_ENTRY_RESOURCE = "knowledge_entry";
export const KNOWLEDGE_ENTRY_ENDPOINT = "/api/knowledge";

export interface KnowledgeCaptureDraft {
  /** Client-minted stable id — required. Server dedupes on this. */
  entry_id: string;
  question: string;
  answer: string;
  /** "human" | "docs" | "codebase" | "ai" — defaults to "human" server-side. */
  source?: string;
  tags?: string[];
  /** ms epoch — informational only; server stamps its own row ts. */
  created_at: number;
}

export interface SaveKnowledgeEntryResult {
  /** "created" when the server accepted inline, "queued" when replayed-later. */
  status: "created" | "queued";
  /** The entry_id — always the caller's. */
  id: string;
  /** Queue entry id on the queued path, else null. */
  queueId: string | null;
}

// ---------------------------------------------------------------------------
// Write path — cache locally + inline-POST + fall through to queue
// ---------------------------------------------------------------------------

/**
 * Primary entry point. Callable from both online and offline contexts.
 *
 * Online path: POST the entry inline via fetchWithRefresh, cache the
 * snapshot for offline cold-loads, return `{status: "created", id}`.
 *
 * Offline (or transient failure) path: cache the snapshot, enqueue the
 * mutation, fire `knowledge.entry_created_offline`, return
 * `{status: "queued", id, queueId}`.
 */
export async function saveKnowledgeEntryOffline(
  draft: KnowledgeCaptureDraft,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SaveKnowledgeEntryResult> {
  if (!draft.entry_id) {
    throw new Error("entry_id is required");
  }
  if (!draft.question || typeof draft.question !== "string") {
    throw new Error("question is required");
  }
  if (!draft.answer || typeof draft.answer !== "string") {
    throw new Error("answer is required");
  }

  // 1) Always cache locally — a subsequent offline cold-load can still
  //    render the pending entry even if the tab restarts before replay.
  await cacheResource(KNOWLEDGE_ENTRY_RESOURCE, draft.entry_id, draft);

  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  const fetchImpl = opts.fetchImpl ?? ((...args) => fetchWithRefresh(...args));

  if (online) {
    try {
      const res = await fetchImpl(KNOWLEDGE_ENTRY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (res.ok) {
        return { status: "created", id: draft.entry_id, queueId: null };
      }
      // Non-ok → fall through to queue. Terminal 4xx will be marked
      // failed by the underlying flushQueue; user still sees their
      // local cache so the UI never blanks.
    } catch {
      // Network error mid-flight — fall through to the queue path.
    }
  }

  const entry = await enqueueMutation({
    endpoint: KNOWLEDGE_ENTRY_ENDPOINT,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Instinct-Resource-Type": KNOWLEDGE_ENTRY_RESOURCE,
    },
    body: draft,
  });
  notifyQueueChanged();
  void emitOfflineCreateEvent("knowledge.entry_created_offline", {
    resource_type: KNOWLEDGE_ENTRY_RESOURCE,
    entry_id: draft.entry_id,
  });
  return {
    status: "queued",
    id: draft.entry_id,
    queueId: entry.id,
  };
}

// ---------------------------------------------------------------------------
// Edit path — PUT /api/knowledge/{id} with offline-queue fallback
// ---------------------------------------------------------------------------

/**
 * Draft shape for an EDIT of an existing knowledge entry. Mirrors
 * `KnowledgeCaptureDraft` but keys on `entry_id` of an already-persisted
 * row and carries an `updated_at` client stamp for UI freshness hinting.
 */
export interface KnowledgeEditDraft {
  entry_id: string;
  question: string;
  answer: string;
  tags?: string[];
  source?: string;
  repo?: string;
  updated_at: number;
}

/**
 * Update an existing knowledge entry. Online path PUTs inline; offline
 * or failure path enqueues for replay and fires
 * `knowledge.entry_updated_offline` for the learning loop.
 */
export async function updateKnowledgeEntryOffline(
  draft: KnowledgeEditDraft,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SaveKnowledgeEntryResult> {
  if (!draft.entry_id) {
    throw new Error("entry_id is required");
  }
  if (!draft.question || typeof draft.question !== "string") {
    throw new Error("question is required");
  }
  if (!draft.answer || typeof draft.answer !== "string") {
    throw new Error("answer is required");
  }

  // Cache the edited snapshot so a subsequent offline cold-load still
  // renders the user's pending change even if the tab restarts before
  // replay lands.
  await cacheResource(KNOWLEDGE_ENTRY_RESOURCE, draft.entry_id, draft);

  const endpoint = `${KNOWLEDGE_ENTRY_ENDPOINT}/${encodeURIComponent(draft.entry_id)}`;
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  const fetchImpl = opts.fetchImpl ?? ((...args) => fetchWithRefresh(...args));

  if (online) {
    try {
      const res = await fetchImpl(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (res.ok) {
        return { status: "created", id: draft.entry_id, queueId: null };
      }
      // Non-ok → fall through to queue so the write isn't silently lost.
    } catch {
      // Network error mid-flight — fall through to the queue path.
    }
  }

  const entry = await enqueueMutation({
    endpoint,
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Instinct-Resource-Type": KNOWLEDGE_ENTRY_RESOURCE,
    },
    body: draft,
  });
  notifyQueueChanged();
  void emitOfflineCreateEvent("knowledge.entry_updated_offline", {
    resource_type: KNOWLEDGE_ENTRY_RESOURCE,
    entry_id: draft.entry_id,
  });
  return {
    status: "queued",
    id: draft.entry_id,
    queueId: entry.id,
  };
}

/**
 * Delete an existing knowledge entry. Online path DELETEs inline; offline
 * or failure path enqueues for replay and fires
 * `knowledge.entry_deleted_offline`. Returns the local cache is also
 * cleared so the UI state stays consistent either way.
 *
 * 404 is treated as terminal success: the server already agrees the row
 * is gone. 5xx / network errors fall through to the queue.
 */
export async function deleteKnowledgeEntryOffline(
  entryId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ status: "deleted" | "queued"; id: string; queueId: string | null }> {
  if (!entryId) {
    throw new Error("entry_id is required");
  }

  const endpoint = `${KNOWLEDGE_ENTRY_ENDPOINT}/${encodeURIComponent(entryId)}`;
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  const fetchImpl = opts.fetchImpl ?? ((...args) => fetchWithRefresh(...args));

  if (online) {
    try {
      const res = await fetchImpl(endpoint, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        await clearResource(KNOWLEDGE_ENTRY_RESOURCE, entryId);
        return { status: "deleted", id: entryId, queueId: null };
      }
      // Non-ok (5xx, 4xx other than 404) → fall through to queue.
    } catch {
      // Network error — fall through to the queue path.
    }
  }

  const entry = await enqueueMutation({
    endpoint,
    method: "DELETE",
    headers: {
      "X-Instinct-Resource-Type": KNOWLEDGE_ENTRY_RESOURCE,
    },
  });
  notifyQueueChanged();
  // Local cache cleared eagerly so the UI hides the row immediately;
  // the queued DELETE will reconcile the server side on reconnect.
  await clearResource(KNOWLEDGE_ENTRY_RESOURCE, entryId);
  void emitOfflineCreateEvent("knowledge.entry_deleted_offline", {
    resource_type: KNOWLEDGE_ENTRY_RESOURCE,
    entry_id: entryId,
  });
  return {
    status: "queued",
    id: entryId,
    queueId: entry.id,
  };
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

export async function loadKnowledgeEntry(
  entryId: string,
  opts?: { silent?: boolean },
): Promise<KnowledgeCaptureDraft | null> {
  const rec = await readCachedResource<KnowledgeCaptureDraft>(
    KNOWLEDGE_ENTRY_RESOURCE,
    entryId,
    { silent: opts?.silent },
  );
  return rec?.data ?? null;
}

export async function listOfflineKnowledgeEntries(): Promise<
  ResourceCacheEntry<KnowledgeCaptureDraft>[]
> {
  const rows = await listCachedResources(KNOWLEDGE_ENTRY_RESOURCE);
  return rows as ResourceCacheEntry<KnowledgeCaptureDraft>[];
}

export async function deleteOfflineKnowledgeEntry(entryId: string): Promise<void> {
  await clearResource(KNOWLEDGE_ENTRY_RESOURCE, entryId);
}

// ---------------------------------------------------------------------------
// Analytics — fire-and-forget per-feature offline-create event
// ---------------------------------------------------------------------------

async function emitOfflineCreateEvent(
  event:
    | "knowledge.entry_created_offline"
    | "knowledge.entry_updated_offline"
    | "knowledge.entry_deleted_offline",
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
