/**
 * Estate scope — narrow retrieval to one client's material.
 *
 * The SharePoint estate holds several clients' documents in one library. A
 * query that spans everything can pull one client's document into another
 * client's answer. Estate scope lets a caller restrict a search to a chosen
 * client (estate), the same way audience filtering restricts by role.
 *
 * Deliberately the SAME shape as audience.ts:
 *  - the KEYWORD side filters in SQL (`bd.estate = ANY(...)` in
 *    buildKeywordSearchSql), so a scoped-out document is never ranked;
 *  - the SEMANTIC side filters against Postgres after the vector search, via
 *    `documentIdsInEstates`, because the Qdrant payload carries no estate.
 *
 * DEFAULT IS EVERYTHING. No estates (undefined/empty) means no filter, which is
 * exactly today's behavior — this only ever narrows, never widens, and only
 * when a caller explicitly asks for a client.
 *
 * FAILS CLOSED, like the audience lookup: if the Postgres lookup throws, the
 * scoped set is empty rather than unfiltered. A scope that silently fell back
 * to "everything" would leak the other clients it was meant to keep out.
 */

import { query } from "@/lib/db";

/**
 * Of `documentIds`, which belong to one of `estates`.
 *
 * Used by the semantic half of retrieval to intersect vector hits down to the
 * chosen client(s). Returns a Set for O(1) membership at the call site.
 */
export async function documentIdsInEstates(
  documentIds: string[],
  estates: string[],
): Promise<Set<string>> {
  if (documentIds.length === 0 || estates.length === 0) return new Set();
  try {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM brain_documents
        WHERE id = ANY($1) AND estate = ANY($2)`,
      [documentIds, estates],
    );
    return new Set(rows.map((r) => String(r.id)));
  } catch {
    /* silent-ok: fails closed to an empty scope, never unfiltered. A scope that
       fell back to "everything" on a DB error would leak the other clients it
       exists to exclude — the same fail-closed posture as readableDocumentIds. */
    return new Set();
  }
}

/**
 * The distinct estates present in the indexed library, most-documents first.
 *
 * For a future scope selector to populate itself from real data rather than a
 * hardcoded client list. Only estates that actually have indexed documents are
 * returned, so the control can never offer a client with nothing behind it.
 */
export async function listEstates(): Promise<Array<{ estate: string; documents: number }>> {
  try {
    const { rows } = await query<{ estate: string; documents: string }>(
      `SELECT estate, COUNT(*)::text AS documents
         FROM brain_documents
        WHERE estate IS NOT NULL AND status = 'indexed'
        GROUP BY estate
        ORDER BY COUNT(*) DESC, estate ASC`,
    );
    return rows.map((r) => ({ estate: r.estate, documents: Number(r.documents) }));
  } catch {
    /* silent-ok: a listing failure yields no estates, so a future selector
       shows nothing rather than crashing. This is a read-only convenience for
       populating a control, not a security boundary. */
    return [];
  }
}
