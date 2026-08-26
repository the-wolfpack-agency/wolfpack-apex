/**
 * Who may be quoted which document.
 *
 * THE GAP THIS CLOSES. Retrieval had no permission model. Any user holding
 * assistant.use could be quoted any document in the index, because
 * keywordSearch and searchBrain both search everything and neither was told
 * who was asking.
 *
 * That is defensible while the corpus is one company's own material. It is
 * indefensible the moment a client tenant holds HR files, dealer agreements
 * and manager-only process documents in the same index, which is exactly what
 * the SharePoint connector puts there.
 *
 * TWO RULES, AND THE SECOND IS THE IMPORTANT ONE
 *
 * A document with no audience is workspace-wide. That is what every document
 * ingested by hand honestly is: somebody in this workspace uploaded it with no
 * restriction, and inventing one now would be a restriction nobody applied.
 *
 * A document WITH an audience is readable only by those roles. Connector
 * documents always carry one, because a SharePoint library is somebody else's
 * permission model and inheriting "everyone" from a system that says otherwise
 * is the failure this module exists to prevent.
 *
 * WHY THE CHECK IS IN POSTGRES AND NOT IN THE VECTOR FILTER
 *
 * Qdrant can filter on payload, and the payload does not carry the audience:
 * every point written before this would need a backfill, and a point missed by
 * that backfill would be a document silently readable by anybody. Filtering
 * against Postgres cannot miss, because the answer comes from the same row the
 * document does. It costs one round trip over at most a page of ids.
 */
import { query } from "@/lib/db";

/**
 * Roles that may read anything, including documents restricted to somebody
 * else. Deliberately short: it is the list somebody will be asked to justify.
 */
const UNRESTRICTED_ROLES: ReadonlySet<string> = new Set(["cto", "ceo", "admin"]);

export function readsEverything(role: string): boolean {
  return UNRESTRICTED_ROLES.has((role || "").toLowerCase());
}

/**
 * Narrow a set of candidate documents to the ones this role may be quoted.
 *
 * FAILS CLOSED. If the lookup throws, nothing is returned rather than
 * everything: a retrieval that fails is a bad answer, and a retrieval that
 * leaks is an incident. The caller reports the difference.
 */
export async function readableDocumentIds(
  documentIds: string[],
  role: string,
): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  if (readsEverything(role)) return new Set(documentIds);

  const asked = (role || "").toLowerCase();
  try {
    const { rows } = await query<{ id: string }>(
      `SELECT id
         FROM brain_documents
        WHERE id = ANY($1)
          AND (audience_roles IS NULL OR $2 = ANY(audience_roles))`,
      [documentIds, asked],
    );
    return new Set(rows.map((r) => String(r.id)));
  } catch {
    return new Set();
  }
}

/** The SQL predicate for a search that filters as it goes. */
export function audienceClause(role: string, paramIndex: number): string {
  if (readsEverything(role)) return "";
  return ` AND (d.audience_roles IS NULL OR $${paramIndex} = ANY(d.audience_roles))`;
}
