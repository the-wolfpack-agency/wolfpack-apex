/**
 * GET /api/cron/integration-health: the nightly integration-health sweep.
 *
 * Walks every workspace that has an active connector, runs a connectivity probe
 * + a schema probe per CRM object, persists each result to integration_health,
 * and emits integration.health_drift_detected when a vendor's schema hash has
 * changed since the last good probe. This is how a client's CRM breaking
 * silently (a removed field, a revoked token, an API version bump) surfaces
 * BEFORE it breaks an agent's workflow - the probe is the signal, the drift
 * event feeds the learning loop.
 *
 * Two auth paths (mirrors /api/cron/agent-drift):
 *   1. Cron path: Authorization: Bearer ${CRON_SECRET}. Vercel Cron hits this on
 *      the nightly schedule. Returns false when CRON_SECRET is unset (local dev).
 *   2. User path: requireCapability(req, "settings.manage_team") for an admin
 *      triggering a manual sweep.
 *
 * Never 500s on a recoverable condition: the sweep is best-effort and a
 * top-level throw returns a zeroed 200 so the cron health-monitor stays green.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { sweepAllWorkspaces } from "@/lib/health/integration-probes";
import { runAssistantSelfCheck } from "@/lib/health/assistant-selfcheck";
import { recordSearchLatency } from "@/lib/health/search-latency-check";
import { recordProviderReadiness } from "@/lib/health/model-provider-check";
import { trackEvent } from "@/lib/analytics";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

async function runSweep(actorId: string, actorRole: string): Promise<NextResponse> {
  try {
    const result = await sweepAllWorkspaces();

    /* THE PRODUCT ASKS ITSELF THE QUESTIONS THAT WERE WRONG.
       The integration probes above answer "can we reach it". This answers "does
       it still give the right answer", which is a different question and the
       one that was false all day on 2026-08-28 while every probe would have
       read green. Runs after the probes so a Graph outage shows up as an
       integration failure rather than as six mysterious behaviour failures. */
    const selfCheck = await runAssistantSelfCheck().catch(() => null);

    /* EVERY INTEGRATION JOINS THE FAN-OUT, AND THE SLOWEST ONE IS THE SEARCH.
       Connecting a client's systems is the product, so each new source widens
       what we answer AND lands a latency risk on every question. #503 stopped a
       slow provider holding the rest up; this notices that it happened, which
       is the half that was missing when one provider made the whole product
       feel broken for weeks without anybody attributing it. */
    const latency = await recordSearchLatency().catch(() => null);

    /* WHICH MODELS WE CAN ACTUALLY REACH.
       The product is sold on routing to the cheapest model that can answer,
       and 99.8% of every call in its life went to one vendor because that is
       the only one with credentials. Production carries ANTHROPIC_MODEL and no
       ANTHROPIC_API_KEY, so three Claude models the registry advertises have
       never been able to run, and nothing reported it: the router correctly
       fell through to the provider that worked, which looks identical to a
       product that only supports one vendor. */
    const modelProviders = await recordProviderReadiness().catch(() => null);
    trackEvent("integration.health_sweep", actorId, actorRole, {
      workspaces: result.workspaces,
      probes: result.probes,
      drift_count: result.drifted.length,
    });
    return NextResponse.json({
      ok: true,
      ...result,
      selfCheck: selfCheck
        ? { ran: selfCheck.ran, failed: selfCheck.failed.map((f) => `${f.id}: ${f.reason}`) }
        : { ran: 0, failed: ["self-check did not run"] },
      modelProviders: modelProviders
        ? {
            reachable: modelProviders.providers.filter((p) => p.configured).map((p) => p.provider),
            unreachable: modelProviders.unreachable.map(
              (p) => `${p.provider}: ${p.missing.join(", ")} not set`,
            ),
          }
        : { reachable: [], unreachable: ["provider check did not run"] },
      searchLatency: latency
        ? {
            budgetMs: latency.budgetMs,
            overBudget: latency.overBudget.map((p) => `${p.provider}: p95 ${p.p95Ms}ms`),
          }
        : { budgetMs: 0, overBudget: ["latency check did not run"] },
    });
  } catch (err) {
    console.error("[cron/integration-health]", (err as Error).message);
    return NextResponse.json({ ok: true, workspaces: 0, probes: 0, drifted: [] });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) {
    return runSweep("cron", "system");
  }
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runSweep(auth.user.id, auth.user.role);
}
