/**
 * Source-topology insights — what we can tell a client from the way
 * their systems are wired, rather than from watching them work.
 *
 * Every other generator in this directory reads OUR tools: GitHub,
 * Vercel, the calendar. They are good, and they all share a shape that
 * fails on day one somewhere else: they describe activity, so they need
 * activity to have happened.
 *
 * A client plugging us into a twelve-year-old system has none of that
 * yet, and is owed an answer anyway. These two generators produce one,
 * because the subject is not the client's behaviour. It is the topology
 * of their systems, which exists in full the moment the second source
 * is connected:
 *
 *   - CROSS-SOURCE OVERLAP needs no history at all. Two connected
 *     systems that both hold `contact` is a fact about the wiring, and
 *     it is a fact nobody inside the company has written down.
 *   - REDUNDANT READS needs minutes, not months. The same request
 *     issued to the same system four times in ten minutes is waste
 *     whether it is the first day or the thousandth.
 *
 * Both are rule-based and arithmetic, per this directory's standing
 * principle: a count a client can verify is worth more than a sentence
 * a model composed.
 */

import type {
  CrossToolInsight,
  InsightContext,
} from "./cross-tool-generators";

/** Same request, same system, this many times inside the window. */
const REPEAT_THRESHOLD = 4;
/** A repeat only counts as waste if it lands inside this window. */
const WINDOW_MINUTES = 10;

/* ── Redundant reads of one system ────────────────────────────────── */

/**
 * The same fingerprint asked of the same connector, several times,
 * close together.
 *
 * The window is what makes this an insight rather than a complaint.
 * Fetching a customer record once an hour all day is a system being
 * used. Fetching the identical record four times inside ten minutes is
 * two chains, or two people, not knowing about each other — and on a
 * legacy database that the client pays for by the query, it is the
 * cheapest saving we will ever hand them.
 */
export async function generateRedundantSourceReads(
  ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  if (!process.env.DATABASE_URL) return [];
  const { query } = await import("@/lib/db");
  const lookbackDays = Math.min(ctx.lookbackDays ?? 7, 30);

  /* Grouped by (connector, fingerprint) inside a tumbling window, so a
     steady hourly poll never trips it and a burst always does. The
     fingerprint is a hash: this query cannot see what was asked, only
     that the same thing was asked twice. */
  const res = await query<{
    connector: string;
    object_type: string | null;
    operation: string | null;
    repeats: number;
    total_ms: number;
    buckets: number;
  }>(
    `WITH calls AS (
       SELECT
         metadata->>'connector'   AS connector,
         metadata->>'fingerprint' AS fingerprint,
         metadata->>'object_type' AS object_type,
         metadata->>'operation'   AS operation,
         COALESCE((metadata->>'duration_ms')::numeric, 0) AS duration_ms,
         date_trunc('hour', timestamp)
           + (floor(extract(minute FROM timestamp) / $2) * $2)
             * INTERVAL '1 minute' AS bucket
       FROM instinct_events
       WHERE event_type = 'assistant.connector_succeeded'
         AND timestamp > NOW() - ($1 || ' days')::interval
         AND metadata->>'fingerprint' IS NOT NULL
     ),
     grouped AS (
       SELECT connector, fingerprint, bucket,
              MAX(object_type) AS object_type,
              MAX(operation)   AS operation,
              COUNT(*)         AS n,
              SUM(duration_ms) AS ms
       FROM calls
       GROUP BY connector, fingerprint, bucket
       HAVING COUNT(*) >= $3
     )
     SELECT connector,
            MAX(object_type) AS object_type,
            MAX(operation)   AS operation,
            SUM(n - 1)::int  AS repeats,
            SUM(ms)::int     AS total_ms,
            COUNT(*)::int    AS buckets
     FROM grouped
     GROUP BY connector
     ORDER BY repeats DESC
     LIMIT 5`,
    [String(lookbackDays), WINDOW_MINUTES, REPEAT_THRESHOLD],
  );

  return (res.rows ?? []).map((r) => {
    const seconds = Math.round((r.total_ms ?? 0) / 1000);
    const noun = r.object_type ? `${r.object_type} ${r.operation ?? "read"}` : "request";
    return {
      id: `redundant_source_reads:${r.connector}`,
      generator: "redundant_source_reads",
      /* Severity tracks the size of the saving, not our confidence.
         Every row here is an arithmetic fact. */
      severity: r.repeats >= 50 ? "high" : r.repeats >= 15 ? "medium" : "low",
      signalStrength: Math.min(100, r.repeats),
      title: `${r.connector} answered the same ${noun} ${r.repeats} extra times`,
      detail:
        `Across ${r.buckets} separate ${WINDOW_MINUTES}-minute windows in the last ` +
        `${lookbackDays} days, the identical request was repeated rather than reused, ` +
        `costing about ${seconds}s of that system's time. Nothing about the request ` +
        `itself is stored — only that it matched.`,
      action: { label: "Reuse the first answer across the chain", chip: "cross-source insights" },
      sources: [r.connector],
    } satisfies CrossToolInsight;
  });
}

/* ── The same entity class living in two systems ──────────────────── */

/**
 * Day zero. No history, no usage, no waiting.
 *
 * Two connected systems that both hold `contact` means every contact in
 * this company has two homes and no stated winner. That is not a
 * failure of theirs; it is what happens to every company that buys a
 * second tool. It is also the single most useful thing to say on the
 * day we connect, because it is true immediately, it is checkable, and
 * it is invisible from inside either system — each one believes it is
 * the only one.
 */
export async function generateCrossSourceOverlap(
  _ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  const { listConnectors } = await import("@/lib/assistant/connectors/registry");
  const configured = listConnectors().filter((c) => {
    try {
      return c.isConfigured();
    } catch {
      return false;
    }
  });
  if (configured.length < 2) return [];

  /* Which object types each configured system serves. The connector
     exposes this through its object map; a connector that does not
     declare one contributes nothing rather than guessing. */
  const byObject = new Map<string, string[]>();
  for (const c of configured) {
    for (const objectType of c.objectTypes?.() ?? []) {
      const key = objectType.toLowerCase();
      byObject.set(key, [...(byObject.get(key) ?? []), c.name]);
    }
  }

  const shared = [...byObject.entries()]
    .filter(([, systems]) => systems.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);

  return shared.map(([objectType, systems]) => ({
    id: `cross_source_overlap:${objectType}`,
    generator: "cross_source_overlap",
    severity: systems.length >= 3 ? "medium" : "low",
    signalStrength: 40 + systems.length * 10,
    title: `${objectType} lives in ${systems.length} connected systems`,
    detail:
      `${systems.join(" and ")} each hold ${objectType} records. Asking both the same ` +
      `question is how drift gets found: the same record with two different answers is ` +
      `a fact neither system can report on its own.`,
    action: { label: `Compare ${objectType} across both`, chip: `compare ${objectType} across systems` },
    sources: systems,
  }));
}
