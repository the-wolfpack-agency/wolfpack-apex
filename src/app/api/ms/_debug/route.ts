/**
 * GET /api/ms/_debug
 *
 * Diagnostic-only: decodes the user's currently-stored MS access
 * token (no signature verification — Azure already verified it on
 * issue) and returns the `scp` claim plus token metadata so we can
 * see *which scopes* the issued token actually carries.
 *
 * This exists because Azure can silently downgrade scopes when:
 *   - prompt=consent is missing (cached consent reused)
 *   - admin consent wasn't granted in the Azure portal
 *   - a tenant policy restricts certain scopes
 *
 * In all three cases Graph endpoints return 200 with empty results
 * instead of 403. The only way to tell what actually happened is to
 * read the token's scp claim. This endpoint does that.
 *
 * Returns:
 *   200 { scopes: string[], expected, missing, expiresIn, ... }
 *   200 { connected: false }     — user has no MS token
 *   401                          — no Instinct JWT
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";

interface JwtPayload {
  scp?: string;
  aud?: string;
  appid?: string;
  tid?: string;
  upn?: string;
  exp?: number;
  iat?: number;
}

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // base64url → base64
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const json = Buffer.from(padded + padding, "base64").toString("utf-8");
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

const EXPECTED_TEAMS_SCOPES = [
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMessage.Read.All",
];

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = await getValidToken(user.id);
  if (!token) {
    return NextResponse.json({ connected: false });
  }
  const payload = decodeJwtPayload(token.accessToken);
  if (!payload) {
    return NextResponse.json({
      connected: true,
      decodable: false,
      hint: "Token isn't a JWS — possibly an opaque token. Can't read scp.",
    });
  }
  const scopes = (payload.scp ?? "").split(" ").filter(Boolean).sort();
  const missing = EXPECTED_TEAMS_SCOPES.filter((s) => !scopes.includes(s));
  const nowSec = Math.floor(Date.now() / 1000);
  return NextResponse.json({
    connected: true,
    decodable: true,
    scopes,
    expected_for_teams: EXPECTED_TEAMS_SCOPES,
    missing_for_teams: missing,
    has_all_teams_scopes: missing.length === 0,
    audience: payload.aud ?? null,
    appid: payload.appid ?? null,
    tenant_id: payload.tid ?? null,
    upn: payload.upn ?? null,
    expires_in_seconds: payload.exp ? payload.exp - nowSec : null,
  });
}
