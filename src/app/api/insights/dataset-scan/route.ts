/**
 * GET /api/insights/dataset-scan
 *
 * Runs the scan and the recommendation pass over the evaluation corpus and
 * returns both, including everything each of them refused to say.
 *
 * THE PLAN IS RETURNED WITH THE ANSWER. A variance is meaningless without the
 * number it was measured against, and a page that shows the gap while hiding
 * the plan is asking to be trusted rather than checked. The competitor's scan
 * shows "9,258 against a target of 10,611" and nothing about where 10,611 came
 * from; ours ships the targets it used so a reader can disagree with them.
 *
 * The targets here are OURS, not the client's. They are labeled as such on the
 * page, because presenting a plan we invented as theirs would be the same
 * failure as the numbers it exists to improve on.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { readEvaluations } from "@/lib/insights/evaluation-reader";
import { scanDataset } from "@/lib/insights/dataset-scan";
import { recommend, summarize, type PlanTarget } from "@/lib/insights/recommendations";
import { trackEvent } from "@/lib/analytics";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * An illustrative plan, stated so it can be argued with.
 *
 * Attendance by role for one cycle. We do not hold the client's real plan, and
 * inventing one and presenting it as theirs would be exactly the move this
 * whole surface exists to beat.
 */
const EXAMPLE_PLAN: PlanTarget[] = [
  { dimension: "role", value: "PCNA Dealer Sales Professional", planned: 1200, unit: "responses" },
  { dimension: "role", value: "PCNA Dealer General Manager", planned: 400, unit: "responses" },
  { dimension: "role", value: "PCNA Dealer Parts Manager", planned: 500, unit: "responses" },
  { dimension: "role", value: "PCNA Dealer Service Manager", planned: 300, unit: "responses" },
  { dimension: "venue", value: "Ritz Carlton", planned: 1000, unit: "responses" },
];

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "reports.view");
  if (!auth.ok) return auth.response;

  const started = Date.now();
  try {
    const corpus = await readEvaluations();
    const scan = scanDataset(corpus.records, corpus.documents);
    const advice = recommend(scan, EXAMPLE_PLAN, "C&I");

    trackEvent("insights.dataset_scanned", auth.user.id, auth.user.role, {
      records: scan.records,
      actions: advice.recommendations.length,
      not_actionable: advice.notActionable.length,
      withheld: scan.withheld.length,
      duration_ms: Date.now() - started,
    });

    return NextResponse.json(
      {
        readable: scan.readable,
        summary: summarize(advice, scan),
        records: scan.records,
        documents: scan.documents,
        /* Reported so a total reads as "at least this many". The exports are
           spreadsheets flattened for retrieval, so a row can be cut in half by
           a chunk boundary and a field then cannot be attributed. */
        unattributed: corpus.partial,
        plan: EXAMPLE_PLAN,
        dimensions: scan.dimensions,
        withheld: scan.withheld,
        recommendations: advice.recommendations,
        notActionable: advice.notActionable,
        durationMs: Date.now() - started,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    /* Unreadable is not the same fact as "nothing to report", and the page
       renders them differently. */
    return NextResponse.json(
      { readable: false, error: (err as Error).message.slice(0, 200) },
      { status: 200, headers: NO_STORE },
    );
  }
}
