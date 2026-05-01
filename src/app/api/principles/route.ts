/**
 * POST /api/principles — create a principle natively (no SharePoint).
 *
 * Leadership-only (ceo / cto). 409 on duplicate slug. 400 on missing
 * required fields. Returns the new principle record.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { canReadTeamEvidence } from "@/lib/principles/authz";
import { createPrincipleNative } from "@/lib/principles/store";
import { evaluatePrinciples } from "@/lib/principles/evaluate-runner";
import { trackEvent } from "@/lib/analytics";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  try {
    const principle = await createPrincipleNative({
      title,
      domains: Array.isArray(body.domains) ? (body.domains as string[]) : [],
      owner: typeof body.owner === "string" ? body.owner : null,
      bodyMd: typeof body.bodyMd === "string" ? body.bodyMd : "",
      scoreboardWeight:
        typeof body.scoreboardWeight === "number"
          ? body.scoreboardWeight
          : 1,
      effectiveAt: typeof body.effectiveAt === "string" ? body.effectiveAt : null,
      signals: Array.isArray(body.signals) ? (body.signals as string[]) : [],
      counterSignals: Array.isArray(body.counterSignals)
        ? (body.counterSignals as string[])
        : [],
    });
    trackEvent("principle.created", user.id, user.role, {
      principle_id: principle.id,
      slug: principle.slug,
      signal_count:
        (Array.isArray(body.signals) ? body.signals.length : 0) +
        (Array.isArray(body.counterSignals)
          ? body.counterSignals.length
          : 0),
    });
    /* Fan out evaluation across the org immediately so the scoreboard
       starts populating without waiting for the next 4h cron tick.
       Fire-and-forget: a network error against M365 shouldn't fail
       the create response — the cron will retry on schedule. The
       wide bootstrap window makes sure the principle gets a real
       month-to-date baseline on first save. */
    void evaluatePrinciples([principle], { forceBootstrap: true }).catch(
      (err) => {
        trackEvent("principle.evaluation_failed", user.id, user.role, {
          stage: "post_create",
          principle_id: principle.id,
          error: (err as Error).message,
        });
      },
    );
    return NextResponse.json({ principle }, { status: 201 });
  } catch (err) {
    const msg = (err as Error).message;
    const status = /already exists/.test(msg) ? 409 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
