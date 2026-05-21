/**
 * GET /api/admin/azure-status — non-secret probe of Azure Cognitive
 * Services configuration + recent-call health.
 *
 * Returns:
 *   - vision/form_recognizer: whether each service has creds set
 *     (boolean only; never echoes endpoint/key — those are secrets).
 *   - last 24h call counts grouped by service + status, sourced from
 *     instinct_azure_calls. Lets the CTO check "did the keys
 *     actually take effect" without running a real OCR call.
 *
 * Capability: admin.health.probe (already used by other integration
 * probes). Cheap by design — one boolean check + one indexed query.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { isVisionConfigured } from "@/lib/azure/vision-ocr";
import { isFormRecognizerConfigured } from "@/lib/azure/form-recognizer";
import { safeQuery } from "@/lib/db";

interface CallCountRow {
  service: string;
  status: string;
  n: number;
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "admin.health.probe");
  if (!auth.ok) return auth.response;

  const calls = await safeQuery<CallCountRow>(
    `SELECT service, status, COUNT(*)::int AS n
     FROM instinct_azure_calls
     WHERE created_at > NOW() - INTERVAL '24 hours'
     GROUP BY service, status
     ORDER BY service, status`,
  );

  /* Group into a friendly shape per service. */
  const byService: Record<string, { total: number; succeeded: number; failed: number; rate_limited: number; not_configured: number }> = {
    computer_vision: { total: 0, succeeded: 0, failed: 0, rate_limited: 0, not_configured: 0 },
    form_recognizer: { total: 0, succeeded: 0, failed: 0, rate_limited: 0, not_configured: 0 },
  };
  for (const r of calls.rows) {
    const bucket = byService[r.service];
    if (!bucket) continue;
    bucket.total += r.n;
    if (r.status in bucket) {
      (bucket as Record<string, number>)[r.status] = r.n;
    }
  }

  /* Last error per service — useful for "I set the key but it's still
     failing" debugging without granting raw DB access. */
  const errs = await safeQuery<{ service: string; error_code: string; error_detail: string; created_at: string }>(
    `SELECT DISTINCT ON (service) service, error_code, error_detail, created_at
     FROM instinct_azure_calls
     WHERE status IN ('failed', 'rate_limited', 'not_configured')
       AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY service, created_at DESC`,
  );

  return NextResponse.json({
    configured: {
      computer_vision: isVisionConfigured(),
      form_recognizer: isFormRecognizerConfigured(),
    },
    last_24h: byService,
    last_errors: errs.rows,
  });
}
