/**
 * GET /api/pilot/phase-one — the figures behind the phase one dashboard.
 *
 * A route rather than a server component reading the database directly, and
 * the reason is not style. The direct version had no capability gate on it at
 * all and no workspace in scope, so it would have served a client-facing
 * summary to anybody who reached the URL and counted every tenant's connected
 * libraries while doing it. The repo-wide tenancy scan caught the second
 * problem, which is what surfaced the first.
 *
 * Gated on assistant.use because that is the capability that means "this
 * person may ask this product questions", and every figure here is a summary
 * of questions asked and answered.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getPhaseOneSnapshot } from "@/lib/pilot/phase-one";
import { getAdoptionSnapshot } from "@/lib/pilot/adoption";
import { readCapabilitySnapshot } from "@/lib/insights/capability-snapshot";
import { readLibraryQuestions } from "@/lib/pilot/library-questions";
import { getTokenUsage } from "@/lib/pilot/token-usage";

const DEFAULT_DAYS = 60;
const MAX_DAYS = 365;

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "assistant.use");
  if (!auth.ok) return auth.response;

  const raw = Number(req.nextUrl.searchParams.get("days"));
  const days =
    Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_DAYS) : DEFAULT_DAYS;

  const workspaceId = auth.user.workspaceId ?? "default";
  /* Fetched together because the page shows them together, and a pilot judged
     on adoption should not have to wait for a second round trip to learn
     whether anybody is using it. */
  /* CAPABILITY MOVES HERE FROM THE ADMIN PAGE.
     It lived on /admin/insights, which is gated to three roles and mixes it
     with our own backlog signals: unmet intents, routing coverage, controls
     shown to the wrong role. Those are OUR questions. What a model costs, how
     little of the product needs one, and what the router stopped from leaving
     are the CLIENT'S questions, and they were on the wrong page for the wrong
     audience. Two audiences sharing a page is most of why that page reads as
     jumbled.

     Read here rather than proxied, so this page owns its own figures and does
     not depend on an admin endpoint a client's role cannot call. */

  /* getGapsSnapshot was dropped here when the "What we could not answer" panel
     was removed from the page. It ran a query on every load and its result was
     no longer rendered, and the connector lookup that fed it went with it. */
  const [snapshot, adoption, capability, tokenUsage, libraryQuestions] = await Promise.all([
    getPhaseOneSnapshot(workspaceId, days),
    getAdoptionSnapshot(workspaceId, days),
    readCapabilitySnapshot(days).catch(() => null),
    /* Real token counts from the completion log, so the cost comparison rests
       on what was actually consumed rather than an estimate from message
       lengths. */
    getTokenUsage(days).catch(() => null),
    /* WEEK ONE'S MOST USEFUL OUTPUT IS A QUESTION. Reading a client's library
       and telling them what it means is the most expensive mistake available:
       42 per cent of our own turned out to be our tooling writing into it. */
    readLibraryQuestions(),
  ]);

  return NextResponse.json({ ...snapshot, adoption, capability, tokenUsage, libraryQuestions }, {
    status: 200,
    /* Never cached: a dashboard figure that is minutes old invites somebody to
       act on a number that has already moved. */
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
