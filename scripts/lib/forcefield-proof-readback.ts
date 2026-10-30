/**
 * Read-back for a live Forcefield proof: how many events recorded since the run started, on the
 * paths the run hit, are NOT marked synthetic. A proof that sent the synthetic header to a target
 * holding the same token leaves 0. Read-only (default_transaction_read_only), aggregate count only.
 * Returns null when the table cannot be read, so the caller reports a skip, never a pass.
 *
 * A real attacker hitting the same path in the same seconds would also count; that is rare, and
 * the failure names the count so it can be checked.
 */
import { Client } from "pg";

export const PROOF_EVENT_TYPES = ["site.agent_payload_attack", "site.agent_trap_tripped", "site.agent_flagged", "site.agent_probed_sensitive"];

export async function unmarkedProofRows(since: Date, paths: string[], url = process.env.DATABASE_URL): Promise<number | null> {
  if (!url) return null;
  const db = new Client({ connectionString: url });
  try {
    await db.connect();
    await db.query("SET default_transaction_read_only = on");
    const r = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM site_analytics_events
        WHERE created_at >= $1 AND event_type = ANY($2::text[]) AND path = ANY($3::text[])
          AND COALESCE(props->>'synthetic', '') <> 'true'`,
      [since.toISOString(), PROOF_EVENT_TYPES, [...new Set(paths)]],
    );
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    return null;
  } finally {
    await db.end().catch(() => {});
  }
}
