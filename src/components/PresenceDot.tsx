"use client";

/**
 * PresenceDot — tiny colored dot representing another user's Teams
 * presence. Used in the Messages page chat list.
 *
 * Batches requests: multiple <PresenceDot /> mounts within a 300ms
 * window collapse into a single POST /api/ms/presence with all user
 * IDs. Results are cached module-scope so subsequent mounts for the
 * same user ID return immediately.
 *
 * Graceful fail: if the API returns 401 or { scope_missing: true },
 * we render nothing (the parent UI is not broken).
 */

import { useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

export type Availability =
  | "Available"
  | "AvailableIdle"
  | "Busy"
  | "BusyIdle"
  | "DoNotDisturb"
  | "Away"
  | "BeRightBack"
  | "Offline"
  | "PresenceUnknown"
  | "Unknown";

interface PresenceRecord {
  availability: Availability | string;
}

type PresenceResult =
  | { kind: "ok"; availability: string }
  | { kind: "scope_missing" };

interface PresenceDotProps {
  userId: string;
  size?: "sm" | "md";
}

/** Module-scope cache of already-resolved presences. */
const presenceCache: Map<string, PresenceResult> = new Map();

/** Pending batch: map userId -> array of resolvers waiting on result. */
const pendingBatch: Map<string, Array<(r: PresenceResult) => void>> = new Map();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

const BATCH_WINDOW_MS = 300;

/**
 * Color map per availability value.
 * Exposed for tests + reuse.
 */
export function colorForAvailability(availability: string): string {
  switch (availability) {
    case "Available":
    case "AvailableIdle":
      return "#22c55e"; // green
    case "Busy":
    case "BusyIdle":
    case "DoNotDisturb":
      return "#ef4444"; // red
    case "Away":
    case "BeRightBack":
      return "#f59e0b"; // yellow
    case "Offline":
    case "PresenceUnknown":
    default:
      return "#9ca3af"; // gray
  }
}

/**
 * Test-only: wipe all batcher state. Exported so tests can reset
 * module-scope caches between cases.
 */
export function __resetPresenceDotForTests(): void {
  presenceCache.clear();
  pendingBatch.clear();
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
}

async function flushBatch(): Promise<void> {
  batchTimer = null;
  if (pendingBatch.size === 0) return;

  const ids = Array.from(pendingBatch.keys());
  const batch = new Map(pendingBatch);
  pendingBatch.clear();

  function resolveAll(result: (id: string) => PresenceResult): void {
    for (const [id, resolvers] of batch) {
      const r = result(id);
      presenceCache.set(id, r);
      for (const fn of resolvers) fn(r);
    }
  }

  try {
    const res = await fetchWithRefresh("/api/ms/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: ids }),
    });

    if (res.status === 401) {
      resolveAll(() => ({ kind: "scope_missing" }));
      return;
    }

    const data = (await res.json().catch(() => ({}))) as {
      scope_missing?: boolean;
      presences?: Array<{ id?: string; userId?: string } & PresenceRecord>;
    };

    if (data?.scope_missing) {
      resolveAll(() => ({ kind: "scope_missing" }));
      return;
    }

    const byId = new Map<string, string>();
    for (const p of data.presences ?? []) {
      const key = p.userId ?? p.id;
      if (key && typeof p.availability === "string") {
        byId.set(key, p.availability);
      }
    }

    resolveAll((id) => {
      const a = byId.get(id);
      return a ? { kind: "ok", availability: a } : { kind: "ok", availability: "PresenceUnknown" };
    });
  } catch {
    // Network error: treat as unknown but don't poison the cache forever.
    for (const [, resolvers] of batch) {
      for (const fn of resolvers) fn({ kind: "ok", availability: "PresenceUnknown" });
    }
  }
}

function requestPresence(userId: string): Promise<PresenceResult> {
  const cached = presenceCache.get(userId);
  if (cached) return Promise.resolve(cached);

  return new Promise<PresenceResult>((resolve) => {
    const resolvers = pendingBatch.get(userId) ?? [];
    resolvers.push(resolve);
    pendingBatch.set(userId, resolvers);
    if (!batchTimer) {
      batchTimer = setTimeout(() => {
        void flushBatch();
      }, BATCH_WINDOW_MS);
    }
  });
}

export default function PresenceDot({ userId, size = "sm" }: PresenceDotProps) {
  const [result, setResult] = useState<PresenceResult | null>(null);

  useEffect(() => {
    let active = true;
    requestPresence(userId).then((r) => {
      if (active) setResult(r);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  if (!result) return null;
  if (result.kind === "scope_missing") return null;

  const px = size === "md" ? 10 : 8;
  const color = colorForAvailability(result.availability);
  const label = result.availability.replace(/([A-Z])/g, " $1").trim();

  return (
    <span
      role="img"
      aria-label={`Presence: ${label}`}
      data-testid="presence-dot"
      data-availability={result.availability}
      style={{
        display: "inline-block",
        width: px,
        height: px,
        borderRadius: 999,
        background: color,
        flex: "0 0 auto",
      }}
    />
  );
}
