"use client";

/**
 * Journal offline wrapper — extend the templatized offline pattern
 * to the Journal PUT path so a user can jot a daily note while fully
 * offline (e.g. on a plane) and have it land on the server as soon as
 * the browser reconnects.
 *
 * Contract — PUT /api/journal (see src/app/api/journal/route.ts):
 *   body: { journal_id, content?, mood?, highlights?, blockers? }
 *   auth: requireCapability("journal.write")
 *   200  : { journal } — updated row
 *   4xx  : { error }   — validation / auth
 *   500  : { error }
 *
 * Offline behavior:
 *   - When `navigator.onLine` is true we hit the endpoint inline via
 *     `fetchWithRefresh` (same headers as the current journal page).
 *   - When offline, or the inline PUT fails transiently, we enqueue
 *     the mutation for the shared offline-queue. The queue replays
 *     on the next `online` event with a fresh Authorization header.
 *   - We cache the write locally under resource_type="journal_entry"
 *     so a subsequent offline cold-load can render the edit the user
 *     just made (GET returns the server row; cache returns their
 *     pending overwrite — callers merge as needed).
 *
 * Analytics:
 *   - `offline.mutation_queued` fires on the queue path from the
 *     underlying offline-queue module (endpoint + method metadata).
 *   - `journal.entry_created_offline` fires ALSO on the queue path
 *     so per-feature dashboards can slice offline-draft volume by
 *     module without parsing `endpoint` strings.
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

export const JOURNAL_ENTRY_RESOURCE = "journal_entry";
export const JOURNAL_ENTRY_ENDPOINT = "/api/journal";

export interface JournalEntryDraft {
  /** journal_id: server-side primary key — required by the PUT handler. */
  journal_id: string;
  content?: string;
  mood?: string | null;
  highlights?: string[];
  blockers?: string[];
}

export interface SaveJournalEntryResult {
  /** "created" when the server accepted inline, "queued" when replayed-later. */
  status: "created" | "queued";
  /** The journal_id (always the caller's — we never mint new ids client-side). */
  id: string;
  /** The queue entry id when status === "queued", else null. */
  queueId: string | null;
}

/**
 * Primary entry point. Callable from both online and offline contexts.
 *
 * Online path: PUT the entry inline, cache the snapshot for subsequent
 * offline cold-loads, return `{status: "created", id}`.
 *
 * Offline (or transient failure) path: cache the snapshot, enqueue the
 * mutation, fire the per-feature analytics event, return
 * `{status: "queued", id}`.
 */
export async function saveJournalEntryOffline(
  draft: JournalEntryDraft,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SaveJournalEntryResult> {
  if (!draft.journal_id) {
    throw new Error("journal_id is required");
  }

  await cacheResource(JOURNAL_ENTRY_RESOURCE, draft.journal_id, draft);

  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  const fetchImpl = opts.fetchImpl ?? ((...args) => fetchWithRefresh(...args));

  if (online) {
    try {
      const res = await fetchImpl(JOURNAL_ENTRY_ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (res.ok) {
        return { status: "created", id: draft.journal_id, queueId: null };
      }
      // Non-ok → fall through to queue. Terminal 4xx will be marked
      // failed by the underlying flushQueue; user still sees their
      // local cache so the UI never blanks.
    } catch {
      // Network error — fall through to queue.
    }
  }

  const entry = await enqueueMutation({
    endpoint: JOURNAL_ENTRY_ENDPOINT,
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Instinct-Resource-Type": JOURNAL_ENTRY_RESOURCE,
    },
    body: draft,
  });
  notifyQueueChanged();
  void emitOfflineCreateEvent("journal.entry_created_offline", {
    resource_type: JOURNAL_ENTRY_RESOURCE,
    entry_id: draft.journal_id,
  });
  return {
    status: "queued",
    id: draft.journal_id,
    queueId: entry.id,
  };
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

export async function loadJournalEntry(
  journalId: string,
  opts?: { silent?: boolean },
): Promise<JournalEntryDraft | null> {
  const rec = await readCachedResource<JournalEntryDraft>(
    JOURNAL_ENTRY_RESOURCE,
    journalId,
    { silent: opts?.silent },
  );
  return rec?.data ?? null;
}

export async function listOfflineJournalEntries(): Promise<
  ResourceCacheEntry<JournalEntryDraft>[]
> {
  const rows = await listCachedResources(JOURNAL_ENTRY_RESOURCE);
  return rows as ResourceCacheEntry<JournalEntryDraft>[];
}

export async function deleteOfflineJournalEntry(journalId: string): Promise<void> {
  await clearResource(JOURNAL_ENTRY_RESOURCE, journalId);
}

// ---------------------------------------------------------------------------
// Analytics — fire-and-forget per-feature offline-create event
// ---------------------------------------------------------------------------

async function emitOfflineCreateEvent(
  event: "journal.entry_created_offline",
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
