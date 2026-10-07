/**
 * Campaigns in the wild: run the deterministic multi-step detector over RECORDED
 * events instead of a live request stream.
 *
 * detectCampaign needs one operator's step history, which a stateless edge shim
 * does not have. But every observed request is already logged (site_analytics_events
 * carries the operator fingerprint in props.fp, the path, and a timestamp), so we
 * can reconstruct each operator's sequence after the fact and find the campaigns
 * that already happened. This is how a site like ogiam.com gets multi-step coverage
 * without putting per-operator state on its hot path.
 *
 * Pure core (campaignsFromEvents) + a thin DB reader (readOperatorCampaigns). The
 * core groups rows by fingerprint, orders by time, and asks detectCampaign per
 * operator. PRIVACY: events store the path + the attack KIND, never the raw query,
 * so payload-in-query signals (payload_chain) are not reconstructable here; the
 * sequence shapes (recon breadth, kill chain, id enumeration, auth abuse) are.
 */
import { detectCampaign, type CampaignVerdict, type CampaignOptions, type OperatorStep } from "./campaign";
import { safeQuery } from "@/lib/db";

/** One recorded request, reduced to what the detector needs. A DB reader maps a
 *  site_analytics_events row to this. */
export interface RecordedStep {
  /** The operator fingerprint (props.fp). Groups a single actor's requests. */
  fp: string;
  path: string;
  method?: string;
  /** Epoch ms (from created_at). Relative order is what matters. */
  tsMs: number;
}

export interface OperatorCampaign {
  fingerprint: string;
  stepCount: number;
  verdict: CampaignVerdict;
}

/**
 * Group recorded steps by operator fingerprint and run the campaign detector on
 * each. Returns only operators whose sequence forms a campaign, worst (high) first.
 * Pure: same rows + options -> same result.
 */
export function campaignsFromEvents(rows: readonly RecordedStep[], opts: CampaignOptions = {}): OperatorCampaign[] {
  const byFp = new Map<string, RecordedStep[]>();
  for (const r of rows) {
    if (!r.fp) continue;
    (byFp.get(r.fp) ?? byFp.set(r.fp, []).get(r.fp)!).push(r);
  }

  const out: OperatorCampaign[] = [];
  for (const [fp, steps] of byFp) {
    const ordered = [...steps].sort((a, b) => a.tsMs - b.tsMs);
    const operatorSteps: OperatorStep[] = ordered.map((s) => ({ path: s.path, method: s.method ?? "GET", ts: s.tsMs }));
    const verdict = detectCampaign(operatorSteps, opts);
    if (verdict.campaign) out.push({ fingerprint: fp, stepCount: ordered.length, verdict });
  }

  // High-severity campaigns first, then by how many signatures fired.
  return out.sort((a, b) => {
    const sev = (v: OperatorCampaign) => (v.verdict.severity === "high" ? 2 : v.verdict.severity === "medium" ? 1 : 0);
    return sev(b) - sev(a) || b.verdict.signatures.length - a.verdict.signatures.length;
  });
}

type EventQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
const liveQuery: EventQuery = (sql, params) => safeQuery(sql, params ?? []) as never;

/**
 * Read the last `windowMinutes` of recorded site events for one site, grouped into
 * per-operator campaigns. Scoped to the site label. Fail-safe: any read error
 * yields [] (a campaign view is informational and must never throw into a route).
 * The query is injectable for tests.
 */
export async function readOperatorCampaigns(
  site: string,
  opts: { windowMinutes?: number; limit?: number } = {},
  q: EventQuery = liveQuery,
): Promise<OperatorCampaign[]> {
  const windowMinutes = Math.max(1, Math.min(1440, opts.windowMinutes ?? 120));
  const limit = Math.max(100, Math.min(50_000, opts.limit ?? 10_000));
  try {
    const res = await q<{ fp: string | null; path: string | null; created_at: string }>(
      `SELECT props->>'fp' AS fp, path, created_at::text AS created_at
         FROM site_analytics_events
        WHERE coalesce(props->>'site', 'ogiam.com') = $1
          AND props->>'fp' IS NOT NULL
          AND created_at > now() - ($2 || ' minutes')::interval
        ORDER BY created_at ASC
        LIMIT $3`,
      [site, String(windowMinutes), limit],
    );
    const rows: RecordedStep[] = res.rows
      .filter((r) => r.fp && r.path)
      .map((r) => ({ fp: r.fp as string, path: r.path as string, tsMs: Date.parse(r.created_at) || 0 }));
    return campaignsFromEvents(rows);
  } catch {
    return [];
  }
}
