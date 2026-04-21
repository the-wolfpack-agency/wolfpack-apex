"use client";

/**
 * Goals offline wrapper (Stream U4-style templated offline rollout).
 *
 * Mirrors `discussions-offline.ts`: the UI calls `sendCommitmentOffline`
 * / `sendGradeOffline`; if the network is down or the server returns
 * non-ok, the mutation is persisted to the offline IDB queue and the
 * OfflineStatusPill surfaces the pending count. On reconnect the queue
 * drains (Stream U4 flush handler already wired in the dashboard
 * layout).
 *
 * Contract:
 *   { status: "sent",   id }  — inline POST/PATCH succeeded (2xx)
 *   { status: "queued", id }  — network down OR server non-ok; queued
 *                                for replay
 *
 * Analytics:
 *   - Queued path fires `goal.commitment_queued_offline`.
 *   - Sent path does NOT fire a queued event (server-side
 *     goal.commitment_ui_submitted / goal.commitment_ui_graded already
 *     runs). Inline success is tracked server-side.
 */

import { enqueueMutation } from "@/lib/offline-queue";
import { notifyQueueChanged } from "@/components/sites/OfflineStatusPill";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";

export const GOAL_COMMITMENT_RESOURCE = "goal_commitment";
export const GOAL_GRADE_RESOURCE = "goal_grade";
export const GOAL_COMMITMENTS_ENDPOINT = "/api/goals/contributions";
export function goalGradeEndpoint(contributionId: string): string {
  return `/api/goals/contributions/${encodeURIComponent(contributionId)}/grade`;
}

export interface CommitmentBody {
  kr_id: string;
  description: string;
  committed_for_week?: string | null;
}

export interface GradeBody {
  contribution_id: string;
  graded_as: "hit" | "miss" | "close";
}

export type OfflineSendStatus = "sent" | "queued";
export interface OfflineSendResult {
  status: OfflineSendStatus;
  id: string;
}

export interface OfflineSendOptions {
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  onAnalytics?: (
    event: string,
    metadata: Record<string, string | number | boolean>,
  ) => void;
}

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
// Public API — create manual commitment
// ---------------------------------------------------------------------------

export async function sendCommitmentOffline(
  body: CommitmentBody,
  opts: OfflineSendOptions = {},
): Promise<OfflineSendResult> {
  if (!body.kr_id || !body.description) {
    throw new Error("sendCommitmentOffline: kr_id + description are required");
  }
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
      const res = await fetchImpl(GOAL_COMMITMENTS_ENDPOINT, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      if (res.ok) {
        let serverId: string | undefined;
        try {
          const data = (await res.json()) as { contribution?: { id?: string } };
          serverId = data?.contribution?.id;
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
    endpoint: GOAL_COMMITMENTS_ENDPOINT,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Instinct-Resource-Type": GOAL_COMMITMENT_RESOURCE,
    },
    body,
  });
  notifyQueueChanged();
  emit("goal.commitment_queued_offline", {
    queue_id: entry.id,
    resource_type: GOAL_COMMITMENT_RESOURCE,
    kr_id: body.kr_id,
  });
  return { status: "queued", id: entry.id };
}

// ---------------------------------------------------------------------------
// Public API — grade commitment
// ---------------------------------------------------------------------------

export async function sendGradeOffline(
  body: GradeBody,
  opts: OfflineSendOptions = {},
): Promise<OfflineSendResult> {
  if (!body.contribution_id || !body.graded_as) {
    throw new Error(
      "sendGradeOffline: contribution_id + graded_as are required",
    );
  }
  const online = (opts.isOnline ?? probeOnline)();
  const fetchImpl =
    opts.fetchImpl ?? ((...args) => fetchWithRefresh(...args));

  const endpoint = goalGradeEndpoint(body.contribution_id);
  const payload = { graded_as: body.graded_as };

  if (online) {
    try {
      const res = await fetchImpl(endpoint, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        let serverId: string | undefined;
        try {
          const data = (await res.json()) as { contribution?: { id?: string } };
          serverId = data?.contribution?.id;
        } catch {
          /* ignore */
        }
        return { status: "sent", id: serverId ?? body.contribution_id };
      }
    } catch {
      /* fall through */
    }
  }

  const entry = await enqueueMutation({
    endpoint,
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Instinct-Resource-Type": GOAL_GRADE_RESOURCE,
    },
    body: payload,
  });
  notifyQueueChanged();
  return { status: "queued", id: entry.id };
}
