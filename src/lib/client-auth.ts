"use client";

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
        const user = getInstinctUser();
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
 * Primary authenticated fetch. Use this instead of raw fetch() for any
 * call that hits an endpoint requiring auth.
 */
export async function fetchWithRefresh(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const initialToken = getInstinctToken();
  const headers = new Headers(init.headers ?? {});
  if (initialToken) headers.set("Authorization", `Bearer ${initialToken}`);

  const opts: RequestInit = { ...init, headers, credentials: "include" };

  const res = await fetch(input, opts);
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
