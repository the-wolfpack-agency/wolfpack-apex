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
import { safeQuery } from "@/lib/db";

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

  /* Build a "subject_user_id → canonical_id" map so observations
     written under stale ids (e.g. before migration 128 deduped team
     members) aggregate to ONE row per real person. We resolve the
     stale id → email via instinct_ms_tokens (which migration 128
     left intact under the canonical id), then email → canonical
     team-member id. Any subject id that already matches the
     canonical row passes through unchanged. */
  const allSubjectIds = new Set<string>();
  for (const o of observations) {
    if (o.subjectUserId) allSubjectIds.add(o.subjectUserId);
  }
  const subjectIds = Array.from(allSubjectIds);
  const canonicalById = new Map<string, string>();
  if (subjectIds.length > 0) {
    /* Two-step lookup. (1) For each subject id, find its email via
       team_members directly (covers canonical ids) OR ms_tokens (covers
       legacy ids). (2) For each email, find the canonical
       team_members.id. The CTE below does both in one round trip. */
    const r = await safeQuery<{ subject_id: string; canonical_id: string }>(
      `WITH ids AS (SELECT UNNEST($1::text[]) AS subject_id),
            email_for_id AS (
              SELECT i.subject_id,
                     COALESCE(
                       (SELECT LOWER(m.email) FROM instinct_team_members m
                         WHERE m.id = i.subject_id LIMIT 1),
                       (SELECT LOWER(t.user_email) FROM instinct_ms_tokens t
                         WHERE t.connected_by = i.subject_id LIMIT 1)
                     ) AS lower_email
                FROM ids i
            )
       SELECT e.subject_id,
              COALESCE(c.id::text, e.subject_id) AS canonical_id
         FROM email_for_id e
         LEFT JOIN instinct_team_members c
           ON LOWER(c.email) = e.lower_email AND c.is_active = TRUE
        WHERE e.subject_id IS NOT NULL`,
      [subjectIds],
    );
    for (const row of r.rows) {
      canonicalById.set(row.subject_id, row.canonical_id);
    }
  }
  const canonicalize = (id: string | null): string | null =>
    id ? canonicalById.get(id) ?? id : null;

  /* Aggregate per (principle, CANONICAL subject) so duplicate-id
     observations roll up cleanly. */
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
    const canonical = canonicalize(o.subjectUserId);
    const key = aggKey(o.principleId, canonical);
    const cur = aggregates.get(key) ?? {
      principleId: o.principleId,
      subjectUserId: canonical,
      count: 0,
      sumScore: 0,
    };
    cur.count += 1;
    cur.sumScore += o.score;
    aggregates.set(key, cur);
  }

  /* Resolve canonical ids → display names. */
  const canonicalIds = new Set<string>();
  for (const a of aggregates.values()) {
    if (a.subjectUserId) canonicalIds.add(a.subjectUserId);
  }
  const nameMap = await resolveUserNames(Array.from(canonicalIds));

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
      const canonical = canonicalize(o.subjectUserId);
      const name = canonical ? nameMap.get(canonical) : null;
      return {
        id: o.id,
        principleId: o.principleId,
        validatorId: o.validatorId,
        surface: o.surface,
        surfaceSubtype: o.surfaceSubtype,
        subjectUserId: canonical,
        subjectName: name?.displayName ?? canonical,
        observedAt: o.observedAt,
        score: o.score,
        evidence: o.evidenceJsonb,
      };
    }),
    aggregates: aggregateRows,
    sinceISO,
  });
}
