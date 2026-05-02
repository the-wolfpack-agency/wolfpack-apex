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

  /* Resolve every subject_user_id → canonical key (active team-member
     id when we can find one by email, otherwise fall back to the
     subject id itself). Group by canonical key so duplicate ids that
     map to the same real person collapse into one row.

     We look up email TWO ways and pick whichever finds it first:
     1. instinct_team_members.id = subject (id matches a canonical row)
     2. instinct_ms_tokens.connected_by = subject (id is from a stale
        token row that was never cleaned up)
     Then for any email found, we re-resolve to the active
     team_members row by LOWER(email) — that's the canonical id. */
  const allSubjectIds = new Set<string>();
  for (const o of observations) {
    if (o.subjectUserId) allSubjectIds.add(o.subjectUserId);
  }
  const subjectIds = Array.from(allSubjectIds);
  const canonicalById = new Map<string, string>();
  if (subjectIds.length > 0) {
    const r = await safeQuery<{ subject_id: string; canonical_id: string }>(
      `WITH ids AS (SELECT UNNEST($1::text[]) AS subject_id),
            email_for_id AS (
              SELECT i.subject_id,
                     LOWER(COALESCE(
                       (SELECT m.email FROM instinct_team_members m
                         WHERE m.id = i.subject_id LIMIT 1),
                       (SELECT t.user_email FROM instinct_ms_tokens t
                         WHERE t.connected_by = i.subject_id
                         ORDER BY t.connected_at DESC LIMIT 1)
                     )) AS lower_email
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

  /* Resolve names FIRST — for every subject id (canonical or stale).
     Then aggregate by (principle, displayName) so duplicate-id rows
     for the same person collapse, even when the duplicate id has
     been orphaned by a prior dedup migration (no email lookup
     possible). Display name is the only key that's truly stable
     across id drift in this codebase. */
  const nameMap = await resolveUserNames(subjectIds);

  const subjectKeyFor = (subjectId: string | null): string => {
    if (!subjectId) return "(team-wide)";
    const n = nameMap.get(subjectId);
    return n?.displayName ?? subjectId;
  };

  const aggKey = (principleId: string, subjectKey: string) =>
    `${principleId}::${subjectKey}`;
  const aggregates = new Map<
    string,
    {
      principleId: string;
      subjectUserId: string | null;
      subjectKey: string;
      count: number;
      sumScore: number;
    }
  >();
  for (const o of observations) {
    const canonical = canonicalize(o.subjectUserId);
    const key = subjectKeyFor(canonical);
    const aggregateKey = aggKey(o.principleId, key);
    const cur = aggregates.get(aggregateKey) ?? {
      principleId: o.principleId,
      /* Keep the canonical id for the "(you)" comparison + drill-down
         link. When two distinct ids share a name (post-dedup orphan),
         we pick the canonical one (the one in team_members today). */
      subjectUserId: canonical,
      subjectKey: key,
      count: 0,
      sumScore: 0,
    };
    /* Prefer a canonical-id row over an orphan-id row when both exist
       under the same name. */
    if (
      canonical &&
      canonicalById.has(canonical) &&
      cur.subjectUserId !== canonical
    ) {
      cur.subjectUserId = canonical;
    }
    cur.count += 1;
    cur.sumScore += o.score;
    aggregates.set(aggregateKey, cur);
  }

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
