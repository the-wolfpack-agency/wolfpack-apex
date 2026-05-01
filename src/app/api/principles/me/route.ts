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
  listObservationsForSubject,
  listSignalsForPrinciple,
} from "@/lib/principles/store";

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
  const [principles, observations] = await Promise.all([
    listActivePrinciples(),
    listObservationsForSubject(user.id, { sinceISO, limit: 200 }),
  ]);

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
