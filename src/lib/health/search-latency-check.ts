/**
 * Hold every search provider to the fan-out budget, in production, nightly.
 *
 * WHY THIS IS A CONTROL AND NOT A NOTE. Connecting a client's systems and
 * answering across them is the product. Every integration added widens what we
 * can answer AND joins a fan-out where the slowest provider is the whole
 * search, because they run at once. So each new connection carries a latency
 * risk that lands on every question, not just the ones it answers.
 *
 * That is not hypothetical. Measured over seven days of production traffic:
 *
 *   Microsoft Teams channels   avg 5515ms   p95 22454ms   max 129458ms
 *   Microsoft Teams chats      avg  594ms   p95  2681ms   max   5024ms
 *   CRM                        avg 1168ms   p95  1805ms   max   3116ms
 *   Documents                  avg  705ms   p95  1187ms   max   3321ms
 *   SharePoint                 avg  403ms   p95  1615ms   max   2181ms
 *   Instinct knowledge         avg   38ms   p95   102ms   max    219ms
 *
 * One provider made the entire product feel broken, and nobody noticed for as
 * long as it took a person to complain about a twenty-second wait. #503 added
 * a per-provider timeout so it can no longer hold the rest up. This is the
 * other half: noticing that it happened.
 *
 * THE RULE THIS ENFORCES. A new integration earns its place in the fan-out
 * only if it answers inside the budget. A provider whose p95 exceeds it is not
 * failing, it is too slow to be worth waiting for, and the difference matters:
 * it still returns results, it just costs every other question to do so.
 *
 * WHY p95 AND NOT THE AVERAGE. An average hides the tail, and the tail is what
 * a person experiences as broken. Teams channels averaged five and a half
 * seconds, inside a naive reading of the budget, while one call in twenty took
 * twenty-two.
 *
 * WHY IT WARNS RATHER THAN DISABLES. Removing a provider from the fan-out
 * silently loses a client's data source, which is worse than a slow answer
 * they at least receive. The timeout already bounds the damage per request;
 * this makes the trend visible so somebody can decide.
 */

import { query } from "@/lib/db";
import { PROVIDER_BUDGET_MS } from "@/lib/search/runSearch";
import { persistProbeResult, type ProbeResult } from "@/lib/health/integration-probes";

/**
 * Calls needed before a p95 means anything.
 *
 * Below this, one slow call sets the percentile and a provider gets reported
 * as over budget on the strength of a single bad morning. A quiet provider is
 * reported as unmeasured, never as healthy: this codebase has been bitten
 * repeatedly by silence reading as success.
 */
export const MIN_CALLS_FOR_VERDICT = 20;

export interface ProviderLatency {
  provider: string;
  calls: number;
  /** Null when there were too few calls to judge. */
  p95Ms: number | null;
  avgMs: number | null;
  /** Null when unmeasured. True when p95 sits inside the budget. */
  withinBudget: boolean | null;
}

export interface LatencyCheck {
  budgetMs: number;
  providers: ProviderLatency[];
  /** Providers whose p95 exceeded the budget, worst first. */
  overBudget: ProviderLatency[];
  /** True when the telemetry itself could not be read. */
  unreadable: boolean;
}

export async function checkSearchLatency(days = 7): Promise<LatencyCheck> {
  const bounded = Math.max(1, Math.min(90, Math.floor(days)));
  try {
    const { rows } = await query<{
      provider: string;
      calls: string;
      p95: string | null;
      avg: string | null;
    }>(
      `SELECT metadata->>'provider' AS provider,
              count(*)::text AS calls,
              round(percentile_cont(0.95) WITHIN GROUP (
                ORDER BY (metadata->>'took_ms')::numeric))::text AS p95,
              round(avg((metadata->>'took_ms')::numeric))::text AS avg
         FROM instinct_events
        WHERE event_type = 'assistant.search_provider_executed'
          AND timestamp > NOW() - ($1::int * INTERVAL '1 day')
          AND metadata->>'took_ms' ~ '^[0-9]+$'
          AND metadata->>'provider' IS NOT NULL
        GROUP BY 1`,
      [bounded],
    );

    const providers: ProviderLatency[] = rows.map((r) => {
      const calls = Number(r.calls);
      /* Too few calls is UNMEASURED, not healthy. */
      const judged = calls >= MIN_CALLS_FOR_VERDICT;
      const p95 = judged && r.p95 !== null ? Number(r.p95) : null;
      return {
        provider: r.provider,
        calls,
        p95Ms: p95,
        avgMs: r.avg !== null ? Number(r.avg) : null,
        withinBudget: p95 === null ? null : p95 <= PROVIDER_BUDGET_MS,
      };
    });

    return {
      budgetMs: PROVIDER_BUDGET_MS,
      providers: providers.sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1)),
      overBudget: providers
        .filter((p) => p.withinBudget === false)
        .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0)),
      unreadable: false,
    };
  } catch {
    /* Unreadable is not "everything is fine". */
    return { budgetMs: PROVIDER_BUDGET_MS, providers: [], overBudget: [], unreadable: true };
  }
}

/**
 * Record each provider's verdict where the other health checks live.
 *
 * One row per provider, so a provider drifting towards the budget over weeks
 * is a trend somebody can read rather than a threshold that trips one night
 * with no history behind it.
 */
export async function recordSearchLatency(
  workspaceId = "default",
  days = 7,
): Promise<LatencyCheck> {
  const check = await checkSearchLatency(days);
  if (check.unreadable) return check;

  for (const p of check.providers) {
    const probe: ProbeResult = {
      vendor: "search-fanout",
      probeKind: "action",
      objectType: p.provider,
      /* Unmeasured is not a pass. A provider with too little traffic to judge
         is recorded as not-ok with a reason, so a quiet provider never reads
         as a healthy one. */
      ok: p.withinBudget === true,
      ...(p.withinBudget === null
        ? { errorMessage: `only ${p.calls} calls, too few to judge`, notConfigured: true }
        : p.withinBudget === false
          ? { errorMessage: `p95 ${p.p95Ms}ms exceeds the ${check.budgetMs}ms fan-out budget` }
          : {}),
      schemaPayload: { calls: p.calls, p95_ms: p.p95Ms, avg_ms: p.avgMs },
      durationMs: p.avgMs ?? 0,
    };
    await persistProbeResult(workspaceId, probe).catch(() => undefined);
  }

  return check;
}
