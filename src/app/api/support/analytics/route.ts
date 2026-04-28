/**
 * GET /api/support/analytics — read-only aggregator endpoint for the AI
 * savings dashboard.
 *
 * Auth: `automations.view` capability (the same gate used by the rest of
 * the support operator console).
 *
 * Query params:
 *   ?window=today | 7d | 30d | all   (default: 7d)
 *
 * Response shape:
 *   {
 *     window: 'today' | '7d' | '30d' | 'all',
 *     summary: SavingsSummary,
 *     by_feature: FeatureBreakdown[],
 *     by_provider: ProviderBreakdown[],
 *     top_cached: TopCachedResponse[],
 *     daily_trend: DailyDataPoint[],
 *     errors: Record<string, string>,  // empty when every section loaded
 *   }
 *
 * Graceful degradation: each repo call is wrapped in its own try/catch so
 * a single broken query (e.g. transient DB hiccup mid-render) does NOT
 * 500 the whole response. The broken section returns its empty default
 * (empty array, or a zeroed-out summary) and the section name + message
 * is recorded in `errors` for the UI to surface non-fatally.
 *
 * Analytics: support.analytics_viewed fires on every successful response.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  getSavingsSummary,
  getSavingsByFeature,
  getSavingsByProvider,
  getTopCachedResponses,
  getDailySavingsTrend,
  type SavingsWindow,
  type SavingsSummary,
  type FeatureBreakdown,
  type ProviderBreakdown,
  type TopCachedResponse,
  type DailyDataPoint,
} from "@/lib/support/analytics-repo";

const ALLOWED_WINDOWS: ReadonlyArray<SavingsWindow> = [
  "today",
  "7d",
  "30d",
  "all",
];

const DEFAULT_WINDOW: SavingsWindow = "7d";

/* Number of trailing days the daily-trend chart should include for each
   window choice. 'today' is intentionally 1 (the chart still renders one
   bar). 'all' uses 30 days because an unbounded trend would balloon
   payload size — UIs that want truly historical data should add a
   dedicated route. */
const DAILY_TREND_DAYS: Record<SavingsWindow, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  all: 30,
};

function parseWindow(value: string | null): SavingsWindow {
  if (value === null) return DEFAULT_WINDOW;
  return ALLOWED_WINDOWS.includes(value as SavingsWindow)
    ? (value as SavingsWindow)
    : DEFAULT_WINDOW;
}

function emptySummary(window: SavingsWindow): SavingsSummary {
  /* Mirrors the SavingsSummary shape so the UI never branches on
     "section is missing" — it just sees zeros + an entry in `errors`. */
  return {
    tokens_saved: 0,
    ai_calls: 0,
    cache_hits: 0,
    cache_miss: 0,
    cache_hit_rate: 0,
    cost_saved_usd: 0,
    time_saved_ms: 0,
    period: { start: null, end: new Date().toISOString() },
  };
  void window;
}

async function tryLoad<T>(
  fn: () => Promise<T>,
  fallback: T,
  errors: Record<string, string>,
  key: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    errors[key] = (err as Error).message || "unknown error";
    return fallback;
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const window = parseWindow(url.searchParams.get("window"));

  const errors: Record<string, string> = {};

  const summary = await tryLoad<SavingsSummary>(
    () => getSavingsSummary(window),
    emptySummary(window),
    errors,
    "summary",
  );
  const by_feature = await tryLoad<FeatureBreakdown[]>(
    () => getSavingsByFeature(window),
    [],
    errors,
    "by_feature",
  );
  const by_provider = await tryLoad<ProviderBreakdown[]>(
    () => getSavingsByProvider(window),
    [],
    errors,
    "by_provider",
  );
  const top_cached = await tryLoad<TopCachedResponse[]>(
    () => getTopCachedResponses(window, 10),
    [],
    errors,
    "top_cached",
  );
  const daily_trend = await tryLoad<DailyDataPoint[]>(
    () => getDailySavingsTrend(DAILY_TREND_DAYS[window]),
    [],
    errors,
    "daily_trend",
  );

  trackEvent("support.analytics_viewed", auth.user.id, auth.user.role, {
    window,
    section_errors: Object.keys(errors).length,
  });

  return NextResponse.json({
    window,
    summary,
    by_feature,
    by_provider,
    top_cached,
    daily_trend,
    errors,
  });
}
