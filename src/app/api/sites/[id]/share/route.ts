/**
 * /api/sites/[id]/share — authed Instinct user issues / lists / revokes
 * the unauthenticated share links for a site.
 *
 * Auth pattern mirrors /api/sites/[id]/domain:
 *   - Bearer token required on every verb (getUserFromRequest)
 *   - role >= sales (hasRole) required for share-link management
 *   - site must exist (getSiteProject) — 404 otherwise
 *
 * POST   → mint a new share link. Default TTL 30d, max 90d.
 * GET    → list every share token (active + revoked + expired) for UI.
 * DELETE → revoke a specific token (?tokenId=<uuid>).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { getSiteProject } from "@/lib/sites";
import { trackEvent } from "@/lib/analytics";
import {
  issueShareToken,
  listShareTokensForSite,
  revokeShareToken,
  ShareSecretMissingError,
} from "@/lib/share-tokens";
import { latestApprovalState } from "@/lib/site-approvals";

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

async function authorize(req: NextRequest, siteId: string) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return {
      user: null as null,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const site = await getSiteProject(siteId);
  if (!site) {
    return {
      user,
      response: NextResponse.json({ error: "not found" }, { status: 404 }),
    };
  }
  if (!hasRole(user.role, "sales")) {
    return {
      user,
      response: NextResponse.json(
        { error: "insufficient role for share-link management", reason: "role_insufficient" },
        { status: 403 },
      ),
    };
  }
  return { user, response: null as null };
}

function shareUrlFromToken(token: string): string {
  return `/share/${token}`;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { user, response } = await authorize(req, id);
  if (response || !user) return response!;

  let body: { ttlSeconds?: number } = {};
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const ttl = body.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) {
    return NextResponse.json(
      { error: "ttlSeconds must be a number", reason: "bad_ttl" },
      { status: 400 },
    );
  }
  if (ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    return NextResponse.json(
      { error: `ttlSeconds must be between 1 and ${MAX_TTL_SECONDS}`, reason: "bad_ttl" },
      { status: 400 },
    );
  }

  try {
    const issued = await issueShareToken({
      siteId: id,
      createdBy: user.id,
      ttlSeconds: ttl,
    });
    trackEvent("site.share_link_issued", user.id, user.role, {
      site_id: id,
      ttl_seconds: ttl,
      token_nonce: issued.nonce, // UUID, not the signed blob
    });
    return NextResponse.json({
      token: issued.token,
      shareUrl: shareUrlFromToken(issued.token),
      tokenId: issued.tokenRowId,
      nonce: issued.nonce,
      expiresAt: issued.expiresAt.toISOString(),
    });
  } catch (err) {
    console.error("[share/POST]", (err as Error).message);
    if (err instanceof ShareSecretMissingError) {
      return NextResponse.json(
        {
          error:
            "Share-link signing is not configured. Set INSTINCT_SHARE_SECRET (or APEX_JWT_SECRET as the auto-derived fallback) in the production environment.",
          reason: "share_secret_missing",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { user, response } = await authorize(req, id);
  if (response || !user) return response!;

  try {
    const [tokens, latest] = await Promise.all([
      listShareTokensForSite(id),
      latestApprovalState(id),
    ]);
    return NextResponse.json({
      // Signed blobs are NEVER replayed back here — the designer sees
      // metadata only. To regenerate a link they issue a new one.
      tokens: tokens.map((t) => ({
        id: t.id,
        nonce: t.nonce,
        created_at: t.created_at,
        expires_at: t.expires_at,
        revoked_at: t.revoked_at,
        last_accessed_at: t.last_accessed_at,
        access_count: t.access_count,
      })),
      latestApproval: latest,
    });
  } catch (err) {
    console.error("[share/GET]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { user, response } = await authorize(req, id);
  if (response || !user) return response!;

  const tokenId = req.nextUrl.searchParams.get("tokenId");
  if (!tokenId) {
    return NextResponse.json(
      { error: "tokenId query param required", reason: "missing_token_id" },
      { status: 400 },
    );
  }

  try {
    await revokeShareToken(tokenId);
    trackEvent("site.share_link_revoked", user.id, user.role, {
      site_id: id,
      token_id: tokenId, // DB UUID is safe to log
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[share/DELETE]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
