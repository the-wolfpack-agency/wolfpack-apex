/**
 * GET /api/admin/ogiam/selftest: run the OGIAM gate self-test for the caller's
 * workspace and return the report.
 *
 * The self-test PROVES the gate in one call: it decides a set of representative
 * ALLOW and DENY cases through the REAL authorize() path, times each call (p50 /
 * p95 / max), and re-verifies the decision chain (verifyChain recomputes every
 * entry hash). The report's correctness, latency, and chainVerified together let
 * an operator or a client confirm the gate is correct, fast, and auditable.
 *
 * Returns 200 even when a case fails: the report's allPassed conveys health, and
 * the caller (a monitor, a dashboard, a client) decides what to do with it. A
 * non-200 would be the wrong signal - the harness ran successfully; it is the
 * gate's health, not the request, that the body reports. This mirrors the verify
 * route: capability gated and graceful-degrading, never 500 on a recoverable
 * condition.
 *
 * GET (not POST): it has no external side effect with cost (the signing-selftest
 * route is POST because it triggers a Key Vault signing operation; this one only
 * exercises the pure-function gate + the best-effort ledger write), it is
 * idempotent, and being a read makes it safe for a health monitor to poll.
 *
 * Capability: settings.manage_team (the same gate as the rest of the OGIAM admin
 * surface).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { runGateSelfTest } from "@/lib/ogiam/gate-selftest";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const workspaceId = auth.user.workspaceId ?? "default";

  try {
    const report = await runGateSelfTest(workspaceId);
    return NextResponse.json({ workspace_id: workspaceId, report });
  } catch (err) {
    // The harness is best-effort; never 500 on a recoverable condition. Report a
    // structured failure so a monitor sees an unhealthy gate rather than a crash.
    console.error("[ogiam selftest]", (err as Error).message);
    return NextResponse.json({
      workspace_id: workspaceId,
      report: {
        correct: 0,
        total: 0,
        allPassed: false,
        latency: { p50: 0, p95: 0, max: 0 },
        chainVerified: false,
        cases: [],
      },
      message: "Self-test failed to run.",
    });
  }
}
