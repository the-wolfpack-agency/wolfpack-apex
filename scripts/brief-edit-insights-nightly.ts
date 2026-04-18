/**
 * scripts/brief-edit-insights-nightly.ts
 *
 * Nightly aggregator for the brief-edit learning loop. Invoked by CI
 * via `npx tsx scripts/brief-edit-insights-nightly.ts`.
 *
 * For each of the 7-day and 30-day windows:
 *   1. compute BriefEditInsights via computeBriefEditInsights()
 *   2. persist the snapshot into apex_brief_edit_insights_snapshots
 *   3. emit a site.insights_snapshot_taken analytics event
 *
 * Exits 0 on success, non-zero with a loud banner on failure so the
 * CI job fails noisily rather than silently producing stale data.
 *
 * Shadow-mode safe: when DATABASE_URL is unset, safeQuery no-ops and
 * the script prints a warning + exits 0 (this lets local developers
 * invoke the script end-to-end without infra).
 */

import { trackEvent } from "@/lib/analytics";
import {
  computeBriefEditInsights,
  writeInsightsSnapshot,
  type BriefEditInsights,
} from "@/lib/brief-edit-learning";

const WINDOWS_DAYS = [7, 30] as const;

// The snapshot script is a process — not a user. Use a stable synthetic
// id so events are distinguishable in analytics.
const ACTOR_USER_ID = "system.brief_edit_snapshot";
const ACTOR_USER_ROLE = "system";

interface SnapshotResult {
  days: number;
  snapshotId: string;
  rowCount: number;
  acceptanceRate: number;
}

async function takeSnapshot(days: number): Promise<SnapshotResult> {
  const insights: BriefEditInsights = await computeBriefEditInsights({ days });
  const snapshotId = await writeInsightsSnapshot(insights);

  trackEvent("site.insights_snapshot_taken", ACTOR_USER_ID, ACTOR_USER_ROLE, {
    snapshot_id: snapshotId,
    window_days: days,
    window_start: insights.window.start,
    window_end: insights.window.end,
    row_count: insights.window.rowCount,
    acceptance_rate: insights.acceptanceRate.overall,
    total_cost_usd: insights.performance.totalCostUsd,
  });

  return {
    days,
    snapshotId,
    rowCount: insights.window.rowCount,
    acceptanceRate: insights.acceptanceRate.overall,
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn(
      "[brief-edit-insights-nightly] DATABASE_URL not set — shadow mode; " +
        "computing insights over empty set and skipping writes.",
    );
  }

  const results: SnapshotResult[] = [];
  for (const days of WINDOWS_DAYS) {
    const r = await takeSnapshot(days);
    results.push(r);
    console.log(
      `[brief-edit-insights-nightly] window=${r.days}d snapshot=${r.snapshotId} ` +
        `rows=${r.rowCount} acceptance=${(r.acceptanceRate * 100).toFixed(1)}%`,
    );
  }

  console.log(
    `[brief-edit-insights-nightly] wrote ${results.length} snapshot(s).`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("==========================================");
  console.error("[brief-edit-insights-nightly] FATAL:", msg);
  if (err instanceof Error && err.stack) console.error(err.stack);
  console.error("==========================================");
  process.exit(1);
});
