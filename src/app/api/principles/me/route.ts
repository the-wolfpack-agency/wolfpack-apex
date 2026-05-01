/**
 * GET /api/principles/me
 *
 * Member self-view. Returns the caller's own observations + active
 * principles. No leadership data, no cross-user data, no awareness of
 * the team scoreboard. Pure self-improvement surface.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  listActivePrinciples,
  listObservationsForSubject,
} from "@/lib/principles/store";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const sinceISO =
    url.searchParams.get("since") ||
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [principles, observations] = await Promise.all([
    listActivePrinciples(),
    listObservationsForSubject(user.id, { sinceISO, limit: 200 }),
  ]);
  return NextResponse.json({
    principles: principles.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      domains: p.domains,
      bodyMd: p.bodyMd,
    })),
    observations: observations.map((o) => ({
      id: o.id,
      principleId: o.principleId,
      surface: o.surface,
      surfaceSubtype: o.surfaceSubtype,
      observedAt: o.observedAt,
      score: o.score,
      evidence: o.evidenceJsonb,
    })),
    sinceISO,
  });
}
