/**
 * POST /api/admin/ai-router/probe - ask every configured model whether it
 * actually answers.
 *
 * WHY THIS IS A POST AND NOT PART OF THE GET
 *
 * The GET beside this one is free: it derives everything from decisions the
 * router already logged. This one sends a real inference request to every
 * configured endpoint. It costs a fraction of a cent, it counts against a rate
 * limit, and it must therefore happen because an operator asked - never on page
 * load. A dashboard that bills you to render itself is a bad dashboard, and a
 * GET that a crawler, a prefetch or a retry can fire is the wrong verb for it.
 *
 * WHAT IT PROVES THAT THE GET CANNOT
 *
 * "Available" on the router page means the environment variables are non-empty.
 * A deployment name with a typo, a deleted deployment, a rotated key and a
 * working model all render identically. This is the only surface that tells
 * them apart, so its headline leads with the models the other page would have
 * shown as green and which did not answer.
 *
 * WHAT IT NEVER RETURNS
 *
 * The provider's response body. A 401 body can echo the key that was rejected,
 * and a 400 body can echo the prompt. Only a status and a sentence written here
 * cross the wire.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { probeAllModels } from "@/lib/ai/models/probe";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const report = await probeAllModels();

  const counts = {
    models_probed: report.results.length,
    reachable: report.reachable,
    broken: report.brokenlyConfigured.length,
    not_configured: report.results.filter((r) => r.outcome === "not-configured").length,
    refused: report.results.filter((r) => r.outcome === "refused").length,
  };

  trackEvent("ai.model_probe_run", auth.user.id, auth.user.role, counts);

  // One row per broken model, so the learning loop can see a deployment that
  // has been quietly failing for a week rather than only the latest total.
  for (const r of report.results) {
    if (r.outcome === "unreachable" || r.outcome === "refused") {
      trackEvent("ai.model_probe_unreachable", auth.user.id, auth.user.role, {
        model_id: r.modelId,
        status: r.status ?? 0,
        outcome: r.outcome,
      });
    }
  }

  // Audited because it reaches every configured provider endpoint with the
  // deployment's own credentials. Who ran it and when is a security-relevant
  // fact, not just an operational one.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai.model_probe_run",
    resourceType: "model_router",
    afterState: counts,
  });

  return NextResponse.json(report, { status: 200 });
}
