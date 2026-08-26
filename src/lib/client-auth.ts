"use client";

import { shouldReportMismatch, controlKey } from "@/lib/analytics/role-mismatch";

/**
 * Client-side auth helpers for Instinct.
 *
 * Canonical pattern for every authenticated API call:
 *
 *   const res = await fetchWithRefresh("/api/whatever", { ... });
 *
 * fetchWithRefresh:
 *   - Adds Authorization: Bearer <access_token> from localStorage.
 *   - On 401, transparently calls POST /api/auth/refresh (HttpOnly refresh
 *     cookie is sent automatically), stores the new access token, retries
 *     the original request exactly once.
 *   - On refresh failure, clears the local session and redirects to /login
 *     with a ?next= back to the current route.
 *   - Dedupes concurrent refreshes: N parallel 401s only fire ONE refresh.
 *
 * Never call plain fetch() for authenticated endpoints. Plain fetch()
 * with authHeaders() is only safe for routes the client has already
 * pre-validated (login, public routes).
 */

/**
 * Dual-key migration state as of Tier 3 rename (2026-04-19).
 *
 * - READ: canonical `instinct_*` first, fallback to legacy `apex_*` so
 *   existing sessions from before the rename still work.
 * - WRITE: ONLY `instinct_*`. We no longer mirror writes to `apex_*`.
 * - MIGRATE: `migrateLegacyApexKeys()` is called once on app boot
 *   (dashboard layout mount). It copies any legacy `apex_*` key into
 *   its `instinct_*` equivalent IF the new key is absent, then deletes
 *   the legacy key. Idempotent; safe to call repeatedly.
 * - CLEAR: wipes both sets so no stale legacy key survives a logout.
 *
 * The fallback-read path stays in place for one release window so edge
 * browsers that miss the migrator don't get kicked to /login. It can be
 * removed in a follow-up commit once the migrator has run everywhere.
 */

const TOKEN_KEYS = ["instinct_token", "apex_token"] as const;
const USER_KEYS = ["instinct_user", "apex_user"] as const;

/**
 * Mapping of legacy `apex_*` localStorage keys to their canonical
 * `instinct_*` names. Used by `migrateLegacyApexKeys()` — see that fn
 * for the read/write semantics.
 */
const LEGACY_KEY_MIGRATIONS: Array<{ legacy: string; canonical: string }> = [
  { legacy: "apex_token", canonical: "instinct_token" },
  { legacy: "apex_user", canonical: "instinct_user" },
  { legacy: "apex_briefing_enabled", canonical: "instinct_briefing_enabled" },
  { legacy: "apex_email_notifications", canonical: "instinct_email_notifications" },
];

export function getInstinctToken(): string | null {
  if (typeof window === "undefined") return null;
  for (const k of TOKEN_KEYS) {
    const v = localStorage.getItem(k);
    if (v) return v;
  }
  return null;
}

export function getInstinctUser<T = unknown>(): T | null {
  if (typeof window === "undefined") return null;
  for (const k of USER_KEYS) {
    const v = localStorage.getItem(k);
    if (v) {
      try { return JSON.parse(v) as T; } catch { return null; }
    }
  }
  return null;
}

export function setInstinctSession(token: string, user: unknown): void {
  if (typeof window === "undefined") return;
  localStorage.setItem("instinct_token", token);
  localStorage.setItem("instinct_user", JSON.stringify(user));
}

export function clearInstinctSession(): void {
  if (typeof window === "undefined") return;
  for (const k of TOKEN_KEYS) localStorage.removeItem(k);
  for (const k of USER_KEYS) localStorage.removeItem(k);
}

/**
 * One-shot migration: copy legacy `apex_*` localStorage keys into their
 * canonical `instinct_*` names, then delete the legacy entries.
 *
 * Called on app boot (dashboard layout) so existing logged-in users —
 * who have `apex_token` / `apex_user` / `apex_briefing_enabled` /
 * `apex_email_notifications` in their browser — keep their session and
 * preferences across the rename without any user-visible disruption.
 *
 * Idempotent: running twice is a no-op (after the first run, the legacy
 * keys are gone).
 *
 * Safe: if the canonical key already has a value, we leave it alone and
 * just remove the legacy — newer writes always win.
 *
 * Returns the count of keys migrated, for analytics/debugging.
 */
export function migrateLegacyApexKeys(): number {
  if (typeof window === "undefined") return 0;
  let migrated = 0;
  for (const { legacy, canonical } of LEGACY_KEY_MIGRATIONS) {
    const legacyValue = localStorage.getItem(legacy);
    if (legacyValue === null) continue;
    const canonicalExists = localStorage.getItem(canonical) !== null;
    if (!canonicalExists) {
      localStorage.setItem(canonical, legacyValue);
      migrated++;
    }
    localStorage.removeItem(legacy);
  }
  return migrated;
}

export function authHeaders(): HeadersInit {
  const token = getInstinctToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), "Content-Type": "application/json" };
}

