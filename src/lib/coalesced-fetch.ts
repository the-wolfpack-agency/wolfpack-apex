"use client";

/**
 * Coalescing wrapper around `fetchWithRefresh`. When N callers issue a
 * GET to the same URL within a short window, only one HTTP request is
 * sent — every caller awaits the same in-flight Promise and shares the
 * cloned Response.
 *
 * Why: four sidebar badges (EmailNavBadge, MessagesNavBadge,
 * NewMessageToast, TeamsUnreadBadge) used to each poll independently
 * on a 5s interval. Three of them hit the SAME endpoint
 * (/api/ms/chats/unread-count). That meant 36 requests/min just to
 * answer "how many unread chats?" — the same answer, four times over.
 *
 * After coalescing the same URL within `coalesceMs` collapses to ONE
 * Graph round-trip. Same correctness; same auth path; same Outlook /
 * Microsoft Graph behavior — the change is purely client-side
 * deduplication. Server endpoints are untouched.
 *
 * Disable with NEXT_PUBLIC_INSTINCT_BADGE_OPTIMIZE=false for instant
 * rollback to the previous one-call-per-component behavior.
 */
import { fetchWithRefresh } from "@/lib/client-auth";

const DEFAULT_COALESCE_MS = 1500;
const ANALYTICS_FLUSH_INTERVAL_MS = 60_000;

interface InFlight {
  promise: Promise<Response>;
  startedAt: number;
}

const inflight = new Map<string, InFlight>();

/**
 * Counters for the learning-loop emitter. `requestsServed` = total
 * GETs callers asked for. `networkCalls` = how many actually hit the
 * network. The delta (`requestsServed - networkCalls`) is the win
 * delivered by coalescing.
 */
const counters = { requestsServed: 0, networkCalls: 0 };
let lastFlushAt = 0;

function maybeFlushAnalytics(): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  if (now - lastFlushAt < ANALYTICS_FLUSH_INTERVAL_MS) return;
  if (counters.requestsServed === 0) return;
  const payload = {
    event: "system.badge_poll_optimized",
    metadata: {
      requests_served: counters.requestsServed,
      network_calls: counters.networkCalls,
      requests_saved:
        counters.requestsServed - counters.networkCalls,
      window_ms: now - lastFlushAt,
    },
  };
  lastFlushAt = now;
  counters.requestsServed = 0;
  counters.networkCalls = 0;
  // Fire-and-forget. Never block the badge fetch on analytics.
  // We use raw fetch (not coalesced) on purpose — analytics POSTs
  // shouldn't be coalesced (they're side-effecting + non-GET) and
  // shouldn't recurse through this module.
  try {
    fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "include",
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* ignore — never let analytics break a badge */
  }
}

function isOptimizeEnabled(): boolean {
  // Default ON in production. Only disabled by an explicit "false"
  // env value so the failure mode of a missing or misspelled flag is
  // "still optimized".
  //
  // Auto-disabled under jest (JEST_WORKER_ID is set) so component
  // tests that mock fetchWithRefresh directly continue to work
  // without each test having to mock coalesced-fetch too. The
  // dedicated coalesced-fetch test file opts back in by setting
  // NEXT_PUBLIC_INSTINCT_BADGE_OPTIMIZE="true".
  if (typeof process === "undefined") return true;
  const v = process.env.NEXT_PUBLIC_INSTINCT_BADGE_OPTIMIZE;
  if (v === "false" || v === "0") return false;
  if (process.env.JEST_WORKER_ID && v !== "true") return false;
  return true;
}

function keyFor(input: RequestInfo | URL, init?: RequestInit): string | null {
  // Only coalesce safe, idempotent GETs. Anything else (POST, PATCH,
  // DELETE) bypasses the cache so we never silently drop a side effect.
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") return null;
  if (typeof input === "string") return `GET ${input}`;
  if (input instanceof URL) return `GET ${input.toString()}`;
  // Request objects: only coalesce if it's a GET request.
  if (typeof Request !== "undefined" && input instanceof Request) {
    if (input.method.toUpperCase() !== "GET") return null;
    return `GET ${input.url}`;
  }
  return null;
}

/**
 * Same signature as `fetchWithRefresh`. Coalesces concurrent identical
 * GETs within a 1.5s window. Returns a cloned Response so each caller
 * can read the body independently.
 */
export async function coalescedFetchWithRefresh(
  input: RequestInfo | URL,
  init: RequestInit = {},
  coalesceMs: number = DEFAULT_COALESCE_MS,
): Promise<Response> {
  if (!isOptimizeEnabled()) {
    return fetchWithRefresh(input, init);
  }

  const key = keyFor(input, init);
  if (key === null) {
    return fetchWithRefresh(input, init);
  }

  counters.requestsServed += 1;

  const now = Date.now();
  const existing = inflight.get(key);
  if (existing && now - existing.startedAt < coalesceMs) {
    try {
      const res = await existing.promise;
      maybeFlushAnalytics();
      return safeClone(res);
    } catch {
      // Fall through and re-fetch — the cached Promise rejected.
    }
  }

  counters.networkCalls += 1;
  const promise = fetchWithRefresh(input, init);
  inflight.set(key, { promise, startedAt: now });
  try {
    const res = await promise;
    maybeFlushAnalytics();
    return safeClone(res);
  } finally {
    setTimeout(() => {
      const cur = inflight.get(key);
      if (cur && cur.promise === promise) inflight.delete(key);
    }, coalesceMs);
  }
}

/**
 * `Response.clone()` is the contract — but some test mocks return
 * plain objects shaped like `{ ok, status, json }` with no clone
 * method. Cloning is only required when 2+ callers share the body;
 * if no clone exists, return the original response and trust each
 * caller to read it once.
 */
function safeClone(res: Response): Response {
  if (typeof (res as Response & { clone?: unknown }).clone === "function") {
    return res.clone();
  }
  return res;
}

/**
 * Test-only: clear the in-flight map so each test starts fresh.
 * Production callers should never need this.
 */
export function __resetCoalescedFetchForTests(): void {
  inflight.clear();
}
