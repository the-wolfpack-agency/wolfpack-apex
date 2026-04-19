/**
 * Microsoft 365 People suggestions integration.
 *
 * Graph `/me/people` surfaces the caller's most-relevant people based on
 * communication patterns (scored by Microsoft). We use this to power the
 * PeopleAutocomplete input. Results are cached for 60 seconds per
 * (user, query) so rapid keystrokes from the UI debounce aren't a storm
 * of Graph calls.
 *
 * Graph surface:
 *   GET /me/people?$search=... or ?$top=N
 *
 * Scope: People.Read (already in MS_SCOPES).
 *
 * On 403 the helper returns [] and emits `system.ms_file_operation_failed`
 * (reused for parity) is NOT right — we emit the explicit
 * `system.ms_people_suggestions_fetched` with ok=false in metadata. The
 * `_Safe` wrapper returns the standard scope_missing payload for callers
 * that want the discriminated form.
 */

 

import { getValidToken } from "@/lib/microsoft-graph";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonSuggestion {
  personId: string;
  displayName: string;
  email: string;
  score: number;
  source: string; // e.g. "directory" | "organizationUser" | "personalContact"
}

export type ScopeMissingResult = { ok: false; code: "scope_missing"; scope: string };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GraphPeopleError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
    this.name = "GraphPeopleError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const CACHE_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

async function resolveToken(userId: string): Promise<string> {
  const tok = await getValidToken(userId);
  if (!tok) throw new GraphPeopleError(401, "No valid Microsoft token for user");
  return tok.accessToken;
}

async function graphGet<T>(endpoint: string, accessToken: string): Promise<T> {
  const url = `${GRAPH_BASE_URL}/${endpoint}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 1;
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    const retry = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!retry.ok) {
      throw new GraphPeopleError(retry.status, `Graph people fetch failed after retry: ${retry.status}`, retryAfter);
    }
    return (await retry.json()) as T;
  }
  if (!res.ok) {
    const text = await safeText(res);
    throw new GraphPeopleError(res.status, `Graph people fetch failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ""; }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function normalizeQueryKey(query: string | undefined): string {
  return (query ?? "").trim().toLowerCase();
}

async function readCache(userId: string, queryKey: string): Promise<PersonSuggestion[] | null> {
  const { rows } = await safeQuery<{
    person_id: string; display_name: string | null; email: string | null; score: number | null; source: string | null; cached_at: string;
  }>(
    `SELECT person_id, display_name, email, score, source, cached_at
     FROM instinct_people_suggestions_cache
     WHERE user_id = $1 AND query_key = $2
       AND cached_at >= NOW() - INTERVAL '1 second' * $3
     ORDER BY rank ASC, cached_at DESC`,
    [userId, queryKey, CACHE_TTL_SECONDS],
  );
  if (rows.length === 0) return null;
  return rows.map((r) => ({
    personId: r.person_id,
    displayName: r.display_name ?? "",
    email: r.email ?? "",
    score: r.score ?? 0,
    source: r.source ?? "",
  }));
}

