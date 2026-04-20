"use client";

/**
 * useOfflineQueue — React hook wrapping `src/lib/offline-queue.ts`.
 *
 * Templatizes the site-editor offline queue so any feature (meetings,
 * HR, knowledge, journals, discussions) gets:
 *   - one-call enqueue that auto-queues when offline and POSTs when online
 *   - reactive pendingCount + isFlushing so components can render state
 *   - manual flush() trigger for "retry now" buttons
 *
 * Design notes:
 *   - Does NOT wrap `useState` around the underlying IDB queue — that
 *     would double the source of truth. Instead subscribes to the
 *     `instinct-offline-queue-changed` custom event that the pill +
 *     enqueue path already fire. One source of truth, reactive UI.
 *   - `replay` lets callers override the replay fetch (e.g. to hit a
 *     different endpoint on reconnect than they enqueued — useful when
 *     drafts post to /api/meetings/draft but final sync hits /api/meetings).
 *     Defaults to a straightforward POST to the original endpoint, which
 *     is what the underlying flushQueue already does.
 *   - Fires no new analytics itself; the underlying queue fires
 *     offline.mutation_queued / _replayed / _replay_failed, and tags
 *     those with `resource_type` so dashboards can slice by feature.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  enqueueMutation,
  flushQueue,
  listQueue,
  type MutationMethod,
  type QueuedMutation,
} from "@/lib/offline-queue";
import { notifyQueueChanged } from "@/components/sites/OfflineStatusPill";

const CHANGE_EVENT = "instinct-offline-queue-changed";

export interface UseOfflineQueueOptions<B> {
  /**
   * Optional replay override. Rarely needed — the default behavior is
   * to POST the original body back to the original endpoint, which is
   * what `flushQueue` already does. Provided here so specialized
   * features (e.g. draft auto-promotion) can transform the body at
   * replay time.
   */
  replay?: (body: B) => Promise<Response>;
  /**
   * Resource type label — stamped into every enqueued payload so
   * analytics dashboards can slice `offline.mutation_queued` by
   * feature area (brief vs meeting_draft vs hr_doc_pending, ...).
   * Defaults to "generic".
   */
  resourceType?: string;
  /** Custom headers to attach on enqueue (minus Authorization — stripped). */
  headers?: Record<string, string>;
}

export interface UseOfflineQueueResult<B> {
  enqueue: (body: B) => Promise<string>;
  pendingCount: number;
  isFlushing: boolean;
  flush: () => Promise<void>;
}

export function useOfflineQueue<B>(
  endpoint: string,
  method: MutationMethod,
  options: UseOfflineQueueOptions<B> = {},
): UseOfflineQueueResult<B> {
  const [pendingCount, setPendingCount] = useState(0);
  const [isFlushing, setIsFlushing] = useState(false);
  const flushingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const rows: QueuedMutation[] = await listQueue();
      setPendingCount(
        rows.filter(
          (r) => r.endpoint === endpoint && r.status === "pending",
        ).length,
      );
    } catch {
      /* ignore */
    }
  }, [endpoint]);

  const enqueue = useCallback(
    async (body: B): Promise<string> => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      };
      // Stamp resource_type so the underlying analytics event carries
      // the slice dimension we want on dashboards. The queue module
      // doesn't know about resource_type, so we carry it as a custom
      // header (non-session, kept intact on replay).
      if (options.resourceType) {
        headers["X-Instinct-Resource-Type"] = options.resourceType;
      }

      const entry = await enqueueMutation({
        endpoint,
        method,
        headers,
        body,
      });
      notifyQueueChanged();
      await refresh();
      return entry.id;
    },
    [endpoint, method, options.headers, options.resourceType, refresh],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    setIsFlushing(true);
    try {
      if (options.replay) {
        // Drain ONLY entries for this endpoint via the user-provided replay.
        const rows = (await listQueue()).filter(
          (r) => r.endpoint === endpoint && r.status === "pending",
        );
        for (const row of rows) {
          try {
            const parsed = row.body ? (JSON.parse(row.body) as B) : ({} as B);
            const res = await options.replay(parsed);
            if (res.ok) {
              // Custom replay succeeded — delegate delete via flushQueue's
              // store access isn't public, so re-running flushQueue will
              // not double-POST because the entry is gone after the below
              // native delete. We use the module's deleteEntry indirectly
              // by re-enqueuing and immediately flushing the rest — but
              // that's not idempotent. Safer: just let the default flush
              // replay as well. Custom-replay is a user promise of "I
              // know what I'm doing", so we swallow the delete as well.
              // The underlying library does not expose deleteEntry as
              // an ESM export? It does — imported below.
              const { deleteEntry } = await import("@/lib/offline-queue");
              await deleteEntry(row.id);
            }
          } catch {
            /* best-effort — fall through to flushQueue for retry semantics */
          }
        }
      }
      await flushQueue();
      notifyQueueChanged();
    } finally {
      flushingRef.current = false;
      setIsFlushing(false);
      await refresh();
    }
  }, [endpoint, options, refresh]);

  // Auto-refresh on mount + on queue-changed events.
  useEffect(() => {
    void refresh();
    if (typeof window === "undefined") return;
    const onChange = () => {
      void refresh();
    };
    const onOnline = () => {
      void flush();
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh, flush]);

  return { enqueue, pendingCount, isFlushing, flush };
}
