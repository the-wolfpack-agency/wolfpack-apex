/**
 * GET /api/principles/team/[userId]
 *
 * Leadership-only per-member drill-down. Returns active principles
 * + the named member's observations + identity. 403 for everyone
 * except ceo / cto. Audit-logs the cross-user read.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  listActivePrinciples,
  listObservationsForSubject,
} from "@/lib/principles/store";
import { canReadTeamEvidence, recordEvidenceView } from "@/lib/principles/authz";
import { resolveUserNames } from "@/lib/principles/user-names";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ userId: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { userId: subjectUserId } = await context.params;
  if (!subjectUserId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  const url = new URL(req.url);
  const sinceISO =
    url.searchParams.get("since") ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [principles, observations, names] = await Promise.all([
    listActivePrinciples(),
    listObservationsForSubject(subjectUserId, { sinceISO, limit: 500 }),
    resolveUserNames([subjectUserId]),
  ]);
  const subject = names.get(subjectUserId);

  void recordEvidenceView({
    viewer: { id: user.id, role: user.role },
    subjectUserId,
    route: `/api/principles/team/${subjectUserId}`,
    evidenceCount: observations.length,
  });

  return NextResponse.json({
    subject: {
      userId: subjectUserId,
      displayName: subject?.displayName ?? subjectUserId,
      email: subject?.email ?? null,
    },
    principles: principles.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      domains: p.domains,
      scoreboardWeight: p.scoreboardWeight,
    })),
    observations: observations.map((o) => ({
      id: o.id,
      principleId: o.principleId,
      validatorId: o.validatorId,
      surface: o.surface,
      surfaceSubtype: o.surfaceSubtype,
      observedAt: o.observedAt,
      score: o.score,
      evidence: o.evidenceJsonb,
    })),
    sinceISO,
  });
}
