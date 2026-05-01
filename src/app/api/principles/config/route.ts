/**
 * /api/principles/config — leadership-only config surface.
 *
 * GET → current config + a hint about owner-auto-detection state.
 * PUT → update doc URL (and optionally owner_user_id). Auto-picks
 *       owner from leadership M365 tokens when not specified.
 *
 * Replaces env-var-driven setup so leadership can configure the
 * principles platform via UI alone. 403 for everyone except ceo/cto.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { canReadTeamEvidence } from "@/lib/principles/authz";
import {
  getPrinciplesConfig,
  setPrinciplesConfig,
  resolvePrinciplesConfig,
} from "@/lib/principles/config";
import { trackEvent } from "@/lib/analytics";
import { WriteQueryError } from "@/lib/db";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const stored = await getPrinciplesConfig();
  const resolved = await resolvePrinciplesConfig();
  return NextResponse.json({
    docUrl: stored.docUrl,
    ownerUserId: stored.ownerUserId,
    updatedBy: stored.updatedBy,
    updatedAt: stored.updatedAt,
    /* Effective values (after fallback + auto-detect) so the UI can
       show "currently using X's token (auto-detected)" when applicable. */
    effective: resolved
      ? {
          docUrl: resolved.docUrl,
          ownerUserId: resolved.ownerUserId,
          ownerAutoDetected: resolved.ownerAutoDetected,
        }
      : null,
  });
}

export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { docUrl?: unknown; ownerUserId?: unknown };
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const docUrl =
    typeof body.docUrl === "string" ? body.docUrl.trim() : null;
  const ownerUserId =
    typeof body.ownerUserId === "string" ? body.ownerUserId.trim() : null;
  if (docUrl !== null && docUrl !== "" && !/^https?:\/\//.test(docUrl)) {
    return NextResponse.json(
      { error: "docUrl must be an http(s) URL" },
      { status: 400 },
    );
  }
  try {
    const saved = await setPrinciplesConfig({
      docUrl: docUrl || null,
      ownerUserId: ownerUserId || null,
      updatedBy: user.id,
    });
    trackEvent("principle.config_updated", user.id, user.role, {
      has_doc_url: !!saved.docUrl,
      has_owner: !!saved.ownerUserId,
    });
    return NextResponse.json({
      docUrl: saved.docUrl,
      ownerUserId: saved.ownerUserId,
      updatedBy: saved.updatedBy,
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    if (err instanceof WriteQueryError) {
      return NextResponse.json(
        { error: "Failed to save config" },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}