// ---------------------------------------------------------------------------
// Refresh-aware fetch
// ---------------------------------------------------------------------------

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Call POST /api/auth/refresh. The HttpOnly refresh cookie is sent
 * automatically by the browser. On success, updates localStorage with
 * the new access token and returns it. On failure, clears the session
 * and returns null.
 *
 * Concurrent callers share a single in-flight refresh promise.
 */
async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { token?: string; user?: unknown };
      if (!data.token) return null;
      if (data.user !== undefined) {
        setInstinctSession(data.token, data.user);
      } else {
        // Token-only refresh — preserve existing user, just rotate access token.
        const user = getInstinctUser<{ role?: string }>();
        setInstinctSession(data.token, user);
      }
      return data.token;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login?next=${next}`;
}

/**
 * Decode a JWT's payload without verifying the signature. Used purely
 * to read the `exp` claim so we can pre-refresh expired tokens
 * BEFORE the request fires — server still verifies signature on
 * every actual call, so this is safe.
 *
 * Returns the seconds-until-expiry (negative if already expired) or
 * null if we can't read a valid `exp`. null means "fall back to the
 * 401-then-refresh path", same as today.
 */
function jwtSecondsUntilExpiry(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // base64url → base64
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const payload = JSON.parse(atob(padded + padding)) as { exp?: number };
    if (typeof payload.exp !== "number") return null;
    return payload.exp - Math.floor(Date.now() / 1000);
  } catch {
    return null;
  }
}

// 30s skew buffer — refresh anything that'll expire in the next 30s
// so the in-flight request doesn't race the clock.
const EXP_SKEW_SECONDS = 30;

/**
 * Primary authenticated fetch. Use this instead of raw fetch() for any
 * call that hits an endpoint requiring auth.
 */
/**
 * Record that somebody acted on a control their role could not use.
 *
 * Deliberately swallows everything. A telemetry failure must never surface to
 * the person who already had one thing not work.
 */
async function reportRoleMismatch(
  input: RequestInfo | URL,
  opts: RequestInit,
): Promise<void> {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (opts.method ?? "GET").toUpperCase();
    if (!shouldReportMismatch(url, method)) return;

    const user = getInstinctUser<{ role?: string }>();
    /* Raw fetch, not fetchWithRefresh: this IS inside fetchWithRefresh, and
       recursing through it would re-enter the 403 branch on its own failure. */
    await fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        event: "ui.role_mismatch_click",
        metadata: {
          control: controlKey(url),
          method,
          /* Where they were standing, which is what tells us which page to
             take the control off. */
          surface: typeof window !== "undefined" ? window.location.pathname : "unknown",
          role: user?.role ?? "unknown",
        },
      }),
    });
  } catch {
    /* Swallowed on purpose. See above. */
  }
}

export async function fetchWithRefresh(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  let initialToken = getInstinctToken();

  // Pre-refresh if the access token is expired or about to expire.
  // Avoids the noisy 401 → refresh → retry path on dashboard mount
  // when the JWT outlived its 15-min TTL while the tab was idle. If
  // exp is unreadable we silently fall through and let the post-401
  // path handle it (same as before).
  if (initialToken) {
    const ttl = jwtSecondsUntilExpiry(initialToken);
    if (ttl !== null && ttl <= EXP_SKEW_SECONDS) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        initialToken = refreshed;
      } else {
        clearInstinctSession();
        redirectToLogin();
        // Even though we're redirecting, return SOMETHING so callers
        // that await this don't hang. A 401 Response with empty body
        // is the closest semantic match.
        return new Response(null, { status: 401 });
      }
    }
  }

  const headers = new Headers(init.headers ?? {});
  if (initialToken) headers.set("Authorization", `Bearer ${initialToken}`);

  const opts: RequestInit = { ...init, headers, credentials: "include" };

  const res = await fetch(input, opts);

  /* A CONTROL THAT LIED. 403 means the API refused, which is the security
     layer working. It also means this person was shown something they could
     never use, clicked it, and watched nothing happen. Recorded here because
     every authenticated fetch in the product passes through this function and
     a guardrail test keeps it that way, so one line covers every control that
     exists and every control added later. Fire-and-forget: telemetry must
     never delay or fail the caller's request. */
  if (res.status === 403) {
    void reportRoleMismatch(input, opts);
  }

  if (res.status !== 401) return res;

  // Access token rejected — try to refresh.
  const newToken = await refreshAccessToken();
  if (!newToken) {
    clearInstinctSession();
    redirectToLogin();
    return res;
  }

  const retryHeaders = new Headers(init.headers ?? {});
  retryHeaders.set("Authorization", `Bearer ${newToken}`);
  return fetch(input, { ...init, headers: retryHeaders, credentials: "include" });
}

/**
 * Convenience wrapper for JSON POST/PUT/PATCH requests with auth + refresh.
 */
export async function fetchJsonWithRefresh<T = unknown>(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Content-Type", "application/json");
  const res = await fetchWithRefresh(input, { ...init, headers });
  return res.json() as Promise<T>;
}
