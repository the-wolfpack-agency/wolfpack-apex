/**
 * GET /api/principles/me
 *
 * Member self-view. Returns the caller's own observations + active
 * principles. No leadership data, no cross-user data, no awareness of
 * the team scoreboard. Pure self-improvement surface.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { canReadTeamEvidence } from "@/lib/principles/authz";
import {
  listActivePrinciples,
  listAllObservations,
  listSignalsForPrinciple,
} from "@/lib/principles/store";
import { safeQuery } from "@/lib/db";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const wantFull =
    url.searchParams.get("full") === "1" &&
    canReadTeamEvidence({ id: user.id, role: user.role });
  const sinceISO =
    url.searchParams.get("since") ||
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [principles, allObs] = await Promise.all([
    listActivePrinciples(),
    listAllObservations({ sinceISO, limit: 1000 }),
  ]);
  const subjectIds = Array.from(
    new Set(
      (allObs ?? [])
        .map((o) => o.subjectUserId)
        .filter((s): s is string => Boolean(s)),
    ),
  );

  /* Canonicalize EVERY id (the JWT user.id + every observation's
     subject_user_id) through the same DB-side CTE the team aggregate
     uses. Two ids are "the same person" if they map to the same
     canonical team-member row by email — looking up the email via
     team_members.id OR ms_tokens.connected_by, then re-resolving
     to the active team_members row by LOWER(email).
     Match observations to user iff canonicalize(obs) === canonicalize(jwt).
     This is JWT-content-agnostic: doesn't matter what email/name the
     JWT carries; we use the DB to figure out who's who. */
  const idsToResolve = Array.from(new Set([...subjectIds, user.id]));
  const canonicalById = new Map<string, string>();
  if (idsToResolve.length > 0) {
    try {
      const r = await safeQuery<{ subject_id: string; canonical_id: string }>(
        `WITH ids AS (SELECT UNNEST($1::text[]) AS subject_id),
              email_for_id AS (
                SELECT i.subject_id,
                       LOWER(COALESCE(
                         (SELECT m.email FROM instinct_team_members m
                           WHERE m.id::text = i.subject_id LIMIT 1),
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
             ON LOWER(c.email) = e.lower_email AND c.is_active = TRUE`,
        [idsToResolve],
      );
      for (const row of r.rows) {
        canonicalById.set(row.subject_id, row.canonical_id);
      }
    } catch {
      /* DB unreachable → identity map. */
    }
  }
  const myCanonical = canonicalById.get(user.id) ?? user.id;
  const observations = (allObs ?? []).filter((o) => {
    if (!o.subjectUserId) return false;
    const c = canonicalById.get(o.subjectUserId) ?? o.subjectUserId;
    return c === myCanonical;
  });
  const teamWideCountByPrinciple = new Map<string, number>();
  for (const o of allObs ?? []) {
    if (o.subjectUserId !== null) continue;
    teamWideCountByPrinciple.set(
      o.principleId,
      (teamWideCountByPrinciple.get(o.principleId) ?? 0) + 1,
    );
  }

  if (wantFull) {
    /* Leadership-only — return the editable shape (signals, weight,
       effective date, owner) used by the native CRUD manager UI. */
    const signalsByPrinciple = await Promise.all(
      principles.map((p) => listSignalsForPrinciple(p.id)),
    );
    return NextResponse.json({
      principles: principles.map((p, i) => {
        const sigs = signalsByPrinciple[i];
        return {
          id: p.id,
          slug: p.slug,
          title: p.title,
          domains: p.domains,
          bodyMd: p.bodyMd,
          owner: p.owner,
          scoreboardWeight: p.scoreboardWeight,
          effectiveAt: p.effectiveAt,
          signals: sigs.filter((s) => s.kind === "signal").map((s) => s.description),
          counterSignals: sigs
            .filter((s) => s.kind === "counter")
            .map((s) => s.description),
        };
      }),
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

  return NextResponse.json({
    principles: principles.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      domains: p.domains,
      bodyMd: p.bodyMd,
      teamWideObservationCount: teamWideCountByPrinciple.get(p.id) ?? 0,
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