async function writeCache(userId: string, queryKey: string, suggestions: PersonSuggestion[]): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    // Clear old rows for this (user, query) then insert fresh.
    await query(
      `DELETE FROM instinct_people_suggestions_cache WHERE user_id = $1 AND query_key = $2`,
      [userId, queryKey],
    );
    let rank = 0;
    for (const s of suggestions) {
      await query(
        `INSERT INTO instinct_people_suggestions_cache
           (user_id, query_key, person_id, display_name, email, score, source, rank, cached_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
        [userId, queryKey, s.personId, s.displayName, s.email, s.score, s.source, rank++],
      );
    }
  } catch (err) {
    console.warn("[microsoft-people] cache write failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

interface GraphPerson {
  id: string;
  displayName?: string;
  scoredEmailAddresses?: { address: string; relevanceScore?: number }[];
  emailAddresses?: { address: string }[];
  personType?: { class?: string; subclass?: string };
}

function normalizePerson(p: GraphPerson): PersonSuggestion {
  const scored = p.scoredEmailAddresses?.[0];
  const email = scored?.address ?? p.emailAddresses?.[0]?.address ?? "";
  const score = scored?.relevanceScore ?? 0;
  return {
    personId: p.id,
    displayName: p.displayName ?? email,
    email,
    score,
    source: p.personType?.subclass ?? p.personType?.class ?? "",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return people suggestions. Cache hit (<= 60s) bypasses Graph.
 * On 403 returns [] and emits `system.ms_people_suggestions_fetched`
 * with scope_missing=true. Never throws on scope missing.
 */
export async function suggestPeople(
  userId: string,
  search?: string,
  top = 10,
): Promise<PersonSuggestion[]> {
  const queryKey = normalizeQueryKey(search);
  const cached = await readCache(userId, queryKey);
  if (cached) {
    trackEvent("system.ms_people_suggestions_fetched", userId, "system", {
      query_len: queryKey.length,
      count: cached.length,
      from_cache: true,
    });
    return cached;
  }

  let token: string;
  try {
    token = await resolveToken(userId);
  } catch (err) {
    if (err instanceof GraphPeopleError && err.status === 401) throw err;
    throw err;
  }

  const boundedTop = Math.min(Math.max(top, 1), 50);
  const params = new URLSearchParams();
  params.set("$top", String(boundedTop));
  params.set(
    "$select",
    "id,displayName,scoredEmailAddresses,emailAddresses,personType",
  );
  if (search && search.trim().length > 0) {
    params.set("$search", `"${search.trim()}"`);
  }
  const endpoint = `me/people?${params.toString()}`;

  try {
    const res = await graphGet<{ value: GraphPerson[] }>(endpoint, token);
    const suggestions = (res.value ?? []).map(normalizePerson);
    await writeCache(userId, queryKey, suggestions);
    trackEvent("system.ms_people_suggestions_fetched", userId, "system", {
      query_len: queryKey.length,
      count: suggestions.length,
      from_cache: false,
    });
    return suggestions;
  } catch (err) {
    if (err instanceof GraphPeopleError && err.status === 403) {
      trackEvent("system.ms_people_suggestions_fetched", userId, "system", {
        query_len: queryKey.length,
        count: 0,
        from_cache: false,
        scope_missing: true,
      });
      return [];
    }
    throw err;
  }
}

/**
 * Strict-safe form — returns ScopeMissingResult on 403 instead of [].
 */
export async function suggestPeople_Safe(
  userId: string,
  search?: string,
  top = 10,
): Promise<{ ok: true; suggestions: PersonSuggestion[] } | ScopeMissingResult> {
  try {
    const cached = await readCache(userId, normalizeQueryKey(search));
    if (cached) return { ok: true, suggestions: cached };
    const token = await resolveToken(userId);

    const boundedTop = Math.min(Math.max(top, 1), 50);
    const params = new URLSearchParams();
    params.set("$top", String(boundedTop));
    params.set(
      "$select",
      "id,displayName,scoredEmailAddresses,emailAddresses,personType",
    );
    if (search && search.trim().length > 0) {
      params.set("$search", `"${search.trim()}"`);
    }
    const res = await graphGet<{ value: GraphPerson[] }>(`me/people?${params.toString()}`, token);
    const suggestions = (res.value ?? []).map(normalizePerson);
    await writeCache(userId, normalizeQueryKey(search), suggestions);
    trackEvent("system.ms_people_suggestions_fetched", userId, "system", {
      query_len: normalizeQueryKey(search).length,
      count: suggestions.length,
      from_cache: false,
    });
    return { ok: true, suggestions };
  } catch (err) {
    if (err instanceof GraphPeopleError && err.status === 403) {
      return { ok: false, code: "scope_missing", scope: "People.Read" };
    }
    throw err;
  }
}
