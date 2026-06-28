/**
 * Cross-scan insight generation - the engine that runs the moat.
 *
 * generateInsights() is the orchestrator that turns the raw, single-layer finding
 * corpus into higher-order cross-scan Insights and feeds every one back into the
 * learning loop:
 *
 *   1. READ   the full open-finding corpus across EVERY platform (listFindings)
 *             plus the resolved-finding history (for regression detection).
 *   2. CORRELATE via the pure correlateFindings() - the only place a security gap,
 *             a broken journey, a perf cliff, and a resolved-then-reopened finding
 *             are reasoned about together.
 *   3. PERSIST via recordInsights (UPSERT by stable key - re-runs never duplicate).
 *   4. LEARN  fire platform.cross_scan_insight_generated PER insight, plus the
 *             sub-events platform.cross_scan_correlation_detected (compound_risk)
 *             and platform.cross_scan_regression_detected (regression). No data
 *             lost: every insight reaches both the durable store AND analytics.
 *
 * Graceful degradation: a persistence failure is swallowed (recordInsights never
 * throws), so the computed insights are STILL returned to the caller - the route
 * stays 200 and the learning events still fired. Mirrors the benchmark route's
 * "the scorer already emitted analytics" robustness idiom.
 *
 * All I/O is injected via `deps` so this is fully unit-testable without a DB or a
 * live analytics pipe.
 */

import { listFindings } from "../store";
import { trackEvent } from "@/lib/analytics";
import { recordInsights, listRecentInsights } from "./insights-store";
import {
  correlateFindings,
  type Insight,
  type CorrelationFinding,
  type CorrelationHistory,
  type CorrelateOptions,
} from "./correlate";
import type { ScanFindingRow } from "../store";

/** Injectable I/O seams. All optional: production defaults wire the real store +
 *  analytics; tests pass fakes. */
export interface GenerateDeps {
  /** Read the open findings for the workspace. Defaults to the real store. */
  listFindings?: typeof listFindings;
  /** Resolved-finding history for regression detection. Optional. */
  history?: CorrelationHistory;
  /** Persist the insights. Defaults to the real store. */
  record?: typeof recordInsights;
  /** Fire an analytics event. Defaults to the real trackEvent. */
  track?: typeof trackEvent;
  /** Correlation tuning (systemic threshold, clock, expected categories). */
  options?: CorrelateOptions;
}

export interface GenerateResult {
  insights: Insight[];
  persisted: number;
}

/** Map a stored finding row to the minimal shape correlation needs. */
function toCorrelationFinding(r: ScanFindingRow): CorrelationFinding {
  return {
    platform: r.platform,
    route: r.route,
    severity: r.severity,
    category: r.category,
    title: r.title,
  };
}

/**
 * Generate cross-scan insights for a workspace: read findings across platforms,
 * correlate, persist, fire learning events, return the insights.
 *
 * @param workspaceId the workspace whose findings to correlate.
 * @param actor       who triggered the run (attributes the analytics events).
 * @param deps        injectable I/O (store, history, analytics).
 */
export async function generateInsights(
  workspaceId: string,
  actor: { id: string; role: string },
  deps: GenerateDeps = {},
): Promise<GenerateResult> {
  const read = deps.listFindings ?? listFindings;
  const persist = deps.record ?? recordInsights;
  const track = deps.track ?? trackEvent;

  // 1. READ the full OPEN corpus across every platform (no platform filter =
  //    cross-modality, cross-target raw material). High limit: correlation needs
  //    the whole picture, not a page.
  let rows: ScanFindingRow[] = [];
  try {
    rows = await read(workspaceId, { status: "open", limit: 500 });
  } catch (err) {
    // A read failure must not throw from the engine; with no corpus there is
    // nothing to correlate, so return empty rather than 500 the caller.
    console.warn("[insights/generate] listFindings failed:", (err as Error).message);
    rows = [];
  }
  const findings = rows.map(toCorrelationFinding);

  // 2. CORRELATE (pure).
  const insights = correlateFindings(findings, deps.history, deps.options);

  // 3. PERSIST (best effort - never throws).
  let persisted = 0;
  try {
    const res = await persist(insights);
    persisted = res.written;
  } catch (err) {
    // recordInsights already swallows per-row errors; this guards a total failure
    // of the seam (e.g. an injected fake that throws). Insights are still returned.
    console.warn("[insights/generate] recordInsights failed:", (err as Error).message);
  }

  // 4. LEARN - one event per insight, plus the typed sub-events. Analytics
  //    metadata is scalar-only, so the modality set is recorded as a stable csv.
  for (const ins of insights) {
    track("platform.cross_scan_insight_generated", actor.id, actor.role, {
      insight_kind: ins.kind,
      severity: ins.severity,
      modalities: ins.modalities.join(","),
      member_count: ins.members.length,
      platform: ins.platform,
    });

    if (ins.kind === "compound_risk") {
      track("platform.cross_scan_correlation_detected", actor.id, actor.role, {
        platform: ins.platform,
        chain_length: ins.members.length,
        peak_severity: ins.severity,
        route: ins.members[0]?.route ?? "",
      });
    } else if (ins.kind === "regression") {
      // gap_days is embedded in the narrative; surface the structured signal too.
      track("platform.cross_scan_regression_detected", actor.id, actor.role, {
        platform: ins.platform,
        finding_class: `${ins.members[0]?.category ?? ""}::${ins.members[0]?.title ?? ""}`,
        route: ins.members[0]?.route ?? "",
        severity: ins.severity,
      });
    }
  }

  return { insights, persisted };
}

// Re-export the read path so the route imports both generate + list from here if
// it prefers a single module; the store remains the source of truth.
export { listRecentInsights };
