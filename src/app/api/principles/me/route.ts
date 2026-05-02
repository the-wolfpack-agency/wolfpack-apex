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
import { resolveUserNames } from "@/lib/principles/user-names";

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
  /* Pull EVERY observation in the window, then filter in-app to those
     whose subject_user_id resolves (via resolveUserNames + email +
     name match) to the requesting user. Email-only matching missed
     observations whose ms_tokens row has user_email NULL/'pending'
     but display_name is correct. Symmetric with the team aggregate's
     name-based grouping — what the scoreboard shows under "Nick
     Hoxsie" is what My principles shows for the Hoxsie session. */
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
  const nameMap = await resolveUserNames(subjectIds);
  const myEmail = (user.email || "").toLowerCase();
  const myName = (user.name || "").trim().toLowerCase();
  const matchesMe = (subjectId: string | null): boolean => {
    if (!subjectId) return false;
    if (subjectId === user.id) return true;
    const r = nameMap.get(subjectId);
    if (!r) return false;
    if (r.email && r.email.toLowerCase() === myEmail) return true;
    if (r.displayName && r.displayName.trim().toLowerCase() === myName) {
      return true;
    }
    return false;
  };
  const observations = (allObs ?? []).filter((o) => matchesMe(o.subjectUserId));
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
