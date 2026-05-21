/**
 * GET /api/job-codes/[code]/dossier — cross-source dossier for a code.
 *
 * Read-only. The dossier joins the cache row, applied receipt scans,
 * the audit log, and code-tagged analytics events into one payload
 * for the /job-codes/[code] page.
 *
 * Capability: jobcodes.view (same gate as the catalog itself —
 * dossier exposes no new fields, just rolls them up).
 *
 * Returns:
 *   200 — { dossier }
 *   404 — { error: "code_not_found" } when the code isn't in the cache
 *   401 / 403 — auth failure (handled by requireCapability)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { buildCodeDossier } from "@/lib/job-codes/dossier";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const auth = await requireCapability(req, "jobcodes.view");
  if (!auth.ok) return auth.response;

  const { code } = await params;
  if (!code || !code.trim()) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }

  const t0 = Date.now();
  const dossier = await buildCodeDossier(code);
  if (!dossier) {
    return NextResponse.json(
      { error: "code_not_found", code },
      { status: 404 },
    );
  }

  /* Fire analytics on every successful dossier read — same surface
     as `jobcodes.viewed` (catalog browse). The dossier is its own
     funnel signal so the learning loop can tell catalog-skim from
     drill-in. */
  await trackEvent(
    "system.job_code_dossier_viewed",
    auth.user.id,
    auth.user.role,
    {
      code: dossier.header.code,
      receipt_count: dossier.rollups.receiptCount,
      activity_count: dossier.activity.length,
      has_po: dossier.header.poAmountNumeric != null,
      latency_ms: Date.now() - t0,
    },
  );

  return NextResponse.json({ dossier });
}
