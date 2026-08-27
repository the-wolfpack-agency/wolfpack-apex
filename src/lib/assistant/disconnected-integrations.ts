/**
 * Which integrations we can PROVE are unusable right now.
 *
 * WHY THIS EXISTS. When the assistant cannot answer, it offers chips. One of
 * them has always been "A financial figure", and QuickBooks has never held a
 * token on this deployment: zero rows, for the whole life of the feature. So
 * every person who ever saw the fallback was offered a button that could not
 * work, and spent a click learning the product is broken. The call site's own
 * comment names this ("a chip that cannot work is the role-mismatch defect
 * wearing a friendlier coat") and only the role half was fixed.
 *
 * RETURNS WHAT IS KNOWN BROKEN, NOT WHAT IS KNOWN WORKING. If the lookup
 * fails we know nothing, and returning an empty connected-set would hide every
 * integration chip and leave somebody with two options and no explanation. A
 * transient database blip must not silently shrink the product. So a failed
 * check contributes nothing to the set, and only a positive absence of
 * credentials removes a chip.
 */

import { query } from "@/lib/db";

/**
 * The tables this reader depends on, named once so a test can prove they
 * exist. A typo here does not fail loudly: it throws, gets caught, and reads
 * as "unknown" forever.
 */
export const CONNECTION_TABLES = ["instinct_ms_tokens", "instinct_qbo_tokens"] as const;

/** Cheap: one row each, and the result is per-turn rather than cached. */
export async function knownDisconnectedIntegrations(userId: string): Promise<Set<string>> {
  const out = new Set<string>();

  const [ms, qb] = await Promise.all([
    query<{ n: string }>(
      `SELECT count(*)::text AS n FROM instinct_ms_tokens WHERE connected_by = $1`,
      [userId],
    ).catch(() => null),
    /* instinct_qbO_tokens. I wrote instinct_qb_tokens first: the query threw,
       the catch turned it into null, null means "unknown", and QuickBooks was
       never flagged. The fix silently did nothing, which is the exact failure
       this module exists to stop, committed inside the module itself. The
       table names are pinned by a test against the migrations. */
    query<{ n: string }>(`SELECT count(*)::text AS n FROM instinct_qbo_tokens`).catch(() => null),
  ]);

  /* null means the question could not be asked, which is not an answer. */
  if (ms && Number(ms.rows[0]?.n ?? 0) === 0) out.add("microsoft");
  if (qb && Number(qb.rows[0]?.n ?? 0) === 0) out.add("quickbooks");

  /* GitHub is a deployment-wide token rather than a per-user grant, so its
     absence is readable without touching the database at all. */
  if (!process.env.GITHUB_TOKEN_WOLFPACK_AGENCY) out.add("github");

  return out;
}
