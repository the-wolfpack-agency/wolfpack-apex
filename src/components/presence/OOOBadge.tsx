"use client";

/**
 * OOOBadge — "Out of office" pill for a user's profile card.
 *
 * - `mode="self"` or omitting `instinctUserId` → calls /api/mailbox/me/ooo
 *   (cached, no Graph round-trip).
 * - `instinctUserId` → calls /api/directory/users/{id}/ooo (cache-only;
 *   we can't fetch someone else's mailbox settings).
 *
 * Only renders when is_enabled AND we're currently inside the [start, end]
 * window. For `alwaysEnabled` status (no window) we trust is_enabled.
 */

import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/client-auth";

export interface OOOBadgeProps {
  instinctUserId?: string;
}

interface OOOState {
  isEnabled: boolean;
  scope: string;
  startAt: string | null;
  endAt: string | null;
}

function isActive(state: OOOState | null, nowMs: number = Date.now()): boolean {
  if (!state || !state.isEnabled) return false;
  if (!state.startAt && !state.endAt) return true; // alwaysEnabled
  const start = state.startAt ? Date.parse(state.startAt) : Number.NEGATIVE_INFINITY;
  const end = state.endAt ? Date.parse(state.endAt) : Number.POSITIVE_INFINITY;
  return nowMs >= start && nowMs <= end;
}

export default function OOOBadge({ instinctUserId }: OOOBadgeProps) {
  const [state, setState] = useState<OOOState | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    const url = instinctUserId
      ? `/api/directory/users/${encodeURIComponent(instinctUserId)}/ooo`
      : `/api/mailbox/me/ooo`;
    (async () => {
      try {
        const res = await fetch(url, { headers: authHeaders() });
        if (!active) return;
        if (!res.ok) {
          setLoaded(true);
          return;
        }
        const body = (await res.json()) as { ooo?: OOOState | null };
        setState(body.ooo ?? null);
        setLoaded(true);
      } catch {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [instinctUserId]);

  if (!loaded) return null;
  if (!isActive(state)) return null;

  return (
    <span
      data-testid="ooo-badge"
      aria-label="Out of office"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
      style={{
        background: "rgba(245, 158, 11, 0.18)",
        color: "#f59e0b",
      }}
    >
      <span
        aria-hidden="true"
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: "#f59e0b" }}
      />
      Out of office
    </span>
  );
}
