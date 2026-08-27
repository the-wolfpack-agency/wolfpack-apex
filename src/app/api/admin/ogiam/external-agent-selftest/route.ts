/**
 * POST /api/admin/ogiam/external-agent-selftest: prove the bring-your-own-agent
 * gate, end to end, from inside the product.
 *
 * The neighbouring selftest proves the gate's DECISION path by calling
 * authorize() directly. This proves the part an outside agent actually meets:
 * the public endpoint, bearer parsing, the key store, capability scoping,
 * revocation, and the status-code discipline that returns a policy deny as
 * 200 { allowed: false } rather than a 403.
 *
 * WHY IT EXISTS. On 2026-08-27 the table holding external keys had zero rows.
 * The endpoint, key store, rate limiter and scoping were each written and each
 * tested in isolation, and had never been exercised together. A control nobody
 * has run is a claim, and this repo has shipped that shape before: an approval
 * gate that had never held a write, a redaction counter reading zero because
 * the redactor stood where the traffic was not.
 *
 * POST, NOT GET, and deliberately not pollable. It mints a real credential and
 * revokes it, so it has a side effect with consequences even though it cleans
 * up after itself. A health monitor must not be able to create keys by
 * accident, which a GET invites.
 *
 * It calls its own deployment over HTTP on purpose. Importing authorize() here
 * would skip exactly the layers most likely to be wrong.
 *
 * Returns 200 with the report even when a step fails: the harness ran, and it
 * is the gate's health rather than the request that the body describes. A
 * failing step is reported as passed:false, never as a 500.
 *
 * Capability: settings.manage_team, the same gate as the rest of the OGIAM
 * admin surface and the same one that mints keys by hand.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit } from "@/lib/audit-log";
import { runExternalAgentExercise } from "@/lib/ogiam/external-agent-exercise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const workspaceId = auth.user.workspaceId ?? "default";

  /* The deployment's own origin, taken from the request rather than from
     configuration: a hardcoded base URL would test whichever environment the
     env var happened to name, which is the one thing this must not do. */
  const origin = new URL(req.url).origin;

  try {
    const report = await runExternalAgentExercise({
      workspaceId,
      createdBy: auth.user.id,
      callGate: async (apiKey, body) => {
        const res = await fetch(`${origin}/api/gate/authorize`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });
        const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { status: res.status, body: parsed };
      },
    });

    /* AUDITED BECAUSE IT MINTS A CREDENTIAL. The key is scoped to one
       read capability and revoked before this returns, but "a key existed for
       four hundred milliseconds" is still a credential event, and the question
       an auditor asks later is who created keys and when. Answering "only the
       selftest" requires the selftest to have said so at the time. */
    await recordAudit({
      actor: { user_id: auth.user.id, role: auth.user.role },
      action: "ogiam.external_agent_selftest_run",
      resourceType: "gate_api_key",
      afterState: {
        workspace_id: workspaceId,
        keys_minted_and_revoked: report.keysCleanedUp,
        steps: report.steps.length,
        passed: report.passed,
      },
    }).catch(() => undefined);

    return NextResponse.json(
      { workspace_id: workspaceId, report },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    /* The harness revokes its keys in a finally block, so a throw here has
       already cleaned up. Reported as a failure to RUN, which is a different
       fact from the gate failing, and the two must not look alike. */
    return NextResponse.json(
      {
        workspace_id: workspaceId,
        error: "selftest_could_not_run",
        detail: err instanceof Error ? err.message : "unknown error",
      },
      { status: 503 },
    );
  }
}
