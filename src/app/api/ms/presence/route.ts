/**
 * /api/ms/presence — Teams presence proxy.
 *
 *   GET   /api/ms/presence                 → caller's own presence
 *   POST  /api/ms/presence  { user_ids }   → batched presence for many users
 *
 * Auth via Instinct JWT; MS token resolved server-side via
 * `getValidToken(user.id)`. 401/403 from Graph surfaces as
 * `{ scope_missing: true }` (HTTP 200) so the UI can prompt for
 * re-consent rather than rendering a blank presence dot.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";
import {
  getOwnPresence,
  getPresence,
  type Presence,
} from "@/lib/ms-graph-presence";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const token = await getValidToken(user.id);
    if (!token) {
      return NextResponse.json({ presence: null, connected: false });
    }
    const presence = await getOwnPresence(token.accessToken, user.id);
    return NextResponse.json(
      { presence },
      { headers: { "Cache-Control": "private, max-age=30" } },
    );
  } catch (err) {
    console.error("[api/ms/presence GET] error:", (err as Error).message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { user_ids?: unknown };
    const rawIds = Array.isArray(body.user_ids) ? body.user_ids : [];
    const userIds = rawIds
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .slice(0, 5000); // hard cap so a malicious POST can't blast Graph

    if (userIds.length === 0) {
      return NextResponse.json({ presences: [] });
    }

    const token = await getValidToken(user.id);
    if (!token) {
      return NextResponse.json({ presences: [], connected: false });
    }

    const map = await getPresence(token.accessToken, userIds, user.id);
    if (map.size === 0 && userIds.length > 0) {
      // `getPresence` returns an empty Map on scope_missing AND on
      // pure miss. Hitting `/me/presence` is the cheapest disambiguator —
      // if it also 401s the scope is missing.
      const probe = await fetch(
        "https://graph.microsoft.com/v1.0/me/presence",
        { headers: { Authorization: `Bearer ${token.accessToken}` } },
      );
      if (probe.status === 401 || probe.status === 403) {
        return NextResponse.json({ presences: [], scope_missing: true });
      }
    }

    const presences: Presence[] = Array.from(map.values());
    return NextResponse.json({ presences });
  } catch (err) {
    console.error("[api/ms/presence POST] error:", (err as Error).message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
