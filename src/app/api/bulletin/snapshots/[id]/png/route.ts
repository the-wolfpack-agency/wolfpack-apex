/**
 * GET /api/bulletin/snapshots/[id]/png — stream the PNG bytes.
 *
 * Serves the raw bytes with `Content-Type: image/png` so callers can
 * `<img src=...>` it directly. Auth-gated; emits a `snapshot_viewed`
 * analytics event on every successful fetch (the learning loop uses
 * this to surface "most-viewed snapshot" / "stale snapshots no one
 * looks at" insights).
 *
 * Auth accepts either form:
 *   1. `Authorization: Bearer <token>` — in-app `<img>` calls go through
 *      `fetchWithRefresh` and carry the access token in the header.
 *   2. The `instinct_access_token` HttpOnly cookie — top-level browser
 *      navigations (the snapshot's "Download" / "View" anchors) don't
 *      attach custom headers; they only carry cookies. The download
 *      surface was 401-ing before this fallback was added.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUserFromRequest, verifyToken, type TeamMember } from "@/lib/auth";
import { ACCESS_TOKEN_COOKIE } from "@/lib/crypto/cookies";
import { trackEvent } from "@/lib/analytics";
import { getSnapshotPng } from "@/lib/bulletin/snapshots";

async function resolveUserFromCookie(): Promise<TeamMember | null> {
  try {
    const jar = await cookies();
    const token = jar.get(ACCESS_TOKEN_COOKIE)?.value;
    if (!token) return null;
    const payload = verifyToken(token);
    return {
      id: payload.userId,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      created_at: "",
    };
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    user = await resolveUserFromCookie();
  }
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;

  const result = await getSnapshotPng(id);
  if (!result) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  trackEvent("bulletin.snapshot_viewed", user.id, user.role, {
    snapshot_id: id,
  });

  /* Wrap the bytes in a Blob so we hit the Web-fetch BodyInit overload
     cleanly across Node 18/20/22 — Uint8Array/Buffer have flickered
     between accepted/not-accepted as `BodyInit` across Next.js + lib
     dom typings; Blob is stable everywhere. */
  const blob = new Blob([new Uint8Array(result.bytes)], { type: "image/png" });

  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=300",
      "Content-Length": String(result.bytes.byteLength),
    },
  });
}
