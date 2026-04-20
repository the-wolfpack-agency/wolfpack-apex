"use client";

/**
 * Worked example — applying the offline pattern to meeting transcript
 * drafts. Serves two purposes:
 *   1. Proof the Stream U4 offline primitives work for a non-sites
 *      feature without modification.
 *   2. Template that dev-copilots (and humans) can crib from when
 *      adding offline support to HR docs, journals, discussions,
 *      knowledge captures.
 *
 * What this gives meetings:
 *   - `saveMeetingDraftOffline(draft)` — persist locally + enqueue a
 *     POST to /api/meetings so the server gets it whenever the
 *     browser next has a connection. Works while fully offline.
 *   - `loadMeetingDraft(draftId, fetcher)` — read a cached draft on
 *     cold-load; serves-stale when offline, refreshes from server
 *     when online.
 *   - `listOfflineMeetingDrafts()` — inspect what's pending locally.
 *
 * IMPORTANT: GET /api/meetings exists (see src/app/api/meetings/route.ts)
 * but it currently does NOT accept POST for draft creation — drafts
 * are produced server-side by the Plaud webhook. In production we'd
 * either add a POST handler or route drafts through a new endpoint
 * (e.g. /api/meetings/draft). This file assumes that endpoint lands
 * as part of the meetings-offline rollout; the contract is:
 *   POST /api/meetings/draft { draft_id, title, notes, created_at }
 *   → 200 | 201 with the server-assigned identifiers.
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

export const MEETING_DRAFT_RESOURCE = "meeting_draft";
export const MEETING_DRAFT_ENDPOINT = "/api/meetings/draft";

export interface MeetingDraft {
  draft_id: string;
  title: string;
  notes: string;
  created_at: number;
  /** Attendees free-text — canonical list lives server-side post-sync. */
  attendees?: string[];
}

// ---------------------------------------------------------------------------
// Write path — cache locally + enqueue for server replay
// ---------------------------------------------------------------------------

export interface SaveMeetingDraftResult {
  /** The queued mutation id — useful for the UI to show "saving..." */
  queueId: string | null;
  /** True if we hit the server inline (online path). False if queued. */
  syncedInline: boolean;
}

/**
 * Primary entry point. Callable from both online and offline contexts.
 *
 * - Always writes to the local cache (so a subsequent read returns
 *   the draft even if the tab is restarted offline).
 * - If navigator.onLine, attempts an inline POST. On success: no
 *   queue entry is created. On failure: falls through to the queue.
 * - If navigator.onLine is false, skips the inline POST and queues.
 */
export async function saveMeetingDraftOffline(
  draft: MeetingDraft,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SaveMeetingDraftResult> {
  await cacheResource(MEETING_DRAFT_RESOURCE, draft.draft_id, draft);

  const online =
    typeof navigator === "undefined" ? true : navigator.onLine;
  const fetchImpl =
    opts.fetchImpl ?? ((...args) => fetchWithRefresh(...args));

  if (online) {
    try {
      const res = await fetchImpl(MEETING_DRAFT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (res.ok) {
        return { queueId: null, syncedInline: true };
      }
      // Non-ok → fall through to queue.
    } catch {
      // Network error (offline transition, DNS, etc.) — fall through.
    }
  }

  const entry = await enqueueMutation({
    endpoint: MEETING_DRAFT_ENDPOINT,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Instinct-Resource-Type": MEETING_DRAFT_RESOURCE,
    },
    body: draft,
  });
  notifyQueueChanged();
  // Per-feature offline-create event. The underlying queue also fires
  // `offline.mutation_queued` with endpoint/method; this extra event
  // lets feature-specific dashboards slice by `resource_type` + the
  // draft_id without having to parse the generic `endpoint` metadata.
  void emitOfflineCreateEvent("meeting.draft_created_offline", {
    resource_type: MEETING_DRAFT_RESOURCE,
    draft_id: draft.draft_id,
  });
  return { queueId: entry.id, syncedInline: false };
}

// ---------------------------------------------------------------------------
// Analytics — fire-and-forget per-feature offline-create event
// ---------------------------------------------------------------------------

async function emitOfflineCreateEvent(
  event: "meeting.draft_created_offline",
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

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

export async function loadMeetingDraft(
  draftId: string,
  opts?: { silent?: boolean },
): Promise<MeetingDraft | null> {
  const rec = await readCachedResource<MeetingDraft>(
    MEETING_DRAFT_RESOURCE,
    draftId,
    { silent: opts?.silent },
  );
  return rec?.data ?? null;
}

export async function listOfflineMeetingDrafts(): Promise<
  ResourceCacheEntry<MeetingDraft>[]
> {
  const rows = await listCachedResources(MEETING_DRAFT_RESOURCE);
  return rows as ResourceCacheEntry<MeetingDraft>[];
}

export async function deleteOfflineMeetingDraft(draftId: string): Promise<void> {
  await clearResource(MEETING_DRAFT_RESOURCE, draftId);
}
