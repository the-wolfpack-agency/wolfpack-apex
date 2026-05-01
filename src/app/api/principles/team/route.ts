/**
 * GET /api/principles/team
 *
 * Leadership-only. Returns aggregate team scoreboard + per-member
 * observation rows. 403 for everyone except ceo / cto.
 *
 * Audit: every successful read is logged via recordEvidenceView so
 * the access trail is reviewable internally (not surfaced to subjects).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  listActivePrinciples,
  listAllObservations,
} from "@/lib/principles/store";
import { canReadTeamEvidence, recordEvidenceView } from "@/lib/principles/authz";
import { resolveUserNames } from "@/lib/principles/user-names";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const sinceISO =
    url.searchParams.get("since") ||
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [principles, observations] = await Promise.all([
    listActivePrinciples(),
    listAllObservations({ sinceISO, limit: 1000 }),
  ]);

  /* Aggregate per (principle, subject) — count + mean score. The
     /principles/team page renders this as the team scoreboard. */
  const aggKey = (principleId: string, subjectId: string | null) =>
    `${principleId}::${subjectId ?? "team"}`;
  const aggregates = new Map<
    string,
    {
      principleId: string;
      subjectUserId: string | null;
      count: number;
      sumScore: number;
    }
  >();
  for (const o of observations) {
    const key = aggKey(o.principleId, o.subjectUserId);
    const cur = aggregates.get(key) ?? {
      principleId: o.principleId,
      subjectUserId: o.subjectUserId,
      count: 0,
      sumScore: 0,
    };
    cur.count += 1;
    cur.sumScore += o.score;
    aggregates.set(key, cur);
  }

  /* Resolve user-ids → display names so the UI doesn't render raw
     UUIDs. Bulk join against instinct_ms_tokens so this is one round
     trip even with dozens of subjects. */
  const allSubjectIds = new Set<string>();
  for (const o of observations) {
    if (o.subjectUserId) allSubjectIds.add(o.subjectUserId);
  }
  const nameMap = await resolveUserNames(Array.from(allSubjectIds));

  const aggregateRows = Array.from(aggregates.values()).map((a) => {
    const name = a.subjectUserId ? nameMap.get(a.subjectUserId) : null;
    return {
      principleId: a.principleId,
      subjectUserId: a.subjectUserId,
      subjectName: name?.displayName ?? a.subjectUserId,
      subjectEmail: name?.email ?? null,
      count: a.count,
      meanScore: a.count > 0 ? Number((a.sumScore / a.count).toFixed(3)) : 0,
    };
  });

  /* Audit-log the cross-user read. Fire-and-forget — we already have
     the data; failure to log doesn't block the response. */
  void recordEvidenceView({
    viewer: { id: user.id, role: user.role },
    subjectUserId: null,
    route: "/api/principles/team",
    evidenceCount: observations.length,
  });

  return NextResponse.json({
    principles: principles.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      domains: p.domains,
      scoreboardWeight: p.scoreboardWeight,
      owner: p.owner,
    })),
    observations: observations.map((o) => {
      const name = o.subjectUserId ? nameMap.get(o.subjectUserId) : null;
      return {
        id: o.id,
        principleId: o.principleId,
        validatorId: o.validatorId,
        surface: o.surface,
        surfaceSubtype: o.surfaceSubtype,
        subjectUserId: o.subjectUserId,
        subjectName: name?.displayName ?? o.subjectUserId,
        observedAt: o.observedAt,
        score: o.score,
        evidence: o.evidenceJsonb,
      };
    }),
    aggregates: aggregateRows,
    sinceISO,
  });
}
